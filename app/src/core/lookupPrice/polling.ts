// 选择本地轮询目标的纯函数：从图鉴共享快照里筛出已拥有且估值达阈值的物品，
// 加上用户手动收藏的物品，组合成本轮要轮询的 market_hash_name 列表。
//
// 设计原则：
//   - 用户收藏（watchedHashes）：无条件入选，无论是否拥有、是否有价格
//   - 已拥有 + priceable（有 hash）：全部入选，threshold 仅用于排序优先级
//     · 有快照价格且 ≥ threshold：高价值，优先轮询
//     · 无快照价格 或 < threshold：常规，排在后面
//   - 上限 maxTargets：单轮控制在合理范围，避免 Steam 限流熔断频繁触发
//
// 排序：watched 优先（用户更关心）→ 高价值拥有物（按快照价格降序）→
// 常规拥有物（无快照价格或低于阈值）。这样在熔断时被砍掉的是低价值的、
// 不太重要的物品。
//
// 注：ownedHashes 来自 InventoryService.getOwnedPriceHashes()，已只包含
// priceable 物品（MATERIAL 或 Legendary+ GEAR）的 market_hash_name。

import type { LookupPriceSnapshot } from "../../../shared/types";

export interface PollingTargetInput {
  /** 当前内存中的图鉴价格快照；可能为 null（启动早期或未拉到 CI 快照时）。 */
  snapshot: LookupPriceSnapshot | null;
  /** 玩家当前拥有物品的 market_hash_name 列表（来自 InventoryService）。 */
  ownedHashes: readonly string[];
  /** 用户手动收藏的 market_hash_name 列表（来自 config.lookupPricePolling.watchedHashes）。 */
  watchedHashes: readonly string[];
  /** 「高价值」USD 价格阈值。仅用于排序优先级，不再过滤目标。 */
  thresholdUsd: number;
  /** 单轮轮询的 hash 数量上限。默认 50。 */
  maxTargets?: number;
}

/**
 * 计算本轮需要轮询的 hash 列表。
 *
 * 见上文设计原则。返回的列表已去重并按上述顺序排序。
 */
export function selectPollingTargets(input: PollingTargetInput): string[] {
  const { snapshot, ownedHashes, watchedHashes, thresholdUsd, maxTargets = 50 } = input;

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

  // 2) 拆分 owned：高价值（快照价格 ≥ 阈值）优先，常规（无价格或低于阈值）排后
  const highValueOwned: Array<{ hash: string; usd: number }> = [];
  const regularOwned: string[] = [];
  for (const hash of ownedHashes) {
    if (typeof hash !== "string") continue;
    const trimmed = hash.trim();
    if (!trimmed) continue;
    if (watchedSet.has(trimmed)) continue; // 已在 watched，不重复
    const usd = snapshot?.prices[trimmed];
    if (typeof usd === "number" && usd >= thresholdUsd) {
      highValueOwned.push({ hash: trimmed, usd });
    } else {
      regularOwned.push(trimmed);
    }
  }
  highValueOwned.sort((a, b) => b.usd - a.usd);

  // 3) 合并 + 截断
  const merged = [
    ...watchedOrdered,
    ...highValueOwned.map((x) => x.hash),
    ...regularOwned,
  ];
  return merged.length > maxTargets ? merged.slice(0, maxTargets) : merged;
}
