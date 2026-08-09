import { describe, it, expect } from "vitest";
import { selectPollingTargets, selectHistoryRefreshTargets } from "../../src/core/lookupPrice";
import type { LookupPriceSnapshot } from "../../shared/types";

function snapshot(prices: Record<string, number | null>): LookupPriceSnapshot {
  return {
    schemaVersion: 1,
    generatedUtc: "2026-07-26T00:00:00.000Z",
    baseCurrency: "USD",
    prices,
    fetchedUtc: {},
    fx: { USD: 1 },
  };
}

describe("selectPollingTargets", () => {
  it("returns empty when nothing watched", () => {
    expect(selectPollingTargets({ watchedHashes: [] })).toEqual([]);
  });

  it("includes only watched hashes (图鉴仅更新星标) regardless of owned/snapshot", () => {
    const snap = snapshot({ "Expensive Gem": 5.5, "Cheap Gem": 0.05, "Mid Gem": 1.0 });
    // snapshot/threshold 不再参与目标筛选；只回星标物品
    const result = selectPollingTargets({
      watchedHashes: ["Expensive Gem", "Cheap Gem"],
    });
    expect(result).toEqual(["Expensive Gem", "Cheap Gem"]);
    void snap;
  });

  it("keeps watched order as given", () => {
    const result = selectPollingTargets({ watchedHashes: ["B", "A", "C"] });
    expect(result).toEqual(["B", "A", "C"]);
  });

  it("dedupes and trims watched hashes", () => {
    const result = selectPollingTargets({
      watchedHashes: ["  A  ", "", "   ", "A", "B", "B"],
    });
    expect(result).toEqual(["A", "B"]);
  });

  it("respects maxTargets cap, keeping watched order", () => {
    const result = selectPollingTargets({
      watchedHashes: ["A", "B", "C", "D", "E"],
      maxTargets: 3,
    });
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("uses default maxTargets=50 when not specified", () => {
    const watched = Array.from({ length: 100 }, (_, i) => `Item ${i}`);
    const result = selectPollingTargets({ watchedHashes: watched });
    expect(result).toHaveLength(50);
  });
});

describe("selectHistoryRefreshTargets", () => {
  it("returns empty when no watched and no snapshot", () => {
    expect(
      selectHistoryRefreshTargets({ snapshot: null, watchedHashes: [], thresholdUsd: 1 }),
    ).toEqual([]);
  });

  it("includes watched hashes regardless of price/ownership", () => {
    const snap = snapshot({ "Watched Cheap": 0.05 });
    const result = selectHistoryRefreshTargets({
      snapshot: snap,
      watchedHashes: ["Watched Cheap", "Watched Missing"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Watched Cheap", "Watched Missing"]);
  });

  it("includes all snapshot items with price >= threshold, sorted by price desc", () => {
    const snap = snapshot({ HV2: 5.0, HV1: 10.0, Cheap: 0.05, Null: null, Hit: 1.0 });
    const result = selectHistoryRefreshTargets({
      snapshot: snap,
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    // 只含价格 >= 1.0 的；按价格降序
    expect(result).toEqual(["HV1", "HV2", "Hit"]);
  });

  it("does not include watched duplicates in the above-threshold list", () => {
    const snap = snapshot({ "Watched High": 50.0, Other: 20.0, Cheap: 0.1 });
    const result = selectHistoryRefreshTargets({
      snapshot: snap,
      watchedHashes: ["Watched High"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Watched High", "Other"]);
  });

  it("places watched first, then above-threshold by price desc", () => {
    const snap = snapshot({ High: 90.0, Mid: 5.0 });
    const result = selectHistoryRefreshTargets({
      snapshot: snap,
      watchedHashes: ["Watched A"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Watched A", "High", "Mid"]);
  });

  it("values below threshold or null are excluded", () => {
    const snap = snapshot({ A: 0.99, B: 1.0, C: null, D: -1 });
    const result = selectHistoryRefreshTargets({
      snapshot: snap,
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["B"]);
  });

  it("returns only watched when snapshot is null", () => {
    const result = selectHistoryRefreshTargets({
      snapshot: null,
      watchedHashes: ["A", "B"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["A", "B"]);
  });

  it("respects optional maxTargets cap", () => {
    const snap = snapshot({ A: 10.0, B: 9.0, C: 8.0, D: 7.0 });
    const result = selectHistoryRefreshTargets({
      snapshot: snap,
      watchedHashes: [],
      thresholdUsd: 1.0,
      maxTargets: 2,
    });
    expect(result).toEqual(["A", "B"]);
  });
});
