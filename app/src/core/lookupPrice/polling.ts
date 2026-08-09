// 轮询/历史拉取目标选择的纯函数，供两个场景使用：
//
//   - {@link selectPollingTargets}：图鉴页的本地价格轮询。仅选取用户手动收藏
//     （星标）的物品，无条件入选，无论是否拥有、是否有价格。上限 maxTargets
//     控制单轮规模，避免 Steam 限流熔断频繁触发。
//
//   - {@link selectHistoryRefreshTargets}：交易页「刷新历史价格」按钮。选取
//     「星标 ∪ 图鉴快照里价格达阈值的全部物品」（快照价格 ≥ thresholdUsd，
//     按价格降序，星标优先）。这是用户主动触发的全量历史刷新，默认不设上限。
//
// 两个选择器职责不同：图鉴只盯用户主动关注的星标；交易页需要更全的高价值集合。

import type { LookupPriceSnapshot } from "../../../shared/types";

export interface PollingTargetInput {
  /** 用户手动收藏的 market_hash_name 列表（来自 config.lookupPricePolling.watchedHashes）。 */
  watchedHashes: readonly string[];
  /** 单轮轮询的 hash 数量上限。默认 50。 */
  maxTargets?: number;
}

/**
 * 计算图鉴页本轮要轮询的 hash 列表（仅星标物品）。
 *
 * 返回的列表已去重、去空并按入参顺序保留。
 */
export function selectPollingTargets(input: PollingTargetInput): string[] {
  const { watchedHashes, maxTargets = 50 } = input;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of watchedHashes) {
    if (typeof h !== "string") continue;
    const trimmed = h.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > maxTargets ? out.slice(0, maxTargets) : out;
}

export interface HistoryRefreshTargetInput {
  /** 当前内存中的图鉴价格快照；可能为 null（启动早期或未拉到 CI 快照时）。 */
  snapshot: LookupPriceSnapshot | null;
  /** 用户手动收藏的 market_hash_name 列表（来自 config.lookupPricePolling.watchedHashes）。 */
  watchedHashes: readonly string[];
  /** 「高价值」USD 价格阈值。快照价格 ≥ 阈值的物品被选中（含所有拥有与否）。 */
  thresholdUsd: number;
  /** hash 数量上限；默认不设上限（尊重「全部」语义）。 */
  maxTargets?: number;
}

/**
 * 计算交易页「刷新历史价格」要拉取 pricehistory 的 hash 列表：
 * 星标（无条件）→ 快照价格 ≥ 阈值的物品（按价格降序）。
 *
 * 返回的列表已去重、去空。
 */
export function selectHistoryRefreshTargets(input: HistoryRefreshTargetInput): string[] {
  const { snapshot, watchedHashes, thresholdUsd, maxTargets } = input;

  // 1) 收集 watched（去重、去空）
  const watchedSet = new Set<string>();
  const watchedOrdered: string[] = [];
  for (const h of watchedHashes) {
    if (typeof h !== "string") continue;
    const trimmed = h.trim();
    if (!trimmed || watchedSet.has(trimmed)) continue;
    watchedSet.add(trimmed);
    watchedOrdered.push(trimmed);
  }

  // 2) 快照里价格 ≥ 阈值的物品（排除已在 watched 的），按价格降序
  const aboveThreshold: Array<{ hash: string; usd: number }> = [];
  if (snapshot) {
    for (const [hash, usd] of Object.entries(snapshot.prices)) {
      if (typeof usd !== "number" || usd < thresholdUsd) continue;
      if (watchedSet.has(hash)) continue;
      aboveThreshold.push({ hash, usd });
    }
    aboveThreshold.sort((a, b) => b.usd - a.usd);
  }

  // 3) 合并（星标优先）
  const merged = [...watchedOrdered, ...aboveThreshold.map((x) => x.hash)];
  return typeof maxTargets === "number" && merged.length > maxTargets
    ? merged.slice(0, maxTargets)
    : merged;
}
