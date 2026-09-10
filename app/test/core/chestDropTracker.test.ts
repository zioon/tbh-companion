import { describe, it, expect, vi } from "vitest";
import {
  ChestDropTracker,
  LiveChestDropAggregator,
  resolveStageBoxDrop,
  isPlagueStage,
  resolveLiveDropCategory,
} from "../../src/core/chestDropTracker";

describe("resolveStageBoxDrop", () => {
  it("resolves common and rare stage boxes from catalog", () => {
    const common = resolveStageBoxDrop(910151);
    expect(common).toEqual({
      itemKey: 910151,
      name: "Normal Monster Box Lv15",
      category: "common",
    });

    const rare = resolveStageBoxDrop(920151);
    expect(rare?.category).toBe("rare");
    expect(rare?.itemKey).toBe(920151);
  });

  it("resolves Normal Monster Box Lv65 from catalog", () => {
    expect(resolveStageBoxDrop(910651)?.name).toBe("Normal Monster Box Lv65");
  });

  it("resolves act boss boxes by prefix", () => {
    const resolved = resolveStageBoxDrop(930151);
    expect(resolved?.category).toBe("act");
    expect(resolved?.itemKey).toBe(930151);
    expect(resolved?.name).toContain("Act boss");
  });

  it("falls back to prefix for unknown keys in range", () => {
    expect(resolveStageBoxDrop(910999)?.category).toBe("common");
    expect(resolveStageBoxDrop(920999)?.category).toBe("rare");
  });

  it("resolves non-canonical duplicate rare ItemKeys to themselves when no canonical tracker exists", () => {
    // 920004 (Stage Boss Box 3 duplicate) has no canonical tracker because
    // Box 1/2/3 don't drop from any stage (phantom tracker entries removed).
    // It resolves to itself rather than being canonicalized to 920003.
    const resolved = resolveStageBoxDrop(920004);
    expect(resolved?.itemKey).toBe(920004);
    expect(resolved?.category).toBe("rare");
  });
});

