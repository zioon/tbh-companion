// Build the web-only chest-source payload from the full lookup_sources.json.
//
// `lookup_sources.json` is 10.8 MB and is deliberately NOT shipped to the
// browser (docs/business-flows/13-web-inspector.md §25.4). The Chests page's
// detail view only needs the `boxes` subtree, and even that is 2.6 MB — almost
// all of it the per-drop `name`/`grade` strings that duplicate the bundled
// `lookup_items.json`.
//
// This emits the box graph with each drop reduced to `[itemKey, dropPct]`
// (the web rehydrates the name/grade from the bundled catalog) plus an `extras`
// map for the handful of item keys that are not in the catalog at all, so no
// row loses its label.
//
// Output: `dist-web/data/box-sources.json` — ~590 KB raw / ~76 KB gzipped,
// fetched lazily by the Chests page (one cached request, not inlined into the
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
const outPath = resolve(root, "dist-web/data/box-sources.json");

const boxes = sources.boxes ?? {};
const extras = {};
const out = {};

for (const [id, box] of Object.entries(boxes)) {
  out[id] = {
    name: box.name,
    grade: box.grade ?? null,
    category: box.category,
    drops: (box.drops ?? []).map((drop) => {
      if (!catalogIds.has(drop.itemKey)) {
        // Removed / uncatalogued item: keep its label so the row still reads.
        extras[drop.itemKey] = { name: drop.name, grade: drop.grade };
      }
      return [drop.itemKey, drop.dropPct];
    }),
    stages: box.stages ?? [],
    dropStageRangeLabel: box.dropStageRangeLabel ?? "",
    firstDropOnly: box.firstDropOnly === true,
    firstDropStages: box.firstDropStages ?? [],
  };
}

const payload = { schemaVersion: 1, boxes: out, extras };
const json = JSON.stringify(payload);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, json);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `box-sources: ${Object.keys(out).length} boxes, ` +
    `${Object.keys(extras).length} uncatalogued drops -> ${outPath} (${kb(json.length)})`,
);
