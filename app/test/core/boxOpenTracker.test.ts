import { describe, it, expect, vi } from "vitest";
import { BoxOpenTracker } from "../../src/core/boxOpenTracker";
import type { BoxOpenTrackerSnapshot } from "../../shared/types";

describe("BoxOpenTracker", () => {
  it("returns empty stats when nothing recorded", () => {
    const t = new BoxOpenTracker();
    expect(t.getStats(3600, () => null)).toEqual([]);
  });

  it("records opens and aggregates by boxKey", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("rare:3", 1001, "Sword", "RARE", 1, 2000);
    t.recordOpen("rare:3", 2002, "Gem", "MAGIC", 1, 3000);

    const stats = t.getStats(3600, () => null);
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.boxKey).toBe("rare:3");
    expect(s.totalOpens).toBe(3);
    expect(s.breakdown).toHaveLength(2);

    const sword = s.breakdown.find((r) => r.itemKey === 1001)!;
    expect(sword.count).toBe(2);
    expect(sword.dropPct).toBeCloseTo(2 / 3, 5);
    expect(sword.buyOrderUnit).toBeNull();
    expect(sword.buyOrderValue).toBeNull();
    expect(sword.hourlyValue).toBeNull();

    const gem = s.breakdown.find((r) => r.itemKey === 2002)!;
    expect(gem.count).toBe(1);
    expect(gem.dropPct).toBeCloseTo(1 / 3, 5);
  });

  it("resolves buyout prices via priceResolver", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 2000);

    // Resolver returns wallet proceeds for selling `count` units, matching
    // the inventory page's "Instant sell" semantics (depth-aware, not unit×count).
    // The third arg is `nowSecondsOverride` — pins the per-box hourly divisor
    // to (4600 - 1000)/3600 = 1 hour, so 100 buyout value → 100/hour.
    const stats = t.getStats(
      3600,
      (itemKey, count) =>
        itemKey === 1001 ? { buyOrderValue: 50 * count, coveredCount: count } : null,
      4600,
    );
    const row = stats[0].breakdown[0];
    expect(row.buyOrderValue).toBe(100);
    expect(row.coveredCount).toBe(2);
    expect(row.buyOrderUnit).toBe(50); // 100 value / 2 covered
    // Per-box divisor: (4600 - 1000)/3600 = 1 hour → 100 value / 1 hour = 100/hour
    expect(row.hourlyValue).toBe(100);
    expect(stats[0].totalBuyOrderValue).toBe(100);
    expect(stats[0].hourlyValue).toBe(100);
    // trackingSinceWallTime is the first drop's wallTime (never reset).
    expect(stats[0].trackingSinceWallTime).toBe(1000);
  });

  it("uses per-box trackingSinceWallTime as the hourly divisor anchor", () => {
    // Two boxKeys dropped at different times in the same session:
    //   common: first drop at t=1000 → 1h elapsed at t=4600 → 60/hour
    //   rare:   first drop at t=3700 → 0.25h elapsed at t=4600 → 240/hour
    // With sessionSeconds=7200 (2h) the old behavior would have given
    // 30/hour for both; the per-box anchor reflects actual farming duration.
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("rare", 2002, "Gem", "MAGIC", 1, 3700);

    const stats = t.getStats(
      7200,
      (itemKey, _count) =>
        itemKey === 1001 || itemKey === 2002 ? { buyOrderValue: 60, coveredCount: 1 } : null,
      4600,
    );
    const common = stats.find((s) => s.boxKey === "common")!;
    const rare = stats.find((s) => s.boxKey === "rare")!;
    expect(common.trackingSinceWallTime).toBe(1000);
    expect(rare.trackingSinceWallTime).toBe(3700);
    // common: hours = (4600-1000)/3600 = 1 → 60/1 = 60/hour
    expect(common.hourlyValue).toBe(60);
    // rare: hours = (4600-3700)/3600 = 0.25 → 60/0.25 = 240/hour
    expect(rare.hourlyValue).toBe(240);
  });

  it("resetBox overwrites trackingSinceWallTime with the reset moment", () => {
    // Use fake timers so `resetBox`'s internal `Date.now()` resolves to a
    // known value (5000s in epoch-ms = 5_000_000 ms).
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    // Pre-reset anchor = first drop's wallTime.
    expect(t.getStats(3600, () => null, 4600)[0].trackingSinceWallTime).toBe(1000);

    // resetBox stamps trackingSince to "now" (5_000_000 ms → 5000 s).
    t.resetBox("common");
    expect(t.captureSnapshot().trackingSinceByKey?.common).toBe(5000);

    // Post-reset: a fresh drop doesn't overwrite the reset stamp (it's already
    // set). New drop at t=5200 with 60 buyout value, queried at t=8800
    // (1 hour after the reset anchor of 5000) → 60/hour.
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 5200);
    const stats = t.getStats(3600, () => ({ buyOrderValue: 60, coveredCount: 1 }), 8600);
    expect(stats[0].trackingSinceWallTime).toBe(5000);
    // hours = (8600 - 5000)/3600 = 1 → 60/1 = 60/hour
    expect(stats[0].hourlyValue).toBe(60);

    vi.useRealTimers();
  });

  it("resetAll clears trackingSinceWallTime alongside counts and history", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("rare", 2002, "Gem", "MAGIC", 1, 2000);
    expect(t.getStats(3600, () => null).length).toBe(2);

    t.resetAll();
    expect(t.getStats(3600, () => null)).toEqual([]);
    // After resetAll, a fresh drop re-initializes trackingSince to that
    // drop's wallTime — no stale anchor survives.
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 5000);
    const stats = t.getStats(3600, () => null, 8600);
    expect(stats[0].trackingSinceWallTime).toBe(5000);
  });

  it("captures trackingSinceByKey in snapshot and restores it", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("rare", 2002, "Gem", "MAGIC", 1, 2000);

    const snap = t.captureSnapshot();
    expect(snap.trackingSinceByKey).toEqual({ common: 1000, rare: 2000 });

    const t2 = new BoxOpenTracker();
    t2.applySnapshot(snap);
    const stats = t2.getStats(7200, () => null, 4600);
    const common = stats.find((s) => s.boxKey === "common")!;
    const rare = stats.find((s) => s.boxKey === "rare")!;
    expect(common.trackingSinceWallTime).toBe(1000);
    expect(rare.trackingSinceWallTime).toBe(2000);
  });

  it("falls back to earliest history wallTime when snapshot lacks trackingSinceByKey", () => {
    // Legacy snapshot (pre-trackingSinceByKey) — applySnapshot should derive
    // trackingSince from the earliest surviving history entry per boxKey.
    const legacy = {
      countsByKey: { common: { "1001|RARE": 1 } },
      namesByKey: { "1001|RARE": "Sword" },
      gradesByKey: { "1001|RARE": "RARE" },
      history: [
        {
          wallTime: 1500,
          boxKey: "common",
          itemKey: 1001,
          itemName: "Sword",
          grade: "RARE",
          count: 1,
        },
      ],
    };
    const t = new BoxOpenTracker();
    t.applySnapshot(legacy);
    const stats = t.getStats(7200, () => null, 5100);
    // Derived from history[0].wallTime = 1500 (only surviving entry).
    expect(stats[0].trackingSinceWallTime).toBe(1500);
  });

  it("handles null priceResolver", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    const stats = t.getStats(3600, null);
    expect(stats[0].breakdown[0].buyOrderUnit).toBeNull();
    expect(stats[0].totalBuyOrderValue).toBeNull();
  });

  it("resets a single boxKey without affecting others", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("rare", 2002, "Gem", "MAGIC", 1, 2000);

    t.resetBox("common");
    const stats = t.getStats(3600, () => null);
    expect(stats).toHaveLength(1);
    expect(stats[0].boxKey).toBe("rare");
  });

  it("resets all boxKeys", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("rare", 2002, "Gem", "MAGIC", 1, 2000);

    t.resetAll();
    expect(t.getStats(3600, () => null)).toEqual([]);
  });

  it("captures and applies a snapshot round-trip", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 1001, "Sword", "RARE", 2, 1000);
    t.recordOpen("common", 2002, "Gem", "MAGIC", 1, 2000);

    const snap: BoxOpenTrackerSnapshot = t.captureSnapshot();

    const t2 = new BoxOpenTracker();
    t2.applySnapshot(snap);
    const stats = t2.getStats(3600, () => null);
    expect(stats).toHaveLength(2);
    const rare = stats.find((s) => s.boxKey === "rare:3")!;
    expect(rare.totalOpens).toBe(2);
    expect(rare.breakdown[0].count).toBe(2);
    expect(rare.breakdown[0].name).toBe("Sword");
  });

  it("records history entries capped at limit", () => {
    const t = new BoxOpenTracker();
    for (let i = 0; i < 600; i++) {
      t.recordOpen("common", 1001, "Sword", "RARE", 1, 1000 + i);
    }
    const stats = t.getStats(3600, () => null);
    // Visible window is 50; history should be at most 50
    expect(stats[0].history.length).toBeLessThanOrEqual(50);
    expect(stats[0].history[0].wallTime).toBe(1000 + 599);
  });

  it("tracks lastOpenWallTime", () => {
    const t = new BoxOpenTracker();
    expect(t.getStats(3600, () => null)).toEqual([]);
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 5000);
    const stats = t.getStats(3600, () => null);
    expect(stats[0].lastOpenWallTime).toBe(5000);
  });

  it("sorts stats by category then level (unclassified first)", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("act", 3003, "Relic", "LEGENDARY", 1, 1000);
    t.recordOpen("rare:5", 2002, "Gem", "MAGIC", 1, 2000);
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 3000);
    t.recordOpen("rare:3", 2002, "Gem", "MAGIC", 1, 4000);
    t.recordOpen("unclassified", 4004, "Unknown", null, 1, 5000);

    const stats = t.getStats(3600, () => null);
    // unclassified sorts first so items needing manual reclassification are
    // visible without scrolling; then common → rare → act.
    expect(stats.map((s) => s.boxKey)).toEqual([
      "unclassified",
      "common",
      "rare:3",
      "rare:5",
      "act",
    ]);
  });

  it("includes unclassified entries in stats", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("unclassified", 1001, "Sword", "RARE", 1, 1000);
    const stats = t.getStats(3600, () => null);
    expect(stats).toHaveLength(1);
    expect(stats[0].boxKey).toBe("unclassified");
    expect(stats[0].category).toBe("unclassified");
    expect(stats[0].label).toBe("Unclassified");
  });

  it("reclassifies an item from one boxKey to another", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("unclassified", 1001, "Sword", "RARE", 3, 1000);
    t.recordOpen("unclassified", 2002, "Gem", "MAGIC", 1, 2000);

    t.reclassifyItem("unclassified", 1001, "common");

    const stats = t.getStats(3600, () => null);
    const common = stats.find((s) => s.boxKey === "common")!;
    expect(common).toBeDefined();
    expect(common.totalOpens).toBe(3);
    expect(common.breakdown[0].name).toBe("Sword");

    const unclassified = stats.find((s) => s.boxKey === "unclassified")!;
    expect(unclassified).toBeDefined();
    expect(unclassified.totalOpens).toBe(1);
    expect(unclassified.breakdown[0].name).toBe("Gem");
  });

  it("reclassify moves history entries too", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("unclassified", 1001, "Sword", "RARE", 1, 1000);
    t.recordOpen("unclassified", 1001, "Sword", "RARE", 1, 2000);

    t.reclassifyItem("unclassified", 1001, "rare:3");

    const stats = t.getStats(3600, () => null);
    const rare = stats.find((s) => s.boxKey === "rare:3")!;
    expect(rare.history).toHaveLength(2);
    expect(rare.history.every((h) => h.boxKey === "rare:3")).toBe(true);
    expect(t.getStats(3600, () => null).find((s) => s.boxKey === "unclassified")).toBeUndefined();
  });

  it("reclassify is a no-op when source item doesn't exist", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("unclassified", 1001, "Sword", "RARE", 1, 1000);
    t.reclassifyItem("unclassified", 9999, "common");
    const stats = t.getStats(3600, () => null);
    expect(stats).toHaveLength(1);
    expect(stats[0].boxKey).toBe("unclassified");
  });

  it("reclassify merges into an existing target boxKey", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("common", 1001, "Sword", "RARE", 2, 1000);
    t.recordOpen("unclassified", 1001, "Sword", "RARE", 3, 2000);

    t.reclassifyItem("unclassified", 1001, "common");

    const stats = t.getStats(3600, () => null);
    const common = stats.find((s) => s.boxKey === "common")!;
    expect(common.totalOpens).toBe(5);
    expect(common.breakdown[0].count).toBe(5);
  });
});