describe("ChestDropTracker", () => {
  it("records log drops by exact chest name", () => {
    const tracker = new ChestDropTracker();
    expect(tracker.recordLogDrop(910151)).toBe(true);
    expect(tracker.recordLogDrop(920151)).toBe(true);
    expect(tracker.recordLogDrop(930151)).toBe(true);

    const stats = tracker.getStats(3600);
    expect(stats.commonTotal).toBe(1);
    expect(stats.rareTotal).toBe(1);
    expect(stats.actTotal).toBe(1);
    expect(stats.combinedTotal).toBe(3);
    // perHour uses the sessionDropStart time window (clamped to 60s for
    // drops recorded "now"), so 1 drop / (60/3600)h = 60/hr.
    expect(stats.commonPerHour).toBe(60);
    expect(stats.rarePerHour).toBe(60);
    expect(stats.actPerHour).toBe(60);
    expect(stats.breakdown).toHaveLength(3);
    expect(stats.breakdown.every((row) => row.itemKey > 0)).toBe(true);
  });

  it("aggregates repeated log drops for the same chest", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLogDrop(910651);
    tracker.recordLogDrop(910651);
    tracker.recordLogDrop(910651);

    const stats = tracker.getStats(3600);
    expect(stats.commonTotal).toBe(3);
    expect(stats.breakdown).toEqual([
      expect.objectContaining({ itemKey: 910651, name: "Normal Monster Box Lv65", count: 3 }),
    ]);
  });

  it("records drop history newest first", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLogDrop(910151, 1000);
    tracker.recordLogDrop(920151, 1010);

    const stats = tracker.getStats(3600);
    expect(stats.history).toHaveLength(2);
    expect(stats.history[0]?.itemKey).toBe(920151);
    expect(stats.history[1]?.itemKey).toBe(910151);
  });

  it("lastRareDropWallTime only tracks stage boss (rare) drops", () => {
    // Mini overlay's boss-chest ring must ignore common/act drops — common
    // chests drop too frequently to make a 7-min lap meaningful.
    const tracker = new ChestDropTracker();
    // No drops yet → null.
    expect(tracker.getStats(3600).lastRareDropWallTime).toBeNull();

    // Common drop alone → still null.
    tracker.recordLiveChestDrop("common", 1000);
    expect(tracker.getStats(3600).lastRareDropWallTime).toBeNull();

    // Rare drop at 2000 → picked up.
    tracker.recordLiveChestDrop("rare", 2000);
    expect(tracker.getStats(3600).lastRareDropWallTime).toBe(2000);

    // Later common + act drops must NOT overwrite the rare timestamp.
    tracker.recordLiveChestDrop("common", 3000);
    tracker.recordLiveChestDrop("act", 4000);
    expect(tracker.getStats(3600).lastRareDropWallTime).toBe(2000);

    // A newer rare drop updates the timestamp.
    tracker.recordLiveChestDrop("rare", 5000);
    expect(tracker.getStats(3600).lastRareDropWallTime).toBe(5000);
  });

  it("round-trips snapshot restore", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLogDrop(910151);
    const snap = tracker.captureSnapshot();

    const restored = new ChestDropTracker();
    restored.applySnapshot(snap);
    restored.recordLogDrop(920151);

    const stats = restored.getStats(7200);
    expect(stats.commonTotal).toBe(1);
    expect(stats.rareTotal).toBe(1);
  });

  it("reset clears all counts, history, and perHour rates", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLogDrop(910151);
    tracker.recordLogDrop(920151);
    tracker.recordLiveChestDrop("act", 1000);

    const before = tracker.getStats(3600);
    expect(before.combinedTotal).toBe(3);
    // perHour uses the sessionDropStart time window — all three drops
    // happened "now", so each category gets 1 / (60/3600) = 60/hr.
    expect(before.commonPerHour).toBe(60);
    expect(before.rarePerHour).toBe(60);
    expect(before.actPerHour).toBe(60);

    tracker.reset();

    const after = tracker.getStats(3600);
    expect(after.commonTotal).toBe(0);
    expect(after.rareTotal).toBe(0);
    expect(after.actTotal).toBe(0);
    expect(after.combinedTotal).toBe(0);
    expect(after.commonPerHour).toBe(0);
    expect(after.rarePerHour).toBe(0);
    expect(after.actPerHour).toBe(0);
    expect(after.history).toHaveLength(0);
    expect(after.breakdown).toHaveLength(0);
  });

  it("getStats always returns readerRequired: true", () => {
    const tracker = new ChestDropTracker();
    expect(tracker.getStats(3600).readerRequired).toBe(true);
  });

  it("applySnapshot restores counts as part of the ongoing session", () => {
    // Restored drops count toward session totals and perHour so the Live
    // tab's displayed count and rate stay consistent after an app restart.
    const oneHourAgo = Date.now() / 1000 - 3600;
    const tracker = new ChestDropTracker();
    tracker.recordLogDrop(910151, oneHourAgo);
    tracker.recordLogDrop(910151, oneHourAgo);
    const snap = tracker.captureSnapshot();

    const restored = new ChestDropTracker();
    restored.applySnapshot(snap);
    const stats = restored.getStats(3600);
    expect(stats.commonTotal).toBe(2);
    expect(stats.commonSession).toBe(2); // restored counts are in-session
    // 2 drops / 1h window = 2/hr. Use toBeCloseTo because `getStats` reads
    // `nowSeconds()` again a few ms after `oneHourAgo` was captured above, so
    // `dropElapsed` is 3600+ε seconds and the rate is 2/(3600+ε)*3600 = 1.9999…
    expect(stats.commonPerHour).toBeCloseTo(2, 5);
  });

  it("clamps short elapsed to MIN_RATE_WINDOW_SEC to avoid perHour spikes", () => {
    // The time window defaults to MIN_RATE_WINDOW_SEC when sessionDropStart
    // is null (no drops) or the drop just happened (elapsed < 60s). With 1
    // drop and a 60s window, perHour = 1 / (60/3600) = 60/hr.
    const tracker = new ChestDropTracker();
    tracker.recordLogDrop(910151);
    const stats = tracker.getStats(5);
    expect(stats.commonTotal).toBe(1);
    expect(stats.commonPerHour).toBe(60);
  });

  it("uses the actual time window when drops happened long ago", () => {
    // 1 drop recorded 1 hour ago (relative to a fixed clock) → perHour = 1.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000); // tracking starts at t = 1000s
      const tracker = new ChestDropTracker();
      vi.setSystemTime(1_000_000 + 3600 * 1000); // now = t + 1h
      tracker.recordLogDrop(910151, 1_000); // drop wallTime = t (1h ago)
      const stats = tracker.getStats(3600);
      expect(stats.commonPerHour).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the wait since tracking started, not since the first drop", () => {
    // Regression: a fresh tracker anchors the rate to when tracking began, so
    // the time spent waiting for the first box counts toward the window. Prior
    // behavior anchored to the first-drop moment and (with the 60s floor)
    // showed a misleading 60/hr for a box that truly arrived 6 minutes later.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const tracker = new ChestDropTracker();
      // Player launches and waits 6 minutes before the first common box drops.
      vi.setSystemTime(1_000_000 + 360 * 1000);
      tracker.recordLogDrop(910151);
      const stats = tracker.getStats(0);
      // 1 drop across a 360s (0.1h) window → 1/0.1 = 10/hr, not 60/hr.
      expect(stats.commonTotal).toBe(1);
      expect(stats.commonPerHour).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshot round-trip preserves the sessionDropStart rate anchor", () => {
    // The rate window anchor must survive restore: without it, a snapshot
    // whose history is later truncated would re-anchor to a later moment and
    // inflate perHour. Anchor = min(trackingStartedAt, firstDropWallTime).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000 * 1000); // tracking starts at t = 1000s
      const tracker = new ChestDropTracker();
      vi.setSystemTime(1200 * 1000); // first drop at t = 1200s
      tracker.recordLogDrop(910151, 1200);
      const snap = tracker.captureSnapshot();
      expect(snap.sessionDropStart).toBe(1000); // min(1000, 1200) = 1000

      const restored = new ChestDropTracker();
      vi.setSystemTime(3000 * 1000); // reopen at t = 3000s
      restored.applySnapshot(snap);
      const stats = restored.getStats(0);
      // Window = now(3000) - anchor(1000) = 2000s → 1 drop / (2000/3600)h = 1.8/hr.
      // The history fallback (oldest kept entry = 1200) would give 1/(1800/3600)
      // = 2/hr — small drift; the important part is the anchor round-trips.
      expect(stats.commonPerHour).toBeCloseTo(1.8, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inflate perHour after restore when history exceeded HISTORY_LIMIT", () => {
    // A long farming session records more drops than HISTORY_LIMIT (500) keeps
    // in `history`, but `countsByKey` keeps every drop. Restoring must anchor
    // the rate window to the true session start (persisted in the snapshot),
    // not the oldest *kept* history entry — otherwise the denominator starts
    // too late while the numerator spans the whole session, inflating perHour
    // on the next app launch.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const tracker = new ChestDropTracker();
      // 600 common drops over 6 hours (one every 36s), starting at t=0.
      for (let i = 0; i < 600; i++) {
        const at = i * 36;
        vi.setSystemTime(at * 1000);
        tracker.recordLiveChestDrop("common", at);
      }
      const snap = tracker.captureSnapshot();
      expect(snap.history.length).toBe(500); // HISTORY_LIMIT truncation applied
      expect(snap.history[0]!.wallTime).toBe(100 * 36); // oldest KEPT, not t=0
      expect(snap.sessionDropStart).toBe(0); // true anchor preserved

      // Reopen the app shortly after (t = 6h + 2min).
      vi.setSystemTime((6 * 3600 + 120) * 1000);
      const restored = new ChestDropTracker();
      restored.applySnapshot(snap);
      const stats = restored.getStats(3600);
      expect(stats.commonSession).toBe(600);
      // True average: 600 / (6h + 2min) ≈ 99.4/hr. The truncated-history
      // fallback yields 600 / ((6h+2min) - 1h) ≈ 119.2/hr (~20% inflated).
      const trueRate = 600 / ((6 * 3600 + 120) / 3600);
      expect(stats.commonPerHour).toBeCloseTo(trueRate, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintains rolling-window stats identically to a full history scan", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000 * 1000); // now = 100_000s → cutoff = 96_400s
      const tracker = new ChestDropTracker();
      // In-window: 2 common + 1 rare + 1 act (all at exactly the cutoff).
      // Out-of-window: 1 common at 90_000s.
      tracker.recordLiveChestDrop("common", 96_400);
      tracker.recordLiveChestDrop("rare", 96_400);
      tracker.recordLiveChestDrop("act", 96_400);
      tracker.recordLiveChestDrop("common", 96_400);
      tracker.recordLiveChestDrop("common", 90_000);

      const stats = tracker.getStats(3600);
      const history = tracker.captureSnapshot().history;

      // Recompute the old O(N) scan from the same history for a reference.
      const cutoff = 100_000 - 3600;
      let common = 0;
      let rare = 0;
      let act = 0;
      let lastRare: number | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].category === "rare") {
          lastRare = history[i].wallTime;
          break;
        }
      }
      for (const e of history) {
        if (e.wallTime < cutoff) continue;
        if (e.category === "common") common++;
        else if (e.category === "rare") rare++;
        else act++;
      }

      expect(stats.lastRareDropWallTime).toBe(lastRare);
      // earliest in-window wallTime is exactly at the cutoff → full 1h window,
      // so the per-hour values equal the raw counts.
      expect(stats.commonRecentPerHour).toBe(common);
      expect(stats.rareRecentPerHour).toBe(rare);
      expect(stats.actRecentPerHour).toBe(act);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds incremental stats correctly after snapshot restore", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000 * 1000);
      const tracker = new ChestDropTracker();
      tracker.applySnapshot({
        countsByKey: {},
        namesByKey: {},
        categoriesByKey: {},
        history: [
          { wallTime: 90_000, itemKey: 900910, name: "Common chest", category: "common" },
          { wallTime: 96_400, itemKey: 900920, name: "Stage boss chest", category: "rare" },
          { wallTime: 97_000, itemKey: 900930, name: "Act boss chest", category: "act" },
        ],
      });

      const stats = tracker.getStats(3600);
      const history = tracker.captureSnapshot().history;

      const cutoff = 100_000 - 3600;
      let common = 0;
      let rare = 0;
      let act = 0;
      let lastRare: number | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].category === "rare") {
          lastRare = history[i].wallTime;
          break;
        }
      }
      for (const e of history) {
        if (e.wallTime < cutoff) continue;
        if (e.category === "common") common++;
        else if (e.category === "rare") rare++;
        else act++;
      }

      expect(stats.lastRareDropWallTime).toBe(lastRare);
      // 90_000 is outside the window; rare(96_400)+act(97_000) are in it, with
      // earliest = 96_400 (exactly the cutoff → 1h window).
      expect(stats.commonRecentPerHour).toBe(common);
      expect(stats.rareRecentPerHour).toBe(rare);
      expect(stats.actRecentPerHour).toBe(act);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops lastRareDropWallTime back to null when the last rare leaves the window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000 * 1000);
      const tracker = new ChestDropTracker();
      // Plant a rare at the front, then push HISTORY_LIMIT common entries so the
      // rare is evicted from the bounded history window.
      tracker.recordLiveChestDrop("rare", 1000);
      for (let i = 0; i < 500; i++) {
        tracker.recordLiveChestDrop("common", 1000 + i);
      }
      expect(tracker.getStats(3600).lastRareDropWallTime).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ChestDropTracker.recordLiveChestDrop", () => {
  it("records a stage boss (rare) drop into the rare bucket", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLiveChestDrop("rare", 1000);
    const stats = tracker.getStats(3600);
    expect(stats.rareTotal).toBe(1);
    expect(stats.commonTotal).toBe(0);
    expect(stats.combinedTotal).toBe(1);
  });

  it("records a common drop into the common bucket", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLiveChestDrop("common", 1000);
    const stats = tracker.getStats(3600);
    expect(stats.commonTotal).toBe(1);
    expect(stats.rareTotal).toBe(0);
  });

  it("aggregates repeated same-category drops under one breakdown row", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLiveChestDrop("common", 1000);
    tracker.recordLiveChestDrop("common", 1001);
    tracker.recordLiveChestDrop("rare", 1002);
    const stats = tracker.getStats(3600);
    expect(stats.commonTotal).toBe(2);
    expect(stats.rareTotal).toBe(1);
    // Two categories → two breakdown rows.
    expect(stats.breakdown).toHaveLength(2);
    expect(stats.history).toHaveLength(3);
  });

  it("drops legacy act-boss rows when restoring an older snapshot", () => {
    const tracker = new ChestDropTracker();
    tracker.applySnapshot({
      countsByKey: { "900910": 1, "900930": 2 },
      namesByKey: { "900910": "Common chest", "900930": "Act boss chest" },
      categoriesByKey: { "900910": "common", "900930": "actBoss" as "common" },
      history: [
        { wallTime: 1000, itemKey: 900910, name: "Common chest", category: "common" },
        {
          wallTime: 1001,
          itemKey: 900930,
          name: "Act boss chest",
          category: "actBoss" as "common",
        },
      ],
    });

    const stats = tracker.getStats(3600);
    expect(stats.commonTotal).toBe(1);
    expect(stats.combinedTotal).toBe(1);
    expect(stats.history).toHaveLength(1);
    expect(tracker.captureSnapshot().countsByKey).toEqual({ "900910": 1 });
  });

  it("records an act boss (act) drop into the act bucket", () => {
    const oneHourAgo = Date.now() / 1000 - 3600;
    const tracker = new ChestDropTracker();
    tracker.recordLiveChestDrop("act", oneHourAgo);
    const stats = tracker.getStats(3600);
    expect(stats.actTotal).toBe(1);
    expect(stats.commonTotal).toBe(0);
    expect(stats.rareTotal).toBe(0);
    expect(stats.combinedTotal).toBe(1);
    // `dropElapsed` is now − oneHourAgo, which is 3600s plus a sub-millisecond
    // skew between the two Date.now() reads, so the rate is 1 ± ε — use a
    // close-to assertion instead of exact equality.
    expect(stats.actPerHour).toBeCloseTo(1, 5);
    expect(stats.breakdown).toHaveLength(1);
    expect(stats.breakdown[0].category).toBe("act");
    expect(stats.breakdown[0].name).toBe("Act boss chest");
  });

  it("preserves act rows when restoring a snapshot with act category", () => {
    const tracker = new ChestDropTracker();
    tracker.applySnapshot({
      countsByKey: { "900910": 1, "900930": 2 },
      namesByKey: { "900910": "Common chest", "900930": "Act boss chest" },
      categoriesByKey: { "900910": "common", "900930": "act" },
      history: [
        { wallTime: 1000, itemKey: 900910, name: "Common chest", category: "common" },
        { wallTime: 1001, itemKey: 900930, name: "Act boss chest", category: "act" },
      ],
    });

    const stats = tracker.getStats(3600);
    expect(stats.commonTotal).toBe(1);
    expect(stats.actTotal).toBe(2);
    expect(stats.combinedTotal).toBe(3);
    expect(stats.history).toHaveLength(2);
  });
});

