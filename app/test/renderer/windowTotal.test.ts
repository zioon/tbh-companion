import { describe, it, expect } from "vitest";
import type { MarketVolumeItem } from "../../shared/types";
import { windowTotalOf } from "../../src/renderer/lib/windowTotal";

function makeItem(overrides: Partial<MarketVolumeItem> = {}): MarketVolumeItem {
  return {
    hash: "item",
    name: "Item",
    category: "OTHER",
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
