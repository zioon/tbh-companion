import { describe, it, expect } from "vitest";
import {
  backfillOpensFromLog,
  BACKFILL_WINDOW_SEC,
  type BackfillBoxRoutes,
  type BackfillChestEvent,
  type BackfillTrackerEntry,
} from "../../src/core/boxOpenBackfill";
import type { RecordLogEntry } from "../../shared/types";

/** Build an acquire ring line with sensible defaults. */
function line(over: Partial<RecordLogEntry> & { wallTime: number }): RecordLogEntry {
  return {
    seq: over.ringSeq ?? Math.round(over.wallTime),
    kind: "acquire",
    acquireRaw: `获得了${over.acquireName ?? "物品"}。`,
    ...over,
  } as RecordLogEntry;
}

/** Build the game's stage-clear ring line ("通关了关卡 3-10。(4秒)"). */
function clearLine(
  wallTime: number,
  label: string,
  over: Partial<RecordLogEntry> = {},
): RecordLogEntry {
  return {
    seq: Math.round(wallTime * 1000),
    kind: "acquire",
    acquireRaw: `通关了关卡 ${label}。(4秒)`,
    acquireName: `关卡 ${label}`,
    wallTime,
    ...over,
  } as RecordLogEntry;
}

/** Build a tracker history entry. */
function tracked(
  wallTime: number,
  itemName: string,
  boxKey = "common:90",
  count = 1,
): BackfillTrackerEntry {
  return { wallTime, boxKey, itemName, grade: "COMMON", count };
}