describe("LiveChestDropAggregator", () => {
  // Reader ticks at ~25 Hz (40 ms). A single chest-drop burst can straddle
  // multiple ticks because the game appends GetBoxLog entries across frames.
  // The aggregator must buffer categories across ticks and collapse a burst
  // exactly once when it goes silent — not record a drop per tick.

  it("flushes nothing while a burst is still flowing within the gap", () => {
    const agg = new LiveChestDropAggregator(0.5);
    // Three ticks, 40 ms apart, all part of one common burst.
    expect(agg.feed(["common", "common", "common"], 1.0)).toEqual([]);
    expect(agg.feed(["common", "common"], 1.04)).toEqual([]);
    expect(agg.feed(["common"], 1.08)).toEqual([]);
  });

  it("collapses a cross-tick burst into a single recorded drop on flush", () => {
    // Reproduces the bug: one common drop whose 5-entry burst splits across
    // two ticks must record exactly one common drop, not two.
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["common", "common", "common"], 1.0);
    agg.feed(["common", "common"], 1.04);
    // Silent tick beyond the gap flushes the burst.
    expect(agg.feed([], 1.6)).toEqual(["common"]);
  });

  it("does not double-record when the same burst keeps trickling across ticks", () => {
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["common"], 1.0);
    agg.feed(["common"], 1.04);
    agg.feed(["common"], 1.08);
    agg.feed(["common"], 1.12);
    agg.feed(["common"], 1.16);
    // One burst, five ticks — exactly one common drop on flush.
    expect(agg.feed([], 1.7)).toEqual(["common"]);
    // Subsequent silent ticks must not re-flush.
    expect(agg.feed([], 1.8)).toEqual([]);
    expect(agg.feed([], 2.0)).toEqual([]);
  });

  it("flushes the prior burst when a new burst starts after the gap", () => {
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["common", "common"], 1.0);
    // New rare burst after silence — flush the common burst first, then seed rare.
    expect(agg.feed(["rare"], 2.0)).toEqual(["common"]);
    // Rare burst still pending.
    expect(agg.feed([], 2.1)).toEqual([]);
    // Flush rare.
    expect(agg.feed([], 2.7)).toEqual(["rare"]);
  });

  it("keeps a lone stage-boss singleton riding another category's burst", () => {
    // One common drop (5 entries split across ticks) + 1 real rare entry in the
    // middle tick. The rare singleton must NOT be dropped — a stage-boss chest
    // can legitimately produce a single GetBoxLog entry, and suppressing it
    // caused real boss drops to be missed ("sometimes fails to recognize").
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["common", "common", "common"], 1.0);
    agg.feed(["common", "common", "rare"], 1.04);
    agg.feed(["common"], 1.08);
    expect(agg.feed([], 1.7)).toEqual(["common", "rare"]);
  });

  it("keeps a genuine 1:1 mix as two distinct drops", () => {
    // Two singletons of different categories in the same burst with no burst
    // backing either — treated as two real single drops.
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["common", "rare"], 1.0);
    expect(agg.feed([], 1.6)).toEqual(["common", "rare"]);
  });

  it("flush() forces the pending buffer out immediately", () => {
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["rare", "rare"], 1.0);
    expect(agg.flush()).toEqual(["rare"]);
    expect(agg.flush()).toEqual([]);
  });

  it("reset() clears the pending buffer", () => {
    const agg = new LiveChestDropAggregator(0.5);
    agg.feed(["common", "common"], 1.0);
    agg.reset();
    expect(agg.feed([], 1.6)).toEqual([]);
    expect(agg.flush()).toEqual([]);
  });

  it("treats the first feed as a fresh burst (no spurious flush)", () => {
    const agg = new LiveChestDropAggregator(0.5);
    expect(agg.feed(["common", "common"], 100.0)).toEqual([]);
    expect(agg.flush()).toEqual(["common"]);
  });

  it("onFeed callback reports input, flush, and buffer state", () => {
    const events: {
      inputCategories: string[];
      flushedCategories: string[];
      bufferSizeAfter: number;
      flushedStale: boolean;
    }[] = [];
    const agg = new LiveChestDropAggregator(0.5, (e) =>
      events.push({
        inputCategories: [...e.inputCategories],
        flushedCategories: [...e.flushedCategories],
        bufferSizeAfter: e.bufferSizeAfter,
        flushedStale: e.flushedStale,
      }),
    );

    // Burst flowing — accumulates, no flush.
    agg.feed(["common", "common"], 1.0);
    agg.feed(["common"], 1.04);
    // Silent tick beyond gap — stale flush.
    agg.feed([], 1.6);

    expect(events).toEqual([
      {
        inputCategories: ["common", "common"],
        flushedCategories: [],
        bufferSizeAfter: 2,
        flushedStale: false,
      },
      {
        inputCategories: ["common"],
        flushedCategories: [],
        bufferSizeAfter: 3,
        flushedStale: false,
      },
      {
        inputCategories: [],
        flushedCategories: ["common"],
        bufferSizeAfter: 0,
        flushedStale: true,
      },
    ]);
  });
});

