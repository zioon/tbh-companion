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
  MARKET_VOLUME_BASE_CURRENCY,
  aggregateHistoryToHourly,
  aggregateItemVolume,
  aggregateLiveActivityItems,
  aggregateLiveItems,
  aggregateSamplesToTrend,
  aggregateVolume,
  calibratePricesWithMedian,
  computeConversionRate,
  detectCurrencyFromPriceHistory,
  inferMarketVolumeCurrency,
  mergeParsedHistory,
  mergePriceHistoryPoints,
  orderRefreshTargets,
  parseMarketVolumeHistory,
  recentVolumeTotal,
  rescaleMarketVolumeItems,
  rescaleParsedHistory,
  rescaleVolumeStats,
  VOLUME_CATEGORY_OTHER,
  volumeCategoryKey,
  type CurrencyDetection,
  type LiveVolumePoint,
  type ParsedMarketVolumeHistory,
  type PriceHistoryPoint,
  type RefreshTargetVolume,
  type VolumeHashSample,
} from "../../core/marketVolume";

import { marketHashName } from "../../core/marketName";
import { createLogger } from "../log";
import { resolveUserDataDir } from "./appData";
import { fetchSteamPrice, fetchSteamPriceHistory } from "./steamPriceApi";

const log = createLogger("marketVolume");

export const MARKET_VOLUME_FILE = "market_volume_history.json";
/** 最多保留多少条轮询采样（约 7 天：每 10 分钟一次 ≈ 1008 条）。 */
export const MAX_SAMPLES = 1200;
/** 历史缓存过期时间（ms）：1 小时内不重复拉取 pricehistory。 */
export const HISTORY_REFRESH_MS = 60 * 60_000;
/** 批内请求间隔（ms），串行拉取时避免瞬时爆发触发限流。 */
const HISTORY_FETCH_DELAY_MS = 1500;
/** SteamMarketProvider 同款熔断：连续 429 达到该次数即中止整批刷新。 */
const MAX_CONSECUTIVE_429 = 3;
/** 采样间最小间隔（ms）：同一时刻附近不重复采样。 */
const MIN_SAMPLE_INTERVAL_MS = 60 * 1000;
/** 单个 hash 最多保留多少条活跃度采样点（约 33 小时：每 1 分钟 1 条）。 */
export const MAX_LIVE_POINTS_PER_HASH = 2000;
/** 刷新排序的时间窗（秒）：最近 24h 的成交额作为「每天交易额」排序口径。 */
export const RECENT_WINDOW_SEC = 24 * 3600;
/** 每日全量覆盖的自然日毫秒（UTC day 键）。 */
export const DAY_MS = 24 * 3600_000;
/** 覆盖率阈值默认值：覆盖率主区达到该比例即视为已覆盖大头交易额。 */
export const COVERAGE_DEFAULT = 0.95;

export interface MarketVolumeDeps {
  /** 返回当前图鉴物品目录（用于把 hash 归到类别）。 */
  getCatalog: () => LookupItem[];
  /** 返回当前用户选择的**显示货币**（如 "USD"/"CNY"）。入库计价与它无关，仅用于出库换算。 */
  getCurrency: () => string;
  /** 返回用于历史拉取的 market_hash_name 列表（owned ∪ watched）。 */
  getTargetHashes: () => string[];
  /** 返回用户填写的 Steam 社区 Cookie（完整 Cookie 头字符串，可为空）。 */
  getCookie: () => string;
  /** 返回每批历史拉取处理的物品数（pricehistory 限流较严，默认 10）。 */
  getHistoryBatchSize: () => number;
  /** 返回批间等待秒数（默认 120 秒，规避 Steam 限流）。 */
  getHistoryBatchDelaySec: () => number;
  /** 返回用户收藏（星标）的 market_hash_name 列表；用于排序时星标无条件优先。 */
  getWatchedHashes?: () => string[];
  /** 返回 hash 在图鉴价格快照里的价格（USD），用作无交易额时的兜底排序；0 表示无。 */
  getSnapshotPriceUsd?: (hash: string) => number;
  /** 返回刷新覆盖率阈值（0~1），默认 0.95。覆盖率达到该比例即视为已覆盖大头交易额。 */
  getCoverageThreshold?: () => number;
  /**
   * 返回「ISO 货币 → 每 1 USD 单位」的图鉴汇率表（`LookupPriceSnapshot.fx`）。
   * 用途有三：① 采集时把显示货币的价格换算成基准货币（USD）入库；② 出库时把 USD
   * 金额换算回显示货币；③ 备份币种换算与自动探测。缺失时：采集侧跳过该次采样、
   * 出库按 USD 原值展示、导入若也推算不出比例则拒绝。
   */
  getFxRates?: () => Readonly<Record<string, number>>;
  /** 注入用于测试；默认 userData 路径。 */
  filePath?: () => string;
  /** 注入用于测试；默认走 Steam pricehistory。 */
  fetchHistory?: (
    hash: string,
    currency: string,
    cookie?: string,
  ) => Promise<PriceHistoryResultLike>;
  /**
   * 注入用于测试；默认走 Steam priceoverview。返回 hash 在 `currency` 下的
   * 成交价中位数，作为把 pricehistory 价格换算到显示货币的锚。
   */
  fetchAnchorMedian?: (hash: string, currency: string) => Promise<number | null>;
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
    /** 本次刷新开始时的待刷新占位卡片（自动/手动刷新共用，供前端展示亮环）。 */
    pending?: MarketVolumeItem[];
    /**
     * 检测到 Steam Cookie 失效（pricehistory 返回 400）时为 true，刷新已被终止，
     * 前端应收起并提示用户前往设置更新 Cookie。
     */
    cookieExpired?: boolean;
    /**
     * 该 hash 成功返回并已实时并入 priceHistory，顶部交易额走势（historyHourly）
     * 已随之重算，为 true 时前端应同步刷新最上方的走势图。
     */
    trendChanged?: boolean;
  }) => void;
}

/** fetchHistory 的最小返回形状（与 steamPriceApi 的 SteamPriceHistoryResult 兼容）。 */
export interface PriceHistoryResultLike {
  ok: boolean;
  points?: PriceHistoryPoint[];
  /** pricehistory 实际返回的货币（由 price_prefix 判定）；null 表示无法判定。 */
  currency?: string | null;
  /** HTTP 状态码；0 表示网络错误。 */
  status?: number;
  /** 失败原因（network/http/no_listing/parse 等，仅失败时）。 */
  reason?: string;
  /** 429 限流时 Steam 建议的等待时间（ms）。 */
  retryAfterMs?: number;
}

