import { describe, expect, it } from "vitest";
import {
  boxCategoryLabel,
  boxDropViaLabel,
  boxDropViaSummaries,
  boxExpectedValue,
  boxPlagueRule,
  boxPlagueTier,
  boxStageListLabel,
  FIRST_DROP_ONLY_LABEL,
  splitDropStageRangeLines,
  summarizeSpawnPcts,
} from "../../src/core/lookup/boxDisplay";
import { loadLookupSources } from "../../src/core/lookup/catalog";

describe("boxStageListLabel", () => {
  it("combines compact stage key and map name", () => {
    expect(boxStageListLabel(1103, "Wasteland")).toBe("Normal 1-3 - Wasteland");
  });
});

describe("boxCategoryLabel", () => {
  it("labels known box categories", () => {
    expect(boxCategoryLabel("common")).toBe("Common chest");
    expect(boxCategoryLabel("stage_boss")).toBe("Stage boss chest");
    expect(boxCategoryLabel("act_boss")).toBe("Act boss chest");
  });

  it("falls back for unknown category", () => {
    expect(boxCategoryLabel("unknown")).toBe("Chest");
  });
});

describe("boxDropViaLabel", () => {
  it("labels all drop vias", () => {
    expect(boxDropViaLabel("monster_box")).toBe("Monster kill");
    expect(boxDropViaLabel("boss_box")).toBe("Stage boss kill");
    expect(boxDropViaLabel("act_boss")).toBe("Act boss kill");
  });
});

describe("FIRST_DROP_ONLY_LABEL", () => {
  it("uses player-facing copy", () => {
    expect(FIRST_DROP_ONLY_LABEL).toBe("First clear only");
  });
});

describe("splitDropStageRangeLines", () => {
  it("splits bundled range labels into separate lines", () => {
    expect(splitDropStageRangeLines("Normal 1-8 – 1-9 · Normal 2-1 – 2-2")).toEqual([
      "Normal 1-8 – 1-9",
      "Normal 2-1 – 2-2",
    ]);
    expect(splitDropStageRangeLines("Normal 1-1")).toEqual(["Normal 1-1"]);
  });

  it("returns empty for missing or placeholder labels", () => {
    expect(splitDropStageRangeLines("")).toEqual([]);
    expect(splitDropStageRangeLines("—")).toEqual([]);
    expect(splitDropStageRangeLines("   ")).toEqual([]);
  });
});

describe("boxDropViaSummaries", () => {
  it("groups farm stages by via with min/max spawn %", () => {
    expect(
      boxDropViaSummaries([
        { stageKey: 1108, stageName: "A", via: "boss_box", spawnPct: 40 },
        { stageKey: 1109, stageName: "B", via: "boss_box", spawnPct: 40 },
      ]),
    ).toEqual([
      {
        via: "boss_box",
        label: "Stage boss kill",
        minPct: 40,
        maxPct: 40,
      },
    ]);

    expect(
      boxDropViaSummaries([
        { stageKey: 4210, stageName: "A", via: "act_boss", spawnPct: 100 },
        { stageKey: 1108, stageName: "B", via: "boss_box", spawnPct: 40 },
      ]),
    ).toEqual([
      { via: "boss_box", label: "Stage boss kill", minPct: 40, maxPct: 40 },
      { via: "act_boss", label: "Act boss kill", minPct: 100, maxPct: 100 },
    ]);
  });
});

describe("summarizeSpawnPcts", () => {
  it("returns null for empty stage lists", () => {
    expect(summarizeSpawnPcts([])).toBeNull();
  });

  it("summarizes uniform and varying spawn percentages", () => {
    expect(
      summarizeSpawnPcts([
        { stageKey: 1101, stageName: "A", via: "boss_box", spawnPct: 100 },
        { stageKey: 1102, stageName: "B", via: "boss_box", spawnPct: 100 },
      ]),
    ).toEqual({ min: 100, max: 100 });

    expect(
      summarizeSpawnPcts([
        { stageKey: 1104, stageName: "A", via: "boss_box", spawnPct: 100 },
        { stageKey: 1105, stageName: "B", via: "boss_box", spawnPct: 80 },
      ]),
    ).toEqual({ min: 80, max: 100 });
  });
});

