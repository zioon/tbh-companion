// Box-queue ("stargaze") scanner — locates the runtime `Dictionary<EBoxType,
// List<BoxData>>` singleton, walks its 3 buckets, and decodes each BoxData's
// `o_rewardItemId` (ACTk ObscuredInt) to produce the predicted drop queue.
//
// Pure: operates over an injected MemoryReader so it is unit-testable over a
// synthetic memory map. The impure koffi backing lives in main/liveMemory.
//
// Detection strategy (ported from tbh-stargaze agent.js, adapted to koffi):
//   1. Find the IL2CPP class whose field type signature contains
//      `Dictionary` + `EBoxType` + `List` + `BoxData` — the class name is
//      obfuscated per build, but the field's IL2CPP type string is stable.
//      Stargaze calls this class `vw`; we just call it the box-queue class.
//   2. Locate a live instance of that class. Stargaze uses async Memory.scan
//      over RW regions for the class pointer pattern; here we scan the same
//      regions synchronously in chunks (koffi is synchronous).
//   3. Read `Dictionary<EBoxType, List<BoxData>>` via the standard IL2CPP
//      container layout (entries array + entry size 24, inline int32 key at
//      +0x08, value pointer at +0x10). Each bucket's List<BoxData> uses the
//      standard List<T> layout (array +0x10, size +0x18, first element +0x20).
//   4. For each BoxData, read `o_rewardItemId` (ACTk ObscuredInt, 8 bytes:
//      int32 hidden + int32 cryptoKey; decrypt = (hidden - crypto) ^ crypto).
//      Also opportunistically read a grade field when present.

import { readI32, readPtr, type MemoryReader } from "./memory";
import { decodeObscuredInt } from "./obscured";
import type { BoxQueueItem } from "../../../shared/types";

// ── IL2CPP layout constants ──────────────────────────────────────────────────

/** Il2CppClass.fields pointer primary offset. */
const IL2CPP_CLASS_FIELDS_OFFSET = 0x80n;
/** Il2CppClass.fields pointer fallback offset (per-build variation). */
const IL2CPP_CLASS_FIELDS_ALT_OFFSET = 0x88n;
/** sizeof(Il2CppFieldInfo) on x64. */
const IL2CPP_FIELD_INFO_SIZE = 0x20;
/** Field name pointer offset inside Il2CppFieldInfo. */
const IL2CPP_FIELD_NAME_OFFSET = 0x0n;
/** Field offset slot inside Il2CppFieldInfo (int32). */
const IL2CPP_FIELD_OFFSET_OFFSET = 0x18n;

/** Max fields to walk per class before giving up. */
const MAX_FIELDS_PER_CLASS = 200;

// ── BoxData / Dictionary layout (stable across patches) ──────────────────────

/** Standard IL2CPP `Dictionary<TKey, TValue>` entry size (x64). */
const DICT_ENTRY_SIZE = 24;
/** Standard IL2CPP `Dictionary` entries array first element offset. */
const DICT_ARRAY_FIRST = 0x20;
/** Standard IL2CPP `Dictionary` count field offset. */
const DICT_COUNT_OFFSET = 0x20;
/** Standard IL2CPP `Dictionary` entries array pointer field offset. */
const DICT_ENTRIES_OFFSET = 0x18;
/** Inline int32 key offset inside a Dictionary<int, T> entry. */
const DICT_ENTRY_KEY_OFFSET = 0x08;
/** Value pointer offset inside a Dictionary entry. */
const DICT_ENTRY_VALUE_OFFSET = 0x10;
/** Hash field offset inside a Dictionary entry (int32; < 0 = empty slot). */
const DICT_ENTRY_HASH_OFFSET = 0x00;

/** Standard IL2CPP `List<T>` backing array pointer offset. */
const LIST_ARRAY_OFFSET = 0x10;
/** Standard IL2CPP `List<T>` size field offset. */
const LIST_SIZE_OFFSET = 0x18;
/** Standard IL2CPP `T[]` first element offset. */
const ARRAY_FIRST_OFFSET = 0x20;

