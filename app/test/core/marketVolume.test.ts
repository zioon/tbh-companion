import { describe, expect, it } from "vitest";
import {
  aggregateHistoryToHourly,
  aggregateHourly,
  aggregateVolume,
  volumeCategoryKey,
  type PriceHistoryPoint,
} from "../../src/core/marketVolume";
import type { LookupItem } from "../../shared/types";

type CatItem = Pick<LookupItem, "type" | "gearGroup" | "materialType">;

const gear: CatItem = { type: "GEAR", gearGroup: "WEAPON", materialType: null };
const armor: CatItem = { type: "GEAR", gearGroup: "ARMOR", materialType: null };
const accessory: CatItem = { type: "GEAR", gearGroup: "ACCESSORY", materialType: null };
const material: CatItem = { type: "MATERIAL", gearGroup: null, materialType: "CRAFTING" };
const coin: CatItem = { type: "MATERIAL", gearGroup: null, materialType: "OFFERING" };

function map<T>(entries: [string, T][]): Map<string, T> {
  return new Map(entries);
}

describe("volumeCategoryKey", () => {
  it("maps gear to WEAPON/ARMOR/ACCESSORY by gearGroup", () => {
    expect(volumeCategoryKey(gear)).toBe("WEAPON");
    expect(volumeCategoryKey(armor)).toBe("ARMOR");
    expect(volumeCategoryKey(accessory)).toBe("ACCESSORY");
  });

  it("maps material to COIN (OFFERING) vs MATERIAL", () => {
    expect(volumeCategoryKey(coin)).toBe("COIN");
    expect(volumeCategoryKey(material)).toBe("MATERIAL");
  });

  it("falls back to a stable category when the group is missing", () => {
    expect(volumeCategoryKey({ type: "GEAR", gearGroup: null, materialType: null })).toBe("ARMOR");
    expect(volumeCategoryKey({ type: "MATERIAL", gearGroup: null, materialType: null })).toBe(
      "MATERIAL",
    );
    expect(
      volumeCategoryKey({
        type: "STAGEBOX" as unknown as CatItem["type"],
        gearGroup: null,
        materialType: null,
      }),
    ).toBe("OTHER");
  });
});

describe("aggregateVolume", () => {
  it("sums volume * median into total and per-category buckets", () => {
    const itemsByHash = map([
      ["sword (Legendary) A", gear],
      ["shield (Legendary) A", armor],
      ["copper coin", coin],
      ["iron ore", material],
    ]);
    const volumeByHash = map([
      ["sword (Legendary) A", { volume: 10, median: 2 }],
      ["shield (Legendary) A", { volume: 5, median: 4 }],
      ["copper coin", { volume: 100, median: 0.1 }],
      ["iron ore", { volume: 20, median: 1 }],
    ]);

    const sample = aggregateVolume(itemsByHash, volumeByHash, "USD", "2026-08-07T10:00:00.000Z");
    expect(sample.total).toBeCloseTo(10 * 2 + 5 * 4 + 100 * 0.1 + 20 * 1, 8);
    expect(sample.items).toBe(4);
    expect(sample.byCategory).toEqual({ WEAPON: 20, ARMOR: 20, COIN: 10, MATERIAL: 20 });
    expect(sample.currency).toBe("USD");
    expect(sample.timestamp).toBe("2026-08-07T10:00:00.000Z");
  });

  it("skips entries with zero/negative volume or invalid median", () => {
    const itemsByHash = map([["sword A", gear]]);
    const volumeByHash = map([
      ["sword A", { volume: 10, median: 2 }],
      ["zero", { volume: 0, median: 2 }],
      ["noMedian", { volume: 10, median: null }],
      ["negMedian", { volume: 10, median: -1 }],
    ]);
    const sample = aggregateVolume(itemsByHash, volumeByHash, "USD");
    expect(sample.total).toBe(20);
    expect(sample.items).toBe(1);
  });

  it("buckets unmatched hashes into OTHER", () => {
    const volumeByHash = map([["mystery item", { volume: 10, median: 1 }]]);
    const sample = aggregateVolume(new Map(), volumeByHash, "USD");
    expect(sample.byCategory).toEqual({ OTHER: 10 });
  });
});

