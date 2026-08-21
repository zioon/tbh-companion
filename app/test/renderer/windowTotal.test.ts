import { describe, it, expect } from "vitest";
import type { MarketVolumeItem } from "../../shared/types";
import {
  downsampleByStep,
  sortItemsByWindowTotal,
  trendGranularityHours,
  windowTotalOf,
} from "../../src/renderer/lib/windowTotal";

function makeItem(overrides: Partial<MarketVolumeItem> = {}): MarketVolumeItem {
  return {
    hash: "item",
    name: "Item",
    category: "OTHER",
    level: null,
    gearType: null,
    materialType: null,
    total: 100,
    points: [],
    ...overrides,
  };
}

const RANGE = { start: "2026-08-13T10:00:00.000Z", end: "2026-08-13T12:00:00.000Z" };

describe("windowTotalOf", () => {
  it("未指定窗口时返回全量 total", () => {
    const item = makeItem({ total: 100 });
    expect(windowTotalOf(item, null)).toBe(100);
    expect(windowTotalOf(item, undefined)).toBe(100);
  });

  it("history 卡片在窗口内对各小时 total 求和", () => {
    const item = makeItem({
      points: [
        { hour: "2026-08-13T10:00:00.000Z", price: 1, volume: 10, total: 10 },
        { hour: "2026-08-13T11:00:00.000Z", price: 1, volume: 20, total: 20 },
        { hour: "2026-08-13T12:00:00.000Z", price: 1, volume: 30, total: 30 },
      ],
    });
    expect(windowTotalOf(item, RANGE)).toBe(60);
  });

  it("history 卡片在区间内无点时返回 0，而非回退全量 total", () => {
    const item = makeItem({
      total: 100,
      points: [
        { hour: "2026-08-10T10:00:00.000Z", price: 1, volume: 50, total: 50 },
        { hour: "2026-08-10T11:00:00.000Z", price: 1, volume: 50, total: 50 },
      ],
    });
    expect(windowTotalOf(item, RANGE)).toBe(0);
  });

  it("live 卡片在窗口内取最新采样点 total", () => {
    const item = makeItem({
      kind: "live",
      points: [
        { hour: "2026-08-13T10:00:00.000Z", price: 1, volume: 10, total: 10 },
        { hour: "2026-08-13T11:00:00.000Z", price: 1, volume: 20, total: 20 },
        { hour: "2026-08-13T12:00:00.000Z", price: 1, volume: 30, total: 30 },
      ],
    });
    expect(windowTotalOf(item, RANGE)).toBe(30);
  });

  it("live 卡片在区间内无点时返回 0", () => {
    const item = makeItem({
      kind: "live",
      total: 100,
      points: [{ hour: "2026-08-10T10:00:00.000Z", price: 1, volume: 50, total: 50 }],
    });
    expect(windowTotalOf(item, RANGE)).toBe(0);
  });
});

describe("sortItemsByWindowTotal", () => {
  const H = (day: number, hour: number) => new Date(Date.UTC(2026, 7, day, hour)).toISOString();
  const range = { start: H(13, 0), end: H(13, 1) };

  it("按窗口内成交额降序排列，不修改原数组", () => {
    const items = [
      makeItem({
        hash: "low",
        total: 999,
        points: [
          { hour: H(13, 0), price: 1, volume: 10, total: 10 },
          { hour: H(13, 1), price: 1, volume: 10, total: 10 },
        ],
      }),
      makeItem({
        hash: "high",
        total: 10,
        points: [
          { hour: H(13, 0), price: 1, volume: 100, total: 100 },
          { hour: H(13, 1), price: 1, volume: 100, total: 100 },
        ],
      }),
    ];
    const original = items.slice();
    const sorted = sortItemsByWindowTotal(items, range);
    // 窗口额：low=20 < high=200，即使全量 total 相反也应 high 在前
    expect(sorted.map((i) => i.hash)).toEqual(["high", "low"]);
    expect(items).toEqual(original);
  });

  it("窗口为空（null）时回退到全量 total 降序", () => {
    const items = [makeItem({ hash: "small", total: 5 }), makeItem({ hash: "big", total: 500 })];
    const sorted = sortItemsByWindowTotal(items, null);
    expect(sorted.map((i) => i.hash)).toEqual(["big", "small"]);
  });

  it("窗口内无任何点（区间外）的物品按 0 排最后", () => {
    const items = [
      makeItem({
        hash: "outside",
        total: 999,
        points: [{ hour: H(10, 0), price: 1, volume: 50, total: 50 }],
      }),
      makeItem({
        hash: "inside",
        total: 1,
        points: [{ hour: H(13, 0), price: 1, volume: 30, total: 30 }],
      }),
    ];
    const sorted = sortItemsByWindowTotal(items, range);
    expect(sorted.map((i) => i.hash)).toEqual(["inside", "outside"]);
  });

  it("live 卡片按窗口内最新采样点 total 排序", () => {
    const items = [
      makeItem({
        hash: "liveLow",
        kind: "live",
        total: 10,
        points: [{ hour: H(13, 1), price: 1, volume: 10, total: 10 }],
      }),
      makeItem({
        hash: "liveHigh",
        kind: "live",
        total: 300,
        points: [{ hour: H(13, 1), price: 1, volume: 300, total: 300 }],
      }),
    ];
    const sorted = sortItemsByWindowTotal(items, range);
    expect(sorted.map((i) => i.hash)).toEqual(["liveHigh", "liveLow"]);
  });
});

describe("trendGranularityHours", () => {
  it("点数未超过上限时不降采样，粒度为 1 小时", () => {
    expect(trendGranularityHours(24, 120)).toBe(1);
    expect(trendGranularityHours(1, 120)).toBe(1);
  });

  it("1 周窗口（168 点）向上归一到 2 小时档位", () => {
    expect(trendGranularityHours(168, 120)).toBe(2);
  });

  it("1 月窗口（720 点）归一到 6 小时档位", () => {
    expect(trendGranularityHours(720, 120)).toBe(6);
  });

  it("向上归一到有意义档位：12h / 1d / 2d / 7d", () => {
    expect(trendGranularityHours(1440, 120)).toBe(12);
    expect(trendGranularityHours(2880, 120)).toBe(24);
    expect(trendGranularityHours(5760, 120)).toBe(48);
    expect(trendGranularityHours(10000, 120)).toBe(168);
  });

  it("点数不足 2 个或上限为 1 时返回 1，避免除零", () => {
    expect(trendGranularityHours(0, 120)).toBe(1);
    expect(trendGranularityHours(1, 1)).toBe(1);
    expect(trendGranularityHours(100, 1)).toBe(1);
  });
});

describe("downsampleByStep", () => {
  it("步长为 1 或点数不足时返回全量", () => {
    expect(downsampleByStep([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(downsampleByStep([1], 2)).toEqual([1]);
  });

  it("步长 2 抽样：相邻索引差恒等于 2，保留最新点", () => {
    const arr = Array.from({ length: 168 }, (_, i) => i);
    const out = downsampleByStep(arr, 2);
    expect(out).toHaveLength(84);
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBe(2);
    }
    expect(out[out.length - 1]).toBe(167);
  });

  it("步长 6 抽样：相邻索引差恒等于 6", () => {
    const arr = Array.from({ length: 720 }, (_, i) => i);
    const out = downsampleByStep(arr, 6);
    expect(out).toHaveLength(120);
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBe(6);
    }
  });
});