/** EBoxType enum bounds (0=common, 1=rare/stage boss, 2=act boss). */
const EBOX_TYPE_MIN = 0;
const EBOX_TYPE_MAX = 5;
/** Per-bucket cap to avoid runaway reads on a corrupted dict. */
const MAX_ITEMS_PER_BUCKET = 64;
/** Per-dict entry cap to avoid runaway walks. */
const MAX_DICT_ENTRIES = 8;
/** Plausible itemKey bounds (catalog uses ints up to ~6000). */
const PLAUSIBLE_ITEM_KEY_MIN = 1;
const PLAUSIBLE_ITEM_KEY_MAX = 100_000;

/** Bytes of heap to scan per chunk when looking for class instances. */
const HEAP_SCAN_CHUNK = 1 << 22; // 4 MiB
/** Minimum region size to bother scanning (small regions are DLL mappings or stacks). */
const MIN_REGION_SIZE_TO_SCAN = 1 << 20; // 1 MiB
/** Hard ceiling on total heap bytes scanned per pass. 2GB covers most Unity GC heaps
 * while still capping sync-read time at ~2–4 seconds on typical hardware. */
const HEAP_SCAN_MAX_BYTES = 2 * (1 << 30); // 2 GiB

// ── BoxData field-name hints ─────────────────────────────────────────────────

/**
 * Field-name hints for resolving BoxData offsets. The reward id field name
 * (`o_rewardItemId`) is the ACTk-mangled ObscuredInt field — stable across
 * builds because the obfuscator preserves ACTk's `<field>k__BackingField`
 * naming. The grade field is best-effort; v1.00.28+ moves it to a GradeSO
 * reference, which the reader can't resolve without extra offsets, so we
 * opportunistically read both an int field and a pointer field.
 */
const REWARD_FIELD_HINTS = new Set([
  "o_rewardItemId",
  "rewardItemId",
  "<rewardItemId>k__BackingField",
]);
const GRADE_INT_FIELD_HINTS = new Set(["itemGradeType", "eGRADE", "gradeType"]);
const GRADE_PTR_FIELD_HINTS = new Set(["gradeSO", "_gradeSO", "<gradeSO>k__BackingField"]);

// ── Public types ─────────────────────────────────────────────────────────────

/** Per-bucket raw queue read from the live Dictionary<EBoxType, List<BoxData>>. */
export interface RawBoxQueueBucket {
  /** EBoxType enum value (0=common, 1=rare, 2=act). */
  eboxType: number;
  /** BoxData items in FIFO order (head = next drop). */
  items: RawBoxQueueItem[];
}

export interface RawBoxQueueItem {
  itemKey: number;
  gradeType?: number;
}

export interface RawBoxQueue {
  buckets: RawBoxQueueBucket[];
}

/** Result of one scan attempt. */
export interface BoxQueueScanResult {
  /** The raw queue read this tick, or null when unavailable. */
  queue: RawBoxQueue | null;
  /** Diagnostic status. */
  status: "ok" | "class_not_found" | "instance_lost" | "scan_failed";
}

// ── Pin state (cached across ticks) ──────────────────────────────────────────

/**
 * Per-reader pin state for the box-queue scanner. Caches the resolved class
 * pointer, the field offset of the `Dictionary<EBoxType, List<BoxData>>`
 * inside it, the BoxData field offsets, and the live singleton instance
 * pointer. All fields are re-derived when validation fails.
 */
export interface BoxQueuePinState {
  /** Il2CppClass* for the box-queue class (e.g. `vw`). Null = not yet found. */
  classPtr: bigint | null;
  /** Instance offset of the `Dictionary<EBoxType, List<BoxData>>` field. */
  dictFieldOffset: number;
  /** BoxData.o_rewardItemId offset (ACTk ObscuredInt, 8 bytes). */
  rewardOffset: number;
  /** BoxData grade int field offset (0 = not derived; reader falls back). */
  gradeIntOffset: number;
  /** BoxData gradeSO pointer field offset (0 = not derived). */
  gradePtrOffset: number;
  /** Live singleton instance pointer. Null = needs (re)scan. */
  instancePtr: bigint | null;
  /** Timestamp of the last heap scan attempt (ms since epoch). Used to throttle
   * re-scans — a new scan is only attempted if enough time has elapsed since
   * the previous attempt. */
  lastScanAttemptMs: number;
}

