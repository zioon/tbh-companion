// 候选硬币兜底归因（P0-4）—— 纯函数。
//
// 差分不可靠时的 fallback：用物品名反查 `offerings.json` 的 loot 表，找出
// 「哪些硬币的掉落池含该物品」，输出候选集合 + 各自 poolPct（**多对多，不猜唯一**）。
//
// 路径：`name` → `nameToItemKey(name)`（main 注入的名称索引）→ itemKey →
// `offeringSourcesForItem(offerings, itemKey)`（core 既有反查）。
//
// 命中失败（无 itemKey / 无 offerings / 无候选）→ `unknown`（I7，不虚构）。
// 无 electron / node:fs / fetch / React 依赖（I9）；**core 不 import 数据**。

import type { WishCoinAttribution, WishCoinCandidate } from "../../../shared/types";
import { offeringSourcesForItem } from "../lookup/offerings";
import type { OfferingsModel } from "../lookup/types";

/** 候选归因的依赖注入（由 main 提供，避免 core 依赖数据文件）。 */
export interface CoinCandidateDeps {
  /** 去标签物品名 → itemKey；无则 undefined。 */
  nameToItemKey: (name: string) => number | undefined;
  /** offerings 模型；目录未就绪时为 null。 */
  offerings: OfferingsModel | null;
  /**
   * P1-2 预留：当前背包持有的硬币集合（用于给候选打 `held` 标记）。
   * 本轮不做过滤，仅在提供时标注。
   */
  heldCoinKeys?: ReadonlySet<number>;
}

/**
 * 候选兜底归因（纯函数）。
 *
 * @returns 命中 loot 反查 → `{ confidence:"inferred", coinKey:null, candidates }`
 *          （候选按 poolPct 降序）；miss → `{ confidence:"unknown", ... }`。
 */
export function inferCoinCandidates(name: string, deps: CoinCandidateDeps): WishCoinAttribution {
  const itemKey = deps.nameToItemKey((name ?? "").trim());
  if (itemKey == null) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "no-item-key" };
  }
  if (!deps.offerings) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "no-offerings" };
  }

  const sources = offeringSourcesForItem(deps.offerings, itemKey);
  if (sources.length === 0) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "no-candidates" };
  }

  const candidates: WishCoinCandidate[] = sources.map((s) => {
    const cand: WishCoinCandidate = { coinKey: s.coinKey, poolPct: s.poolPct };
    if (deps.heldCoinKeys) cand.held = deps.heldCoinKeys.has(s.coinKey);
    return cand;
  });

  return {
    confidence: "inferred",
    coinKey: null,
    candidates,
    basis: `loot:${candidates.length}cand`,
  };
}
