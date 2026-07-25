import { describe, it, expect } from "vitest";
import { selectPollingTargets } from "../../src/core/lookupPrice";
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
  it("returns empty when nothing owned, nothing watched, no snapshot", () => {
    expect(
      selectPollingTargets({
        snapshot: null,
        ownedHashes: [],
        watchedHashes: [],
        thresholdUsd: 1,
      }),
    ).toEqual([]);
  });

  it("includes all owned items; high-value (>= threshold) sorted first by price desc", () => {
    const snap = snapshot({ "Expensive Gem": 5.5, "Cheap Gem": 0.05, "Mid Gem": 1.0 });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["Expensive Gem", "Cheap Gem", "Mid Gem"],
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    // 全部入选；高价值（>= 1.0）按价格降序在前，低价（< 1.0）排后
    expect(result).toEqual(["Expensive Gem", "Mid Gem", "Cheap Gem"]);
  });

  it("includes owned items with null (no listing) snapshot price, after high-value", () => {
    const snap = snapshot({ "No Listing Item": null, "Priced Item": 2.0 });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["No Listing Item", "Priced Item"],
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Priced Item", "No Listing Item"]);
  });

  it("includes owned items absent from snapshot, after high-value", () => {
    const snap = snapshot({ "Priced Item": 2.0 });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["Priced Item", "Unknown Item"],
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Priced Item", "Unknown Item"]);
  });

  it("includes all owned items even when snapshot is null", () => {
    const result = selectPollingTargets({
      snapshot: null,
      ownedHashes: ["A", "B", "C"],
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    // 无快照时全部算常规，按 owned 顺序入选
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("always includes watched hashes regardless of price/ownership", () => {
    const snap = snapshot({ "Watched Priced": 0.05 });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: [],
      watchedHashes: ["Watched Priced", "Watched Not In Snapshot"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Watched Priced", "Watched Not In Snapshot"]);
  });

  it("dedupes hashes that appear in both owned and watched", () => {
    const snap = snapshot({ "Shared Hash": 5.0 });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["Shared Hash"],
      watchedHashes: ["Shared Hash"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Shared Hash"]);
  });

  it("places watched first, then high-value owned by price desc, then regular owned", () => {
    const snap = snapshot({
      "Watched A": 0.05,
      "Owned Cheap": 0.05,
      "Owned High": 10.0,
      "Owned Mid": 3.0,
    });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["Owned Cheap", "Owned High", "Owned Mid"],
      watchedHashes: ["Watched A"],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Watched A", "Owned High", "Owned Mid", "Owned Cheap"]);
  });

  it("respects maxTargets cap, dropping regular owned first, then low-value high-value", () => {
    const snap = snapshot({
      "Watched 1": 0.05,
      "Owned 5": 5.0,
      "Owned 4": 4.0,
      "Owned 3": 3.0,
      "Owned 2": 2.0,
      "Owned Regular": 0.05,
    });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["Owned Regular", "Owned 5", "Owned 4", "Owned 3", "Owned 2"],
      watchedHashes: ["Watched 1"],
      thresholdUsd: 1.0,
      maxTargets: 3,
    });
    // watched 1 个 + 高价值 owned 前 2 个 = 3，regular 被砍
    expect(result).toEqual(["Watched 1", "Owned 5", "Owned 4"]);
  });

  it("trims and ignores empty/whitespace hashes", () => {
    const snap = snapshot({ "Real Hash": 2.0 });
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: ["  Real Hash  ", "", "   "],
      watchedHashes: ["", "  "],
      thresholdUsd: 1.0,
    });
    expect(result).toEqual(["Real Hash"]);
  });

  it("uses default maxTargets=50 when not specified", () => {
    const snap = snapshot(
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`Item ${i}`, 2.0])),
    );
    const owned = Array.from({ length: 100 }, (_, i) => `Item ${i}`);
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: owned,
      watchedHashes: [],
      thresholdUsd: 1.0,
    });
    // 100 个全为高价值（2.0 >= 1.0），截断到 50
    expect(result).toHaveLength(50);
  });

  it("includes regular owned (below threshold) up to maxTargets after high-value", () => {
    // 5 个高价值 + 10 个常规，maxTargets=8 → 5 高价值 + 3 常规
    const highValue = Array.from({ length: 5 }, (_, i) => [`HV ${i}`, 5.0] as const);
    const regular = Array.from({ length: 10 }, (_, i) => [`RG ${i}`, 0.05] as const);
    const snap = snapshot(Object.fromEntries([...highValue, ...regular]));
    const result = selectPollingTargets({
      snapshot: snap,
      ownedHashes: [...regular.map(([h]) => h), ...highValue.map(([h]) => h)],
      watchedHashes: [],
      thresholdUsd: 1.0,
      maxTargets: 8,
    });
    expect(result).toHaveLength(8);
    // 前 5 个是高价值（按价格降序，都是 5.0，顺序保持 owned 输入的反转）
    expect(result.slice(0, 5)).toEqual(highValue.map(([h]) => h));
    // 后 3 个是常规（按 owned 输入顺序）
    expect(result.slice(5)).toEqual(["RG 0", "RG 1", "RG 2"]);
  });
});
