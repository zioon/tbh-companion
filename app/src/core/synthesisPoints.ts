// 合成点数：宝箱价值评价体系。
//
// 按掉落物品的品质给一个「合成点数」：普通 1 点、罕见 9 点，更高品质按合成
// 成功率逐级递归（见下方推导），饰品类（gearGroup === "ACCESSORY"）为一般的
// 3 倍。纯函数，无 Electron / node / React 依赖，可单元测试。

/**
 * 基础合成点数表（非饰品）。来源：以 COMMON=1、UNCOMMON=9 为锚点，按
 * `data/synthesis_model.json` 每级「合成升到下一级的上浮概率」递归：
 *
 *     V[g] = V[g-1] * 9 / P_up(g-1)
 *     P_up(g) = ( weights[+1] + weights[+2] ) / total(g)
 *
 * 其中 9 为合成单次消耗的材料数（materialAmount，各合成类型恒为 9）。
 * COMMON..IMMORTAL 各级 P_up 恒为 1（低品质几乎必然升级），故点数恰为 9 的
 * 次幂（1 / 9 / 81 / 729 / 6561）；IMMORTAL 起 P_up 逐级下降，点数按成功率
 * 膨胀：IMMORTAL→ARCANA 50.12%、ARCANA→BEYOND 33.44%、BEYOND→CELESTIAL
 * 23.14%、CELESTIAL→DIVINE 16.68%、DIVINE→COSMIC 9.09%。数值与产品确认记录
 * 一致。
 */
export const SYNTHESIS_POINTS: Readonly<Record<string, number>> = Object.freeze({
  COMMON: 1,
  UNCOMMON: 9,
  RARE: 81,
  LEGENDARY: 729,
  IMMORTAL: 6561,
  ARCANA: 117804.22388059703,
  BEYOND: 3170164.4127868125,
  CELESTIAL: 123320448.86817536,
  DIVINE: 6653760362.558724,
  COSMIC: 658722275893.3137,
});

/** 饰品类（gearGroup === "ACCESSORY"）的合成点数倍率。 */
export const ACCESSORY_POINT_MULTIPLIER = 3;

/** 是否为饰品类。gearGroup 为空忽略；仅当严格等于 "ACCESSORY" 时视为饰品。 */
export function isAccessoryItem(item: { gearGroup?: string | null } | null | undefined): boolean {
  return item != null && item.gearGroup === "ACCESSORY";
}

/** 单一品质的基础合成点数；品质未知/不受支持返回 null。 */
export function synthesisPointsForGrade(grade: string | null | undefined): number | null {
  if (!grade) return null;
  return SYNTHESIS_POINTS[grade] ?? null;
}

/**
 * 某品质在「是否饰品」下的合成点数 = 基础点数 × (饰品 ? 3 : 1)。
 * 品质未知返回 null。
 */
export function synthesisPointsForItem(
  grade: string | null | undefined,
  isAccessory: boolean,
): number | null {
  const base = synthesisPointsForGrade(grade);
  if (base == null) return null;
  return isAccessory ? base * ACCESSORY_POINT_MULTIPLIER : base;
}

/** 便捷版：直接按物品（含 gearGroup）判断是否为饰品并计算合成点数。 */
export function synthesisPointsForGearItem(
  grade: string | null | undefined,
  item: { gearGroup?: string | null } | null | undefined,
): number | null {
  return synthesisPointsForItem(grade, isAccessoryItem(item));
}

/**
 * 特殊材料的合成点覆盖规则（数据驱动，运行时由 `buildMaterialSynthesisPoints` 现算）：
 * - 灵魂石（Soulstone）：对应以难度映射到的 ACT(章节)宝箱 的合成点——普通→Act Lv30、
 *   噩梦→Act Lv50、地狱→Act Lv85、折磨→Act Lv90；被污染→对应污染章 Act 箱。
 *   该「难庭→ACT箱号」是产品规则（灵魂石不被 ACT 箱掉落，无法从数据推导），故需保留本表；
 *   但**值（箱期望）由数据现算**，不手写。
 * - 纪念硬币（offering coin 160001~160010）：按其「开出物品清单+概率」参考宝箱算法
 *   估值——Σ(loot.poolPct/100 × 该项单点)，开启概率来自 `data/offerings.json`（运行时现算）。
 *
 * 普通硬币/硬币堆（150001~150007）无 offer 开出清单也无宝箱关联，不做覆盖（按品质估值）。
 */
export const SOULSTONE_ACT_BOX: Readonly<Record<number, number>> = Object.freeze({
  190001: 930301, // 普通 → Act Boss Box Lv30
  190002: 930501, // 噩梦 → Act Boss Box Lv50
  190003: 930851, // 地狱 → Act Boss Box Lv85
  190004: 930901, // 折磨 → Act Boss Box Lv90
  190102: 935001, // 被污染 噩梦 → Contaminated ActBoss (N) -1
  190103: 935103, // 被污染 地狱 → Contaminated ActBoss (H) -3
  190104: 935202, // 被污染 折磨 → Contaminated ActBoss (T) -2
});

