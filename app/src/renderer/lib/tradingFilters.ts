// 交易页卡片筛选的共享纯函数与类型：从卡片数据推导各维度的选项、
// 按「等级 / 品质 / 部位 / 种类 / 名称 / 价格 / 成交量 / 成交额」过滤。
// 供 TradingFilters 与 Trading 共用，避免从组件文件导出非组件（破坏 Fast Refresh）。

import type { MarketVolumeHourPoint, MarketVolumeItem } from "../../../shared/types";
import { GRADE_ORDER } from "../../core/grades";
import { LEVEL_MAX, LEVEL_MIN } from "./lookupFilters";
import { windowLatestPriceOf, windowTotalOf, windowVolumeOf } from "./windowTotal";

/** 交易页卡片的筛选状态（与 Lookup 页各维度对应）。 */
export interface TradingFilterState {
  /** 名称关键字（大小写不敏感，模糊匹配 name）。 */
  query: string;
  /** 品质多选（grade。空数组 = 全部）。 */
  gradeFilter: string[];
  /** 装备部位多选（gearType。空数组 = 全部）。 */
  gearTypeFilter: string[];
  /** 材料种类多选（materialType。空数组 = 全部）。 */
  materialKindFilter: string[];
  /** 等级区间 `[lo, hi]`，覆盖 LEVEL_MIN..LEVEL_MAX 全跨度时视为「不限」。 */
  levelRange: [number, number];
  /** 成交额下限（全量总成交额 `item.total`）。null = 不限。 */
  minTotal: number | null;
  /** 成交量下限（全量累积成交量）。null = 不限。 */
  minVolume: number | null;
  /** 价格下限（全量加权均价 = total / volume）。null = 不限。 */
  minPrice: number | null;
}

/** 初始筛选状态（全部不限、等级取全跨度）。 */
export const DEFAULT_TRADING_FILTER: TradingFilterState = {
  query: "",
  gradeFilter: [],
  gearTypeFilter: [],
  materialKindFilter: [],
  levelRange: [LEVEL_MIN, LEVEL_MAX],
  minTotal: null,
  minVolume: null,
  minPrice: null,
};

/** 等级区间是否覆盖全跨度（视为「不限等级」）。 */
function isFullLevelRange([lo, hi]: [number, number]): boolean {
  return lo <= LEVEL_MIN && hi >= LEVEL_MAX;
}

/** 从卡片推导品质选项（按 GRADE_ORDER 排序，未知品质追加在后）。 */
export function gradeOptionsFromVolumeItems(items: readonly MarketVolumeItem[]): string[] {
  const present = new Set(
    items.map((i) => i.grade).filter((g): g is string => g != null && g !== ""),
  );
  const ordered: string[] = GRADE_ORDER.filter((g) => present.has(g));
  const extras = [...present].filter((g) => !ordered.includes(g)).sort();
  return [...ordered, ...extras];
}

/** 从卡片推导装备部位选项（仅取非空 gearType，去重排序）。 */
export function gearTypeOptionsFromVolumeItems(items: readonly MarketVolumeItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.gearType ? [i.gearType] : [])))].sort();
}

/** 从卡片推导材料种类选项（仅取非空 materialType，去重排序）。 */
export function materialKindOptionsFromVolumeItems(items: readonly MarketVolumeItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.materialType ? [i.materialType] : [])))].sort();
}

/** 多选命中：未选项为空数组时全部通过；否则要求 value 非空且在选中集内。 */
function matchesMulti(selected: string[], value: string | null | undefined): boolean {
  return selected.length === 0 || (value != null && selected.includes(value));
}

/**
 * 按筛选状态过滤卡片。规则与 Lookup 页一致：
 * - 品质 / 部位 / 种类为多选，空数组 = 全部；
 * - 等级区间仅在对应物品有等级（装备）时生效，无等级的卡片始终通过；
 * - 名称关键字做大小写不敏感的模糊匹配（同时命中显示名与英文市场名 hash）；
 * - 成交额 / 成交量 / 价格为「当前时段」下限（与卡片展示口径一致：`windowTotalOf` /
 *   `windowVolumeOf` / `windowLatestPriceOf`，随上方时间窗口联动；未指定窗口时
 *   成交额/成交量回退全量、价格取全量最新点）；
 * - 返回 `items` 中命中的子集，保持原相对顺序。
 */
