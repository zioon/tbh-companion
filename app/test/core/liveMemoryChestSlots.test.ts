import { describe, it, expect } from "vitest";
import { readIntArray, readRuntimeChestSlots } from "../../src/core/liveMemory/chestSlots";
import { offsetsForVersion } from "../../src/core/liveMemory/offsets";
import type { LiveOffsets } from "../../src/core/liveMemory/offsets";
import { FakeMemory } from "./liveMemoryFake";
import type { BoxCategory } from "../../shared/types";

const GA_BASE = 0x140000000n;
const GA_SIZE = 0x6000000;

// Heap anchors for the synthetic memory chain.
const PLAYER_PTR = 0x500000n;
const BOX_DATA_PTR = 0x600000n;
const TYPES_LIST_PTR = 0x700000n;
const TYPES_ITEMS_PTR = 0x710000n;
const QTY_LIST_PTR = 0x800000n;
const QTY_ITEMS_PTR = 0x810000n;

const CAND = 0xb0; // first static-field candidate offset in il2cppClass.staticFieldsOffsets

/** Build a working offsets table by overriding the boxData fields on the
 *  canonical 1.00.21 table — keeps the test robust to unrelated offset drift. */
function makeOffsets(overrides?: {
  playerBoxData?: number;
  boxTypes?: number;
  boxQuantity?: number;
}): LiveOffsets {
  const o = offsetsForVersion("1.00.21")!;
  return {
    ...o,
    player: { ...o.player, boxData: overrides?.playerBoxData ?? 0x80 },
    boxData: {
      boxTypes: overrides?.boxTypes ?? 0x10,
      boxQuantity: overrides?.boxQuantity ?? 0x18,
    },
  };
}

/** Catalog mapping: boxType int → tracker BoxCategory. */
function makeCatalog(): Map<number, BoxCategory> {
  return new Map<number, BoxCategory>([
    [100, "common"],
    [200, "rare"],
    [300, "act"],
    [999, "unclassified"],
  ]);
}

/** Seed a List<int> with the given int values at the given list pointer.
 *  List layout: +listItems (0x10) = items array ptr; +listSize (0x18) = size.
 *  Array layout: +0x18 = length, +0x20 = first element (arrayFirst from container). */
function seedListInt(
  m: FakeMemory,
  listPtr: bigint,
  itemsPtr: bigint,
  values: number[],
): FakeMemory {
  m.writePtr(listPtr + 0x10n, itemsPtr);
  m.writeI32(listPtr + 0x18n, values.length);
  for (let i = 0; i < values.length; i++) {
    m.writeI32(itemsPtr + 0x20n + BigInt(i * 4), values[i]);
  }
  return m;
}

