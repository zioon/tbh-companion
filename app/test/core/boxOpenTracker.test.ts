import { describe, it, expect } from "vitest";
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

    const stats = t.getStats(3600, (itemKey) => (itemKey === 1001 ? { buyOrderUnit: 50 } : null));
    const row = stats[0].breakdown[0];
    expect(row.buyOrderUnit).toBe(50);
    expect(row.buyOrderValue).toBe(100);
    // 2 opens in 1 hour session (3600s) = 100 value / 1 hour = 100/hour
    expect(row.hourlyValue).toBe(100);
    expect(stats[0].totalBuyOrderValue).toBe(100);
    expect(stats[0].hourlyValue).toBe(100);
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
    expect(stats.map((s) => s.boxKey)).toEqual(["unclassified", "common", "rare:3", "rare:5", "act"]);
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
   * gameDataLookup.get(catalogId). Drops garbage itemKeys that have no
   * catalog match (the v1.00.28 String-pointer-bits-as-int bug).
   */
  function makeNormalizer(catalog: Map<number, { name: string; grade: string | null }>) {
    return (rawItemKey: number) => {
      const catalogId = rawItemKey < 1_000_000 ? rawItemKey : Math.trunc(rawItemKey / 1000);
      const item = catalog.get(catalogId);
      if (!item) return null;
      return { itemKey: catalogId, name: item.name };
    };
  }

  it("drops garbage itemKeys that have no catalog match", () => {
    const catalog = new Map([
      [530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }],
    ]);
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
    const catalog = new Map([
      [530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }],
    ]);
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
    const catalog = new Map([
      [530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }],
    ]);
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
    const catalog = new Map([
      [530017, { name: "Ethereal Amulet", grade: "UNCOMMON" }],
    ]);
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
    // Both itemKeys are garbage (not in catalog). The whole `rare:3` bucket
    // should disappear from stats, not show up with 0 opens.
    const catalog = new Map<number, { name: string; grade: string | null }>([]);
    const t = new BoxOpenTracker();
    t.recordOpen("rare:3", 1703973696, "#1703973696", null, 1, 1000);
    t.recordOpen("common", 530017, "#530017", null, 1, 2000); // also garbage here

    t.reResolveNames(makeNormalizer(catalog));

    expect(t.getStats(3600, () => null)).toEqual([]);
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
