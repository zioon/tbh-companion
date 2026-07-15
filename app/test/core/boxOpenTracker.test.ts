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

  it("sorts stats by category then level", () => {
    const t = new BoxOpenTracker();
    t.recordOpen("act", 3003, "Relic", "LEGENDARY", 1, 1000);
    t.recordOpen("rare:5", 2002, "Gem", "MAGIC", 1, 2000);
    t.recordOpen("common", 1001, "Sword", "RARE", 1, 3000);
    t.recordOpen("rare:3", 2002, "Gem", "MAGIC", 1, 4000);

    const stats = t.getStats(3600, () => null);
    expect(stats.map((s) => s.boxKey)).toEqual(["common", "rare:3", "rare:5", "act"]);
  });
});
