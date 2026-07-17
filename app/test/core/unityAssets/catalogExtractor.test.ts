// app/test/core/unityAssets/catalogExtractor.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCatalog } from "../../../src/core/unityAssets/catalogExtractor";

const FX = join(__dirname, "fixtures");

describe("extractCatalog", () => {
  it("extracts the full catalog from real game files", () => {
    const result = extractCatalog({
      sharedassets0: readFileSync(join(FX, "sharedassets0.assets")),
      sharedBundle: readFileSync(join(FX, "shared_assets.bundle")),
      enBundle: readFileSync(join(FX, "en_stringtable.bundle")),
    });
    expect(result.gameVersion).toBe("1.00.28");
    expect(result.items.length).toBeGreaterThan(5000);
    expect(result.stats.resolvedNames).toBeGreaterThan(500);

    const byId = new Map(result.items.map((it) => [it.id, it]));
    expect(byId.get(110001)?.name).toBe("Minor Ruby");
    expect(byId.get(120001)?.name).toBe("Goblin Hide");
    expect(byId.get(530017)?.name).toBe("Dimensional Boots");
    expect(byId.get(628111)?.name).toBe("Emerald Ring");
    expect(byId.get(910011)?.name).toBe("Normal Monster Box 1");

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
