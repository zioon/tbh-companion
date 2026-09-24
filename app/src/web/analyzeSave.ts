// Web build: turn a user-supplied `.es3` save file into a `ResolvedInventory`.
//
// This mirrors what the Electron main process does on the inventory path
// (`es3.decrypt` -> `parseInventory` -> `resolveInventory`, see
// `docs/ARCHITECTURE.md` "Data flow (inventory)"), minus everything that needs
// a running game: no file watching, no live-memory, no Steam price refresh.
// Pricing comes from the same-origin CI snapshot instead (`webPriceLookup`), so
// a save loaded before that fetch completes starts unpriced and is re-resolved
// once the snapshot lands.

import { parseInventory } from "../core/inventory/parse";
import { resolveInventory, type PriceLookup } from "../core/inventory/resolve";
import { decryptToText } from "../core/es3Web";
import { gameItemName, indexById, type GameData, type GameItem } from "../core/gamedata";
import { categoryFromBoxItemName } from "../core/liveMemory/chestSlots";
import { loadLocaleCatalog, type LocaleCatalog } from "../core/localeCatalog";
import { formatMoney } from "../core/steamPrice";
import {
  buildMaterialSynthesisPoints,
  synthesisPointsForItemKeyByGear,
} from "../core/synthesisPoints";
import { loadLookupItems } from "../core/lookup/catalog";
import { installWebDataSource } from "./dataSource";
import type { ResolvedLanguage } from "../../shared/language";
import type {
  InventoryPriceInfo,
  InventorySnapshot,
  LookupItem,
  LookupPriceSnapshot,
  ResolvedInventory,
  ResolvedInventoryRow,
} from "../../shared/types";
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
 *
 * `priceLookup` is optional: without it the rows carry no prices (the table
 * renders its "not loaded" state). The web layer passes the CI snapshot's
 * lookup so the inventory is priced like the desktop's.
 */
export async function analyzeSaveFile(
  file: ArrayBuffer | Uint8Array,
  language: ResolvedLanguage = "en",
  saveMtime = 0,
  priceLookup?: PriceLookup,
): Promise<AnalyzeResult> {
  const byteSize = file.byteLength ?? 0;

  const text = await decryptToText(file);
  const snapshot = parseInventory(text, saveMtime, isMaterialItemKey, classifyBoxItemKey);

  const inventory = resolveWebInventory(snapshot, language, priceLookup);

  return {
    inventory,
    snapshot,
    stats: {
      itemCount: snapshot.items.length,
      chestCount: snapshot.chests.reduce((sum, chest) => sum + chest.quantity, 0),
      byteSize,
    },
  };
}

/**
 * Resolve a parsed save into localized display rows.
 *
 * Split out of {@link analyzeSaveFile} so the web layer can re-run it when the
 * Steam price snapshot arrives or the language changes, without re-decrypting
 * the file — only the parse is expensive.
 */
export function resolveWebInventory(
  snapshot: InventorySnapshot,
  language: ResolvedLanguage,
  priceLookup?: PriceLookup,
): ResolvedInventory {
  const catalog = loadLocaleCatalog(language);
  const { items } = webCatalog();

  const resolved = resolveInventory(snapshot, (key) => items.get(key), true, priceLookup, {
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

  return { ...resolved, rows };
}

/**
 * Build the inventory `PriceLookup` from the same-origin CI snapshot.
 *
 * The CI snapshot carries only the lowest active listing per market_hash_name —
 * recent-sale medians and buy orders come from the desktop's local polling,
 * which a browser cannot do. Rows priced from it therefore report the
 * "lowest listing" source and never a buy order; that is the honest ceiling of
 * what a browser can know without talking to Steam.
 *
 * Returns undefined when there is no snapshot, so callers keep whatever prices
 * they already had instead of wiping them.
 */
export function webPriceLookup(
  snapshot: LookupPriceSnapshot | null | undefined,
): PriceLookup | undefined {
  if (!snapshot?.prices) return undefined;
  const prices = snapshot.prices;
  const currency = snapshot.baseCurrency;
  return (hash): InventoryPriceInfo | undefined => {
    const lowest = prices[hash];
    if (lowest == null) return undefined;
    return {
      median: null,
      lowest,
      // The table renders from the raw Steam text, which the snapshot does not
      // carry — format the number in the snapshot's (USD) base currency.
      rawMedian: null,
      rawLowest: formatMoney(lowest, currency),
      buyOrder: null,
      rawBuyOrder: null,
      buyOrderQuantity: null,
      buyOrderLevels: null,
      buyOrderFetched: false,
    };
  };
}