describe("ChestDropTracker onDrop callback", () => {
  it("fires onDrop with category when recordLiveChestDrop succeeds", () => {
    const events: Array<{ category: string; wallTime: number }> = [];
    const tracker = new ChestDropTracker({
      onDrop: (e) => events.push({ category: e.category, wallTime: e.wallTime }),
    });
    tracker.recordLiveChestDrop("rare", 1234.5);
    expect(events).toEqual([{ category: "rare", wallTime: 1234.5 }]);
  });
  it("fires onDrop with itemKey + category when recordLogDrop succeeds", () => {
    // Use a known RARE itemKey from stage_boxes.json (920151 is canonical Lv5).
    const events: Array<{ category: string; itemKey?: number }> = [];
    const tracker = new ChestDropTracker({
      onDrop: (e) => events.push({ category: e.category, itemKey: e.itemKey }),
    });
    tracker.recordLogDrop(920151, 2000);
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe("rare");
    expect(events[0]?.itemKey).toBe(920151);
  });
  it("does not fire onDrop when recordLogDrop rejects an unknown itemKey", () => {
    const events: unknown[] = [];
    const tracker = new ChestDropTracker({ onDrop: () => events.push({}) });
    // 99999999 is not a stage box id
    expect(tracker.recordLogDrop(99999999, 3000)).toBe(false);
    expect(events).toEqual([]);
  });
  it("does not fire onDrop when disabled (no callback provided)", () => {
    const tracker = new ChestDropTracker();
    expect(() => tracker.recordLiveChestDrop("common", 4000)).not.toThrow();
  });
});