describe("aggregateHourly", () => {
  it("averages samples within the same hour bucket and sorts ascending", () => {
    const samples = [
      { timestamp: "2026-08-07T10:10:00.000Z", total: 100 },
      { timestamp: "2026-08-07T10:40:00.000Z", total: 200 },
      { timestamp: "2026-08-07T09:05:00.000Z", total: 50 },
    ];
    const points = aggregateHourly(samples);
    expect(points).toHaveLength(2);
    expect(points[0].hour).toBe("2026-08-07T09:00:00.000Z");
    expect(points[0].total).toBe(50);
    expect(points[1].hour).toBe("2026-08-07T10:00:00.000Z");
    expect(points[1].total).toBe(150);
  });

  it("caps at maxHours keeping the most recent buckets", () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 7, 7, i % 24, 0)).toISOString(),
      total: i,
    }));
    const points = aggregateHourly(samples, 24);
    expect(points.length).toBeLessThanOrEqual(24);
  });

  it("returns empty for no samples", () => {
    expect(aggregateHourly([])).toEqual([]);
  });
});

describe("aggregateHistoryToHourly", () => {
  const H = 3600;
  const base = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000;

  it("buckets pricehistory points per hour and sums volume*price into total/byCategory", () => {
    const itemsByHash = map([
      ["sword A", gear],
      ["shield A", armor],
    ]);
    const historyByHash = map<PriceHistoryPoint[]>([
      [
        "sword A",
        [
          { timestamp: base, price: 2, volume: 10 },
          { timestamp: base + H, price: 3, volume: 5 },
        ],
      ],
      ["shield A", [{ timestamp: base, price: 4, volume: 5 }]],
    ]);

    const agg = aggregateHistoryToHourly(historyByHash, itemsByHash);
    expect(agg.points).toHaveLength(2);
    expect(agg.points[0].hour).toBe(
      new Date(base * 1000).toISOString().slice(0, 13) + ":00:00.000Z",
    );
    expect(agg.points[0].total).toBe(10 * 2 + 5 * 4);
    expect(agg.points[0].byCategory).toEqual({ WEAPON: 20, ARMOR: 20 });
    expect(agg.points[1].total).toBe(15);
    expect(agg.points[1].byCategory).toEqual({ WEAPON: 15 });
    expect(agg.itemCount).toBe(2);
    expect(agg.itemCountsByCategory).toEqual({ WEAPON: 1, ARMOR: 1 });
  });

  it("skips invalid points (non-finite timestamp/price, zero/negative volume)", () => {
    const historyByHash = map<PriceHistoryPoint[]>([
      [
        "sword A",
        [
          { timestamp: base, price: 2, volume: 10 },
          { timestamp: base + H, price: 0, volume: 5 },
          { timestamp: base + 2 * H, price: 2, volume: 0 },
          { timestamp: NaN, price: 2, volume: 5 },
        ],
      ],
    ]);
    const agg = aggregateHistoryToHourly(historyByHash, map([["sword A", gear]]));
    expect(agg.points).toHaveLength(1);
    expect(agg.points[0].total).toBe(20);
    expect(agg.itemCount).toBe(1);
    expect(agg.itemCountsByCategory).toEqual({ WEAPON: 1 });
  });

  it("classifies coin vs material and counts distinct items per category", () => {
    const itemsByHash = map([
      ["coin A", coin],
      ["coin B", coin],
      ["wood", material],
    ]);
    const historyByHash = map<PriceHistoryPoint[]>([
      ["coin A", [{ timestamp: base, price: 1, volume: 10 }]],
      ["coin B", [{ timestamp: base, price: 1, volume: 5 }]],
      ["wood", [{ timestamp: base, price: 2, volume: 3 }]],
    ]);
    const agg = aggregateHistoryToHourly(historyByHash, itemsByHash);
    expect(agg.points[0].byCategory).toEqual({ COIN: 15, MATERIAL: 6 });
    expect(agg.itemCount).toBe(3);
    expect(agg.itemCountsByCategory).toEqual({ COIN: 2, MATERIAL: 1 });
  });

  it("buckets unmatched hashes into OTHER and sorts ascending", () => {
    const historyByHash = map<PriceHistoryPoint[]>([
      ["mystery", [{ timestamp: base, price: 1, volume: 10 }]],
      ["sword A", [{ timestamp: base + H, price: 2, volume: 5 }]],
    ]);
    const agg = aggregateHistoryToHourly(historyByHash, new Map());
    expect(agg.points[0].total).toBe(10);
    expect(agg.points[0].byCategory).toEqual({ OTHER: 10 });
    expect(agg.points[1].total).toBe(10);
    expect(agg.itemCount).toBe(2);
    expect(agg.itemCountsByCategory).toEqual({ OTHER: 2 });
  });

  it("returns an empty aggregation for no history", () => {
    const agg = aggregateHistoryToHourly(new Map(), new Map());
    expect(agg.points).toEqual([]);
    expect(agg.itemCount).toBe(0);
    expect(agg.itemCountsByCategory).toEqual({});
  });
});
