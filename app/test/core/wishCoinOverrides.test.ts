import { describe, expect, it } from "vitest";
import {
  applyCoinOverrides,
  applyOverridesToHistory,
  applyOverridesToRecent,
  manualAttribution,
  overrideCoinKey,
  overrideIndex,
} from "../../src/core/wish/coinOverrides";
import type {
  WishCoinGroup,
  WishCoinOverride,
  WishHistoryEntry,
  WishRecentResult,
  WishUnattributedGroup,
} from "../../shared/types";

/** 简化构造器：一条手工绑定。 */
function ov(itemName: string, coinKey: number, createdAt = 1): WishCoinOverride {
  return { itemName, coinKey, createdAt };
}

/** coinKey → { name, grade } 的测试解析器。 */
const META: Record<number, { name: string; grade: "COMMON" | "COSMIC" }> = {
  160001: { name: "普通硬币", grade: "COMMON" },
  160010: { name: "宇宙硬币", grade: "COSMIC" },
};
const resolveMeta = (k: number) => META[k];

describe("overrideIndex", () => {
  it("建立 itemName → coinKey 的查找表", () => {
    const idx = overrideIndex([ov("A", 160001), ov("B", 160010)]);
    expect(idx.get("A")).toBe(160001);
    expect(idx.get("B")).toBe(160010);
    expect(idx.get("C")).toBeUndefined();
  });

  it("后写覆盖先写（与 config 侧去重语义一致）", () => {
    const idx = overrideIndex([ov("A", 160001), ov("A", 160010)]);
    expect(idx.get("A")).toBe(160010);
    expect(idx.size).toBe(1);
  });
});

describe("manualAttribution", () => {
  it("产出 confidence=manual、无候选、basis=manual 的归因", () => {
    expect(manualAttribution(160001)).toEqual({
      confidence: "manual",
      coinKey: 160001,
      candidates: [],
      basis: "manual",
    });
  });
});

describe("overrideCoinKey", () => {
  it("找到绑定时返回 coinKey，未绑定返回 undefined", () => {
    const idx = overrideIndex([ov("A", 160001)]);
    expect(overrideCoinKey(idx, "A")).toBe(160001);
    expect(overrideCoinKey(idx, "Z")).toBeUndefined();
  });

  it("查询前 trim 物品名（与 config sanitize 同口径）", () => {
    const idx = overrideIndex([ov("A", 160001)]);
    expect(overrideCoinKey(idx, "  A  ")).toBe(160001);
  });

  it("空名字不命中", () => {
    const idx = overrideIndex([ov("A", 160001)]);
    expect(overrideCoinKey(idx, "")).toBeUndefined();
  });
});

