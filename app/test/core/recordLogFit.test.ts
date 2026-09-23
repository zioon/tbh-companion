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

  // -------------------------------------------------------------------------
  // Hero life-event notices. Real archive data (2026-09-21, live v1.2.4 Boss
  // run): a death lands 0.627 s before the clear line that follows it, i.e.
  // inside FIT_WINDOW_SEC, so pass 4's clear-by-nearest-time fallback used to
  // claim it and the UI badged "牧师被击败了。(木乃伊)" as 通关.
  // -------------------------------------------------------------------------

  it("never fits a hero death line, even when a clear event sits inside the window", () => {
    const out = fitAcquireSources(
      [
        {
          seq: 6,
          wallTime: 1789990881.34,
          acquireName: "牧师",
          acquireCount: 1,
          acquireRaw: "牧师被击败了。(木乃伊)",
          acquireColor: "#7030A5",
        },
      ],
      [],
      [],
      [{ wallTime: 1789990881.967, stageKey: 309 }],
    );
    expect(out["6"]).toBeUndefined();
  });

  it("never fits a hero line via the purple tint alone (no template wording)", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "牧师", acquireRaw: "x", acquireColor: "#7030a5" }],
      [{ wallTime: 1000, category: "common" }],
      [{ wallTime: 1000, boxKey: "rare:1", itemName: "y", grade: null, count: 1 }],
      [{ wallTime: 1000, stageKey: 1 }],
    );
    expect(out).toEqual({});
  });

  it("never fits hero lines by wording alone (tint absent on legacy rows)", () => {
    for (const raw of [
      "剑士阵亡了。(骷髅王)",
      "牧师复活了。(木乃伊)",
      "弓手升级了。",
      "法师觉醒了。",
    ]) {
      const out = fitAcquireSources(
        [{ seq: 1, wallTime: 1000, acquireName: "英雄", acquireRaw: raw }],
        [],
        [],
        [{ wallTime: 1000, stageKey: 1 }],
      );
      expect(out, raw).toEqual({});
    }
  });

  it("still fits the real clear line next to an excluded hero death line", () => {
    // The pair from the live archive — only the death line is suppressed.
    const out = fitAcquireSources(
      [
        {
          seq: 6,
          wallTime: 1789990881.34,
          acquireName: "牧师",
          acquireCount: 1,
          acquireRaw: "牧师被击败了。(木乃伊)",
          acquireColor: "#7030A5",
        },
        {
          seq: 7,
          wallTime: 1789990881.967,
          acquireName: "关卡 3-9",
          acquireCount: 1,
          acquireRaw: "通关了关卡 3-9。(73秒)",
          acquireColor: "#A69255",
        },
      ],
      [],
      [],
      [{ wallTime: 1789990881.967, stageKey: 309 }],
    );
    expect(out["6"]).toBeUndefined();
    expect(out["7"]).toEqual({ source: "clear", stageLabel: "3-9" });
  });

  it("leaves an ordinary reward line next to a clear still fittable", () => {
    const out = fitAcquireSources(
      [{ seq: 1, wallTime: 1000, acquireName: "金币", acquireRaw: "获得金币 x50" }],
      [],
      [],
      [{ wallTime: 1000.5, stageKey: 310 }],
    );
    expect(out["1"]).toEqual({ source: "clear", stageKey: 310 });
  });

  // -------------------------------------------------------------------------
  // Offering ("祈愿结果") lines — Wish v2 P0-5. A wish lands close in time to a
  // stage clear, so pass 4's clear-by-nearest-time fallback would claim it and
  // the UI would badge it "通关". The renderer's `!fit` branch already has a
  // "wish" text bucket, so the fix is to keep the line UNFITTED at the fit
  // layer (same discipline as isHeroNotice). `ringSeq` uses a high unique index
  // (900000+) so these fixtures never pollute the real archive dedupe set.
  // -------------------------------------------------------------------------

  it("never fits an offering line, even when a clear event sits inside the window", () => {
    const out = fitAcquireSources(
      [
        {
          seq: 900001,
          wallTime: 1000,
          acquireName: "木盾",
          acquireCount: 1,
          acquireRaw: "祈愿结果：获得 木盾",
        },
      ],
      [],
      [],
      [{ wallTime: 1000.4, stageKey: 310 }],
    );
    expect(out["900001"]).toBeUndefined();
    expect(out).toEqual({});
  });

  it("never fits an offering line via nearest open / chest either", () => {
    const out = fitAcquireSources(
      [
        {
          seq: 900002,
          wallTime: 1000,
          acquireName: "永恒手套",
          acquireCount: 1,
          acquireRaw: "祈愿结果：获得 永恒手套",
        },
      ],
      [{ wallTime: 1000.1, category: "rare" }],
      [{ wallTime: 1000.2, boxKey: "rare:3", itemName: "永恒手套", grade: "ARCANA", count: 1 }],
      [{ wallTime: 1000.3, stageKey: 310 }],
    );
    expect(out["900002"]).toBeUndefined();
  });

  it("still fits the real clear line next to an excluded offering line", () => {
    const out = fitAcquireSources(
      [
        {
          seq: 900003,
          wallTime: 1000,
          acquireName: "木盾",
          acquireCount: 1,
          acquireRaw: "祈愿结果：获得 木盾",
        },
        {
          seq: 900004,
          wallTime: 1000.4,
          acquireName: "关卡 3-9",
          acquireCount: 1,
          acquireRaw: "通关了关卡 3-9。(73秒)",
          acquireColor: "#A69255",
        },
      ],
      [],
      [],
      [{ wallTime: 1000.4, stageKey: 309 }],
    );
    expect(out["900003"]).toBeUndefined();
    expect(out["900004"]).toEqual({ source: "clear", stageLabel: "3-9" });
  });

  it("excludes offering lines across all four client languages (isWishLine)", () => {
    for (const raw of [
      "祈愿结果：获得 木盾",
      "祈願結果：獲得 木盾",
      "Offering result: obtained Wooden Shield",
      "기원 결과: 획득 목방패",
    ]) {
      const out = fitAcquireSources(
        [{ seq: 900005, wallTime: 1000, acquireName: "x", acquireRaw: raw }],
        [],
        [],
        [{ wallTime: 1000.3, stageKey: 310 }],
      );
      expect(out, raw).toEqual({});
    }
  });

  it("does NOT exclude a craft/synthesis result line (only offering is gated)", () => {
    const out = fitAcquireSources(
      [{ seq: 900006, wallTime: 1000, acquireName: "剑", acquireRaw: "制作结果：获得 剑" }],
      [],
      [],
      [{ wallTime: 1000.3, stageKey: 310 }],
    );
    expect(out["900006"]).toEqual({ source: "clear", stageKey: 310 });
  });
});