export function makeBoxQueuePinState(): BoxQueuePinState {
  return {
    classPtr: null,
    dictFieldOffset: 0,
    rewardOffset: 0,
    gradeIntOffset: 0,
    gradePtrOffset: 0,
    instancePtr: null,
    lastScanAttemptMs: 0,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlausibleHeapPtr(v: bigint | null): v is bigint {
  return v != null && v > 0x10000n && v < 0x7ff0_0000_0000n;
}

function isPlausibleItemKey(v: number | null): v is number {
  return v != null && v >= PLAUSIBLE_ITEM_KEY_MIN && v <= PLAUSIBLE_ITEM_KEY_MAX;
}

/** Read a NUL-terminated ASCII string of up to `maxLen` bytes. */
function readCString(reader: MemoryReader, ptr: bigint, maxLen: number): string | null {
  if (!isPlausibleHeapPtr(ptr)) return null;
  const buf = reader.readBytes(ptr, maxLen);
  if (!buf || buf.length === 0) return null;
  const end = buf.indexOf(0);
  const bytes = buf.subarray(0, end === -1 ? buf.length : end);
  if (bytes.length === 0) return null;
  for (const b of bytes) {
    // Allow printable ASCII only (field type strings never contain UTF-8).
    if (b < 0x20 || b > 0x7e) return null;
  }
  return bytes.toString("utf8");
}

/**
 * Walk `Il2CppFieldInfo[]` at `classPtr + 0x80` (fallback +0x88) and return
 * a list of `{ name, offset, typePtr }` entries. The `typePtr` is the
 * `Il2CppType*` for the field (used to read its type name string).
 *
 * Adapted from `readClassFields` in il2cppScanner.ts, but also returns the
 * type pointer so we can match by field type signature (not just name).
 */
interface FieldInfo {
  name: string;
  offset: number;
}

function readClassFieldInfos(
  reader: MemoryReader,
  classPtr: bigint,
  maxFields = MAX_FIELDS_PER_CLASS,
): FieldInfo[] | null {
  let fieldsPtr = readPtr(reader, classPtr + IL2CPP_CLASS_FIELDS_OFFSET);
  if (fieldsPtr == null) {
    fieldsPtr = readPtr(reader, classPtr + IL2CPP_CLASS_FIELDS_ALT_OFFSET);
  }
  if (fieldsPtr == null) return null;

  const out: FieldInfo[] = [];
  for (let i = 0; i < maxFields; i++) {
    const base = fieldsPtr + BigInt(i * IL2CPP_FIELD_INFO_SIZE);
    const namePtr = readPtr(reader, base + IL2CPP_FIELD_NAME_OFFSET);
    if (namePtr == null) break;
    const name = readCString(reader, namePtr, 128);
    if (name == null) break;
    const offset = readI32(reader, base + IL2CPP_FIELD_OFFSET_OFFSET);
    if (offset != null) out.push({ name, offset });
  }
  return out.length > 0 ? out : null;
}

/**
 * Read the Il2CppClass* from a class's static-fields block to identify the
 * runtime class of a candidate instance. We compare the candidate's header
 * pointer (`*candidate`) to the resolved class pointer.
 *
 * This is a direct bytes match — same approach as stargaze's `headerOk`.
 */
function headerMatchesClass(reader: MemoryReader, candidatePtr: bigint, classPtr: bigint): boolean {
  const header = readPtr(reader, candidatePtr);
  return header != null && header === classPtr;
}

// ── Heap region enumeration ──────────────────────────────────────────────────

export interface HeapRegion {
  base: bigint;
  size: number;
}

/**
 * Default no-op heap region provider. The scanner works over a list of
 * regions supplied by the caller (the live reader enumerates RW regions via
 * VirtualQueryEx in main/). Tests inject synthetic regions.
 */
export type HeapRegionProvider = () => HeapRegion[];

// ── Class finder: locate the box-queue class ────────────────────────────────

/**
 * Candidate class-name patterns for the box-queue class.
 *
 * The class name is obfuscated per build. Stargaze's v1.00.28 build uses `vw`;
 * other builds may use different short random names. We also try stable
 * descriptive names in case the obfuscator preserves them.
 *
 * The match is case-sensitive and matches either the full IL2CPP name
 * (e.g. `vb.vw`) or the short name after the last `.` (e.g. `vw`).
 */
const BOX_QUEUE_NAME_CANDIDATES = [
  "vw", // stargaze v1.00.28
  "BoxQueue",
  "RewardQueue",
  "DropQueue",
  "BoxDropQueue",
  "BoxRewardQueue",
  "StageBoxQueue",
];

/**
 * Find the box-queue class.
 *
 * Strategy (in order):
 *   1. **Class-name match** (preferred): use `classNameLookup` to find a class
 *      whose name matches one of {@link BOX_QUEUE_NAME_CANDIDATES}. The lookup
 *      is backed by `ScanContext.className` in main, which reads
 *      `Il2CppClass.name` at +0x10 — a verified offset.
 *   2. **Structural fallback**: iterate every class pointer and look for one
 *      with a single reference-typed instance field whose offset is in a
 *      plausible range. This is a weak heuristic (many classes match) so it
 *      only runs when name lookup is unavailable or finds nothing, and the
 *      caller's heap scan will further validate any hit via
 *      `validateBoxQueueInstance`.
 *
 * The old field-type-signature path (`readFieldTypeName`) was unreliable for
 * generic types — IL2CPP's `Il2CppType.data` union stores an
 * `Il2CppClass*`/`Il2CppGenericClass*` for TYPE_GENERICINST, not a string — so
 * it has been removed.
 *
 * Returns `{ classPtr, dictFieldOffset }` on success, or null.
 */
export function findBoxQueueClass(
  reader: MemoryReader,
  classPtrs: readonly bigint[],
  classNameLookup?: (classPtr: bigint) => string | null,
): { classPtr: bigint; dictFieldOffset: number } | null {
  // Strategy 1: class-name match.
  if (classNameLookup != null) {
    for (const classPtr of classPtrs) {
      if (!isPlausibleHeapPtr(classPtr)) continue;
      const fullName = classNameLookup(classPtr);
      if (fullName == null) continue;
      const shortName = fullName.includes(".")
        ? fullName.slice(fullName.lastIndexOf(".") + 1)
        : fullName;
      if (!BOX_QUEUE_NAME_CANDIDATES.includes(shortName)) continue;
      // Verify the class has at least one instance field we can use as the
      // dict field. Pick the first field with a plausible offset.
      const fields = readClassFieldInfos(reader, classPtr);
      if (fields == null || fields.length === 0) continue;
      const dictField = fields.find((f) => f.offset >= 0x8 && f.offset <= 0x100);
      if (dictField == null) continue;
      return { classPtr, dictFieldOffset: dictField.offset };
    }
  }

  // Strategy 2: structural fallback — find a class with exactly 1 reference
  // field at a plausible offset. This is very weak (many classes match), so
  // we rely on the downstream heap-scan + validateBoxQueueInstance to reject
  // false positives. We only check the first N classes to bound cost.
  const MAX_STRUCTURAL_PROBES = 500;
  const probed = classPtrs.slice(0, MAX_STRUCTURAL_PROBES);
  for (const classPtr of probed) {
    if (!isPlausibleHeapPtr(classPtr)) continue;
    const fields = readClassFieldInfos(reader, classPtr);
    if (fields == null) continue;
    // The box-queue class has exactly 1 instance field (the Dictionary).
    if (fields.length !== 1) continue;
    const f = fields[0];
    if (f == null || f.offset < 0x8 || f.offset > 0x100) continue;
    return { classPtr, dictFieldOffset: f.offset };
  }

  return null;
}

// ── BoxData field resolver ───────────────────────────────────────────────────

/**
 * Resolve BoxData field offsets by walking the `BoxData` class's field-info
 * array. The reward id field name is stable (`o_rewardItemId` or its
 * backing-field variant); the grade field names vary, so we try a list of
 * hints and accept the first hit.
 *
 * Returns the reward offset (always required; 0 = resolution failed) plus
 * optional grade offsets.
 */
export function resolveBoxDataOffsets(
  reader: MemoryReader,
  boxDataClassPtr: bigint,
): {
  rewardOffset: number;
  gradeIntOffset: number;
  gradePtrOffset: number;
} {
  const fields = readClassFieldInfos(reader, boxDataClassPtr);
  if (fields == null) return { rewardOffset: 0, gradeIntOffset: 0, gradePtrOffset: 0 };

  let rewardOffset = 0;
  let gradeIntOffset = 0;
  let gradePtrOffset = 0;
  for (const f of fields) {
    if (rewardOffset === 0 && REWARD_FIELD_HINTS.has(f.name)) {
      rewardOffset = f.offset;
      continue;
    }
    if (gradeIntOffset === 0 && GRADE_INT_FIELD_HINTS.has(f.name)) {
      gradeIntOffset = f.offset;
      continue;
    }
    if (gradePtrOffset === 0 && GRADE_PTR_FIELD_HINTS.has(f.name)) {
      gradePtrOffset = f.offset;
    }
  }
  return { rewardOffset, gradeIntOffset, gradePtrOffset };
}

/**
 * Resolve BoxData field offsets from a *live BoxData instance* — used when the
 * BoxData class itself isn't in the static-reachable index (per-build
 * obfuscation hides its name). We read the IL2CPP header at `*boxData` to get
 * the BoxData class pointer, then call {@link resolveBoxDataOffsets}.
 */
export function resolveBoxDataOffsetsFromInstance(
  reader: MemoryReader,
  boxDataPtr: bigint,
): {
  rewardOffset: number;
  gradeIntOffset: number;
  gradePtrOffset: number;
} | null {
  const boxDataClass = readPtr(reader, boxDataPtr);
  if (boxDataClass == null || !isPlausibleHeapPtr(boxDataClass)) return null;
  return resolveBoxDataOffsets(reader, boxDataClass);
}

// ── Heap scanner: locate the live singleton instance ────────────────────────

/**
 * Validate a candidate singleton instance: header matches `classPtr`, the
 * dict field at `dictFieldOffset` is a plausible pointer, the dict's count
 * is in [1, MAX_DICT_ENTRIES], and the bucket keys are plausible EBoxType
 * values. Returns the dict pointer when valid, null otherwise.
 *
 * Adapted from stargaze's `structOk`. We do NOT call the reward decoder here
 * — that runs only on instances that pass this cheap structural check, so we
 * never invoke ObscuredInt decode on a garbage pointer.
 */
export function validateBoxQueueInstance(
  reader: MemoryReader,
  candidatePtr: bigint,
  classPtr: bigint,
  dictFieldOffset: number,
): bigint | null {
  if (!isPlausibleHeapPtr(candidatePtr)) return null;
  if (!headerMatchesClass(reader, candidatePtr, classPtr)) return null;

  const dictPtr = readPtr(reader, candidatePtr + BigInt(dictFieldOffset));
  if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) return null;

  const entriesArr = readPtr(reader, dictPtr + BigInt(DICT_ENTRIES_OFFSET));
  if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) return null;

  const count = readI32(reader, dictPtr + BigInt(DICT_COUNT_OFFSET));
  if (count == null || count < 1 || count > MAX_DICT_ENTRIES) return null;

  let totalItems = 0;
  const first = entriesArr + BigInt(DICT_ARRAY_FIRST);
  for (let i = 0; i < count; i++) {
    const eBase = first + BigInt(i * DICT_ENTRY_SIZE);
    const key = readI32(reader, eBase + BigInt(DICT_ENTRY_KEY_OFFSET));
    if (key == null || key < EBOX_TYPE_MIN || key > EBOX_TYPE_MAX) return null;
    const listPtr = readPtr(reader, eBase + BigInt(DICT_ENTRY_VALUE_OFFSET));
    if (listPtr == null || !isPlausibleHeapPtr(listPtr)) return null;
    const listArr = readPtr(reader, listPtr + BigInt(LIST_ARRAY_OFFSET));
    if (listArr == null || !isPlausibleHeapPtr(listArr)) return null;
    const listSize = readI32(reader, listPtr + BigInt(LIST_SIZE_OFFSET));
    if (listSize == null || listSize < 0 || listSize > 500) return null;
    totalItems += listSize;
  }
  // Empty dict (all buckets size 0) is suspicious — likely a fresh instance
  // mid-init. Reject so the scanner keeps looking.
  if (totalItems === 0) return null;
  return dictPtr;
}

