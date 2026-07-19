// Game item catalog: maps the save's numeric ItemKey to name/grade/type/level.
//
// Bundled in data/gamedata.json (updated via tbh-data release workflow).

import type { LocaleCatalog } from "./localeCatalog";

export interface GameItem {
  id: number; // == save itemSaveDatas[].ItemKey
  name: string;
  grade: string; // COMMON..COSMIC
  type: string; // GEAR | MATERIAL | STAGEBOX | ...
  level: number | null; // gear item level; null for materials / unknown
  marketTradable: boolean;
}

export interface GameData {
  source: string;
  fetchedUtc: string;
  count: number;
  items: GameItem[];
}

export function indexById(items: GameItem[]): Map<number, GameItem> {
  const m = new Map<number, GameItem>();
  for (const it of items) m.set(it.id, it);
  return m;
}

/** Save ItemKeys in the bundled catalog range (gear, materials, stage boxes). */
const SAVE_CATALOG_ITEM_KEY_MIN = 110_001;
const SAVE_CATALOG_ITEM_KEY_MAX = 939_999;

/**
 * Map a save `itemSaveDatas[].ItemKey` to the catalog `id`.
 * Newer builds may append a 3-digit suffix (e.g. `514051800` → catalog `514051`).
 * Suffix `900` is Steam Market pipeline only — stripped here for id lookup, but
 * those rows are excluded from playable inventory (`isMarketPipelineSaveItemKey`).
 */
export function catalogItemKeyFromSave(itemKey: number): number {
  if (itemKey < 1_000_000) return itemKey;
  const base = Math.trunc(itemKey / 1000);
  if (base >= SAVE_CATALOG_ITEM_KEY_MIN && base <= SAVE_CATALOG_ITEM_KEY_MAX) return base;
  return itemKey;
}

/** `ItemKey` ending in …900 — Steam Market pipeline (Ship / listed); not playable inventory. */
export function isMarketPipelineSaveItemKey(itemKey: number): boolean {
  return itemKey >= 1_000_000 && itemKey % 1000 === 900;
}

/**
 * Whether a `catalogItemKeyFromSave` result falls in the bundled catalog's id
 * range. Used to distinguish a genuine game id the catalog hasn't indexed yet
 * (e.g. 620017, extracted from the localization key "ItemName_620017") from a
 * garbage misread (e.g. 1703973696, a heap-address low-32-bits that
 * `catalogItemKeyFromSave` couldn't normalize). The former should be preserved
 * so loot isn't lost on restart; the latter should be dropped.
 */
export function isPlausibleCatalogItemKey(catalogId: number): boolean {
  return catalogId >= SAVE_CATALOG_ITEM_KEY_MIN && catalogId <= SAVE_CATALOG_ITEM_KEY_MAX;
}

/** Normalize a catalog row loaded from JSON (tolerates legacy icon/gearId fields). */
export function normalizeGameItem(raw: Record<string, unknown>): GameItem | null {
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const levelRaw = raw.level;
  return {
    id,
    name: String(raw.name ?? `#${id}`),
    grade: String(raw.grade ?? "UNKNOWN"),
    type: String(raw.type ?? "UNKNOWN"),
    level:
      levelRaw === null || levelRaw === undefined
        ? null
        : Number.isFinite(Number(levelRaw))
          ? Number(levelRaw)
          : null,
    marketTradable: Boolean(raw.marketTradable ?? raw.is_market_tradable),
  };
}

/**
 * Resolve a GameItem's display name. Looks up `catalog.items[String(item.id)]`
 * first — this covers both `ItemName_<id>` placeholders AND items whose
 * gamedata.name was already resolved to English from the EN stringtable
 * (e.g. "Long Sword" → catalog.items["300001"] = "长剑"). Falls back to
 * `item.name` (which is either the raw `ItemName_<id>` key, a hardcoded
 * English name, or an English name resolved from the EN stringtable).
 *
 * Pass `catalog = null` to skip localization (returns `item.name` as-is).
 *
 * Accepts any object with `{ id, name }` so it works with both `GameItem`
 * (gamedata.json rows) and `LookupItem` (lookup_items.json rows) without
 * forcing callers to coerce.
 */
export function gameItemName(
  item: { id: number; name: string },
  catalog: LocaleCatalog | null = null,
): string {
  if (catalog) {
    const localized = catalog.items[String(item.id)];
    if (localized) return localized;
  }
  return item.name;
}
