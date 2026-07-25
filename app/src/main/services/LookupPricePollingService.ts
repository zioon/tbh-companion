// 本地高价值/重点物品价格轮询服务。
//
// 与图鉴共享快照（LookupPriceService，每 30 分钟从 GitHub release 拉取 CI
// 每 6 小时构建的 prices.json）互补：开启后客户端在本地周期性调用 Steam
// priceoverview 接口，刷新「已拥有且估值达阈值」或「用户收藏」的物品价格，
// 并 merge 进内存中的 LookupPriceSnapshot，让图鉴 tab 立刻看到更新的价格。
//
// 设计要点：
//   - 复用现有 IPC.LOOKUP_PRICES 通道广播更新（不新增 IPC 通道）
//   - 不持久化 polling 数据到 lookup_prices.json（保持 CI 快照的纯净来源）
//   - 限流熔断沿用 SteamMarketProvider 的策略：3s 间隔、连续 3 次 429 中止本轮
//   - 单轮串行抓取，避免并发触发 Steam 限流
//   - 与 inventory 的「auto scan」是独立的：那个抓玩家拥有的全部物品；
//     这个只盯「图鉴快照里 ≥ 阈值」的子集，并 merge 到图鉴快照（不进 prices.<CUR>.json）

import type {
  LookupPricePollingPrefs,
  LookupPricePollingStatus,
  LookupPriceSnapshot,
  PollingCycleResult,
} from "../../../shared/types";
import { selectPollingTargets } from "../../core/lookupPrice";
import { fetchSteamPrice } from "./steamPriceApi";
import type { LookupPriceService } from "./LookupPriceService";
import { createLogger } from "../log";

const log = createLogger("lookupPolling");

export const POLLING_MIN_INTERVAL_MIN = 5;
export const POLLING_MAX_INTERVAL_MIN = 60;
export const POLLING_DEFAULT_INTERVAL_MIN = 10;
export const POLLING_DEFAULT_THRESHOLD_USD = 1.0;
/** 单次轮询调用之间的延迟（ms）。匹配 SteamMarketProvider 的 3s 节流。 */
const FETCH_DELAY_MS = 3000;
/** 429 后的退避乘子（延迟 × 2）。 */
const RATE_LIMIT_BACKOFF_MS = 6000;
/** 连续 429 次数达到此阈值则中止本轮轮询（避免反复撞 Steam 限流墙）。 */
const MAX_CONSECUTIVE_RATE_LIMITS = 3;

// 本地配置形态（与 shared/types 的 LookupPricePollingPrefs 同形；保留独立
// 类型名是为了让 service 内部的配置语义清晰，且能在 sanitize 时复用）。
export type LookupPricePollingConfig = LookupPricePollingPrefs;

export interface LookupPricePollingDeps {
  /** 拿当前内存中的图鉴快照（用于 merge 与目标筛选）。 */
  lookupPrices: LookupPriceService;
  /** 拿当前玩家拥有物品的 hash 列表（来自 InventoryService）。 */
  getOwnedHashes: () => string[];
  /** 广播通道（一般绑定到 IPC.LOOKUP_PRICES 的 broadcast 函数）。 */
  broadcast: (channel: string, payload: unknown) => void;
  /** 注入用于测试；默认走 fetchSteamPrice（调 Steam priceoverview）。 */
  fetchUsd?: (hash: string) => Promise<{ ok: boolean; usd: number | null; rateLimited: boolean }>;
  /** 注入用于测试；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 状态变更回调（cycle 开始/每个 item 完成/cycle 结束）。用于向 renderer
   * 广播 polling 进度（IPC.LOOKUP_PRICES_POLL_STATUS）。可选。
   */
  onStatusChange?: (status: LookupPricePollingStatus) => void;
}

export type { LookupPricePollingStatus, PollingCycleResult };

/**
 * 把任意输入归一化为合法的 polling 配置。intervalMinutes 限定在
 * [POLLING_MIN_INTERVAL_MIN, POLLING_MAX_INTERVAL_MIN]；thresholdUsd ≥ 0；
 * watchedHashes 去重去空。
 */
export function sanitizePollingConfig(
  cfg: Partial<LookupPricePollingConfig> | undefined,
): LookupPricePollingConfig {
  const intervalMinutes = (() => {
    const n =
      typeof cfg?.intervalMinutes === "number" ? cfg.intervalMinutes : Number(cfg?.intervalMinutes);
    if (!Number.isFinite(n)) return POLLING_DEFAULT_INTERVAL_MIN;
    return Math.min(Math.max(Math.round(n), POLLING_MIN_INTERVAL_MIN), POLLING_MAX_INTERVAL_MIN);
  })();
  const thresholdUsd = (() => {
    const n = typeof cfg?.thresholdUsd === "number" ? cfg.thresholdUsd : Number(cfg?.thresholdUsd);
    if (!Number.isFinite(n) || n < 0) return POLLING_DEFAULT_THRESHOLD_USD;
    return n;
  })();
  const watchedHashes = (() => {
    if (!Array.isArray(cfg?.watchedHashes)) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of cfg!.watchedHashes) {
      if (typeof h !== "string") continue;
      const trimmed = h.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  })();
  return {
    enabled: Boolean(cfg?.enabled),
    intervalMinutes,
    thresholdUsd,
    watchedHashes,
  };
}

