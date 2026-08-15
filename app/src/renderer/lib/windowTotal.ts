// 交易页卡片的共享纯函数与类型：窗口成交额计算、刷新批次状态、走势图降采样。
// 供 ItemVolumeCard 与 Trading 共用，避免从组件文件导出非组件（破坏 Fast Refresh）。

import type { MarketVolumeItem } from "../../../shared/types";

/** 交易页主图表与卡片共用的时间范围。 */
export type VolumeRange = "1d" | "1w" | "1m" | "all";

/** 各范围对应的窗口小时数（"all" 用全量点数）。 */
export const RANGE_HOURS: Record<Exclude<VolumeRange, "all">, number> = {
  "1d": 24,
  "1w": 168,
  "1m": 720,
};

/** 交易页刷新批次的单片状态（驱动卡片亮环）。 */
export type RefreshStatus = "pending" | "refreshing" | "refreshed";

/**
 * 二分查找：在按 `hour` 升序的 points 中返回第一个 `hour >= target` 的索引；
 * 若所有 hour 都小于 target，返回 points.length。
 *
 * `hour` 为 ISO 字符串，字典序即时间序，可直接用字符串比较。
 */
function lowerBound(points: readonly { hour: string }[], target: string): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].hour < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 二分查找：在按 `hour` 升序的 points 中返回最后一个 `hour <= target` 的索引；
 * 若所有 hour 都大于 target，返回 -1。
 */
function upperBound(points: readonly { hour: string }[], target: string): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].hour <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * 计算某物品在给定时间窗口内的成交额。
 *
 * - 未指定窗口（"all" 或数据为空）：返回全量 `total`。
 * - 指定窗口但区间内无历史价格点：返回 0，而非回退全量 `total`——否则会把
 *   「区间内没有成交」误显示成「全部成交金额」。
 * - `kind === "live"` 卡片（24h 滚动累计，不可求和）：取区间内最新一个采样点的 `total`。
 * - history 卡片（真实小时增量，可求和）：对区间内各点 `total` 求和。
 *
 * 内部用二分定位窗口边界后仅在窗口内累加，避免对整个 points 做 `filter` 全量扫描。
 */
export function windowTotalOf(
  item: MarketVolumeItem,
  windowRange?: { start: string; end: string } | null,
): number {
  if (!windowRange || !windowRange.start || !windowRange.end) {
    return item.total;
  }
  const pts = item.points;
  const startIdx = lowerBound(pts, windowRange.start);
  const endIdx = upperBound(pts, windowRange.end);
  if (startIdx > endIdx) return 0;
  if (item.kind === "live") return pts[endIdx].total;
  let sum = 0;
  for (let i = startIdx; i <= endIdx; i++) sum += pts[i].total;
  return sum;
}

/**
 * 按 `[start, end]` 闭区间二分切片升序 points，返回窗口内的新数组（含端点）。
 * 供卡片走势图取当前窗口的点序列，替代 `filter` 全量扫描。
 */
export function sliceWindow<T extends { hour: string }>(
  points: readonly T[],
  windowRange: { start: string; end: string },
): T[] {
  const startIdx = lowerBound(points, windowRange.start);
  const endIdx = upperBound(points, windowRange.end);
  if (startIdx > endIdx) return [];
  return points.slice(startIdx, endIdx + 1);
}

/**
 * 均匀降采样到最多 `maxPoints` 个点，保留首尾点。用于把超出显示像素密度的
 * 走势点压缩到可绘制的规模，减少 SVG path 字符串长度与节点数量。
 */
export function downsample<T>(arr: readonly T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr.slice();
  const step = (arr.length - 1) / (maxPoints - 1);
  const out: T[] = new Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    out[i] = arr[Math.round(i * step)];
  }
  return out;
}

/**
 * 按「当前时间窗口内的成交额」对物品卡片降序排序（无窗口/空窗口时回退到全量
 * `total`）。预计算每个 hash 的窗口成交额再排序，避免比较器里反复调用
 * `windowTotalOf`（每次比较都全量扫描 points，O(n·log n) 次调用）。
 *
 * 主列表与刷新期间的待刷新占位卡片共用本函数，保证「卡片展示金额」与
 * 「排列顺序」的口径一致——否则待刷新列表按目标集顺序（全量交易额）排列、
 * 卡片却展示窗口金额，看起来像「更新后没有按交易额排序」。
 */
export function sortItemsByWindowTotal<T extends MarketVolumeItem>(
  items: readonly T[],
  windowRange?: { start: string; end: string } | null,
): T[] {
  const windowTotalByHash = new Map<string, number>();
  for (const item of items) windowTotalByHash.set(item.hash, windowTotalOf(item, windowRange));
  return [...items].sort(
    (a, b) => (windowTotalByHash.get(b.hash) ?? 0) - (windowTotalByHash.get(a.hash) ?? 0),
  );
}

/**
 * 按固定小时步长抽样（索引步长 = stepHours，因为数据每小时一个点），保证相邻
 * 采样点间隔严格等于步长，使每个点对应的粒度稳定一致。从最新点往回抽样，
 * 确保最新数据点始终保留在序列里。
 */
export function downsampleByStep<T>(arr: readonly T[], stepHours: number): T[] {
  if (arr.length <= 1 || stepHours <= 1) return arr.slice();
  const out: T[] = [];
  for (let i = arr.length - 1; i >= 0; i -= stepHours) {
    out.push(arr[i]);
  }
  return out.reverse();
}

/** 有意义的时间粒度档位（小时）：1h / 2h / 6h / 12h / 1d / 2d / 7d。 */
const GRANULARITY_STEPS_HOURS = [1, 2, 6, 12, 24, 48, 168] as const;

/**
 * 走势图显示粒度：平均每个显示点覆盖的小时数（= 窗口点数 / 显示点数），
 * 向上归一到有意义的档位（1h/2h/6h/12h/1d/2d/7d），避免出现「1.4 小时」这类
 * 无意义的中间值。用于在 UI 上明确标识当前范围的最小时间粒度。
 */
export function trendGranularityHours(pointCount: number, maxPoints: number): number {
  const samples = Math.max(1, Math.min(pointCount, maxPoints));
  if (pointCount <= 1 || samples <= 1) return 1;
  const rawHours = pointCount / samples;
  return (
    GRANULARITY_STEPS_HOURS.find((step) => rawHours <= step) ??
    GRANULARITY_STEPS_HOURS[GRANULARITY_STEPS_HOURS.length - 1]
  );
}