describe("BoxOpenTracker.reResolveNames", () => {
  /**
   * Stand-in for TrackingService's normalizer: catalogItemKeyFromSave +
   * gameDataLookup.get(catalogId). Drops garbage itemKeys that fall outside
   * the catalog id range (the v1.00.28 String-pointer-bits-as-int bug);
   * preserves real ids the catalog hasn't indexed yet with a `#id` name.
   */
  const CATALOG_MIN = 110_001;
  const CATALOG_MAX = 939_999;
  function makeNormalizer(catalog: Map<number, { name: string; grade: string | null }>) {
    return (rawItemKey: number, _grade: string | null) => {
      const catalogId = rawItemKey < 1_000_000 ? rawItemKey : Math.trunc(rawItemKey / 1000);
      const item = catalog.get(catalogId);
      if (!item) {
        if (catalogId >= CATALOG_MIN && catalogId <= CATALOG_MAX) {
          return { itemKey: catalogId, name: `#${catalogId}` };
        }
        return null;
      }
      return { itemKey: catalogId, name: item.name };
    };
  }

  it("drops garbage itemKeys that have no catalog match", () => {
    const catalog = new Map([[530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }]]);
    const t = new BoxOpenTracker();
    // Simulate a v1.00.28 corrupted snapshot: 1703973696 is a heap-address
    // low 32 bits misread as int32; 530017 is the real catalog id.
    t.recordOpen("rare:3", 1703973696, "#1703973696", null, 2, 1000);
    t.recordOpen("rare:3", 530017, "#530017", "RARE", 1, 2000);

    t.reResolveNames(makeNormalizer(catalog));

    const stats = t.getStats(3600, () => null);
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.totalOpens).toBe(1);
    expect(s.breakdown).toHaveLength(1);
    expect(s.breakdown[0].itemKey).toBe(530017);
    expect(s.breakdown[0].name).toBe("Ethereal Amulet");
    expect(s.breakdown[0].grade).toBe("RARE");
    expect(s.breakdown[0].count).toBe(1);
  });

  it("re-resolves name for surviving itemKeys (grade preserved)", () => {
    const catalog = new Map([[530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }]]);
    const t = new BoxOpenTracker();
    // Recorded with a stale `#xxx` name fallback from a prior session.
    t.recordOpen("rare:3", 530017, "#530017", "RARE", 1, 1000);

    t.reResolveNames(makeNormalizer(catalog));

    const stats = t.getStats(3600, () => null);
    const row = stats[0].breakdown[0];
    expect(row.name).toBe("Ethereal Amulet");
    expect(row.grade).toBe("RARE");
  });

  it("remaps raw itemKey to catalogId and merges counts under the new key", () => {
    // Save-encoded itemKey 530017001 → catalogItemKeyFromSave → 530017.
    // Both entries should merge under catalogId 530017 with count 3.
    const catalog = new Map([[530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }]]);
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 530017, "#530017", null, 1, 1000);
    t.recordOpen("rare:3", 530017001, "#530017001", null, 2, 2000);

    t.reResolveNames(makeNormalizer(catalog));

    const stats = t.getStats(3600, () => null);
    expect(stats[0].breakdown).toHaveLength(1);
    expect(stats[0].breakdown[0].itemKey).toBe(530017);
    expect(stats[0].breakdown[0].count).toBe(3);
  });

  it("updates history entries in place (itemKey, name; grade preserved)", () => {
    const catalog = new Map([[530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }]]);
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 530017, "#530017", "RARE", 1, 5000);
    t.recordOpen("rare:3", 1703973696, "#1703973696", null, 1, 6000); // garbage

    t.reResolveNames(makeNormalizer(catalog));

    const stats = t.getStats(3600, () => null);
    const history = stats[0].history;
    expect(history).toHaveLength(1);
    expect(history[0].itemKey).toBe(530017);
    expect(history[0].itemName).toBe("Ethereal Amulet");
    expect(history[0].grade).toBe("RARE");
  });

  it("removes a boxKey entirely when all its items are dropped", () => {
    // Both itemKeys are out-of-range garbage (heap-address misreads). The whole
    // `rare:3` bucket should disappear from stats, not show up with 0 opens.
    const catalog = new Map<number, { name: string; grade: string | null }>([]);
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 1703973696, "#1703973696", null, 1, 1000);
    t.recordOpen("common", 9999999, "#9999999", null, 1, 2000); // out of range

    t.reResolveNames(makeNormalizer(catalog));

    expect(t.getStats(3600, () => null)).toEqual([]);
  });

  it("preserves in-range itemKeys the catalog hasn't indexed yet", () => {
    // 620017 is a genuine game id (from "ItemName_620017") that the bundled
    // catalog doesn't have yet. It must survive reResolveNames so loot isn't
    // lost on restart — mirroring resolveBoxOpenEntry's `#id` fallback.
    const catalog = new Map<number, { name: string; grade: string | null }>([
      [530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }],
    ]);
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 620017, "#620017", "RARE", 1, 1000);
    t.recordOpen("rare:3", 530017, "#530017", "RARE", 1, 2000);

    t.reResolveNames(makeNormalizer(catalog));

    const stats = t.getStats(3600, () => null);
    expect(stats).toHaveLength(1);
    const breakdown = stats[0].breakdown;
    expect(breakdown).toHaveLength(2);
    const unknown = breakdown.find((r) => r.itemKey === 620017)!;
    expect(unknown.name).toBe("#620017");
    expect(unknown.grade).toBe("RARE");
    expect(unknown.count).toBe(1);
    const known = breakdown.find((r) => r.itemKey === 530017)!;
    expect(known.name).toBe("Ethereal Amulet");
  });

  it("remaps (baseId, grade) → catalog variant id using grade", () => {
    // Catalog has independent ids per rarity variant. A normalizer that uses
    // grade to remap should rewrite 530017 (COMMON) + grade="RARE" to the
    // RARE variant id (532171). Grade stays preserved on the composite key.
    const catalog = new Map<number, { name: string; grade: string | null }>([
      [530017, { name: "Dimensional Boots", grade: "COMMON" }],
      [532171, { name: "Dimensional Boots", grade: "RARE" }],
    ]);
    const t = new BoxOpenTracker();
    // Recorded as base id with RARE grade (the save format).
    t.recordOpen("rare:3", 530017, "Dimensional Boots", "RARE", 2, 1000);

    // Normalizer remaps using (id, grade).
    const remappingNormalizer = (rawItemKey: number, grade: string | null) => {
      const catalogId = rawItemKey < 1_000_000 ? rawItemKey : Math.trunc(rawItemKey / 1000);
      const item = catalog.get(catalogId);
      if (!item) return null;
      // If grade differs from the catalog grade, find the variant id.
      if (grade && grade !== item.grade) {
        for (const [id, v] of catalog) {
          if (v.name === item.name && v.grade === grade) {
            return { itemKey: id, name: v.name };
          }
        }
      }
      return { itemKey: catalogId, name: item.name };
    };
    t.reResolveNames(remappingNormalizer);

    const stats = t.getStats(3600, () => null);
    expect(stats[0].breakdown).toHaveLength(1);
    const row = stats[0].breakdown[0];
    expect(row.itemKey).toBe(532171);
    expect(row.grade).toBe("RARE");
    expect(row.count).toBe(2);
    // History also remapped.
    expect(stats[0].history[0].itemKey).toBe(532171);
  });
});

