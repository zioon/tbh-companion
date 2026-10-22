import { describe, expect, it } from "vitest";
import { loadSynthesisModel } from "../../src/core/lookup/catalog";
import {
  gradeRoll,
  pathsToItem,
  simulate,
  formatSynthesisPathSetup,
  formatSynthesisResultRange,
  formatMaterialAverageLevelRange,
  materialAverageLevelRange,
  recipeTierResultRange,
  synthesisTypeForItem,
} from "../../src/core/lookup/synthesis";

const AMBER_RING = {
  id: 623071,
  name: "Amber Ring",
  grade: "LEGENDARY",
  type: "GEAR" as const,
  gearType: "RING",
  gearGroup: "ACCESSORY",
  materialType: null,
  level: 30,
  iconPath: "RING_620007",
  marketTradable: true,
};

/**
 * v1.3.0 relic family. `ItemInfoData.Level` is EMPTY for these rows (they
 * are not level-scaled gear) — the synthesis result level comes from the
 * model's single bucket level instead.
 */
const CRIMSON_RELIC = {
  id: 715001,
  name: "Crimson Relic - Blade",
  grade: "ARCANA",
  type: "GEAR" as const,
  gearType: "RELIC_RED",
  gearGroup: "RELIC",
  materialType: null,
  level: null,
  iconPath: "relic-710001",
  marketTradable: false,
};

const RELIQUARY = {
  id: 795001,
  name: "Relentless Reliquary",
  grade: "ARCANA",
  type: "GEAR" as const,
  gearType: "RELIQUARY",
  gearGroup: "RELIQUARY",
  materialType: null,
  level: null,
  iconPath: "reliquary-790001",
  marketTradable: false,
};

describe("synthesis engine", () => {
  const model = loadSynthesisModel();

  it("gradeRoll matches reference values for Amber Ring inputs", () => {
    const rareUp = gradeRoll("RARE", model).find((r) => r.step === 1);
    const uncSkip = gradeRoll("UNCOMMON", model).find((r) => r.step === 2);
    expect(rareUp?.pct).toBe(97.56);
    expect(uncSkip?.pct).toBe(3.85);
  });

  it("pathsToItem lists tier-labeled Amber Ring paths with ascending level weights", () => {
    const paths = pathsToItem(AMBER_RING, model);
    expect(paths[0]).toMatchObject({
      inputGrade: "RARE",
      tier: 4,
      minMaterialTier: 3,
      materialAvgLevel: 30,
      resultLevelMin: 30,
      resultLevelMax: 40,
      chance: 20.19,
      pLevel: 75,
      itemPoolPct: 27.5862,
    });
    expect(paths).toContainEqual(
      expect.objectContaining({
        inputGrade: "RARE",
        tier: 3,
        minMaterialTier: 2,
        materialAvgLevel: 25,
        chance: 13.46,
      }),
    );
    const keys = paths.map(
      (p) => `${p.inputGrade}|${p.tier}|${p.minMaterialTier}|${p.materialAvgLevel}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("recipeTierResultRange and material average bands use fixed ranges only", () => {
    expect(formatSynthesisResultRange(20, 40)).toBe("Lv 20~40");
    const t4 = recipeTierResultRange(model, "Accessory", 4);
    expect(t4).toEqual({ min: 20, max: 40 });

    const paths = pathsToItem(AMBER_RING, model);
    const bestPath = paths[0]!;
    expect(materialAverageLevelRange(bestPath)).toEqual({ min: 30, max: 34 });
    expect(formatSynthesisPathSetup(bestPath, t4!, { min: 30, max: 34 })).toBe(
      "Tier 4 (Lv 20~40) · Average item Lv 30-34",
    );

    const highAvgPath = paths.find((p) => p.materialAvgLevel === 35)!;
    expect(materialAverageLevelRange(highAvgPath)).toEqual({ min: 35, max: 40 });
    expect(highAvgPath.chance).toBeLessThan(bestPath.chance);

    const tier3Path = paths.find((p) => p.tier === 3 && p.materialAvgLevel === 25)!;
    expect(materialAverageLevelRange(tier3Path)).toEqual({ min: 25, max: 30 });

    for (const path of paths) {
      expect(formatMaterialAverageLevelRange(materialAverageLevelRange(path))).not.toMatch(/\+/);
    }
  });

  it("simulate returns a distribution for a concrete recipe row", () => {
    const outcomes = simulate("RARE", 4, 30, 3, "Accessory", model);
    expect(outcomes.length).toBeGreaterThan(0);
    const amber = outcomes.find((o) => o.itemKey === AMBER_RING.id && o.level === 30);
    expect(amber?.chance).toBe(20.18);
  });
});

describe("synthesis engine — v1.3.0 relic family", () => {
  const model = loadSynthesisModel();

  it("maps the relic gear groups to their own synthesis chains", () => {
    expect(synthesisTypeForItem(CRIMSON_RELIC)).toBe("RELIC");
    expect(synthesisTypeForItem(RELIQUARY)).toBe("RELIQUARY");
    // Unchanged for the pre-1.3.0 families.
    expect(synthesisTypeForItem(AMBER_RING)).toBe("Accessory");
    expect(synthesisTypeForItem({ type: "GEAR", gearGroup: "WEAPON" })).toBe("Gear");
    expect(synthesisTypeForItem({ type: "MATERIAL", gearGroup: null })).toBeNull();
  });

  it("resolves a relic synthesis path despite the item having no level", () => {
    const paths = pathsToItem(CRIMSON_RELIC, model);
    expect(paths.length).toBeGreaterThan(0);
    // The result level comes from the model's single RELIC bucket level.
    expect(paths[0]!.itemLevel).toBe(1);
    expect(paths[0]!.resultLevelMin).toBe(1);
    expect(paths[0]!.resultLevelMax).toBe(1);
    expect(paths[0]!.chance).toBeGreaterThan(0);
  });

  it("resolves a reliquary synthesis path", () => {
    const paths = pathsToItem(RELIQUARY, model);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]!.itemLevel).toBe(1);
  });

  it("still returns no path for a material", () => {
    expect(
      pathsToItem(
        { id: 110001, grade: "COMMON", level: null, type: "MATERIAL", gearGroup: null },
        model,
      ),
    ).toEqual([]);
  });
});
