// Shared bundled-data type, split out so the node and web implementations of
// `bundledData` can both import it without duplicating the union — and without
// the web build pulling in the node implementation's `node:fs` import.

/** JSON shipped via electron-builder extraResources → resources/data/. */
export type BundledDataFile =
  | "gamedata.json"
  | "stage_boxes.json"
  | "box_types.json"
  | "rune_box_cap.json"
  | "rune_auto_open.json"
  | "rune_wave.json"
  | "pets.json"
  | "steam_item_nameids.json"
  | "steam_market_fee.json"
  | "lookup_items.json"
  | "lookup_sources.json"
  | "synthesis_model.json"
  | "offerings.json"
  | "_game_locale_dump.json";