/**
 * Scan RW heap regions for a pointer whose value equals `classPtr`. Returns
 * the first plausible instance address that passes {@link validateBoxQueueInstance}.
 *
 * Mirrors stargaze's async `scanForInstance` — synchronous here because koffi
 * ReadProcessMemory is synchronous. Chunks reads at 4 MiB to bound each call.
 * Caps total bytes scanned per pass at 2GB to avoid multi-second stalls on
 * processes with huge heaps.
 */
export function scanForBoxQueueInstance(
  reader: MemoryReader,
  regions: readonly HeapRegion[],
  classPtr: bigint,
  dictFieldOffset: number,
): bigint | null {
  let totalScanned = 0;
  for (const region of regions) {
    if (totalScanned >= HEAP_SCAN_MAX_BYTES) break;
    if (region.size < MIN_REGION_SIZE_TO_SCAN) continue;
    const regionSize = Math.min(region.size, HEAP_SCAN_MAX_BYTES - totalScanned);
    for (let off = 0; off < regionSize; off += HEAP_SCAN_CHUNK) {
      const chunkSize = Math.min(HEAP_SCAN_CHUNK, regionSize - off);
      const buf = reader.readBytes(region.base + BigInt(off), chunkSize);
      if (!buf) continue;
      // 8-byte aligned slot walk.
      for (let i = 0; i + 8 <= buf.length; i += 8) {
        const v = buf.readBigUInt64LE(i);
        if (v !== classPtr) continue;
        const candidate = region.base + BigInt(off) + BigInt(i);
        const dict = validateBoxQueueInstance(reader, candidate, classPtr, dictFieldOffset);
        if (dict != null) return candidate;
      }
    }
    totalScanned += regionSize;
  }
  return null;
}

