import { describe, expect, it } from "vitest";
import { RecordLogTracker } from "../../src/core/recordLogTracker";

describe("RecordLogTracker", () => {
  it("assigns incrementing seq and returns newest-first stats", () => {
    const t = new RecordLogTracker();
    t.feed("drop", 100, { dropCategory: "common" });
    t.feed("open", 101, { boxKey: "rare:3", name: "Sword" });
    t.feed("clear", 102, { stageKey: 3205, clearTimeSec: 30 });

    const stats = t.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byKind).toEqual({ drop: 1, open: 1, clear: 1, acquire: 0 });
    expect(stats.nextSeq).toBe(3);
    // newest-first
    expect(stats.entries.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(stats.entries[0]).toMatchObject({ seq: 3, kind: "clear", stageKey: 3205 });
  });

  it("trims to capacity keeping the newest entries only", () => {
    const t = new RecordLogTracker({ capacity: 3 });
    for (let i = 1; i <= 5; i++) t.feed("drop", i, { dropCategory: "common" });

    const stats = t.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byKind.drop).toBe(3);
    expect(stats.entries.map((e) => e.seq)).toEqual([5, 4, 3]);
  });

  it("caps the recent window exposed to the renderer", () => {
    const t = new RecordLogTracker({ recentWindow: 2 });
    for (let i = 1; i <= 5; i++) t.feed("drop", i, {});
    expect(t.getStats().entries.map((e) => e.seq)).toEqual([5, 4]);
    // capacity still defaults to 10000, so the total is not trimmed
    expect(t.getStats().total).toBe(5);
  });

  it("aggregates per-kind counts across mixed events", () => {
    const t = new RecordLogTracker();
    t.feed("drop", 1, {});
    t.feed("open", 2, {});
    t.feed("drop", 3, {});
    t.feed("clear", 4, {});
    expect(t.getStats().byKind).toEqual({ drop: 2, open: 1, clear: 1, acquire: 0 });
  });

  it("round-trips through snapshot/applySnapshot preserving counts", () => {
    const t = new RecordLogTracker();
    t.feed("drop", 100, { dropCategory: "rare" });
    t.feed("open", 101, { name: "Boots" });

    const fresh = new RecordLogTracker();
    fresh.applySnapshot(t.snapshot());

    const stats = fresh.getStats();
    expect(stats.total).toBe(2);
    expect(stats.byKind).toEqual({ drop: 1, open: 1, clear: 0, acquire: 0 });
    expect(stats.entries.map((e) => e.seq)).toEqual([2, 1]);
  });

  it("dedupes on seq when merging an overlapping snapshot (crash recovery)", () => {
    const t = new RecordLogTracker();
    t.feed("drop", 1, {});
    t.feed("drop", 2, {});
    const partial = t.snapshot(); // seq 1,2 on disk

    // New events arrive before the tail was persisted → seq 3 only
    const next = new RecordLogTracker();
    next.applySnapshot(partial);
    next.feed("open", 3, {}); // seq 3
    const disk = { nextSeq: 2, entries: partial.entries }; // stale disk (only seq 1,2)

    // Reload merges disk + in-memory(seq 1..3) without duplicating
    next.applySnapshot(disk);
    const stats = next.getStats();
    expect(stats.total).toBe(3);
    expect(stats.entries.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(stats.nextSeq).toBe(3);
  });

  it("restarts with an empty state by default", () => {
    const t = new RecordLogTracker();
    const stats = t.getStats();
    expect(stats.total).toBe(0);
    expect(stats.entries).toEqual([]);
    expect(stats.byKind).toEqual({ drop: 0, open: 0, clear: 0, acquire: 0 });
    expect(stats.nextSeq).toBe(0);
  });

  it("reset clears everything", () => {
    const t = new RecordLogTracker();
    t.feed("clear", 1, {});
    t.reset();
    const stats = t.getStats();
    expect(stats.total).toBe(0);
    expect(stats.nextSeq).toBe(0);
    expect(stats.entries).toEqual([]);
  });

  it("tracks acquire signatures and prunes them when entries are evicted", () => {
    const t = new RecordLogTracker({ capacity: 2 });
    expect(t.hasAcquireSignature("17:45", "获得了永恒之弓。")).toBe(false);
    t.feed("acquire", 1, { acquireTime: "17:45", acquireRaw: "获得了永恒之弓。" });
    expect(t.hasAcquireSignature("17:45", "获得了永恒之弓。")).toBe(true);
    // time matters: same raw, different minute → not a duplicate
    expect(t.hasAcquireSignature("17:46", "获得了永恒之弓。")).toBe(false);
    // empty raw is never indexed
    t.feed("acquire", 2, { acquireTime: "17:47", acquireRaw: "" });
    expect(t.hasAcquireSignature("17:47", "")).toBe(false);
    // capacity eviction drops the oldest signature together with its entry
    t.feed("drop", 3, { dropCategory: "common" });
    expect(t.hasAcquireSignature("17:45", "获得了永恒之弓。")).toBe(false);
    t.feed("acquire", 4, { acquireTime: "17:49", acquireRaw: "获得金币 x2" });
    expect(t.hasAcquireSignature("17:49", "获得金币 x2")).toBe(true);
  });

  it("rebuilds acquire signatures from an applied snapshot and clears on reset", () => {
    const t = new RecordLogTracker();
    t.feed("acquire", 1, { acquireTime: "15:06", acquireRaw: "获得了骰子。" });
    const fresh = new RecordLogTracker();
    fresh.applySnapshot(t.snapshot());
    expect(fresh.hasAcquireSignature("15:06", "获得了骰子。")).toBe(true);
    fresh.reset();
    expect(fresh.hasAcquireSignature("15:06", "获得了骰子。")).toBe(false);
  });

  it("dedupes a re-attach batch by ring index (stamp and text mutations don't matter)", () => {
    const t = new RecordLogTracker({ capacity: 3 });
    expect(t.hasRingSeq(101)).toBe(false);
    // The stamp below is whatever the game's rewritten time string says — the
    // index alone is the identity, so its value is irrelevant to the dedupe.
    t.feed("acquire", 1, {
      ringSeq: 101,
      acquireTime: "14:07",
      acquireRaw: "通关了关卡 3-10。(4秒)",
    });
    expect(t.hasRingSeq(101)).toBe(true);
    expect(t.hasRingSeq(102)).toBe(false);

    // Eviction drops the identity together with the entry.
    t.feed("acquire", 2, { ringSeq: 102, acquireTime: "14:08", acquireRaw: "X1" });
    t.feed("acquire", 3, { ringSeq: 103, acquireTime: "14:09", acquireRaw: "X2" });
    t.feed("acquire", 4, { ringSeq: 104, acquireTime: "14:10", acquireRaw: "X3" });
    expect(t.hasRingSeq(101)).toBe(false); // evicted (capacity 3)
    expect(t.hasRingSeq(104)).toBe(true);
  });

  it("rebuilds ring indices from a snapshot and clears them on reset", () => {
    const t = new RecordLogTracker();
    t.feed("acquire", 1, { ringSeq: 7, acquireTime: "10:00", acquireRaw: "获得了银锭。" });
    const fresh = new RecordLogTracker();
    fresh.applySnapshot(t.snapshot());
    expect(fresh.hasRingSeq(7)).toBe(true);
    fresh.reset();
    expect(fresh.hasRingSeq(7)).toBe(false);
  });

  it("keeps newest acquire lines on top when the log is at capacity", () => {
    const t = new RecordLogTracker({ capacity: 10000, recentWindow: 200 });
    for (let i = 0; i < 10000; i++) t.feed("drop", i, {});
    // Incremental acquire lines arrive after the log is full.
    t.feed("acquire", 10000, { acquireTime: "12:52", acquireRaw: "获得了次元权杖。" });
    t.feed("acquire", 10001, { acquireTime: "12:53", acquireRaw: "通关了关卡 3-9。" });

    const stats = t.getStats();
    expect(stats.total).toBe(10000);
    // Newest first, and the newest acquire lines are in the window.
    expect(stats.entries[0]).toMatchObject({ seq: 10002, kind: "acquire" });
    expect(stats.entries[1]).toMatchObject({ seq: 10001, kind: "acquire" });
    expect(stats.entries[0].acquireTime).toBe("12:53");
  });
});
