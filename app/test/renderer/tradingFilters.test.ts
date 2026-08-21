import { describe, expect, it } from "vitest";
import type { MarketVolumeItem } from "../../shared/types";
import {
  DEFAULT_TRADING_FILTER,
  aggregateFilteredToHourly,
  filterVolumeItems,
  gearTypeOptionsFromVolumeItems,
  gradeOptionsFromVolumeItems,
  hasActiveTradingFilter,
  itemCountsByCategoryFromItems,
  materialKindOptionsFromVolumeItems,
} from "../../src/renderer/lib/tradingFilters";

function makeItem(overrides: Partial<MarketVolumeItem> = {}): MarketVolumeItem {
  return {
    hash: "h",
    name: "Some Sword",
    category: "WEAPON",
    grade: "LEGENDARY",
    level: 40,
    gearType: "SWORD",
    materialType: null,
    total: 100,
    points: [],
    ...overrides,
  };
}

const MATERIAL: MarketVolumeItem = makeItem({
  hash: "mat",
  name: "Fire Rune",
  category: "MATERIAL",
  grade: "RARE",
  level: null,
  gearType: null,
  materialType: "CRAFTING",
});

const GEAR: MarketVolumeItem = makeItem({ name: "Ancient Blade" });

describe("gradeOptionsFromVolumeItems", () => {
  it("按 GRADE_ORDER 排序并追加未知品质", () => {
    const options = gradeOptionsFromVolumeItems([
      makeItem({ grade: "RARE" }),
      makeItem({ grade: "LEGENDARY" }),
      makeItem({ grade: "MYSTERIOUS" }),
    ]);
    expect(options).toEqual(["RARE", "LEGENDARY", "MYSTERIOUS"]);
  });
});

describe("gearTypeOptionsFromVolumeItems / materialKindOptionsFromVolumeItems", () => {
  it("仅收集非空值并去重排序", () => {
    expect(
      gearTypeOptionsFromVolumeItems([GEAR, makeItem({ gearType: "HELMET" }), MATERIAL]),
    ).toEqual(["HELMET", "SWORD"]);
    expect(materialKindOptionsFromVolumeItems([MATERIAL, GEAR])).toEqual(["CRAFTING"]);
  });
});

