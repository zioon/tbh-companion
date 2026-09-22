// Web build: bundled-data loader with no filesystem.
//
// Replaces `core/bundledData.ts` via a Vite alias. The desktop version resolves
// a filesystem path and calls `readFileSync`; in a browser the catalog is
// already in memory (installed by `src/web/dataSource.ts` before first render),
// so the path-resolution half is unnecessary — and `node:path`/`node:fs` would
// otherwise be pulled into the bundle.
//
// Keeps the same exports as the module it replaces so every existing call site
// (`loadLocaleCatalog`, `loadLookupItems`, `getTbhMarketFeeRates`, box catalogs)
// works unchanged.

import { getBundledDataTextSource } from "./dataSource";
import type { BundledDataFile } from "./bundledDataTypes";

export const REQUIRED_BUNDLED_DATA_FILES = [
  "gamedata.json",
  "stage_boxes.json",
  "box_types.json",
  "rune_box_cap.json",
  "rune_auto_open.json",
  "rune_wave.json",
  "pets.json",
  "steam_item_nameids.json",
  "steam_market_fee.json",
  "lookup_items.json",
  "lookup_sources.json",
  "synthesis_model.json",
  "offerings.json",
  "_game_locale_dump.json",
] as const;

export const QA_GATE_BUNDLED_DATA_FILES = [
  "gamedata.json",
  "stage_boxes.json",
  "box_types.json",
  "rune_box_cap.json",
  "rune_wave.json",
  "steam_item_nameids.json",
  "steam_market_fee.json",
  "_game_locale_dump.json",
] as const;

export type { BundledDataFile };

/** No filesystem in the browser — provided only so call sites type-check. */
export function bundledDataCandidates(filename: string, userDataDir?: string): string[] {
  void userDataDir;
  return [filename];
}

export function resolveBundledDataPath(filename: string): string {
  return filename;
}

const jsonCache = new Map<string, unknown>();

export function readBundledJson<T>(filename: BundledDataFile | string): T {
  const hit = jsonCache.get(filename);
  if (hit !== undefined) return hit as T;

  const source = getBundledDataTextSource();
  const raw = source?.(filename);
  if (raw == null) {
    throw new Error(
      `Bundled data file not shipped in the web build: ${filename}. ` +
        `Add it to src/web/dataSource.ts if a browser feature needs it.`,
    );
  }

  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  jsonCache.set(filename, parsed);
  return parsed;
}

/** Drop cached reads — call after swapping catalogs (unused on the web build). */
export function clearBundledJsonCache(): void {
  jsonCache.clear();
}
