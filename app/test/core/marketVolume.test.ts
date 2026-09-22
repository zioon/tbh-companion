import { describe, expect, it } from "vitest";
import {
  MARKET_VOLUME_BASE_CURRENCY,
  aggregateHistoryToHourly,
  aggregateHourly,
  aggregateItemVolume,
  aggregateLiveActivityItems,
  aggregateLiveItems,
  aggregateVolume,
  detectCurrencyFromPriceHistory,
  mergeParsedHistory,
  orderRefreshTargets,
  parseMarketVolumeHistory,
  recentVolumeTotal,
  rescaleMarketVolumeItems,
  rescaleVolumeStats,
  volumeCategoryKey,
  type ParsedMarketVolumeHistory,
  type PriceHistoryPoint,
  type RefreshTargetVolume,
} from "../../src/core/marketVolume";
import type { LookupItem, MarketVolumeStats } from "../../shared/types";

type CardItem = Pick<
  LookupItem,
  "id" | "type" | "gearGroup" | "materialType" | "name" | "grade" | "level" | "gearType"
>;

type CatItem = Pick<LookupItem, "type" | "gearGroup" | "materialType">;

const fullAccessory: CardItem = {
  id: 601011,
  name: "Accessory",
  type: "GEAR",
  gearGroup: "ACCESSORY",
  materialType: null,
  grade: "RARE",
  level: 30,
  gearType: "AMULET",
};
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

