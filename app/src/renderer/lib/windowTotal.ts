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
