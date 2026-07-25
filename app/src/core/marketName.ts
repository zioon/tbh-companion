// Map catalog items to Steam Community Market `market_hash_name`s.
//
// Materials: 1:1 on display name. Gear: "<name> (<Grade>) A" (variant letter).
// Gear is only priced at Legendary+; materials are priced regardless of grade.
// Exact grade only (no cross-grade fallback). priceoverview confirms listings.
//
// Variant B–E are not probed: save letter is unknown and B listings are often phantom.

import type { GameItem } from "./gamedata";
import { gradeTitle, isPriceableGrade } from "./grades";

export interface MarketHashMatch {
  name: string;
}

/**
 * Minimal item shape needed to derive a market hash — satisfied by GameItem
 * and LookupItem.
 *
 * `sourceName` is optional and used (when present) as the Steam
 * `market_hash_name` base instead of `name`. Steam hashes are always
 * English; rendering a localized `name` (e.g. "铜币") would break price
 * lookups because the snapshot is keyed by the English name (e.g.
 * "Copper Coin"). LookupService sets `sourceName` on localized items so
 * `marketHashName`/`marketHashCandidates` keep producing English hashes
 * regardless of the UI language.
 */
export type MarketHashItem = Pick<GameItem, "name" | "grade" | "type" | "marketTradable"> & {
  sourceName?: string;
};

/** Steam market_hash_name base: prefer the English source name when present. */
function hashBaseName(item: MarketHashItem): string {
  return item.sourceName ?? item.name;
}

export function isPriceableItem(type: string, grade: string, marketTradable: boolean): boolean {
  if (!marketTradable) return false;
  if (type === "MATERIAL") return true;
  if (type === "GEAR") return isPriceableGrade(grade);
  return false;
}

/**
 * Names like "ItemName_145002" are unresolved catalog placeholders —
 * `build_catalog.py` falls back to the raw NameKey when the localization
 * hash isn't matched (see `scripts/build_catalog.py` `unresolved_namekey`).
 * They never correspond to a real Steam market_hash_name, so probing them
 * just wastes rate-limit budget and (with 429 backoff) can stall the whole
 * refresh. Treat them as non-priceable.
 */
export function isPlaceholderItemName(name: string): boolean {
  return name.startsWith("ItemName_");
}

/** Gear market hash suffix letters we price and link to (A only until save letter is known). */
export const GEAR_MARKET_VARIANT_LETTERS = ["A"] as const;

const GEAR_VARIANT_SUFFIX_RE = /\) ([A-Z])$/;

/** Keep materials and gear `… A` hashes; drop other variant letters from stale inputs. */
export function limitGearVariantHashes(hashes: readonly string[]): string[] {
  const allowed = new Set<string>(GEAR_MARKET_VARIANT_LETTERS);
  return hashes.filter((hash) => {
    const match = hash.match(GEAR_VARIANT_SUFFIX_RE);
    if (!match) return true;
    return allowed.has(match[1]);
  });
}

export function gearMarketHash(
  itemName: string,
  catalogGrade: string,
  variantLetter: (typeof GEAR_MARKET_VARIANT_LETTERS)[number] = "A",
): string {
  return `${itemName} (${gradeTitle(catalogGrade)}) ${variantLetter}`;
}

/** Steam hash for a priceable gear piece (variant A). */
export function gearMarketHashCandidates(itemName: string, catalogGrade: string): string[] {
  return [gearMarketHash(itemName, catalogGrade, "A")];
}

/** Resolve a catalog item to a Steam market_hash_name, or null if not priceable. */
export function marketHashMatch(item: MarketHashItem): MarketHashMatch | null {
  if (!isPriceableItem(item.type, item.grade, item.marketTradable)) return null;
  const baseName = hashBaseName(item);
  if (isPlaceholderItemName(baseName)) return null;

  if (item.type === "MATERIAL") {
    return { name: baseName };
  }

  if (item.type === "GEAR") {
    return { name: gearMarketHash(baseName, item.grade, "A") };
  }

  return null;
}

/** Steam hash names to price (gear: variant A; materials: display name). */
export function marketHashCandidates(item: MarketHashItem): string[] {
  if (!isPriceableItem(item.type, item.grade, item.marketTradable)) return [];
  const baseName = hashBaseName(item);
  if (isPlaceholderItemName(baseName)) return [];
  if (item.type === "MATERIAL") return [baseName];
  if (item.type === "GEAR") return gearMarketHashCandidates(baseName, item.grade);
  return [];
}

export function marketHashName(item: MarketHashItem): string | null {
  return marketHashMatch(item)?.name ?? null;
}
