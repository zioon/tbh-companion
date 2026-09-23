// 按硬币分组聚合单测（Wish v2 P0-8）。

import { describe, expect, it } from "vitest";
import { coinGroupsFromHistory } from "../../src/core/wish/coinGroups";
import type { WishCoinAttribution, WishHistoryEntry } from "../../shared/types";

function observed(coinKey: number): WishCoinAttribution {
  return { confidence: "observed", coinKey, candidates: [], basis: `diff:${coinKey}` };
}
function inferred(candidates: { coinKey: number; poolPct: number }[]): WishCoinAttribution {
  return {
    confidence: "inferred",
    coinKey: null,
    candidates,
    basis: `loot:${candidates.length}cand`,
  };
}
const UNKNOWN: WishCoinAttribution = { confidence: "unknown", coinKey: null, candidates: [] };

function entry(
  name: string,
  count: number,
  coin: WishCoinAttribution | undefined,
  grade: WishHistoryEntry["grade"] = "COMMON",
): WishHistoryEntry {
  return { wallTime: 1000, name, grade, count, raw: "", coin };
}

/** 测试用 coinMeta。 */
const coinMeta = (coinKey: number) => {
  const map: Record<number, { name: string; grade: WishHistoryEntry["grade"] }> = {
    160001: { name: "Kingdom 1st", grade: "COMMON" },
    160003: { name: "Kingdom 10th", grade: "RARE" },
  };
  return map[coinKey];
};

describe("coinGroupsFromHistory", () => {
  it("observed 条目按 coinKey 分组；offeringCount 数行、itemCount 数件", () => {
    const history = [
      entry("木盾", 1, observed(160001)),
      entry("木盾", 3, observed(160001)),
      entry("铁剑", 1, observed(160003)),
    ];
    const { coinGroups, unattributed } = coinGroupsFromHistory(history, coinMeta);
    expect(coinGroups).toHaveLength(2);
    const g1 = coinGroups.find((g) => g.coinKey === 160001)!;
    expect(g1.coinName).toBe("Kingdom 1st");
    expect(g1.grade).toBe("COMMON");
    expect(g1.offeringCount).toBe(2);
    expect(g1.itemCount).toBe(4);
    // items 按 count 降序（木盾 4 件 → 单条）。
    expect(g1.items).toEqual([{ name: "木盾", count: 4, grade: "COMMON" }]);

    const g3 = coinGroups.find((g) => g.coinKey === 160003)!;
    expect(g3.offeringCount).toBe(1);
    expect(g3.itemCount).toBe(1);
    expect(unattributed.items).toEqual([]);
  });

  it("分区按 coinKey 升序输出", () => {
    const history = [entry("a", 1, observed(160003)), entry("b", 1, observed(160001))];
    const { coinGroups } = coinGroupsFromHistory(history, coinMeta);
    expect(coinGroups.map((g) => g.coinKey)).toEqual([160001, 160003]);
  });

  it("items 同 count 时按 name 升序", () => {
    const history = [entry("z", 2, observed(160001)), entry("a", 2, observed(160001))];
    const { coinGroups } = coinGroupsFromHistory(history, coinMeta);
    expect(coinGroups[0]!.items.map((i) => i.name)).toEqual(["a", "z"]);
  });

  it("非 observed（inferred/unknown/无 coin）→ unattributed，元素带候选", () => {
    const history = [
      entry("木盾", 2, inferred([{ coinKey: 160001, poolPct: 40 }])),
      entry("幽灵", 1, UNKNOWN),
      entry("无归因", 1, undefined),
    ];
    const { coinGroups, unattributed } = coinGroupsFromHistory(history, coinMeta);
    expect(coinGroups).toEqual([]);
    // `items` 排序契约为「count 降序优先，同 count 再按 name 升序」：木盾 2 件 → 必居首。
    // 同 count 的 name 升序走 `localeCompare`，其结果随运行环境 locale 变化
    // （en-US 下「幽灵」排在「无归因」前，zh-CN 下相反），故此处不写死顺序：
    // 只断言 count 优先级与元素集合；同 count 升序由上面的 ASCII 用例覆盖。
    const names = unattributed.items.map((i) => i.name);
    expect(names[0]).toBe("木盾");
    expect(new Set(names)).toEqual(new Set(["木盾", "无归因", "幽灵"]));
    const shield = unattributed.items.find((i) => i.name === "木盾")!;
    expect(shield.coin?.confidence).toBe("inferred");
    expect(shield.coin?.candidates).toEqual([{ coinKey: 160001, poolPct: 40 }]);
  });

  it("coinMeta miss → coinName 降级为字符串、grade 为 UNKNOWN", () => {
    const history = [entry("x", 1, observed(169999))];
    const { coinGroups } = coinGroupsFromHistory(history, () => undefined);
    expect(coinGroups[0]!.coinName).toBe("169999");
    expect(coinGroups[0]!.grade).toBe("UNKNOWN");
  });

  it("空历史 → 两组皆空", () => {
    const { coinGroups, unattributed } = coinGroupsFromHistory([], coinMeta);
    expect(coinGroups).toEqual([]);
    expect(unattributed.items).toEqual([]);
  });

  it("空名称条目被跳过", () => {
    const history = [entry("", 5, observed(160001))];
    const { coinGroups } = coinGroupsFromHistory(history, coinMeta);
    expect(coinGroups).toEqual([]);
  });
});