// ── Queue reader: decode the 3 buckets ───────────────────────────────────────

/**
 * Decode a single BoxData entry: read `o_rewardItemId` as ObscuredInt, plus
 * an optional grade. Returns null when the item id is unreadable or
 * implausible (caller skips it).
 */
export function decodeBoxData(
  reader: MemoryReader,
  boxDataPtr: bigint,
  rewardOffset: number,
  gradeIntOffset: number,
  gradePtrOffset: number,
): RawBoxQueueItem | null {
  if (rewardOffset === 0) return null;
  // Read 8 bytes for the ObscuredInt (hidden + cryptoKey) at rewardOffset.
  const buf = reader.readBytes(boxDataPtr + BigInt(rewardOffset), 8);
  if (!buf || buf.length < 8) return null;
  const itemKey = decodeObscuredInt(buf, 0);
  if (!isPlausibleItemKey(itemKey)) return null;

  const out: RawBoxQueueItem = { itemKey };

  // Optional grade int field (pre-1.00.28 path).
  if (gradeIntOffset !== 0) {
    const grade = readI32(reader, boxDataPtr + BigInt(gradeIntOffset));
    if (grade != null && grade >= 0 && grade < 32) {
      out.gradeType = grade;
    }
  }
  // Optional gradeSO pointer field (v1.00.28+ path). We only resolve the
  // inner `eGRADE` int when the pointer is plausible — full GradeSO.eGRADE
  // offset resolution would require an extra offset derivation step; for
  // now we leave gradeType undefined and let the renderer fall back to the
  // catalog grade. The field is probed so future enrichment can fill it in.
  // (gradePtrOffset is read but not dereferenced here — see header comment.)
  void gradePtrOffset;

  return out;
}

