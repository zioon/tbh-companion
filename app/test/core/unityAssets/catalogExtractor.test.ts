// app/test/core/unityAssets/catalogExtractor.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractCatalog,
  CATALOG_SCHEMA_VERSION,
} from "../../../src/core/unityAssets/catalogExtractor";

const FX = join(__dirname, "fixtures");

describe("extractCatalog", () => {
  it("extracts the full catalog from real game files", () => {
    const result = extractCatalog({
      sharedassets0: readFileSync(join(FX, "sharedassets0.assets")),
      sharedBundle: readFileSync(join(FX, "shared_assets.bundle")),
      enBundle: readFileSync(join(FX, "en_stringtable.bundle")),
    });
    expect(result.gameVersion).toBe("1.00.28");
    expect(result.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    // The fixture CSV (game v1.3.0) keeps 4364 server-deleted rows
    // (IsDeletedInServer=True, including every Lv85 gear) — they must be
    // filtered out of the catalog.
    expect(result.stats.skipped).toBe(4364);
    expect(result.items.length).toBeGreaterThan(1500);
    expect(result.stats.resolvedNames).toBeGreaterThan(500);

    const byId = new Map(result.items.map((it) => [it.id, it]));
    expect(byId.get(110001)?.name).toBe("Minor Ruby");
    expect(byId.get(120001)?.name).toBe("Goblin Hide");
    expect(byId.get(530017)?.name).toBe("Dimensional Boots");
    expect(byId.get(628111)?.name).toBe("Emerald Ring");
    expect(byId.get(910011)?.name).toBe("Normal Monster Box 1");
    // v1.3.0 Halloween event boxes.
    expect(byId.get(940001)?.name).toBe("Halloween Normal Box (Nightmare)");
    expect(byId.get(941001)?.name).toBe("Halloween Stage Box (Nightmare)");

    // Server-deleted rows never re-enter via the NameKey-only fallback: 300018
    // (Lv85 Shadow Blade) is deleted in the CSV AND has an ItemName_* key in
    // the locale table, so it must not come back as an empty-type row.
    expect(byId.get(300018)).toBeUndefined();

    // NameKey-only entries: 620017 is in localization bundle but not in CSV.
    expect(byId.get(620017)?.name).toBe("Ethereal Ring");
  });

  it("throws a clear error when ItemInfoData is missing", () => {
    expect(() =>
      extractCatalog({
        sharedassets0: Buffer.alloc(0),
        sharedBundle: readFileSync(join(FX, "shared_assets.bundle")),
        enBundle: readFileSync(join(FX, "en_stringtable.bundle")),
      }),
    ).toThrow(/ItemInfoData/);
  });
});