describe("backfillOpensFromLog", () => {
  it("returns nothing for an empty log", () => {
    const r = backfillOpensFromLog([], []);
    expect(r.candidates).toEqual([]);
    expect(r.scanned).toBe(0);
  });

  it("reports a log grant the tracker never recorded", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 7, wallTime: 1000, acquireName: "永恒之剑" })],
      [],
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      ringSeq: 7,
      itemName: "永恒之剑",
      count: 1,
    });
    // No box evidence → unclassified, never an invented level.
    expect(r.candidates[0]!.boxKey).toBe("unclassified");
    expect(r.unattributed).toBe(1);
  });

  it("treats a name+time match as already tracked (no duplicate)", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "永恒之剑" })],
      [tracked(1000.05, "永恒之剑")],
    );
    expect(r.candidates).toEqual([]);
    expect(r.alreadyTracked).toBe(1);
  });

  it("only matches within the attribution window", () => {
    const inside = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "永恒之剑" })],
      [tracked(1000 + BACKFILL_WINDOW_SEC - 0.1, "永恒之剑")],
    );
    expect(inside.alreadyTracked).toBe(1);

    const outside = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000, acquireName: "永恒之剑" })],
      [tracked(1000 + BACKFILL_WINDOW_SEC + 5, "永恒之剑")],
    );
    expect(outside.alreadyTracked).toBe(0);
    expect(outside.candidates).toHaveLength(1);
  });

  it("is count-aware: one entry of N covers a ×N line, and N lines exhaust it", () => {
    const burst = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "银锭", acquireCount: 3 })],
      [tracked(1000, "银锭", "common:90", 3)],
    );
    expect(burst.alreadyTracked).toBe(1);
    expect(burst.candidates).toEqual([]);

    // Two lines consume two of the three units.
    const twoLines = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000, acquireName: "银锭" }),
        line({ ringSeq: 2, wallTime: 1000.2, acquireName: "银锭" }),
      ],
      [tracked(1000, "银锭", "common:90", 2)],
    );
    expect(twoLines.alreadyTracked).toBe(2);
    expect(twoLines.candidates).toEqual([]);

    // A third line finds the count exhausted → it becomes a candidate.
    const exhausted = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000, acquireName: "银锭" }),
        line({ ringSeq: 2, wallTime: 1000.2, acquireName: "银锭" }),
        line({ ringSeq: 3, wallTime: 1000.4, acquireName: "银锭" }),
      ],
      [tracked(1000, "银锭", "common:90", 2)],
    );
    expect(exhausted.alreadyTracked).toBe(2);
    expect(exhausted.candidates).toHaveLength(1);
    expect(exhausted.candidates[0]!.ringSeq).toBe(3);
  });

  it("borrows the boxKey from a surviving sibling of the same burst", () => {
    // The tracker lost one of three items from a rare:90 burst; the two it
    // kept are the evidence for the third.
    const r = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000.0, acquireName: "紫水晶" }),
        line({ ringSeq: 2, wallTime: 1000.1, acquireName: "蘑菇孢子" }),
        line({ ringSeq: 3, wallTime: 1000.2, acquireName: "次元头盔" }),
      ],
      [tracked(1000.0, "紫水晶", "rare:90"), tracked(1000.1, "蘑菇孢子", "rare:90")],
    );
    expect(r.alreadyTracked).toBe(2);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ ringSeq: 3, boxKey: "rare:90" });
    // Attributed, not unattributed.
    expect(r.unattributed).toBe(0);
  });

  it("prefers a name match over a nearer sibling entry", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "紫水晶" })],
      [tracked(1000.5, "次元头盔", "rare:90"), tracked(1000.9, "紫水晶", "act:12")],
    );
    // Name match wins even though the sibling is closer in time.
    expect(r.alreadyTracked).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  it("falls back to the nearest GetBox drop category when no open evidence exists", () => {
    const chests: BackfillChestEvent[] = [{ wallTime: 1000.1, category: "rare" }];
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "未知物" })],
      [],
      chests,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.boxKey).toBe("rare");
    expect(r.unattributed).toBe(0);
  });

  it("never mistakes the chest drop notice for its contents", () => {
    const r = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000, acquireName: "普通宝箱" }),
        line({ ringSeq: 2, wallTime: 1001, acquireName: "关卡宝箱" }),
        line({ ringSeq: 3, wallTime: 1002, acquireName: "章节首领宝箱" }),
      ],
      [],
      [{ wallTime: 1000, category: "common" }],
    );
    expect(r.candidates).toEqual([]);
    expect(r.excluded).toBe(3);
  });

  it("excludes clears, non-grants and bulk replays, but not materials", () => {
    const r = backfillOpensFromLog(
      [
        line({
          ringSeq: 1,
          wallTime: 1000,
          acquireName: "关卡 3-9",
          acquireRaw: "通关了关卡 3-9。(72秒)",
        }),
        line({
          ringSeq: 2,
          wallTime: 1001,
          acquireName: "牧师",
          acquireRaw: "牧师被击败了。(木乃伊)",
        }),
        // A genuine grant replayed in the initial bulk batch: its wallTime is
        // the ingest moment, so it must never be time-matched.
        line({ ringSeq: 3, wallTime: 1002, acquireName: "永恒之剑", bulk: true }),
        line({ ringSeq: 4, wallTime: 1003, acquireName: "普通宝箱" }),
      ],
      [],
    );
    expect(r.candidates).toEqual([]);
    expect(r.excluded).toBe(4);
  });

  it("keeps materials as candidates rather than dropping them by name", () => {
    // A blanket material name-list previously dropped these — but the same
    // suffix appears on real chest loot, so the list caused silent data loss
    // (the very bug this feature fixes). They are kept unclassified instead.
    const r = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000, acquireName: "铁锭" }),
        line({ ringSeq: 2, wallTime: 1001, acquireName: "永恒之剑" }),
      ],
      [],
    );
    expect(r.candidates.map((c) => c.itemName)).toEqual(["铁锭", "永恒之剑"]);
    expect(r.excluded).toBe(0);
  });

  it("is idempotent: recording the candidates yields none on a re-run", () => {
    const log = [
      line({ ringSeq: 1, wallTime: 1000.0, acquireName: "紫水晶" }),
      line({ ringSeq: 2, wallTime: 1000.1, acquireName: "蘑菇孢子" }),
    ];
    const first = backfillOpensFromLog(log, [tracked(1000.0, "紫水晶", "rare:90")]);
    expect(first.candidates).toHaveLength(1);

    // Simulate the caller recording the candidate, then re-run.
    const after = [tracked(1000.0, "紫水晶", "rare:90"), tracked(1000.1, "蘑菇孢子", "rare:90")];
    const second = backfillOpensFromLog(log, after);
    expect(second.candidates).toEqual([]);
    expect(second.alreadyTracked).toBe(2);
  });

  it("does not invent a box when the only evidence is outside the window", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "未知物" })],
      [tracked(1000 + BACKFILL_WINDOW_SEC + 60, "同类物", "rare:90")],
      [{ wallTime: 1000 + BACKFILL_WINDOW_SEC + 60, category: "rare" }],
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.boxKey).toBe("unclassified");
    expect(r.unattributed).toBe(1);
  });

  it("drops unattributed grants when allowUnclassified is false", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "未知物" })],
      [],
      [],
      { allowUnclassified: false },
    );
    expect(r.candidates).toEqual([]);
    expect(r.unattributed).toBe(1);
  });

  it("can be restricted to name-only matching via attributeFromOpenEntries false", () => {
    const r = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000.0, acquireName: "紫水晶" }),
        line({ ringSeq: 2, wallTime: 1000.1, acquireName: "蘑菇孢子" }),
      ],
      [tracked(1000.0, "紫水晶", "rare:90")],
      [],
      { attributeFromOpenEntries: false, allowUnclassified: true },
    );
    // The sibling entry is not used as box evidence → unclassified.
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.boxKey).toBe("unclassified");
  });

  it("carries the log line's quality colour through for grade fallback", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000, acquireName: "永恒之剑", acquireColor: "#519FFF" })],
      [],
    );
    expect(r.candidates[0]!.color).toBe("#519FFF");
  });

  it("reports diagnostics counts consistently", () => {
    const r = backfillOpensFromLog(
      [
        line({ ringSeq: 1, wallTime: 1000, acquireName: "已记录品" }),
        line({ ringSeq: 2, wallTime: 1001, acquireName: "漏记品" }),
        line({ ringSeq: 3, wallTime: 1002, acquireName: "普通宝箱" }),
      ],
      [tracked(1000, "已记录品")],
      [],
    );
    expect(r.scanned).toBe(2); // the grant lines only
    expect(r.alreadyTracked).toBe(1);
    expect(r.excluded).toBe(1); // the chest notice
    expect(r.candidates).toHaveLength(1);
  });
});

