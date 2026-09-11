import { stageName } from "../stages";
import type {
  LookupBoxCategory,
  LookupBoxDrop,
  LookupBoxDropVia,
  LookupBoxStageRef,
} from "./types";

/**
 * v1.02.00+ Plague (Contaminated) chest tiers, keyed by their 9xxx box id
 * prefix so they can be recognized independently of the Lookup source's
 * category tag (which classifies them as plain common/stage_boss/act_boss).
 */
export type BoxPlagueTier = "plagueCommon" | "plagueRare" | "plagueAct";

/** Map a box id prefix to its plague tier (915 = normal, 925 = stage, 935 = act boss). */
export function boxPlagueTier(boxItemKey: number): BoxPlagueTier | null {
  const key = String(boxItemKey);
  if (key.startsWith("915")) return "plagueCommon";
  if (key.startsWith("925")) return "plagueRare";
  if (key.startsWith("935")) return "plagueAct";
  return null;
}

/**
 * Acquisition-group semantics of a plague (Contaminated) chest, inferred from
 * the drop-source `via` and how many stages share this box:
 *   - `shared-group` — normal-monster drops, several adjacent stages share one box
 *     (e.g. Contaminated Normal Boxes cover a range like "21-1 – 21-5").
 *   - `unique-stage`  — dropped only by that stage's boss (one stage, one box).
 *   - `unique-act`    — dropped by an act boss (one box per act).
 * Pure — derived purely from the box id and its drop-stage refs, so UI can show
 * "is this chest shared across maps or unique to one?" without hardcoding.
 */
export type BoxPlagueRuleKind = "shared-group" | "unique-stage" | "unique-act";

export interface BoxPlagueRule {
  kind: BoxPlagueRuleKind;
  /** Number of stages that drop this box (1 = unique, >1 = shared group). */
  stageCount: number;
}

export function boxPlagueRule(
  boxItemKey: number,
  stages: ReadonlyArray<LookupBoxStageRef>,
): BoxPlagueRule | null {
  if (!boxPlagueTier(boxItemKey)) return null;
  const stageCount = stages.length;
  const via = stages[0]?.via;
  if (via === "act_boss") return { kind: "unique-act", stageCount };
  if (via === "boss_box") return { kind: "unique-stage", stageCount };
  return { kind: "shared-group", stageCount };
}

export interface BoxExpectedValue {
  /** Σ(dropPct × unit unit price) ÷ 100 across priced drops; null when no drop is priced. */
  value: number | null;
  /** Drops that resolved to a price. */
  pricedCount: number;
  /** Total drops in the box loot table. */
  totalCount: number;
  /** Sum of dropPct across priced drops (in %), same domain as individual dropPct. */
  pricedDropPctSum: number;
}

/**
 * Expected market value of opening one box: the probability-weighted sum of its
 * loot-table drops' unit prices. Pure — inject `unitPrice` (e.g. a
 * `useLookupPrices().resolve`-derived price) so it stays unit-testable.
 *
 * Drops without a price are skipped; if none are priced (`pricedCount === 0`)
 * `value` is null so the UI can degrade to "list loot only, no market data".
 */
export function boxExpectedValue(
  drops: ReadonlyArray<LookupBoxDrop>,
  unitPrice: (itemKey: number) => number | null,
): BoxExpectedValue {
  let value = 0;
  let pricedCount = 0;
  let pricedDropPctSum = 0;
  for (const drop of drops) {
    const unit = unitPrice(drop.itemKey);
    if (unit == null || !Number.isFinite(unit)) continue;
    value += (drop.dropPct * unit) / 100;
    pricedCount += 1;
    pricedDropPctSum += drop.dropPct;
  }
  return {
    value: pricedCount > 0 ? value : null,
    pricedCount,
    totalCount: drops.length,
    pricedDropPctSum,
  };
}

export const FIRST_DROP_ONLY_LABEL = "First clear only";

/** Compact stage key plus map name for box detail stage rows. */
export function boxStageListLabel(stageKey: number, displayName: string): string {
  return `${stageName(stageKey)} - ${displayName}`;
}

export function boxCategoryLabel(category: LookupBoxCategory): string {
  switch (category) {
    case "common":
      return "Common chest";
    case "stage_boss":
      return "Stage boss chest";
    case "act_boss":
      return "Act boss chest";
    default:
      return "Chest";
  }
}

export function boxDropViaLabel(via: LookupBoxDropVia): string {
  switch (via) {
    case "monster_box":
      return "Monster kill";
    case "boss_box":
      return "Stage boss kill";
    case "act_boss":
      return "Act boss kill";
  }
}

/** Split tbh-data `dropStageRangeLabel` into one line per range chunk. */
export function splitDropStageRangeLines(label: string): string[] {
  const trimmed = label.trim();
  if (!trimmed || trimmed === "—") return [];
  return trimmed
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface BoxDropViaSummary {
  via: LookupBoxDropVia;
  label: string;
  minPct: number;
  maxPct: number;
}

const DROP_VIA_ORDER: LookupBoxDropVia[] = ["monster_box", "boss_box", "act_boss"];

/** Group farm stages by kill type with min/max spawn % per via. */
export function boxDropViaSummaries(stages: LookupBoxStageRef[]): BoxDropViaSummary[] {
  const buckets = new Map<LookupBoxDropVia, number[]>();
  for (const stage of stages) {
    const pcts = buckets.get(stage.via) ?? [];
    pcts.push(stage.spawnPct);
    buckets.set(stage.via, pcts);
  }

  return DROP_VIA_ORDER.filter((via) => buckets.has(via)).map((via) => {
    const pcts = buckets.get(via)!;
    return {
      via,
      label: boxDropViaLabel(via),
      minPct: Math.min(...pcts),
      maxPct: Math.max(...pcts),
    };
  });
}

/** Min/max spawnPct across farm stages (JSON already in %). */
export function summarizeSpawnPcts(
  stages: LookupBoxStageRef[],
): { min: number; max: number } | null {
  if (stages.length === 0) return null;
  const pcts = stages.map((s) => s.spawnPct);
  return { min: Math.min(...pcts), max: Math.max(...pcts) };
}
