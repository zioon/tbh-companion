// renderer/lib/gameLocaleLabels.ts
// Converts flat game bundle locale keys (e.g. "Grade_COMMON", "GearType_SWORD")
// into the companion's nested labels structure for i18next resource merging.
// This is the TypeScript equivalent of scripts/sync_common_with_game.py's logic.

// Mapping: game key prefix → companion labels path suffix
const GRADE_PREFIX = "Grade_";
const GEAR_TYPE_PREFIX = "GearType_";
const ITEM_TYPE_PREFIX = "ItemType_";
const STAT_NAME_PREFIX = "StatName_";
const STAT_TEMPLATE_PREFIX = "Stat_";
const BASE_STAT_NAME_PREFIX = "BaseStatName_";
const HERO_NAME_PREFIX = "HeroName_";
const STASH_FILTER_PREFIX = "StashItemFilterType_";
const ITEM_PARTS_PREFIX = "ItemParts_";

// Stat template mod suffixes — keys like "Stat_<statKey>_<MOD>" or
// "Stat_<statKey>_<MOD>_MinMax" are the game's own attribute-line formatters
// (e.g. "Stat_AttackDamage_FLAT" = "Attack Damage +{0}"). They are the
// authoritative source for attribute-line text in every game language.
const STAT_MOD_SUFFIXES = ["FLAT", "ADDITIVE", "MULTIPLICATIVE"];

// Single-key material kinds (no prefix, exact match)
const MATERIAL_KINDS = new Set(["OFFERING", "INSCRIPTION", "DECORATION", "ENGRAVING", "CRAFTING"]);

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
  /**
   * Game-supplied attribute-line templates keyed by the full game key
   * (e.g. "Stat_AttackDamage_FLAT", "Stat_AttackDamage_FLAT_MinMax").
   * Used by formatStatRow/formatMaterialOutcome to render attribute lines
   * in the player's language without companion-side translation.
   */
  statTemplates?: Record<string, string>;
  /**
   * Game-supplied base-stat display names keyed by stat key (e.g.
   * "BaseStatName_AttackSpeed" → "Attack Per Second" / "每秒攻击"). The game
   * uses these — not the generic `StatName_<stat>` — when rendering a gear
   * piece's base Attack Speed line, because the unit differs (attacks/sec
   * rather than the raw internal integer). Only AttackSpeed currently has a
   * BaseStatName entry; other base stats fall back to `StatName_<stat>`
   * via `labels.stats`.
   */
  baseStatNames?: Record<string, string>;
  /**
   * Game-supplied item-part labels keyed by UPPER_SNAKE_CASE (e.g.
   * "ItemParts_MAIN_WEAPON" → "Main Weapon" / "主武器"). Used by
   * `craftingTypeLabel` to render a recipe's crafting category for
   * MainWeapon/SubWeapon, which don't appear in `gearGroups` or `types`.
   */
  itemParts?: Record<string, string>;
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
  const statTemplates: Record<string, string> = {};
  const baseStatNames: Record<string, string> = {};
  const itemParts: Record<string, string> = {};

  for (const [key, value] of Object.entries(game)) {
    if (key.startsWith(GRADE_PREFIX)) {
      grades[key.slice(GRADE_PREFIX.length)] = value;
    } else if (key.startsWith(GEAR_TYPE_PREFIX)) {
      types[key.slice(GEAR_TYPE_PREFIX.length)] = value;
    } else if (key.startsWith(ITEM_TYPE_PREFIX)) {
      types[key.slice(ITEM_TYPE_PREFIX.length)] = value;
    } else if (key.startsWith(BASE_STAT_NAME_PREFIX)) {
      baseStatNames[key.slice(BASE_STAT_NAME_PREFIX.length)] = value;
    } else if (key.startsWith(STAT_NAME_PREFIX)) {
      stats[key.slice(STAT_NAME_PREFIX.length)] = value;
    } else if (key.startsWith(STAT_TEMPLATE_PREFIX)) {
      // Only keep keys that match the "Stat_<statKey>_<MOD>" or
      // "Stat_<statKey>_<MOD>_MinMax" shape. This excludes unrelated keys
      // that happen to start with "Stat_" (none currently, but defensive).
      const rest = key.slice(STAT_TEMPLATE_PREFIX.length);
      const parts = rest.split("_");
      const last = parts[parts.length - 1];
      const isMinMax = last === "MinMax";
      const modIdx = isMinMax ? parts.length - 2 : parts.length - 1;
      const mod = parts[modIdx];
      if (mod && STAT_MOD_SUFFIXES.includes(mod)) {
        statTemplates[key] = value;
      }
    } else if (key.startsWith(HERO_NAME_PREFIX)) {
      const cls = HERO_ID_TO_CLASS[key.slice(HERO_NAME_PREFIX.length)];
      if (cls) classes[cls] = value;
    } else if (key.startsWith(STASH_FILTER_PREFIX)) {
      const group = key.slice(STASH_FILTER_PREFIX.length);
      // Only include WEAPON/ARMOR/ACCESSORY (skip ALL, MATERIAL, CLASS_*)
      if (group === "WEAPON" || group === "ARMOR" || group === "ACCESSORY") {
        gearGroups[group] = value;
      }
    } else if (key.startsWith(ITEM_PARTS_PREFIX)) {
      itemParts[key.slice(ITEM_PARTS_PREFIX.length)] = value;
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
  if (Object.keys(statTemplates).length > 0) result.statTemplates = statTemplates;
  if (Object.keys(baseStatNames).length > 0) result.baseStatNames = baseStatNames;
  if (Object.keys(itemParts).length > 0) result.itemParts = itemParts;
  return Object.keys(result).length > 0 ? result : null;
}
