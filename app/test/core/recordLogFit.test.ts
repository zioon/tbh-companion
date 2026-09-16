import { describe, it, expect } from "vitest";
import { fitAcquireSources, FIT_WINDOW_SEC } from "../../src/core/recordLogFit";

describe("fitAcquireSources", () => {
  it("fits stage-clear lines by their own text prefix (no bucket data needed)", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "关卡", acquireRaw: "通关了关卡 3-10。(4秒)" }],
      [],
      [],
      [],
    );
    expect(out["1"]).toEqual({ source: "clear", stageLabel: "3-10" });
  });

  it("fits box-open content by exact item-name equality", () => {
    const out = fitAcquireSources(
      [
        { seq: 1, wallTime: 1000, acquireName: "永恒之弓", acquireRaw: "获得了永恒之弓。" },
        { seq: 2, wallTime: 1001, acquireName: "金币", acquireRaw: "获得金币 x10" },
      ],
      [],
      [{ wallTime: 1000.5, boxKey: "rare:3", itemName: "永恒之弓", grade: "RARE", count: 1 }],
      [],
    );
    expect(out["1"]).toEqual({ source: "open", boxKey: "rare:3", grade: "RARE" });
    // The gold line has no bucket event of its own nearby → unfitted.
    expect(out["2"]).toBeUndefined();
  });

  it("prefers the name-matched open over a nearer chest event", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "永恒之弓", acquireRaw: "获得了永恒之弓。" }],
      [{ wallTime: 1000.1, category: "rare" }],
      [{ wallTime: 1001, boxKey: "rare:2", itemName: "永恒之弓", grade: "RARE", count: 1 }],
      [],
    );
    expect(out["1"]).toEqual({ source: "open", boxKey: "rare:2", grade: "RARE" });
  });

  it("is count-aware: one open of N units covers a ×N line and N lines", () => {
    const burst = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "银锭", acquireCount: 3, acquireRaw: "×3" }],
      [],
      [{ wallTime: 1000, boxKey: "common", itemName: "银锭", grade: "COMMON", count: 3 }],
      [],
    );
    expect(burst["1"]).toEqual({ source: "open", boxKey: "common", grade: "COMMON" });

    const twoLines = fitAcquireSources(
      [
        { seq: 1, wallTime: 1000, acquireName: "银锭", acquireRaw: "a" },
        { seq: 2, wallTime: 1000.5, acquireName: "银锭", acquireRaw: "b" },
      ],
      [],
      [{ wallTime: 1000, boxKey: "common", itemName: "银锭", grade: "COMMON", count: 2 }],
      [],
    );
    expect(twoLines["1"]).toBeDefined();
    expect(twoLines["2"]).toBeDefined();

    // A third line finds the open's count exhausted → unfitted.
    const exhausted = fitAcquireSources(
      [
        { seq: 1, wallTime: 1000, acquireName: "银锭", acquireCount: 3, acquireRaw: "×3" },
        { seq: 2, wallTime: 1001, acquireName: "银锭", acquireRaw: "late" },
      ],
      [],
      [{ wallTime: 1000, boxKey: "common", itemName: "银锭", grade: "COMMON", count: 3 }],
      [],
    );
    expect(exhausted["1"]).toBeDefined();
    expect(exhausted["2"]).toBeUndefined();
  });

  it("fits chest lines by the nearest unused GetBox event", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "普通宝箱", acquireRaw: "获得了普通宝箱。" }],
      [{ wallTime: 1000.2, category: "common" }],
      [],
      [],
    );
    expect(out["1"]).toEqual({ source: "chest", chestCategory: "common" });
  });

  it("keeps non-chest lines from stealing chest events", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "金币", acquireRaw: "获得金币 x50" }],
      [{ wallTime: 1000, category: "rare" }],
      [],
      [],
    );
    expect(out["1"]).toBeUndefined();
  });

  it("consumes chest events: a second chest line stays unfitted", () => {
    const out = fitAcquireSources(
      [
        { seq: 1, wallTime: 1000, acquireName: "普通宝箱", acquireRaw: "a" },
        { seq: 2, wallTime: 1001, acquireName: "普通宝箱", acquireRaw: "b" },
      ],
      [{ wallTime: 1000, category: "common" }],
      [],
      [],
    );
    expect(out["1"]).toEqual({ source: "chest", chestCategory: "common" });
    expect(out["2"]).toBeUndefined();
  });

  it("falls back to open-by-time for content lines the name match missed", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "神秘粉末", acquireRaw: "获得了神秘粉末。" }],
      [],
      [{ wallTime: 1000.5, boxKey: "act", itemName: "其他名字", grade: null, count: 2 }],
      [],
    );
    expect(out["1"]).toEqual({ source: "open", boxKey: "act", grade: null });
  });

  it("falls back to clear-by-time for leftover lines near a clear", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "金币", acquireRaw: "Obtained 50 gold" }],
      [],
      [],
      [{ wallTime: 1000.5, stageKey: 310 }],
    );
    expect(out["1"]).toEqual({ source: "clear", stageKey: 310 });
  });

  it("picks the nearest candidate among several usable events", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "银锭", acquireRaw: "获得了银锭。" }],
      [],
      [
        { wallTime: 997, boxKey: "common", itemName: "银锭", grade: "COMMON", count: 1 },
        { wallTime: 1001, boxKey: "rare:1", itemName: "银锭", grade: "RARE", count: 1 },
      ],
      [],
    );
    expect(out["1"]?.boxKey).toBe("rare:1");
  });

  it("never fits beyond the window", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "神秘粉末", acquireRaw: "x" }],
      [
        {
          wallTime: 1000 + FIT_WINDOW_SEC + 0.5,
          category: "common" as const,
        },
      ],
      [
        {
          wallTime: 1000 + FIT_WINDOW_SEC + 0.5,
          boxKey: "common",
          itemName: "y",
          grade: null,
          count: 1,
        },
      ],
      [{ wallTime: 1000 + FIT_WINDOW_SEC + 0.5, stageKey: 1 }],
    );
    expect(out).toEqual({});
  });

  it("never fits bulk-replayed lines (their wallTime is the ingest moment)", () => {
    const out = fitAcquireSources(
      [
        {
          seq: 1,
          wallTime: 1000,
          acquireName: "普通宝箱",
          acquireRaw: "通关了关卡 3-10。(4秒)",
          bulk: true,
        },
      ],
      [{ wallTime: 1000, category: "common" }],
      [],
      [{ wallTime: 1000, stageKey: 310 }],
    );
    expect(out).toEqual({});
  });
});
