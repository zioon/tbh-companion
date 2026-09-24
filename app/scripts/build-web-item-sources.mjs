// Build the web-only item/stage-source payload from the full lookup_sources.json.
//
// `lookup_sources.json` is 10.8 MB and is deliberately NOT shipped to the
// browser (docs/business-flows/13-web-inspector.md §25.4). The Lookup tab's
// item detail needs the `items` + `stages` subtrees; the `boxes` subtree is
// already covered by `box-sources.json` and is dropped here.
//
// Slimming (names/grades are rehydrated from the bundled `lookup_items.json`
// and the box-sources payload at runtime, see `src/web/itemSourcesSnapshot.ts`):
//   * drops     → `[via, boxItemKey, dropPct, grade]` (the drop's own grade is
//                 kept — it is NOT reliably the catalog entry's grade)
//   * materials → `[itemKey, amount]` (name comes from the bundled catalog)
//   * outputs   → `[itemKey, poolPct]`
// `crafting` / `usedIn` / `extras` keep their shape otherwise. `extras` holds
// the labels of the rare item keys that are not in the bundled catalog at all,
// so no row loses its name.
//
// Output: `dist-web/data/item-sources.json` — ~1.9 MB raw / ~75 KB gzipped,
// fetched lazily by the Lookup tab (one cached request, not inlined into the
// JS bundle).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const sources = JSON.parse(readFileSync(resolve(root, "data/lookup_sources.json"), "utf8"));
const catalog = JSON.parse(readFileSync(resolve(root, "data/lookup_items.json"), "utf8"));
const catalogItems = catalog.items ?? catalog;
const catalogIds = new Set(catalogItems.map((item) => item.id));
const outPath = resolve(root, "dist-web/data/item-sources.json");

const items = sources.items ?? {};
const stages = sources.stages ?? {};
const extras = {};
const out = {};

for (const [id, item] of Object.entries(items)) {
  // Drops: `[via, boxItemKey, dropPct, grade]`. A drop entry is keyed by the
  // receiving item and only references its source box; the box *name* is
  // rehydrated from the box-sources payload at runtime (same build chain, so
  // the pairing is lossless). The drop's own grade is kept — it is not
  // reliably the catalog entry's grade.
  const drops = (item.drops ?? []).map((drop) => [
    drop.via,
    drop.boxItemKey,
    drop.dropPct,
    drop.grade ?? null,
  ]);

  // Crafting: materials reduced to `[itemKey, amount]` pairs.
  const crafting = (item.crafting ?? []).map((recipe) => ({
    recipeKey: recipe.recipeKey,
    tier: recipe.tier,
    craftingType: recipe.craftingType,
    level: recipe.level,
    outputPct: recipe.outputPct,
    m: (recipe.materials ?? []).map((mat) => {
      if (!catalogIds.has(mat.itemKey)) extras[mat.itemKey] = { name: mat.name, grade: null };
      return [mat.itemKey, mat.amount];
    }),
  }));

  // Used-in: materials and outputs reduced the same way.
  const usedIn = (item.usedIn ?? []).map((recipe) => ({
    recipeKey: recipe.recipeKey,
    craftingType: recipe.craftingType,
    tier: recipe.tier,
    level: recipe.level,
    m: (recipe.materials ?? []).map((mat) => {
      if (!catalogIds.has(mat.itemKey)) extras[mat.itemKey] = { name: mat.name, grade: null };
      return [mat.itemKey, mat.amount];
    }),
    outputs: (recipe.outputs ?? []).map((output) => [output.itemKey, output.poolPct]),
  }));

  out[id] = { drops, crafting, usedIn };
}

const payload = { schemaVersion: 1, items: out, stages, extras };
const json = JSON.stringify(payload);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, json);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `item-sources: ${Object.keys(out).length} items, ${Object.keys(stages).length} stages, ` +
    `${Object.keys(extras).length} uncatalogued labels -> ${outPath} (${kb(json.length)})`,
);