interface PersistedMarketVolume {
  /** 备份格式版本：1 = 旧版（金额按显示货币），2 = 金额统一为基准货币（USD）。 */
  version?: number;
  /**
   * 本文件金额的计价货币 ISO 码。**v2 起恒为 {@link MARKET_VOLUME_BASE_CURRENCY}**。
   * 刻意沿用 `currency` 字段名（而非新字段）是为了向下兼容：旧版应用读 v2 备份时会把
   * `"USD"` 与其当时的显示货币比对并走 fx 换算，恰好得到正确结果。
   */
  currency?: string;
  /** 轮询采样快照（金额为 USD）。 */
  samples: MarketVolumeSample[];
  /** pricehistory 聚合的小时成交额（金额为 USD）。 */
  historyHourly: MarketVolumeHourPoint[];
  /** 原始 pricehistory 点（`price` 为 USD）：hash -> 该物品的全部历史点（保留天/小时混合粒度）。 */
  priceHistory: Record<string, PriceHistoryPoint[]>;
  /** 各 hash 的活跃度采样历史（`median` 为 USD，旧→新）。 */
  liveHistory?: Record<string, LiveVolumePoint[]>;
  itemCount: number;
  itemCountsByCategory: Record<string, number>;
  /** 上次成功刷新 pricehistory 的时间（ms），持久化以便重启后仍命中 1h 缓存。 */
  historyFetchedAtMs?: number;
  /** 各 hash 最近一次发起 pricehistory 刷新的 epoch ms，保障「每天全量一遍」。 */
  lastRefreshAt?: Record<string, number>;
}

/** {@link MarketVolumeService.analyzeBackupJson} 的返回。 */
export interface MarketVolumeBackupAnalysis {
  ok: true;
  /** 备份的计价货币；null = 无法确认（旧格式且价格历史不足，需用户手动选择）。 */
  detectedCurrency: string | null;
  /**
   * 币种来源：
   * - `declared`：文件顶层 `currency` 字段（v2 文件恒为 USD）；
   * - `samples`：旧格式从 `samples[].currency` 推断；
   * - `auto`：按「备份价格历史 × USD 价格参考」推算（见 `detectCurrencyFromPriceHistory`）；
   * - null：无法确认。
   */
  detectedBy: "declared" | "samples" | "auto" | null;
  /** 自动探测的诊断信息（仅 `detectedBy === "auto"` 时非空，供 UI 显示依据/歧义）。 */
  detection: {
    method: CurrencyDetection["method"];
    samples: number;
    relativeError: number | null;
    runnerUp: CurrencyDetection["runnerUp"];
  } | null;
  /** 备份已是 USD 基准（`version >= 2`），前端可锁定币种选择器。 */
  baseCurrencyFile: boolean;
  /** 摘要：物品种数、价格历史覆盖 hash 数、原始点数、时间范围（epoch 秒）。 */
  itemCount: number;
  priceHashCount: number;
  pricePointCount: number;
  oldestTs: number | null;
  newestTs: number | null;
}

/** 默认的显示货币中位价查询：走 Steam priceoverview。 */
const defaultFetchAnchorMedian = async (hash: string, currency: string): Promise<number | null> => {
  const r = await fetchSteamPrice(hash, currency);
  if (!r.ok) return null;
  return r.entry.median ?? null;
};

export class MarketVolumeService {
  /** hash -> 最近一次成交量/成交价采样（实时累积，内存态）。 */
  private live: Map<string, VolumeHashSample> = new Map();
  /** 轮询采样历史（旧→新），用于 latest 快照。 */
  private samples: MarketVolumeSample[] = [];
  /** pricehistory 聚合的小时成交额序列（升序，最新在最后），用于走势。 */
  private historyHourly: MarketVolumeHourPoint[] = [];
  /** 原始 pricehistory 点（hash -> 全部历史点），保留混合粒度，供后续按需再聚合。 */
  private priceHistory: Record<string, PriceHistoryPoint[]> = {};
  /** 各 hash 的活跃度采样历史（旧→新），快照卡片「不刷新也随时间范围变化」用。 */
  private liveHistory: Record<string, LiveVolumePoint[]> = {};
  /** 历史统计覆盖的物品种数（有有效 pricehistory 数据的 hash）。 */
  private historyItemCount = 0;
  /** 各分类覆盖的物品种数。 */
  private historyItemCountsByCategory: Record<string, number> = {};
  private lastSampleAtMs = 0;
  private historyFetchedAtMs = 0;
  private refreshing = false;
  /** 用户手动终止整次历史刷新：置 true 后刷新循环尽快安全退出。 */
  private historyAbortRequested = false;
  /** 各 hash 最近一次发起 pricehistory 刷新的 epoch ms，保障「每天全量一遍」。 */
  private lastRefreshAt: Record<string, number> = {};
  private readonly filePath: () => string;

  constructor(private readonly deps: MarketVolumeDeps) {
    this.filePath = deps.filePath ?? (() => join(resolveUserDataDir(), MARKET_VOLUME_FILE));
    this.loadHistory();
  }

  /** 从磁盘加载历史（兼容旧版纯数组格式；解析复用 core 的 parseMarketVolumeHistory）。 */
  private loadHistory(): void {
    try {
      const path = this.filePath();
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as unknown;
      const parsed = parseMarketVolumeHistory(raw);
      if (!parsed) {
        this.resetVolumeData();
        return;
      }
      // 金额数据统一以基准货币（USD）入库。先解析文件计价货币（顶层 `currency` 优先，
      // 旧格式从 samples 推断），再等比换算到 USD —— **即使文件币种与当前显示货币
      // 不一致也不再丢弃**（这是「统一 USD 计价」的核心收益：切币/换机不再丢历史）。
      // 只有币种确实无法确认、或 fx 表缺该币种时，才保守丢弃金额数据。
      const resolved = this.resolveFileCurrency(parsed);
      const base = this.toBaseCurrency(parsed, resolved.currency);
      if (!base) {
        log.warn(
          `market volume history currency unresolved: file=${resolved.currency ?? "(unknown)"} ` +
            `source=${resolved.source ?? "(none)"}; discarding volume data`,
        );
        this.resetVolumeData();
        return;
      }
      this.samples = base.data.samples;
      this.historyHourly = base.data.historyHourly;
      this.priceHistory = base.data.priceHistory;
      this.liveHistory = base.data.liveHistory ?? {};
      this.historyItemCount = base.data.itemCount;
      this.historyItemCountsByCategory = base.data.itemCountsByCategory;
      this.historyFetchedAtMs = base.data.historyFetchedAtMs ?? 0;
      this.lastRefreshAt = base.data.lastRefreshAt ?? {};
      if (base.convertedFrom) {
        log.info(
          `market volume history converted to ${MARKET_VOLUME_BASE_CURRENCY}: ` +
            `from=${base.convertedFrom} rate=${(base.rate ?? 0).toFixed(4)}`,
        );
      }
      // 走势（historyHourly）是 priceHistory 的派生物。文件里缺失/为空但有原始点
      // 时（例如只带 priceHistory 的备份、或早期版本的残缺文件）重算一次，避免
      // 出现「有原始价格历史却没有任何走势」的不一致状态。
      if (this.historyHourly.length === 0 && Object.keys(this.priceHistory).length > 0) {
        this.recomputeHistoryTrend();
      }
      // 非 v2/USD 文件就地迁移落盘（换算后的 USD 金额 + 补写 version/currency），只做一次。
      const alreadyMigrated =
        (parsed.version ?? 0) >= 2 &&
        (resolved.currency ?? "").toUpperCase() === MARKET_VOLUME_BASE_CURRENCY;
      if (!alreadyMigrated) this.saveHistory();
    } catch (err) {
      log.warn(`Failed to load market volume history: ${(err as Error).message}`);
      this.resetVolumeData();
    }
  }