describe("filterVolumeItems", () => {
  const items = [
    GEAR,
    makeItem({ name: "Igneous Helm", gearType: "HELMET", grade: "RARE", level: 10 }),
    MATERIAL,
  ];

  it("默认状态不筛选（全部通过）", () => {
    expect(filterVolumeItems(items, DEFAULT_TRADING_FILTER)).toHaveLength(3);
  });

  it("名称关键字模糊匹配（大小写不敏感）", () => {
    const out = filterVolumeItems(items, { ...DEFAULT_TRADING_FILTER, query: "BLADE" });
    expect(out.map((i) => i.name)).toEqual(["Ancient Blade"]);
  });

  it("名称可命中英文市场名（hash），即使显示名是本地化名不含关键字", () => {
    const downScaled = [
      GEAR, // hash "h"
      makeItem({ hash: "Sword (Legendary) A", name: "传奇之剑", grade: "LEGENDARY" }),
    ];
    const out = filterVolumeItems(downScaled, {
      ...DEFAULT_TRADING_FILTER,
      query: "sword (legendary)",
    });
    expect(out.map((i) => i.name)).toEqual(["传奇之剑"]);
  });

  it("品质多选命中", () => {
    const out = filterVolumeItems(items, { ...DEFAULT_TRADING_FILTER, gradeFilter: ["LEGENDARY"] });
    expect(out).toEqual([GEAR]);
  });

  it("部位多选命中（静置无 gearType 的物品被排除）", () => {
    const out = filterVolumeItems(items, {
      ...DEFAULT_TRADING_FILTER,
      gearTypeFilter: ["HELMET"],
    });
    expect(out.map((i) => i.name)).toEqual(["Igneous Helm"]);
  });

  it("种类多选命中材料", () => {
    const out = filterVolumeItems(items, {
      ...DEFAULT_TRADING_FILTER,
      materialKindFilter: ["CRAFTING"],
    });
    expect(out).toEqual([MATERIAL]);
  });

  it("等级区间只作用于有等级的物品，无等级的材料始终通过", () => {
    const out = filterVolumeItems(items, { ...DEFAULT_TRADING_FILTER, levelRange: [1, 20] });
    // Some Sword(40) 被排除；Igneous Helm(10) 保留；Fire Rune(无等级) 保留。
    expect(out.map((i) => i.name)).toEqual(["Igneous Helm", "Fire Rune"]);
  });

  it("成交额下限 minTotal 过滤（未指定窗口时按全量 total）", () => {
    const list = [makeItem({ name: "Big", total: 500 }), makeItem({ name: "Small", total: 100 })];
    const out = filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minTotal: 400 });
    expect(out.map((i) => i.name)).toEqual(["Big"]); // total 500 ≥ 400
  });

  it("成交量下限 minVolume 过滤（未指定窗口时回退全量：history 求和、live 取最新点）", () => {
    // history 卡片：两个点 5 + 1 = 6
    const historyCard = makeItem({
      name: "History Card",
      total: 60,
      points: [
        { hour: "h1", price: 10, volume: 5, total: 50 },
        { hour: "h2", price: 10, volume: 1, total: 10 },
      ],
    });
    // live 卡片：最新采样点 volume=4（滚动累计，不可求和）
    const liveCard = makeItem({
      name: "Live Card",
      total: 40,
      kind: "live",
      points: [
        { hour: "h1", price: 10, volume: 100, total: 1000 },
        { hour: "h2", price: 10, volume: 4, total: 40 },
      ],
    });
    const list = [historyCard, liveCard];
    // 6 ≥ 6 命中 history；4 ≥ 4 命中 live
    expect(
      filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minVolume: 4 }).map((i) => i.name),
    ).toEqual(["History Card", "Live Card"]);
    // 6 ≥ 6 命中 history；4 < 6 → live 被过滤
    const out = filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minVolume: 6 });
    expect(out.map((i) => i.name)).toEqual(["History Card"]);
  });

  it("指定窗口时成交额/成交量按当前时段（窗口内）过滤", () => {
    const windowRange = { start: "h2", end: "h2" };
    // history：h1 成交额 50 / 量 5；h2 成交额 10 / 量 1。窗口=仅 h2。
    const historyCard = makeItem({
      name: "History Card",
      total: 60,
      points: [
        { hour: "h1", price: 10, volume: 5, total: 50 },
        { hour: "h2", price: 10, volume: 1, total: 10 },
      ],
    });
    const list = [historyCard];

    // 窗口成交额 = 10（h2）→ minTotal 20 过滤掉（10 < 20）
    expect(
      filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minTotal: 20 }, windowRange),
    ).toEqual([]);
    // 窗口成交量 = 1（h2）→ minVolume 1 命中
    expect(
      filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minVolume: 1 }, windowRange).map(
        (i) => i.name,
      ),
    ).toEqual(["History Card"]);
  });

  it("价格下限 minPrice 过滤（当前时段最新价 = 窗口内最新走势点 price；无走势时被过滤）", () => {
    // 全部走势：h1 price=10、h2 price=12、h3 price=14
    const priced = makeItem({
      name: "Priced Card",
      total: 60,
      points: [
        { hour: "h1", price: 10, volume: 5, total: 50 },
        { hour: "h2", price: 12, volume: 1, total: 10 },
        { hour: "h3", price: 14, volume: 1, total: 5 },
      ],
    });
    // 无走势：窗口内无价格，设价格下限时被过滤
    const priceless = makeItem({ name: "Priceless Card", total: 100, points: [] });
    const list = [priced, priceless];

    // 未指定窗口：取全量最新点 price=14（h3）
    expect(
      filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minPrice: 14 }).map((i) => i.name),
    ).toEqual(["Priced Card"]);
    // 指定窗口 [h1,h2]：窗口内最新点 = h2 price=12 → 12 ≥ 12 命中、14 已超出窗口
    const windowRange = { start: "h1", end: "h2" };
    expect(
      filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minPrice: 12 }, windowRange).map(
        (i) => i.name,
      ),
    ).toEqual(["Priced Card"]);
    // 窗口内最新价 12 < 13 → 被过滤
    expect(
      filterVolumeItems(list, { ...DEFAULT_TRADING_FILTER, minPrice: 13 }, windowRange).map(
        (i) => i.name,
      ),
    ).toEqual([]);
  });
});

describe("hasActiveTradingFilter", () => {
  it("默认状态无生效条件", () => {
    expect(hasActiveTradingFilter(DEFAULT_TRADING_FILTER)).toBe(false);
  });
  it("任一维度激活即视为有生效条件", () => {
    expect(hasActiveTradingFilter({ ...DEFAULT_TRADING_FILTER, query: "剑" })).toBe(true);
    expect(hasActiveTradingFilter({ ...DEFAULT_TRADING_FILTER, gradeFilter: ["LEGENDARY"] })).toBe(
      true,
    );
    expect(hasActiveTradingFilter({ ...DEFAULT_TRADING_FILTER, minTotal: 10 })).toBe(true);
    expect(hasActiveTradingFilter({ ...DEFAULT_TRADING_FILTER, levelRange: [1, 50] })).toBe(true);
  });
});

describe("aggregateFilteredToHourly / itemCountsByCategoryFromItems", () => {
  it("按小时累加成交额与分类明细，跳过 live 卡片", () => {
    const weaponA = makeItem({
      hash: "a",
      name: "A",
      category: "WEAPON",
      points: [
        { hour: "h1", price: 10, volume: 1, total: 10 },
        { hour: "h2", price: 20, volume: 1, total: 20 },
      ],
    });
    const weaponB = makeItem({
      hash: "b",
      name: "B",
      category: "WEAPON",
      points: [{ hour: "h2", price: 30, volume: 1, total: 30 }],
    });
    // live 卡片（滚动累计）不参与聚合
    const liveCard = makeItem({
      hash: "c",
      name: "C",
      category: "MATERIAL",
      kind: "live",
      points: [{ hour: "h2", price: 5, volume: 100, total: 500 }],
    });

    const hourly = aggregateFilteredToHourly([weaponA, weaponB, liveCard]);
    expect(hourly).toEqual([
      { hour: "h1", total: 10, byCategory: { WEAPON: 10 } },
      { hour: "h2", total: 50, byCategory: { WEAPON: 50 } },
    ]);

    expect(itemCountsByCategoryFromItems([weaponA, weaponB, liveCard])).toEqual({
      WEAPON: 2,
      MATERIAL: 1,
    });
  });
});
