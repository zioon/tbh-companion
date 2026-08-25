// 市场交易额纯函数：把「hash 维度」的成交量×成交价聚合为「类别 + 时间」维度，
// 供 Market 页展示总交易额、各类别交易额与按小时走势。无 Electron/IO 依赖，可单测。

import type { LookupItem, MarketVolumeHourPoint, MarketVolumeSample } from "../../shared/types";

/** Steam pricehistory 返回的单个历史点。 */
export interface PriceHistoryPoint {
  /** 点时间戳（epoch 秒，UTC）。 */
  timestamp: number;
  /** 该点成交价（目标货币）。 */
  price: number;
  /** 该点成交量（件数）。 */
  volume: number;
}

/** 按小时聚合后的历史成交额点（含分类明细）。 */
export interface HourlyHistoryBucket {
  /** 小时桶起始时间（ISO UTC，整点）。 */
  hour: string;
  /** 该小时总成交额（目标货币）。 */
  total: number;
  /** 该小时各类别成交额：类别 key -> 金额。 */
  byCategory: Record<string, number>;
}

/** 单个 hash 的成交量采样。 */
export interface VolumeHashSample {
  /** 24h 成交量（单位数）。 */
  volume: number;
  /** 成交价中位数（目标货币）。小于等于 0 视为无效，不计入交易额。 */
  median: number | null;
}

/** 单个 hash 的一次「活跃度采样」历史点（来自轮询 live 快照，非 pricehistory）。 */
export interface LiveVolumePoint {
  /** 采样时间（epoch ms，UTC）。 */
  ts: number;
  /** 24h 成交量（滚动累计，非该时刻增量）。 */
  volume: number;
  /** 成交价中位数（目标货币）。 */
  median: number | null;
}

/** 交易额展示的 5 大分类 key。 */
export const VOLUME_CATEGORY_WEAPON = "WEAPON";
export const VOLUME_CATEGORY_ARMOR = "ARMOR";
export const VOLUME_CATEGORY_ACCESSORY = "ACCESSORY";
export const VOLUME_CATEGORY_MATERIAL = "MATERIAL";
export const VOLUME_CATEGORY_COIN = "COIN";
export const VOLUME_CATEGORY_OTHER = "OTHER";

/**
 * 把一个图鉴物品归到交易额展示的 5 大分类：
 * - 武器 = 装备 gearGroup=WEAPON；
 * - 防具 = 装备 gearGroup=ARMOR；
 * - 饰品 = 装备 gearGroup=ACCESSORY；
 * - 硬币 = 材料 materialType=OFFERING（纪念币）；
 * - 材料 = 其余材料（CRAFTING/DECORATION/ENGRAVING/INSCRIPTION/SOULSTONE）。
 * 无法归类的物品（如 STAGEBOX）回退到 {@link VOLUME_CATEGORY_OTHER}。
 */
export function volumeCategoryKey(
  item: Pick<LookupItem, "type" | "gearGroup" | "materialType">,
): string {
  if (item.type === "GEAR") {
    if (item.gearGroup === VOLUME_CATEGORY_WEAPON) return VOLUME_CATEGORY_WEAPON;
    if (item.gearGroup === VOLUME_CATEGORY_ACCESSORY) return VOLUME_CATEGORY_ACCESSORY;
    return VOLUME_CATEGORY_ARMOR;
  }
  if (item.type === "MATERIAL") {
    return item.materialType === "OFFERING" ? VOLUME_CATEGORY_COIN : VOLUME_CATEGORY_MATERIAL;
  }
  return VOLUME_CATEGORY_OTHER;
}

/** 历史遗留/别名分类 key 归一化（如旧版用 OFFERING 表示硬币，现统一为 COIN）。 */
const CATEGORY_ALIASES: Record<string, string> = { OFFERING: VOLUME_CATEGORY_COIN };

/** 把分类 key 归一化到走势图使用的 5 大分类 key，未知 key 原样返回。 */
export function normalizeCategoryKey(key: string): string {
  return CATEGORY_ALIASES[key] ?? key;
}

