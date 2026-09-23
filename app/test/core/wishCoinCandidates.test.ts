// 候选兜底归因单测（Wish v2 P0-4）。
//
// 覆盖：
//   - 命中 loot 反查 → inferred + 候选（按 poolPct 降序）；
//   - miss（无 itemKey / 无 offerings / 无候选）→ unknown（I7，不虚构）；
//   - heldCoinKeys 打 held 标记。

import { describe, expect, it } from "vitest";
import { inferCoinCandidates } from "../../src/core/wish/coinCandidates";
import type { OfferingsModel } from "../../shared/types";

/** 构造一个最小 offerings 模型：物品 111 由 160001(40%) / 160003(12%) 产出。 */
const OFFERINGS: OfferingsModel = [
  { coinKey: 160001, goldCost: 10, unlockCubeLevel: 20, loot: [{ itemKey: 111, poolPct: 40 }] },
  { coinKey: 160003, goldCost: 210, unlockCubeLevel: 20, loot: [{ itemKey: 111, poolPct: 12 }] },
  { coinKey: 160005, goldCost: 410, unlockCubeLevel: 20, loot: [{ itemKey: 222, poolPct: 5 }] },
];

describe("inferCoinCandidates", () => {
  it("命中 loot 反查 → inferred + 候选按 poolPct 降序", () => {
    const out = inferCoinCandidates("木盾", {
      nameToItemKey: (n) => (n === "木盾" ? 111 : undefined),
      offerings: OFFERINGS,
    });
    expect(out.confidence).toBe("inferred");
    expect(out.coinKey).toBeNull();
    expect(out.candidates.map((c) => c.coinKey)).toEqual([160001, 160003]);
    expect(out.candidates[0]!.poolPct).toBe(40);
    expect(out.candidates[1]!.poolPct).toBe(12);
    expect(out.basis).toBe("loot:2cand");
  });

  it("名称无法解析为 itemKey → unknown", () => {
    const out = inferCoinCandidates("幽灵物品", {
      nameToItemKey: () => undefined,
      offerings: OFFERINGS,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.candidates).toEqual([]);
    expect(out.basis).toBe("no-item-key");
  });

  it("offerings 未就绪 → unknown", () => {
    const out = inferCoinCandidates("木盾", {
      nameToItemKey: () => 111,
      offerings: null,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.basis).toBe("no-offerings");
  });

  it("itemKey 无任何候选硬币 → unknown", () => {
    const out = inferCoinCandidates("无人产出", {
      nameToItemKey: () => 999,
      offerings: OFFERINGS,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.candidates).toEqual([]);
    expect(out.basis).toBe("no-candidates");
  });

  it("heldCoinKeys 提供时给候选打 held 标记（不过滤）", () => {
    const out = inferCoinCandidates("木盾", {
      nameToItemKey: () => 111,
      offerings: OFFERINGS,
      heldCoinKeys: new Set([160003]),
    });
    expect(out.confidence).toBe("inferred");
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.find((c) => c.coinKey === 160001)?.held).toBe(false);
    expect(out.candidates.find((c) => c.coinKey === 160003)?.held).toBe(true);
  });

  it("名称首尾空白被裁剪后仍能命中", () => {
    const out = inferCoinCandidates("  木盾  ", {
      nameToItemKey: (n) => (n === "木盾" ? 111 : undefined),
      offerings: OFFERINGS,
    });
    expect(out.confidence).toBe("inferred");
  });
});
