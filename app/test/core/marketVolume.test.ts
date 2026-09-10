import { describe, expect, it } from "vitest";
import {
  aggregateHistoryToHourly,
  aggregateHourly,
  aggregateVolume,
  orderRefreshTargets,
  parseMarketVolumeHistory,
  recentVolumeTotal,
  volumeCategoryKey,
  type PriceHistoryPoint,
  type RefreshTargetVolume,
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

describe("parseMarketVolumeHistory", () => {
  it("解析合法快照并逐字段过滤", () => {
    const parsed = parseMarketVolumeHistory({
      version: 1,
      samples: [
        { timestamp: "2026-08-25T00:00:00Z", items: 1, total: 10, byCategory: {}, currency: "USD" },
        { timestamp: 123 },
      ],
      historyHourly: [{ hour: "2026-08-25T00:00:00Z", total: 5 }, { hour: 123 }],
      priceHistory: {
        "Copper Coin": [
          { timestamp: 1720000000, price: 1.2, volume: 340 },
          { timestamp: NaN, price: 1, volume: 1 },
        ],
      },
      liveHistory: {
        "Copper Coin": [
          { ts: 1720000000000, volume: 340, median: 1.2 },
          { ts: "x", volume: 1 },
        ],
      },
      itemCount: 1,
      itemCountsByCategory: { WEAPON: 1 },
      historyFetchedAtMs: 1720000000000,
    });

    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toHaveLength(1);
    expect(parsed!.historyHourly).toHaveLength(1);
    expect(parsed!.priceHistory["Copper Coin"]).toHaveLength(1);
    expect(parsed!.liveHistory!["Copper Coin"]).toHaveLength(1);
    expect(parsed!.itemCount).toBe(1);
    expect(parsed!.historyFetchedAtMs).toBe(1720000000000);
  });

  it("顶层非法（null / string / number）返回 null", () => {
    expect(parseMarketVolumeHistory(null)).toBeNull();
    expect(parseMarketVolumeHistory("nope")).toBeNull();
    expect(parseMarketVolumeHistory(42)).toBeNull();
  });

  it("接受旧版纯数组格式并解析为 samples", () => {
    const parsed = parseMarketVolumeHistory([
      { timestamp: "2026-08-25T00:00:00Z", items: 1, total: 10, byCategory: {}, currency: "USD" },
      { total: 1 },
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toHaveLength(1);
    expect(parsed!.historyHourly).toEqual([]);
  });

  it("部分字段缺失时回退为安全默认值", () => {
    const parsed = parseMarketVolumeHistory({ priceHistory: "bad" });
    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toEqual([]);
    expect(parsed!.historyHourly).toEqual([]);
    expect(parsed!.priceHistory).toEqual({});
    expect(parsed!.itemCount).toBe(0);
    expect(parsed!.itemCountsByCategory).toEqual({});
  });

  it("解析 lastRefreshAt（仅保留数字毫秒）", () => {
    const parsed = parseMarketVolumeHistory({
      lastRefreshAt: { a: 123, b: "bad", c: 456 },
    });
    expect(parsed!.lastRefreshAt).toEqual({ a: 123, c: 456 });
  });

  it("解析 currency 字段（trim 后保留；缺失/非字符串丢弃）", () => {
    expect(parseMarketVolumeHistory({ currency: " USD " })!.currency).toBe("USD");
    expect(parseMarketVolumeHistory({ currency: "cny" })!.currency).toBe("cny");
    expect(parseMarketVolumeHistory({ currency: 42 })!.currency).toBeUndefined();
    expect(parseMarketVolumeHistory({ currency: "" })!.currency).toBeUndefined();
    expect(parseMarketVolumeHistory({})!.currency).toBeUndefined();
  });
});

function volumes(entries: [string, RefreshTargetVolume][]): Map<string, RefreshTargetVolume> {
  return new Map(entries);
}

describe("recentVolumeTotal", () => {
  const nowSec = 1_000_000;
  const H = 3600;

  it("只累计最近窗口内、价/量有效的点", () => {
    const pts: PriceHistoryPoint[] = [
      { timestamp: nowSec, price: 2, volume: 10 }, // 窗口内
      { timestamp: nowSec - H, price: 4, volume: 5 }, // 窗口内（最近24h内）
      { timestamp: nowSec - 25 * H, price: 100, volume: 1 }, // 窗口外
      { timestamp: nowSec, price: 0, volume: 5 }, // 价无效
      { timestamp: nowSec, price: 2, volume: -1 }, // 量无效
    ];
    expect(recentVolumeTotal(pts, nowSec, 24 * H)).toBeCloseTo(20 + 20, 8);
  });

  it("窗口内无有效点返回 0", () => {
    expect(recentVolumeTotal([], nowSec, 24 * H)).toBe(0);
    expect(
      recentVolumeTotal([{ timestamp: nowSec - 30 * H, price: 2, volume: 10 }], nowSec, 24 * H),
    ).toBe(0);
  });
});

describe("orderRefreshTargets", () => {
  it("星标最前，其余按窗口交易额降序，仅价格按价格降序，无数据在尾", () => {
    const targets = ["a", "b", "c", "d", "e", "f"];
    const vol = volumes([
      ["b", { windowTotal: 50, fallbackPrice: 0 }],
      ["d", { windowTotal: 100, fallbackPrice: 0 }],
      ["a", { windowTotal: 0, fallbackPrice: 9 }],
      ["f", { windowTotal: 0, fallbackPrice: 3 }],
      ["c", { windowTotal: 30, fallbackPrice: 0 }],
    ]);
    // e 无数据
    const seen = new Set(["a"]);
    const { ordered } = orderRefreshTargets(targets, vol, seen, 0.95);
    expect(ordered).toEqual(["a", "d", "b", "c", "f", "e"]);
  });

  it("覆盖率主区 = 星标数 + 达到阈值所需的最少有交易额数量", () => {
    // 交易额：d=100, b=50, c=30；总 180。90% 阈值需主区覆盖 ≥162 → d+b+c 全 3 个。
    const vol = volumes([
      ["b", { windowTotal: 50, fallbackPrice: 0 }],
      ["d", { windowTotal: 100, fallbackPrice: 0 }],
      ["c", { windowTotal: 30, fallbackPrice: 0 }],
    ]);
    const { ordered, primary } = orderRefreshTargets(["b", "d", "c"], vol, new Set(), 0.9);
    expect(ordered).toEqual(["d", "b", "c"]);
    expect(primary).toBe(3);
  });

  it("阈值较低时主区只需前几个头部", () => {
    // 总 180，覆盖 1/3（60）即用前 2 个：100 ≥ 60。
    const vol = volumes([
      ["b", { windowTotal: 50, fallbackPrice: 0 }],
      ["d", { windowTotal: 100, fallbackPrice: 0 }],
      ["c", { windowTotal: 30, fallbackPrice: 0 }],
    ]);
    const { primary } = orderRefreshTargets(["b", "d", "c"], vol, new Set(), 0.3);
    // 100/180=0.556≥0.3 → 1 个即可
    expect(primary).toBe(1);
  });

  it("星标计入主区；冷启动（无任何交易额）时主区为全量", () => {
    const vol = volumes([["x", { windowTotal: 100, fallbackPrice: 0 }]]);
    const { primary } = orderRefreshTargets(["s", "x"], vol, new Set(["s"]), 0.9);
    expect(primary).toBe(2);
    // 全无数据 → primary=全量
    const cold = orderRefreshTargets(["p", "q"], volumes([]), new Set(), 0.9);
    expect(cold.primary).toBe(2);
    expect(cold.ordered).toEqual(["p", "q"]);
  });
});