describe("readIntArray", () => {
  it("reads a List<int> via _items + _size", () => {
    const m = new FakeMemory();
    // fieldPtr (at obj + fieldOff) holds the List<int>* — seed it to TYPES_LIST_PTR.
    m.writePtr(0x1000n, TYPES_LIST_PTR);
    seedListInt(m, TYPES_LIST_PTR, TYPES_ITEMS_PTR, [10, 20, 30]);
    const c = { listItems: 0x10, listSize: 0x18, arrayFirst: 0x20 };
    expect(readIntArray(m, 0x1000n, /* fieldOff */ 0x0, c)).toEqual([10, 20, 30]);
  });

  it("returns null when the field pointer is unreadable", () => {
    const m = new FakeMemory(); // nothing seeded
    const c = { listItems: 0x10, listSize: 0x18, arrayFirst: 0x20 };
    expect(readIntArray(m, 0x9999n, 0x0, c)).toBeNull();
  });

  it("returns null when size is implausibly large", () => {
    const m = new FakeMemory()
      .writePtr(0x1000n, TYPES_LIST_PTR)
      .writePtr(TYPES_LIST_PTR + 0x10n, TYPES_ITEMS_PTR)
      .writeI32(TYPES_LIST_PTR + 0x18n, 10_000); // > MAX_CHEST_SLOTS
    const c = { listItems: 0x10, listSize: 0x18, arrayFirst: 0x20 };
    expect(readIntArray(m, 0x1000n, 0x0, c)).toBeNull();
  });

  it("returns null when size is <= 0", () => {
    const m = new FakeMemory()
      .writePtr(0x1000n, TYPES_LIST_PTR)
      .writePtr(TYPES_LIST_PTR + 0x10n, TYPES_ITEMS_PTR)
      .writeI32(TYPES_LIST_PTR + 0x18n, 0);
    const c = { listItems: 0x10, listSize: 0x18, arrayFirst: 0x20 };
    expect(readIntArray(m, 0x1000n, 0x0, c)).toBeNull();
  });

  it("falls back to direct int[] path when _items pointer is unreadable", () => {
    // fieldPtr is the list-like object. _items at +0x10 holds a low pointer
    // (readPtr returns null), so the List branch fails and readDirectIntArray
    // treats fieldPtr itself as the array: length at +0x18, first elem at +0x20.
    const m = new FakeMemory()
      .writePtr(0x1000n, TYPES_LIST_PTR) // fieldPtr = array-like object
      .writePtr(TYPES_LIST_PTR + 0x10n, 0x10n) // _items low ⇒ itemsPtr null
      .writeI32(TYPES_LIST_PTR + 0x18n, 2) // array length (also listSize, but unused on fallback)
      .writeI32(TYPES_LIST_PTR + 0x20n, 7)
      .writeI32(TYPES_LIST_PTR + 0x24n, 8);
    const c = { listItems: 0x10, listSize: 0x18, arrayFirst: 0x20 };
    expect(readIntArray(m, 0x1000n, 0x0, c)).toEqual([7, 8]);
  });
});

describe("readRuntimeChestSlots — offset guards", () => {
  it("returns null with status when player.boxData offset = 0", () => {
    const o = makeOffsets({ playerBoxData: 0 });
    const r = readRuntimeChestSlots(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      o,
      makeCatalog(),
      PLAYER_PTR,
    );
    expect(r.slots).toBeNull();
    expect(r.status).toContain("player.boxData offset = 0");
  });

  it("returns null with status when boxData.boxTypes offset = 0", () => {
    const o = makeOffsets({ boxTypes: 0 });
    const r = readRuntimeChestSlots(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      o,
      makeCatalog(),
      PLAYER_PTR,
    );
    expect(r.slots).toBeNull();
    expect(r.status).toContain("boxData struct offsets not derived");
  });

  it("returns null with status when boxData.boxQuantity offset = 0", () => {
    const o = makeOffsets({ boxQuantity: 0 });
    const r = readRuntimeChestSlots(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      o,
      makeCatalog(),
      PLAYER_PTR,
    );
    expect(r.slots).toBeNull();
    expect(r.status).toContain("boxData struct offsets not derived");
  });
});

