// 独立回归对抗测试（第二层 QA —— 严过关，Wish v2）。
//
// 与工程自测（wishCoinDiff / wishCoinCandidates / wishTracker / recordLogFit）*
// 刻意不同*：这里只从「不变量被攻破」的角度构造用例，尤其是 R1「绝不虚构
// coinKey」。任何一条失败都意味着源码缺陷（除非断言本身写错）。
//
// 约定：
//   - 帧数据一律手写 `Map<number, number>`（10 枚 coinKey），不走真实存档；
//   - 涉及 record_log 的用例使用高位唯一 `ringSeq`（900000+），避免污染真实归档；
//   - 纯 core，无 electron / fs / React。

import { describe, expect, it } from "vitest";
import type {
  CoinAttributionConfidence,
  WishCoinAttribution,
  WishHistoryEntry,
  WishGrade,
} from "../../shared/types";
import { WISH_COIN_KEYS } from "../../shared/types";
import { attributeCoinByDiff } from "../../src/core/wish/coinDiff";
import { inferCoinCandidates, type CoinCandidateDeps } from "../../src/core/wish/coinCandidates";
import { coinGroupsFromHistory } from "../../src/core/wish/coinGroups";
import { WishCoinDiffWindow } from "../../src/core/wish/coinDiffWindow";
import {
  WISH_COIN_GRADE_FALLBACK,
  WISH_DIFF_TOLERANCE_FACTOR,
} from "../../src/core/wish/constants";
import { buildNameIndex } from "../../src/core/lookup/nameIndex";
import type { OfferingsModel } from "../../src/core/lookup/types";
import { fitAcquireSources, type AcquireFitInput } from "../../src/core/recordLogFit";
import { isWishLine, parseWishLine } from "../../src/core/wishLine";
import { WishTracker } from "../../src/core/wishTracker";

// ---------------------------------------------------------------------------
// 工具：构造 10 枚硬币的帧快照
// ---------------------------------------------------------------------------

/** 构造 materialStacks 快照（默认全 0，可覆盖指定 coinKey）。 */
function frame(overrides: Record<number, number> = {}): Map<number, number> {
  const m = new Map<number, number>();
  for (const k of WISH_COIN_KEYS) m.set(k, 0);
  for (const [k, v] of Object.entries(overrides)) m.set(Number(k), v);
  return m;
}

/**
 * R1 核心护栏：`coinKey` 非 null **当且仅当** `confidence === "observed"`。
 * 这才是「绝不虚构 coinKey」的精确表述 —— unknown/inferred 必须 coinKey === null。
 */
function assertNoFabrication(attr: WishCoinAttribution, label: string): void {
  if (attr.confidence === "observed") {
    expect(attr.coinKey, `${label}: observed 必须带 coinKey`).not.toBeNull();
  } else {
    expect(attr.coinKey, `${label}: 非 observed 绝不带 coinKey`).toBeNull();
  }
}

// 手写一份 offerings loot 表，用于 candidates。
// OfferingsModel = OfferingEntry[]，OfferingEntry = { coinKey, goldCost,
// unlockCubeLevel, loot: { itemKey, poolPct }[] }（见 shared/types.ts）。
// 这里不 import 数据文件，符合 I9「core 不 import 数据」。
function makeOfferingsModel(
  loot: Array<{ itemKey: number; coinKey: number; poolPct: number }>,
): OfferingsModel {
  const byCoin = new Map<number, { itemKey: number; poolPct: number }[]>();
  for (const l of loot) {
    const arr = byCoin.get(l.coinKey) ?? [];
    arr.push({ itemKey: l.itemKey, poolPct: l.poolPct });
    byCoin.set(l.coinKey, arr);
  }
  return [...byCoin.entries()].map(([coinKey, entries]) => ({
    coinKey,
    goldCost: 0,
    unlockCubeLevel: 0,
    loot: entries,
  }));
}

const depsWith = (
  nameToItemKey: (n: string) => number | undefined,
  offerings: OfferingsModel | null,
): CoinCandidateDeps => ({ nameToItemKey, offerings });

// ===========================================================================
// R1 —— 攻击「绝不虚构 coinKey」（最高优先级）
// ===========================================================================