  /**
   * 解析历史/备份文件的计价货币。顶层 `currency` 优先（v2 文件恒为 USD）；旧格式
   * （顶层无 currency）用 {@link inferMarketVolumeCurrency} 从采样记录推断（旧版每条
   * 采样都带当时的显示货币），混杂/缺失时返回 null。
   */
  private resolveFileCurrency(parsed: ParsedMarketVolumeHistory): {
    currency: string | null;
    source: "declared" | "samples" | null;
  } {
    if (typeof parsed.currency === "string" && parsed.currency.trim().length > 0) {
      return { currency: parsed.currency.trim().toUpperCase(), source: "declared" };
    }
    if (parsed.samples.length > 0) {
      const inferred = inferMarketVolumeCurrency(parsed.samples);
      if (inferred) return { currency: inferred.toUpperCase(), source: "samples" };
    }
    return { currency: null, source: null };
  }

  /**
   * 把已解析快照的金额归一化到基准货币（USD）。
   *
   * - 已是基准货币 → 原样返回；
   * - 非基准货币且 `fx[该币]` 可得 → 等比换算（`rate = 1 / fx[该币]`）；
   * - **币种不可知且确有金额数据 → 返回 null**（调用方丢弃，绝不给旧币数值贴 USD 标签）；
   * - fx 表缺该币种 → 返回 null（同上，保守兜底）。
   */
  private toBaseCurrency(
    parsed: ParsedMarketVolumeHistory,
    fileCurrency: string | null,
  ): { data: ParsedMarketVolumeHistory; convertedFrom: string | null; rate: number | null } | null {
    if (fileCurrency == null) {
      // 币种不可知：仅当没有金额数据可丢时接受（相当于从空数据起步）。
      return hasVolumeAmounts(parsed) ? null : { data: parsed, convertedFrom: null, rate: null };
    }
    if (fileCurrency === MARKET_VOLUME_BASE_CURRENCY) {
      return { data: parsed, convertedFrom: null, rate: null };
    }
    const unitsPerUsd = this.unitsPerUsd(fileCurrency);
    if (unitsPerUsd == null) return null;
    const rate = 1 / unitsPerUsd;
    return { data: rescaleParsedHistory(parsed, rate), convertedFrom: fileCurrency, rate };
  }

