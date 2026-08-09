// 市场交易额服务。
//
// 数据来源有两路：
//  1. 轮询快照（实时）：LookupPricePollingService 每次 priceoverview 抓到的
//     24h 成交量 `volume` 与成交价中位数 `median`，累积成「hash -> 最近一次」
//     映射，并周期性聚合成 {@link MarketVolumeSample}（24h 滚动成交额）持久化。
//  2. 历史（走势）：按需拉取 poll targets 的 Steam `/market/pricehistory`，
//     得到每个物品的真实小时成交量×成交价，聚合成按小时桶的成交额序列
//     {@link MarketVolumeHourPoint}（真实小时增量），供 24h/7d 走势展示。
//
// pricehistory 是历史数据，无需频繁拉取，故采用「按需 + 缓存 + 节流」：
// `refreshHistory()` 在缓存过期（默认 30 分钟）且未在刷新时，串行拉取有限数量
// 的 targets 并聚合，完成后持久化并广播，避免高频请求触发 Steam 限流。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  LookupItem,
  MarketVolumeHourPoint,
  MarketVolumeItem,
  MarketVolumeItemStats,
  MarketVolumeSample,
  MarketVolumeStats,
} from "../../../shared/types";
import {
  aggregateHistoryToHourly,
  aggregateItemVolume,
  aggregateLiveItems,
  aggregateSamplesToTrend,
  aggregateVolume,
  VOLUME_CATEGORY_OTHER,
  volumeCategoryKey,
  type PriceHistoryPoint,
  type VolumeHashSample,
} from "../../core/marketVolume";
import { marketHashName } from "../../core/marketName";
import { createLogger } from "../log";
import { resolveUserDataDir } from "./appData";
import { fetchSteamPriceHistory } from "./steamPriceApi";

const log = createLogger("marketVolume");

export const MARKET_VOLUME_FILE = "market_volume_history.json";
/** 最多保留多少条轮询采样（约 7 天：每 10 分钟一次 ≈ 1008 条）。 */
export const MAX_SAMPLES = 1200;
/** 历史缓存过期时间（ms）：30 分钟内不重复拉取 pricehistory。 */
export const HISTORY_REFRESH_MS = 30 * 60_000;
/** 每批历史拉取最多处理的物品数（Steam 对 pricehistory 限流较严，约超过 10 个即触发，故每批封顶 10 个）。 */
export const MAX_HISTORY_TARGETS = 10;
/** 批内请求间隔（ms），串行拉取时避免瞬时爆发触发限流。 */
const HISTORY_FETCH_DELAY_MS = 1500;
/** 批间等待（ms）：每拉完一批（10 个）后等待 2 分钟再拉下一批，规避 Steam 限流。 */
const HISTORY_BATCH_DELAY_MS = 2 * 60 * 1000;
/** 采样间最小间隔（ms）：同一时刻附近不重复采样。 */
const MIN_SAMPLE_INTERVAL_MS = 60 * 1000;

export interface MarketVolumeDeps {
  /** 返回当前图鉴物品目录（用于把 hash 归到类别）。 */
  getCatalog: () => LookupItem[];
  /** 返回当前用户选择的显示货币（如 "USD"/"CNY"）。 */
  getCurrency: () => string;
  /** 返回用于历史拉取的 market_hash_name 列表（owned ∪ watched）。 */
  getTargetHashes: () => string[];
  /** 返回用户填写的 Steam 社区 Cookie（完整 Cookie 头字符串，可为空）。 */
  getCookie: () => string;
  /** 注入用于测试；默认 userData 路径。 */
  filePath?: () => string;
  /** 注入用于测试；默认走 Steam pricehistory。 */
  fetchHistory?: (
    hash: string,
    currency: string,
    cookie?: string,
  ) => Promise<PriceHistoryResultLike>;
  /**
   * 历史拉取进度回调（每处理完一个 hash 调用一次）。交易页利用它推送
   * 「刷新历史价格」的实时进度。可选。
   */
  onHistoryProgress?: (p: {
    running: boolean;
    total: number;
    done: number;
    current: string | null;
    /** 单个 hash 刷新完成后的最新卡片（仅当确实拉到数据时携带），供前端实时更新。 */
    updatedItem?: MarketVolumeItem;
  }) => void;
}

