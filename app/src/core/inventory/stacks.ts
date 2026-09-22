// Material stacking semantics — per-slot stack capacity + cross-slot summing.
//
// Game update (post-v1.2.2): material-class items stack inside a single bag
// slot, up to `MAX_STACK_PER_SLOT` copies per slot. The authoritative per-slot
// stack size lives on the **slot objects** (`inventorySaveDatas[]`,
// `stashSaveDatas[]`, `remakeTradingStashSaveDatas[]`) as a `Quantity` field —
// NOT on `itemSaveDatas[]`. Verified against a live save:
//
//   inventorySaveDatas: [{ "Index":1, "ItemUniqueId":551278195918962700,
//                          "IsUnlock":true, "Quantity":2 }, ...]
//   stashSaveDatas:     [{ "Index":0, "ItemUniqueId":551278195918962700,
//                          "IsUnLock":true, "Quantity":5 }, ...]
//
// Several slots may reference the same material (`ItemUniqueId` points at the
// `itemSaveDatas` row whose `ItemKey` is the catalog id), e.g. 7 copies of a
// material occupy two slots as `5 + 2`. The **total** owned quantity is the SUM
// of every non-empty slot's `Quantity` — never a per-slot max, never a slot
// count.
//
// Backward compatibility: older saves (or a future patch that drops the field)
// simply lack `Quantity`; `materialStacksFromSlots` then contributes nothing and
// the caller falls back to the lifetime-aggregate path. Never throws.

import type { MaterialStackTotal } from "../../../shared/types";

/** Maximum number of identical materials that fit in one bag slot. */
export const MAX_STACK_PER_SLOT = 5;

/** Which bag the slot belongs to — mirrors the location the item resolves to. */
export type StackSlotLocation = "inventory" | "stash" | "trading";

/** A parsed bag/stash slot row (both string-regex and object paths normalize to this). */
export interface SlotEntry {
  /** Raw slot `ItemUniqueId` digit string (`"0"` = empty slot). */
  itemUniqueId: string;
  /** Per-slot stack size. `null` when the field is absent (old save / field removed). */
  quantity: number | null;
  /** Whether the slot is unlocked (capacity). */
  isUnlock: boolean;
  /** Which bag the slot sits in. Defaults to `"inventory"` when not threaded. */
  location?: StackSlotLocation;
}

/** Clamp one slot's stack size into `[0, MAX_STACK_PER_SLOT]`. */
export function clampStackQuantity(quantity: number | null | undefined): number {
  if (quantity == null || !Number.isFinite(quantity)) return 0;
  const truncated = Math.trunc(quantity);
  if (truncated <= 0) return 0;
  return Math.min(truncated, MAX_STACK_PER_SLOT);
}

/**
 * Total owned quantity per material ItemKey, summed across every slot.
 *
 * Joins each slot's `ItemUniqueId` (string, lossless — ids exceed
 * `Number.MAX_SAFE_INTEGER`) to its catalog `ItemKey` via `itemKeyByUniqueId`,
 * then sums the per-slot `Quantity`:
 *   - empty slots (`ItemUniqueId === "0"`) are ignored;
 *   - `Quantity <= 0` / missing slots are ignored;
 *   - each slot contributes at most {@link MAX_STACK_PER_SLOT} (defensive clamp).
 *
 * Only ItemKeys accepted by `isMaterialItemKey` are kept. The returned map
 * carries the grand total plus the per-bag split so `resolve` can keep
 * `inventoryCount` / `stashCount` / `tradingCount` accurate.
 */
export function materialStacksFromSlots(
  slots: readonly SlotEntry[],
  itemKeyByUniqueId: ReadonlyMap<string, number>,
  isMaterialItemKey: (itemKey: number) => boolean,
): Map<number, MaterialStackTotal> {
  const totals = new Map<number, MaterialStackTotal>();
  for (const slot of slots) {
    const uniqueId = slot.itemUniqueId;
    if (!uniqueId || uniqueId === "0") continue;
    const perSlot = clampStackQuantity(slot.quantity);
    if (perSlot <= 0) continue;
    const itemKey = itemKeyByUniqueId.get(uniqueId);
    if (itemKey == null || !isMaterialItemKey(itemKey)) continue;

    const entry = totals.get(itemKey) ?? { total: 0, inventory: 0, stash: 0, trading: 0 };
    const location = slot.location ?? "inventory";
    entry.total += perSlot;
    entry[location] += perSlot;
    totals.set(itemKey, entry);
  }
  return totals;
}