export class LookupPricePollingService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 防止单轮尚未结束时下一轮 setInterval 触发又开新一轮。 */
  private cycleRunning = false;
  private config: LookupPricePollingConfig = {
    enabled: false,
    intervalMinutes: POLLING_DEFAULT_INTERVAL_MIN,
    thresholdUsd: POLLING_DEFAULT_THRESHOLD_USD,
    watchedHashes: [],
  };
  /** 上次轮询结果（供 UI 显示「上次更新时间」）。 */
  private lastCycleResult: PollingCycleResult | null = null;
  private lastCycleAtMs: number | null = null;
  /** 当前轮询的实时进度（cycle 结束后清回 null）。 */
  private currentProgress: {
    targets: number;
    processed: number;
    priced: number;
    rateLimited: number;
    failed: number;
  } | null = null;

  constructor(
    private readonly deps: LookupPricePollingDeps,
    initialConfig?: Partial<LookupPricePollingConfig>,
  ) {
    if (initialConfig) {
      this.config = sanitizePollingConfig(initialConfig);
    }
  }

  /** 当前配置（UI 可读，不应直接修改）。 */
  getConfig(): LookupPricePollingConfig {
    return { ...this.config };
  }

  /**
   * 返回当前 polling 状态快照（renderer 用来显示「运行中 / 上次结果 / 进度」）。
   * 不要缓存返回值——`config` 和 `currentProgress` 是实时引用快照。
   */
  getPollingStatus(): LookupPricePollingStatus {
    return {
      running: this.cycleRunning,
      enabled: this.config.enabled,
      config: this.getConfig(),
      progress: this.currentProgress ? { ...this.currentProgress } : null,
      lastCycleResult: this.lastCycleResult ? { ...this.lastCycleResult } : null,
      lastCycleAtMs: this.lastCycleAtMs,
    };
  }

  getLastCycleResult(): { result: PollingCycleResult; atMs: number } | null {
    if (!this.lastCycleResult || this.lastCycleAtMs == null) return null;
    return { result: this.lastCycleResult, atMs: this.lastCycleAtMs };
  }

  /** 主动广播当前状态（用于 IPC handler 拉取后立即 push 给 renderer）。 */
  private emitStatus(): void {
    this.deps.onStatusChange?.(this.getPollingStatus());
  }

  /**
   * 应用新配置。当 enabled 或 intervalMinutes 变化时重启定时器；
   * 仅 thresholdUsd / watchedHashes 变化时不重启（下一轮自动用新值）。
   */
  setConfig(cfg: Partial<LookupPricePollingConfig>): void {
    const prev = this.config;
    const next = sanitizePollingConfig({ ...prev, ...cfg });
    this.config = next;

    const intervalChanged = next.intervalMinutes !== prev.intervalMinutes;
    const enabledToggled = next.enabled !== prev.enabled;

    if (enabledToggled) {
      if (next.enabled) this.start();
      else this.stop();
    } else if (next.enabled && intervalChanged) {
      // 间隔变化 → 重启定时器
      this.start();
    }
    // 否则保持现状

    // 配置变更（含 enabled toggle）后总是 emit 一次，让 UI 立即反映新状态
    this.emitStatus();
  }

  /** 启动定时器。会立即触发一次轮询，然后按 intervalMinutes 周期性触发。 */
  start(): void {
    if (!this.config.enabled) return;
    this.stop();
    log.info(
      `start: interval=${this.config.intervalMinutes}min threshold=$${this.config.thresholdUsd} watched=${this.config.watchedHashes.length}`,
    );
    // 立即触发一次，让用户开开关后很快看到效果
    void this.pollOnce();
    const ms = this.config.intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => void this.pollOnce(), ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 不强制中断正在运行的 cycle（避免半merge状态）；让它自然跑完
  }

  isRunning(): boolean {
    return this.cycleRunning;
  }

  /** 单轮轮询。可被测试直接调用。 */
  async pollOnce(): Promise<PollingCycleResult> {
    if (this.cycleRunning) {
      log.info("skip: previous cycle still running");
      return {
        targets: 0,
        priced: 0,
        rateLimited: 0,
        failed: 0,
        aborted: true,
      };
    }
    if (!this.config.enabled) {
      return { targets: 0, priced: 0, rateLimited: 0, failed: 0, aborted: true };
    }

    this.cycleRunning = true;
    try {
      const snapshot = this.deps.lookupPrices.getSnapshot();
      const ownedHashes = this.deps.getOwnedHashes();
      const targets = selectPollingTargets({
        snapshot,
        ownedHashes,
        watchedHashes: this.config.watchedHashes,
        thresholdUsd: this.config.thresholdUsd,
      });

      if (targets.length === 0) {
        log.info("cycle: no targets (skip)");
        const result: PollingCycleResult = {
          targets: 0,
          priced: 0,
          rateLimited: 0,
          failed: 0,
          aborted: false,
        };
        this.lastCycleResult = result;
        this.lastCycleAtMs = Date.now();
        this.emitStatus();
        return result;
      }

      log.info(
        `cycle start: ${targets.length} targets (owned=${ownedHashes.length} watched=${this.config.watchedHashes.length} threshold=$${this.config.thresholdUsd})`,
      );

      let consecutiveRateLimits = 0;
      let priced = 0;
      let rateLimited = 0;
      let failed = 0;
      let aborted = false;

      const updatedPrices: Record<string, number | null> = {};
      const updatedFetchedUtc: Record<string, string> = {};

      this.currentProgress = {
        targets: targets.length,
        processed: 0,
        priced: 0,
        rateLimited: 0,
        failed: 0,
      };
      this.emitStatus();

      for (const hash of targets) {
        const result = await this.fetchOne(hash);
        if (result.rateLimited) {
          rateLimited++;
          consecutiveRateLimits++;
          if (this.currentProgress) this.currentProgress.rateLimited = rateLimited;
          if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
            log.warn(
              `cycle aborted: ${MAX_CONSECUTIVE_RATE_LIMITS} consecutive rate limits (${rateLimited}/${targets.length} rate-limited so far)`,
            );
            aborted = true;
            break;
          }
          if (this.currentProgress) this.currentProgress.processed++;
          this.emitStatus();
          await this.sleep(RATE_LIMIT_BACKOFF_MS);
          continue;
        }
        consecutiveRateLimits = 0;
        if (result.ok) {
          updatedPrices[hash] = result.usd;
          updatedFetchedUtc[hash] = new Date().toISOString();
          priced++;
          if (this.currentProgress) this.currentProgress.priced = priced;
        } else {
          // 网络错误、HTTP 非 429 等：跳过这个 hash，下一轮再试
          failed++;
          if (this.currentProgress) this.currentProgress.failed = failed;
        }
        if (this.currentProgress) this.currentProgress.processed++;
        this.emitStatus();
        await this.sleep(FETCH_DELAY_MS);
      }

      // 把新价格 merge 进内存快照（如果至少抓到了一个）
      if (priced > 0) {
        const current = this.deps.lookupPrices.getSnapshot();
        if (current) {
          const merged: LookupPriceSnapshot = {
            ...current,
            prices: { ...current.prices, ...updatedPrices },
            fetchedUtc: { ...(current.fetchedUtc ?? {}), ...updatedFetchedUtc },
          };
          // 注意：generatedUtc 保持 CI 快照的原始值——它代表「CI 何时生成
          // 整个 prices.json」，而我们的 polling 只是局部覆盖。UI 显示的
          // 「updated N ago」依旧锚定 CI 时间，分项的 fetchedUtc[hash] 才
          // 反映具体物品的抓取时间。
          this.deps.lookupPrices.replaceSnapshot(merged);
        }
      }

      const cycleResult: PollingCycleResult = {
        targets: targets.length,
        priced,
        rateLimited,
        failed,
        aborted,
      };
      this.lastCycleResult = cycleResult;
      this.lastCycleAtMs = Date.now();
      this.currentProgress = null;
      log.info(
        `cycle end: priced=${priced}/${targets.length} rateLimited=${rateLimited} failed=${failed} aborted=${aborted}`,
      );
      this.emitStatus();
      return cycleResult;
    } finally {
      this.cycleRunning = false;
    }
  }

  private async fetchOne(
    hash: string,
  ): Promise<{ ok: boolean; usd: number | null; rateLimited: boolean }> {
    if (this.deps.fetchUsd) return this.deps.fetchUsd(hash);
    // 默认实现：调 Steam priceoverview，USD，取 lowest（无 lowest 则 median）
    const response = await fetchSteamPrice(hash, "USD");
    if (!response.ok && response.status === 429) {
      return { ok: false, usd: null, rateLimited: true };
    }
    if (!response.ok) return { ok: false, usd: null, rateLimited: false };
    const entry = response.entry;
    const usd = entry.lowest ?? entry.median;
    // ok=true 但没有 sell price（no_listing / no_sell_price）→ 视为 null（确认无挂单）
    return { ok: true, usd, rateLimited: false };
  }

  private async sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