/**
 * 把轮询采样快照（24h 滚动成交额）聚合成走势点。
 *
 * 每个 {@link MarketVolumeSample} 自带时间戳与分类明细，是 pricehistory 拉取
 * 失败时的回退走势数据源。按小时桶聚合（同小时多点取平均，与
 * {@link aggregateHourly} 一致），分类 key 经 {@link normalizeCategoryKey} 归一化
 * （兼容旧版 OFFERING → COIN）。返回升序（旧→新）。
 */
export function aggregateSamplesToTrend(samples: MarketVolumeSample[]): MarketVolumeHourPoint[] {
  const buckets = new Map<
    string,
    { total: number; count: number; byCategory: Record<string, number> }
  >();
  for (const s of samples) {
    const ms = Date.parse(s.timestamp);
    if (!Number.isFinite(ms)) continue;
    const hour = new Date(Math.floor(ms / 3600_000) * 3600_000).toISOString();
    let b = buckets.get(hour);
    if (!b) {
      b = { total: 0, count: 0, byCategory: {} };
      buckets.set(hour, b);
    }
    b.total += s.total;
    b.count++;
    for (const [k, v] of Object.entries(s.byCategory ?? {})) {
      const nk = normalizeCategoryKey(k);
      b.byCategory[nk] = (b.byCategory[nk] ?? 0) + v;
    }
  }

  const points: MarketVolumeHourPoint[] = [];
  for (const [hour, b] of buckets) {
    const byCategory: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.byCategory)) byCategory[k] = v / b.count;
    points.push({ hour, total: b.total / b.count, byCategory });
  }
  points.sort((a, b) => (a.hour < b.hour ? -1 : 1));
  return points;
}

/**
 * 把 hash 维度的成交量/成交价聚合为一次 {@link MarketVolumeSample}。
 *
 * 只统计「有成交量且成交价有效」的物品。成交额 = Σ(volume × median)。
 *
 * @param volumeByHash  物品索引需要 hash 维度数据：传入一个 `hash -> item` 映射
 *                      以把 hash 归到类别；未匹配到图鉴物品的 hash 归到 OTHER。
 */
export function aggregateVolume(
  itemsByHash: Map<string, Pick<LookupItem, "type" | "gearGroup" | "materialType">>,
  volumeByHash: Map<string, VolumeHashSample>,
  currency: string,
  timestamp = new Date().toISOString(),
): MarketVolumeSample {
  let total = 0;
  let counted = 0;
  const byCategory: Record<string, number> = {};

  for (const [hash, sample] of volumeByHash) {
    if (!Number.isFinite(sample.volume) || sample.volume <= 0) continue;
    if (sample.median == null || !Number.isFinite(sample.median) || sample.median <= 0) continue;
    const amount = sample.volume * sample.median;
    total += amount;
    counted++;
    const item = itemsByHash.get(hash);
    const key = item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER;
    byCategory[key] = (byCategory[key] ?? 0) + amount;
  }

  return { timestamp, items: counted, total, byCategory, currency };
}

/**
 * 把一列带时间戳的采样按「小时桶」聚合成走势点。
 * 同一小时内的多个采样取平均 total；返回升序（旧→新），最新在最后。
 *
 * @param maxHours 最多保留多少个最近的小时桶（默认 24）。
 */
export function aggregateHourly(
  samples: Pick<MarketVolumeSample, "timestamp" | "total">[],
  maxHours = 24,
): MarketVolumeHourPoint[] {
  if (samples.length === 0) return [];

  // hash -> hour 桶（ISO 整点）-> { sum, count }
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const s of samples) {
    const ms = Date.parse(s.timestamp);
    if (!Number.isFinite(ms)) continue;
    const hour = new Date(Math.floor(ms / 3600_000) * 3600_000).toISOString();
    const b = buckets.get(hour);
    if (b) {
      b.sum += s.total;
      b.count++;
    } else {
      buckets.set(hour, { sum: s.total, count: 1 });
    }
  }

  const points: MarketVolumeHourPoint[] = [];
  for (const [hour, b] of buckets) {
    points.push({ hour, total: b.sum / b.count });
  }
  points.sort((a, b) => (a.hour < b.hour ? -1 : 1));
  return points.slice(-maxHours);
}

