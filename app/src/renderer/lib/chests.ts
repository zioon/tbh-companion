/**
 * Chest grouping helpers for the Chests tab reorganization.
 *
 * These mirror the category vocabulary used by `core/chestDropTracker` and
 * `core/boxes/resolve.ts` so the "held" (from `ChestState.rows`) and "catalog"
 * (from `LookupSources.boxes`) splits group boxes identically. The lookup-side
 * catalog reports plague boxes under `category: "unknown"`, so the catalog side
 * derives its group from the 9xxx item-key prefix instead of `box.category`.
 *
 * v1.3.0 adds the Halloween **event** boxes (940xxx/941xxx) as two groups of
 * their own — `eventNormal` (940xxx) and `eventStage` (941xxx) — mirroring the
 * normal / stage-boss split of the regular chests: the game gives them no
 * capacity / auto-open / drop-cooldown chain of their own, but the companion
 * tracks them separately so they never mix into the common or stage-boss rows.
 */

import { categoryFromBoxItemId, type BoxFamily } from "../../core/boxCategories";

/** The ordered set of chest categories shown on the Chests tab. */
export type ChestGroupCategory = BoxFamily;

/** Display order (matches the capacity cards and i18n `chests.category.*`). */
export const CHEST_GROUPS: ChestGroupCategory[] = [
  "common",
  "rare",
  "act",
  "plagueCommon",
  "plagueRare",
  "plagueAct",
  "eventNormal",
  "eventStage",
];

/**
 * Map a box item-key to its chest group via the 9xxx prefix. Delegates to the
 * shared band table in `core/boxCategories.ts` so the catalog view, the drop
 * tracker and the Chests tab always agree on which group a box belongs to.
 */
export function chestCategoryFromKey(itemKey: number): ChestGroupCategory | null {
  return categoryFromBoxItemId(itemKey);
}

/** i18n key for a group's label within the `chests` namespace. */
export function chestCategoryLabelKey(cat: ChestGroupCategory): string {
  switch (cat) {
    case "rare":
      return "category.stageBoss";
    case "act":
      return "category.actBoss";
    default:
      return `category.${cat}`;
  }
}

/**
 * v1.3.0 掉率符文加成的一行文案。
 *
 * 未购买该类符文时返回空数组（不占行）。语义是**乘数**提升百分比（游戏的
 * stat 名带 `Percent` 后缀），不是加法。
 */
export function dropChanceParts(
  t: (key: string, opts?: Record<string, unknown>) => string,
  breakdown: { bonusPercent: number; purchasedRuneNodes: number; runeLabel: string } | undefined,
): string[] {
  if (!breakdown || breakdown.bonusPercent <= 0) return [];
  return [
    t("dropChanceRuneBonus", {
      percent: breakdown.bonusPercent,
      nodes: breakdown.purchasedRuneNodes,
      runeLabel: breakdown.runeLabel,
    }),
  ];
}
