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