/** 单个物品的市场交易额（交易页卡片）。 */
export interface MarketVolumeItem {
  /** market_hash_name。 */
  hash: string;
  /** 展示名（本地化；未匹配到图鉴时用 hash）。 */
  name: string;
  /** 交易额分类 key（与 {@link volumeCategoryKey} 一致）。 */
  category: string;
  /** 物品品质等级（COMMON..COSMIC）。未匹配到图鉴时为 undefined。 */
  grade?: string;
  /** 物品等级（1..LEVEL_MAX）。材料/未匹配到图鉴时为 null。用于等级筛选。 */
  level: number | null;
  /** 装备部位（仅 GEAR 物品有值，如 MAIN_WEAPON/HELMET…）。材料或未匹配时为 null。 */
  gearType: string | null;
  /** 材料种类（仅 MATERIAL 物品有值，如 OFFERING/CRAFTING…）。装备或未匹配时为 null。 */
  materialType: string | null;
  /** 总交易额（目标货币）。 */
  total: number;
  /** 按小时的历史走势（升序，最新在最后），用于卡片小图。 */
  points: { hour: string; price: number; volume: number; total: number }[];
  /**
   * 数据口径：`history`=pricehistory 真实小时增量（可按区间求和）；
   * `live`=轮询活跃度采样（24h 滚动累计，不可求和，取窗口内最新值）。
   * 缺省视为 `history`。
   */
  kind?: "history" | "live";
}

/**
 * 把各 hash 的 pricehistory 原始点聚合成「物品维度」的交易额卡片数据。
 * 每个物品：总交易额 = Σ(volume × price)，小时走势 = 按小时桶累加的成交量与金额、
 * 并以「小时内的成交量加权均价」作为该小时的 price。
 * 只保留总交易额 > 0 的物品，按总交易额降序返回。
 */
export function aggregateItemVolume(
  historyByHash: ReadonlyMap<string, readonly PriceHistoryPoint[]>,
  itemsByHash: Map<
    string,
    Pick<
      LookupItem,
      "type" | "gearGroup" | "materialType" | "name" | "grade" | "level" | "gearType"
    >
  >,
): MarketVolumeItem[] {
  const results: MarketVolumeItem[] = [];
  for (const [hash, points] of historyByHash) {
    // 小时桶：累计成交量、成交额、用于计算成交量加权均价
    const buckets = new Map<string, { volume: number; total: number }>();
    let total = 0;
    for (const p of points) {
      if (!Number.isFinite(p.timestamp) || !Number.isFinite(p.price) || p.price <= 0) continue;
      if (!Number.isFinite(p.volume) || p.volume <= 0) continue;
      const hour = new Date(Math.floor(p.timestamp / 3600) * 3600_000).toISOString();
      const amount = p.volume * p.price;
      const b = buckets.get(hour) ?? { volume: 0, total: 0 };
      b.volume += p.volume;
      b.total += amount;
      buckets.set(hour, b);
      total += amount;
    }
    if (total <= 0) continue;
    const item = itemsByHash.get(hash);
    const series = [...buckets.entries()]
      .map(([hour, b]) => ({
        hour,
        volume: b.volume,
        total: b.total,
        // 成交量加权均价：total / volume；无成交量时回退为 0
        price: b.volume > 0 ? b.total / b.volume : 0,
      }))
      .sort((a, b) => (a.hour < b.hour ? -1 : 1));
    results.push({
      hash,
      name: item?.name ?? hash,
      category: item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER,
      grade: item?.grade,
      level: item?.level ?? null,
      gearType: item?.gearType ?? null,
      materialType: item?.materialType ?? null,
      total,
      points: series,
    });
  }
  results.sort((a, b) => b.total - a.total);
  return results;
}

/**
 * 从轮询 live 映射构建物品卡片（pricehistory 未拉取时的回退）。
 * 无小时走势（points 为空数组），总交易额 = volume × median。
 */
export function aggregateLiveItems(
  itemsByHash: Map<
    string,
    Pick<
      LookupItem,
      "type" | "gearGroup" | "materialType" | "name" | "grade" | "level" | "gearType"
    >
  >,
  volumeByHash: ReadonlyMap<string, VolumeHashSample>,
): MarketVolumeItem[] {
  const results: MarketVolumeItem[] = [];
  for (const [hash, sample] of volumeByHash) {
    if (!Number.isFinite(sample.volume) || sample.volume <= 0) continue;
    if (sample.median == null || !Number.isFinite(sample.median) || sample.median <= 0) continue;
    const item = itemsByHash.get(hash);
    results.push({
      hash,
      name: item?.name ?? hash,
      category: item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER,
      grade: item?.grade,
      level: item?.level ?? null,
      gearType: item?.gearType ?? null,
      materialType: item?.materialType ?? null,
      total: sample.volume * sample.median,
      points: [],
    });
  }
  results.sort((a, b) => b.total - a.total);
  return results;
}