describe("applyCoinOverrides", () => {
  const unattributed: WishUnattributedGroup = {
    items: [
      { name: "神秘手套", count: 2, grade: "RARE" },
      { name: "未绑定物", count: 1, grade: "COMMON" },
    ],
  };

  it("无绑定时原样返回（coinGroups 为新副本，unattributed 不变）", () => {
    const groups: WishCoinGroup[] = [
      {
        coinKey: 160001,
        coinName: "普通硬币",
        grade: "COMMON",
        offeringCount: 3,
        itemCount: 5,
        items: [{ name: "铁剑", count: 5, grade: "COMMON" }],
      },
    ];
    const out = applyCoinOverrides(groups, unattributed, [], resolveMeta);
    expect(out.coinGroups).toHaveLength(1);
    expect(out.coinGroups[0]).toBe(groups[0]);
    expect(out.unattributed).toBe(unattributed);
  });

  it("未归因区为空时不做任何改动", () => {
    const out = applyCoinOverrides([], { items: [] }, [ov("神秘手套", 160010)], resolveMeta);
    expect(out.coinGroups).toEqual([]);
    expect(out.unattributed.items).toEqual([]);
  });

  it("把绑定的物品从未归因区移入既有硬币分组，并累加计数", () => {
    const groups: WishCoinGroup[] = [
      {
        coinKey: 160010,
        coinName: "宇宙硬币",
        grade: "COSMIC",
        offeringCount: 1,
        itemCount: 3,
        items: [{ name: "铁剑", count: 3, grade: "COMMON" }],
      },
    ];
    const out = applyCoinOverrides(groups, unattributed, [ov("神秘手套", 160010)], resolveMeta);

    expect(out.coinGroups).toHaveLength(1);
    const g = out.coinGroups[0];
    expect(g.coinKey).toBe(160010);
    // 件数 += 2（神秘手套 count=2）；次数 += 1（一个未归因条目）。
    expect(g.itemCount).toBe(5);
    expect(g.offeringCount).toBe(2);
    // 未绑定物仍在未归因区。
    expect(out.unattributed.items.map((i) => i.name)).toEqual(["未绑定物"]);
  });

  it("目标分组不存在时新建该分组（offeringCount/itemCount 由绑定条目起算）", () => {
    const out = applyCoinOverrides([], unattributed, [ov("神秘手套", 160010)], resolveMeta);

    expect(out.coinGroups).toHaveLength(1);
    const g = out.coinGroups[0];
    expect(g.coinKey).toBe(160010);
    expect(g.coinName).toBe("宇宙硬币");
    expect(g.grade).toBe("COSMIC");
    expect(g.offeringCount).toBe(1);
    expect(g.itemCount).toBe(2);
    expect(g.items).toEqual([{ name: "神秘手套", count: 2, grade: "RARE" }]);
  });

  it("多个物品绑定到同一硬币时，分组计数累加", () => {
    const un: WishUnattributedGroup = {
      items: [
        { name: "A", count: 2, grade: "RARE" },
        { name: "B", count: 3, grade: "COMMON" },
      ],
    };
    const out = applyCoinOverrides([], un, [ov("A", 160001), ov("B", 160001)], resolveMeta);
    const g = out.coinGroups[0]!;
    expect(g.itemCount).toBe(5);
    expect(g.offeringCount).toBe(2);
    // items 按 count 降序：B(3) 在 A(2) 之前。
    expect(g.items.map((i) => i.name)).toEqual(["B", "A"]);
  });

  it("输出按 coinKey 升序（确定性）", () => {
    const un: WishUnattributedGroup = {
      items: [
        { name: "A", count: 1, grade: "RARE" },
        { name: "B", count: 1, grade: "COMMON" },
      ],
    };
    const out = applyCoinOverrides([], un, [ov("A", 160010), ov("B", 160001)], resolveMeta);
    expect(out.coinGroups.map((g) => g.coinKey)).toEqual([160001, 160010]);
  });

  it("coinMeta miss 时名称降级、品质 UNKNOWN", () => {
    const out = applyCoinOverrides([], unattributed, [ov("神秘手套", 999999)], () => undefined);
    const g = out.coinGroups[0]!;
    expect(g.coinName).toBe("999999");
    expect(g.grade).toBe("UNKNOWN");
  });

  it("不 mutate 入参", () => {
    const groups: WishCoinGroup[] = [
      {
        coinKey: 160010,
        coinName: "宇宙硬币",
        grade: "COSMIC",
        offeringCount: 1,
        itemCount: 3,
        items: [{ name: "铁剑", count: 3, grade: "COMMON" }],
      },
    ];
    const snapshot = JSON.stringify({ groups, unattributed });
    applyCoinOverrides(groups, unattributed, [ov("神秘手套", 160010)], resolveMeta);
    expect(JSON.stringify({ groups, unattributed })).toBe(snapshot);
  });

  it("绑定物品名与既有分组内同名物品合并（件数相加、不重复出行）", () => {
    const groups: WishCoinGroup[] = [
      {
        coinKey: 160010,
        coinName: "宇宙硬币",
        grade: "COSMIC",
        offeringCount: 1,
        itemCount: 3,
        items: [{ name: "神秘手套", count: 3, grade: "RARE" }],
      },
    ];
    const out = applyCoinOverrides(groups, unattributed, [ov("神秘手套", 160010)], resolveMeta);
    const g = out.coinGroups[0]!;
    expect(g.items).toHaveLength(1);
    expect(g.items[0]).toEqual({ name: "神秘手套", count: 5, grade: "RARE" });
    expect(g.itemCount).toBe(5);
  });

  it("绑定后「次数 ≤ 件数」的不变量保持（count=1 的条目）", () => {
    const un: WishUnattributedGroup = {
      items: [{ name: "A", count: 1, grade: "RARE" }],
    };
    const out = applyCoinOverrides([], un, [ov("A", 160001)], resolveMeta);
    const g = out.coinGroups[0]!;
    expect(g.offeringCount).toBeLessThanOrEqual(g.itemCount);
  });
});

describe("applyOverridesToHistory", () => {
  const entries: WishHistoryEntry[] = [
    { wallTime: 1, name: "神秘手套", grade: "RARE", count: 1, raw: "…" },
    { wallTime: 2, name: "铁剑", grade: "COMMON", count: 1, raw: "…" },
  ];

  it("无绑定时返回新数组但内容不变", () => {
    const out = applyOverridesToHistory(entries, []);
    expect(out).toEqual(entries);
    expect(out).not.toBe(entries);
  });

  it("绑定的行改写为 manual 归因，未绑定的行原样保留", () => {
    const out = applyOverridesToHistory(entries, [ov("神秘手套", 160010)]);
    expect(out[0]!.coin).toEqual(manualAttribution(160010));
    expect(out[1]!.coin).toBeUndefined();
  });

  it("覆盖已有的自动归因（manual 优先级最高）", () => {
    const withObserved: WishHistoryEntry[] = [
      {
        wallTime: 1,
        name: "神秘手套",
        grade: "RARE",
        count: 1,
        raw: "…",
        coin: { confidence: "inferred", coinKey: null, candidates: [] },
      },
    ];
    const out = applyOverridesToHistory(withObserved, [ov("神秘手套", 160010)]);
    expect(out[0]!.coin!.confidence).toBe("manual");
    expect(out[0]!.coin!.coinKey).toBe(160010);
  });
});

describe("applyOverridesToRecent", () => {
  const rows: WishRecentResult[] = [
    {
      wallTime: 1,
      name: "神秘手套",
      grade: "RARE",
      count: 1,
      coin: { confidence: "unknown", coinKey: null, candidates: [] },
    },
  ];

  it("把绑定行改写为 manual 归因", () => {
    const out = applyOverridesToRecent(rows, [ov("神秘手套", 160010)]);
    expect(out[0]!.coin).toEqual(manualAttribution(160010));
  });

  it("无绑定时返回新数组但内容不变", () => {
    const out = applyOverridesToRecent(rows, []);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
});
