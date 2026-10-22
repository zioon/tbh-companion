/**
 * Chest grouping helpers for the Chests tab reorganization.
 *
 * These mirror the category vocabulary used by `core/chestDropTracker` and
 * `core/boxes/resolve.ts` so the "held" (from `ChestState.rows`) and "catalog"
 * (from `LookupSources.boxes`) splits group boxes identically. The lookup-side
 * catalog reports plague boxes under `category: "unknown"`, so the catalog side
 * derives its group from the 9xxx item-key prefix instead of `box.category`.
 */

/** The ordered set of chest categories shown on the Chests tab. */
export type ChestGroupCategory =
  | "common"
  | "rare"
  | "act"
  | "plagueCommon"
  | "plagueRare"
  | "plagueAct";

/** Display order (matches the capacity cards and i18n `chests.category.*`). */
export const CHEST_GROUPS: ChestGroupCategory[] = [
  "common",
  "rare",
  "act",
  "plagueCommon",
  "plagueRare",
  "plagueAct",
];

/**
 * Map a box item-key to its chest group via the 9xxx prefix. Mirrors
 * `categoryFromPrefix` in `core/chestDropTracker.ts` so the catalog view and the
 * drop tracker agree on which group a plague/normal box belongs to.
 */
export function chestCategoryFromKey(itemKey: number): ChestGroupCategory | null {
  if (itemKey >= 915_000 && itemKey < 916_000) return "plagueCommon";
  if (itemKey >= 925_000 && itemKey < 926_000) return "plagueRare";
  if (itemKey >= 935_000 && itemKey < 936_000) return "plagueAct";
  if (itemKey >= 910_000 && itemKey < 920_000) return "common";
  if (itemKey >= 920_000 && itemKey < 930_000) return "rare";
  if (itemKey >= 930_000 && itemKey < 940_000) return "act";
  // v1.3.0 Halloween event boxes (CONTENTTYPE=EVENT): 940xxx = normal tier
  // (common slot), 941xxx = stage-boss tier (rare slot). The game gives them
  // no dedicated capacity runes, so they occupy the existing buckets.
  if (itemKey >= 940_000 && itemKey < 941_000) return "common";
  if (itemKey >= 941_000 && itemKey < 942_000) return "rare";
  return null;
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
