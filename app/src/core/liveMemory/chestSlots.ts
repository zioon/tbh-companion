// Pure: read chest slot quantities from PlayerSaveData.BoxData runtime.
// No electron / node / fs — keep unit-testable.

import type { LiveOffsets } from "./offsets";
import type { MemoryReader } from "./memory";
import { readPtr, readI32 } from "./memory";
import { readStaticFieldPtr } from "./statics";
import type { BoxCategory, LiveChestSlots } from "../../../shared/types";

export type { LiveChestSlots } from "../../../shared/types";

export interface ReadChestSlotsResult {
  /** Per-category slot quantity. null = unavailable this tick. */
  slots: LiveChestSlots | null;
  /** Diagnostics: why slots is null. Empty when slots are present. */
  status: string;
}

/** Container layout (mirrors LiveOffsets.container). */
interface ArrayContainer {
  listItems: number;
  listSize: number;
  arrayFirst: number;
}

/** Maximum plausible chest slot count (sanity bound). */
const MAX_CHEST_SLOTS = 100;

/**
 * Read an int array from a struct field. Handles both `List<int>` (with
 * `_items` backing array + `_size`) and raw `int[]` (where the field points
 * directly at the array). Returns null when the pointer walk fails or the
 * size is implausible.
 */
export function readIntArray(
  reader: MemoryReader,
  obj: bigint,
  fieldOff: number,
  c: ArrayContainer,
): number[] | null {
  const fieldPtr = readPtr(reader, obj + BigInt(fieldOff));
  if (fieldPtr == null) return null;

  // Try List<int> path first: list._items (backing array) + list._size.
  const itemsPtr = readPtr(reader, fieldPtr + BigInt(c.listItems));
  const size = readI32(reader, fieldPtr + BigInt(c.listSize));
  if (itemsPtr == null || size == null) {
    // Fall back to direct int[] path: fieldPtr IS the array.
    return readDirectIntArray(reader, fieldPtr, c);
  }
  if (size <= 0 || size > MAX_CHEST_SLOTS) return null;
  return readInt32Elements(reader, itemsPtr, size, c.arrayFirst);
}

function readDirectIntArray(
  reader: MemoryReader,
  arrPtr: bigint,
  c: ArrayContainer,
): number[] | null {
  // IL2CPP arrays store length at arrPtr + 0x18 (standard Il2CppArray.size).
  const size = readI32(reader, arrPtr + 0x18n);
  if (size == null || size <= 0 || size > MAX_CHEST_SLOTS) return null;
  return readInt32Elements(reader, arrPtr, size, c.arrayFirst);
}

function readInt32Elements(
  reader: MemoryReader,
  arrPtr: bigint,
  size: number,
  firstOff: number,
): number[] {
  const out: number[] = [];
  const base = arrPtr + BigInt(firstOff);
  for (let i = 0; i < size; i++) {
    const v = readI32(reader, base + BigInt(i * 4));
    if (v == null) break;
    out.push(v);
  }
  return out;
}

/**
 * Read current chest slot quantities from `PlayerSaveData.BoxData` runtime.
 * Returns null with a status string when any offset is unset or any pointer
 * path fails — callers fall back to the save path in that case.
 *
 * `boxTypeCatalog` maps runtime BoxType int → tracker BoxCategory. Entries
 * absent from the catalog (or "unclassified") are skipped; only common/rare/act
 * are aggregated.
 */
export function readRuntimeChestSlots(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  boxTypeCatalog: ReadonlyMap<number, BoxCategory>,
  playerPtrOverride?: bigint | null,
): ReadChestSlotsResult {
  if (o.player.boxData === 0) {
    return { slots: null, status: "player.boxData offset = 0 (not derived)" };
  }
  // Defensive: `boxData` struct offsets were added to LiveOffsets after the
  // v1.00.28 disk cache was first written. Legacy cache files load without
  // this nested object (o.boxData === undefined), so accessing .boxTypes
  // would throw — which in the worker loop triggers detach → re-attach →
  // name-scan → crash every ~20s. Treat absent boxData the same as not-yet-
  // derived and fall back to the save path.
  if (o.boxData == null) {
    return { slots: null, status: "boxData offsets absent (legacy cache)" };
  }
  if (o.boxData.boxTypes === 0 || o.boxData.boxQuantity === 0) {
    return { slots: null, status: "boxData struct offsets not derived" };
  }

  // Resolve playerPtr — accept override (from cached player scan) before
  // falling back to the CommonSaveData static-field walk.
  let playerPtr = playerPtrOverride ?? null;
  if (playerPtr == null) {
    playerPtr = readStaticFieldPtr(
      reader,
      gaBase,
      gaSize,
      o.typeInfoRva.commonSaveData,
      o.player.commonSaveData,
      o.il2cppClass.staticFieldsOffsets,
    );
  }
  if (playerPtr == null) {
    return {
      slots: null,
      status: "PlayerSaveData (CommonSaveData singleton) static field unreadable",
    };
  }

  const boxDataPtr = readPtr(reader, playerPtr + BigInt(o.player.boxData));
  if (boxDataPtr == null) {
    return { slots: null, status: "BoxData pointer null (player.boxData offset suspect)" };
  }

  const types = readIntArray(reader, boxDataPtr, o.boxData.boxTypes, o.container);
  const quantities = readIntArray(reader, boxDataPtr, o.boxData.boxQuantity, o.container);
  if (types == null || quantities == null) {
    return { slots: null, status: "BoxTypes/BoxQuantity array unreadable" };
  }
  if (types.length !== quantities.length) {
    return {
      slots: null,
      status: `length mismatch: types=${types.length} qty=${quantities.length}`,
    };
  }

  const slots: LiveChestSlots = { common: 0, rare: 0, act: 0 };
  for (let i = 0; i < types.length; i++) {
    const category = boxTypeCatalog.get(types[i]!);
    if (category == null || category === "unclassified") continue;
    slots[category] += quantities[i]!;
  }
  return { slots, status: "" };
}
