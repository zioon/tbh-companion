// 本地高价值/重点物品价格轮询服务。
//
// 与图鉴共享快照（LookupPriceService，每 30 分钟从 GitHub release 拉取 CI
// 每 6 小时构建的 prices.json）互补：开启后客户端在本地周期性调用 Steam
// priceoverview + itemordershistogram 接口，刷新「已拥有且估值达阈值」或
// 「用户收藏」的物品价格，并 merge 进内存中的 LookupPriceSnapshot，让图鉴
// tab 立刻看到更新的价格。
//
// 抓取三档价格（与 UI 三行对齐）：
//   - pricesLocal[hash]      = 最低出售价（priceoverview.lowest_price）
//   - medianLocal[hash]      = 最近成交价中位数（priceoverview.median_price）
//   - buyOrderLocal[hash]    = 最高收购价（itemordershistogram.highest_buy_order）
//
// 设计要点：
//   - 复用现有 IPC.LOOKUP_PRICES 通道广播更新（不新增 IPC 通道）
//   - 不持久化 polling 数据到 lookup_prices.json（保持 CI 快照的纯净来源）
//   - 限流熔断沿用 SteamMarketProvider 的策略：3s 间隔、连续 3 次 429 中止本轮
//   - 单轮串行抓取，避免并发触发 Steam 限流
//   - buyOrder 抓取需要 item_nameid；nameid 解析失败时跳过 buyOrder，不影响
//     最低出售价和成交价的写入
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
import { fetchSteamBuyOrder } from "./steamBuyOrderApi";
import type { SteamItemNameIdService } from "./steamItemNameId";
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
  /**
   * 拿当前用户选择的显示货币（如 "USD"/"CNY"/"BRL"）。polling 会直接用
   * 此货币调 Steam priceoverview，写入 `snapshot.pricesLocal`，避免 FX
   * 圆整误差。每次 cycle 开始时读取，cycle 中途切换货币要等下一轮生效。
   */
  getCurrency: () => string;
  /**
   * 解析 hash → item_nameid；buyOrder 抓取依赖此服务。可选注入：
   * 未注入时跳过 buyOrder（仅抓最低出售价 + 成交价）。
   */
  nameIdService?: SteamItemNameIdService;
  /** 注入用于测试；默认走 fetchSteamPrice（调 Steam priceoverview）。 */
  fetchUsd?: (hash: string) => Promise<{ ok: boolean; usd: number | null; rateLimited: boolean }>;
  /**
   * 注入用于测试；默认走 fetchSteamPrice 但用目标货币。返回目标货币的
   * 最低挂牌价 + 中位数成交价。如果未注入，默认实现用 fetchSteamPrice
   * + currency 参数。
   */
  fetchLocal?: (
    hash: string,
    currency: string,
  ) => Promise<{
    ok: boolean;
    amount: number | null;
    median?: number | null;
    rateLimited: boolean;
  }>;
  /**
   * 注入用于测试；默认走 fetchSteamBuyOrder（调 Steam itemordershistogram）。
   * 返回目标货币的最高收购价。如果未注入或 nameIdService 为空，跳过 buyOrder。
   */
  fetchBuyOrder?: (
    hash: string,
    currency: string,
  ) => Promise<{ ok: boolean; buyOrder: number | null; rateLimited: boolean }>;
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
   * 把本轮抓到的三档价格 merge 进内存快照并广播。
   *
   * 抽出来供 {@link pollOnce}（多目标 cycle）和 {@link pollSingleHash}
   * （单 hash 手动刷新）共用。仅当至少写入了 1 个价格时才 merge。
   *
   * @returns 是否真的发生了 merge（用于判断要不要广播）。
   */
  private mergeUpdatesIntoSnapshot(
    updates: {
      prices?: Record<string, number | null>;
      pricesLocal?: Record<string, number | null>;
      medianLocal?: Record<string, number | null>;
      buyOrderLocal?: Record<string, number | null>;
      fetchedUtc?: Record<string, string>;
    },
    targetCurrency: string,
  ): boolean {
    const hasAny =
      (updates.prices && Object.keys(updates.prices).length > 0) ||
      (updates.pricesLocal && Object.keys(updates.pricesLocal).length > 0) ||
      (updates.medianLocal && Object.keys(updates.medianLocal).length > 0) ||
      (updates.buyOrderLocal && Object.keys(updates.buyOrderLocal).length > 0);
    if (!hasAny) return false;

    const current = this.deps.lookupPrices.getSnapshot();
    if (!current) return false;

    const merged: LookupPriceSnapshot = {
      ...current,
      ...(updates.prices ? { prices: { ...current.prices, ...updates.prices } } : {}),
      ...(updates.pricesLocal
        ? { pricesLocal: { ...(current.pricesLocal ?? {}), ...updates.pricesLocal } }
        : {}),
      ...(updates.medianLocal
        ? { medianLocal: { ...(current.medianLocal ?? {}), ...updates.medianLocal } }
        : {}),
      ...(updates.buyOrderLocal
        ? { buyOrderLocal: { ...(current.buyOrderLocal ?? {}), ...updates.buyOrderLocal } }
        : {}),
      localCurrency: targetCurrency,
      ...(updates.fetchedUtc
        ? { fetchedUtc: { ...(current.fetchedUtc ?? {}), ...updates.fetchedUtc } }
        : {}),
    };
    this.deps.lookupPrices.replaceSnapshot(merged);
    return true;
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
      const updatedPricesLocal: Record<string, number | null> = {};
      const updatedMedianLocal: Record<string, number | null> = {};
      const updatedBuyOrderLocal: Record<string, number | null> = {};
      const updatedFetchedUtc: Record<string, string> = {};
      // 在 cycle 开始时读取用户货币，写入 pricesLocal/medianLocal/buyOrderLocal + localCurrency
      const targetCurrency = this.deps.getCurrency();

      this.currentProgress = {
        targets: targets.length,
        processed: 0,
        priced: 0,
        rateLimited: 0,
        failed: 0,
      };
      this.emitStatus();

      for (const hash of targets) {
        const result = await this.fetchOne(hash, targetCurrency);
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
          // usd: number | null → 写 prices[hash]（null 表示已确认无挂单）；
          // undefined → 未抓取 USD（fetchLocal 注入路径），保留原 prices[hash]
          if (result.usd !== undefined) {
            updatedPrices[hash] = result.usd;
          }
          // 目标货币价格写 pricesLocal（UI 优先用这个，无 FX 误差）
          updatedPricesLocal[hash] = result.localAmount;
          // 中位数成交价（同源 priceoverview.median_price）
          if (result.median !== undefined) {
            updatedMedianLocal[hash] = result.median;
          }
          // 最高收购价（itemordershistogram.highest_buy_order；nameid 解析失败时为 null）
          if (result.buyOrder !== undefined) {
            updatedBuyOrderLocal[hash] = result.buyOrder;
          }
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
        this.mergeUpdatesIntoSnapshot(
          {
            prices: updatedPrices,
            pricesLocal: updatedPricesLocal,
            medianLocal: updatedMedianLocal,
            buyOrderLocal: updatedBuyOrderLocal,
            fetchedUtc: updatedFetchedUtc,
          },
          targetCurrency,
        );
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

  /**
   * 手动触发单个 hash 的三档价格抓取（用户在图鉴 UI 点「立即刷新此物品」按钮）。
   *
   * 与 {@link pollOnce} 的差异：
   *   - 不依赖 `config.enabled`：即使 polling 关闭，也允许单次手动抓取
   *   - 不走 selectPollingTargets：直接抓传入的 hash（跳过 owned/watched 过滤）
   *   - 共用 `cycleRunning` 锁：与 pollOnce 互斥，避免同时跑两轮撞 Steam 限流
   *   - 复用 {@link fetchOne} + {@link mergeUpdatesIntoSnapshot}：与 cycle 路径
   *     走完全相同的抓取与 merge 逻辑，保证结果一致
   *
   * 返回值与 pollOnce 同形（targets=1, priced=0|1, aborted=…）。UI 应通过
   * `useLookupPricePolling()` 的 `running` 字段反映加载态，而非 await 这个
   * promise（结果通过 LOOKUP_PRICES 流式 push 回来）。
   */
  async pollSingleHash(hash: string): Promise<PollingCycleResult> {
    const trimmed = hash?.trim();
    if (!trimmed) {
      return { targets: 0, priced: 0, rateLimited: 0, failed: 0, aborted: true };
    }
    if (this.cycleRunning) {
      log.info(`pollSingleHash: skip (${trimmed}); another cycle is running`);
      return { targets: 0, priced: 0, rateLimited: 0, failed: 0, aborted: true };
    }

    this.cycleRunning = true;
    try {
      const targetCurrency = this.deps.getCurrency();
      this.currentProgress = { targets: 1, processed: 0, priced: 0, rateLimited: 0, failed: 0 };
      this.emitStatus();
      log.info(`pollSingleHash: ${trimmed} (currency=${targetCurrency})`);

      const result = await this.fetchOne(trimmed, targetCurrency);
      // 诊断日志：记录 fetchOne 返回的每档价格，便于排查「副行不显示」问题
      log.info(
        `pollSingleHash fetchOne: ${trimmed} ok=${result.ok} ` +
          `localAmount=${result.localAmount} median=${result.median} ` +
          `buyOrder=${result.buyOrder} rateLimited=${result.rateLimited}`,
      );
      let priced = 0;
      let rateLimited = 0;
      let failed = 0;
      // 单 hash 路径不会触发熔断（MAX_CONSECUTIVE_RATE_LIMITS=3），aborted 恒为 false

      if (result.rateLimited) {
        rateLimited = 1;
      } else if (result.ok) {
        priced = 1;
        const updates: {
          prices?: Record<string, number | null>;
          pricesLocal: Record<string, number | null>;
          medianLocal: Record<string, number | null>;
          buyOrderLocal: Record<string, number | null>;
          fetchedUtc: Record<string, string>;
        } = {
          pricesLocal: { [trimmed]: result.localAmount },
          medianLocal: {},
          buyOrderLocal: {},
          fetchedUtc: { [trimmed]: new Date().toISOString() },
        };
        if (result.usd !== undefined) {
          updates.prices = { [trimmed]: result.usd };
        }
        if (result.median !== undefined) {
          updates.medianLocal[trimmed] = result.median;
        }
        if (result.buyOrder !== undefined) {
          updates.buyOrderLocal[trimmed] = result.buyOrder;
        }
        this.mergeUpdatesIntoSnapshot(updates, targetCurrency);
      } else {
        failed = 1;
      }

      if (this.currentProgress) {
        this.currentProgress.processed = 1;
        this.currentProgress.priced = priced;
        this.currentProgress.rateLimited = rateLimited;
        this.currentProgress.failed = failed;
      }

      const cycleResult: PollingCycleResult = {
        targets: 1,
        priced,
        rateLimited,
        failed,
        aborted: false,
      };
      this.lastCycleResult = cycleResult;
      this.lastCycleAtMs = Date.now();
      this.currentProgress = null;
      log.info(
        `pollSingleHash end: ${trimmed} priced=${priced} rateLimited=${rateLimited} failed=${failed}`,
      );
      this.emitStatus();
      return cycleResult;
    } finally {
      this.cycleRunning = false;
    }
  }

  /**
   * 抓单个 hash 的三档价格：
   *   - 最低出售价（lowest_price）：写 pricesLocal[hash]
   *   - 最近成交价中位数（median_price）：写 medianLocal[hash]
   *   - 最高收购价（highest_buy_order）：写 buyOrderLocal[hash]
   *
   * 调用顺序：
   *   1. priceoverview（一次）：同时拿 lowest + median
   *   2. itemordershistogram（一次）：拿 buyOrder（需先解析 item_nameid）
   *
   * 当目标货币就是 USD 时，priceoverview 一次调用搞定 lowest + median。
   * 非 USD 时，再额外抓一次 USD 写 prices（给其他货币用户回退用）。
   *
   * 返回值语义：
   *   - usd:        number | null | undefined
   *     - number    = 抓到的 USD 价格（写 prices[hash]）
   *     - null      = 抓取成功但无挂单（写 prices[hash] = null）
   *     - undefined = 未抓取 USD（fetchLocal 注入路径），保留原 prices[hash]
   *   - localAmount: number | null  = 目标货币最低出售价（写 pricesLocal[hash]）
   *   - median:     number | null | undefined
   *     - number/null = 写 medianLocal[hash]（null = 无成交记录）
   *     - undefined   = 未抓取 median（fetchLocal 注入路径未提供），保留原值
   *   - buyOrder:    number | null | undefined
   *     - number/null = 写 buyOrderLocal[hash]（null = 无收购单）
   *     - undefined   = nameid 解析失败或注入路径未提供，保留原值
   *
   * 任何子调用 429 都会立即返回 rateLimited=true，让外层熔断逻辑统一处理。
   */
  private async fetchOne(
    hash: string,
    targetCurrency: string,
  ): Promise<{
    ok: boolean;
    usd: number | null | undefined;
    localAmount: number | null;
    median: number | null | undefined;
    buyOrder: number | null | undefined;
    rateLimited: boolean;
  }> {
    // 测试注入路径：fetchLocal 优先（同时覆盖 lowest + median）
    if (this.deps.fetchLocal) {
      const r = await this.deps.fetchLocal(hash, targetCurrency);
      // fetchLocal 注入路径不抓 USD，用 undefined 保留原 prices[hash]
      // median 由注入决定（可选提供）
      const median = r.median !== undefined ? r.median : undefined;
      // 进一步尝试 buyOrder（如果注入了 fetchBuyOrder 或有 nameIdService）
      const buyOrder = await this.tryFetchBuyOrder(hash, targetCurrency);
      return {
        ok: r.ok,
        usd: undefined,
        localAmount: r.amount,
        median,
        buyOrder,
        rateLimited: r.rateLimited,
      };
    }
    if (this.deps.fetchUsd) {
      // 简化注入路径：fetchUsd 只提供 usd，localAmount/usd 同源
      // median 和 buyOrder 仍尝试从真实接口抓（不常见，主要为兼容旧测试）
      const r = await this.deps.fetchUsd(hash);
      const median = await this.tryFetchMedianFromOverview(hash, targetCurrency);
      const buyOrder = await this.tryFetchBuyOrder(hash, targetCurrency);
      return {
        ok: r.ok,
        usd: r.usd,
        localAmount: r.usd,
        median,
        buyOrder,
        rateLimited: r.rateLimited,
      };
    }

    const isUsd = targetCurrency.toUpperCase() === "USD";
    // 总是抓一次目标货币 priceoverview（同时拿 lowest + median）
    const localResponse = await fetchSteamPrice(hash, isUsd ? "USD" : targetCurrency);
    if (!localResponse.ok && localResponse.status === 429) {
      return { ok: false, usd: null, localAmount: null, median: null, buyOrder: null, rateLimited: true };
    }
    if (!localResponse.ok) {
      return { ok: false, usd: null, localAmount: null, median: null, buyOrder: null, rateLimited: false };
    }
    const localAmount = localResponse.entry.lowest ?? null;
    const localMedian = localResponse.entry.median ?? null;

    let usd: number | null;
    if (isUsd) {
      // 目标就是 USD，一次调用搞定
      usd = localAmount;
    } else {
      // 目标不是 USD：再抓一次 USD 写 prices（给其他货币用户回退用）
      const usdResponse = await fetchSteamPrice(hash, "USD");
      if (!usdResponse.ok && usdResponse.status === 429) {
        // USD 抓取被限流，但 local 已经成功——保留 local 数据，跳过 USD 写入
        return {
          ok: true,
          usd: undefined,
          localAmount,
          median: localMedian,
          buyOrder: await this.tryFetchBuyOrder(hash, targetCurrency),
          rateLimited: false,
        };
      }
      usd = usdResponse.ok ? (usdResponse.entry.lowest ?? usdResponse.entry.median ?? null) : null;
    }

    // 尝试抓 buyOrder（nameid 解析失败时返回 undefined，不影响 lowest/median）
    const buyOrder = await this.tryFetchBuyOrder(hash, targetCurrency);

    return {
      ok: true,
      usd,
      localAmount,
      median: localMedian,
      buyOrder,
      rateLimited: false,
    };
  }

  /**
   * 在 fetchUsd 注入路径下补抓 median：调一次 priceoverview（目标货币）。
   * 主要用于兼容旧测试的 fetchUsd 注入；正常路径不会走到这里。
   * 任何失败都返回 null（median 视为「无成交记录」）。
   */
  private async tryFetchMedianFromOverview(
    hash: string,
    targetCurrency: string,
  ): Promise<number | null> {
    try {
      const res = await fetchSteamPrice(hash, targetCurrency);
      if (!res.ok) return null;
      return res.entry.median ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 抓 buyOrder：先解析 item_nameid，再调 itemordershistogram。
   * - nameIdService 未注入或解析失败 → 返回 undefined（保留原 buyOrderLocal[hash]）
   * - 解析成功但 histogram 调用失败 → 返回 null（视为「无收购单」）
   * - 解析成功且 histogram 返回数据 → 返回 buyOrder 数值或 null
   * 429 时不计入熔断（buyOrder 是辅助数据），仅返回 null。
   */
  private async tryFetchBuyOrder(
    hash: string,
    targetCurrency: string,
  ): Promise<number | null | undefined> {
    // 测试注入路径
    if (this.deps.fetchBuyOrder) {
      const r = await this.deps.fetchBuyOrder(hash, targetCurrency);
      return r.ok ? r.buyOrder : null;
    }
    if (!this.deps.nameIdService) {
      log.info(`tryFetchBuyOrder: ${hash} skip (nameIdService not injected)`);
      return undefined;
    }
    try {
      const nameIdResult = await this.deps.nameIdService.resolve(hash);
      if (!nameIdResult.ok) {
        // nameid 解析失败：记录原因（429 / HTTP 错误 / parse miss），便于诊断
        // 429 时 retryAfterMs 可能有值；其他情况 status 反映 HTTP 状态码
        log.info(
          `tryFetchBuyOrder: ${hash} nameid resolve failed (status=${nameIdResult.status}` +
            (nameIdResult.retryAfterMs ? ` retryAfter=${nameIdResult.retryAfterMs}ms` : "") +
            ")",
        );
        return undefined;
      }
      const buyOrderResult = await fetchSteamBuyOrder(nameIdResult.nameId, hash, targetCurrency);
      if (!buyOrderResult.ok) {
        // histogram 调用失败：视为「无收购单」，写 null
        log.info(
          `tryFetchBuyOrder: ${hash} histogram failed (status=${buyOrderResult.status})`,
        );
        return null;
      }
      return buyOrderResult.buyOrder ?? null;
    } catch (err) {
      log.warn(`tryFetchBuyOrder: ${hash} exception: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
