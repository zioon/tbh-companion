import { describe, it, expect } from "vitest";
import {
  SYNTHESIS_POINTS,
  ACCESSORY_POINT_MULTIPLIER,
  SOULSTONE_ACT_BOX,
  buildMaterialSynthesisPoints,
  isAccessoryItem,
  synthesisPointsForGrade,
  synthesisPointsForItem,
  synthesisPointsForGearItem,
  synthesisPointsForItemKey,
  synthesisPointsForItemKeyByGear,
} from "../../src/core/synthesisPoints";

describe("synthesisPoints", () => {
  it("anchors the base ladder at COMMON=1 and UNCOMMON=9", () => {
    expect(SYNTHESIS_POINTS.COMMON).toBe(1);
    expect(SYNTHESIS_POINTS.UNCOMMON).toBe(9);
  });

  it("low grades are exact powers of 9 (P_up = 100%)", () => {
    expect(SYNTHESIS_POINTS.RARE).toBe(81);
    expect(SYNTHESIS_POINTS.LEGENDARY).toBe(729);
    expect(SYNTHESIS_POINTS.IMMORTAL).toBe(6561);
  });

  it("higher grades inflate by the decreasing synthesis success rate", () => {
    // IMMORTAL→ARCANA P_up 50.12% → 6561*9/0.5012 ≈ 117804
    expect(SYNTHESIS_POINTS.ARCANA).toBeCloseTo(117804, 0);
    expect(SYNTHESIS_POINTS.COSMIC).toBeCloseTo(658722275893, 0);
  });

  it("returns null for unknown / missing grades", () => {
    expect(synthesisPointsForGrade(null)).toBeNull();
    expect(synthesisPointsForGrade(undefined)).toBeNull();
    expect(synthesisPointsForGrade("UNKNOWN")).toBeNull();
  });

  it("applies the accessory multiplier (×3)", () => {
    expect(ACCESSORY_POINT_MULTIPLIER).toBe(3);
    expect(synthesisPointsForItem("COMMON", true)).toBe(3);
    expect(synthesisPointsForItem("UNCOMMON", true)).toBe(27);
    expect(synthesisPointsForItem("COMMON", false)).toBe(1);
    expect(synthesisPointsForItem(null, true)).toBeNull();
  });

  it("isAccessoryItem checks gearGroup strictly", () => {
    expect(isAccessoryItem({ gearGroup: "ACCESSORY" })).toBe(true);
    expect(isAccessoryItem({ gearGroup: "WEAPON" })).toBe(false);
    expect(isAccessoryItem({})).toBe(false);
    expect(isAccessoryItem(null)).toBe(false);
    expect(isAccessoryItem(undefined)).toBe(false);
  });

  it("synthesisPointsForGearItem combines grade and gearGroup", () => {
    expect(synthesisPointsForGearItem("RARE", { gearGroup: "ACCESSORY" })).toBe(81 * 3);
    expect(synthesisPointsForGearItem("RARE", { gearGroup: "WEAPON" })).toBe(81);
  });

  it("buildMaterialSynthesisPoints computes soulstone = its ACT box expected points from data", () => {
    // 普通灵魂石 → ACT Lv30(930301)；给该箱一个 100% 掉落的 IMMORTAL 内容物，
    // 期望 = 1.0 × 6561 → 覆盖值 6561（非自身品质触碰不到本表则回退品质）。
    const items = new Map<number, { grade?: string | null; gearGroup?: string | null }>([
      [12345, { grade: "IMMORTAL", gearGroup: null }],
    ]);
    const actBoxKey = SOULSTONE_ACT_BOX[190001];
    const override = buildMaterialSynthesisPoints({
      itemByKey: (k) => items.get(k),
      boxDrops: (key) =>
        key === actBoxKey ? [{ itemKey: 12345, grade: "IMMORTAL", dropPct: 100 }] : null,
      offerings: [],
    });
    expect(override[190001]).toBeCloseTo(6561, 5);
    // 覆盖值在 synthesisPointsForItemKey 中生效（与饰品倍率无关）。
    expect(synthesisPointsForItemKey(190001, "IMMORTAL", false, override)).toBeCloseTo(6561, 5);
    expect(synthesisPointsForItemKey(190001, "IMMORTAL", true, override)).toBeCloseTo(6561, 5);
  });

  it("buildMaterialSynthesisPoints computes offering coins from their loot list", () => {
    const items = new Map<number, { grade?: string | null; gearGroup?: string | null }>([
      [2001, { grade: "RARE", gearGroup: null }],
      [2002, { grade: "RARE", gearGroup: "ACCESSORY" }],
    ]);
    const override = buildMaterialSynthesisPoints({
      itemByKey: (k) => items.get(k),
      offerings: [{ coinKey: 160001, loot: [{ itemKey: 2001, poolPct: 100 }] }],
    });
    // 100% × rare(81) → 81
    expect(override[160001]).toBeCloseTo(81, 5);
    // 无 lookup 物品的 loot 项（无 grade）跳过不计。
    const override2 = buildMaterialSynthesisPoints({
      itemByKey: () => undefined,
      offerings: [{ coinKey: 160002, loot: [{ itemKey: 999999, poolPct: 100 }] }],
    });
    expect(override2[160002]).toBeUndefined();
  });

  it("synthesisPointsForItemKey returns overrideMap value when present, else quality", () => {
    const override: Record<number, number> = { 190001: 1234 };
    expect(synthesisPointsForItemKey(190001, "IMMORTAL", false, override)).toBe(1234);
    // 未在 overrideMap 中的 itemKey 回退到品质×饰品。
    expect(synthesisPointsForItemKey(601011, "RARE", false, override)).toBe(81);
    expect(synthesisPointsForItemKey(601011, "RARE", true, override)).toBe(81 * 3);
    // 无 overrideMap（undefined）时纯品质。
    expect(synthesisPointsForItemKey(190001, "IMMORTAL", false)).toBe(6561);
  });

  it("keeps grade-based points when no override is provided", () => {
    expect(synthesisPointsForItemKey(601011, "RARE", false)).toBe(81);
    expect(synthesisPointsForItemKey(601011, "RARE", true)).toBe(81 * 3);
    expect(synthesisPointsForItemKey(999999, "UNKNOWN", false)).toBeNull();
  });

  it("synthesisPointsForItemKeyByGear maps gearGroup to the accessory multiplier", () => {
    expect(
      synthesisPointsForItemKeyByGear({ itemKey: 601011, grade: "RARE", gearGroup: "ACCESSORY" }),
    ).toBe(81 * 3);
    expect(
      synthesisPointsForItemKeyByGear({ itemKey: 601011, grade: "RARE", gearGroup: "WEAPON" }),
    ).toBe(81);
    expect(
      synthesisPointsForItemKeyByGear({ itemKey: 601011, grade: "RARE", gearGroup: null }),
    ).toBe(81);
    expect(
      synthesisPointsForItemKeyByGear({ itemKey: 601011, grade: "RARE", gearGroup: undefined }),
    ).toBe(81);
  });

  it("synthesisPointsForItemKeyByGear honours an injected overrideMap", () => {
    const override: Record<number, number> = { 190001: 9999 };
    expect(
      synthesisPointsForItemKeyByGear({
        itemKey: 190001,
        grade: "IMMORTAL",
        gearGroup: "ACCESSORY",
        overrideMap: override,
      }),
    ).toBe(9999);
    // 未注入 overrideMap → 回退品质估值（IMMORTAL 6561 × 饰品 3 = 19683）。
    expect(
      synthesisPointsForItemKeyByGear({
        itemKey: 190001,
        grade: "IMMORTAL",
        gearGroup: "ACCESSORY",
      }),
    ).toBe(19683);
  });
});