  /** 「每 1 USD 的该币单位数」：基准货币恒为 1，其余查图鉴 fx 表。fx 缺失/无效返回 null。 */
  private unitsPerUsd(iso: string): number | null {
    const code = iso.trim().toUpperCase();
    if (code === MARKET_VOLUME_BASE_CURRENCY) return 1;
    const v = (this.deps.getFxRates?.() ?? {})[code];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * 出库换算比例：基准货币（USD）→ 显示货币。`fx[显示货币]` 有效时返回该值；
   * fx 缺失（图鉴快照尚未就绪）或该币种不在表中时**回退为 1 并标 USD** —— 宁可把
   * USD 数值标成 USD，也不标成其他币种。
   */
  private displayRate(): { rate: number; currency: string } {
    const display = this.deps.getCurrency().trim().toUpperCase();
    const units = this.unitsPerUsd(display);
    if (units == null) {
      log.warn(
        `displayRate: fx missing for ${display}; displaying raw ${MARKET_VOLUME_BASE_CURRENCY}`,
      );
      return { rate: 1, currency: MARKET_VOLUME_BASE_CURRENCY };
    }
    return { rate: units, currency: display };
  }

  /**
   * 把当前内存态拼成 {@link ParsedMarketVolumeHistory} 快照（供融合导入作为 existing 侧）。
   * 金额已是基准货币（USD）。
   */
  private buildExistingSnapshot(): ParsedMarketVolumeHistory {
    return {
      version: 2,
      currency: MARKET_VOLUME_BASE_CURRENCY,
      samples: this.samples,
      historyHourly: this.historyHourly,
      priceHistory: this.priceHistory,
      liveHistory: this.liveHistory,
      itemCount: this.historyItemCount,
      itemCountsByCategory: this.historyItemCountsByCategory,
      historyFetchedAtMs: this.historyFetchedAtMs,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  /** 清空全部金额类状态与元数据（货币不可知 / 损坏文件时用）。 */
  private resetVolumeData(): void {
    this.live.clear();
    this.samples = [];
    this.historyHourly = [];
    this.priceHistory = {};
    this.liveHistory = {};
    this.historyItemCount = 0;
    this.historyItemCountsByCategory = {};
    this.lastSampleAtMs = 0;
    this.historyFetchedAtMs = 0;
    this.lastRefreshAt = {};
  }

  /** 持久化历史（v2：金额统一为基准货币 USD）。 */
  private saveHistory(): void {
    try {
      const path = this.filePath();
      mkdirSync(dirname(path), { recursive: true });
      const payload: PersistedMarketVolume = {
        version: 2,
        currency: MARKET_VOLUME_BASE_CURRENCY,
        samples: this.samples,
        historyHourly: this.historyHourly,
        priceHistory: this.priceHistory,
        liveHistory: this.liveHistory,
        itemCount: this.historyItemCount,
        itemCountsByCategory: this.historyItemCountsByCategory,
        historyFetchedAtMs: this.historyFetchedAtMs,
        lastRefreshAt: this.lastRefreshAt,
      };
      writeFileSync(path, JSON.stringify(payload));
    } catch (err) {
      log.warn(`Failed to save market volume history: ${(err as Error).message}`);
    }
  }

  /**
   * 返回当前完整历史快照（供导出备份）。金额统一为基准货币（USD），与显示货币无关 ——
   * 因此备份可跨机、跨币种导入并**融合**。
   */
  exportHistory(): PersistedMarketVolume {
    return { ...this.buildExistingSnapshot(), version: 2 };
  }

  /**
   * 解析备份 JSON 并生成导入前摘要（供 UI 展示摘要与选择币种）。纯解析，**不改动**
   * 内存态与磁盘。
   *
   * 备份币种按「顶层 `currency` → `samples[].currency` 推断 → 价格历史自动探测」三级
   * 解析（自动探测见 {@link detectBackupCurrency}）。
   */
  analyzeBackupJson(
    json: string,
  ): MarketVolumeBackupAnalysis | { ok: false; reason: "invalid_backup" } {
    let raw: unknown;
    try {
      raw = JSON.parse(json.replace(/^\uFEFF/, ""));
    } catch {
      return { ok: false, reason: "invalid_backup" };
    }
    const parsed = parseMarketVolumeHistory(raw);
    if (!parsed) return { ok: false, reason: "invalid_backup" };

    const resolved = this.resolveFileCurrency(parsed);
    let detectedCurrency: string | null = resolved.currency;
    let detectedBy: MarketVolumeBackupAnalysis["detectedBy"] = resolved.source;
    let detection: MarketVolumeBackupAnalysis["detection"] = null;
    if (detectedCurrency == null) {
      const auto = this.detectBackupCurrency(parsed);
      if (auto.currency) {
        detectedCurrency = auto.currency;
        detectedBy = "auto";
      }
      detection = {
        method: auto.method,
        samples: auto.samples,
        relativeError: auto.relativeError,
        runnerUp: auto.runnerUp,
      };
    }

    let priceHashCount = 0;
    let pricePointCount = 0;
    let oldestTs: number | null = null;
    let newestTs: number | null = null;
    for (const pts of Object.values(parsed.priceHistory)) {
      if (pts.length === 0) continue;
      priceHashCount++;
      pricePointCount += pts.length;
      for (const p of pts) {
        if (!Number.isFinite(p.timestamp)) continue;
        if (oldestTs == null || p.timestamp < oldestTs) oldestTs = p.timestamp;
        if (newestTs == null || p.timestamp > newestTs) newestTs = p.timestamp;
      }
    }

    return {
      ok: true,
      detectedCurrency,
      detectedBy: detectedCurrency ? detectedBy : null,
      detection,
      baseCurrencyFile: (parsed.version ?? 0) >= 2,
      itemCount: parsed.itemCount,
      priceHashCount,
      pricePointCount,
      oldestTs,
      newestTs,
    };
  }

  /**
   * 备份币种**自动探测**：用备份的价格历史与「USD 价格参考」比对推算比例，再在 fx 表里
   * 匹配最接近的币种。参考源优先**现有 USD 价格历史**（内存里已是 USD，历史比历史最准），
   * 回退 **CI USD 快照的当前挂单价**（`deps.getSnapshotPriceUsd`）。
   */
  private detectBackupCurrency(parsed: ParsedMarketVolumeHistory): CurrencyDetection {
    const backupPriceHistory = new Map(Object.entries(parsed.priceHistory));
    const usdSnapshot: Record<string, number | null> = {};
    for (const hash of backupPriceHistory.keys()) {
      usdSnapshot[hash] = this.deps.getSnapshotPriceUsd?.(hash) ?? null;
    }
    return detectCurrencyFromPriceHistory({
      fx: this.deps.getFxRates?.() ?? {},
      backupPriceHistory,
      usdHistory: new Map(Object.entries(this.priceHistory)),
      usdSnapshot,
    });
  }

  /**
   * 用备份 JSON **融合**当前历史数据（不再整体替换）。
   *
   * `sourceCurrency` 传 `"auto"` 时走三级币种解析（顶层 `currency` → `samples` 推断 →
   * 价格历史自动探测）；传具体 ISO 时以用户选择为准。备份金额先等比换算到基准货币
   * （USD），再与内存态合并（`mergeParsedHistory`：`priceHistory` 按 UTC 天保留更细粒度、
   * 采样按时间键去重），**因此同一备份重复导入不会翻倍**。解析失败 / 币种无法确认 /
   * 换算比例不可得时返回失败原因且**不改动现有数据**。
   */
  importHistory(
    json: string,
    sourceCurrency: string,
  ):
    | {
        ok: true;
        itemCount: number;
        mergedHashes: number;
        mergedSamples: number;
        mergedLivePoints: number;
        converted?: { from: string; rate: number };
      }
    | { ok: false; reason: "invalid_backup" | "conversion_unavailable" } {
    let raw: unknown;
    try {
      raw = JSON.parse(json.replace(/^\uFEFF/, ""));
    } catch {
      return { ok: false, reason: "invalid_backup" };
    }
    const parsed = parseMarketVolumeHistory(raw);
    if (!parsed) return { ok: false, reason: "invalid_backup" };

    const resolved = this.resolveImportCurrency(parsed, sourceCurrency);
    if (resolved == null) {
      log.warn(
        `import market volume history: currency unresolved (requested=${sourceCurrency}); rejected`,
      );
      return { ok: false, reason: "conversion_unavailable" };
    }

    let data = parsed;
    let converted: { from: string; rate: number } | undefined;
    if (resolved !== MARKET_VOLUME_BASE_CURRENCY) {
      const rate = this.conversionRateToBase(resolved, parsed);
      if (rate == null) {
        log.warn(
          `import market volume history: no conversion rate for ${resolved} -> ` +
            `${MARKET_VOLUME_BASE_CURRENCY}; rejected`,
        );
        return { ok: false, reason: "conversion_unavailable" };
      }
      data = rescaleParsedHistory(parsed, rate);
      converted = { from: resolved, rate };
      log.info(
        `import market volume history converted: ${resolved} -> ` +
          `${MARKET_VOLUME_BASE_CURRENCY} rate=${rate.toFixed(4)}`,
      );
    }

    const { merged, addedHashes, addedSamples, addedLivePoints } = mergeParsedHistory(
      this.buildExistingSnapshot(),
      data,
      { maxSamples: MAX_SAMPLES, maxLivePointsPerHash: MAX_LIVE_POINTS_PER_HASH },
    );
    this.samples = merged.samples;
    this.priceHistory = merged.priceHistory;
    this.liveHistory = merged.liveHistory ?? {};
    this.historyFetchedAtMs = merged.historyFetchedAtMs ?? 0;
    this.lastRefreshAt = merged.lastRefreshAt ?? {};
    // 派生字段（historyHourly / itemCount / itemCountsByCategory）由合并后的 priceHistory
    // 重算；无可聚合数据时保留融合值，避免把已有的好走势清空。
    this.recomputeHistoryTrend();
    if (this.historyHourly.length === 0 && merged.historyHourly.length > 0) {
      this.historyHourly = merged.historyHourly;
      this.historyItemCount = merged.itemCount;
      this.historyItemCountsByCategory = merged.itemCountsByCategory;
    }
    this.saveHistory();
    log.info(
      `import market volume history merged: hashes=+${addedHashes}, samples=+${addedSamples}, ` +
        `livePoints=+${addedLivePoints}, itemCount=${this.historyItemCount}`,
    );
    return {
      ok: true,
      itemCount: this.historyItemCount,
      mergedHashes: addedHashes,
      mergedSamples: addedSamples,
      mergedLivePoints: addedLivePoints,
      ...(converted ? { converted } : {}),
    };
  }

  /**
   * 解析导入来源的计价货币。`"auto"`（或缺省）走三级解析 —— 顶层 `currency` →
   * `samples[].currency` 推断 → 价格历史自动探测；显式 ISO 直接采用（大小写不敏感）。
   * 三级都拿不到时返回 null。
   */
  private resolveImportCurrency(
    parsed: ParsedMarketVolumeHistory,
    requested: string,
  ): string | null {
    const asked = (requested ?? "").trim();
    if (asked !== "" && asked.toUpperCase() !== "AUTO") return asked.toUpperCase();
    const resolved = this.resolveFileCurrency(parsed);
    if (resolved.currency) return resolved.currency;
    return this.detectBackupCurrency(parsed).currency;
  }

  /**
   * 「来源币 → USD」换算比例。优先 fx 表（`1 / fx[来源]`）；缺该币种时回退
   * {@link computeConversionRate}（用现有 USD 价格历史与备份共同 hash / 时间最接近的
   * 一对点求价格比推算）；仍拿不到返回 null。
   */
  private conversionRateToBase(from: string, parsed: ParsedMarketVolumeHistory): number | null {
    const units = this.unitsPerUsd(from);
    if (units != null) return 1 / units;
    return computeConversionRate({
      from,
      to: MARKET_VOLUME_BASE_CURRENCY,
      fx: this.deps.getFxRates?.(),
      backupPriceHistory: new Map(Object.entries(parsed.priceHistory)),
      currentPriceHistory: new Map(Object.entries(this.priceHistory)),
    });
  }

  /**
   * 显示货币变更钩子 —— 现在**不再清账**。
   *
   * 金额已统一以 {@link MARKET_VOLUME_BASE_CURRENCY} 入库，与显示货币无关：`samples` /
   * `priceHistory` / `liveHistory` / 实时 `live` 在任意显示货币下都继续有效，展示层按
   * 新的 fx 重新换算即可。调用方（appState / configPatch）只需在调用后重新广播
   * `MARKET_VOLUME` / `MARKET_VOLUME_ITEMS`。保留本方法作为切币语义的锚点与日志位。
   */
  onCurrencyChanged(): void {
    log.info(
      `onCurrencyChanged: no-op (base currency is ${MARKET_VOLUME_BASE_CURRENCY}, ` +
        `display is ${this.deps.getCurrency()})`,
    );
  }

  /** 记录一次轮询采样（hash 维度），并累积该 hash 的活跃度采样历史。 */
  recordVolume(hash: string, volume: number, median: number | null, currency: string): void {
    if (!hash) return;
    if (!Number.isFinite(volume) || volume < 0) return;
    // 竞态护栏（与基准货币无关）：cycle 在切换显示货币前开始、切换后结束时，采样货币
    // 会与当前显示货币不符；这种旧币采样直接丢弃，等下一轮重新抓取。
    if (currency.toUpperCase() !== this.deps.getCurrency().toUpperCase()) {
      log.debug(`recordVolume: drop stale-currency sample for ${hash} (${currency})`);
      return;
    }
    // 采样 median 以显示货币计价；入库统一换算为基准货币（USD）。
    const unitsPerUsd = this.unitsPerUsd(currency);
    if (median != null && unitsPerUsd == null) {
      log.debug(`recordVolume: drop sample for ${hash} (no fx rate for ${currency})`);
      return;
    }
    const medianUsd = median == null || unitsPerUsd == null ? null : median / unitsPerUsd;
    this.live.set(hash, { volume, median: medianUsd });
    // 累积 per-hash 活跃度采样点：同一轮询周期（< MIN_SAMPLE_INTERVAL_MS）内去重，
    // 只更新该点数值而非新增，避免重复。裁剪到 MAX_LIVE_POINTS_PER_HASH。
    const now = Date.now();
    const arr = this.liveHistory[hash] ?? (this.liveHistory[hash] = []);
    const last = arr[arr.length - 1];
    if (last && now - last.ts < MIN_SAMPLE_INTERVAL_MS) {
      last.volume = volume;
      last.median = medianUsd;
    } else {
      arr.push({ ts: now, volume, median: medianUsd });
      if (arr.length > MAX_LIVE_POINTS_PER_HASH) {
        this.liveHistory[hash] = arr.slice(-MAX_LIVE_POINTS_PER_HASH);
      }
    }
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

  /** 用当前轮询实时映射构造一次采样（不落盘；金额已由 `recordVolume` 换算为 USD）。 */
  private buildSample(nowMs: number): MarketVolumeSample {
    const itemsByHash = this.buildItemsByHash();
    return aggregateVolume(
      itemsByHash,
      this.live,
      MARKET_VOLUME_BASE_CURRENCY,
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
   * 清理实时映射与活跃度采样历史，仅保留 `keepHashes` 内的 hash。
   *
   * `live` / `liveHistory` 由轮询（watched）驱动、从不主动清理：用户取消星标
   * 后，这些 hash 不再被轮询，但旧数据仍残留，会持续被计入采样总交易额与
   * 兜底卡片，导致数值被高估。轮询 cycle 成功结束时调用本方法，把两者裁剪到
   * 本轮轮询目标集，确保只统计当前仍被关注的物品。有裁剪变化时立即落盘，避免
   * 重启后从磁盘读回已清理的旧条目。
   */
  pruneLive(keepHashes: ReadonlySet<string>): void {
    let changed = false;
    for (const hash of [...this.live.keys()]) {
      if (!keepHashes.has(hash)) {
        this.live.delete(hash);
        changed = true;
      }
    }
    for (const hash of Object.keys(this.liveHistory)) {
      if (!keepHashes.has(hash)) {
        delete this.liveHistory[hash];
        changed = true;
      }
    }
    if (changed) this.saveHistory();
  }

  /**
   * 请求终止当前进行中的整次历史刷新。置位后刷新循环在下一个安全退出点（每个
   * 物品处理完、批间等待被唤醒时）尽快退出并正常收尾（广播 running=false）。
   * 未在刷新时调用会被下一次刷新开始时重置，无副作用。
   */
  abortHistoryRefresh(): void {
    this.historyAbortRequested = true;
  }

  /**
   * 可中断的等待：每隔固定小步长唤醒检查是否被请求终止，以毫秒粒度尽快对「停止」
   * 做出响应（批间等待最长可达数分钟，若用一个长 setTimeout 无法即时中止）。
   * @returns 等待期间是否收到了终止请求。
   */
  private async waitOrAbort(ms: number): Promise<boolean> {
    const STEP = 250;
    let waited = 0;
    while (waited < ms) {
      if (this.historyAbortRequested) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(STEP, ms - waited)));
      waited += STEP;
    }
    return this.historyAbortRequested;
  }

  /**
   * 把 pricehistory 本次拉到的点换算到**基准货币（USD）**（若返回货币不是 USD）。
   *
   * Steam `pricehistory` 忽略 `currency` 参数，返回区域锁定货币（价格列单位靠
   * `price_prefix` 判定）。本方法用该物品 priceoverview 的成交中位价（**USD**）作锚，
   * 把整条序列等比校正到 USD。货币解析不出来 / 已是 USD / 锚不可用时都保守地不换算
   * （保留原值）。
   */
  private async calibrateHistoryToBase(
    hash: string,
    points: PriceHistoryPoint[],
    resCurrency: string | null | undefined,
  ): Promise<PriceHistoryPoint[]> {
    if (!resCurrency) return points;
    if (resCurrency.toUpperCase() === MARKET_VOLUME_BASE_CURRENCY) return points;

    // 取最近一个有成交量的点，作为与锚中位价对应的原货币价格。
    let sourcePrice: number | null = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].volume > 0) {
        sourcePrice = points[i].price;
        break;
      }
    }
    if (sourcePrice == null || sourcePrice <= 0) return points;

    let median: number | null = null;
    try {
      const fetchMedian = this.deps.fetchAnchorMedian ?? defaultFetchAnchorMedian;
      median = await fetchMedian(hash, MARKET_VOLUME_BASE_CURRENCY);
    } catch (err) {
      log.warn(`calibrate history ${hash}: median fetch failed: ${(err as Error).message}`);
    }

    const cal = calibratePricesWithMedian(points, median, sourcePrice);
    if (cal.applied && median != null) {
      log.info(
        `calibrate history ${hash}: ${resCurrency} -> ${MARKET_VOLUME_BASE_CURRENCY} ` +
          `scale=${(median / sourcePrice).toFixed(4)}`,
      );
    }
    return cal.points;
  }

  /**
   * 手动更新单个物品的历史价格（交易页卡片上的刷新按钮）。
   *
   * 只拉取该 hash 的 pricehistory，成功后实时并入 `priceHistory` 并重算顶部走势、
   * 落盘；返回该物品的最新卡片（供前端实时更新）与是否触发 Cookie 失效。不参与
   * 整批刷新的 running/pending 进度流，避免误触顶部「刷新中」状态。
   */
  async refreshItem(
    hash: string,
    now = Date.now(),
  ): Promise<{ updated?: MarketVolumeItem; cookieExpired: boolean }> {
    const currency = this.deps.getCurrency();
    const cookie = this.deps.getCookie();
    const fetchOne = this.deps.fetchHistory ?? fetchSteamPriceHistory;
    const r = await fetchOne(hash, currency, cookie);
    if (r.ok && r.points && r.points.length > 0) {
      const calibrated = await this.calibrateHistoryToBase(hash, r.points, r.currency);
      this.priceHistory[hash] = mergePriceHistoryPoints(this.priceHistory[hash] ?? [], calibrated);
      this.recomputeHistoryTrend();
      this.historyFetchedAtMs = now;
      this.saveHistory();
      log.info(`refreshItem: ${hash} ok (${r.points.length} points)`);
      return { updated: this.buildItemForHash(hash), cookieExpired: false };
    }
    const view = r as { status?: number; reason?: string };
    if (view.status === 400 || view.reason === "unauthorized") {
      log.warn(`refreshItem: ${hash} cookie expired (status=400)`);
      return { cookieExpired: true };
    }
    log.warn(
      `refreshItem: ${hash} no data (status=${view.status ?? 0}, reason=${view.reason ?? "no_data"})`,
    );
    return { cookieExpired: false };
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
    const rawTargets = opts?.targets ?? this.deps.getTargetHashes();
    let targets = rawTargets;
    // 自动路径（未显式传 targets）做「会话优化」：按最近 24h 交易额降序 + 覆盖率为
    // 主区优先 + 每日全量兜底（见 planSessionTargets），用尽可能少的刷新覆盖最多的
    // 交易额，同时保证每天把目标全集都刷一遍。手动（force）路径尊重调用方给定顺序
    // （cardOrder / sortTargetsByVolume 已按时间窗成交额排好）。
    if (!opts?.targets) {
      targets = this.planSessionTargets(
        targets,
        now,
        this.deps.getCoverageThreshold?.() ?? COVERAGE_DEFAULT,
      );
    }
    if (!opts?.force && now - this.historyFetchedAtMs < HISTORY_REFRESH_MS) return false;
    if (this.refreshing) return false;
    this.refreshing = true;
    // 新一轮刷新开始：清掉可能残留的「终止」请求，保证本次可正常执行。
    this.historyAbortRequested = false;
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
      // 按每批 getHistoryBatchSize() 个分组串行拉取；批内间隔 HISTORY_FETCH_DELAY_MS，
      // 每拉完一批等待 getHistoryBatchDelaySec()（默认 120 秒 = 2 分钟）再拉下一批，规避 Steam 限流。
      const batchSize = Math.max(1, Math.round(this.deps.getHistoryBatchSize()));
      const batchDelayMs = Math.max(0, Math.round(this.deps.getHistoryBatchDelaySec())) * 1000;
      let done = 0;
      let consecutive429 = 0;
      // 构建本次待刷新目标的占位卡片，并在刷新开始时推送一次，让前端（交易页）
      // 在自动/手动刷新时都能显示亮环提示（与 refreshMarketVolumeItems 的 pending 一致）。
      const pending = this.buildPendingItems(targets);
      this.deps.onHistoryProgress?.({
        running: true,
        total: targets.length,
        done: 0,
        current: null,
        pending,
      });
      // 每次刷新是否检测到 Cookie 失效（pricehistory 返回 400）：一旦命中说明
      // 登录态整体失效，继续拉取只会白白触发限流，立即终止本次价格刷新。
      let cookieExpired = false;
      outer: for (let i = 0; i < targets.length && !this.historyAbortRequested; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);
        for (const hash of batch) {
          if (this.historyAbortRequested) break;
          this.deps.onHistoryProgress?.({
            running: true,
            total: targets.length,
            done,
            current: hash,
          });
          let updatedItem: MarketVolumeItem | undefined;
          // 记下该 hash 本次发起刷新（成功与否都记，避免同日内的每日全量兜底反复重试）。
          this.lastRefreshAt[hash] = now;
          try {
            const r = await fetchOne(hash, currency, cookie);
            if (r.ok && r.points && r.points.length > 0) {
              const calibrated = await this.calibrateHistoryToBase(hash, r.points, r.currency);
              historyByHash.set(hash, calibrated);
              // 实时更新内存态：与旧数据合并（保留更细粒度），该 hash 立即反映
              // 最新价格，供前端实时刷新卡片（持久化在全部拉完之后统一做）。
              this.priceHistory[hash] = mergePriceHistoryPoints(
                this.priceHistory[hash] ?? [],
                calibrated,
              );
              updatedItem = this.buildItemForHash(hash);
              // 该物品实时并入 priceHistory 后立即重算顶部交易额走势，让最上方的
              // 时间范围随每个成功返回的物品同步更新（而非等整批刷新结束）。
              this.recomputeHistoryTrend();
              consecutive429 = 0;
              log.info(`refreshHistory: ${hash} ok (${r.points.length} points)`);
            } else {
              // 诊断：拉取「完成」但无数据时要能看出原因（400 无 Cookie / 429 限流 / 网络错误 / 该物品无成交）。
              // 用宽松查看避免判别联合窄化问题（PriceHistoryResultLike.ok 为 boolean）。
              const view = r as { status?: number; reason?: string; retryAfterMs?: number };
              // 400 = 未登录 / Steam Cookie 失效：登录态整体失效，终止整次刷新。
              if (view.status === 400 || view.reason === "unauthorized") {
                cookieExpired = true;
                log.warn(`refreshHistory: ${hash} cookie expired (status=400), aborting refresh`);
                this.deps.onHistoryProgress?.({
                  running: true,
                  total: targets.length,
                  done,
                  current: null,
                  cookieExpired: true,
                });
                break outer;
              } else if (view.status === 429) {
                // Rate-limited: respect Steam's retryAfterMs and stop hammering.
                // Three in a row means the quota is gone for this window — abort
                // the batch (keep whatever was already fetched) instead of
                // burning the remaining items at 1.5s intervals.
                consecutive429++;
                const backoffMs =
                  typeof view.retryAfterMs === "number" && view.retryAfterMs > 0
                    ? view.retryAfterMs
                    : HISTORY_FETCH_DELAY_MS;
                log.warn(
                  `refreshHistory: ${hash} rate-limited (429) consecutive=${consecutive429}/${MAX_CONSECUTIVE_429}, ` +
                    `waiting ${backoffMs}ms`,
                );
                if (consecutive429 >= MAX_CONSECUTIVE_429) {
                  log.warn(
                    `refreshHistory: aborting batch after ${consecutive429} consecutive 429s`,
                  );
                  break outer;
                }
                if (await this.waitOrAbort(backoffMs)) break outer;
              } else {
                consecutive429 = 0;
                const reason = view.reason ?? (r.ok ? "no_data" : "failed");
                const retry = view.retryAfterMs ? `, retryAfter=${view.retryAfterMs}ms` : "";
                log.warn(
                  `refreshHistory: ${hash} no data (status=${view.status ?? 0}, reason=${reason}${retry})`,
                );
              }
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
            ...(updatedItem ? { trendChanged: true } : {}),
          });
          // 批内物品间隔（可被手动终止中断）
          if (await this.waitOrAbort(HISTORY_FETCH_DELAY_MS)) break outer;
        }
        if (i + batchSize < targets.length) {
          // 批间等待（默认 120 秒，可被手动终止中断）
          if (await this.waitOrAbort(batchDelayMs)) break;
        }
      }
      // 本次拉取的新数据聚合：决定返回值「本次是否刷新到了有效数据」。
      const fetchedAgg = aggregateHistoryToHourly(historyByHash, this.buildItemsByHash());
      // 用合并后的完整 priceHistory 重新聚合小时走势，保证包含所有已拉取过的
      // hash（而非仅本次 targets），且粒度合并后为最细粒度。
      const allAgg = aggregateHistoryToHourly(
        new Map(Object.entries(this.priceHistory)),
        this.buildItemsByHash(),
      );
      // 诊断：刷新结束，汇总成功拉到的物品数与小时桶数，便于判断是否整体无数据。
      log.info(
        `refreshHistory end: fetched=${historyByHash.size}/${targets.length}, hourlyBuckets=${allAgg.points.length}`,
      );
      // 一次刷新拿到该物品全部历史（仅粒度随新旧变化），故保留全部小时桶，不截断，
      // 供全量走势展示；priceHistory 已在循环内逐 hash 合并（保留更细粒度 + 非目标
      // hash 保留），此处不再全量覆盖，避免失败把已有好数据清空。
      if (allAgg.points.length > 0) {
        this.historyHourly = allAgg.points;
        this.historyItemCount = allAgg.itemCount;
        this.historyItemCountsByCategory = allAgg.itemCountsByCategory;
      }
      // 无论成败都记录拉取时机，命中 30min 缓存去抖，避免每次轮询/打开页面都
      // 高频重试触发 Steam 限流。返回是否确实刷新到了新数据（决定是否广播）。
      this.historyFetchedAtMs = now;
      this.saveHistory();
      // 刷新完成：通知 renderer 结束运行态（清空进度提示）。
      this.deps.onHistoryProgress?.({
        running: false,
        total: targets.length,
        done,
        current: null,
        ...(cookieExpired ? { cookieExpired: true } : {}),
      });
      return fetchedAgg.points.length > 0;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 依据当前内存态 priceHistory 重算顶部交易额走势（historyHourly / itemCount /
   * itemCountsByCategory）。刷新过程中每个成功返回的物品并入 priceHistory 后调用，
   * 让最上方的走势时间范围随单品更新实时刷新；忽略无数据的结果（失败不清空已有好数据）。
   */
  private recomputeHistoryTrend(): void {
    const agg = aggregateHistoryToHourly(
      new Map(Object.entries(this.priceHistory)),
      this.buildItemsByHash(),
    );
    if (agg.points.length > 0) {
      this.historyHourly = agg.points;
      this.historyItemCount = agg.itemCount;
      this.historyItemCountsByCategory = agg.itemCountsByCategory;
    }
  }

  /** 返回当前统计（最新轮询快照 + 按小时走势）。金额换算到**显示货币**后返回。 */
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
    log.debug(
      `[volume-stats] getStats called hourly=${hourly.length} (${hourly[0]?.hour}..${hourly[hourly.length - 1]?.hour})`,
    );
    // 内存与磁盘金额均为基准货币（USD），出库时换算到显示货币。
    const { rate, currency } = this.displayRate();
    return rescaleVolumeStats(
      { latest, hourly, itemCount, itemCountsByCategory, currency: MARKET_VOLUME_BASE_CURRENCY },
      rate,
      currency,
    );
  }

