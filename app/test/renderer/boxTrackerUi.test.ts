import { describe, it, expect } from "vitest";
import {
  boxTrackerSectionOrder,
  groupCatalogByLevel,
  groupEnabledByLevelAndCategory,
  levelGroupTooltip,
} from "../../src/renderer/lib/boxTrackerUi";
import type { BoxTimerCatalogEntry } from "../../shared/types";

describe("boxTrackerSectionOrder", () => {
  it("puts cooldown first by default", () => {
    expect(boxTrackerSectionOrder("cooldown-first")).toEqual(["cooldown", "ready"]);
  });

  it("puts ready first when configured", () => {
    expect(boxTrackerSectionOrder("ready-first")).toEqual(["ready", "cooldown"]);
  });
});

function entry(overrides: Partial<BoxTimerCatalogEntry> & { boxId: number }): BoxTimerCatalogEntry {
  return {
    name: `Box ${overrides.boxId}`,
    level: 1,
    category: "rare",
    idealStageKey: 1101,
    idealStageLabel: "Normal 1-1",
    defaultIdealStageKey: 1101,
    defaultIdealStageLabel: "Normal 1-1",
    idealStageIsCustom: false,
    farmStageOptions: [],
    dropStageRangeLabel: "Normal 1-1",
    cooldownSeconds: 720,
    cooldownIsCustom: false,
    enabled: false,
    notifyWhenReady: true,
    ...overrides,
  };
}

describe("groupCatalogByLevel", () => {
  it("collapses same-level routes (standard + Contaminated variants) into one group", () => {
    const groups = groupCatalogByLevel([
      entry({ boxId: 920901, level: 90, dropStageRangeLabel: "Torment 2-9" }),
      entry({
        boxId: 925201,
        level: 90,
        category: "plagueRare",
        dropStageRangeLabel: "Torment 23-1",
      }),
      entry({
        boxId: 925202,
        level: 90,
        category: "plagueRare",
        dropStageRangeLabel: "Torment 23-2",
      }),
      entry({ boxId: 920801, level: 80, dropStageRangeLabel: "Torment 2-8" }),
    ]);

    expect(groups.map((g) => g.level)).toEqual([80, 90]);
    const lv90 = groups.find((g) => g.level === 90)!;
    expect(lv90.entries.map((e) => e.boxId)).toEqual([920901, 925201, 925202]);
  });

  it("sorts ascending by level and marks a group enabled when any route is enabled", () => {
    const groups = groupCatalogByLevel([
      entry({ boxId: 920901, level: 90 }),
      entry({ boxId: 925201, level: 90, category: "plagueRare", enabled: true }),
      entry({ boxId: 920011, level: 1 }),
    ]);

    expect(groups.map((g) => g.level)).toEqual([1, 90]);
    expect(groups[0].enabled).toBe(false);
    expect(groups[1].enabled).toBe(true);
  });
});

describe("groupEnabledByLevelAndCategory", () => {
  it("only groups enabled routes", () => {
    const groups = groupEnabledByLevelAndCategory([
      entry({ boxId: 920801, level: 80, enabled: true }),
      entry({ boxId: 920901, level: 90, enabled: false }),
    ]);
    expect(groups.map((g) => g.level)).toEqual([80]);
  });

  it("keeps the standard and plague routes of one level in separate rows", () => {
    const groups = groupEnabledByLevelAndCategory([
      entry({ boxId: 920901, level: 90, category: "rare", enabled: true }),
      entry({ boxId: 925201, level: 90, category: "plagueRare", enabled: true }),
      entry({ boxId: 925202, level: 90, category: "plagueRare", enabled: true }),
    ]);

    expect(groups.map((g) => [g.category, g.level])).toEqual([
      ["rare", 90],
      ["plagueRare", 90],
    ]);
    expect(groups[0].entries.map((e) => e.boxId)).toEqual([920901]);
    expect(groups[1].entries.map((e) => e.boxId)).toEqual([925201, 925202]);
  });

  it("orders rows by level, then standard before plague", () => {
    const groups = groupEnabledByLevelAndCategory([
      entry({ boxId: 925101, level: 65, category: "plagueRare", enabled: true }),
      entry({ boxId: 920651, level: 65, category: "rare", enabled: true }),
      entry({ boxId: 920801, level: 80, category: "rare", enabled: true }),
    ]);

    expect(groups.map((g) => [g.level, g.category])).toEqual([
      [65, "rare"],
      [65, "plagueRare"],
      [80, "rare"],
    ]);
  });
});

describe("levelGroupTooltip", () => {
  it("keeps the single-route format", () => {
    const [group] = groupCatalogByLevel([
      entry({
        boxId: 920801,
        level: 80,
        idealStageLabel: "Torment 1-3",
        dropStageRangeLabel: "T1-3 – T2-8",
      }),
    ]);
    expect(levelGroupTooltip(group)).toBe("Torment 1-3 · T1-3 – T2-8");
  });

  it("lists distinct ranges for multi-route levels and caps long lists", () => {
    const groups = groupCatalogByLevel([
      entry({ boxId: 920901, level: 90, dropStageRangeLabel: "Torment 2-9" }),
      entry({ boxId: 925201, level: 90, dropStageRangeLabel: "Torment 23-1" }),
      entry({ boxId: 925202, level: 90, dropStageRangeLabel: "Torment 23-2" }),
      entry({ boxId: 925203, level: 90, dropStageRangeLabel: "Torment 23-3" }),
      entry({ boxId: 925204, level: 90, dropStageRangeLabel: "Torment 23-4" }),
      entry({ boxId: 925205, level: 90, dropStageRangeLabel: "Torment 2-9" }),
    ]);
    expect(levelGroupTooltip(groups[0])).toBe(
      "Torment 2-9 · Torment 23-1 · Torment 23-2 · Torment 23-3 · …",
    );
  });
});