describe("lookup box sources", () => {
  it("loads farm spawnPct, act boss stages, and first-drop flags", () => {
    const sources = loadLookupSources();
    const farm = sources.boxes["920101"];
    expect(farm.stages[0]?.spawnPct).toBe(40);
    expect(farm.firstDropOnly).toBe(false);
    expect(splitDropStageRangeLines(farm.dropStageRangeLabel).length).toBeGreaterThan(0);

    const act = sources.boxes["930901"];
    expect(act.stages).toHaveLength(2);
    expect(act.stages.every((s) => s.via === "act_boss" && s.spawnPct === 100)).toBe(true);

    const first = sources.boxes["920001"];
    expect(first.firstDropOnly).toBe(true);
    expect(first.firstDropStages).toEqual([{ stageKey: 1101, stageName: "Pasture" }]);
    expect(first.stages).toHaveLength(0);
    expect(splitDropStageRangeLines(first.dropStageRangeLabel)).toEqual(["Normal 1-1"]);
  });
});

describe("boxPlagueTier", () => {
  it("recognizes plague chests by 9xxx id prefix", () => {
    expect(boxPlagueTier(915001)).toBe("plagueCommon");
    expect(boxPlagueTier(925101)).toBe("plagueRare");
    expect(boxPlagueTier(935201)).toBe("plagueAct");
  });

  it("returns null for non-plague chests", () => {
    expect(boxPlagueTier(910051)).toBeNull();
    expect(boxPlagueTier(920901)).toBeNull();
    expect(boxPlagueTier(930101)).toBeNull();
  });
});

describe("boxExpectedValue", () => {
  const drops = [
    { itemKey: 1001, name: "A", grade: "RARE", dropPct: 40 },
    { itemKey: 1002, name: "B", grade: "COMMON", dropPct: 60 },
  ];

  it("computes probability-weighted sum of priced drops", () => {
    const prices: Record<number, number> = { 1001: 5, 1002: 1 };
    const result = boxExpectedValue(drops, (k) => prices[k] ?? null);
    // (40 × 5 + 60 × 1) / 100 = 2.6
    expect(result).toEqual({
      value: 2.6,
      pricedCount: 2,
      totalCount: 2,
      pricedDropPctSum: 100,
    });
  });

  it("returns null when no drop is priced", () => {
    const result = boxExpectedValue(drops, () => null);
    expect(result.value).toBeNull();
    expect(result.pricedCount).toBe(0);
    expect(result.totalCount).toBe(2);
    expect(result.pricedDropPctSum).toBe(0);
  });

  it("skips unpriced drops and discounts the cover percentage", () => {
    const prices: Record<number, number> = { 1002: 1 };
    const result = boxExpectedValue(drops, (k) => prices[k] ?? null);
    // (60 × 1) / 100 = 0.6
    expect(result.value).toBe(0.6);
    expect(result.pricedCount).toBe(1);
    expect(result.pricedDropPctSum).toBe(60);
  });
});

describe("boxPlagueRule", () => {
  it("derives shared-group rule for common plague chests (multiple monster-drop maps)", () => {
    const stages = Array.from({ length: 5 }, (_, i) => ({
      stageKey: 201201 + i,
      stageName: `NM 21-${i + 1}`,
      via: "monster_box" as const,
      spawnPct: 0.08,
    }));
    expect(boxPlagueRule(915001, stages)).toEqual({
      kind: "shared-group",
      stageCount: 5,
    });
  });

  it("derives unique-stage rule for stage-boss plague chests", () => {
    expect(
      boxPlagueRule(925002, [
        { stageKey: 201202, stageName: "NM 21-2", via: "boss_box", spawnPct: 4 },
      ]),
    ).toEqual({ kind: "unique-stage", stageCount: 1 });
  });

  it("derives unique-act rule for act-boss plague chests", () => {
    expect(
      boxPlagueRule(935001, [
        { stageKey: 201021, stageName: "NM 1-10", via: "act_boss", spawnPct: 100 },
      ]),
    ).toEqual({ kind: "unique-act", stageCount: 1 });
  });

  it("returns null for non-plague chests", () => {
    expect(boxPlagueRule(920901, [])).toBeNull();
    expect(boxPlagueRule(930101, [])).toBeNull();
  });
});