/**
 * Read all 3 buckets from a validated dict pointer. Returns one
 * {@link RawBoxQueueBucket} per non-empty bucket, in dict-iteration order.
 * Buckets with EBoxType outside [0, 2] are skipped (the EBoxType enum can
 * grow beyond the 3 we track; only common/rare/act are surfaced).
 */
export function readBoxQueues(
  reader: MemoryReader,
  dictPtr: bigint,
  rewardOffset: number,
  gradeIntOffset: number,
  gradePtrOffset: number,
): RawBoxQueue | null {
  const entriesArr = readPtr(reader, dictPtr + BigInt(DICT_ENTRIES_OFFSET));
  if (entriesArr == null) return null;
  const count = readI32(reader, dictPtr + BigInt(DICT_COUNT_OFFSET));
  if (count == null || count < 0 || count > MAX_DICT_ENTRIES) return null;

  const first = entriesArr + BigInt(DICT_ARRAY_FIRST);
  const buckets: RawBoxQueueBucket[] = [];

  for (let i = 0; i < count; i++) {
    const eBase = first + BigInt(i * DICT_ENTRY_SIZE);
    const hash = readI32(reader, eBase + BigInt(DICT_ENTRY_HASH_OFFSET));
    if (hash == null || hash < 0) continue; // empty/deleted slot
    const eboxType = readI32(reader, eBase + BigInt(DICT_ENTRY_KEY_OFFSET));
    if (eboxType == null || eboxType < EBOX_TYPE_MIN || eboxType > EBOX_TYPE_MAX) continue;
    if (eboxType > 2) continue; // only common(0) / rare(1) / act(2) tracked
    const listPtr = readPtr(reader, eBase + BigInt(DICT_ENTRY_VALUE_OFFSET));
    if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
    const arrPtr = readPtr(reader, listPtr + BigInt(LIST_ARRAY_OFFSET));
    if (arrPtr == null || !isPlausibleHeapPtr(arrPtr)) continue;
    const listSize = readI32(reader, listPtr + BigInt(LIST_SIZE_OFFSET));
    if (listSize == null || listSize < 0) continue;

    const items: RawBoxQueueItem[] = [];
    const cap = Math.min(listSize, MAX_ITEMS_PER_BUCKET);
    const arrFirst = arrPtr + BigInt(ARRAY_FIRST_OFFSET);
    for (let j = 0; j < cap; j++) {
      const boxDataPtr = readPtr(reader, arrFirst + BigInt(j * 8));
      if (boxDataPtr == null || !isPlausibleHeapPtr(boxDataPtr)) continue;
      const item = decodeBoxData(reader, boxDataPtr, rewardOffset, gradeIntOffset, gradePtrOffset);
      if (item != null) items.push(item);
    }
    buckets.push({ eboxType, items });
  }

  return { buckets };
}