/** fetchHistory 的最小返回形状（与 steamPriceApi 的 SteamPriceHistoryResult 兼容）。 */
export interface PriceHistoryResultLike {
  ok: boolean;
  points?: PriceHistoryPoint[];
  /** HTTP 状态码；0 表示网络错误。 */
  status?: number;
  /** 失败原因（network/http/no_listing/parse 等，仅失败时）。 */
  reason?: string;
  /** 429 限流时 Steam 建议的等待时间（ms）。 */
  retryAfterMs?: number;
}

interface PersistedMarketVolume {
  samples: MarketVolumeSample[];
  historyHourly: MarketVolumeHourPoint[];
  /** 原始 pricehistory 点：hash -> 该物品的全部历史点（保留天/小时混合粒度），供后续按需再聚合。 */
  priceHistory: Record<string, PriceHistoryPoint[]>;
  itemCount: number;
  itemCountsByCategory: Record<string, number>;
  /** 上次成功刷新 pricehistory 的时间（ms），持久化以便重启后仍命中 30min 缓存。 */
  historyFetchedAtMs?: number;
}

export class MarketVolumeService {
  /** hash -> 最近一次成交量/成交价采样（实时累积，内存态）。 */
  private live: Map<string, VolumeHashSample> = new Map();
  /** 轮询采样历史（旧→新），用于 latest 快照。 */
  private samples: MarketVolumeSample[] = [];
  /** pricehistory 聚合的小时成交额序列（升序，最新在最后），用于走势。 */
  private historyHourly: MarketVolumeHourPoint[] = [];
  /** 原始 pricehistory 点（hash -> 全部历史点），保留混合粒度，供后续按需再聚合。 */
  private priceHistory: Record<string, PriceHistoryPoint[]> = {};
  /** 历史统计覆盖的物品种数（有有效 pricehistory 数据的 hash）。 */
  private historyItemCount = 0;
  /** 各分类覆盖的物品种数。 */
  private historyItemCountsByCategory: Record<string, number> = {};
  private lastSampleAtMs = 0;
  private historyFetchedAtMs = 0;
  private refreshing = false;
  private readonly filePath: () => string;

  constructor(private readonly deps: MarketVolumeDeps) {
    this.filePath = deps.filePath ?? (() => join(resolveUserDataDir(), MARKET_VOLUME_FILE));
    this.loadHistory();
  }

  /** 从磁盘加载历史（兼容旧版纯数组格式）。 */
  private loadHistory(): void {
    try {
      const path = this.filePath();
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as unknown;
      if (Array.isArray(raw)) {
        // 旧版格式：纯 MarketVolumeSample[]。
        this.samples = raw.filter(
          (s): s is MarketVolumeSample =>
            !!s && typeof s.timestamp === "string" && typeof s.total === "number",
        );
      } else if (raw && typeof raw === "object") {
        const p = raw as PersistedMarketVolume;
        if (Array.isArray(p.samples)) {
          this.samples = p.samples.filter(
            (s): s is MarketVolumeSample =>
              !!s && typeof s.timestamp === "string" && typeof s.total === "number",
          );
        }
        if (Array.isArray(p.historyHourly)) {
          this.historyHourly = p.historyHourly.filter(
            (h): h is MarketVolumeHourPoint =>
              !!h && typeof h.hour === "string" && typeof h.total === "number",
          );
        }
        if (p.priceHistory && typeof p.priceHistory === "object") {
          this.priceHistory = {};
          for (const [hash, pts] of Object.entries(p.priceHistory)) {
            if (Array.isArray(pts)) {
              this.priceHistory[hash] = pts.filter(
                (pt): pt is PriceHistoryPoint =>
                  !!pt &&
                  Number.isFinite(pt.timestamp) &&
                  Number.isFinite(pt.price) &&
                  Number.isFinite(pt.volume),
              );
            }
          }
        }
        if (typeof p.itemCount === "number") this.historyItemCount = p.itemCount;
        if (p.itemCountsByCategory && typeof p.itemCountsByCategory === "object") {
          this.historyItemCountsByCategory = p.itemCountsByCategory;
        }
        if (typeof p.historyFetchedAtMs === "number")
          this.historyFetchedAtMs = p.historyFetchedAtMs;
      }
    } catch (err) {
      log.warn(`Failed to load market volume history: ${(err as Error).message}`);
      this.samples = [];
      this.historyHourly = [];
      this.priceHistory = {};
      this.historyItemCount = 0;
      this.historyItemCountsByCategory = {};
    }
  }

