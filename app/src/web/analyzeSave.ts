// Web build: turn a user-supplied `.es3` save file into a `ResolvedInventory`.
//
// This mirrors what the Electron main process does on the inventory path
// (`es3.decrypt` -> `parseInventory` -> `resolveInventory`, see
// `docs/ARCHITECTURE.md` "Data flow (inventory)"), minus everything that needs
// a running game: no file watching, no live-memory, no Steam price refresh.
// Prices are simply absent, which the inventory table already renders as a
// "not loaded" state.

import { parseInventory } from "../core/inventory/parse";
import { resolveInventory } from "../core/inventory/resolve";
import { decryptToText } from "../core/es3Web";
import { gameItemName, indexById, type GameData, type GameItem } from "../core/gamedata";
import { categoryFromBoxItemName } from "../core/liveMemory/chestSlots";
import { loadLocaleCatalog, type LocaleCatalog } from "../core/localeCatalog";
import {
  buildMaterialSynthesisPoints,
  synthesisPointsForItemKeyByGear,
} from "../core/synthesisPoints";
import { loadLookupItems } from "../core/lookup/catalog";
import { installWebDataSource } from "./dataSource";
import type { ResolvedLanguage } from "../../shared/language";
import type { LookupItem, ResolvedInventory, ResolvedInventoryRow } from "../../shared/types";
import type { InventorySnapshot } from "../../shared/types";
import type { BoxCategory } from "../../shared/types";
import { readBundledJson } from "../core/bundledData";

export interface AnalyzeResult {
  inventory: ResolvedInventory;
  snapshot: InventorySnapshot;
  /** Counts surfaced in the UI so users can sanity-check a load. */
  stats: { itemCount: number; chestCount: number; byteSize: number };
}

interface WebCatalog {
  /** gamedata.json rows, merged with lookup_items.json so placeholder names resolve. */
  items: Map<number, GameItem>;
  lookup: Map<number, LookupItem>;
}

let catalogCache: WebCatalog | null = null;

function webCatalog(): WebCatalog {
  if (catalogCache) return catalogCache;
  installWebDataSource();

  const gamedata = readBundledJson<GameData>("gamedata.json");
  const lookupItems = loadLookupItems();

  const lookup = new Map<number, LookupItem>();
  for (const item of lookupItems) lookup.set(item.id, item);

  const items = indexById(gamedata.items ?? []);
  // Replace `ItemName_<id>` placeholders with the English source name, matching
  // `InventoryService.getEnglishMergedGameItem`. Localization happens later so
  // `marketHashName` keeps producing English hashes for Steam.
  for (const [id, item] of items) {
    if (!item.name.startsWith("ItemName_")) continue;
    const src = lookup.get(id);
    if (src?.name) items.set(id, { ...item, name: src.name });
  }

  catalogCache = { items, lookup };
  return catalogCache;
}

/** Material detection, used by `parseInventory` to merge stackable rows. */
function isMaterialItemKey(itemKey: number): boolean {
  return webCatalog().items.get(itemKey)?.type === "MATERIAL";
}

/** Stage-box classification, used by `parseInventory` to label chest holdings. */
function classifyBoxItemKey(itemKey: number): { category: BoxCategory; label: string } | null {
  const item = webCatalog().items.get(itemKey);
  if (!item || item.type !== "STAGEBOX") return null;
  const category = categoryFromBoxItemName(item.name);
  return category ? { category, label: item.name } : null;
}

/** Stage boxes are listed in the Chests tab; the inventory table omits them. */
function excludeItemKey(itemKey: number): boolean {
  return webCatalog().items.get(itemKey)?.type === "STAGEBOX";
}

function localizeRow(row: ResolvedInventoryRow, catalog: LocaleCatalog): ResolvedInventoryRow {
  const item = webCatalog().items.get(row.itemKey);
  const localized = item ? gameItemName(item, catalog) : row.name;
  return localized === row.name ? row : { ...row, name: localized };
}

/**
 * Decrypt and analyze a save file. Throws `Es3Error` for a wrong password or a
 * non-save file — `err.message` is already user-facing.
 */
export async function analyzeSaveFile(
  file: ArrayBuffer | Uint8Array,
  language: ResolvedLanguage = "en",
  saveMtime = 0,
): Promise<AnalyzeResult> {
  const byteSize = file.byteLength ?? 0;

  const text = await decryptToText(file);
  const snapshot = parseInventory(text, saveMtime, isMaterialItemKey, classifyBoxItemKey);

  const catalog = loadLocaleCatalog(language);
  const { items } = webCatalog();

  const resolved = resolveInventory(snapshot, (key) => items.get(key), true, undefined, {
    excludeItemKey,
  });

  // Synthesis points for materials (soulstones / memorial coins), matching the
  // desktop Inventory tab's `rowSynthesisPoints`. Both `boxDrops` and
  // `offerings` need catalogs the web build does not ship (lookup_sources.json /
  // offerings.json), so soulstone and coin rows fall back to the plain
  // grade-based value instead of an expected-value override.
  const materialPoints = buildMaterialSynthesisPoints({
    itemByKey: (itemKey) => webCatalog().lookup.get(itemKey),
  });

  const rows = resolved.rows.map((row) => {
    const localized = localizeRow(row, catalog);
    // `gearGroup` lives on the lookup catalog entry, not on the resolved row.
    const points = synthesisPointsForItemKeyByGear({
      itemKey: localized.itemKey,
      grade: localized.grade,
      gearGroup: webCatalog().lookup.get(localized.itemKey)?.gearGroup ?? null,
      overrideMap: materialPoints,
    });
    return points == null ? localized : { ...localized, synthesisPoints: points };
  });

  return {
    inventory: { ...resolved, rows },
    snapshot,
    stats: {
      itemCount: snapshot.items.length,
      chestCount: snapshot.chests.reduce((sum, chest) => sum + chest.quantity, 0),
      byteSize,
    },
  };
}
