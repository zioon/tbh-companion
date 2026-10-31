import type { BoxSlotStatus } from "../../../shared/types";
import type { ChestCapDefinition, RuneBoxCapCatalog } from "./catalog";
import type { RunePurchase } from "./runes";
import { runeCapacityBonus } from "./runes";

export function boxCapacity(purchases: RunePurchase[], def: ChestCapDefinition): number {
  const bonus = runeCapacityBonus(purchases, def);
  return def.baseCapacity + bonus;
}

export function commonBoxCapacity(purchases: RunePurchase[], catalog: RuneBoxCapCatalog): number {
  return boxCapacity(purchases, catalog.common);
}

export function stageBossBoxCapacity(
  purchases: RunePurchase[],
  catalog: RuneBoxCapCatalog,
): number {
  return boxCapacity(purchases, catalog.stageBoss);
}

export function actBossBoxCapacity(purchases: RunePurchase[], catalog: RuneBoxCapCatalog): number {
  return boxCapacity(purchases, catalog.actBoss);
}

/** v1.02.00 Plague (Contaminated) common chest capacity. */
export function plagueCommonBoxCapacity(
  purchases: RunePurchase[],
  catalog: RuneBoxCapCatalog,
): number {
  return boxCapacity(purchases, catalog.plagueCommon);
}

/** v1.02.00 Plague (Contaminated) stage boss chest capacity. */
export function plagueRareBoxCapacity(
  purchases: RunePurchase[],
  catalog: RuneBoxCapCatalog,
): number {
  return boxCapacity(purchases, catalog.plagueRare);
}

/** v1.02.00 Plague (Contaminated) act boss chest capacity. */
export function plagueActBoxCapacity(
  purchases: RunePurchase[],
  catalog: RuneBoxCapCatalog,
): number {
  return boxCapacity(purchases, catalog.plagueAct);
}

/**
 * v1.3.0 万圣节普通活动箱（940xxx）容量。
 *
 * 活动箱在游戏里占用 common / rare 桶（无 `MaxAmountEvent*Chest` 链），这里
 * 仍按产品决策给它**独立箱位**，数值沿用 common 链。
 */
export function eventNormalBoxCapacity(
  purchases: RunePurchase[],
  catalog: RuneBoxCapCatalog,
): number {
  return boxCapacity(purchases, catalog.eventNormal);
}

/**
 * v1.3.0 万圣节关卡活动箱（941xxx）容量。
 *
 * 同样没有专属符文链，数值沿用 stage boss 链。
 */
export function eventStageBoxCapacity(
  purchases: RunePurchase[],
  catalog: RuneBoxCapCatalog,
): number {
  return boxCapacity(purchases, catalog.eventStage);
}

export function boxSlotState(heldQty: number, capacity: number): BoxSlotStatus {
  const quantity = Math.max(0, heldQty);
  const cap = Math.max(0, capacity);
  const isFull = quantity > 0 && quantity >= cap;
  return {
    quantity,
    capacity: cap,
    isFull,
    slotsRemaining: Math.max(0, cap - quantity),
  };
}

/** @deprecated use boxSlotState */
export const commonBoxState = boxSlotState;