  /** 返回原始 pricehistory 点（hash -> 全部历史点，保留混合粒度），供按需再聚合/展示。 */
  getPriceHistory(): Readonly<Record<string, readonly PriceHistoryPoint[]>> {
    return this.priceHistory;
  }

  /**
   * 构造单个 hash 的最新「物品维度」卡片（刷新过程中实时推送用）。
   *
   * 复用该 hash 已存在（含刚实时写入）的 pricehistory 聚合出带走势的卡片；
   * 无有效交易额数据时回退为空白卡片（仅展示名与分类）。金额换算到**显示货币**。
   */
  private buildItemForHash(hash: string): MarketVolumeItem {
    // 复用同一个 catalog 映射，避免 refreshHistory 逐 hash 调用时反复重建整个 Map。
    const itemsByHash = this.buildItemsByHash();
    const item = itemsByHash.get(hash);
    const pts = this.priceHistory[hash] ?? [];
    const agg = aggregateItemVolume(new Map([[hash, pts]]), itemsByHash);
    const base: MarketVolumeItem = agg[0] ?? {
      hash,
      name: item?.name ?? hash,
      category: item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER,
      grade: item?.grade,
      itemKey: item?.id,
      gearGroup: item?.gearGroup,
      level: item?.level ?? null,
      gearType: item?.gearType ?? null,
      materialType: item?.materialType ?? null,
      total: 0,
      points: [],
    };
    const { rate } = this.displayRate();
    return rescaleMarketVolumeItems([base], rate)[0]!;
  }

