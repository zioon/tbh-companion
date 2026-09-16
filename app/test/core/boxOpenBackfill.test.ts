import { describe, it, expect } from "vitest";
import {
  backfillOpensFromLog,
  BACKFILL_WINDOW_SEC,
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
