// renderer/lib/gameLocaleLabels.ts
// Converts flat game bundle locale keys (e.g. "Grade_COMMON", "GearType_SWORD")
// into the companion's nested labels structure for i18next resource merging.
// This is the TypeScript equivalent of scripts/sync_common_with_game.py's logic.

// Mapping: game key prefix → companion labels path suffix
const GRADE_PREFIX = "Grade_";
const GEAR_TYPE_PREFIX = "GearType_";
const ITEM_TYPE_PREFIX = "ItemType_";
const STAT_NAME_PREFIX = "StatName_";
const HERO_NAME_PREFIX = "HeroName_";
const STASH_FILTER_PREFIX = "StashItemFilterType_";

// Single-key material kinds (no prefix, exact match)
const MATERIAL_KINDS = new Set([
  "OFFERING",
  "INSCRIPTION",
  "DECORATION",
  "ENGRAVING",
  "CRAFTING",
]);

// Reverse mapping: HeroName_<id> → companion's class key
const HERO_ID_TO_CLASS: Record<string, string> = {
  "101": "Knight",
  "201": "Ranger",
  "301": "Sorcerer",
  "401": "Priest",
  "501": "Hunter",
  "601": "Slayer",
};

export interface GameLabelsSection {
  grades?: Record<string, string>;
  types?: Record<string, string>;
  stats?: Record<string, string>;
  classes?: Record<string, string>;
  gearGroups?: Record<string, string>;
}

/**
 * Convert a flat game locale map into the companion's labels structure.
 *
 * Example input:
 *   { "Grade_COMMON": "Common", "GearType_SWORD": "Sword", ... }
 *
 * Example output:
 *   { grades: { COMMON: "Common" }, types: { SWORD: "Sword" }, ... }
 *
 * Returns null if no label keys are found.
 */
export function flatGameKeysToLabels(game: Record<string, string>): GameLabelsSection | null {
  const grades: Record<string, string> = {};
  const types: Record<string, string> = {};
  const stats: Record<string, string> = {};
  const classes: Record<string, string> = {};
  const gearGroups: Record<string, string> = {};

  for (const [key, value] of Object.entries(game)) {
    if (key.startsWith(GRADE_PREFIX)) {
      grades[key.slice(GRADE_PREFIX.length)] = value;
    } else if (key.startsWith(GEAR_TYPE_PREFIX)) {
      types[key.slice(GEAR_TYPE_PREFIX.length)] = value;
    } else if (key.startsWith(ITEM_TYPE_PREFIX)) {
      types[key.slice(ITEM_TYPE_PREFIX.length)] = value;
    } else if (key.startsWith(STAT_NAME_PREFIX)) {
      stats[key.slice(STAT_NAME_PREFIX.length)] = value;
    } else if (key.startsWith(HERO_NAME_PREFIX)) {
      const cls = HERO_ID_TO_CLASS[key.slice(HERO_NAME_PREFIX.length)];
      if (cls) classes[cls] = value;
    } else if (key.startsWith(STASH_FILTER_PREFIX)) {
      const group = key.slice(STASH_FILTER_PREFIX.length);
      // Only include WEAPON/ARMOR/ACCESSORY (skip ALL, MATERIAL, CLASS_*)
      if (group === "WEAPON" || group === "ARMOR" || group === "ACCESSORY") {
        gearGroups[group] = value;
      }
    } else if (MATERIAL_KINDS.has(key)) {
      types[key] = value;
    }
    // Skip unrecognized keys (ItemName_*, UI_*, Toast_*, etc.)
  }

  const result: GameLabelsSection = {};
  if (Object.keys(grades).length > 0) result.grades = grades;
  if (Object.keys(types).length > 0) result.types = types;
  if (Object.keys(stats).length > 0) result.stats = stats;
  if (Object.keys(classes).length > 0) result.classes = classes;
  if (Object.keys(gearGroups).length > 0) result.gearGroups = gearGroups;
  return Object.keys(result).length > 0 ? result : null;
}