describe("aggregate card builders passthrough itemKey/gearGroup", () => {
  it("aggregateItemVolume exposes itemKey + gearGroup for matched hashes", () => {
    const itemsByHash = new Map<string, CardItem>([["acc (Rare) x1", fullAccessory]]);
    const historyByHash = new Map<string, PriceHistoryPoint[]>([
      ["acc (Rare) x1", [{ timestamp: 1000, price: 2, volume: 5 }]],
    ]);
    const out = aggregateItemVolume(historyByHash, itemsByHash);
    expect(out).toHaveLength(1);
    expect(out[0].itemKey).toBe(601011);
    expect(out[0].gearGroup).toBe("ACCESSORY");
  });
  it("aggregateLiveItems exposes itemKey + gearGroup for matched hashes", () => {
    const itemsByHash = new Map<string, CardItem>([["acc (Rare) x1", fullAccessory]]);
    const volumeByHash = new Map<string, { volume: number; median: number }>([
      ["acc (Rare) x1", { volume: 10, median: 2 }],
    ]);
    const out = aggregateLiveItems(itemsByHash, volumeByHash);
    expect(out).toHaveLength(1);
    expect(out[0].itemKey).toBe(601011);
    expect(out[0].gearGroup).toBe("ACCESSORY");
  });
  it("aggregateLiveActivityItems exposes itemKey + gearGroup for matched hashes", () => {
    const itemsByHash = new Map<string, CardItem>([["acc (Rare) x1", fullAccessory]]);
    const livePointsByHash = new Map<string, Array<{ ts: number; volume: number; median: number }>>(
      [["acc (Rare) x1", [{ ts: 1000, volume: 10, median: 2 }]]],
    );
    const out = aggregateLiveActivityItems(itemsByHash, livePointsByHash);
    expect(out).toHaveLength(1);
    expect(out[0].itemKey).toBe(601011);
    expect(out[0].gearGroup).toBe("ACCESSORY");
  });
  it("leaves itemKey/gearGroup undefined for unmatched hashes", () => {
    const out = aggregateItemVolume(
      new Map([["mystery", [{ timestamp: 1000, price: 2, volume: 5 }]]]),
      new Map(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].itemKey).toBeUndefined();
    expect(out[0].gearGroup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// USD 基准货币：历史融合 / 金额缩放 / 备份币种自动探测
// ---------------------------------------------------------------------------

const LIMITS = { maxSamples: 1200, maxLivePointsPerHash: 2000 };
const DAY = 86400;

function snapshot(over: Partial<ParsedMarketVolumeHistory> = {}): ParsedMarketVolumeHistory {
  return {
    samples: [],
    historyHourly: [],
    priceHistory: {},
    itemCount: 0,
    itemCountsByCategory: {},
    ...over,
  };
}

function sample(timestamp: string, total: number) {
  return { timestamp, items: 1, total, byCategory: {}, currency: MARKET_VOLUME_BASE_CURRENCY };
}

describe("mergeParsedHistory", () => {
  it("不同 UTC 天的历史取并集，并输出 v2 / USD 标记", () => {
    const dayStart = 20000 * DAY;
    const existing = snapshot({
      priceHistory: { A: [{ timestamp: dayStart, price: 1, volume: 1 }] },
      itemCount: 1,
    });
    const incoming = snapshot({
      priceHistory: { B: [{ timestamp: dayStart + DAY, price: 2, volume: 2 }] },
      itemCount: 1,
    });

    const { merged, addedHashes } = mergeParsedHistory(existing, incoming, LIMITS);
    expect(Object.keys(merged.priceHistory).sort()).toEqual(["A", "B"]);
    expect(addedHashes).toBe(1);
    expect(merged.version).toBe(2);
    expect(merged.currency).toBe(MARKET_VOLUME_BASE_CURRENCY);
    // 派生字段不在此合并，由调用方重算
    expect(merged.itemCount).toBe(1);
  });

  it("同一 UTC 天保留点数更多（更细粒度）的一侧，避免重复计数", () => {
    const dayStart = 20000 * DAY;
    const fine = Array.from({ length: 24 }, (_, i) => ({
      timestamp: dayStart + i * 3600,
      price: 1,
      volume: 1,
    }));
    const coarse = [{ timestamp: dayStart, price: 1, volume: 24 }];

    // incoming 更细 → 取 incoming
    const up = mergeParsedHistory(
      snapshot({ priceHistory: { A: coarse } }),
      snapshot({ priceHistory: { A: fine } }),
      LIMITS,
    );
    expect(up.merged.priceHistory.A).toHaveLength(24);
    expect(up.addedHashes).toBe(1);

    // incoming 更粗 → 保留 existing 的细粒度，不被降级
    const down = mergeParsedHistory(
      snapshot({ priceHistory: { A: fine } }),
      snapshot({ priceHistory: { A: coarse } }),
      LIMITS,
    );
    expect(down.merged.priceHistory.A).toHaveLength(24);
    expect(down.addedHashes).toBe(0);
  });

  it("幂等：同一份备份融合两次不翻倍", () => {
    const dayStart = 20000 * DAY;
    const fine = Array.from({ length: 24 }, (_, i) => ({
      timestamp: dayStart + i * 3600,
      price: 1,
      volume: 1,
    }));
    const incoming = snapshot({
      priceHistory: { A: fine },
      samples: [sample("2026-08-25T01:00:00Z", 1), sample("2026-08-25T02:00:00Z", 2)],
      liveHistory: {
        A: [
          { ts: 1000, volume: 10, median: 1 },
          { ts: 2000, volume: 20, median: 2 },
        ],
      },
    });

    const once = mergeParsedHistory(snapshot(), incoming, LIMITS);
    expect(once.addedSamples).toBe(2);
    expect(once.addedLivePoints).toBe(2);

    const twice = mergeParsedHistory(once.merged, incoming, LIMITS);
    expect(twice.merged.priceHistory.A).toHaveLength(24);
    expect(twice.merged.samples).toHaveLength(2);
    expect(twice.merged.liveHistory!.A).toHaveLength(2);
    expect(twice.addedHashes).toBe(0);
    expect(twice.addedSamples).toBe(0);
    expect(twice.addedLivePoints).toBe(0);
  });

  it("samples 按 timestamp、liveHistory 按 ts 去重，同键取 incoming 且升序", () => {
    const existing = snapshot({
      samples: [sample("2026-08-25T02:00:00Z", 2)],
      liveHistory: { A: [{ ts: 2000, volume: 20, median: 2 }] },
    });
    const incoming = snapshot({
      samples: [sample("2026-08-25T01:00:00Z", 1), sample("2026-08-25T02:00:00Z", 99)],
      liveHistory: {
        A: [{ ts: 1000, volume: 10, median: 1 }],
        B: [{ ts: 1000, volume: 5, median: 0.5 }],
      },
    });

    const { merged, addedSamples, addedLivePoints } = mergeParsedHistory(
      existing,
      incoming,
      LIMITS,
    );
    expect(merged.samples.map((s) => s.timestamp)).toEqual([
      "2026-08-25T01:00:00Z",
      "2026-08-25T02:00:00Z",
    ]);
    expect(merged.samples[1].total).toBe(99); // 同刻 incoming 覆盖
    expect(addedSamples).toBe(1);
    expect(merged.liveHistory!.A.map((p) => p.ts)).toEqual([1000, 2000]);
    expect(merged.liveHistory!.B).toHaveLength(1);
    expect(addedLivePoints).toBe(2);
  });

  it("按上限裁剪（保留最新）", () => {
    const existing = snapshot({
      samples: [sample("2026-08-25T01:00:00Z", 1), sample("2026-08-25T02:00:00Z", 2)],
      liveHistory: {
        A: [
          { ts: 1000, volume: 1, median: 1 },
          { ts: 2000, volume: 2, median: 2 },
        ],
      },
    });
    const { merged } = mergeParsedHistory(existing, snapshot(), {
      maxSamples: 1,
      maxLivePointsPerHash: 1,
    });
    expect(merged.samples.map((s) => s.timestamp)).toEqual(["2026-08-25T02:00:00Z"]);
    expect(merged.liveHistory!.A.map((p) => p.ts)).toEqual([2000]);
  });

  it("historyFetchedAtMs 取较大值、lastRefreshAt 逐 hash 取较大值", () => {
    const existing = snapshot({
      historyFetchedAtMs: 100,
      lastRefreshAt: { A: 100, B: 50 },
    });
    const incoming = snapshot({
      historyFetchedAtMs: 300,
      lastRefreshAt: { A: 10, C: 20 },
    });
    const { merged } = mergeParsedHistory(existing, incoming, LIMITS);
    expect(merged.historyFetchedAtMs).toBe(300);
    expect(merged.lastRefreshAt).toEqual({ A: 100, B: 50, C: 20 });
  });
});

describe("金额缩放（USD → 显示货币）", () => {
  const card = {
    hash: "A",
    name: "A",
    category: "COIN",
    level: null,
    gearType: null,
    materialType: null,
    total: 10,
    points: [{ hour: "2026-08-25T01:00:00Z", price: 2, volume: 5, total: 10 }],
  };

  it("rescaleMarketVolumeItems 缩放金额与走势价/额，但不缩放成交量", () => {
    const [out] = rescaleMarketVolumeItems([card], 7);
    expect(out.total).toBeCloseTo(70, 9);
    expect(out.points[0].price).toBeCloseTo(14, 9);
    expect(out.points[0].total).toBeCloseTo(70, 9);
    expect(out.points[0].volume).toBe(5);
    // 不改动入参
    expect(card.total).toBe(10);
    expect(card.points[0].price).toBe(2);
  });

  it("rescaleMarketVolumeItems 在 rate 无效时原样返回", () => {
    expect(rescaleMarketVolumeItems([card], 0)[0].total).toBe(10);
    expect(rescaleMarketVolumeItems([card], Number.NaN)[0].total).toBe(10);
    expect(rescaleMarketVolumeItems([card], -1)[0].total).toBe(10);
  });

  it("rescaleVolumeStats 缩放 latest / hourly 并改写 currency", () => {
    const stats: MarketVolumeStats = {
      latest: {
        timestamp: "2026-08-25T01:00:00Z",
        items: 1,
        total: 10,
        byCategory: { COIN: 10 },
        currency: MARKET_VOLUME_BASE_CURRENCY,
      },
      hourly: [
        { hour: "2026-08-25T01:00:00Z", total: 10, byCategory: { COIN: 10 } },
        { hour: "2026-08-25T02:00:00Z", total: 5 },
      ],
      itemCount: 2,
      itemCountsByCategory: { COIN: 2 },
      currency: MARKET_VOLUME_BASE_CURRENCY,
    };

    const out = rescaleVolumeStats(stats, 7, "CNY");
    expect(out.currency).toBe("CNY");
    expect(out.latest!.currency).toBe("CNY");
    expect(out.latest!.total).toBeCloseTo(70, 9);
    expect(out.latest!.byCategory.COIN).toBeCloseTo(70, 9);
    expect(out.hourly[0].total).toBeCloseTo(70, 9);
    expect(out.hourly[0].byCategory!.COIN).toBeCloseTo(70, 9);
    expect(out.hourly[1].total).toBeCloseTo(35, 9);
    // 原本缺失 byCategory 的点仍缺失（不补空对象）
    expect(out.hourly[1].byCategory).toBeUndefined();
    // 不改动入参
    expect(stats.latest!.total).toBe(10);
    expect(stats.currency).toBe(MARKET_VOLUME_BASE_CURRENCY);
  });
});

describe("detectCurrencyFromPriceHistory", () => {
  const fx = { USD: 1, CNY: 7.1, BRL: 5.4, JPY: 150 };
  const usdHistory = new Map<string, PriceHistoryPoint[]>([
    ["A", [{ timestamp: 1000, price: 1, volume: 1 }]],
    ["B", [{ timestamp: 1000, price: 2, volume: 1 }]],
    ["C", [{ timestamp: 1000, price: 5, volume: 1 }]],
  ]);
  const backupCny = new Map<string, PriceHistoryPoint[]>([
    ["A", [{ timestamp: 1000, price: 7.1, volume: 1 }]],
    ["B", [{ timestamp: 1000, price: 14.2, volume: 1 }]],
    ["C", [{ timestamp: 1000, price: 35.5, volume: 1 }]],
  ]);

  it("优先与现有 USD 价格历史比对（历史 vs 历史）识别 CN", () => {
    const d = detectCurrencyFromPriceHistory({
      fx,
      backupPriceHistory: backupCny,
      usdHistory,
    });
    expect(d.currency).toBe("CNY");
    expect(d.method).toBe("usdHistory");
    expect(d.samples).toBe(3);
    expect(d.rate).toBeCloseTo(1 / 7.1, 9);
    expect(d.relativeError).toBeLessThan(1e-6);
  });

  it("无 USD 历史时回退到 CI USD 快照当前价", () => {
    const d = detectCurrencyFromPriceHistory({
      fx,
      backupPriceHistory: backupCny,
      usdSnapshot: { A: 1, B: 2, C: 5 },
    });
    expect(d.currency).toBe("CNY");
    expect(d.method).toBe("usdSnapshot");
  });

  it("已以 USD 计的备份识别为 USD（rate=1）", () => {
    const d = detectCurrencyFromPriceHistory({
      fx,
      backupPriceHistory: usdHistory,
      usdSnapshot: { A: 1, B: 2, C: 5 },
    });
    expect(d.currency).toBe("USD");
    expect(d.rate).toBe(1);
  });

  it("与 USD 历史配对时取时间最接近的点", () => {
    const usdWithFar = new Map<string, PriceHistoryPoint[]>([
      ["A", [{ timestamp: 1000, price: 1, volume: 1 }]],
      // 近处有一个「USD 价」但其实不是同一时期，若取错点会算出 7.1/2 的错误比例
      ["B", [{ timestamp: 9000, price: 2, volume: 1 }]],
      ["C", [{ timestamp: 1000, price: 5, volume: 1 }]],
    ]);
    const d = detectCurrencyFromPriceHistory({
      fx,
      backupPriceHistory: backupCny,
      usdHistory: usdWithFar,
    });
    expect(d.currency).toBe("CNY");
    expect(d.impliedUnitsPerUsd).toBeCloseTo(7.1, 6);
  });

  it("样本不足时判定为「无法识别」并保留诊断信息", () => {
    const d = detectCurrencyFromPriceHistory({
      fx,
      backupPriceHistory: new Map([["A", [{ timestamp: 1000, price: 7.1, volume: 1 }]]]),
      usdSnapshot: { A: 1 },
    });
    expect(d.currency).toBeNull();
    expect(d.rate).toBeNull();
    expect(d.samples).toBe(1);
    expect(d.impliedUnitsPerUsd).toBeCloseTo(7.1, 6);
  });

  it("推算比例与汇率表都对不上时判定为「无法识别」", () => {
    // 备份价是 USD 的 3 倍，fx 表里最接近的是 USD(1)，相对误差 0.67 > 容差
    const backup = new Map<string, PriceHistoryPoint[]>([
      ["A", [{ timestamp: 1000, price: 3, volume: 1 }]],
      ["B", [{ timestamp: 1000, price: 6, volume: 1 }]],
      ["C", [{ timestamp: 1000, price: 15, volume: 1 }]],
    ]);
    const d = detectCurrencyFromPriceHistory({
      fx,
      backupPriceHistory: backup,
      usdSnapshot: { A: 1, B: 2, C: 5 },
    });
    expect(d.currency).toBeNull();
    expect(d.relativeError).toBeGreaterThan(0.15);
  });

  it("无任何参考源时返回空结果", () => {
    const d = detectCurrencyFromPriceHistory({ fx, backupPriceHistory: backupCny });
    expect(d).toMatchObject({ currency: null, method: null, samples: 0, rate: null });
  });

  it("报告次优候选以便提示歧义（NOK/SEK 这类量级接近的币种）", () => {
    const ambiguousFx = { USD: 1, NOK: 10.48, SEK: 10.4 };
    const backup = new Map<string, PriceHistoryPoint[]>([
      ["A", [{ timestamp: 1000, price: 10.45, volume: 1 }]],
      ["B", [{ timestamp: 1000, price: 20.9, volume: 1 }]],
      ["C", [{ timestamp: 1000, price: 52.25, volume: 1 }]],
    ]);
    const d = detectCurrencyFromPriceHistory({
      fx: ambiguousFx,
      backupPriceHistory: backup,
      usdSnapshot: { A: 1, B: 2, C: 5 },
    });
    expect(d.currency).toBe("NOK"); // 10.48 比 10.4 更接近 implied 10.45
    expect(d.runnerUp?.currency).toBe("SEK");
  });
});