// ── Top-level scan entry point ───────────────────────────────────────────────

/**
 * Run one box-queue scan tick. Uses the pin state to short-circuit when the
 * class + instance are already resolved; otherwise falls back to a full
 * heap scan. Always re-validates the cached instance — when it fails, we
 * mark `instancePtr = null` and re-scan next tick (or this tick if budget
 * allows).
 *
 * @param reader Memory access (koffi-backed in main, FakeMemory in tests).
 * @param classPtrs IL2CPP class pointers to search for the box-queue class.
 *   Typically produced by `collectClassEntries` over GA-static regions, but
 *   tests inject a small synthetic list.
 * @param heapRegions RW heap regions to scan for the singleton instance.
 * @param pin Pin state, mutated in place across ticks.
 * @param classNameLookup Optional: resolve an Il2CppClass* to its name. Used
 *   by {@link findBoxQueueClass} for obfuscation-immune name matching
 *   (preferred path). When omitted, falls back to the weak structural probe.
 */
export function scanBoxQueue(
  reader: MemoryReader,
  classPtrs: readonly bigint[],
  heapRegions: readonly HeapRegion[],
  pin: BoxQueuePinState,
  classNameLookup?: (classPtr: bigint) => string | null,
): BoxQueueScanResult {
  // 1. Resolve the box-queue class + dict field offset (cached on pin).
  if (pin.classPtr == null || pin.dictFieldOffset === 0) {
    const found = findBoxQueueClass(reader, classPtrs, classNameLookup);
    if (found == null) {
      return { queue: null, status: "class_not_found" };
    }
    pin.classPtr = found.classPtr;
    pin.dictFieldOffset = found.dictFieldOffset;
  }

  const classPtr = pin.classPtr;
  const dictOff = pin.dictFieldOffset;

  // 2. Validate the cached instance pointer; if it fails, clear and re-scan.
  if (pin.instancePtr != null) {
    const dict = validateBoxQueueInstance(reader, pin.instancePtr, classPtr, dictOff);
    if (dict == null) {
      pin.instancePtr = null;
      // Don't bail — try a fresh scan below.
    }
  }

  // 3. If no valid instance, scan the heap (throttled to avoid hammering).
  if (pin.instancePtr == null) {
    const now = Date.now();
    const SCAN_COOLDOWN_MS = 30_000; // 30 seconds between full heap scans
    if (now - pin.lastScanAttemptMs < SCAN_COOLDOWN_MS) {
      return { queue: null, status: "instance_lost" };
    }
    pin.lastScanAttemptMs = now;
    const found = scanForBoxQueueInstance(reader, heapRegions, classPtr, dictOff);
    if (found == null) {
      return { queue: null, status: "scan_failed" };
    }
    pin.instancePtr = found;
  }

  // 4. Resolve BoxData field offsets (cached on pin; derived from the first
  //    BoxData instance we can reach through the dict).
  if (pin.rewardOffset === 0) {
    // Walk the dict to find the first BoxData pointer.
    const dictPtr = validateBoxQueueInstance(reader, pin.instancePtr, classPtr, dictOff);
    if (dictPtr == null) {
      pin.instancePtr = null;
      return { queue: null, status: "instance_lost" };
    }
    const entriesArr = readPtr(reader, dictPtr + BigInt(DICT_ENTRIES_OFFSET));
    if (entriesArr == null) {
      return { queue: null, status: "instance_lost" };
    }
    const count = readI32(reader, dictPtr + BigInt(DICT_COUNT_OFFSET));
    if (count == null || count < 1) {
      return { queue: null, status: "instance_lost" };
    }
    const first = entriesArr + BigInt(DICT_ARRAY_FIRST);
    let resolved: { rewardOffset: number; gradeIntOffset: number; gradePtrOffset: number } | null =
      null;
    for (let i = 0; i < count && resolved == null; i++) {
      const eBase = first + BigInt(i * DICT_ENTRY_SIZE);
      const listPtr = readPtr(reader, eBase + BigInt(DICT_ENTRY_VALUE_OFFSET));
      if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
      const arrPtr = readPtr(reader, listPtr + BigInt(LIST_ARRAY_OFFSET));
      if (arrPtr == null || !isPlausibleHeapPtr(arrPtr)) continue;
      const listSize = readI32(reader, listPtr + BigInt(LIST_SIZE_OFFSET));
      if (listSize == null || listSize < 1) continue;
      const arrFirst = arrPtr + BigInt(ARRAY_FIRST_OFFSET);
      const boxDataPtr = readPtr(reader, arrFirst);
      if (boxDataPtr == null || !isPlausibleHeapPtr(boxDataPtr)) continue;
      resolved = resolveBoxDataOffsetsFromInstance(reader, boxDataPtr);
    }
    if (resolved == null || resolved.rewardOffset === 0) {
      return { queue: null, status: "ok" }; // queue readable but no BoxData yet
    }
    pin.rewardOffset = resolved.rewardOffset;
    pin.gradeIntOffset = resolved.gradeIntOffset;
    pin.gradePtrOffset = resolved.gradePtrOffset;
  }

  // 5. Read the queues.
  const dictPtr = validateBoxQueueInstance(reader, pin.instancePtr, classPtr, dictOff);
  if (dictPtr == null) {
    pin.instancePtr = null;
    return { queue: null, status: "instance_lost" };
  }
  const queue = readBoxQueues(
    reader,
    dictPtr,
    pin.rewardOffset,
    pin.gradeIntOffset,
    pin.gradePtrOffset,
  );
  return { queue, status: "ok" };
}

// ── Conversion: RawBoxQueue → BoxQueueSnapshot ──────────────────────────────

/**
 * Convert a {@link RawBoxQueue} to the IPC-friendly {@link BoxQueueItem}
 * arrays grouped by canonical category. EBoxType 0 → common, 1 → rare, 2 →
 * act. Unknown EBoxType values are dropped. Items are kept in their
 * per-bucket FIFO order (head first).
 */
export function toBoxQueueItems(queue: RawBoxQueue): {
  common: BoxQueueItem[];
  rare: BoxQueueItem[];
  act: BoxQueueItem[];
} {
  const common: BoxQueueItem[] = [];
  const rare: BoxQueueItem[] = [];
  const act: BoxQueueItem[] = [];
  for (const bucket of queue.buckets) {
    const target =
      bucket.eboxType === 0
        ? common
        : bucket.eboxType === 1
          ? rare
          : bucket.eboxType === 2
            ? act
            : null;
    if (target == null) continue;
    for (const item of bucket.items) {
      target.push({ itemKey: item.itemKey, gradeType: item.gradeType });
    }
  }
  return { common, rare, act };
}