export function filterVolumeItems(
  items: readonly MarketVolumeItem[],
  state: TradingFilterState,
  windowRange?: { start: string; end: string } | null,
): MarketVolumeItem[] {
  const q = state.query.trim().toLowerCase();
  const fullLevel = isFullLevelRange(state.levelRange);
  const [minLevel, maxLevel] = state.levelRange;
  return items.filter((item) => {
    if (!matchesMulti(state.gradeFilter, item.grade)) return false;
    if (!matchesMulti(state.gearTypeFilter, item.gearType)) return false;
    if (!matchesMulti(state.materialKindFilter, item.materialType)) return false;
    if (!fullLevel && item.level != null && (item.level < minLevel || item.level > maxLevel)) {
      return false;
    }
    // 名称：同时匹配显示名（本地化，如中文）与英文市场名（hash）。很多用户从
    // Steam 市场复制英文 hash 来搜，而卡片显示的是本地化名，两者都能命中。
    if (q) {
      const hitName = item.name.toLowerCase().includes(q);
      const hitHash = item.hash ? item.hash.toLowerCase().includes(q) : false;
      if (!hitName && !hitHash) return false;
    }
    // 数值下限：均为「当前时段」（窗口口径）：成交额/成交量按窗口、价格取窗口内最新。
    if (state.minTotal != null && windowTotalOf(item, windowRange) < state.minTotal) return false;
    if (state.minVolume != null && windowVolumeOf(item, windowRange) < state.minVolume) {
      return false;
    }
    if (state.minPrice != null) {
      const price = windowLatestPriceOf(item, windowRange);
      if (price == null || price < state.minPrice) return false;
    }
    return true;
  });
}

/** 是否存在任意生效的筛选条件（用于判断大图表是否需要重聚合）。 */
export function hasActiveTradingFilter(state: TradingFilterState): boolean {
  return (
    state.query.trim() !== "" ||
    state.gradeFilter.length > 0 ||
    state.gearTypeFilter.length > 0 ||
    state.materialKindFilter.length > 0 ||
    !isFullLevelRange(state.levelRange) ||
    state.minTotal != null ||
    state.minVolume != null ||
    state.minPrice != null
  );
}

/**
 * 把筛选后的物品卡片重聚合为按小时走势（供上方大图表跟随筛选）。
 *
 * 只聚合 `kind !== "live"` 的卡片：live 卡片是 24h 滚动累计、不可求和（与主进程
 * `hourly` 只来自 pricehistory 的口径一致）。每点含该小时总成交额与按分类明细。
 * 返回升序（旧→新）；无有效点则返回空数组。
 */
export function aggregateFilteredToHourly(
  items: readonly MarketVolumeItem[],
): MarketVolumeHourPoint[] {
  const buckets = new Map<string, { total: number; byCategory: Record<string, number> }>();
  for (const item of items) {
    if (item.kind === "live") continue;
    for (const p of item.points) {
      if (!Number.isFinite(p.total) || p.total <= 0) continue;
      let b = buckets.get(p.hour);
      if (!b) {
        b = { total: 0, byCategory: {} };
        buckets.set(p.hour, b);
      }
      b.total += p.total;
      b.byCategory[item.category] = (b.byCategory[item.category] ?? 0) + p.total;
    }
  }
  const points: MarketVolumeHourPoint[] = [];
  for (const [hour, b] of buckets) {
    points.push({ hour, total: b.total, byCategory: b.byCategory });
  }
  points.sort((a, b) => (a.hour < b.hour ? -1 : 1));
  return points;
}

/** 从筛选后的物品统计各分类覆盖的物品种数（供大图表图例标注）。 */
export function itemCountsByCategoryFromItems(
  items: readonly MarketVolumeItem[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}