describe("plague (Contaminated) chest drop tracking", () => {
  it("maps plague box itemKeys to plague categories, not common/rare/act", () => {
    // 915xxx/925xxx/935xxx must NOT be misjudged as common/rare/act.
    expect(resolveStageBoxDrop(915001)?.category).toBe("plagueCommon");
    expect(resolveStageBoxDrop(915999)?.category).toBe("plagueCommon");
    expect(resolveStageBoxDrop(925001)?.category).toBe("plagueRare");
    expect(resolveStageBoxDrop(935001)?.category).toBe("plagueAct");
  });

  it("detects plague stages from the stage-box catalog", () => {
    // 201201 is a plague map (idealStageKey of plague box 915001). A non-plague
    // stageKey (1) is not a plague map.
    expect(isPlagueStage(201201)).toBe(true);
    expect(isPlagueStage(1)).toBe(false);
  });

  it("upgrades base live categories on plague maps and passes through elsewhere", () => {
    expect(resolveLiveDropCategory(201201, "common")).toBe("plagueCommon");
    expect(resolveLiveDropCategory(201201, "rare")).toBe("plagueRare");
    expect(resolveLiveDropCategory(201201, "act")).toBe("plagueAct");
    // Normal / unknown / null stageKey → passthrough.
    expect(resolveLiveDropCategory(1, "common")).toBe("common");
    expect(resolveLiveDropCategory(null, "rare")).toBe("rare");
    expect(resolveLiveDropCategory(0, "act")).toBe("act");
  });

  it("aggregates plague totals, rates, session, and combined", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLiveChestDrop("plagueCommon");
    tracker.recordLiveChestDrop("plagueRare");
    tracker.recordLiveChestDrop("common");

    const stats = tracker.getStats(3600);
    expect(stats.plagueCommonTotal).toBe(1);
    expect(stats.plagueRareTotal).toBe(1);
    expect(stats.plagueActTotal).toBe(0);
    expect(stats.commonTotal).toBe(1);
    // combined includes plague.
    expect(stats.combinedTotal).toBe(3);
    expect(stats.plagueCommonSession).toBe(1);
    expect(stats.plagueRareSession).toBe(1);
    // perHour uses the min 60s window: 1 / (60/3600) = 60.
    expect(stats.plagueCommonPerHour).toBe(60);
    // breakdown contains all three categories.
    expect(stats.breakdown.map((r) => r.category)).toEqual(
      expect.arrayContaining(["plagueCommon", "plagueRare", "common"]),
    );
  });

  it("round-trips plague categories through snapshot restore", () => {
    const tracker = new ChestDropTracker();
    tracker.recordLiveChestDrop("plagueAct", 1000);
    const snap = tracker.captureSnapshot();

    const restored = new ChestDropTracker();
    restored.applySnapshot(snap);
    const stats = restored.getStats(3600);
    expect(stats.plagueActTotal).toBe(1);
    expect(stats.combinedTotal).toBe(1);
  });
});
