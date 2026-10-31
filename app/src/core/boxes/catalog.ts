import { readBundledJson } from "../bundledData";
// P2-1: `BoxCategory` is defined once in `shared/types.ts` (canonical tracker-side
// vocabulary). Re-exported here so existing `import { BoxCategory } from "./catalog"`
// call sites keep working without churn.
import type { BoxCategory } from "../../../shared/types";
export type { BoxCategory };

export interface BoxTypeEntry {
  boxType: number;
  label: string;
  category: BoxCategory;
  color: string;
}

export interface BoxTypeCatalog {
  types: BoxTypeEntry[];
}

export interface ChestCapDefinition {
  boxType: number;
  baseCapacity: number;
  bonusPerLevel: number;
  runeLabel: string;
  runeKeys: number[];
}

export interface RuneBoxCapCatalog {
  common: ChestCapDefinition;
  stageBoss: ChestCapDefinition;
  actBoss: ChestCapDefinition;
  /** v1.02.00 Plague (Contaminated) chests — stored separately from normal ones. */
  plagueCommon: ChestCapDefinition;
  plagueRare: ChestCapDefinition;
  plagueAct: ChestCapDefinition;
  /**
   * v1.3.0 万圣节普通活动箱（940xxx）——独立箱位。
   *
   * 游戏没有 `MaxAmountEvent*Chest` 链，故数值沿用 common 链（base 5、
   * +1/级、同一批符文节点）；箱位本身是 companion 侧的独立记账单位。
   */
  eventNormal: ChestCapDefinition;
  /**
   * v1.3.0 万圣节关卡活动箱（941xxx）——独立箱位，与普通箱 / 关卡宝箱对称。
   *
   * 同样没有专属符文链，数值沿用 stage boss 链（base 5、+1/级、同一批节点）。
   */
  eventStage: ChestCapDefinition;
  note?: string;
}

export interface AutoOpenDefinition {
  baseSeconds: number;
  runeLabel: string;
  /** Seconds shaved off per purchased level, keyed by rune node id. */
  perLevelSeconds: Record<string, number>;
}

export interface RuneAutoOpenCatalog {
  common: AutoOpenDefinition;
  stageBoss: AutoOpenDefinition;
  actBoss: AutoOpenDefinition;
  /** v1.02.00 Plague (Contaminated) chests — stored separately from normal ones. */
  plagueCommon: AutoOpenDefinition;
  plagueRare: AutoOpenDefinition;
  plagueAct: AutoOpenDefinition;
  /**
   * No `eventNormal` / `eventStage` entries: the v1.3.0 Halloween event boxes
   * (940xxx/941xxx) have **no auto-open at all**. The game's auto-open chain is
   * keyed by the box's own type (`UnlockAutoOpen*Chest` / `ReduceAutoOpen*ChestTime`,
   * one family per common / stage-boss / act-boss / plague tier) and
   * `RuneInfoData` / `RuneLevelInfoData` carry no `UnlockAutoOpenEvent*Chest`
   * node — the game never opens an event chest on a timer, the player opens it
   * by hand. Event chests therefore never enter the auto-classify queue.
   */
  note?: string;
}

export interface RuneWaveCatalog {
  runeLabel: string;
  /** 每级减少的关卡波数，键为符文节点 RuneKey 字符串。 */
  reductionPerLevel: Record<string, number>;
  note?: string;
}

/**
 * v1.3.0 掉率符文（Rune of Exploration / Rune of Conquest）。
 *
 * 游戏的 stat 名带 `Percent` 后缀（`DropChanceNormalChestPercent`），
 * 语义是「掉率**乘数**提升百分比」——`AccountStat_DropChance*Percent` =
 * `'{0}% Increased ... Drop Chance Multiplier'`。每级同值，故总加成 =
 * Σ(已购等级 × perLevelPercent)，与其余符文族同构。
 */
export interface RuneDropChanceDefinition {
  runeLabel: string;
  /** 每级提供的掉率乘数提升百分比，键为符文节点 RuneKey 字符串。 */
  perLevelPercent: Record<string, number>;
}

export interface RuneDropChanceCatalog {
  common: RuneDropChanceDefinition;
  stageBoss: RuneDropChanceDefinition;
  plagueCommon: RuneDropChanceDefinition;
  plagueRare: RuneDropChanceDefinition;
  note?: string;
}

export function loadBoxTypeCatalog(): BoxTypeCatalog {
  return readBundledJson<BoxTypeCatalog>("box_types.json");
}

export function loadRuneBoxCapCatalog(): RuneBoxCapCatalog {
  return readBundledJson<RuneBoxCapCatalog>("rune_box_cap.json");
}

export function loadRuneAutoOpenCatalog(): RuneAutoOpenCatalog {
  return readBundledJson<RuneAutoOpenCatalog>("rune_auto_open.json");
}

export function loadRuneWaveCatalog(): RuneWaveCatalog {
  return readBundledJson<RuneWaveCatalog>("rune_wave.json");
}

export function loadRuneDropChanceCatalog(): RuneDropChanceCatalog {
  return readBundledJson<RuneDropChanceCatalog>("rune_drop_chance.json");
}

export function boxTypeIndex(catalog: BoxTypeCatalog): Map<number, BoxTypeEntry> {
  return new Map(catalog.types.map((t) => [t.boxType, t]));
}
