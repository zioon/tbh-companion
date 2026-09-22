// Web build: bundled catalog JSON shipped as Vite assets.
//
// On desktop these files are read from disk at runtime (`core/bundledData`),
// with `lookup_sources.json` (10 MB) and `_game_locale_dump.json` (3 MB) only
// consulted by features the web build does not offer (catalog refresh, loot
// sources). The web target fetches only what the inventory analyzer needs and
// installs it into the core data source synchronously.
//
// Vite resolves each `?raw` import to a string literal at build time, so this
// module pulls the JSON into the bundle exactly once and the core loader sees
// no filesystem at all.

import type { BundledDataTextSource } from "../core/dataSource";
import { setBundledDataTextSource } from "../core/dataSource";

import gamedata from "../../../data/gamedata.json?raw";
import stageBoxes from "../../../data/stage_boxes.json?raw";
import boxTypes from "../../../data/box_types.json?raw";
import steamMarketFee from "../../../data/steam_market_fee.json?raw";
import lookupItems from "../../../data/lookup_items.json?raw";
import localeEn from "../../../data/locale_strings_en.json?raw";
import localeZhCN from "../../../data/locale_strings_zh-CN.json?raw";
import localeJa from "../../../data/locale_strings_ja.json?raw";
import localeKo from "../../../data/locale_strings_ko.json?raw";

const FILES: Record<string, string> = {
  "gamedata.json": gamedata,
  "stage_boxes.json": stageBoxes,
  "box_types.json": boxTypes,
  "steam_market_fee.json": steamMarketFee,
  "lookup_items.json": lookupItems,
  "locale_strings_en.json": localeEn,
  "locale_strings_zh-CN.json": localeZhCN,
  "locale_strings_ja.json": localeJa,
  "locale_strings_ko.json": localeKo,
};

/** Files the web bundle does not ship — requested names are logged so a missing
 *  catalog entry surfaces as a diagnosable warning instead of a silent
 *  `Bundled data file not found` stack trace mid-render. */
const OMITTED = new Set([
  "lookup_sources.json",
  "_game_locale_dump.json",
  "synthesis_model.json",
  "offerings.json",
  "rune_box_cap.json",
  "rune_auto_open.json",
  "rune_wave.json",
  "pets.json",
  "steam_item_nameids.json",
  "level_curve.json",
]);

const source: BundledDataTextSource = (filename) => {
  const hit = FILES[filename];
  if (hit != null) return hit;
  if (!OMITTED.has(filename)) {
    console.warn(`[web] bundled data not shipped: ${filename}`);
  }
  return null;
};

let installed = false;

/** Install the in-memory source. Safe to call more than once. */
export function installWebDataSource(): void {
  if (installed) return;
  setBundledDataTextSource(source);
  installed = true;
}

/** Filenames the web bundle can serve, for diagnostics/tests. */
export const WEB_DATA_FILES = Object.keys(FILES);
