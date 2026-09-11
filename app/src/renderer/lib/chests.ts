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