/** 箱子内容物条目（`lookup_sources.boxes[boxKey].drops` 的最小结构）。 */
export interface SynthesisBoxDrop {
  itemKey: number;
  grade?: string | null;
  dropPct: number;
}
/** 硬币开出条目（`offerings.loot` 的最小结构）。 */
export interface SynthesisOfferLoot {
  itemKey: number;
  poolPct: number;
}
/** 单一物品（`lookup_items` 的最小结构，用于判定品质与是否饰品）。 */
export interface SynthesisSourceItem {
  grade?: string | null;
  gearGroup?: string | null;
}
/** 构建材料覆盖表所需的外部数据（main / renderer 各自喂入）。 */
export interface SynthesisPointsData {
  /** itemKey → 物品（品质/饰品判定）。 */
  itemByKey: (itemKey: number) => SynthesisSourceItem | undefined;
  /** boxKey → 该箱内容物（掉率+品质）；缺省/无 = 无法算该箱期望。 */
  boxDrops?: (boxKey: number) => SynthesisBoxDrop[] | null | undefined;
  /** 硬币开出清单。 */
  offerings?: Array<{ coinKey: number; loot: SynthesisOfferLoot[] }>;
}

/** 单点（基础品质 × 饰品倍率）；缺图鉴时用 drop.grade 兜底。 */
function unitPoint(
  item: SynthesisSourceItem | undefined,
  grade: string | null | undefined,
): number | null {
  const base = synthesisPointsForGrade(item?.grade ?? grade);
  if (base == null || !item) return base == null ? null : base;
  // 有完整 item（含 gearGroup）时才按饰品类 ×3
  return isAccessoryItem(item) ? base * ACCESSORY_POINT_MULTIPLIER : base;
}

/**
 * 由数据现算「特殊材料覆盖表」：灵魂石（=对应 ACT 箱的期望合成点）、纪念硬币
 * （=其 offer 开出清单的期望合成点）。数据更新自动跟随，无需手写数值。
 */
export function buildMaterialSynthesisPoints(data: SynthesisPointsData): Record<number, number> {
  const out: Record<number, number> = {};

  // 灵魂石 → 对应 ACT 箱的期望合成点 = Σ(dropPct/100 × 单点)
  const boxDrops = data.boxDrops ?? (() => null);
  for (const [itemKey, actBox] of Object.entries(SOULSTONE_ACT_BOX)) {
    const drops = boxDrops(Number(actBox));
    if (!drops?.length) continue;
    let sum = 0;
    let any = false;
    for (const d of drops) {
      const item = data.itemByKey(d.itemKey);
      const u = unitPoint(item, d.grade);
      if (u == null) continue;
      any = true;
      sum += (d.dropPct / 100) * u;
    }
    if (any) out[Number(itemKey)] = sum;
  }

  // 纪念硬币 → 其 offer 清单期望 = Σ(poolPct/100 × 单点)
  for (const entry of data.offerings ?? []) {
    let sum = 0;
    let any = false;
    for (const l of entry.loot) {
      const item = data.itemByKey(l.itemKey);
      const u = unitPoint(item, item?.grade); // offer loot 无 grade，靠 lookup_items
      if (u == null) continue;
      any = true;
      sum += (l.poolPct / 100) * u;
    }
    if (any) out[entry.coinKey] = sum;
  }

  return out;
}

/**
 * 某 itemKey 的合成数：命中传入的 `overrideMap`（灵魂石/纪念硬币，由
 * `buildMaterialSynthesisPoints` 现算）用覆盖值，否则按品质 + 饰品倍率。
 */
export function synthesisPointsForItemKey(
  itemKey: number,
  grade: string | null | undefined,
  isAccessory: boolean,
  overrideMap?: Readonly<Record<number, number>> | null,
): number | null {
  if (overrideMap) {
    const override = overrideMap[itemKey];
    if (override != null) return override;
  }
  return synthesisPointsForItem(grade, isAccessory);
}

/**
 * 便捷版：直接按物品的 gearGroup 判断是否为饰品并计算合成点数。
 * 供物品页/图鉴页/交易页三处页面统一调用，避免在各自判断 `gearGroup === "ACCESSORY"`。
 */
export function synthesisPointsForItemKeyByGear({
  itemKey,
  grade,
  gearGroup,
  overrideMap,
}: {
  itemKey: number;
  grade: string | null | undefined;
  gearGroup?: string | null;
  overrideMap?: Readonly<Record<number, number>> | null;
}): number | null {
  return synthesisPointsForItemKey(itemKey, grade, isAccessoryItem({ gearGroup }), overrideMap);
}