/**
 * 从「每个 hash 的轮询活跃度采样历史」构建物品卡片（pricehistory 未拉取时的回退）。
 *
 * 与 {@link aggregateLiveItems} 的区别：这里能把多轮采样的实时值累积成采样点
 * `points`（供卡片迷你走势图与时间范围切换），但每个点都是 24h 滚动累计量而非
 * 该时刻增量，**不可按区间求和**（会重复计算）。因此：
 * - `total` = 最近一次有效采样的 volume × median（当前活跃度）；
 * - `points` 仅作「活跃度随时间的采样趋势」，前端按 `kind="live"` 取窗口内最新值。
 */
export function aggregateLiveActivityItems(
  itemsByHash: Map<
    string,
    Pick<
      LookupItem,
      "type" | "gearGroup" | "materialType" | "name" | "grade" | "level" | "gearType"
    >
  >,
  livePointsByHash: ReadonlyMap<string, readonly LiveVolumePoint[]>,
): MarketVolumeItem[] {
  const results: MarketVolumeItem[] = [];
  for (const [hash, allPoints] of livePointsByHash) {
    const valid = allPoints.filter(
      (p) =>
        Number.isFinite(p.volume) &&
        p.volume > 0 &&
        p.median != null &&
        Number.isFinite(p.median) &&
        p.median > 0,
    );
    if (valid.length === 0) continue;
    const last = valid[valid.length - 1];
    const total = last.volume * (last.median as number);
    if (total <= 0) continue;
    const item = itemsByHash.get(hash);
    const series = valid.map((p) => ({
      hour: new Date(p.ts).toISOString(),
      price: p.median as number,
      volume: p.volume,
      total: p.volume * (p.median as number),
    }));
    results.push({
      hash,
      name: item?.name ?? hash,
      category: item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER,
      grade: item?.grade,
      level: item?.level ?? null,
      gearType: item?.gearType ?? null,
      materialType: item?.materialType ?? null,
      kind: "live",
      total,
      points: series,
    });
  }
  results.sort((a, b) => b.total - a.total);
  return results;
}

/**
 * 按小时聚合后的历史成交额序列及其覆盖的物品统计。
 */
export interface HistoryAggregation {
  /** 按小时桶的成交额序列（升序，最新在最后）。 */
  points: HourlyHistoryBucket[];
  /** 本次统计覆盖的、有有效交易数据的物品种数。 */
  itemCount: number;
  /** 各分类覆盖的物品种数：类别 key -> 数量。 */
  itemCountsByCategory: Record<string, number>;
}

/**
 * 把多个 hash 的 pricehistory 原始序列聚合成「按小时桶」的真实成交额序列。
 *
 * Steam pricehistory 每个点代表一个时间段（活跃物品约 1 小时）的成交价与
 * 成交量，因此**小时成交额 = Σ(volume × price)**，反映该小时的真实成交额增量
 * （区别于 {@link MarketVolumeSample} 的 24h 滚动值）。同一小时的多个点累加。
 *
 * @param historyByHash hash -> 该物品的 pricehistory 点序列。
 * @returns 升序（旧→新）的小时桶序列；每个点含总成交额与分类明细，并附覆盖物品数。
 */
