import { describe, it, expect } from "vitest";
import {
  MAX_STACK_PER_SLOT,
  clampStackQuantity,
  materialStacksFromSlots,
  type SlotEntry,
} from "../../src/core/inventory/stacks";

const MATERIAL_KEY = 141002;
const isMaterial = (key: number) => key === MATERIAL_KEY;

/** UniqueId -> catalog ItemKey, as built from `itemSaveDatas`. */
const idToKey = new Map<string, number>([["1001", MATERIAL_KEY]]);

function slot(
  itemUniqueId: string,
  quantity: number | null,
  location: SlotEntry["location"] = "stash",
): SlotEntry {
  return { itemUniqueId, quantity, isUnlock: true, location };
}

describe("MAX_STACK_PER_SLOT", () => {
  it("is 5", () => {
    expect(MAX_STACK_PER_SLOT).toBe(5);
  });
});

describe("clampStackQuantity", () => {
  it("clamps below zero and above the cap", () => {
    expect(clampStackQuantity(-3)).toBe(0);
    expect(clampStackQuantity(0)).toBe(0);
    expect(clampStackQuantity(3)).toBe(3);
    expect(clampStackQuantity(5)).toBe(5);
    expect(clampStackQuantity(9)).toBe(5);
  });

  it("treats missing/NaN/null as zero", () => {
    expect(clampStackQuantity(null)).toBe(0);
    expect(clampStackQuantity(undefined)).toBe(0);
    expect(clampStackQuantity(Number.NaN)).toBe(0);
    expect(clampStackQuantity(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("materialStacksFromSlots", () => {
  it("sums the same material across slots (7 = 5 + 2)", () => {
    const totals = materialStacksFromSlots([slot("1001", 5), slot("1001", 2)], idToKey, isMaterial);
    const entry = totals.get(MATERIAL_KEY)!;
    expect(entry.total).toBe(7);
    expect(entry.stash).toBe(7);
  });

  it("splits the total by bag", () => {
    const totals = materialStacksFromSlots(
      [slot("1001", 3, "inventory"), slot("1001", 4, "stash"), slot("1001", 1, "trading")],
      idToKey,
      isMaterial,
    );
    const entry = totals.get(MATERIAL_KEY)!;
    expect(entry.total).toBe(8);
    expect(entry.inventory).toBe(3);
    expect(entry.stash).toBe(4);
    expect(entry.trading).toBe(1);
  });

  it("ignores empty slots and Quantity <= 0", () => {
    const totals = materialStacksFromSlots(
      [slot("0", 5), slot("1001", 0), slot("1001", null), slot("1001", 2)],
      idToKey,
      isMaterial,
    );
    expect(totals.get(MATERIAL_KEY)!.total).toBe(2);
  });

  it("clamps each slot to the per-slot cap before summing", () => {
    const totals = materialStacksFromSlots([slot("1001", 9), slot("1001", 2)], idToKey, isMaterial);
    expect(totals.get(MATERIAL_KEY)!.total).toBe(7);
  });

  it("skips ids not present in itemSaveDatas and non-material keys", () => {
    const totals = materialStacksFromSlots(
      [slot("9999", 5), slot("1001", 1)],
      idToKey,
      (key) => key === MATERIAL_KEY || key === 322111,
    );
    expect(totals.has(322111)).toBe(false);
    expect(totals.get(MATERIAL_KEY)!.total).toBe(1);
  });

  it("returns an empty map when no slot carries a Quantity (old save)", () => {
    const totals = materialStacksFromSlots([slot("1001", null)], idToKey, isMaterial);
    expect(totals.size).toBe(0);
  });
});