describe("readRuntimeChestSlots — full path", () => {
  it("aggregates BoxTypes × BoxQuantity into per-category totals", () => {
    const o = makeOffsets();
    const m = new FakeMemory();
    // playerPtr → boxDataPtr
    m.writePtr(PLAYER_PTR + BigInt(o.player.boxData), BOX_DATA_PTR);
    // boxData.boxTypes field at BOX_DATA_PTR + 0x10 → TYPES_LIST_PTR
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxTypes), TYPES_LIST_PTR);
    // boxData.boxQuantity field at BOX_DATA_PTR + 0x18 → QTY_LIST_PTR
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxQuantity), QTY_LIST_PTR);
    // BoxTypes = [100 (common), 200 (rare), 300 (act), 100 (common), 999 (unclassified)]
    seedListInt(m, TYPES_LIST_PTR, TYPES_ITEMS_PTR, [100, 200, 300, 100, 999]);
    // BoxQuantity = [3, 1, 2, 4, 5]  ⇒ common=7, rare=1, act=2 (999 skipped)
    seedListInt(m, QTY_LIST_PTR, QTY_ITEMS_PTR, [3, 1, 2, 4, 5]);

    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), PLAYER_PTR);
    expect(r.slots).toEqual({ common: 7, rare: 1, act: 2 });
    expect(r.status).toBe("");
  });

  it("returns zero totals when all BoxTypes are unknown", () => {
    const o = makeOffsets();
    const m = new FakeMemory();
    m.writePtr(PLAYER_PTR + BigInt(o.player.boxData), BOX_DATA_PTR);
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxTypes), TYPES_LIST_PTR);
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxQuantity), QTY_LIST_PTR);
    seedListInt(m, TYPES_LIST_PTR, TYPES_ITEMS_PTR, [888, 889]); // unknown types
    seedListInt(m, QTY_LIST_PTR, QTY_ITEMS_PTR, [10, 20]);
    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), PLAYER_PTR);
    expect(r.slots).toEqual({ common: 0, rare: 0, act: 0 });
  });

  it("returns null when types.length !== quantities.length", () => {
    const o = makeOffsets();
    const m = new FakeMemory();
    m.writePtr(PLAYER_PTR + BigInt(o.player.boxData), BOX_DATA_PTR);
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxTypes), TYPES_LIST_PTR);
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxQuantity), QTY_LIST_PTR);
    seedListInt(m, TYPES_LIST_PTR, TYPES_ITEMS_PTR, [100, 200]); // length 2
    seedListInt(m, QTY_LIST_PTR, QTY_ITEMS_PTR, [1]); // length 1
    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), PLAYER_PTR);
    expect(r.slots).toBeNull();
    expect(r.status).toContain("length mismatch");
  });

  it("returns null when BoxData pointer is null", () => {
    const o = makeOffsets();
    // playerPtr + boxData offset holds a low (null) pointer
    const m = new FakeMemory().writePtr(PLAYER_PTR + BigInt(o.player.boxData), 0x100n);
    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), PLAYER_PTR);
    expect(r.slots).toBeNull();
    expect(r.status).toContain("BoxData pointer null");
  });

  it("returns null when BoxTypes array is unreadable", () => {
    const o = makeOffsets();
    const m = new FakeMemory();
    m.writePtr(PLAYER_PTR + BigInt(o.player.boxData), BOX_DATA_PTR);
    // boxTypes field pointer = low ⇒ readIntArray returns null
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxTypes), 0x10n);
    // boxQuantity field pointer = valid (won't be reached)
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxQuantity), QTY_LIST_PTR);
    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), PLAYER_PTR);
    expect(r.slots).toBeNull();
    expect(r.status).toContain("BoxTypes/BoxQuantity array unreadable");
  });

  it("walks the CommonSaveData static-field chain when playerPtrOverride is null", () => {
    const o = makeOffsets();
    const m = new FakeMemory();
    // Seed the static-field chain: slot → classPtr → staticFields block → playerPtr.
    const slot = GA_BASE + o.typeInfoRva.commonSaveData;
    const classPtr = 0x200000n;
    const staticBlock = 0x300000n;
    m.writePtr(slot, classPtr);
    m.writePtr(classPtr + BigInt(CAND), staticBlock);
    m.writePtr(staticBlock + BigInt(o.player.commonSaveData), PLAYER_PTR);
    // Now seed the boxData chain as in the full-path test.
    m.writePtr(PLAYER_PTR + BigInt(o.player.boxData), BOX_DATA_PTR);
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxTypes), TYPES_LIST_PTR);
    m.writePtr(BOX_DATA_PTR + BigInt(o.boxData.boxQuantity), QTY_LIST_PTR);
    seedListInt(m, TYPES_LIST_PTR, TYPES_ITEMS_PTR, [100, 200]);
    seedListInt(m, QTY_LIST_PTR, QTY_ITEMS_PTR, [5, 2]);

    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), /* override */ null);
    expect(r.slots).toEqual({ common: 5, rare: 2, act: 0 });
  });

  it("returns null when static-field chain is broken and no override provided", () => {
    const o = makeOffsets();
    const m = new FakeMemory(); // nothing seeded — static-field walk will fail
    const r = readRuntimeChestSlots(m, GA_BASE, GA_SIZE, o, makeCatalog(), /* override */ null);
    expect(r.slots).toBeNull();
    expect(r.status).toContain("PlayerSaveData");
  });
});