export function aggregateHistoryToHourly(
  historyByHash: ReadonlyMap<string, readonly PriceHistoryPoint[]>,
  itemsByHash: Map<string, Pick<LookupItem, "type" | "gearGroup" | "materialType">>,
): HistoryAggregation {
  const buckets = new Map<string, { total: number; byCategory: Record<string, number> }>();
  const itemHashesByCategory = new Map<string, Set<string>>();

  for (const [hash, points] of historyByHash) {
    const item = itemsByHash.get(hash);
    const key = item ? volumeCategoryKey(item) : VOLUME_CATEGORY_OTHER;
    let hasValid = false;
    for (const p of points) {
      if (!Number.isFinite(p.timestamp) || !Number.isFinite(p.price) || p.price <= 0) continue;
      if (!Number.isFinite(p.volume) || p.volume <= 0) continue;
      hasValid = true;
      const hour = new Date(Math.floor(p.timestamp / 3600) * 3600_000).toISOString();
      let b = buckets.get(hour);
      if (!b) {
        b = { total: 0, byCategory: {} };
        buckets.set(hour, b);
      }
      const amount = p.volume * p.price;
      b.total += amount;
      b.byCategory[key] = (b.byCategory[key] ?? 0) + amount;
    }
    if (hasValid) {
      let set = itemHashesByCategory.get(key);
      if (!set) {
        set = new Set();
        itemHashesByCategory.set(key, set);
      }
      set.add(hash);
    }
  }

  const points: HourlyHistoryBucket[] = [];
  for (const [hour, b] of buckets) {
    points.push({ hour, total: b.total, byCategory: b.byCategory });
  }
  points.sort((a, b) => (a.hour < b.hour ? -1 : 1));

  const itemCountsByCategory: Record<string, number> = {};
  let itemCount = 0;
  for (const [key, set] of itemHashesByCategory) {
    itemCountsByCategory[key] = set.size;
    itemCount += set.size;
  }

  return { points, itemCount, itemCountsByCategory };
}

/**
 * 合并新旧 pricehistory 点，按「保留更细粒度」优先。
 *
 * Steam pricehistory 的粒度随数据新旧变化：最近为小时粒度、更早为日粒度。随
 * 时间推移，原本的小时粒度数据会被 Steam 降级为日粒度；若直接覆盖会丢失旧的
 * 小时粒度细节。本函数按 UTC 天分组，比较新旧两组在同一「天」内的点数，保留
 * 点数更多（更细）的一组；点数相等时用新数据（更新）。这样旧的小时粒度不会被
 * 新的日粒度覆盖，同时最近的新数据仍以新值覆盖旧值。
 */
export function mergePriceHistoryPoints(
  oldPoints: readonly PriceHistoryPoint[],
  newPoints: readonly PriceHistoryPoint[],
): PriceHistoryPoint[] {
  if (oldPoints.length === 0) return [...newPoints];
  if (newPoints.length === 0) return [...oldPoints];

  const DAY_SECONDS = 86400;
  const byDay = new Map<number, { old: PriceHistoryPoint[]; next: PriceHistoryPoint[] }>();
  const bucket = (day: number) => {
    let e = byDay.get(day);
    if (!e) {
      e = { old: [], next: [] };
      byDay.set(day, e);
    }
    return e;
  };
  for (const p of oldPoints) bucket(Math.floor(p.timestamp / DAY_SECONDS)).old.push(p);
  for (const p of newPoints) bucket(Math.floor(p.timestamp / DAY_SECONDS)).next.push(p);

  const result: PriceHistoryPoint[] = [];
  for (const { old, next } of byDay.values()) {
    // 点数更多的一方视为更细粒度（小时 > 日）；相等时用新数据（更新）。
    result.push(...(old.length > next.length ? old : next));
  }
  result.sort((a, b) => a.timestamp - b.timestamp);
  return result;
}

/**
 * 按 priceoverview 的中位价锚把 pricehistory 的整条价格线等比换算到显示货币。
 *
 * Steam `pricehistory` 忽略 `currency` 参数，价格列返回的是区域锁定货币（如
 * 巴西用户拿到的是 `R$`）。这里用「同物品、同货币权威的 priceoverview 中位价
 * `anchorMedian`（显示货币）÷ 对应时的 pricehistory 价格 `sourcePrice`（原货币）」
 * 得出单一换算系数，把整条序列等比校正到显示货币。
 *
 * @param points       原始 pricehistory 点（price 为价格列原值，货币与显示货币不一致）。
 * @param anchorMedian priceoverview 中位价（显示货币），作为换算锚。
 * @param sourcePrice  pricehistory 序列中与 `anchorMedian` 同一时段的原货币价格
 *                     （一般取序列里最近一个有成交量的点）。
 * @returns `applied` 表示是否实际进行过换算；未换算时返回原副本。
 */