describe("backfillOpensFromLog level inference from stage clears", () => {
  /**
   * Real route shapes from the bundled catalog (`data/stage_boxes.json`):
   *  - COMMON/RARE share the same stage ranges but differ at low levels.
   *  - ACT boss boxes drop on their act's boss stage only (1 stage per level).
   * Plague variants have no routes at all.
   *
   * Note the stage encoding: act 3 stage 5 is 3205, and stage 10 is 3210 —
   * which is the ACT boss stage for act 3, NOT a stage-boss (rare) stage.
   */
  const ROUTES: BackfillBoxRoutes = {
    byCategory: new Map([
      [
        "common",
        [
          {
            level: 65,
            dropStageKeys: [3205, 3206, 3207, 3208, 3209, 3301, 3302, 3303, 3304, 3305],
          },
          { level: 90, dropStageKeys: [4209, 4301, 4302] },
        ],
      ],
      [
        "rare",
        [
          {
            level: 65,
            dropStageKeys: [3205, 3206, 3207, 3208, 3209, 3301, 3302, 3303, 3304, 3305],
          },
          { level: 90, dropStageKeys: [4209, 4301, 4302] },
        ],
      ],
      [
        "act",
        [
          { level: 65, dropStageKeys: [3210] },
          { level: 90, dropStageKeys: [4210, 4310] },
        ],
      ],
    ]),
  };

  it("levels a category-only sibling using the nearest clear line's stage", () => {
    // The tracker kept one sibling but could only resolve its category; the
    // clear records bracket the burst, so the level is recoverable exactly.
    const r = backfillOpensFromLog(
      [
        clearLine(1000.0, "3-5"),
        line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" }),
        clearLine(1000.4, "4-1"),
      ],
      [tracked(1000.1, "幸存品", "rare")],
      [],
      { clears: [{ wallTime: 1000.0, stageKey: 3205 }], boxRoutes: ROUTES },
    );
    expect(r.candidates).toHaveLength(1);
    // The live clear history is preferred: 3205 resolves to rare Lv65.
    expect(r.candidates[0]!.boxKey).toBe("rare:65");
    expect(r.unattributed).toBe(0);
  });

  it("levels a chest-drop category with no open evidence at all", () => {
    const chests: BackfillChestEvent[] = [{ wallTime: 1000.1, category: "common" }];
    const r = backfillOpensFromLog(
      [line({ ringSeq: 1, wallTime: 1000.2, acquireName: "漏记品" })],
      [tracked(900, "别的箱子", "rare:65")],
      chests,
      { clears: [{ wallTime: 1000.0, stageKey: 4209 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("common:90");
  });

  it("reads the level from the clear LINES when the clear history is empty", () => {
    // The history is bounded (200 entries) and in-memory only, so after a
    // restart the ring's own clear lines are the surviving evidence. Their
    // "act-stage" label needs the difficulty borrowed from a resolved clear.
    const r = backfillOpensFromLog(
      [clearLine(1000.0, "3-5"), line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      // Reference clear is far outside the window: only its difficulty (3) is
      // borrowed, the ring line supplies the act/stage.
      { clears: [{ wallTime: 900, stageKey: 3205 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("common:65"); // 3205 → Lv65
  });

  it("resolves the plague 6-digit stage encoding", () => {
    // Plague acts (21-24) reuse `difficulty * 100 + act` for the region base.
    const regionBase = 2012; // Nightmare act 21
    const r = backfillOpensFromLog(
      [clearLine(1000.0, "21-1"), line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      { clears: [{ wallTime: 900, stageKey: regionBase * 100 + 1 }], boxRoutes: ROUTES },
    );
    // 201201 — no common route claims it, so the attribution stays category-only.
    expect(r.candidates[0]!.boxKey).toBe("common");
  });

  it("never touches a sibling boxKey that already carries a level", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [tracked(1000.1, "幸存品", "rare:65")],
      [{ wallTime: 1000.2, category: "common" }],
      { clears: [{ wallTime: 1000.0, stageKey: 4209 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("rare:65");
  });

  it("leaves the attribution category-only when no clear evidence is in the window", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      {
        clears: [{ wallTime: 1000 - BACKFILL_WINDOW_SEC - 60, stageKey: 4209 }],
        boxRoutes: ROUTES,
      },
    );
    expect(r.candidates[0]!.boxKey).toBe("common");
  });

  it("leaves the attribution category-only when no route claims the stage", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      // Stage 1102 is not in this trimmed route table.
      { clears: [{ wallTime: 1000.0, stageKey: 1102 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("common");
  });

  it("keeps plague categories category-only (they have no routes)", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [{ wallTime: 1000.2, category: "plagueCommon" }],
      { clears: [{ wallTime: 1000.0, stageKey: 4209 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("plagueCommon");
  });

  it("still falls to unclassified when there is neither chest nor clear evidence", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [],
      { clears: [{ wallTime: 1000.0, stageKey: 4209 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("unclassified");
    expect(r.unattributed).toBe(1);
  });

  it("ignores a bulk-replayed clear line when collecting level evidence", () => {
    // A bulk line's wallTime is the ingest moment, so it must never be treated
    // as a real clear near the grant.
    const r = backfillOpensFromLog(
      [
        clearLine(999.0, "4-1", { bulk: true }),
        line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" }),
      ],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      { clears: [], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("common");
  });

  it("is idempotent when the recorded candidate carries a level", () => {
    const log = [
      clearLine(1000.0, "3-5"),
      line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" }),
    ];
    const first = backfillOpensFromLog(log, [], [{ wallTime: 1000.2, category: "common" }], {
      clears: [{ wallTime: 1000.0, stageKey: 3205 }],
      boxRoutes: ROUTES,
    });
    expect(first.candidates[0]!.boxKey).toBe("common:65");

    // Simulate the caller recording it under the name from the log line, then
    // re-run: the name+time match must claim it and yield nothing.
    const after = [tracked(1000.2, "漏记品", "common:65")];
    const second = backfillOpensFromLog(log, after, [{ wallTime: 1000.2, category: "common" }], {
      clears: [{ wallTime: 1000.0, stageKey: 3205 }],
      boxRoutes: ROUTES,
    });
    expect(second.candidates).toEqual([]);
    expect(second.alreadyTracked).toBe(1);
  });

  it("does not level without boxRoutes (previous behaviour preserved)", () => {
    const r = backfillOpensFromLog(
      [line({ ringSeq: 2, wallTime: 1000.2, acquireName: "漏记品" })],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      { clears: [{ wallTime: 1000.0, stageKey: 4209 }] },
    );
    expect(r.candidates[0]!.boxKey).toBe("common");
  });

  it("counts clear lines as excluded, not as grants", () => {
    const r = backfillOpensFromLog(
      [clearLine(1000.0, "3-10"), line({ ringSeq: 2, wallTime: 1001, acquireName: "正常品" })],
      [tracked(1001, "正常品")],
      [],
      { clears: [], boxRoutes: ROUTES },
    );
    expect(r.scanned).toBe(1);
    expect(r.alreadyTracked).toBe(1);
    expect(r.excluded).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  it("takes the nearest clear line when several are inside the window", () => {
    // The label is "act-stage": "3-5" is act 3 stage 5 → 3305 (a Lv65
    // stage-boss stage). It sits 0.1s from the grant while "1-1" (1101, which
    // this trimmed table gives no route) sits 6s away — the nearer wins.
    const r = backfillOpensFromLog(
      [
        clearLine(994.0, "1-1"),
        clearLine(1000.1, "3-5"),
        line({ ringSeq: 3, wallTime: 1000.2, acquireName: "漏记品" }),
      ],
      [],
      [{ wallTime: 1000.2, category: "rare" }],
      // Difficulty reference (3) is borrowed; it is far outside the window.
      { clears: [{ wallTime: 900, stageKey: 3305 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("rare:65");
  });

  it("skips a nearer clear line whose stage has no route and uses the next", () => {
    // "5-1" → 5501: no route anywhere claims it (the trimmed table only knows
    // 1xxx low stages and 3xxx/4xxx), so the farther "3-5" → 3305 (Lv65) is
    // used instead of leaving the row category-only.
    const r = backfillOpensFromLog(
      [
        clearLine(1000.1, "5-1"),
        clearLine(995.0, "3-5"),
        line({ ringSeq: 3, wallTime: 1000.2, acquireName: "漏记品" }),
      ],
      [],
      [{ wallTime: 1000.2, category: "common" }],
      { clears: [{ wallTime: 900, stageKey: 3305 }], boxRoutes: ROUTES },
    );
    expect(r.candidates[0]!.boxKey).toBe("common:65");
  });
});