describe("BoxOpenTracker onUnclassified callback", () => {
  it("fires onUnclassified when recordOpen targets UNCLASSIFIED_BOX_KEY", async () => {
    const batches: Array<{ itemKeys: number[] }> = [];
    const tracker = new BoxOpenTracker({
      onUnclassified: (entries) => batches.push({ itemKeys: entries.map((e) => e.itemKey) }),
    });
    tracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 1.0);
    tracker.recordOpen("unclassified", 101, "Shield", "COMMON", 1, 1.01);
    // Microtask flush
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.itemKeys).toEqual([100, 101]);
  });
  it("does not fire onUnclassified when recordOpen targets a known boxKey", async () => {
    const batches: unknown[] = [];
    const tracker = new BoxOpenTracker({
      onUnclassified: () => batches.push({}),
    });
    tracker.recordOpen("rare:3", 100, "Sword", "COMMON", 1, 1.0);
    await Promise.resolve();
    expect(batches).toEqual([]);
  });
  it("flushes pending batch immediately when flushUnclassified() is called", () => {
    const batches: number[][] = [];
    const tracker = new BoxOpenTracker({
      onUnclassified: (entries) => batches.push(entries.map((e) => e.itemKey)),
    });
    tracker.recordOpen("unclassified", 200, "Potion", "COMMON", 1, 2.0);
    tracker.flushUnclassified();
    expect(batches).toEqual([[200]]);
  });
  it("does not throw when no callback is set", () => {
    const tracker = new BoxOpenTracker();
    expect(() => tracker.recordOpen("unclassified", 300, "Gem", "RARE", 1, 3.0)).not.toThrow();
  });
});