describe("R1 绝不虚构 coinKey（对抗）", () => {
  it("R1-a 单枚减少 + 窗内 → observed（唯二可 observed 的路径）", () => {
    const out = attributeCoinByDiff(frame({ 160007: 3 }), frame({ 160007: 2 }), {
      wallTime: 1000,
      beforeAt: 998,
      afterAt: 1002,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("observed");
    expect(out.coinKey).toBe(160007);
    expect(out.candidates).toEqual([]);
    assertNoFabrication(out, "R1-a");
  });

  it("R1-b 多枚同时减少 → unknown，coinKey 必须为 null（不可就近猜）", () => {
    const out = attributeCoinByDiff(
      frame({ 160001: 2, 160009: 5, 160003: 1 }),
      frame({ 160001: 1, 160009: 4, 160003: 1 }),
      { wallTime: 1000, beforeAt: 998, afterAt: 1002, toleranceSec: 7.5 },
    );
    // 2 枚减少 → 不可归因到任一。
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.candidates).toEqual([]);
    expect(out.basis).toBe("multi-coin");
    assertNoFabrication(out, "R1-b");
  });

  it("R1-c 无帧（before=null / after=null / 双 null）→ unknown", () => {
    for (const [before, after] of [
      [null, frame({ 160001: 1 })],
      [frame({ 160001: 2 }), null],
      [null, null],
    ] as const) {
      const out = attributeCoinByDiff(before, after, {
        wallTime: 1000,
        beforeAt: null,
        afterAt: 1005,
        toleranceSec: 7.5,
      });
      expect(out.confidence).toBe("unknown");
      expect(out.coinKey).toBeNull();
      assertNoFabrication(out, "R1-c");
    }
  });

  it("R1-d 事件时刻越窗（含左右边界外）→ unknown", () => {
    // 窗 = [998-7.5, 1002+7.5] = [990.5, 1009.5]
    const before = frame({ 160004: 2 });
    const after = frame({ 160004: 1 });
    for (const wallTime of [990.49, 1009.51, 5000, -100]) {
      const out = attributeCoinByDiff(before, after, {
        wallTime,
        beforeAt: 998,
        afterAt: 1002,
        toleranceSec: 7.5,
      });
      expect(out.confidence, `wallTime=${wallTime}`).toBe("unknown");
      expect(out.coinKey).toBeNull();
      expect(out.basis).toBe("out-of-window");
      assertNoFabrication(out, `R1-d ${wallTime}`);
    }
  });

  it("R1-d2 恰在窗边界（含端点）仍 observed（边界包含语义）", () => {
    const before = frame({ 160004: 2 });
    const after = frame({ 160004: 1 });
    for (const wallTime of [990.5, 1009.5]) {
      const out = attributeCoinByDiff(before, after, {
        wallTime,
        beforeAt: 998,
        afterAt: 1002,
        toleranceSec: 7.5,
      });
      expect(out.confidence, `boundary wallTime=${wallTime}`).toBe("observed");
      expect(out.coinKey).toBe(160004);
    }
  });

  it("R1-d3 边界再外 0.001s → unknown（排除 >= vs > 的 off-by-one）", () => {
    const before = frame({ 160004: 2 });
    const after = frame({ 160004: 1 });
    for (const wallTime of [990.4999, 1009.5001]) {
      const out = attributeCoinByDiff(before, after, {
        wallTime,
        beforeAt: 998,
        afterAt: 1002,
        toleranceSec: 7.5,
      });
      expect(out.confidence, `just-outside wallTime=${wallTime}`).toBe("unknown");
    }
  });

  it("R1-e bulk 行 → unknown（basis bulk-skip），绝不 observed", () => {
    const out = attributeCoinByDiff(frame({ 160001: 5 }), frame({ 160001: 4 }), {
      wallTime: 1000,
      bulk: true,
      beforeAt: 998,
      afterAt: 1002,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.basis).toBe("bulk-skip");
    assertNoFabrication(out, "R1-e");
  });

  it("R1-f 帧时刻缺失（beforeAt/afterAt 为 null）→ unknown（不可跳窗）", () => {
    const out = attributeCoinByDiff(frame({ 160001: 5 }), frame({ 160001: 4 }), {
      wallTime: 1000,
      beforeAt: null,
      afterAt: null,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.basis).toBe("no-frame-time");
  });

  it("R1-g candidates 命中 → inferred，coinKey 仍必须为 null（候选≠实证）", () => {
    const offerings = makeOfferingsModel([{ itemKey: 7001, coinKey: 160003, poolPct: 0.4 }]);
    const out = inferCoinCandidates(
      "神秘护符",
      depsWith((n) => (n === "神秘护符" ? 7001 : undefined), offerings),
    );
    expect(out.confidence).toBe("inferred");
    expect(out.coinKey).toBeNull();
    expect(out.candidates.length).toBeGreaterThan(0);
    assertNoFabrication(out, "R1-g");
  });

  it("R1-h candidates miss（无 itemKey / 无 offerings / 无候选）→ unknown + 空候选", () => {
    const missNoKey = inferCoinCandidates(
      "不存在之物",
      depsWith(() => undefined, makeOfferingsModel([])),
    );
    expect(missNoKey.confidence).toBe("unknown");
    expect(missNoKey.coinKey).toBeNull();
    expect(missNoKey.candidates).toEqual([]);

    const missNoOff = inferCoinCandidates(
      "神秘护符",
      depsWith(() => 7001, null),
    );
    expect(missNoOff.confidence).toBe("unknown");
    expect(missNoOff.candidates).toEqual([]);

    const missNoCand = inferCoinCandidates(
      "神秘护符",
      depsWith(() => 7001, makeOfferingsModel([{ itemKey: 8888, coinKey: 160003, poolPct: 0.4 }])),
    );
    expect(missNoCand.confidence).toBe("unknown");
    expect(missNoCand.coinKey).toBeNull();
    expect(missNoCand.candidates).toEqual([]);
  });

  it("R1-i 反向验证：枚举所有非 observed 输出，断言 coinKey 恒 null", () => {
    const cases: Array<
      [
        ReadonlyMap<number, number> | null,
        ReadonlyMap<number, number> | null,
        Parameters<typeof attributeCoinByDiff>[2],
      ]
    > = [
      [null, null, { wallTime: 1, beforeAt: null, afterAt: null }],
      [frame({ 160001: 1 }), null, { wallTime: 1, beforeAt: 0, afterAt: 1 }],
      [null, frame({ 160001: 1 }), { wallTime: 1, beforeAt: 0, afterAt: 1 }],
      [
        frame({ 160001: 1, 160002: 1 }),
        frame({ 160001: 0, 160002: 0 }),
        { wallTime: 1, beforeAt: 0, afterAt: 1 },
      ],
      [frame({ 160001: 1 }), frame({ 160001: 1 }), { wallTime: 1, beforeAt: 0, afterAt: 1 }],
      [
        frame({ 160001: 1 }),
        frame({ 160001: 0 }),
        { wallTime: 99, beforeAt: 0, afterAt: 1, toleranceSec: 0.1 },
      ],
      [
        frame({ 160001: 1 }),
        frame({ 160001: 0 }),
        { wallTime: 1, bulk: true, beforeAt: 0, afterAt: 1 },
      ],
      [frame({ 160001: 1 }), frame({ 160001: 0 }), { wallTime: 1, beforeAt: null, afterAt: null }],
    ];
    for (const [b, a, opts] of cases) {
      const out = attributeCoinByDiff(b, a, opts);
      if (out.confidence !== "observed") {
        expect(out.coinKey, JSON.stringify(opts)).toBeNull();
      }
    }
  });

  it("R1-j coinKey 输出恒属于闭集 WISH_COIN_KEYS", () => {
    const out = attributeCoinByDiff(frame({ 160010: 2 }), frame({ 160010: 1 }), {
      wallTime: 1000,
      beforeAt: 998,
      afterAt: 1002,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("observed");
    expect(WISH_COIN_KEYS).toContain(out.coinKey as number);
  });
});

// ===========================================================================
// R1-window —— 差分窗口 bracket 语义
// ===========================================================================

describe("R1-window WishCoinDiffWindow bracket（对抗）", () => {
  it("只保留最近 2 帧", () => {
    const w = new WishCoinDiffWindow();
    w.push({ at: 1, stacks: frame() });
    w.push({ at: 2, stacks: frame() });
    w.push({ at: 3, stacks: frame() });
    expect(w.size()).toBe(2);
  });

  it("乱序 push 仍按 at 去取 before/after", () => {
    const w = new WishCoinDiffWindow();
    w.push({ at: 1005, stacks: frame({ 160001: 4 }) });
    w.push({ at: 995, stacks: frame({ 160001: 5 }) });
    const br = w.bracket(1000);
    expect(br.beforeAt).toBe(995);
    expect(br.afterAt).toBe(1005);
    expect(br.before?.get(160001)).toBe(5);
    expect(br.after?.get(160001)).toBe(4);
  });

  it("wallTime 恰等于某帧 at → 该帧算 before，不算 after（<= 语义）", () => {
    const w = new WishCoinDiffWindow();
    w.push({ at: 1000, stacks: frame({ 160001: 5 }) });
    w.push({ at: 1005, stacks: frame({ 160001: 4 }) });
    const br = w.bracket(1000);
    expect(br.beforeAt).toBe(1000);
    expect(br.afterAt).toBe(1005);
  });

  it("无 framed → before/after 均 null", () => {
    const w = new WishCoinDiffWindow();
    const br = w.bracket(1000);
    expect(br.before).toBeNull();
    expect(br.after).toBeNull();
    expect(br.beforeAt).toBeNull();
    expect(br.afterAt).toBeNull();
  });

  it("reset 清空", () => {
    const w = new WishCoinDiffWindow();
    w.push({ at: 1, stacks: frame() });
    w.reset();
    expect(w.size()).toBe(0);
    expect(w.bracket(1).before).toBeNull();
  });

  it("非有限 at 被忽略", () => {
    const w = new WishCoinDiffWindow();
    w.push({ at: Number.NaN, stacks: frame() });
    w.push({ at: Number.POSITIVE_INFINITY, stacks: frame() });
    expect(w.size()).toBe(0);
  });
});

// ===========================================================================
// R2 —— 记录页祈愿行归因（不得被任何 recordLogFit pass 认领）
// ===========================================================================

describe("R2 记录页祈愿行不得被 recordLogFit 认领（对抗）", () => {
  // 真实归档实证样本（%APPDATA%/tbh-companion/record_log.json）。
  const REAL_WISH_RAW = "祈愿结果：获得 木盾";
  const ADJACENT_CLEAR_RAW = "通关了关卡 3-9。(73秒)";

  it("R2-a 祈愿行 sourceFit 为空（4 语言前缀 + 结构兜底）", () => {
    const raws = [
      "祈愿结果：获得 木盾", // zh-CN
      "祈願結果：獲得 木盾", // zh-Hant / ja
      "Offering result: obtained 木盾。", // en
      "기원 결과: 획득 木盾", // ko
    ];
    const acquires: AcquireFitInput[] = raws.map((raw, i) => ({
      seq: 900001 + i,
      wallTime: 1789999851.607 + i,
      acquireName: "木盾",
      acquireRaw: raw,
    }));
    // 放一个 0.6s 后的通关事件 —— Pass 4 若未被排除必然认领。
    const clears = [{ wallTime: 1789999852.234, stageKey: 39 }];
    const out = fitAcquireSources(acquires, [], [], clears);
    for (const a of acquires) {
      expect(out[String(a.seq)], `${a.acquireRaw} 不应被认领`).toBeUndefined();
    }
  });

  it("R2-b 祈愿行 + 相邻通关行（0.627s）→ 祈愿行空、通关行仍即时归", () => {
    const wish: AcquireFitInput = {
      seq: 900010,
      wallTime: 1789999881.34,
      acquireName: "木盾",
      acquireRaw: REAL_WISH_RAW,
    };
    const clear: AcquireFitInput = {
      seq: 900011,
      wallTime: 1789999881.967, // +0.627s（§23.4 实测间隙）
      acquireRaw: ADJACENT_CLEAR_RAW,
    };
    const out = fitAcquireSources(
      [wish, clear],
      [],
      [],
      [{ wallTime: 1789999881.967, stageKey: 39 }],
    );
    expect(out[String(wish.seq)], "祈愿行必须空").toBeUndefined();
    expect(out[String(clear.seq)]?.source, "通关行仍应即时归").toBe("clear");
  });

  it("R2-b2 【真实归档实证】seq=363 祈愿行距通关行仅 0.292s → 仍不被认领", () => {
    // 从本机 %APPDATA%/tbh-companion/record_log.json 实测（4193 条）：
    //   seq=363 wall=1789999851.607 raw=祈愿结果：获得 木盾
    //   seq=364（通关行）距祈愿行仅 0.292s —— 若无 wish 排除，Pass 4 必抢占。
    const wish: AcquireFitInput = {
      seq: 900363,
      wallTime: 1789999851.607,
      acquireName: "木盾",
      acquireRaw: "祈愿结果：获得 木盾",
    };
    const clear: AcquireFitInput = {
      seq: 900364,
      wallTime: 1789999851.899, // +0.292s
      acquireRaw: ADJACENT_CLEAR_RAW,
    };
    // 同一通关事件对两行均在 8s 窗内。
    const out = fitAcquireSources(
      [wish, clear],
      [],
      [],
      [{ wallTime: 1789999851.899, stageKey: 39 }],
    );
    expect(out[String(wish.seq)], "祈愿行必须落 wish 桶（不被认领）").toBeUndefined();
    expect(out[String(clear.seq)]?.source, "0.292s 外的通关行仍归 clear").toBe("clear");
  });

  it("R2-b3 【真实归档实证】seq=3432 祈愿行（永恒手套）→ 不被认领", () => {
    const wish: AcquireFitInput = {
      seq: 900432,
      wallTime: 1790100949.548,
      acquireName: "永恒手套",
      acquireRaw: "祈愿结果：获得 永恒手套",
    };
    const out = fitAcquireSources([wish], [], [], [{ wallTime: 1790100960.21, stageKey: 12 }]);
    expect(out[String(wish.seq)]).toBeUndefined();
  });

  it("R2-c 祈愿行不会被 Pass 2（宝箱）误认领（名字像宝箱也无效）", () => {
    const wish: AcquireFitInput = {
      seq: 900020,
      wallTime: 1000,
      acquireName: "宝箱", // 极端：物品名含"宝箱"字样
      acquireRaw: "祈愿结果：获得 宝箱",
    };
    const out = fitAcquireSources(
      [wish],
      [{ wallTime: 1000.5, category: "stage" as never }],
      [],
      [],
    );
    expect(out[String(wish.seq)]).toBeUndefined();
  });

  it("R2-d 祈愿行不会被 Pass 1/3（开启）误认领（名字命中开启物品）", () => {
    const wish: AcquireFitInput = {
      seq: 900030,
      wallTime: 1000,
      acquireName: "永恒手套",
      acquireRaw: "祈愿结果：获得 永恒手套",
    };
    const opens = [{ wallTime: 1000.2, boxKey: "box:1", itemName: "永恒手套", count: 1 }];
    const out = fitAcquireSources([wish], [], opens, []);
    expect(out[String(wish.seq)]).toBeUndefined();
  });

  it("R2-e isWishLine 跨语言识别（4 语言显式白名单）", () => {
    expect(isWishLine("祈愿结果：获得 木盾")).toBe(true);
    expect(isWishLine("祈願結果：獲得 木盾")).toBe(true);
    expect(isWishLine("Offering result: obtained Wood Shield. ")).toBe(true);
    expect(isWishLine("기원 결과: 획득 목방패")).toBe(true);
    // 结构兜底（未知语言）：冒号 + 富文本 + 获得动词。
    expect(isWishLine("Zzz result: 获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(true);
  });

  it("R2-f isWishLine 零误判：其他结果类 / 普通获得行不判真", () => {
    // 排除表优先。
    expect(isWishLine("制作结果：获得 <color=#D7D7D7>木盾</color>。")).toBe(false);
    expect(isWishLine("合成结果：获得 <color=#D7D7D7>木盾</color>。")).toBe(false);
    expect(isWishLine("炼金结果：获得 <color=#D7D7D7>木盾</color>。")).toBe(false);
    // 普通获得行（无冒号 → 结构兜底不命中）。
    expect(isWishLine("获得了<color=#D7D7D7>木盾</color>。")).toBe(false);
    // 通关行不是祈愿行。
    expect(isWishLine("通关了关卡 3-9。(73秒)")).toBe(false);
    // 英雄生命事件不是祈愿行。
    expect(isWishLine("牧师被击败了。(木乃伊)")).toBe(false);
    // 空行。
    expect(isWishLine("")).toBe(false);
  });

  it("R2-g 真实祈愿行解析：名称/件数符合归档形态", () => {
    const item = parseWishLine("祈愿结果：获得 木盾");
    expect(item).not.toBeNull();
    expect(item?.name).toBe("木盾");
    expect(item?.count).toBe(1);
  });

  it("R2-h 英雄行 5 项护栏未被 wish 排除逻辑破坏（回归）", () => {
    // §23.4 实测：英雄死亡行 0.627s 早于通关行；若被 Pass 4 认领会误标"通关"。
    const hero: AcquireFitInput = {
      seq: 900040,
      wallTime: 1789990881.34,
      acquireName: "木乃伊",
      acquireRaw: "牧师被击败了。(木乃伊)",
      acquireColor: "#7030A5",
    };
    const clear: AcquireFitInput = {
      seq: 900041,
      wallTime: 1789990881.967,
      acquireRaw: "通关了关卡 3-9。(73秒)",
    };
    const out = fitAcquireSources(
      [hero, clear],
      [],
      [],
      [{ wallTime: 1789990881.967, stageKey: 39 }],
    );
    expect(out[String(hero.seq)], "英雄行不得被认领").toBeUndefined();
    expect(out[String(clear.seq)]?.source).toBe("clear");
    // 文本信号单独也成立（无紫色）。
    const heroText: AcquireFitInput = {
      seq: 900042,
      wallTime: 1789990881.34,
      acquireRaw: "牧师阵亡了。(木乃伊)",
    };
    const out2 = fitAcquireSources(
      [heroText],
      [],
      [],
      [{ wallTime: 1789990881.967, stageKey: 39 }],
    );
    expect(out2[String(heroText.seq)]).toBeUndefined();
  });

  it("R2-i bulk 祈愿行永不归因（wallTime 非事件时刻）", () => {
    const wish: AcquireFitInput = {
      seq: 900050,
      wallTime: 1000,
      bulk: true,
      acquireRaw: REAL_WISH_RAW,
    };
    const out = fitAcquireSources([wish], [], [], [{ wallTime: 1000.1, stageKey: 1 }]);
    expect(out[String(wish.seq)]).toBeUndefined();
  });
});

// ===========================================================================
// R3 —— feed 第 4 参可选，向后兼容
// ===========================================================================

describe("R3 feed 第 4 参可选（向后兼容）", () => {
  it("R3-a 旧 3 参调用不报错，entry.coin 为 undefined", () => {
    const t = new WishTracker();
    const ok = t.feed({ name: "木盾", count: 1, grade: "RARE" as WishGrade }, 1000, { raw: "x" });
    expect(ok).toBe(true);
    const stats = t.getStats(0);
    // feed 不带归因 → history 条目 coin undefined。
    const entry = t.fitHistory()[0];
    expect(entry.coin).toBeUndefined();
    // getStats().history 也不应凭空造 coin。
    expect(stats.history[0]?.coin).toBeUndefined();
  });

  it("R3-b 带第 4 参：entry.coin 被写入", () => {
    const t = new WishTracker();
    const attr: WishCoinAttribution = {
      confidence: "observed",
      coinKey: 160001,
      candidates: [],
      basis: "diff:160001",
    };
    t.feed({ name: "木盾", count: 1, grade: "RARE" as WishGrade }, 1000, { raw: "x" }, attr);
    expect(t.fitHistory()[0]?.coin).toEqual(attr);
  });

  it("R3-c recentResults 对缺失 coin 的条目兜底为 unknown（不崩、不虚构）", () => {
    const t = new WishTracker();
    t.feed({ name: "木盾", count: 1, grade: "RARE" as WishGrade }, 1000, { raw: "x" });
    const stats = t.getStats(0);
    expect(stats.recentResults[0]?.coin.confidence).toBe("unknown");
    expect(stats.recentResults[0]?.coin.coinKey).toBeNull();
  });
});

// ===========================================================================
// R4 —— 不变量 I1–I10
// ===========================================================================

describe("R4 不变量（对抗）", () => {
  it("R4-I8 历史内存上限 HISTORY_LIMIT=500", () => {
    const t = new WishTracker();
    for (let i = 0; i < 600; i++) {
      t.feed({ name: `物品${i}`, count: 1, grade: "COMMON" as WishGrade }, 1000 + i, { raw: "x" });
    }
    expect(t.fitHistory().length).toBe(500);
    // 保留的是最近 500 条（shift 掉最早的）。
    expect(t.fitHistory()[0]?.name).toBe("物品100");
  });

  it("R4-I8 历史可见窗口 HISTORY_VISIBLE=50", () => {
    const t = new WishTracker();
    for (let i = 0; i < 80; i++) {
      t.feed({ name: `物品${i}`, count: 1, grade: "COMMON" as WishGrade }, 1000 + i, { raw: "x" });
    }
    expect(t.getStats(0).history.length).toBe(50);
  });

  it("R4-I8 最近结果上限 WISH_RECENT_VISIBLE=20", () => {
    const t = new WishTracker();
    for (let i = 0; i < 60; i++) {
      t.feed({ name: `物品${i}`, count: 1, grade: "COMMON" as WishGrade }, 1000 + i, { raw: "x" });
    }
    expect(t.getStats(0).recentResults.length).toBe(20);
  });

  it("R4-I1 双计数：一条祈愿行 = +1 次；件数另计", () => {
    const t = new WishTracker();
    t.feed({ name: "木盾", count: 3, grade: "RARE" as WishGrade }, 1000, { raw: "x" });
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(1);
    expect(s.itemCountTotal).toBe(3);
  });

  it("R4-I2 会话重置：session 归零、累计不变、sessionEpoch++", () => {
    const t = new WishTracker();
    t.feed({ name: "木盾", count: 1, grade: "RARE" as WishGrade }, 1000, { raw: "x" });
    const epochBefore = t.getSessionEpoch();
    const totalBefore = t.getStats(0).offeringCountTotal;
    t.reset();
    const s = t.getStats(0);
    expect(s.offeringCountSession).toBe(0);
    expect(s.itemCountSession).toBe(0);
    expect(s.offeringCountTotal).toBe(totalBefore); // 累计不变
    expect(t.getSessionEpoch()).toBe(epochBefore + 1);
  });

  it("R4-I3 会话重置不清历史（wish_record 归档语义）", () => {
    const t = new WishTracker();
    t.feed({ name: "木盾", count: 1, grade: "RARE" as WishGrade }, 1000, { raw: "x" });
    t.reset();
    expect(t.fitHistory().length).toBe(1);
  });

  it("R4-I4 bulk 行不入滚动窗（recentPerHour 不被顶爆）", () => {
    const t = new WishTracker();
    for (let i = 0; i < 50; i++) {
      t.feed({ name: `物品${i}`, count: 1, grade: "COMMON" as WishGrade }, 1000 + i, {
        raw: "x",
        bulk: true,
      });
    }
    const s = t.getStats(0);
    expect(s.offeringRecentPerHour).toBe(0);
    // 但累计仍计入。
    expect(s.offeringCountTotal).toBe(50);
  });

  it("R4-I7 绝不猜测：UNKNOWN 桶承接无法映射的品质", () => {
    const t = new WishTracker();
    // 非法品质字符串 → UNKNOWN。
    t.feed({ name: "未知物", count: 1, grade: "NOT_A_GRADE" as WishGrade }, 1000, { raw: "x" });
    const unknown = t.getStats(0).gradeDistribution.find((g) => g.grade === "UNKNOWN");
    expect(unknown?.count).toBe(1);
  });

  it("R4-I9 core/wish 与 wishTracker 不含 electron/node:fs/fetch/React（源码级）", async () => {
    // 动态 import 源码文本，断言无禁用依赖。这里只覆盖本测试导出的模块图入口。
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const coreRoot = path.resolve(here, "../../src/core");
    const files = [
      "wish/coinDiff.ts",
      "wish/coinCandidates.ts",
      "wish/coinGroups.ts",
      "wish/coinDiffWindow.ts",
      "wish/constants.ts",
      "wishTracker.ts",
      "wishLine.ts",
    ];
    const banned = [
      /from\s+["']electron["']/,
      /from\s+["']node:fs/,
      /from\s+["']fs["']/,
      /fetch\s*\(/,
      /from\s+["']react["']/,
    ];
    for (const rel of files) {
      const text = await fs.readFile(path.join(coreRoot, rel), "utf8");
      for (const re of banned) {
        expect(re.test(text), `${rel} 命中禁用依赖 ${re}`).toBe(false);
      }
    }
  });
});

// ===========================================================================
// R5 —— 11 桶完整性 + 三处 GRADE_ORDER 一致 + 旧档兼容
// ===========================================================================

describe("R5 11 桶与三处 GRADE_ORDER 一致（对抗）", () => {
  const EXPECTED: WishGrade[] = [
    "COMMON",
    "UNCOMMON",
    "RARE",
    "LEGENDARY",
    "IMMORTAL",
    "ARCANA",
    "CELESTIAL",
    "BEYOND",
    "DIVINE",
    "COSMIC",
    "UNKNOWN",
  ];

  it("R5-a WishGrade 类型 11 成员（编译期）+ 运行期桶数 = 11", () => {
    const t = new WishTracker();
    const dist = t.getStats(0).gradeDistribution;
    expect(dist.length).toBe(11);
    expect(dist.map((d) => d.grade)).toEqual(EXPECTED);
  });

  it("R5-b core GRADE_ORDER 顺序：CELESTIAL 必须先于 BEYOND（回归工程曾错序）", () => {
    const dist = new WishTracker().getStats(0).gradeDistribution.map((d) => d.grade);
    const iCel = dist.indexOf("CELESTIAL");
    const iBey = dist.indexOf("BEYOND");
    expect(iCel).toBeGreaterThan(-1);
    expect(iBey).toBeGreaterThan(-1);
    expect(iCel, "CELESTIAL 应排在 BEYOND 之前").toBeLessThan(iBey);
  });

  it("R5-c main/stats.ts EMPTY_WISH 与 core 顺序一致（源码级）", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const statsPath = path.resolve(here, "../../src/main/stats.ts");
    const text = await fs.readFile(statsPath, "utf8");
    // stats.ts 用 `{ grade: "COMMON", ... }` 对象字面量形式；按出现顺序抽取。
    const matches = [...text.matchAll(/grade:\s*"([A-Z]+)"/g)].map((m) => m[1]);
    // 只取 EMPTY_WISH.gradeDistribution 段（前 11 个 grade: 出现即该段）。
    const seg = matches.slice(0, 11);
    expect(seg, "stats.ts gradeDistribution 应为 11 桶且顺序一致").toEqual(EXPECTED);
  });

  it("R5-d renderer useWish.ts GRADE_ORDER 顺序一致（源码级）", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const useWishPath = path.resolve(here, "../../src/renderer/lib/useWish.ts");
    const text = await fs.readFile(useWishPath, "utf8");
    const iCel = text.indexOf('"CELESTIAL"');
    const iBey = text.indexOf('"BEYOND"');
    expect(iCel).toBeGreaterThan(-1);
    expect(iBey).toBeGreaterThan(-1);
    expect(iCel, "useWish.ts 中 CELESTIAL 应先于 BEYOND").toBeLessThan(iBey);
    for (const g of EXPECTED) {
      expect(text.includes(`"${g}"`), `useWish.ts 缺桶 ${g}`).toBe(true);
    }
  });

  it("R5-e 旧档兼容：applySnapshot 缺新字段不崩、旧 grade 保留", () => {
    const t = new WishTracker();
    // 模拟旧快照（无 coin / 无新字段）。
    t.applySnapshot({
      offeringCount: 2,
      itemCount: 2,
      countsByName: { 木盾: 2 },
      gradeByName: { 木盾: "RARE" as WishGrade },
      history: [
        { wallTime: 1, name: "木盾", grade: "RARE" as WishGrade, count: 1, raw: "a" },
        { wallTime: 2, name: "木盾", grade: "RARE" as WishGrade, count: 1, raw: "b" },
      ],
      sessionWishStart: null,
      sessionOfferingBaseline: 0,
      sessionItemBaseline: 0,
    } as never);
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(2);
    // 旧档条目无 coin → recentResults 兜底 unknown，不虚构。
    expect(s.recentResults[0]?.coin.confidence).toBe("unknown");
    expect(s.recentResults[0]?.coin.coinKey).toBeNull();
    // 非 observed 条目全进 unattributed。
    expect(s.coinGroups.length).toBe(0);
    expect(s.unattributed.items.length).toBeGreaterThan(0);
  });

  it("R5-f applySnapshot 含 coin 的条目正确分组", () => {
    const t = new WishTracker();
    t.applySnapshot({
      offeringCount: 2,
      itemCount: 2,
      countsByName: { 木盾: 1, 长剑: 1 },
      gradeByName: { 木盾: "RARE" as WishGrade, 长剑: "COMMON" as WishGrade },
      history: [
        {
          wallTime: 1,
          name: "木盾",
          grade: "RARE" as WishGrade,
          count: 1,
          raw: "a",
          coin: { confidence: "observed", coinKey: 160001, candidates: [], basis: "diff:160001" },
        },
        {
          wallTime: 2,
          name: "长剑",
          grade: "COMMON" as WishGrade,
          count: 1,
          raw: "b",
          coin: { confidence: "unknown", coinKey: null, candidates: [] },
        },
      ],
      sessionWishStart: null,
      sessionOfferingBaseline: 0,
      sessionItemBaseline: 0,
    } as never);
    const s = t.getStats(0);
    expect(s.coinGroups.find((g) => g.coinKey === 160001)?.itemCount).toBe(1);
    expect(s.unattributed.items.map((i) => i.name)).toContain("长剑");
  });

  it("R5-g 4 语言 grade 段 11 键且顺序一致（源码级）", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    for (const loc of ["zh-CN", "en", "ja", "ko"]) {
      const p = path.resolve(here, `../../shared/locales/${loc}/wish.json`);
      const raw = await fs.readFile(p, "utf8");
      const json = JSON.parse(raw) as { grade?: Record<string, string> };
      const keys = Object.keys(json.grade ?? {});
      expect(keys.length, `${loc} grade 应有 11 键`).toBe(11);
      for (const g of EXPECTED) {
        expect(keys, `${loc} grade 缺 ${g}`).toContain(g);
      }
      // 顺序：JSON 键插入序应与 EXPECTED 一致。
      expect(keys, `${loc} grade 顺序应与 core 一致`).toEqual(EXPECTED);
    }
  });
});

// ===========================================================================
// 附加：coinGroups 派生正确性（S2/S4 支撑）
// ===========================================================================

describe("S2/S4 coinGroups 派生（对抗）", () => {
  it("observed 条目按 coinKey 分组；offeringCount=行数，itemCount=件数和", () => {
    const history: WishHistoryEntry[] = [
      {
        wallTime: 1,
        name: "木盾",
        grade: "RARE",
        count: 1,
        raw: "a",
        coin: { confidence: "observed", coinKey: 160001, candidates: [] },
      },
      {
        wallTime: 2,
        name: "木盾",
        grade: "RARE",
        count: 2,
        raw: "b",
        coin: { confidence: "observed", coinKey: 160001, candidates: [] },
      },
    ];
    const { coinGroups } = coinGroupsFromHistory(history, () => undefined);
    expect(coinGroups.length).toBe(1);
    expect(coinGroups[0]?.coinKey).toBe(160001);
    expect(coinGroups[0]?.offeringCount).toBe(2);
    expect(coinGroups[0]?.itemCount).toBe(3);
  });

  it("inferred（coinKey=null）绝不进 coinGroups，只能进 unattributed", () => {
    const history: WishHistoryEntry[] = [
      {
        wallTime: 1,
        name: "神秘护符",
        grade: "COMMON",
        count: 1,
        raw: "a",
        coin: {
          confidence: "inferred",
          coinKey: null,
          candidates: [{ coinKey: 160003, poolPct: 0.4 }],
        },
      },
    ];
    const { coinGroups, unattributed } = coinGroupsFromHistory(history, () => undefined);
    expect(coinGroups.length).toBe(0);
    expect(unattributed.items.length).toBe(1);
    expect(unattributed.items[0]?.coin?.confidence).toBe("inferred");
  });

  it("coinMeta miss → coinName 降级为 String(coinKey)，grade 降级 UNKNOWN", () => {
    const history: WishHistoryEntry[] = [
      {
        wallTime: 1,
        name: "木盾",
        grade: "RARE",
        count: 1,
        raw: "a",
        coin: { confidence: "observed", coinKey: 160001, candidates: [] },
      },
    ];
    const { coinGroups } = coinGroupsFromHistory(history, () => undefined);
    expect(coinGroups[0]?.coinName).toBe("160001");
    expect(coinGroups[0]?.grade).toBe("UNKNOWN");
  });
});

// ===========================================================================
// 附加：常量与 fallback 表
// ===========================================================================

describe("常量与 fallback（对抗）", () => {
  it("WISH_DIFF_TOLERANCE_FACTOR = 1.5", () => {
    expect(WISH_DIFF_TOLERANCE_FACTOR).toBe(1.5);
  });

  it("WISH_COIN_GRADE_FALLBACK 覆盖 10 枚且键属闭集", () => {
    const keys = Object.keys(WISH_COIN_GRADE_FALLBACK).map(Number);
    expect(keys.length).toBe(10);
    for (const k of keys) expect(WISH_COIN_KEYS).toContain(k);
  });

  it("闭集 WISH_COIN_KEYS 恰为 160001–160010", () => {
    expect([...WISH_COIN_KEYS]).toEqual([
      160001, 160002, 160003, 160004, 160005, 160006, 160007, 160008, 160009, 160010,
    ]);
  });
});

// ===========================================================================
// 附加：buildNameIndex（S2 依赖）
// ===========================================================================

describe("buildNameIndex（对抗）", () => {
  it("name / sourceName 均可反查；首见优先，无模糊匹配", () => {
    const idx = buildNameIndex([
      { id: 1, name: "木盾", sourceName: "Wood Shield" },
      { id: 2, name: "木盾", sourceName: "Dup" }, // 同名 → 首见保留
    ] as never);
    expect(idx.get("木盾")).toBe(1);
    expect(idx.get("Wood Shield")).toBe(1);
    // 不模糊匹配。
    expect(idx.get("木盾 ")).toBeUndefined();
    expect(idx.get("木盾x")).toBeUndefined();
  });
});

// ===========================================================================
// 附加：类型层面（编译即断言）
// ===========================================================================

describe("类型层面（编译即断言）", () => {
  it("CoinAttributionConfidence 三值可用", () => {
    const vals: CoinAttributionConfidence[] = ["observed", "inferred", "unknown"];
    expect(vals.length).toBe(3);
  });
});