  /** 持久化历史。 */
  private saveHistory(): void {
    try {
      const path = this.filePath();
      mkdirSync(dirname(path), { recursive: true });
      const payload: PersistedMarketVolume = {
        samples: this.samples,
        historyHourly: this.historyHourly,
        priceHistory: this.priceHistory,
        itemCount: this.historyItemCount,
        itemCountsByCategory: this.historyItemCountsByCategory,
        historyFetchedAtMs: this.historyFetchedAtMs,
      };
      writeFileSync(path, JSON.stringify(payload));
    } catch (err) {
      log.warn(`Failed to save market volume history: ${(err as Error).message}`);
    }
  }

  /** 记录一次轮询采样（hash 维度）。 */
  recordVolume(hash: string, volume: number, median: number | null, _currency: string): void {
    if (!hash) return;
    if (!Number.isFinite(volume) || volume < 0) return;
    this.live.set(hash, { volume, median });
  }

  /** 把当前轮询实时映射聚合成一次采样并持久化。 */
  sampleNow(now = new Date().getTime()): MarketVolumeSample | null {
    if (now - this.lastSampleAtMs < MIN_SAMPLE_INTERVAL_MS) return null;
    const sample = this.buildSample(now);
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.slice(-MAX_SAMPLES);
    }
    this.lastSampleAtMs = now;
    this.saveHistory();
    return sample;
  }

  /** 用当前轮询实时映射构造一次采样（不落盘）。 */
  private buildSample(nowMs: number): MarketVolumeSample {
    const itemsByHash = this.buildItemsByHash();
    return aggregateVolume(
      itemsByHash,
      this.live,
      this.deps.getCurrency(),
      new Date(nowMs).toISOString(),
    );
  }

  private buildItemsByHash(): Map<string, LookupItem> {
    const itemsByHash = new Map<string, LookupItem>();
    for (const item of this.deps.getCatalog()) {
      const hash = marketHashName(item);
      if (hash) itemsByHash.set(hash, item);
    }
    return itemsByHash;
  }

  /**
   * 按需拉取 pricehistory 并刷新小时走势数据。
   *
   * 缓存过期（HISTORY_REFRESH_MS）且未在刷新时才真正拉取（除非 `force`）；
   * 目标集默认取 `deps.getTargetHashes()`（owned ∪ watched），可传 `targets`
   * 覆盖（交易页「刷新历史价格」按钮用：星标 ∪ 快照阈值以上全部物品）。
   * 成功刷新后持久化。返回是否触发了刷新（未发请求且未过期时返回 false）。
   */
  async refreshHistory(
    now = Date.now(),
    opts?: { targets?: readonly string[]; force?: boolean },
  ): Promise<boolean> {
    const targets = opts?.targets ?? this.deps.getTargetHashes();
    if (!opts?.force && now - this.historyFetchedAtMs < HISTORY_REFRESH_MS) return false;
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      const currency = this.deps.getCurrency();
      const cookie = this.deps.getCookie();
      const fetchOne = this.deps.fetchHistory ?? fetchSteamPriceHistory;
      // 诊断：刷新开始，记录是否配置 Cookie 及其包含的键名（不打印值，避免泄露），
      // 便于确认「已配置但 400」时合成的 Cookie 头是否包含 Steam 期望的字段。
      const cookieKeys = cookie
        ? [
            ...new Set(
              cookie
                .split(";")
                .map((p) => p.split("=")[0].trim())
                .filter(Boolean),
            ),
          ]
        : [];
      log.info(
        `refreshHistory start: targets=${targets.length}, cookieConfigured=${cookie.length > 0}, ` +
          `cookieKeys=[${cookieKeys.join(",")}], currency=${currency}`,
      );
      const historyByHash = new Map<string, PriceHistoryPoint[]>();
      // 按每批 MAX_HISTORY_TARGETS 个分组串行拉取；批内间隔 HISTORY_FETCH_DELAY_MS，
      // 每拉完一批等待 HISTORY_BATCH_DELAY_MS（2 分钟）再拉下一批，规避 Steam 限流。
      let done = 0;
      for (let i = 0; i < targets.length; i += MAX_HISTORY_TARGETS) {
        const batch = targets.slice(i, i + MAX_HISTORY_TARGETS);
        for (const hash of batch) {
          this.deps.onHistoryProgress?.({
            running: true,
            total: targets.length,
            done,
            current: hash,
          });
          let updatedItem: MarketVolumeItem | undefined;
          try {
            const r = await fetchOne(hash, currency, cookie);
            if (r.ok && r.points && r.points.length > 0) {
              historyByHash.set(hash, r.points);
              // 实时更新内存态：该 hash 立即反映最新价格，供前端实时刷新卡片
              // （持久化在全部拉完之后统一做，避免频繁写盘）。
              this.priceHistory[hash] = r.points;
              updatedItem = this.buildItemForHash(hash);
              log.info(`refreshHistory: ${hash} ok (${r.points.length} points)`);
            } else {
              // 诊断：拉取「完成」但无数据时要能看出原因（400 无 Cookie / 429 限流 / 网络错误 / 该物品无成交）。
              // 用宽松查看避免判别联合窄化问题（PriceHistoryResultLike.ok 为 boolean）。
              const view = r as { status?: number; reason?: string; retryAfterMs?: number };
              const reason = view.reason ?? (r.ok ? "no_data" : "failed");
              const retry = view.retryAfterMs ? `, retryAfter=${view.retryAfterMs}ms` : "";
              log.warn(
                `refreshHistory: ${hash} no data (status=${view.status ?? 0}, reason=${reason}${retry})`,
              );
            }
          } catch (err) {
            // 单个物品失败不影响其余物品
            log.warn(`refreshHistory: ${hash} threw: ${(err as Error).message}`);
          }
          done++;
          this.deps.onHistoryProgress?.({
            running: true,
            total: targets.length,
            done,
            current: null,
            updatedItem,
          });
          await new Promise((resolve) => setTimeout(resolve, HISTORY_FETCH_DELAY_MS));
        }
        if (i + MAX_HISTORY_TARGETS < targets.length) {
          await new Promise((resolve) => setTimeout(resolve, HISTORY_BATCH_DELAY_MS));
        }
      }
      const agg = aggregateHistoryToHourly(historyByHash, this.buildItemsByHash());
      // 诊断：刷新结束，汇总成功拉到的物品数与小时桶数，便于判断是否整体无数据。
      log.info(
        `refreshHistory end: fetched=${historyByHash.size}/${targets.length}, hourlyBuckets=${agg.points.length}`,
      );
      // 一次刷新拿到该物品全部历史（仅粒度随新旧变化），故保留全部小时桶，不截断，
      // 供全量走势展示；同时保存原始 pricehistory 点，供后续按需再聚合。
      // 仅当确实拉到数据时才覆盖历史数组，避免失败把已有好数据清空。
      if (agg.points.length > 0) {
        this.historyHourly = agg.points;
        this.priceHistory = Object.fromEntries(historyByHash);
        this.historyItemCount = agg.itemCount;
        this.historyItemCountsByCategory = agg.itemCountsByCategory;
      }
      // 无论成败都记录拉取时机，命中 30min 缓存去抖，避免每次轮询/打开页面都
      // 高频重试触发 Steam 限流。返回是否确实刷新到了新数据（决定是否广播）。
      this.historyFetchedAtMs = now;
      this.saveHistory();
      // 刷新完成：通知 renderer 结束运行态（清空进度提示）。
      this.deps.onHistoryProgress?.({
        running: false,
        total: targets.length,
        done: targets.length,
        current: null,
      });
      return agg.points.length > 0;
    } finally {
      this.refreshing = false;
    }
  }

  /** 返回当前统计（最新轮询快照 + 按小时走势）。 */
  getStats(): MarketVolumeStats {
    const latest = this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
    let hourly = this.historyHourly;
    let itemCount = this.historyItemCount;
    let itemCountsByCategory = this.historyItemCountsByCategory;
    // pricehistory 历史未拉到数据时，回退到轮询采样快照构建走势，保证 Market 页
    // 「走势图直接给出」，不因 Steam 对 pricehistory 限流而空白。
    if (hourly.length === 0 && this.samples.length > 0) {
      hourly = aggregateSamplesToTrend(this.samples);
      itemCount = latest?.items ?? 0;
      // 采样快照只含分类金额、不含分类物品种数，故分类物品数置空（图例显示 0）。
      itemCountsByCategory = {};
    }
    log.info(
      `[volume-stats] getStats called hourly=${hourly.length} (${hourly[0]?.hour}..${hourly[hourly.length - 1]?.hour})`,
    );
    return {
      latest,
      hourly,
      itemCount,
      itemCountsByCategory,
      currency: this.deps.getCurrency(),
    };
  }

  /** 返回原始 pricehistory 点（hash -> 全部历史点，保留混合粒度），供按需再聚合/展示。 */
  getPriceHistory(): Readonly<Record<string, readonly PriceHistoryPoint[]>> {
    return this.priceHistory;
  }

  /**
   * 构造单个 hash 的最新「物品维度」卡片（刷新过程中实时推送用）。
   *
   * 复用该 hash 已存在（含刚实时写入）的 pricehistory 聚合出带走势的卡片；
   * 无有效交易额数据时回退为空白卡片（仅展示名与分类）。
   */
  private buildItemForHash(hash: string): MarketVolumeItem {
    const item = this.buildItemsByHash().get(hash);
    const pts = this.priceHistory[hash] ?? [];
    const agg = aggregateItemVolume(new Map([[hash, pts]]), this.buildItemsByHash());
    return (
      agg[0] ?? {
        hash,
        name: item?.name ?? hash,
        category: item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER,
        grade: item?.grade,
        total: 0,
        points: [],
      }
    );
  }

  /**
   * 构造「待刷新」目标物品的占位卡片（交易页刷新进行中提前展示）。
   *
   * 输入为待刷新的 market_hash_name 列表（如 `selectHistoryRefreshTargets`
   * 的结果）。若该 hash 已拉取过 pricehistory（存在历史数据），则**复用历史
   * 数据生成带走势的卡片**（总交易额与小时 points 齐全，刷新过程中不因尚未
   * 拉到最新数据而丢失图表）；否则生成为 `total=0`、`points=[]` 的空白占位
   * （首次刷新 / 尚无任何历史），仅展示名与分类。按输入顺序返回（目标集已按
   * 星标优先/价格降序排好）。
   */
  buildPendingItems(targets: readonly string[]): MarketVolumeItem[] {
    const itemsByHash = this.buildItemsByHash();
    // 复用已有 pricehistory 聚合出「带走势」的卡片，避免刷新过程中图表消失。
    const existingByHash = new Map(
      aggregateItemVolume(new Map(Object.entries(this.priceHistory)), itemsByHash).map((i) => [
        i.hash,
        i,
      ]),
    );
    const out: MarketVolumeItem[] = [];
    const seen = new Set<string>();
    for (const hash of targets) {
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      const item = itemsByHash.get(hash);
      out.push(
        existingByHash.get(hash) ?? {
          hash,
          name: item?.name ?? hash,
          category: item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER,
          grade: item?.grade,
          total: 0,
          points: [],
        },
      );
    }
    return out;
  }

  /**
   * 按已有交易额对待刷新目标从高到低排序（交易页二次及以后刷新用）。
   *
   * 交易额数据沿用 {@link getVolumeItems} 的合并口径（pricehistory 聚合为主、
   * live 快照 volume×median 补充）。有交易额数据的 hash 按 total 降序排在前面，
   * 无交易额数据的（如首次刷新、尚无任何历史/采样）保持原相对顺序排最后。
   * 这样「先刷新交易额高的物品」。
   */
  sortTargetsByVolume(targets: readonly string[]): string[] {
    const totalByHash = new Map<string, number>();
    for (const item of this.getVolumeItems().items) {
      totalByHash.set(item.hash, item.total);
    }
    const withVolume = targets
      .filter((h) => h && totalByHash.has(h))
      .sort((a, b) => (totalByHash.get(b) ?? 0) - (totalByHash.get(a) ?? 0));
    const withoutVolume = targets.filter((h) => h && !totalByHash.has(h));
    return [...withVolume, ...withoutVolume];
  }

  /**
   * 返回「物品维度」的交易额卡片数据（交易页），按总交易额降序。
   *
   * 合并两路数据：
   *  - pricehistory 按小时聚合（含小时走势 points），为主；
   *  - 轮询 live 快照（volume × median，无走势）补充 pricehistory 尚未覆盖到的
   *    物品，保证卡片尽量齐全。同一 hash 以 pricehistory 为准。
   */
  getVolumeItems(): MarketVolumeItemStats {
    const itemsByHash = this.buildItemsByHash();
    const currency = this.deps.getCurrency();
    const historyByHash = new Map(Object.entries(this.priceHistory));
    const historyItems = aggregateItemVolume(historyByHash, itemsByHash);
    const liveItems = aggregateLiveItems(itemsByHash, this.live);
    const historyHashes = new Set(historyItems.map((item) => item.hash));
    const merged = [...historyItems, ...liveItems.filter((item) => !historyHashes.has(item.hash))];
    merged.sort((a, b) => b.total - a.total);
    return { items: merged, currency };
  }
}

/**
 * 判断一个采样是否「有内容」（至少 1 个物品计入交易额），供 UI 判断
 * 是否显示空态。
 */
export function hasVolumeData(sample: MarketVolumeSample | null): boolean {
  return !!sample && sample.items > 0 && sample.total > 0;
}