export function calibratePricesWithMedian(
  points: readonly PriceHistoryPoint[],
  anchorMedian: number | null,
  sourcePrice: number | null,
): { applied: boolean; points: PriceHistoryPoint[] } {
  if (
    points.length === 0 ||
    anchorMedian == null ||
    anchorMedian <= 0 ||
    sourcePrice == null ||
    sourcePrice <= 0
  ) {
    return { applied: false, points: [...points] };
  }
  const scale = anchorMedian / sourcePrice;
  if (!Number.isFinite(scale) || scale <= 0) {
    return { applied: false, points: [...points] };
  }
  const applied = Math.abs(scale - 1) > 1e-6;
  const scaled: PriceHistoryPoint[] = points.map((p) => ({ ...p, price: p.price * scale }));
  return { applied, points: scaled };
}


/** 解析后的交易页历史数据快照（结构兼容 main 的 PersistedMarketVolume）。 */
export interface ParsedMarketVolumeHistory {
  /** 备份格式版本；当前恒为 1。解析时保留，供未来迁移。 */
  version?: number;
  samples: MarketVolumeSample[];
  historyHourly: MarketVolumeHourPoint[];
  priceHistory: Record<string, PriceHistoryPoint[]>;
  liveHistory?: Record<string, LiveVolumePoint[]>;
  itemCount: number;
  itemCountsByCategory: Record<string, number>;
  historyFetchedAtMs?: number;
}

function isMarketVolumeSample(s: unknown): s is MarketVolumeSample {
  const v = s as MarketVolumeSample;
  return !!s && typeof v.timestamp === "string" && typeof v.total === "number";
}

function isMarketVolumeHourPoint(h: unknown): h is MarketVolumeHourPoint {
  const v = h as MarketVolumeHourPoint;
  return !!h && typeof v.hour === "string" && typeof v.total === "number";
}

function isPriceHistoryPoint(pt: unknown): pt is PriceHistoryPoint {
  const v = pt as PriceHistoryPoint;
  return !!pt && Number.isFinite(v.timestamp) && Number.isFinite(v.price) && Number.isFinite(v.volume);
}

function isLiveVolumePoint(pt: unknown): pt is LiveVolumePoint {
  const v = pt as LiveVolumePoint;
  return !!pt && Number.isFinite(v.ts) && Number.isFinite(v.volume);
}

/**
 * 把任意 JSON 解析为交易页历史快照（校验 + 逐字段过滤）。与旧 loadHistory
 * 的过滤规则一致；顶层非法返回 null。旧版纯数组格式解析为仅含 samples 的快照。
 */
export function parseMarketVolumeHistory(raw: unknown): ParsedMarketVolumeHistory | null {
  if (Array.isArray(raw)) {
    return {
      samples: raw.filter(isMarketVolumeSample),
      historyHourly: [],
      priceHistory: {},
      itemCount: 0,
      itemCountsByCategory: {},
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;

  const result: ParsedMarketVolumeHistory = {
    samples: Array.isArray(p.samples) ? p.samples.filter(isMarketVolumeSample) : [],
    historyHourly: Array.isArray(p.historyHourly)
      ? p.historyHourly.filter(isMarketVolumeHourPoint)
      : [],
    priceHistory: {},
    itemCount: typeof p.itemCount === "number" ? p.itemCount : 0,
    itemCountsByCategory:
      p.itemCountsByCategory && typeof p.itemCountsByCategory === "object"
        ? (p.itemCountsByCategory as Record<string, number>)
        : {},
  };

  if (p.priceHistory && typeof p.priceHistory === "object") {
    for (const [hash, pts] of Object.entries(p.priceHistory as Record<string, unknown>)) {
      if (Array.isArray(pts)) {
        result.priceHistory[hash] = pts.filter(isPriceHistoryPoint);
      }
    }
  }
  if (p.liveHistory && typeof p.liveHistory === "object") {
    const liveHistory: Record<string, LiveVolumePoint[]> = {};
    for (const [hash, pts] of Object.entries(p.liveHistory as Record<string, unknown>)) {
      if (Array.isArray(pts)) {
        const valid = pts.filter(isLiveVolumePoint);
        if (valid.length > 0) liveHistory[hash] = valid;
      }
    }
    result.liveHistory = liveHistory;
  }
  if (typeof p.version === "number") result.version = p.version;
  if (typeof p.historyFetchedAtMs === "number") result.historyFetchedAtMs = p.historyFetchedAtMs;
  return result;
}