  /**
   * 构造「待刷新」目标物品的占位卡片（交易页刷新进行中提前展示）。
   *
   * 输入为待刷新的 market_hash_name 列表（如 `selectHistoryRefreshTargets`
   * 的结果）。若该 hash 已有交易额数据（合并口径：pricehistory 聚合 + 活跃度
   * 采样历史 + live 快照），则**复用该数据生成带走势/金额的卡片**，与主列表
   * 口径一致，刷新过程中不因尚未拉到最新数据而丢失图表或金额；否则生成为
   * `total=0`、`points=[]` 的空白占位（首次刷新 / 尚无任何数据），仅展示名与
   * 分类。按输入顺序返回（目标集已按星标优先/价格降序排好）。
   */
  buildPendingItems(targets: readonly string[]): MarketVolumeItem[] {
    const itemsByHash = this.buildItemsByHash();
    // 复用合并口径（pricehistory + 活跃度采样 + live 快照）的卡片，避免待刷新
    // 物品在刷新期间显示为空白占位，与主列表卡片重复时口径不一致。
    const existingByHash = new Map(this.getVolumeItems().items.map((i) => [i.hash, i]));
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
          itemKey: item?.id,
          gearGroup: item?.gearGroup,
          level: item?.level ?? null,
          gearType: item?.gearType ?? null,
          materialType: item?.materialType ?? null,
          total: 0,
          points: [],
        },
      );
    }
    return out;
  }

  /**
   * 按最近 24h 交易额对待刷新目标从高到低排序（交易页二次及以后刷新用）。
   *
   * 排序口径为「最近 24h 时间窗成交额」而非全量历史累计——贴合「每天交易额」，
   * 反映当前/当天的交易活跃度。星标（watched）无条件最前，有交易额者降序、仅价格
   * 者按价格降序、无数据者保持原相对顺序（见 {@link orderRefreshTargets}）。这样
   * 「先刷新交易额高的物品」，用最少的刷新覆盖最多的交易额。
   */
  sortTargetsByVolume(targets: readonly string[]): string[] {
    const prefix = new Set(this.deps.getWatchedHashes?.() ?? []);
    const volumes = this.recentVolumeByHash(targets, Date.now());
    // 阈值传 1：返回完整排序（排好序的全集），覆盖率截断交给计划/自动路径处理。
    return orderRefreshTargets(targets, volumes, prefix, 1).ordered;
  }

  /**
   * 计算每个目标 hash 的「最近 24h 成交额」与兜底价格（用于刷新排序）。
   *
   * 口径优先取 pricehistory 最近窗口内的真实成交额；无则用活跃度采样历史的最新
   * 采样（volume×median，24h 滚动）；再退到 live 快照；都没有时用图鉴快照价格兜底。
   */
  private recentVolumeByHash(
    hashes: readonly string[],
    nowMs: number,
  ): Map<string, RefreshTargetVolume> {
    const nowSec = nowMs / 1000;
    const map = new Map<string, RefreshTargetVolume>();
    for (const h of hashes) {
      if (!h) continue;
      const history = recentVolumeTotal(this.priceHistory[h] ?? [], nowSec, RECENT_WINDOW_SEC);
      if (history > 0) {
        map.set(h, { windowTotal: history, fallbackPrice: 0 });
        continue;
      }
      let liveTotal = 0;
      const lh = this.liveHistory[h];
      if (lh && lh.length > 0) {
        for (let i = lh.length - 1; i >= 0; i--) {
          const p = lh[i];
          if (
            Number.isFinite(p.volume) &&
            p.volume > 0 &&
            p.median != null &&
            Number.isFinite(p.median) &&
            p.median > 0
          ) {
            liveTotal = p.volume * p.median;
            break;
          }
        }
      }
      if (liveTotal > 0) {
        map.set(h, { windowTotal: liveTotal, fallbackPrice: 0 });
        continue;
      }
      const lv = this.live.get(h);
      if (lv && lv.volume > 0 && lv.median != null && lv.median > 0) {
        map.set(h, { windowTotal: lv.volume * lv.median, fallbackPrice: 0 });
        continue;
      }
      const fb = this.deps.getSnapshotPriceUsd?.(h) ?? 0;
      map.set(h, { windowTotal: 0, fallbackPrice: fb > 0 ? fb : 0 });
    }
    return map;
  }

  /**
   * 规划自动路径本次要拉取的目标集：会话内排序 + 覆盖率主区优先 + 每日全量兜底。
   *
   * 1. 按最近 24h 交易额对目标排序（星标最前 → …），并算出覆盖率主区数量 `primary`；
   * 2. 每次自动刷新**必拉主区**（用最少的刷新覆盖最多的交易额）；
   * 3. 主区外的长尾物品，若当日尚未刷新过（`lastRefreshAt` 不在今天）则一并补拉——
   *    这保证在一天的时间预算内把目标全集都刷一遍（「每天全量一遍」），同时不事事
   *    都刷长尾导致浪费预算。
   */
  private planSessionTargets(
    rawTargets: readonly string[],
    nowMs: number,
    coverageThreshold: number,
  ): string[] {
    const prefix = new Set(this.deps.getWatchedHashes?.() ?? []);
    const volumes = this.recentVolumeByHash(rawTargets, nowMs);
    const { ordered, primary } = orderRefreshTargets(
      rawTargets,
      volumes,
      prefix,
      coverageThreshold,
    );
    const dayNow = Math.floor(nowMs / DAY_MS);
    const out: string[] = [];
    const seen = new Set<string>();
    ordered.forEach((h, i) => {
      if (seen.has(h)) return;
      seen.add(h);
      const lastDay = Math.floor((this.lastRefreshAt[h] ?? 0) / DAY_MS);
      if (i < primary || lastDay < dayNow) out.push(h);
    });
    return out;
  }

  /**
   * 返回「物品维度」的交易额卡片数据（交易页），按总交易额降序。金额换算到**显示货币**。
   *
   * 合并三路数据：
   *  - pricehistory 按小时聚合（含小时走势 points），为主；
   *  - 轮询活跃度采样历史（per-hash 采样点，`kind="live"`，含采样走势 points，
   *    取窗口内最新值）补充 pricehistory 尚未覆盖到的物品；
   *  - 轮询 live 快照（体积更小，无走势）兜底活动历史尚未累积的 hash。
   * 同一 hash 以 pricehistory 优先，其次活跃度采样历史。
   */
  getVolumeItems(): MarketVolumeItemStats {
    const itemsByHash = this.buildItemsByHash();
    const historyByHash = new Map(Object.entries(this.priceHistory));
    const historyItems = aggregateItemVolume(historyByHash, itemsByHash);
    const skip = new Set(historyItems.map((item) => item.hash));
    const liveActivityItems = aggregateLiveActivityItems(
      itemsByHash,
      new Map(Object.entries(this.liveHistory)),
    ).filter((item) => !skip.has(item.hash));
    const activityHashes = new Set(liveActivityItems.map((item) => item.hash));
    const liveFallback = aggregateLiveItems(itemsByHash, this.live).filter(
      (item) => !skip.has(item.hash) && !activityHashes.has(item.hash),
    );
    const merged = [...historyItems, ...liveActivityItems, ...liveFallback];
    merged.sort((a, b) => b.total - a.total);
    // 聚合出的金额是基准货币（USD），出库换算到显示货币。
    const { rate, currency } = this.displayRate();
    return { items: rescaleMarketVolumeItems(merged, rate), currency };
  }
}

/**
 * 判断一个已解析快照里是否存在任何金额类数据。用于「文件币种不可知时」的判定：
 * 无金额可丢才接受，否则保守丢弃。
 */
function hasVolumeAmounts(p: ParsedMarketVolumeHistory): boolean {
  return (
    p.samples.length > 0 ||
    p.historyHourly.length > 0 ||
    Object.keys(p.priceHistory).length > 0 ||
    Object.keys(p.liveHistory ?? {}).length > 0
  );
}

/**
 * 判断一个采样是否「有内容」（至少 1 个物品计入交易额），供 UI 判断
 * 是否显示空态。
 */
export function hasVolumeData(sample: MarketVolumeSample | null): boolean {
  return !!sample && sample.items > 0 && sample.total > 0;
}
