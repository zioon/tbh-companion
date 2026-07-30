// Pure IL2CPP class/field scanner + structural anchor detectors — used by the
// runtime offset extractor. Injects MemoryReader so it is unit-testable over
// FakeMemory. No node / electron / koffi imports.
//
// Detection strategy (validated live against game v1.00.23): per-build name
// randomization renames most manager classes AND their singleton wrappers, so
// anchors are found structurally — by what their static fields point at — and
// only serialization-stable names ("StageCache", "StageInfoData", "GetBoxLog",
// "HeroList", "PetSaveData", …) are trusted as identifiers.

import { readI32, readI64, readIl2CppString, readPtr, type MemoryReader } from "./memory";
import { decodeObscuredInt } from "./obscured";
import { plausibleGold } from "./offsets";

// ── IL2CPP metadata layout (x64, stable across recent Unity versions) ────────

const IL2CPP_CLASS_NAME_OFFSET = 0x10n;
const IL2CPP_CLASS_FIELDS_OFFSET = 0x80n; // Il2CppClass.fields: Il2CppFieldInfo*
const IL2CPP_CLASS_FIELDS_ALT_OFFSET = 0x88n; // fallback when 0x80 yields null
const IL2CPP_FIELD_INFO_SIZE = 0x20; // sizeof(Il2CppFieldInfo) — x64
const IL2CPP_FIELD_NAME_OFFSET = 0x0n;
const IL2CPP_FIELD_OFFSET_OFFSET = 0x18n;
const MAX_CLASS_NAME_LEN = 128;
const MAX_FIELDS = 200;

/** Il2CppClass.static_fields candidate offsets (varies slightly per Unity build). */
export const STATIC_FIELDS_CANDIDATES = [0xb0, 0xb8, 0xa8] as const;

// ── Game-structural constants (obfuscated names, stable byte offsets) ─────────

/** Standard IL2CPP container layout — shared with the emitted LiveOffsets. */
export const STRUCT_CONTAINER = {
  objectHeader: 0x10,
  listItems: 0x10,
  listSize: 0x18,
  arrayFirst: 0x20,
} as const;

/** Standard `Dictionary<int, T>` layout — shared with the emitted LiveOffsets. */
export const STRUCT_DICT = {
  entries: 0x18,
  count: 0x20,
  entrySize: 24,
  entryHash: 0,
  entryKey: 8,
  entryValue: 16,
} as const;

/** GetBoxLog EMonsterLogType field offset candidates. The field has lived at
 *  0x50 on every version seen so far, but the field name is obfuscated so the
 *  byte offset is not name-stable. Probe a small candidate set rather than
 *  assume — extended for v1.01.02 where the offset may have shifted. */
const STRUCT_GETBOX_MONSTER_TYPE_CANDIDATES = [0x50, 0x48, 0x58, 0x40, 0x60];
const STRUCT_CACHE_INFO_DATA = 0x10; // StageCache → StageInfoData
const STRUCT_STAGE_CACHE_STATIC_OFF = 0x88; // vb.uu / uz.us current StageCache static field
const STRUCT_CURRENCY_DICT = 0x8; // currency-manager statics: dict at +8 (list at +0)
const STRUCT_OBSCURED_QTY = 0x28; // currency entry → ACTk ObscuredLong quantity

/** How deep into a class's static block the detectors look for anchors. */
const STATIC_SCAN_MAX = 0x100;
/** How deep into an object's instance fields the player-list hunt looks. */
const INSTANCE_SCAN_MAX = 0x140;

function isPlausibleHeapPtr(v: bigint): boolean {
  return v > 0x10000n && v < 0x7ff0_0000_0000n;
}

/**
 * Match a class name, tolerating an obfuscation namespace prefix.
 * Per-build name randomization can rename `PetSaveData` → `vb.PetSaveData`
 * (seen live on v1.00.23 for StageCache); the short name stays stable because
 * it is the ES3 serialization name. Match `vb.PetSaveData` against `PetSaveData`.
 */
function classNameMatches(actual: string | null, expected: string): boolean {
  if (actual == null) return false;
  return actual === expected || actual.endsWith("." + expected);
}

// ── Primitive readers ─────────────────────────────────────────────────────────

/**
 * Read a null-terminated ASCII/UTF-8 C string at `ptr`.
 * Returns null if the pointer is implausible, the memory is unreadable, or the
 * string contains non-printable characters (class/field names never do).
 * Reads up to `maxLen` bytes (default 128).
 */
export function readCString(
  reader: MemoryReader,
  ptr: bigint,
  maxLen = MAX_CLASS_NAME_LEN,
): string | null {
  if (!isPlausibleHeapPtr(ptr)) return null;
  const buf = reader.readBytes(ptr, maxLen);
  if (!buf || buf.length === 0) return null;
  const end = buf.indexOf(0);
  const bytes = buf.subarray(0, end === -1 ? buf.length : end);
  if (bytes.length === 0) return null;
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) return null;
  }
  return bytes.toString("utf8");
}

/**
 * Walk `Il2CppFieldInfo[]` at `classPtr + 0x80` (fallback +0x88).
 * Each entry is 0x20 bytes: name: char* @+0x0, offset: int32 @+0x18.
 * Stops when the name pointer is null/unreadable or after `maxFields` entries.
 * Returns null when the fields base pointer is unreadable.
 */
export function readClassFields(
  reader: MemoryReader,
  classPtr: bigint,
  maxFields = MAX_FIELDS,
): Map<string, number> | null {
  let fieldsPtr = readPtr(reader, classPtr + IL2CPP_CLASS_FIELDS_OFFSET);
  if (fieldsPtr == null) {
    fieldsPtr = readPtr(reader, classPtr + IL2CPP_CLASS_FIELDS_ALT_OFFSET);
  }
  if (fieldsPtr == null) return null;

  const map = new Map<string, number>();
  for (let i = 0; i < maxFields; i++) {
    const base = fieldsPtr + BigInt(i * IL2CPP_FIELD_INFO_SIZE);
    const namePtr = readPtr(reader, base + IL2CPP_FIELD_NAME_OFFSET);
    if (namePtr == null) break; // end of array
    const name = readCString(reader, namePtr);
    if (name == null) break;
    const offset = readI32(reader, base + IL2CPP_FIELD_OFFSET_OFFSET);
    if (offset != null) {
      map.set(name, offset);
    }
  }

  return map.size > 0 ? map : null;
}

/** Decode one ACTk ObscuredLong from its struct base address. */
function readObscuredLong(reader: MemoryReader, structAddr: bigint): bigint | null {
  const hidden = readI64(reader, structAddr + 8n);
  const crypto = readI64(reader, structAddr + 16n);
  if (hidden == null || crypto == null) return null;
  return (hidden - crypto) ^ crypto;
}

/** Walk `Dictionary<int, T>` entries and return the value pointer for `key`. */
function dictLookupIntKey(
  reader: MemoryReader,
  dictPtr: bigint,
  key: number,
  maxCount: number,
  maxScan: number,
): bigint | null {
  const entriesArr = readPtr(reader, dictPtr + BigInt(STRUCT_DICT.entries));
  if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) return null;
  const count = readI32(reader, dictPtr + BigInt(STRUCT_DICT.count));
  if (count == null || count <= 0 || count > maxCount) return null;
  const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
  const limit = Math.min(count, maxScan);
  for (let i = 0; i < limit; i++) {
    const eBase = first + BigInt(i * STRUCT_DICT.entrySize);
    const hash = readI32(reader, eBase + BigInt(STRUCT_DICT.entryHash));
    if (hash == null || hash < 0) continue; // deleted / unused slot
    if (readI32(reader, eBase + BigInt(STRUCT_DICT.entryKey)) !== key) continue;
    return readPtr(reader, eBase + BigInt(STRUCT_DICT.entryValue));
  }
  return null;
}

// ── Scan context: cached class-metadata lookups ───────────────────────────────

/**
 * Read-through caches over one attached process. Class names, field maps, and
 * static-slot walks are each resolved at most once per Il2CppClass, which keeps
 * the structural detectors affordable over tens of thousands of candidates.
 */
export type ScanContextLogFn = (line: string) => void;

export class ScanContext {
  private readonly names = new Map<bigint, string | null>();
  private readonly fields = new Map<bigint, Map<string, number> | null>();
  private readonly statics = new Map<bigint, ReadonlyArray<{ soff: number; value: bigint }>>();
  private readonly probedClasses = new Set<bigint>();

  constructor(
    readonly reader: MemoryReader,
    private readonly logFn?: ScanContextLogFn,
  ) {}

  /** Emit a diagnostic line through the wired logger (no-op when absent). */
  log(line: string): void {
    this.logFn?.(line);
  }

  /** `Il2CppClass.name`, cached; null when unreadable or non-printable. */
  className(classPtr: bigint): string | null {
    const hit = this.names.get(classPtr);
    if (hit !== undefined) return hit;
    const namePtr = readPtr(this.reader, classPtr + IL2CPP_CLASS_NAME_OFFSET);
    const name = namePtr != null ? readCString(this.reader, namePtr) : null;
    this.names.set(classPtr, name);
    return name;
  }

  /** Field name → instance offset map, cached per class. */
  classFields(classPtr: bigint): Map<string, number> | null {
    const hit = this.fields.get(classPtr);
    if (hit !== undefined) return hit;
    const f = readClassFields(this.reader, classPtr);
    this.fields.set(classPtr, f);
    return f;
  }

  /** Class name of a live object via its IL2CPP header (`*obj` = Il2CppClass*). */
  instanceClassName(objPtr: bigint): string | null {
    const klass = readPtr(this.reader, objPtr);
    if (klass == null || !isPlausibleHeapPtr(klass)) return null;
    return this.className(klass);
  }

  /** Field map of a live object's class via its IL2CPP header. */
  instanceClassFields(objPtr: bigint): Map<string, number> | null {
    const klass = readPtr(this.reader, objPtr);
    if (klass == null || !isPlausibleHeapPtr(klass)) return null;
    if (this.className(klass) == null) return null;
    return this.classFields(klass);
  }

  /**
   * Diagnostic dump: when `instanceClassFields` returned a non-empty Map but
   * the expected field names are missing, dump the Map contents + raw
   * field-info bytes so we can see what names were actually read and whether
   * the field-info struct layout (name at +0x0, offset at +0x18) still holds.
   * Returns a diagnostic string for the caller to log, or null when already
   * dumped for this class.
   */
  dumpClassFields(objPtr: bigint, fields: Map<string, number>): string | null {
    const klass = readPtr(this.reader, objPtr);
    if (klass == null || !isPlausibleHeapPtr(klass)) return null;
    if (this.probedClasses.has(klass)) return null;
    this.probedClasses.add(klass);
    const name = this.className(klass);
    // Dump the field names + offsets we successfully read.
    const fieldList: string[] = [];
    for (const [fname, foff] of fields) {
      fieldList.push(`${fname}=0x${foff.toString(16)}`);
    }
    let msg = `[scanner] classFields dump: klass=0x${klass.toString(16)} name="${name ?? "null"}" fields(${fields.size})=[${fieldList.join(", ")}]`;
    // Also dump raw field-info bytes (first 3 entries × 0x20 bytes) so the
    // struct layout can be inferred if the names look wrong.
    const fieldsPtr = readPtr(this.reader, klass + IL2CPP_CLASS_FIELDS_OFFSET);
    if (fieldsPtr == null) {
      const fieldsPtrAlt = readPtr(this.reader, klass + IL2CPP_CLASS_FIELDS_ALT_OFFSET);
      if (fieldsPtrAlt != null && isPlausibleHeapPtr(fieldsPtrAlt)) {
        const sample = this.reader.readBytes(fieldsPtrAlt, 0x60);
        if (sample && sample.length === 0x60) {
          const hex: string[] = [];
          for (let i = 0; i < sample.length; i += 8) {
            const lo = sample.readUInt32LE(i);
            const hi = sample.readUInt32LE(i + 4);
            hex.push(
              `${i.toString(16).padStart(2, "0")}:${lo.toString(16).padStart(8, "0")}${hi.toString(16).padStart(8, "0")}`,
            );
          }
          msg += ` | raw@+0x88=0x${fieldsPtrAlt.toString(16)}: ${hex.join(" ")}`;
        }
      }
    } else if (isPlausibleHeapPtr(fieldsPtr)) {
      const sample = this.reader.readBytes(fieldsPtr, 0x60);
      if (sample && sample.length === 0x60) {
        const hex: string[] = [];
        for (let i = 0; i < sample.length; i += 8) {
          const lo = sample.readUInt32LE(i);
          const hi = sample.readUInt32LE(i + 4);
          hex.push(
            `${i.toString(16).padStart(2, "0")}:${lo.toString(16).padStart(8, "0")}${hi.toString(16).padStart(8, "0")}`,
          );
        }
        msg += ` | raw@+0x80=0x${fieldsPtr.toString(16)}: ${hex.join(" ")}`;
      }
    }
    // Dump the live instance bytes (0x60 bytes from objPtr) so we can see the
    // actual field values + surrounding bytes. Helps disambiguate ObscuredInt
    // (8 bytes) vs int64 (8 bytes) vs int32 (4 bytes) layouts.
    const instBuf = this.reader.readBytes(objPtr, 0x60);
    if (instBuf && instBuf.length === 0x60) {
      const hex: string[] = [];
      for (let i = 0; i < instBuf.length; i += 8) {
        const lo = instBuf.readUInt32LE(i);
        const hi = instBuf.readUInt32LE(i + 4);
        hex.push(
          `${i.toString(16).padStart(2, "0")}:${lo.toString(16).padStart(8, "0")}${hi.toString(16).padStart(8, "0")}`,
        );
      }
      msg += ` | inst@0x${objPtr.toString(16)}: ${hex.join(" ")}`;
    }
    return msg;
  }

  /**
   * Diagnostic probe: when `instanceClassFields` returns null despite the class
   * name being readable, dump the raw pointer values at several candidate
   * Il2CppClass.fields offsets. Returns a diagnostic string for the caller to
   * log (core layer has no logger). Returns null when the probe is suppressed
   * (already probed this class, or klass unreadable).
   */
  probeClassFieldsLayout(objPtr: bigint): string | null {
    const klass = readPtr(this.reader, objPtr);
    if (klass == null || !isPlausibleHeapPtr(klass)) return null;
    if (this.probedClasses.has(klass)) return null;
    this.probedClasses.add(klass);
    const name = this.className(klass);
    const candidates = [0x68n, 0x70n, 0x78n, 0x80n, 0x88n, 0x90n, 0x98n, 0xa0n, 0xa8n, 0xb0n];
    const parts: string[] = [];
    let firstPlausibleFieldsPtr: bigint | null = null;
    let firstPlausibleOffset: bigint | null = null;
    for (const off of candidates) {
      const p = readPtr(this.reader, klass + off);
      const pStr = p == null ? "null" : isPlausibleHeapPtr(p) ? `0x${p.toString(16)}` : "impl";
      parts.push(`+0x${off.toString(16)}=${pStr}`);
      if (firstPlausibleFieldsPtr == null && p != null && isPlausibleHeapPtr(p)) {
        firstPlausibleFieldsPtr = p;
        firstPlausibleOffset = off;
      }
    }
    let msg = `[scanner] classFields probe: klass=0x${klass.toString(16)} name="${name ?? "null"}" ${parts.join(" ")}`;
    // Dump 0x40 bytes of the first plausible field-info pointer so the layout
    // (entry size, name pointer offset, field offset) can be inferred offline.
    if (firstPlausibleFieldsPtr != null && firstPlausibleOffset != null) {
      const sample = this.reader.readBytes(firstPlausibleFieldsPtr, 0x40);
      if (sample && sample.length === 0x40) {
        const hex: string[] = [];
        for (let i = 0; i < sample.length; i += 8) {
          const lo = sample.readUInt32LE(i);
          const hi = sample.readUInt32LE(i + 4);
          hex.push(
            `${i.toString(16).padStart(2, "0")}:${lo.toString(16).padStart(8, "0")}${hi.toString(16).padStart(8, "0")}`,
          );
        }
        msg += ` | field-info@+0x${firstPlausibleOffset.toString(16)}=0x${firstPlausibleFieldsPtr.toString(16)}: ${hex.join(" ")}`;
      }
    }
    return msg;
  }

  /** static_fields block pointer (tries the known Il2CppClass layout offsets). */
  staticBlock(classPtr: bigint): bigint | null {
    for (const off of STATIC_FIELDS_CANDIDATES) {
      const p = readPtr(this.reader, classPtr + BigInt(off));
      if (p != null && isPlausibleHeapPtr(p)) return p;
    }
    return null;
  }

  /** Plausible pointers in the class's static block (first 0x100 bytes), cached. */
  staticSlots(classPtr: bigint): ReadonlyArray<{ soff: number; value: bigint }> {
    const hit = this.statics.get(classPtr);
    if (hit !== undefined) return hit;
    const out: Array<{ soff: number; value: bigint }> = [];
    const sb = this.staticBlock(classPtr);
    if (sb != null) {
      for (let soff = 0; soff <= STATIC_SCAN_MAX; soff += 8) {
        const v = readPtr(this.reader, sb + BigInt(soff));
        if (v != null && isPlausibleHeapPtr(v)) out.push({ soff, value: v });
      }
    }
    this.statics.set(classPtr, out);
    return out;
  }
}

// ── Class-slot collection (bulk chunked reads) ────────────────────────────────

export interface ScanRegion {
  base: bigint;
  size: number;
}

export interface ClassEntry {
  classPtr: bigint;
  /** TypeInfo slot RVA: address of the slot holding classPtr, relative to gaBase. */
  slotRva: bigint;
  name: string;
}

export interface CollectStats {
  slotsScanned: number;
  pointerTargets: number;
  namedClasses: number;
}

const DEFAULT_CHUNK = 1 << 22; // 4 MiB per ReadProcessMemory call

/**
 * Scan the given regions (8-byte-aligned slots, bulk chunked reads) and index
 * every slot whose value dereferences to a named Il2CppClass. Deduplicates by
 * class pointer, keeping the first slot found — the TypeInfo table entry.
 */
export function collectClassEntries(
  ctx: ScanContext,
  gaBase: bigint,
  regions: readonly ScanRegion[],
  chunkSize = DEFAULT_CHUNK,
): { entries: ClassEntry[]; stats: CollectStats } {
  const slotByTarget = new Map<bigint, bigint>();
  let slotsScanned = 0;

  for (const region of regions) {
    for (let off = 0; off < region.size; off += chunkSize) {
      const size = Math.min(chunkSize, region.size - off);
      const buf = ctx.reader.readBytes(region.base + BigInt(off), size);
      if (!buf) continue;
      for (let i = 0; i + 8 <= buf.length; i += 8) {
        slotsScanned++;
        const v = buf.readBigUInt64LE(i);
        if (!isPlausibleHeapPtr(v)) continue;
        if (!slotByTarget.has(v)) {
          slotByTarget.set(v, region.base + BigInt(off) + BigInt(i) - gaBase);
        }
      }
    }
  }

  const entries: ClassEntry[] = [];
  for (const [classPtr, slotRva] of slotByTarget) {
    const name = ctx.className(classPtr);
    if (name != null) entries.push({ classPtr, slotRva, name });
  }
  return {
    entries,
    stats: {
      slotsScanned,
      pointerTargets: slotByTarget.size,
      namedClasses: entries.length,
    },
  };
}

// ── Anchor detectors ──────────────────────────────────────────────────────────

const MAX_LOG_DICT_ENTRIES = 64;
const MAX_CHEST_LOG = 5_000;
const LOG_VALIDATE_ENTRIES = 20;
const MAX_CURRENCY_DICT = 100_000;
const CURRENCY_DICT_SCAN = 512;

function isStageCacheClassName(name: string | null): boolean {
  return (
    name === "StageCache" || name === "vb.StageCache" || (name?.endsWith(".StageCache") ?? false)
  );
}

/** True when `block` looks like the currency static store (List at +0, Dict at +8). */
function staticBlockHasCurrencyShape(ctx: ScanContext, block: bigint): boolean {
  const list = readPtr(ctx.reader, block);
  const dict = readPtr(ctx.reader, block + 8n);
  return list != null && isPlausibleHeapPtr(list) && dict != null && isPlausibleHeapPtr(dict);
}

/** Gold probe on a currency static block — same disambiguation as the singleton path. */
function staticBlockPassesGoldProbe(ctx: ScanContext, block: bigint, goldKey: number): boolean {
  const dict = readPtr(ctx.reader, block + 8n);
  if (dict == null || !isPlausibleHeapPtr(dict)) return false;
  const goldEntry = dictLookupIntKey(
    ctx.reader,
    dict,
    goldKey,
    MAX_CURRENCY_DICT,
    CURRENCY_DICT_SCAN,
  );
  if (goldEntry == null || !isPlausibleHeapPtr(goldEntry)) return false;
  const gold = readObscuredLong(ctx.reader, goldEntry + BigInt(STRUCT_OBSCURED_QTY));
  return gold != null && plausibleGold(Number(gold));
}

/**
 * Currency manager static store (`uz.tm` / `vb.tp`): a class whose static_fields
 * block holds List<tn> at +0 and Dictionary<int, tn> at +8 with a plausible gold
 * entry for `goldKey`. Matches how bundled TypeInfo RVAs are used at runtime.
 */
export function findCurrencyManagerStatic(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  goldKey: number,
): { slotRva: bigint } | null {
  for (const entry of entries) {
    const block = ctx.staticBlock(entry.classPtr);
    if (block == null) continue;
    if (!staticBlockHasCurrencyShape(ctx, block)) continue;
    if (!staticBlockPassesGoldProbe(ctx, block, goldKey)) continue;
    return { slotRva: entry.slotRva };
  }
  return null;
}

/**
 * Stage-cache static store (`uz.us` / `vb.uu`): a class whose static_fields block
 * holds a live `StageCache` at +0x88 pointing at `StageInfoData` at +0x10.
 */
export function findStageCacheManagerStatic(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): { slotRva: bigint; currentCache: number } | null {
  for (const entry of entries) {
    const block = ctx.staticBlock(entry.classPtr);
    if (block == null) continue;
    const cache = readPtr(ctx.reader, block + BigInt(STRUCT_STAGE_CACHE_STATIC_OFF));
    if (cache == null || !isPlausibleHeapPtr(cache)) continue;
    if (!isStageCacheClassName(ctx.instanceClassName(cache))) continue;
    const info = readPtr(ctx.reader, cache + BigInt(STRUCT_CACHE_INFO_DATA));
    if (info == null || !isPlausibleHeapPtr(info)) continue;
    if (ctx.instanceClassName(info) !== "StageInfoData") continue;
    return { slotRva: entry.slotRva, currentCache: STRUCT_STAGE_CACHE_STATIC_OFF };
  }
  return null;
}

/**
 * StageManager singleton: the wrapper class whose static block holds an object
 * whose class declares a `HeroList` field (serialization-stable name). Returns
 * the wrapper's TypeInfo slot RVA plus the derived HeroList instance offset.
 *
 * Validation layers (a non-StageManager class that also declares `HeroList`
 * must fail at least one):
 *   1. HeroList pointer is plausible and its count is in [1, 64].
 *   2. (Optional, when `opts.heroOffsets` is provided) At least one hero in
 *      the array walks end-to-end: `hero → unit.cache → heroRuntime.info →
 *      heroInfoData.heroKey` yields a plausible int in (0, 10_000_000). This
 *      rejects UI preview / cache classes that hold non-Unit references in
 *      their `HeroList` field — they pass layer 1 but fail layer 2.
 *
 * Without layer 2, the v1.01.02 regression "实现实时了但 DPS/经验/通关记录都没数据"
 * was only partially fixed: the extractor picked a wrong class whose HeroList
 * briefly held a non-empty array of non-Unit pointers during the 5s extraction
 * window; by the time the reader scanned that class's 31 static slots, all
 * arrays were empty (or pointed at non-Unit data) and live data stayed null.
 */
export interface FindStageManagerOpts {
  /**
   * Hero-walk validation offsets. When provided, each candidate's HeroList
   * array is sampled (up to `maxHeroesProbe` elements) and the first element
   * that walks end-to-end to a plausible heroKey validates the class.
   * All three offsets must be non-zero for layer 2 to run.
   */
  heroOffsets?: {
    /** Unit.cache — pointer at `heroPtr + this` → HeroRuntime. */
    unitCache: number;
    /** HeroRuntime.info — pointer at `runtimePtr + this` → HeroInfoData. */
    heroRuntimeInfo: number;
    /** HeroInfoData.heroKey — int32 at `infoPtr + this`. */
    heroInfoDataKey: number;
  };
  /** How many array elements to probe when hero-walk validation is active. */
  maxHeroesProbe?: number;
}

export function findStageManager(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  opts?: FindStageManagerOpts,
): { slotRva: bigint; heroList: number } | null {
  const heroOffsets = opts?.heroOffsets;
  const canWalkHero =
    heroOffsets != null &&
    heroOffsets.unitCache > 0 &&
    heroOffsets.heroRuntimeInfo > 0 &&
    heroOffsets.heroInfoDataKey > 0;
  const maxProbe = Math.min(opts?.maxHeroesProbe ?? 8, 64);
  let rejected = 0;
  let rejectedEmpty = 0;
  let rejectedHeroWalk = 0;
  let firstRejectName: string | null = null;
  let firstRejectReason = "";
  for (const entry of entries) {
    for (const { value: inst } of ctx.staticSlots(entry.classPtr)) {
      const fields = ctx.instanceClassFields(inst);
      const heroList = fields?.get("HeroList");
      if (heroList == null || heroList <= 0) continue;
      // Layer 1: HeroList must point at a non-empty array.
      const arrPtr = readPtr(ctx.reader, inst + BigInt(heroList));
      if (arrPtr == null || !isPlausibleHeapPtr(arrPtr)) {
        rejected++;
        if (firstRejectName == null) {
          firstRejectName = entry.name ?? "(unnamed)";
          firstRejectReason = "arrPtr null/implausible";
        }
        continue;
      }
      const count = readI32(ctx.reader, arrPtr + BigInt(STRUCT_CONTAINER.listSize));
      if (count == null || count <= 0 || count > 64) {
        rejectedEmpty++;
        if (firstRejectName == null) {
          firstRejectName = entry.name ?? "(unnamed)";
          firstRejectReason = `count=${count ?? "null"} (empty/out-of-range)`;
        }
        continue;
      }
      // Layer 2 (when opts provided): at least one hero must walk to a
      // plausible heroKey. UI preview / cache classes that hold non-Unit
      // pointers in their HeroList fail here.
      if (canWalkHero) {
        const first = arrPtr + BigInt(STRUCT_CONTAINER.arrayFirst);
        let validated = false;
        for (let i = 0; i < Math.min(count, maxProbe); i++) {
          const heroPtr = readPtr(ctx.reader, first + BigInt(i * 8));
          if (heroPtr == null || !isPlausibleHeapPtr(heroPtr)) continue;
          const runtimePtr = readPtr(ctx.reader, heroPtr + BigInt(heroOffsets!.unitCache));
          if (runtimePtr == null || !isPlausibleHeapPtr(runtimePtr)) continue;
          const infoPtr = readPtr(ctx.reader, runtimePtr + BigInt(heroOffsets!.heroRuntimeInfo));
          if (infoPtr == null || !isPlausibleHeapPtr(infoPtr)) continue;
          const heroKey = readI32(ctx.reader, infoPtr + BigInt(heroOffsets!.heroInfoDataKey));
          if (heroKey == null || heroKey <= 0 || heroKey >= 10_000_000) continue;
          validated = true;
          break;
        }
        if (!validated) {
          rejectedHeroWalk++;
          if (firstRejectName == null) {
            firstRejectName = entry.name ?? "(unnamed)";
            firstRejectReason = `hero-walk failed (count=${count}, none walked to a valid heroKey)`;
          }
          continue;
        }
      }
      ctx.log(
        `findStageManager: matched class="${entry.name}" inst=0x${inst.toString(16)} ` +
          `heroList=0x${heroList.toString(16)} arrPtr=0x${arrPtr.toString(16)} count=${count} ` +
          `(rejected=${rejected} empty=${rejectedEmpty} heroWalk=${rejectedHeroWalk})`,
      );
      return { slotRva: entry.slotRva, heroList };
    }
  }
  ctx.log(
    `findStageManager: no match — rejected=${rejected} empty=${rejectedEmpty} ` +
      `heroWalk=${rejectedHeroWalk} firstReject="${firstRejectName}"` +
      (firstRejectReason ? ` (${firstRejectReason})` : ""),
  );
  return null;
}

/**
 * StageCacheManager singleton: a static slot pointing at a `StageCache` object
 * whose `+0x10` resolves to a `StageInfoData` (both real class names). Returns
 * the wrapper's slot RVA and the static offset of the current cache.
 */
export function findStageCacheManager(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): { slotRva: bigint; currentCache: number } | null {
  for (const entry of entries) {
    for (const { soff, value: cache } of ctx.staticSlots(entry.classPtr)) {
      if (!isStageCacheClassName(ctx.instanceClassName(cache))) continue;
      const info = readPtr(ctx.reader, cache + BigInt(STRUCT_CACHE_INFO_DATA));
      if (info == null || !isPlausibleHeapPtr(info)) continue;
      if (ctx.instanceClassName(info) !== "StageInfoData") continue;
      return { slotRva: entry.slotRva, currentCache: soff };
    }
  }
  return null;
}

/** LogManager.logByType field offset candidates. The dict has lived at +0x28 on
 *  every version seen so far, but the field name is obfuscated so the byte
 *  offset is not name-stable. Probe a small candidate set rather than assume.
 *  Extended in Rev 6 to cover ±3 pointer-widths for v1.00.28 field shifts. */
const LOG_DICT_OFFSET_CANDIDATES = [0x28, 0x20, 0x30, 0x38, 0x18, 0x40];

/** True for `GetBoxLog` and obfuscated variants (`vb.GetBoxLog`). */
function isGetBoxLogClassName(name: string | null): boolean {
  return classNameMatches(name, "GetBoxLog");
}

/** True for `BoxOpenLog` and obfuscated variants (`vb.BoxOpenLog`). */
function isBoxOpenLogClassName(name: string | null): boolean {
  return classNameMatches(name, "BoxOpenLog");
}

/** Validate a List<GetBoxLog> candidate: non-empty + sampled entries are real
 *  GetBoxLog with EMonsterLogType ∈ {0,1,2}. The non-empty requirement is what
 *  keeps unrelated dictionaries (seen live: compiler-generated `<>c`) from
 *  false-positive matching — keep it.
 *
 *  Tolerance for per-build drift (v1.01.02+):
 *  1. EMonsterLogType offset is probed across
 *     {@link STRUCT_GETBOX_MONSTER_TYPE_CANDIDATES} instead of hardcoded 0x50.
 *     The field name is obfuscated so the byte offset is not name-stable.
 *  2. When the class name doesn't match `GetBoxLog` (even via
 *     {@link classNameMatches}), accept the entry if its IL2CPP class metadata
 *     has a field literally named `monsterLogType` — the ES3 serialization
 *     name stays stable even when the class name is fully randomized.
 */
export function validateGetBoxList(ctx: ScanContext, listPtr: bigint): boolean {
  const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (arr == null || count == null || count <= 0 || count > MAX_CHEST_LOG) return false;
  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);
  // Probe the first entry to discover the EMonsterLogType offset. Try each
  // candidate (and the named "monsterLogType" field) until one yields a value
  // in {0,1,2}. If none does, the field layout is unknown — reject.
  const firstEntry = readPtr(ctx.reader, first);
  if (firstEntry == null || !isPlausibleHeapPtr(firstEntry)) return false;
  const monsterTypeOff = resolveGetBoxMonsterTypeOffset(ctx, firstEntry);
  if (monsterTypeOff == null) return false;

  for (let i = 0; i < Math.min(count, LOG_VALIDATE_ENTRIES); i++) {
    const e = readPtr(ctx.reader, first + BigInt(i * 8));
    if (e == null || !isPlausibleHeapPtr(e)) return false;
    if (!isGetBoxLogClassName(ctx.instanceClassName(e))) {
      // Class-name gate failed. Try the field-name fallback: read this
      // entry's IL2CPP class fields and accept if `monsterLogType` is
      // present (ES3 serialization-stable name). Only the first entry is
      // probed — if it's a GetBoxLog, the rest of the list is too
      // (homogeneous List<T>).
      if (i === 0) {
        const fields = ctx.instanceClassFields(e);
        if (fields == null || !fields.has("monsterLogType")) return false;
        continue;
      }
      // Subsequent entries: trust the first entry's verdict (homogeneous list).
      continue;
    }
    const mt = readI32(ctx.reader, e + BigInt(monsterTypeOff));
    if (mt == null || mt < 0 || mt > 2) return false;
  }
  return true;
}

/** Discover the EMonsterLogType field offset on a GetBoxLog instance by
 *  probing candidate offsets. Returns the first offset whose value is in
 *  {0,1,2}, or null when none validates. Also tries the field name
 *  "monsterLogType" from the class metadata first (stable ES3 name). */
function resolveGetBoxMonsterTypeOffset(ctx: ScanContext, entryPtr: bigint): number | null {
  // 1. Named field lookup (most robust — ES3-stable name).
  const fields = ctx.instanceClassFields(entryPtr);
  if (fields != null) {
    const named = fields.get("monsterLogType");
    if (named != null && named > 0) {
      const v = readI32(ctx.reader, entryPtr + BigInt(named));
      if (v != null && v >= 0 && v <= 2) return named;
    }
  }
  // 2. Candidate offset probe.
  for (const off of STRUCT_GETBOX_MONSTER_TYPE_CANDIDATES) {
    const v = readI32(ctx.reader, entryPtr + BigInt(off));
    if (v != null && v >= 0 && v <= 2) return off;
  }
  return null;
}

/** Validate a List<BoxOpenLog> candidate: non-empty + sampled entries are real
 *  BoxOpenLog instances. Class name is the primary gate (serialization-stable
 *  identifier; the item-key/grade field offsets are resolved separately from the
 *  class metadata). The non-empty requirement mirrors validateGetBoxList —
 *  keeps compiler-generated buckets from matching.
 *
 *  Fallback when class-name validation fails: if the entry's IL2CPP class
 *  metadata exposes a field literally named `itemStringKey` or `itemGradeType`,
 *  accept it anyway. This covers per-build obfuscation that renames the class
 *  beyond what `classNameMatches` tolerates (seen live on v1.00.28) — the field
 *  names are ES3 serialization names and stay stable even when the class name
 *  is fully randomized, so their presence is a stronger signal than the class
 *  name itself.
 *
 *  Returns the first entry pointer on success so the caller can read field
 *  offsets directly from the live object's IL2CPP class metadata (robust against
 *  the BoxOpenLog class being absent from the static-reachable index, or its
 *  name carrying an unexpected namespace prefix). Returns null on rejection. */
function validateBoxOpenList(ctx: ScanContext, listPtr: bigint): bigint | null {
  const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (arr == null || count == null || count <= 0 || count > MAX_CHEST_LOG) return null;
  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);
  let firstEntryPtr: bigint | null = null;
  for (let i = 0; i < Math.min(count, LOG_VALIDATE_ENTRIES); i++) {
    const e = readPtr(ctx.reader, first + BigInt(i * 8));
    if (e == null || !isPlausibleHeapPtr(e)) return null;
    if (!isBoxOpenLogClassName(ctx.instanceClassName(e))) {
      // Class-name gate failed. Try the field-name fallback: read this entry's
      // IL2CPP class fields and accept if `itemStringKey` or `itemGradeType` is
      // present. Only the first entry is probed — if it's a BoxOpenLog, the
      // rest of the list is too (homogeneous List<T>).
      if (i === 0) {
        const fields = ctx.instanceClassFields(e);
        if (fields == null || (!fields.has("itemStringKey") && !fields.has("itemGradeType"))) {
          return null;
        }
        firstEntryPtr = e;
        continue;
      }
      // Subsequent entries: trust the first entry's verdict (homogeneous list).
      // Only the pointer plausibility check above applies.
      if (firstEntryPtr == null) firstEntryPtr = e;
      continue;
    }
    if (i === 0) firstEntryPtr = e;
  }
  return firstEntryPtr;
}

/**
 * Find the Dictionary<ELogType, List<GetBoxLog>> on a LogManager candidate.
 * Neither the `logByType` field offset nor the `ELogType.GetBox` enum value is
 * name-stable, so probe several offset candidates and scan the dict entries for
 * a value that validates as a List<GetBoxLog>. Returns the discovered offset +
 * enum key, or null when no candidate validates.
 */
function findGetBoxLogDict(
  ctx: ScanContext,
  lmPtr: bigint,
): { logByType: number; getBoxTypeKey: number } | null {
  for (const logOff of LOG_DICT_OFFSET_CANDIDATES) {
    const dictPtr = readPtr(ctx.reader, lmPtr + BigInt(logOff));
    if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) continue;
    const entriesArr = readPtr(ctx.reader, dictPtr + BigInt(STRUCT_DICT.entries));
    if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) continue;
    const count = readI32(ctx.reader, dictPtr + BigInt(STRUCT_DICT.count));
    if (count == null || count <= 0 || count > MAX_LOG_DICT_ENTRIES) continue;
    const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
    for (let i = 0; i < count; i++) {
      const eBase = first + BigInt(i * STRUCT_DICT.entrySize);
      const hash = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryHash));
      if (hash == null || hash < 0) continue;
      const key = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryKey));
      if (key == null) continue;
      const listPtr = readPtr(ctx.reader, eBase + BigInt(STRUCT_DICT.entryValue));
      if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
      if (validateGetBoxList(ctx, listPtr)) {
        return { logByType: logOff, getBoxTypeKey: key };
      }
    }
  }
  return null;
}

/**
 * Scan the already-located `logByType` dictionary for the
 * `ELogType.GetItemWithBoxOpen` key — the bucket whose value validates as a
 * `List<BoxOpenLog>`. `logByType` offset is already known from
 * {@link findGetBoxLogDict}, so this is a single-dict walk. Returns `{key:0,
 * firstEntryPtr:null}` when the bucket isn't found (no box opened yet, or
 * BoxOpenLog class name shifted) — the loot reader then degrades to "no live
 * data" gracefully.
 *
 * The returned `firstEntryPtr` is the first validated BoxOpenLog instance
 * pointer, used to resolve struct field offsets directly from the live object's
 * IL2CPP class metadata. This is more robust than searching the static class
 * index by name: the BoxOpenLog class is frequently not static-reachable, and
 * per-build obfuscation can prepend namespace prefixes the name matcher doesn't
 * expect.
 */
function findBoxOpenLogDictKey(
  ctx: ScanContext,
  lmPtr: bigint,
  logByType: number,
): { key: number; firstEntryPtr: bigint | null } {
  const dictPtr = readPtr(ctx.reader, lmPtr + BigInt(logByType));
  if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) return { key: 0, firstEntryPtr: null };
  const entriesArr = readPtr(ctx.reader, dictPtr + BigInt(STRUCT_DICT.entries));
  if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) return { key: 0, firstEntryPtr: null };
  const count = readI32(ctx.reader, dictPtr + BigInt(STRUCT_DICT.count));
  if (count == null || count <= 0 || count > MAX_LOG_DICT_ENTRIES)
    return { key: 0, firstEntryPtr: null };
  const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
  for (let i = 0; i < count; i++) {
    const eBase = first + BigInt(i * STRUCT_DICT.entrySize);
    const hash = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryHash));
    if (hash == null || hash < 0) continue;
    const key = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryKey));
    if (key == null) continue;
    const listPtr = readPtr(ctx.reader, eBase + BigInt(STRUCT_DICT.entryValue));
    if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
    const firstEntryPtr = validateBoxOpenList(ctx, listPtr);
    if (firstEntryPtr != null) return { key, firstEntryPtr };
  }
  return { key: 0, firstEntryPtr: null };
}

/**
 * Resolve `BoxOpenLog` struct field offsets. `itemStringKey` and `itemGradeType`
 * are ES3 serialization-stable field names (real names, not obfuscated).
 *
 * Resolution order (most robust first):
 *  1. **Live instance class metadata** — when `instancePtr` is provided (a
 *     validated BoxOpenLog object pointer from the dict walk), read the field
 *     map directly from the object's IL2CPP class header via
 *     {@link ScanContext.instanceClassFields}. This works even when the
 *     BoxOpenLog class isn't static-reachable and therefore absent from the
 *     `entries` index, and tolerates namespace-prefixed class names
 *     (`vb.BoxOpenLog`, etc.) because the class pointer comes from the live
 *     object, not a name match.
 *  2. **Named class index search** — fall back to {@link namedClassField} over
 *     the static-reachable class index. Used when no instance is available
 *     (e.g. the boxOpen bucket hasn't been populated yet) but the class happens
 *     to be indexed.
 *
 * `boxType` and `level` are obfuscated private fields with no stable name —
 * they return 0 here and must be filled from a manual IL2CPP dump if needed.
 * Returns 0 for every unresolvable field; the reader treats 0 as "not derived"
 * and skips that field.
 */
export function findBoxOpenLogFields(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  instancePtr: bigint | null = null,
): {
  itemStringKey: number;
  itemGradeType: number;
  gradeSO: number;
  gradeSOGrade: number;
  diagnostics?: string;
} {
  // 1. Live instance class metadata (preferred — robust against missing index
  //    entries and namespace-prefixed class names).
  if (instancePtr != null) {
    const fields = ctx.instanceClassFields(instancePtr);
    if (fields != null) {
      const isk = fields.get("itemStringKey");
      const igt = fields.get("itemGradeType");
      // Both fields resolved from the live class — done. Also try to resolve
      // the v1.00.28 GradeSO path (named `gradeSO` field + GradeSO.eGRADE)
      // in case this version supports it; zeros when not found.
      if (isk != null && isk > 0 && igt != null && igt > 0) {
        const { gradeSO, gradeSOGrade } = resolveGradeSOOffsets(ctx, instancePtr, fields);
        return { itemStringKey: isk, itemGradeType: igt, gradeSO, gradeSOGrade };
      }
      // Partial resolution: keep what we have, fall through to named search to
      // fill the gap (a different BoxOpenLog class entry in the index may have
      // the missing field — rare, but cheap to try).
      const fallback = {
        itemStringKey: namedClassField(ctx, entries, "BoxOpenLog", "itemStringKey"),
        itemGradeType: namedClassField(ctx, entries, "BoxOpenLog", "itemGradeType"),
      };
      const result = {
        itemStringKey: isk != null && isk > 0 ? isk : fallback.itemStringKey,
        itemGradeType: igt != null && igt > 0 ? igt : fallback.itemGradeType,
        gradeSO: 0,
        gradeSOGrade: 0,
      };
      // Both fields missing from the live class — field names are likely
      // obfuscated (seen live on v1.00.28: `bfne`/`bfnf`/`bfng` instead of
      // `itemStringKey`/`itemGradeType`). Try to identify the right offsets by
      // reading each candidate field from the live BoxOpenLog instance and
      // validating the value as a plausible catalog item key / grade.
      if (result.itemStringKey === 0 && result.itemGradeType === 0) {
        const identified = identifyBoxOpenLogFieldsByValue(ctx, instancePtr, fields);
        if (identified != null) {
          if (identified.itemStringKey !== 0 && identified.itemGradeType !== 0) {
            // Successfully identified by value — override named-search result.
            // Also resolve GradeSO from the identified GradeSO* pointer field
            // (v1.00.28: the field that's neither itemKey nor grade is the
            // GradeSO* reference; identifyBoxOpenLogFieldsByValue dumps its
            // klass in diagnostics, and resolveGradeSOFromInstance can walk it).
            const { gradeSO, gradeSOGrade } = resolveGradeSOOffsets(ctx, instancePtr, fields);
            return {
              itemStringKey: identified.itemStringKey,
              itemGradeType: identified.itemGradeType,
              gradeSO,
              gradeSOGrade,
              diagnostics: identified.diagnostics,
            };
          }
          // Identification returned diagnostics (e.g. observed values outside
          // expected ranges). Forward the diagnostics to the caller's log.
          if (identified.diagnostics) {
            const dump = ctx.dumpClassFields(instancePtr, fields);
            return {
              itemStringKey: 0,
              itemGradeType: 0,
              gradeSO: 0,
              gradeSOGrade: 0,
              diagnostics: `${identified.diagnostics}${dump != null ? ` | ${dump}` : ""}`,
            };
          }
        }
        // Value-based identification returned null (not enough candidate offsets).
        // Fall back to dump for offline analysis.
        const dump = ctx.dumpClassFields(instancePtr, fields);
        if (dump != null) {
          return { ...result, diagnostics: dump };
        }
      }
      return result;
    }
    // instanceClassFields returned null despite instanceClassName succeeding.
    // Likely cause: the Il2CppClass.fields offset (0x80 / 0x88 fallback) doesn't
    // match this runtime build, or the field-info struct layout changed. Probe
    // additional offsets so the extractor log can pinpoint the new layout.
    const probe = ctx.probeClassFieldsLayout(instancePtr);
    if (probe != null) {
      return {
        itemStringKey: 0,
        itemGradeType: 0,
        gradeSO: 0,
        gradeSOGrade: 0,
        diagnostics: probe,
      };
    }
  }
  // 2. Named class index search.
  return {
    itemStringKey: namedClassField(ctx, entries, "BoxOpenLog", "itemStringKey"),
    itemGradeType: namedClassField(ctx, entries, "BoxOpenLog", "itemGradeType"),
    gradeSO: 0,
    gradeSOGrade: 0,
  };
}

/**
 * Resolve the v1.00.28 GradeSO grade path: find a BoxOpenLog field that points
 * at a GradeSO instance, then read GradeSO's `eGRADE` field offset from its
 * class metadata. Returns zeros when the version doesn't use GradeSO (pre-1.00.28)
 * or when the GradeSO class/eGRADE field can't be resolved.
 *
 * Strategy: walk each candidate field offset, read the pointer, check if the
 * pointer's klass name is "GradeSO". If so, read GradeSO's class fields and
 * look up `eGRADE`. This is O(n_fields) per BoxOpenLog instance and cheap.
 */
function resolveGradeSOOffsets(
  ctx: ScanContext,
  instancePtr: bigint,
  fields: Map<string, number>,
): { gradeSO: number; gradeSOGrade: number } {
  for (const [, off] of fields) {
    if (off <= 0) continue;
    const ptrVal = readPtr(ctx.reader, instancePtr + BigInt(off));
    if (ptrVal == null || !isPlausibleHeapPtr(ptrVal)) continue;
    const klass = readPtr(ctx.reader, ptrVal);
    if (klass == null || !isPlausibleHeapPtr(klass)) continue;
    const klassName = ctx.className(klass);
    if (klassName == null || !classNameMatches(klassName, "GradeSO")) continue;
    // Found the GradeSO* field. Read GradeSO's class fields to find eGRADE.
    const soFields = ctx.classFields(klass);
    if (soFields == null) return { gradeSO: off, gradeSOGrade: 0 };
    const eGrade = soFields.get("eGRADE");
    return {
      gradeSO: off,
      gradeSOGrade: eGrade != null && eGrade > 0 ? eGrade : 0,
    };
  }
  return { gradeSO: 0, gradeSOGrade: 0 };
}

/**
 * Identify `itemStringKey` and `itemGradeType` field offsets by reading each
 * candidate field from a live BoxOpenLog instance and validating the value.
 *
 * Used when IL2CPP field names are obfuscated (e.g. v1.00.28 renames
 * `itemStringKey` → `bfne`). The heuristic:
 *  - `itemStringKey` is the field whose value looks like a save itemKey:
 *    a positive int32, either a catalog id (< 1_000_000, in catalog range) or
 *    a save-encoded itemKey (>= 1_000_000, divides by 1000 to a catalog id).
 *  - `itemGradeType` is the field whose value is a small non-negative int
 *    (0..16 — item grades are a small enum).
 *
 * Reads multiple sample entries to avoid false positives from coincidental
 * values. Returns null when no consistent assignment is found.
 */
function identifyBoxOpenLogFieldsByValue(
  ctx: ScanContext,
  instancePtr: bigint,
  fields: Map<string, number>,
): { itemStringKey: number; itemGradeType: number; diagnostics?: string } | null {
  // Collect all int32 field offsets declared on the class.
  const offsets = Array.from(fields.values())
    .filter((o) => o > 0)
    .sort((a, b) => a - b);
  if (offsets.length < 2) return null;

  // Sample up to 3 entries from the list (we only have the first instance
  // pointer; for multi-entry validation we'd need the list head, which isn't
  // passed here. Rely on the single instance + value-range heuristics.)
  const samples = [instancePtr];

  let bestItemKeyOffset = 0;
  let bestGradeOffset = 0;

  // Track all values for diagnostic output when identification fails.
  const samples0: string[] = [];

  for (const off of offsets) {
    let itemKeyHits = 0;
    let gradeHits = 0;
    for (const ptr of samples) {
      // Try plain int32 first (v1.00.21/23/27 use unobfuscated int fields).
      let v = readI32(ctx.reader, ptr + BigInt(off));
      let decodeMode = "i32";
      let isString = false;
      const diagParts: string[] = [];
      // If int32 read is implausible, the field may be:
      //   - a pointer (v1.00.28 BoxOpenLog.itemStringKey is a System.String
      //     pointer, not an int)
      //   - an ACTk ObscuredInt struct (hiddenValue + currentCryptoKey)
      // Try pointer → IL2CPP String → number first, then ObscuredInt.
      //
      // "Implausible" covers three cases:
      //   1. v == null (read failed)
      //   2. v < 0 (high bit set — typical for pointers whose low 32 bits
      //      exceed 0x7FFFFFFF, e.g. GradeSO* 0x1fdf23f2700 → i32 = -230742786)
      //   3. v >= 0 but neither a plausible itemKey nor a plausible grade
      //      (e.g. a System.String pointer whose low 32 bits happen to be
      //      positive, like 0x1fe57509000 → i32 = 0x57509000 = 1464897536).
      //      Without this third case, the scanner treats the pointer's low
      //      bits as a plain int32 and never tries the String path — the
      //      field is silently misidentified and itemKeyHits stays 0.
      if (v == null || v < 0 || (!isPlausibleItemKey(v) && !isPlausibleGrade(v))) {
        const ptrVal = readPtr(ctx.reader, ptr + BigInt(off));
        if (ptrVal == null) {
          diagParts.push("ptr=null");
        } else if (!isPlausibleHeapPtr(ptrVal)) {
          diagParts.push(`ptr=0x${ptrVal.toString(16)}[impl]`);
        } else {
          // Read the klass at the pointer target so we can see WHAT the
          // pointer points at (System.String vs some other managed object).
          // Without this, a non-String pointer silently falls through to the
          // ObscuredInt path and produces a garbage int32 that masks the real
          // layout (root cause of the v1.00.28 "[obsc]" misdiagnosis).
          const klass = readPtr(ctx.reader, ptrVal);
          const klassName =
            klass != null && isPlausibleHeapPtr(klass) ? ctx.className(klass) : null;
          diagParts.push(`ptr=0x${ptrVal.toString(16)}[klass=${klassName ?? "null"}]`);
          // v1.00.28: grade moved from a plain int field to a GradeSO
          // ScriptableObject reference. Dump GradeSO's class fields + instance
          // bytes so we can find the grade enum/int offset inside it.
          if (klassName != null && classNameMatches(klassName, "GradeSO")) {
            const gradeFields = ctx.classFields(klass!);
            if (gradeFields != null && gradeFields.size > 0) {
              const fl: string[] = [];
              for (const [fn, fo] of gradeFields) {
                fl.push(`${fn}=0x${fo.toString(16)}`);
              }
              diagParts.push(`gradeSO.fields=[${fl.join(",")}]`);
              // Dump first 0x40 bytes of the GradeSO instance to see field values.
              const soBuf = ctx.reader.readBytes(ptrVal, 0x40);
              if (soBuf != null && soBuf.length === 0x40) {
                const hex: string[] = [];
                for (let i = 0; i < soBuf.length; i += 8) {
                  const lo = soBuf.readUInt32LE(i);
                  const hi = soBuf.readUInt32LE(i + 4);
                  hex.push(
                    `${i.toString(16).padStart(2, "0")}:${lo.toString(16).padStart(8, "0")}${hi.toString(16).padStart(8, "0")}`,
                  );
                }
                diagParts.push(`gradeSO.inst=[${hex.join(" ")}]`);
              }
            } else {
              diagParts.push("gradeSO.fields=null");
            }
          }
          if (klassName != null && classNameMatches(klassName, "String")) {
            const s = readIl2CppString(ctx.reader, ptrVal);
            if (s == null) {
              const len = readI32(ctx.reader, ptrVal + 0x10n);
              diagParts.push(`str=null[len=${len ?? "null"}]`);
            } else {
              diagParts.push(`str="${s.length > 32 ? s.slice(0, 32) + "…" : s}"`);
              // v1.00.28 itemStringKey is a localization key like "ItemName_530017",
              // not a pure-numeric string. Accept either pure digits OR extract
              // the trailing digit run as the catalog itemKey.
              const direct = /^[0-9]+$/.test(s) ? s : (s.match(/(\d+)$/) ?? [])[1];
              if (direct != null) {
                const parsed = Number.parseInt(direct, 10);
                if (Number.isSafeInteger(parsed) && parsed > 0) {
                  v = parsed;
                  decodeMode = "str";
                  isString = true;
                }
              }
            }
          }
        }
        // Still no luck — try ObscuredInt decode (8-byte struct).
        // NOTE: this path returns non-null for almost any non-zero 8 bytes, so
        // the resulting int32 is often garbage when the field is actually a
        // pointer. The diagParts above let us distinguish "real ObscuredInt"
        // from "pointer misread as ObscuredInt" in the log.
        if (v == null || v < 0) {
          const buf = ctx.reader.readBytes(ptr + BigInt(off), 8);
          if (buf != null && buf.length >= 8) {
            const decoded = decodeObscuredInt(buf, 0);
            if (decoded != null) {
              v = decoded;
              decodeMode = "obsc";
            }
          }
        }
      }
      if (v == null) {
        samples0.push(`+0x${off.toString(16)}=null[${diagParts.join(",")}]`);
        continue;
      }
      samples0.push(
        `+0x${off.toString(16)}=${v}(0x${v.toString(16)})[${decodeMode}]${isString ? "[str]" : ""}${diagParts.length > 0 ? `[${diagParts.join(",")}]` : ""}${isPlausibleItemKey(v) ? "[ik]" : ""}${isPlausibleGrade(v) ? "[gr]" : ""}`,
      );
      if (isPlausibleItemKey(v)) itemKeyHits++;
      if (isPlausibleGrade(v)) gradeHits++;
    }
    // Prefer the offset that hits as itemKey for all samples and never as grade.
    if (itemKeyHits === samples.length && gradeHits === 0) {
      bestItemKeyOffset = off;
    }
    // Prefer the offset that hits as grade for all samples and never as itemKey.
    if (gradeHits === samples.length && itemKeyHits === 0) {
      bestGradeOffset = off;
    }
  }

  if (bestItemKeyOffset !== 0 && bestGradeOffset !== 0) {
    return {
      itemStringKey: bestItemKeyOffset,
      itemGradeType: bestGradeOffset,
      diagnostics: `[scanner] identifyByValue ok: itemStringKey=0x${bestItemKeyOffset.toString(16)} itemGradeType=0x${bestGradeOffset.toString(16)} samples=[${samples0.join(", ")}]`,
    };
  }
  // Identification failed — return diagnostics so the caller can log the
  // observed values. The ranges in isPlausibleItemKey / isPlausibleGrade may
  // need widening, or the fields may be non-int32 (e.g. ObscuredLong).
  return {
    itemStringKey: 0,
    itemGradeType: 0,
    diagnostics: `[scanner] identifyByValue failed: instancePtr=0x${instancePtr.toString(16)} samples=[${samples0.join(", ")}]`,
  };
}

/** True when `v` looks like a save itemKey: positive int32 in catalog range
 *  (< 1_000_000) or save-encoded (>= 1_000_000, divides by 1000 to catalog). */
function isPlausibleItemKey(v: number): boolean {
  if (v <= 0 || !Number.isSafeInteger(v)) return false;
  if (v < 1_000_000) {
    // Catalog id range (gamedata.ts: SAVE_CATALOG_ITEM_KEY_MIN..MAX).
    return v >= 110_001 && v <= 939_999;
  }
  // Save-encoded: /1000 should land in catalog range.
  const base = Math.trunc(v / 1000);
  return base >= 110_001 && base <= 939_999;
}

/** True when `v` looks like an item grade: small non-negative int (0..16). */
function isPlausibleGrade(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0 && v <= 16;
}

/**
 * LogManager singleton (chest-drop log): a static slot pointing at an object
 * whose logByType dictionary maps some ELogType key to a list of `GetBoxLog`
 * entries. The field offset and enum key are discovered structurally (see
 * {@link findGetBoxLogDict}) rather than assumed. Requires at least one logged
 * drop to validate — retried on later launches while the offset table stays
 * incomplete. Returns the slot RVA plus the discovered logByType offset and
 * GetBox enum key so the runtime reader uses the same values.
 *
 * Also derives the `ELogType.GetItemWithBoxOpen` key (loot tracker) by scanning
 * the same dictionary for a `List<BoxOpenLog>` bucket, and the `BoxOpenLog`
 * struct field offsets (`itemStringKey`, `itemGradeType`) from the class
 * metadata. The field offsets are resolved from the live BoxOpenLog instance
 * captured during the dict walk when available (robust against the class being
 * absent from the static-reachable index), falling back to the named-class
 * index search. These are best-effort: they return 0 when the bucket is empty
 * or the class isn't indexed yet, and the loot reader degrades gracefully.
 */
export function findLogManager(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): {
  slotRva: bigint;
  logByType: number;
  getBoxTypeKey: number;
  boxOpenTypeKey: number;
  boxOpenLog: {
    itemStringKey: number;
    itemGradeType: number;
    gradeSO: number;
    gradeSOGrade: number;
    diagnostics?: string;
  };
  /**
   * Diagnostics for the box-open derivation path. Populated when `boxOpenTypeKey`
   * is non-zero (dict bucket located) but `boxOpenLog.itemStringKey` is 0 (field
   * offsets not resolved). Lets the extractor log WHY validation failed so we
   * can fix the structural detector without a live debugger.
   *  - `bucketCount`: list size observed in the dict (0 = empty bucket, >0 = entries present)
   *  - `firstEntryClassName`: the class name read from the first entry's IL2CPP
   *    header (null when the pointer was unreadable or the class name didn't
   *    match the printable-ASCII gate). When non-null but not matching
   *    `BoxOpenLog`, the obfuscator has renamed the class beyond what
   *    `classNameMatches` tolerates.
   *  - `fieldsProbe`: when `instanceClassFields` returned null despite the class
   *    name being readable, a one-shot dump of candidate Il2CppClass.fields
   *    offsets + the first plausible field-info struct bytes. Pinpoints whether
   *    the Il2CppClass layout shifted on a new runtime build.
   */
  boxOpenDiagnostics?: {
    bucketCount: number | null;
    firstEntryClassName: string | null;
    firstEntryPtr: bigint | null;
    fieldsProbe?: string;
  };
} | null {
  for (const entry of entries) {
    for (const { value: inst } of ctx.staticSlots(entry.classPtr)) {
      const found = findGetBoxLogDict(ctx, inst);
      if (found != null) {
        const boxOpen = findBoxOpenLogDictKey(ctx, inst, found.logByType);
        const boxOpenLog = findBoxOpenLogFields(ctx, entries, boxOpen.firstEntryPtr);
        const boxOpenDiagnostics =
          boxOpen.key !== 0 && boxOpenLog.itemStringKey === 0
            ? collectBoxOpenDiagnostics(
                ctx,
                inst,
                found.logByType,
                boxOpen.key,
                boxOpenLog.diagnostics,
              )
            : undefined;
        return {
          slotRva: entry.slotRva,
          logByType: found.logByType,
          getBoxTypeKey: found.getBoxTypeKey,
          boxOpenTypeKey: boxOpen.key,
          boxOpenLog,
          boxOpenDiagnostics,
        };
      }
    }
  }
  return null;
}

/**
 * Best-effort diagnostics for the box-open bucket: read the list size and the
 * first entry's class name, so the extractor log can pinpoint why
 * `validateBoxOpenList` rejected the bucket (empty list, renamed class,
 * unreadable header, …). Pure-read: no state change.
 */
function collectBoxOpenDiagnostics(
  ctx: ScanContext,
  lmPtr: bigint,
  logByType: number,
  boxOpenKey: number,
  fieldsProbe?: string,
): {
  bucketCount: number | null;
  firstEntryClassName: string | null;
  firstEntryPtr: bigint | null;
  fieldsProbe?: string;
} {
  const dictPtr = readPtr(ctx.reader, lmPtr + BigInt(logByType));
  if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) {
    return { bucketCount: null, firstEntryClassName: null, firstEntryPtr: null, fieldsProbe };
  }
  const listPtr = dictLookupIntKey(
    ctx.reader,
    dictPtr,
    boxOpenKey,
    MAX_LOG_DICT_ENTRIES,
    MAX_LOG_DICT_ENTRIES,
  );
  if (listPtr == null || !isPlausibleHeapPtr(listPtr)) {
    return { bucketCount: null, firstEntryClassName: null, firstEntryPtr: null, fieldsProbe };
  }
  const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (arr == null || count == null || count <= 0) {
    return { bucketCount: count, firstEntryClassName: null, firstEntryPtr: null, fieldsProbe };
  }
  const firstEntryPtr = readPtr(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
  if (firstEntryPtr == null || !isPlausibleHeapPtr(firstEntryPtr)) {
    return { bucketCount: count, firstEntryClassName: null, firstEntryPtr: null, fieldsProbe };
  }
  const className = ctx.instanceClassName(firstEntryPtr);
  return { bucketCount: count, firstEntryClassName: className, firstEntryPtr, fieldsProbe };
}

/**
 * Best-effort diagnostics for `findLogManager` rejection: walk the same
 * static-slot → logByType-dict path that `findGetBoxLogDict` would, but
 * instead of validating + returning on the first hit, dump every dict
 * bucket encountered so the extractor log can pinpoint WHY validation
 * failed (renamed GetBoxLog class, empty list, shifted dict offset, …).
 *
 * Called only when `findLogManager` returns null — pure-read, no state
 * change, bounded to 5 buckets to keep the log short. Output is a
 * newline-joined string prefixed with `[logManager-diag]` per line so
 * `grep "[logManager-diag]"` collects the whole dump.
 *
 * Returns `"[logManager-diag] no dict-shaped static slot found"` when no
 * static slot's instance has a dict-shaped field at any candidate offset —
 * the LogManager singleton either isn't loaded yet or its layout shifted
 * beyond `LOG_DICT_OFFSET_CANDIDATES`.
 */
export function collectLogManagerDiagnostics(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): string {
  const lines: string[] = [];
  let probed = 0;
  for (const entry of entries) {
    for (const { value: inst } of ctx.staticSlots(entry.classPtr)) {
      for (const logOff of LOG_DICT_OFFSET_CANDIDATES) {
        const dictPtr = readPtr(ctx.reader, inst + BigInt(logOff));
        if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) continue;
        const entriesArr = readPtr(ctx.reader, dictPtr + BigInt(STRUCT_DICT.entries));
        if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) continue;
        const count = readI32(ctx.reader, dictPtr + BigInt(STRUCT_DICT.count));
        if (count == null || count <= 0 || count > MAX_LOG_DICT_ENTRIES) continue;
        const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
        for (let i = 0; i < count; i++) {
          const eBase = first + BigInt(i * STRUCT_DICT.entrySize);
          const hash = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryHash));
          if (hash == null || hash < 0) continue; // deleted / unused slot
          const key = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryKey));
          const listPtr = readPtr(ctx.reader, eBase + BigInt(STRUCT_DICT.entryValue));
          if (listPtr == null || !isPlausibleHeapPtr(listPtr)) {
            lines.push(
              `[logManager-diag] slotRva=0x${entry.slotRva.toString(16)} logOff=0x${logOff.toString(16)} key=${key ?? "null"} dictCount=${count} bucketCount=null (no list ptr)`,
            );
            probed++;
            if (probed >= 5) return lines.join("\n");
            continue;
          }
          const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
          const bucketCount = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
          let firstEntryClassName: string | null = null;
          let firstEntryFields: string | null = null;
          if (arr != null && bucketCount != null && bucketCount > 0) {
            const firstEntry = readPtr(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
            if (firstEntry != null && isPlausibleHeapPtr(firstEntry)) {
              firstEntryClassName = ctx.instanceClassName(firstEntry);
              const fields = ctx.instanceClassFields(firstEntry);
              if (fields != null) {
                const fl: string[] = [];
                for (const [fn, fo] of fields) fl.push(`${fn}=0x${fo.toString(16)}`);
                firstEntryFields = `[${fl.join(",")}]`;
              }
            }
          }
          lines.push(
            `[logManager-diag] slotRva=0x${entry.slotRva.toString(16)} logOff=0x${logOff.toString(16)} key=${key ?? "null"} dictCount=${count} bucketCount=${bucketCount ?? "null"} firstEntryClassName=${firstEntryClassName ?? "null"} firstEntryFields=${firstEntryFields ?? "null"}`,
          );
          probed++;
          if (probed >= 5) return lines.join("\n");
        }
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "[logManager-diag] no dict-shaped static slot found";
}

/**
 * Direct fallback for {@link findLogManager} when GetBoxLog validation fails.
 * Walks every static slot's candidate logByType offsets, scans each dict's
 * buckets, and returns the first one whose value validates as a
 * `List<BoxOpenLog>` (via {@link validateBoxOpenList}, which has a field-name
 * fallback for obfuscated class names). Resolves BoxOpenLog field offsets
 * from the live first entry.
 *
 * Returns `{ slotRva, logByType, boxOpenTypeKey, boxOpenLog }` on success,
 * or null when no dict has a valid BoxOpen bucket. `getBoxTypeKey` is 0
 * (GetBoxLog chest-drop log is unavailable in this path — only loot tracking
 * is restored).
 *
 * This is the v1.01.02 safety net: when GetBoxLog's class name or
 * EMonsterLogType offset shifts beyond what validateGetBoxList tolerates
 * (even after Task 4's widening), the loot tracker can still function
 * because BoxOpenLog validation is more tolerant (field-name fallback).
 */
export function findBoxOpenLogDictDirect(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): {
  slotRva: bigint;
  logByType: number;
  boxOpenTypeKey: number;
  boxOpenLog: {
    itemStringKey: number;
    itemGradeType: number;
    gradeSO: number;
    gradeSOGrade: number;
    diagnostics?: string;
  };
} | null {
  for (const entry of entries) {
    for (const { value: inst } of ctx.staticSlots(entry.classPtr)) {
      for (const logOff of LOG_DICT_OFFSET_CANDIDATES) {
        const dictPtr = readPtr(ctx.reader, inst + BigInt(logOff));
        if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) continue;
        const entriesArr = readPtr(ctx.reader, dictPtr + BigInt(STRUCT_DICT.entries));
        if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) continue;
        const count = readI32(ctx.reader, dictPtr + BigInt(STRUCT_DICT.count));
        if (count == null || count <= 0 || count > MAX_LOG_DICT_ENTRIES) continue;
        const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
        for (let i = 0; i < count; i++) {
          const eBase = first + BigInt(i * STRUCT_DICT.entrySize);
          const hash = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryHash));
          if (hash == null || hash < 0) continue;
          const key = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryKey));
          if (key == null) continue;
          const listPtr = readPtr(ctx.reader, eBase + BigInt(STRUCT_DICT.entryValue));
          if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
          const firstEntryPtr = validateBoxOpenList(ctx, listPtr);
          if (firstEntryPtr == null) continue;
          // Found a BoxOpen bucket — resolve field offsets from the live entry.
          const boxOpenLog = findBoxOpenLogFields(ctx, entries, firstEntryPtr);
          return {
            slotRva: entry.slotRva,
            logByType: logOff,
            boxOpenTypeKey: key,
            boxOpenLog,
          };
        }
      }
    }
  }
  return null;
}

/**
 * Currency manager singleton fallback: statics hold a List at +0 and a
 * `Dictionary<int, T>` at +8 whose `goldKey` entry decodes to plausible gold.
 */
export function findCurrencyManager(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  goldKey: number,
): { slotRva: bigint } | null {
  for (const entry of entries) {
    const sb = ctx.staticBlock(entry.classPtr);
    if (sb == null) continue;
    const list = readPtr(ctx.reader, sb);
    const dict = readPtr(ctx.reader, sb + BigInt(STRUCT_CURRENCY_DICT));
    if (list == null || !isPlausibleHeapPtr(list)) continue;
    if (dict == null || !isPlausibleHeapPtr(dict)) continue;
    const goldEntry = dictLookupIntKey(
      ctx.reader,
      dict,
      goldKey,
      MAX_CURRENCY_DICT,
      CURRENCY_DICT_SCAN,
    );
    if (goldEntry == null || !isPlausibleHeapPtr(goldEntry)) continue;
    const gold = readObscuredLong(ctx.reader, goldEntry + BigInt(STRUCT_OBSCURED_QTY));
    if (gold != null && plausibleGold(Number(gold))) {
      return { slotRva: entry.slotRva };
    }
  }
  return null;
}

const MAX_SAVE_LIST = 100_000;

/** Offset of the first instance field holding a `List<elementClassName>`. */
function findListField(ctx: ScanContext, obj: bigint, elementClassName: string): number | null {
  for (let foff = 0x10; foff <= INSTANCE_SCAN_MAX; foff += 8) {
    const listPtr = readPtr(ctx.reader, obj + BigInt(foff));
    if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
    const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
    if (arr == null || !isPlausibleHeapPtr(arr)) continue;
    const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
    if (count == null || count <= 0 || count > MAX_SAVE_LIST) continue;
    const e0 = readPtr(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
    if (e0 == null || !classNameMatches(ctx.instanceClassName(e0), elementClassName)) continue;
    return foff;
  }
  return null;
}

export interface PlayerAnchor {
  /** TypeInfo slot RVA of the class whose static block holds the player object. */
  commonSaveData: bigint;
  /** Offset of the player object within that static block. */
  playerStaticOff: number;
  petSaveDatas: number;
  itemSaveDatas: number;
  /** Optional: PlayerSaveData.aggregateSaveDatas offset (for combat gold reading). */
  aggregateSaveDatas?: number;
  /** Optional: PlayerSaveData.BoxData offset (for live chest slot reading). 0 = not derived. */
  boxData?: number;
  /**
   * Diagnostic dump from `ScanContext.dumpClassFields` produced when the
   * "BoxData" field-name match fails. Forwarded to the extractor log so we
   * can see the actual PlayerSaveData field names on versions where BoxData
   * is obfuscated/renamed (e.g. v1.01.02). Undefined when the field was
   * found, or when the one-shot `probedClasses` guard suppressed the dump.
   */
  boxDataDiagnostics?: string;
  petKey: number;
  petIsUnlock: number;
  itemKey: number;
  itemIsChaotic: number;
}

/** Field offset from a named class in the index (0 when class/field is absent). */
function namedClassField(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  className: string,
  fieldName: string,
): number {
  for (const entry of entries) {
    if (!classNameMatches(entry.name, className)) continue;
    const off = ctx.classFields(entry.classPtr)?.get(fieldName);
    if (off != null && off > 0) return off;
  }
  return 0;
}

/**
 * Player save-data anchor (pets + inventory): a static slot pointing at an
 * object that carries the save lists — identified by the serialization-stable
 * field names (`PetSaveData`, `itemSaveDatas`) or, failing that, by hunting for
 * a `List<PetSaveData>` / `List<ItemSaveData>` among its raw instance fields.
 * Element struct offsets come from the `PetSaveData` / `ItemSaveData` classes.
 * Not resolvable on v1.00.23 (save objects are not static-reachable at
 * runtime) — pets/inventory then degrade to save-file data.
 */
export function findPlayerSaveData(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): PlayerAnchor | null {
  for (const entry of entries) {
    for (const { soff, value: obj } of ctx.staticSlots(entry.classPtr)) {
      const fields = ctx.instanceClassFields(obj);
      if (fields == null) continue;
      let petsOff = fields.get("PetSaveData") ?? 0;
      let itemsOff = fields.get("itemSaveDatas") ?? 0;
      if (petsOff <= 0) petsOff = findListField(ctx, obj, "PetSaveData") ?? 0;
      if (itemsOff <= 0) itemsOff = findListField(ctx, obj, "ItemSaveData") ?? 0;
      if (petsOff <= 0 && itemsOff <= 0) continue;

      // BoxData field — named match first (ES3-stable field name), structural
      // fallback not yet needed. 0 = absent; reader falls back to save path.
      // When the named match fails, dump the PlayerSaveData class field table
      // + raw bytes so the extractor log shows the actual (possibly obfuscated)
      // field names on versions like v1.01.02 where "BoxData" is renamed.
      // `dumpClassFields` is one-shot per class (probedClasses guard), so this
      // is cheap and won't spam the log on repeated extraction attempts.
      const boxDataOff = fields.get("BoxData") ?? 0;
      const boxDataDiagnostics =
        boxDataOff === 0 ? (ctx.dumpClassFields(obj, fields) ?? undefined) : undefined;

      return {
        commonSaveData: entry.slotRva,
        playerStaticOff: soff,
        petSaveDatas: petsOff,
        itemSaveDatas: itemsOff,
        boxData: boxDataOff,
        boxDataDiagnostics,
        petKey: namedClassField(ctx, entries, "PetSaveData", "PetKey"),
        petIsUnlock: namedClassField(ctx, entries, "PetSaveData", "IsUnlock"),
        itemKey: namedClassField(ctx, entries, "ItemSaveData", "ItemKey"),
        itemIsChaotic: namedClassField(ctx, entries, "ItemSaveData", "IsChaotic"),
      };
    }
  }
  return null;
}

// ── MonsterSpawnManager detector ──────────────────────────────────────────────

const MONSTER_LIST_SCAN_MAX = 0x200;
const MAX_MONSTERS_SCAN = 500;

/** True when `obj` (a potential MonsterSpawnManager) has at least 2 non-empty List<> fields. */
function hasMonsterListShape(ctx: ScanContext, obj: bigint): boolean {
  let listCount = 0;
  for (let foff = 0x10; foff <= MONSTER_LIST_SCAN_MAX; foff += 8) {
    const listPtr = readPtr(ctx.reader, obj + BigInt(foff));
    if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
    const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
    if (arr == null || !isPlausibleHeapPtr(arr)) continue;
    const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
    if (count != null && count >= 0 && count <= MAX_MONSTERS_SCAN) listCount++;
  }
  return listCount >= 2;
}

/**
 * MonsterSpawnManager singleton: a static slot pointing at an object with at
 * least 2 non-empty List<> fields (monsterList + summonedList, or monsterList +
 * deadMonsterList). Validated structurally: no name matching needed.
 * Also returns the instance pointer for follow-up health-controller discovery.
 * Returns null when no MonsterSpawnManager is found (no battle in progress).
 */
export function findMonsterSpawnManager(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): { slotRva: bigint; inst: bigint } | null {
  for (const entry of entries) {
    for (const { value: inst } of ctx.staticSlots(entry.classPtr)) {
      if (hasMonsterListShape(ctx, inst)) return { slotRva: entry.slotRva, inst };
    }
  }
  return null;
}

// ── Catalog extraction diagnostics (spike for runtime catalog overlay) ───────
//
// The bundled gamedata.json lags behind game patches (e.g. v1.00.28 ships
// 620xxx ring items absent from the v1.00.21 catalog). The long-term fix is a
// runtime catalog overlay extracted from game memory. This diagnostic dumps
// candidate ItemSO classes + ItemManager containers so we can design the real
// extractor without guessing. Triggered by TBH_DUMP_CATALOG_CANDIDATES=1 in
// offsetExtractor; zero impact on the production path when disabled.

const CATALOG_DUMP_MAX_CLASSES = 40;
const CATALOG_DUMP_MAX_CONTAINERS = 20;
const CATALOG_DUMP_MAX_NAME_PROBE = 200;
/** Per-host static slots scanned in Pass 2 (bounded to keep dump fast). */
const CATALOG_DUMP_MAX_SLOTS_PER_HOST = 8;
/** Per-instance field offsets scanned in Pass 2 (bounded). */
const CATALOG_DUMP_MAX_FIELD_SCAN = 0x80;
/** Hint words for ItemManager / ItemDatabase host class names. */
const CATALOG_MANAGER_NAME_HINTS = [
  "manager",
  "database",
  "catalog",
  "table",
  "list",
  "registry",
  "dict",
];
const CATALOG_ITEM_NAME_HINTS = ["item", "gear", "equip", "loot", "treasure"];
/**
 * Pass 0 name-probe hints: dump class names ending with these suffixes or
 * containing these words. Designed to discover the real ItemSO class name
 * (v1.00.28 may use GearSO/MaterialSO/AccessorySO instead of ItemSO). Output
 * is class names only (no field dump), so we can afford a larger cap.
 */
const CATALOG_NAME_PROBE_HINTS = [
  "SO", // ScriptableObject suffix (GearSO, MaterialSO, GradeSO, ...)
  "Gear",
  "Material",
  "Accessory",
  "StageBox",
  "Ring",
  "Amulet",
  "Earring",
  "Bracer",
  "Weapon",
  "Armor",
  "Helmet",
  "Boots",
  "Gloves",
  "Shield",
  "Sword",
  "Bow",
  "Staff",
  "Scepter",
  "Definition",
  "ItemDef",
];

/** Field names that suggest an id field on an ItemSO candidate. */
const ID_FIELD_HINTS = new Set(["id", "itemId", "itemKey", "key", "uniqueId"]);
/** Field names that suggest a name/display field. */
const NAME_FIELD_HINTS = new Set([
  "name",
  "itemName",
  "displayName",
  "localizationKey",
  "itemNameKey",
  "stringKey",
]);
/** Field names that suggest a grade/rarity field. */
const GRADE_FIELD_HINTS = new Set(["grade", "gradeType", "itemGradeType", "rarity", "tier"]);

function fieldHintMatch(fields: Map<string, number>, hints: Set<string>): string | null {
  for (const name of fields.keys()) {
    if (hints.has(name)) return name;
  }
  // Tolerate suffix variations (mangled names would not match, but un-mangled
  // renamed fields like "itemId_" might).
  for (const name of fields.keys()) {
    for (const h of hints) {
      if (name.toLowerCase().startsWith(h.toLowerCase())) return name;
    }
  }
  return null;
}

/**
 * Heuristic: does this class look like an ItemSO candidate? Either the class
 * name contains an item-related hint, OR its field table has both an id-like
 * and a name-like field (the minimum to extract catalog rows).
 */
function isItemSOCandidate(name: string | null, fields: Map<string, number> | null): boolean {
  const nameHitsItem =
    name != null && CATALOG_ITEM_NAME_HINTS.some((h) => name.toLowerCase().includes(h));
  if (nameHitsItem && fields != null && fields.size > 0) return true;
  if (fields == null || fields.size < 2) return false;
  // Field-based signature: id + name (with or without grade). This catches
  // renamed classes whose field names survived (serialization-stable).
  return (
    fieldHintMatch(fields, ID_FIELD_HINTS) != null &&
    fieldHintMatch(fields, NAME_FIELD_HINTS) != null
  );
}

/**
 * Probe whether `inst` looks like a List<T> or Dictionary<int, T> container
 * whose element type is `elementClassPtr`. Returns a short descriptor for the
 * dump log, or null when the shape doesn't match.
 */
function probeContainerOf(
  ctx: ScanContext,
  inst: bigint,
  elementClassPtr: bigint,
): { kind: "List" | "Dict"; count: number; firstElementPtr: bigint } | null {
  // List<T>: listPtr + 0x10 = array, +0x18 = count, array + 0x20 = first element.
  const arr = readPtr(ctx.reader, inst + BigInt(STRUCT_CONTAINER.listItems));
  if (arr != null && isPlausibleHeapPtr(arr)) {
    const count = readI32(ctx.reader, inst + BigInt(STRUCT_CONTAINER.listSize));
    if (count != null && count > 0 && count < 200_000) {
      const e0 = readPtr(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
      if (e0 != null && isPlausibleHeapPtr(e0)) {
        const e0Klass = readPtr(ctx.reader, e0);
        if (e0Klass === elementClassPtr) {
          return { kind: "List", count, firstElementPtr: e0 };
        }
      }
    }
  }
  // Dictionary<int, T>: dictPtr + 0x18 = entries, +0x20 = count. Each entry is
  // 24 bytes (hash:4, next:4, key:8, value:8). We only need to validate one
  // entry's value klass to confirm element type.
  const entriesArr = readPtr(ctx.reader, inst + BigInt(STRUCT_DICT.entries));
  if (entriesArr != null && isPlausibleHeapPtr(entriesArr)) {
    const count = readI32(ctx.reader, inst + BigInt(STRUCT_DICT.count));
    if (count != null && count > 0 && count < 200_000) {
      // First entry's value sits at entriesArr + 0x20 (arrayFirst) + entrySize - 8
      // (value is the last 8 bytes of the 24-byte entry). entrySize = 24, so
      // value offset within first entry = 0x20 + 16 = 0x30.
      const firstValue = readPtr(
        ctx.reader,
        entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst) + BigInt(STRUCT_DICT.entrySize - 8),
      );
      if (firstValue != null && isPlausibleHeapPtr(firstValue)) {
        const vKlass = readPtr(ctx.reader, firstValue);
        if (vKlass === elementClassPtr) {
          return { kind: "Dict", count, firstElementPtr: firstValue };
        }
      }
    }
  }
  return null;
}

/**
 * Dump catalog-extraction candidates via the `log` callback, streaming each
 * line as it's found (so the user sees progress immediately). Each line is
 * prefixed with `[catalog-dump]`.
 *
 * What it dumps:
 *  1. ItemSO candidate classes — classes whose name hits an item hint, OR whose
 *     field table has id-like + name-like fields. For each: class name, field
 *     table (up to 20 fields), and whether grade/level-like fields are present.
 *  2. ItemManager candidates — classes whose name hits a manager hint (Manager /
 *     Database / Catalog / Table / List / Registry / Dict) AND whose static
 *     block has a plausible instance pointer holding a List<T>/Dict<int,T> of
 *     an ItemSO candidate. For each: container class name, container kind,
 *     element count, and a pointer to the first element.
 *  3. One sample ItemSO instance field dump — shows actual field values (int /
 *     String* / GradeSO*) so we can design the extractor without guessing.
 *
 * Bounded for performance:
 *  - At most CATALOG_DUMP_MAX_CLASSES ItemSO candidates.
 *  - At most CATALOG_DUMP_MAX_CONTAINERS ItemManager candidates.
 *  - Pass 2 only scans host classes whose name hits a manager hint (cuts the
 *    10k+ entries to a few dozen), and for each only the first
 *    CATALOG_DUMP_MAX_SLOTS_PER_HOST static slots × field offsets up to
 *    CATALOG_DUMP_MAX_FIELD_SCAN.
 */
export function dumpCatalogCandidates(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  log: (line: string) => void,
): void {
  log(
    `[catalog-dump] scanning ${entries.length} class entries for ItemSO / ItemManager candidates`,
  );

  // Pass 0: name probe — dump class names that match item-definition naming
  // patterns (suffix "SO", or contains gear/material/accessory type words).
  // This is cheap (string match only, no memory reads) and reveals the real
  // ItemSO class name when v1.00.28 uses GearSO/MaterialSO instead of ItemSO.
  // Output is capped at CATALOG_DUMP_MAX_NAME_PROBE class names.
  const nameProbeHits: Array<{ name: string; classPtr: bigint }> = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    const lower = entry.name.toLowerCase();
    const hit =
      lower.endsWith("so") ||
      CATALOG_NAME_PROBE_HINTS.some((h) => {
        if (h === "SO") return false; // already checked via endsWith
        return lower.includes(h.toLowerCase());
      });
    if (!hit) continue;
    nameProbeHits.push({ name: entry.name, classPtr: entry.classPtr });
    if (nameProbeHits.length >= CATALOG_DUMP_MAX_NAME_PROBE) break;
  }
  log(
    `[catalog-dump] name-probe hits: ${nameProbeHits.length}` +
      (nameProbeHits.length >= CATALOG_DUMP_MAX_NAME_PROBE
        ? ` (capped at ${CATALOG_DUMP_MAX_NAME_PROBE})`
        : ""),
  );
  // Output in compact form: up to 8 names per line to keep log short.
  for (let i = 0; i < nameProbeHits.length; i += 8) {
    const chunk = nameProbeHits.slice(i, i + 8);
    log(`[catalog-dump]   ${chunk.map((h) => h.name).join(" | ")}`);
  }

  // Pass 1: collect ItemSO candidate classes.
  const itemSOCandidates: Array<{
    entry: ClassEntry;
    fields: Map<string, number>;
    idField: string | null;
    nameField: string | null;
    gradeField: string | null;
  }> = [];
  for (const entry of entries) {
    const fields = ctx.classFields(entry.classPtr);
    if (!isItemSOCandidate(entry.name, fields)) continue;
    itemSOCandidates.push({
      entry,
      fields: fields!,
      idField: fieldHintMatch(fields!, ID_FIELD_HINTS),
      nameField: fieldHintMatch(fields!, NAME_FIELD_HINTS),
      gradeField: fieldHintMatch(fields!, GRADE_FIELD_HINTS),
    });
    if (itemSOCandidates.length >= CATALOG_DUMP_MAX_CLASSES) break;
  }

  log(
    `[catalog-dump] ItemSO candidates: ${itemSOCandidates.length}` +
      (itemSOCandidates.length >= CATALOG_DUMP_MAX_CLASSES
        ? ` (capped at ${CATALOG_DUMP_MAX_CLASSES})`
        : ""),
  );

  for (const c of itemSOCandidates) {
    const fieldSummary = Array.from(c.fields.entries())
      .slice(0, 20)
      .map(([n, o]) => `${n}=0x${o.toString(16)}`)
      .join(",");
    log(
      `[catalog-dump]   ItemSO? name="${c.entry.name}" classPtr=0x${c.entry.classPtr.toString(16)}` +
        ` idField=${c.idField ?? "—"} nameField=${c.nameField ?? "—"} gradeField=${c.gradeField ?? "—"}` +
        ` fields=[${fieldSummary}${c.fields.size > 20 ? ",…" : ""}]`,
    );
  }

  // Early exit: Pass 2/3 need at least one ItemSO candidate to look for.
  if (itemSOCandidates.length === 0) {
    log(`[catalog-dump] no ItemSO candidates — skipping ItemManager scan`);
    log(`[catalog-dump] end`);
    return;
  }

  // Pass 2: find ItemManager containers. Pre-filter host classes by name hint
  // (ItemManager / ItemDatabase etc.) — scanning all 10k+ entries against
  // every ItemSO candidate is O(N*M*K) memory reads and would take minutes.
  const itemSOClassPtrs = new Set(itemSOCandidates.map((c) => c.entry.classPtr));
  const itemSOClassPtrByName = new Map<string, bigint>();
  for (const c of itemSOCandidates) {
    if (c.entry.name) itemSOClassPtrByName.set(c.entry.name, c.entry.classPtr);
  }
  const managerHosts = entries.filter(
    (e) =>
      e.name != null && CATALOG_MANAGER_NAME_HINTS.some((h) => e.name!.toLowerCase().includes(h)),
  );
  log(
    `[catalog-dump] ItemManager scan: ${managerHosts.length} host candidates (name hints: ${CATALOG_MANAGER_NAME_HINTS.join("/")})`,
  );

  let containerCount = 0;
  let samplePtr: bigint | null = null;
  let sampleItemSOClassPtr: bigint | null = null;
  for (const entry of managerHosts) {
    if (containerCount >= CATALOG_DUMP_MAX_CONTAINERS) break;
    const slots = ctx.staticSlots(entry.classPtr).slice(0, CATALOG_DUMP_MAX_SLOTS_PER_HOST);
    for (const { soff, value: inst } of slots) {
      if (containerCount >= CATALOG_DUMP_MAX_CONTAINERS) break;
      for (let foff = 0x10; foff <= CATALOG_DUMP_MAX_FIELD_SCAN; foff += 8) {
        const fieldPtr = readPtr(ctx.reader, inst + BigInt(foff));
        if (fieldPtr == null || !isPlausibleHeapPtr(fieldPtr)) continue;
        for (const itemClassPtr of itemSOClassPtrs) {
          const probe = probeContainerOf(ctx, fieldPtr, itemClassPtr);
          if (probe != null) {
            const elemName = ctx.className(itemClassPtr) ?? "??";
            log(
              `[catalog-dump]   ItemManager? host="${entry.name}" static+0x${soff.toString(16)}→inst=0x${inst.toString(16)}` +
                ` field+0x${foff.toString(16)}→${probe.kind}<${elemName}> count=${probe.count} firstElem=0x${probe.firstElementPtr.toString(16)}`,
            );
            if (samplePtr == null) {
              samplePtr = probe.firstElementPtr;
              sampleItemSOClassPtr = itemClassPtr;
            }
            containerCount++;
            break; // next static slot
          }
        }
      }
    }
  }

  log(
    `[catalog-dump] ItemManager candidates: ${containerCount}` +
      (containerCount >= CATALOG_DUMP_MAX_CONTAINERS
        ? ` (capped at ${CATALOG_DUMP_MAX_CONTAINERS})`
        : ""),
  );

  // Pass 3: dump one sample ItemSO instance's field values. This is the most
  // useful line — it tells us whether id/name/grade are plain ints or
  // String*/GradeSO* references, which determines how the real extractor reads
  // them.
  if (samplePtr != null && sampleItemSOClassPtr != null) {
    const sampleCandidate = itemSOCandidates.find((c) => c.entry.classPtr === sampleItemSOClassPtr);
    if (sampleCandidate != null) {
      const fields = sampleCandidate.fields;
      const samples: string[] = [];
      for (const [fname, foff] of fields.entries()) {
        if (samples.length >= 12) break;
        const rawPtr = readPtr(ctx.reader, samplePtr + BigInt(foff));
        const i32 = readI32(ctx.reader, samplePtr + BigInt(foff));
        let desc: string;
        if (rawPtr != null && isPlausibleHeapPtr(rawPtr)) {
          const klass = ctx.instanceClassName(rawPtr);
          if (klass != null && klass.toLowerCase().includes("string")) {
            const s = readIl2CppString(ctx.reader, rawPtr);
            desc = `str="${s == null ? "null" : s.length > 40 ? s.slice(0, 40) + "…" : s}"`;
          } else if (klass != null && klass.toLowerCase().includes("grade")) {
            desc = `GradeSO*(${klass})`;
          } else {
            desc = `ptr→${klass ?? "??"}(0x${rawPtr.toString(16)})`;
          }
        } else if (i32 != null) {
          desc = `i32=${i32}${isPlausibleItemKey(i32) ? "[ik]" : ""}${isPlausibleGrade(i32) ? "[gr]" : ""}`;
        } else {
          desc = `?`;
        }
        samples.push(`${fname}@0x${foff.toString(16)}=${desc}`);
      }
      log(
        `[catalog-dump] sample ItemSO instance at 0x${samplePtr.toString(16)} (class="${sampleCandidate.entry.name}"): ${samples.join(" | ")}`,
      );
    }
  }

  log(`[catalog-dump] end`);
}

// ── Save-list holder diagnostic dump ─────────────────────────────────────────

const SAVE_LIST_DUMP_MAX_LISTS = 200;
const SAVE_LIST_DUMP_MAX_NAME_PROBE = 200;
const SAVE_LIST_DUMP_RECURSE_MAX = 0x80; // sub-object field scan depth (per level)
const SAVE_LIST_DUMP_RECURSE_DEPTH = 3; // Pass C+D recurse depth (levels)

/**
 * Class-name hints for the save-list holder name probe (Pass A) and the
 * recurse target filter (Pass C). Ordered loosely by likelihood.
 */
const SAVE_LIST_NAME_HINTS = [
  "Save",
  "Player",
  "Pet",
  "Item",
  "Box",
  "Inventory",
  "Holder",
  "DataManager",
  "Container",
  "Repository",
];

/**
 * Diagnostic dump: locate where `List<PetSaveData>` / `List<ItemSaveData>`
 * (or their renamed/obfuscated variants) actually live at runtime. Triggered
 * by `TBH_DUMP_SAVE_LIST_HOLDERS=1` when `findPlayerSaveData` returns null
 * (v1.01.02 symptom: `extract: player save-data anchor not derived`).
 *
 * Three passes, all bounded for performance:
 *
 *  - **Pass A — name probe**: print class names containing save-data hints
 *    (Save/Player/Pet/Item/Box/Inventory/Holder/DataManager/Container/
 *    Repository). Cheap string match, reveals the renamed holder class.
 *
 *  - **Pass B — static-reachable List<*>**: for every class entry's static
 *    slots, scan instance fields 0x10..INSTANCE_SCAN_MAX for List-shaped
 *    pointers (ptr → +0x10 _items array, +0x18 _size). For each List, read
 *    the first element's class name and dump it. This catches the case where
 *    the holder is static-reachable but its field name is obfuscated AND the
 *    element class name is also obfuscated (e.g. `vb.PetSaveData` → `csd.XY`).
 *    Capped at SAVE_LIST_DUMP_MAX_LISTS.
 *
 *  - **Pass C — CommonSaveData sub-object recurse**: for the first
 *    name-matched holder class (CommonSaveData/PlayerSaveData/...) with a
 *    static-reachable instance, recurse ONE level into its pointer fields and
 *    scan each sub-object for List<*> shapes. This catches the v1.01.02 case
 *    where CommonSaveData no longer holds save lists directly but references
 *    a sub-object (e.g. `CommonSaveData.saveHolder → SaveHolder.petSaveDatas`).
 *    Only the first matching holder class is recursed (keeps the dump small).
 *
 * The dump reuses the already-built ScanContext + entries, so it adds no
 * extra memory scanning — only field-table lookups and a bounded instance
 * field walk.
 */
export function dumpSaveListHolders(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
  log: (line: string) => void,
): void {
  log(`[save-list-dump] scanning ${entries.length} class entries for save-list holders`);

  // Build classPtr → name lookup for Pass C's subClassLabel fallback.
  // When instanceClassName returns null (class name field unreadable), we
  // cross-reference the class pointer against this map to recover the name.
  const classPtrToName = new Map<bigint, string>();
  for (const entry of entries) {
    if (entry.name) classPtrToName.set(entry.classPtr, entry.name);
  }

  // ── Pass A: name probe ─────────────────────────────────────────────────
  const nameProbeHits: Array<{ name: string; classPtr: bigint }> = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    const lower = entry.name.toLowerCase();
    if (SAVE_LIST_NAME_HINTS.some((h) => lower.includes(h.toLowerCase()))) {
      nameProbeHits.push({ name: entry.name, classPtr: entry.classPtr });
      if (nameProbeHits.length >= SAVE_LIST_DUMP_MAX_NAME_PROBE) break;
    }
  }
  log(
    `[save-list-dump] Pass A — name-probe hits: ${nameProbeHits.length}` +
      (nameProbeHits.length >= SAVE_LIST_DUMP_MAX_NAME_PROBE
        ? ` (capped at ${SAVE_LIST_DUMP_MAX_NAME_PROBE})`
        : ""),
  );
  for (let i = 0; i < nameProbeHits.length; i += 8) {
    const chunk = nameProbeHits.slice(i, i + 8);
    log(`[save-list-dump]   ${chunk.map((h) => h.name).join(" | ")}`);
  }

  // ── Pass B: static-reachable List<*> ───────────────────────────────────
  let listCount = 0;
  for (const entry of entries) {
    if (listCount >= SAVE_LIST_DUMP_MAX_LISTS) break;
    const slots = ctx.staticSlots(entry.classPtr);
    for (const { value: obj } of slots) {
      if (listCount >= SAVE_LIST_DUMP_MAX_LISTS) break;
      for (let foff = 0x10; foff <= INSTANCE_SCAN_MAX; foff += 8) {
        if (listCount >= SAVE_LIST_DUMP_MAX_LISTS) break;
        const found = scanListAt(ctx, obj, foff);
        if (found == null) continue;
        log(
          `[save-list-dump] Pass B — holder="${entry.name}" inst=0x${obj.toString(16)} ` +
            `+0x${foff.toString(16)} → List<element="${found.elemClass ?? "null"}" count=${found.count}>` +
            (found.elemClass == null ? ` raw=${found.rawItemsHex}` : ""),
        );
        listCount++;
      }
    }
  }
  log(
    `[save-list-dump] Pass B — dumped ${listCount} static-reachable List fields` +
      (listCount >= SAVE_LIST_DUMP_MAX_LISTS ? ` (capped at ${SAVE_LIST_DUMP_MAX_LISTS})` : ""),
  );

  // ── Pass C: CommonSaveData sub-object recurse (one level) ──────────────
  // Find the first name-matched holder class that has a static-reachable
  // instance, then walk its pointer fields one level deep and scan each
  // sub-object for List<*> shapes. This catches the v1.01.02 case where
  // CommonSaveData references a sub-object that holds the save lists.
  //
  // Instance resolution tries two paths:
  //   1. `ctx.staticSlots(classPtr)` — the standard Il2CppClass.static_fields
  //      block (at +0xb0/+0xb8/+0xa8). Works for most versions.
  //   2. Header-block scan fallback — when static_fields is null (v1.01.02
  //      CommonSaveData: `+0xb0 = 0`), scan the class header's ptr-like
  //      values (0x00..0xC0) as potential block pointers, and for each block
  //      scan 0x00..0x400 for an instance whose header matches classPtr or
  //      a subclass. This mirrors `probeClassLayout` in liveReader.ts and
  //      finds instances stored in non-standard header offsets.
  const findHolderInstance = (classPtr: bigint): bigint | null => {
    const slots = ctx.staticSlots(classPtr);
    if (slots.length > 0) return slots[0].value;
    // Fallback: header-block scan (probeClassLayout-style).
    return findInstanceViaHeaderScan(ctx, classPtr);
  };

  let recurseHolder: { name: string; classPtr: bigint; inst: bigint } | null = null;
  for (const entry of entries) {
    if (!entry.name) continue;
    const lower = entry.name.toLowerCase();
    // Prefer CommonSaveData / PlayerSaveData; fall back to any name hit.
    const isPreferred =
      lower === "commonsavedata" ||
      lower === "playersavedata" ||
      lower.endsWith(".commonsavedata") ||
      lower.endsWith(".playersavedata");
    if (!isPreferred) continue;
    const inst = findHolderInstance(entry.classPtr);
    if (inst == null) continue;
    recurseHolder = { name: entry.name, classPtr: entry.classPtr, inst };
    break;
  }
  // Fallback: if no CommonSaveData/PlayerSaveData by exact short name, use
  // the first name-probe hit that has a static-reachable instance.
  if (recurseHolder == null) {
    for (const hit of nameProbeHits) {
      const inst = findHolderInstance(hit.classPtr);
      if (inst == null) continue;
      recurseHolder = { name: hit.name, classPtr: hit.classPtr, inst };
      break;
    }
  }

  if (recurseHolder == null) {
    log(
      `[save-list-dump] Pass C — no name-matched holder class with a static-reachable instance; skipping recurse`,
    );
    log(`[save-list-dump] end`);
    return;
  }

  log(
    `[save-list-dump] Pass C — recursing into "${recurseHolder.name}" inst=0x${recurseHolder.inst.toString(16)} sub-objects (depth ${SAVE_LIST_DUMP_RECURSE_DEPTH}, per-level scan ${SAVE_LIST_DUMP_RECURSE_MAX.toString(16)})`,
  );
  const visited = new Set<bigint>();
  visited.add(recurseHolder.inst);
  const passCPath: string[] = [`"${recurseHolder.name}"`];
  const recurseCount = recurseForSaveLists(
    ctx,
    classPtrToName,
    recurseHolder.inst,
    passCPath,
    0,
    visited,
    SAVE_LIST_DUMP_MAX_LISTS,
    log,
  );
  log(
    `[save-list-dump] Pass C — dumped ${recurseCount} List fields in sub-objects of "${recurseHolder.name}" (recursed ${SAVE_LIST_DUMP_RECURSE_DEPTH} levels)` +
      (recurseCount >= SAVE_LIST_DUMP_MAX_LISTS ? ` (capped at ${SAVE_LIST_DUMP_MAX_LISTS})` : ""),
  );

  // ── Pass E: CommonSaveData reference graph ─────────────────────────────
  // Dump every pointer field (0x10..0x400) of the holder instance + its
  // immediate sub-objects, showing the sub-object's class name. This gives
  // a complete view of where save data could be nested, even when no
  // List<*> shape is detected (e.g. Dictionary, custom container, or
  // struct-array storage).
  log(
    `[save-list-dump] Pass E — reference graph from "${recurseHolder.name}" inst=0x${recurseHolder.inst.toString(16)} (one level, scan 0x10..0x400)`,
  );
  const refGraphVisited = new Set<bigint>();
  refGraphVisited.add(recurseHolder.inst);
  let refCount = 0;
  for (let foff = 0x10; foff <= 0x400; foff += 8) {
    const subPtr = readPtr(ctx.reader, recurseHolder.inst + BigInt(foff));
    if (subPtr == null || !isPlausibleHeapPtr(subPtr)) continue;
    if (refGraphVisited.has(subPtr)) continue;
    refGraphVisited.add(subPtr);
    const subClass = ctx.instanceClassName(subPtr);
    const subClassPtr = readPtr(ctx.reader, subPtr);
    const subClassLabel =
      subClass != null
        ? subClass
        : (classPtrToName.get(subClassPtr ?? 0n) ?? `class@0x${(subClassPtr ?? 0n).toString(16)}`);
    // Also show the sub-object's own pointer fields' class names (one level)
    const childFields: string[] = [];
    for (let cfoff = 0x10; cfoff <= 0x80; cfoff += 8) {
      const childPtr = readPtr(ctx.reader, subPtr + BigInt(cfoff));
      if (childPtr == null || !isPlausibleHeapPtr(childPtr)) continue;
      if (refGraphVisited.has(childPtr)) {
        childFields.push(`+0x${cfoff.toString(16)}→(visited)`);
        continue;
      }
      refGraphVisited.add(childPtr);
      const childClass = ctx.instanceClassName(childPtr);
      const childClassPtr = readPtr(ctx.reader, childPtr);
      const childLabel =
        childClass != null
          ? childClass
          : (classPtrToName.get(childClassPtr ?? 0n) ??
            `class@0x${(childClassPtr ?? 0n).toString(16)}`);
      childFields.push(`+0x${cfoff.toString(16)}→${childLabel}`);
    }
    log(
      `[save-list-dump] Pass E — "${recurseHolder.name}"+0x${foff.toString(16)}→${subClassLabel}(0x${subPtr.toString(16)})` +
        (childFields.length > 0 ? ` children=[${childFields.join(", ")}]` : ""),
    );
    refCount++;
  }
  log(
    `[save-list-dump] Pass E — dumped ${refCount} direct references from "${recurseHolder.name}"`,
  );

  // ── Pass F: Dump field tables for key candidate classes ──────────────
  // For each direct sub-object of the holder, dump its class's field name
  // table (offset → name). This reveals what the sub-object actually is
  // (e.g. PlayerSaveData, ItemSaveData holder, BoxData holder) even when
  // no List<*> shape is found.
  log(
    `[save-list-dump] Pass F — dumping field tables for direct sub-objects of "${recurseHolder.name}"`,
  );
  const passFVisited = new Set<bigint>();
  passFVisited.add(recurseHolder.inst);
  let fieldTableCount = 0;
  for (let foff = 0x10; foff <= 0x400; foff += 8) {
    const subPtr = readPtr(ctx.reader, recurseHolder.inst + BigInt(foff));
    if (subPtr == null || !isPlausibleHeapPtr(subPtr)) continue;
    if (passFVisited.has(subPtr)) continue;
    passFVisited.add(subPtr);
    const fields = ctx.instanceClassFields(subPtr);
    const subClass = ctx.instanceClassName(subPtr);
    const subClassPtr = readPtr(ctx.reader, subPtr);
    const subClassLabel =
      subClass != null
        ? subClass
        : (classPtrToName.get(subClassPtr ?? 0n) ?? `class@0x${(subClassPtr ?? 0n).toString(16)}`);
    if (fields != null && fields.size > 0) {
      const fieldList = Array.from(fields.entries())
        .map(([name, off]) => `${name}=0x${off.toString(16)}`)
        .join(", ");
      log(
        `[save-list-dump] Pass F — "${recurseHolder.name}"+0x${foff.toString(16)}→${subClassLabel}(0x${subPtr.toString(16)}) fields(${fields.size}): ${fieldList}`,
      );
      fieldTableCount++;
    } else {
      // instanceClassFields failed — try probeClassFieldsLayout as fallback.
      // This probes class+0x68..0xb0 for plausible field-info pointers and
      // dumps the raw bytes, letting us identify fields even when the standard
      // +0x80/+0x88 layout doesn't match.
      const probe = ctx.probeClassFieldsLayout(subPtr);
      if (probe != null) {
        log(
          `[save-list-dump] Pass F — "${recurseHolder.name}"+0x${foff.toString(16)}→${subClassLabel}(0x${subPtr.toString(16)}) fields=probe: ${probe}`,
        );
        fieldTableCount++;
      }
    }
  }
  log(`[save-list-dump] Pass F — dumped ${fieldTableCount} field tables`);

  // ── Pass G: Dump the shared container class field table + element raw bytes
  // Pass C found Lists with `class@0x1fc20282468` as the holder's +0x20 field
  // (this class appears in multiple sub-objects). Dump its field table so we
  // can identify what container type it is (e.g. SerializableList<T>,
  // SavedList<T>, etc.). Also dump the first List element's full 64 bytes
  // (not just qwords) to identify the element struct layout.
  const SHARED_CONTAINER_CLASS = 0x1fc20282468n;
  const sharedFields = ctx.classFields(SHARED_CONTAINER_CLASS);
  if (sharedFields != null && sharedFields.size > 0) {
    const fieldList = Array.from(sharedFields.entries())
      .map(([name, off]) => `${name}=0x${off.toString(16)}`)
      .join(", ");
    log(
      `[save-list-dump] Pass G — shared container class@0x${SHARED_CONTAINER_CLASS.toString(16)} fields(${sharedFields.size}): ${fieldList}`,
    );
  } else {
    log(
      `[save-list-dump] Pass G — shared container class@0x${SHARED_CONTAINER_CLASS.toString(16)} has no readable field table`,
    );
  }

  // Dump first List element's raw bytes (64 bytes continuous) from the first
  // List found in Pass C. Re-find it by scanning the holder's sub-objects
  // recursively (up to 3 levels, matching Pass C).
  // Also dump the List object itself + the _items array header, so we can
  // verify the IL2CPP List<T> layout (which may differ in v1.01.02).
  const passGVisited = new Set<bigint>();
  passGVisited.add(recurseHolder.inst);
  const findAndDumpList = (obj: bigint, path: string[], depth: number): boolean => {
    if (depth >= SAVE_LIST_DUMP_RECURSE_DEPTH) return false;
    for (let foff = 0x10; foff <= SAVE_LIST_DUMP_RECURSE_MAX; foff += 8) {
      const subPtr = readPtr(ctx.reader, obj + BigInt(foff));
      if (subPtr == null || !isPlausibleHeapPtr(subPtr)) continue;
      if (passGVisited.has(subPtr)) continue;
      passGVisited.add(subPtr);
      for (let sfoff = 0x10; sfoff <= INSTANCE_SCAN_MAX; sfoff += 8) {
        const listPtr = readPtr(ctx.reader, subPtr + BigInt(sfoff));
        if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
        const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
        if (arr == null || !isPlausibleHeapPtr(arr)) continue;
        const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
        if (count == null || count <= 0 || count > MAX_SAVE_LIST) continue;
        // Dump List object + _items array header + first element.
        const listBuf = ctx.reader.readBytes(listPtr, 64);
        const arrBuf = ctx.reader.readBytes(arr, 64);
        const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);
        const elemBuf = ctx.reader.readBytes(first, 64);
        const dumpQwords = (buf: Buffer | null, label: string): string => {
          if (buf == null || buf.length < 64) return `${label}=<unreadable>`;
          const qwords: string[] = [];
          for (let i = 0; i < 8; i++) {
            qwords.push(`+0x${(i * 8).toString(16)}=0x${buf.readBigUInt64LE(i * 8).toString(16)}`);
          }
          return `${label}=${qwords.join(" ")}`;
        };
        log(
          `[save-list-dump] Pass G — List at ${path.join("")}+0x${foff.toString(16)}+0x${sfoff.toString(16)} (listPtr=0x${listPtr.toString(16)}, arr=0x${arr.toString(16)}, count=${count}):`,
        );
        log(`[save-list-dump] Pass G   ${dumpQwords(listBuf, "listObj")}`);
        log(`[save-list-dump] Pass G   ${dumpQwords(arrBuf, "arrHdr  ")}`);
        log(`[save-list-dump] Pass G   ${dumpQwords(elemBuf, "elem0  ")}`);
        // Dump arrHdr+0x10 and arrHdr+0x18 as IL2CPP strings — these may be
        // ES3List's key strings (e.g. "keys", "values") that identify the
        // container type.
        for (const keyOff of [0x10, 0x18]) {
          const keyPtr = readPtr(ctx.reader, arr + BigInt(keyOff));
          if (keyPtr == null || !isPlausibleHeapPtr(keyPtr)) continue;
          const keyStr = readIl2CppString(ctx.reader, keyPtr);
          if (keyStr != null) {
            log(`[save-list-dump] Pass G   arrHdr+0x${keyOff.toString(16)} → String "${keyStr}"`);
          } else {
            // Not a System.String — try inline null-terminated ASCII. ES3
            // keys are sometimes stored as raw char arrays rather than
            // managed String objects (v1.01.02 confirmed case).
            const inlineAscii = readCString(ctx.reader, keyPtr, 128);
            if (inlineAscii != null) {
              log(
                `[save-list-dump] Pass G   arrHdr+0x${keyOff.toString(16)} → ASCII "${inlineAscii}"`,
              );
            } else {
              // Not a string — dump as object
              const keyClass = ctx.instanceClassName(keyPtr);
              const keyClassLabel =
                keyClass != null
                  ? keyClass
                  : (classPtrToName.get(readPtr(ctx.reader, keyPtr) ?? 0n) ??
                    `class@0x${(readPtr(ctx.reader, keyPtr) ?? 0n).toString(16)}`);
              log(
                `[save-list-dump] Pass G   arrHdr+0x${keyOff.toString(16)} → ${keyClassLabel}(0x${keyPtr.toString(16)})`,
              );
            }
          }
        }
        // Also dump the first element OBJECT (what arrHdr+0x20 points to).
        // This is the actual save-data element (HeroSaveData/PetSaveData/etc).
        const elemObjPtr = readPtr(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
        if (elemObjPtr != null && isPlausibleHeapPtr(elemObjPtr)) {
          const elemClass = ctx.instanceClassName(elemObjPtr);
          const elemFields = ctx.instanceClassFields(elemObjPtr);
          const elemClassLabel =
            elemClass != null
              ? elemClass
              : (classPtrToName.get(readPtr(ctx.reader, elemObjPtr) ?? 0n) ??
                `class@0x${(readPtr(ctx.reader, elemObjPtr) ?? 0n).toString(16)}`);
          const fieldList =
            elemFields != null && elemFields.size > 0
              ? Array.from(elemFields.entries())
                  .map(([name, off]) => `${name}=0x${off.toString(16)}`)
                  .join(", ")
              : "<no readable fields>";
          log(
            `[save-list-dump] Pass G   elemObj =0x${elemObjPtr.toString(16)} klass=${elemClassLabel} fields(${elemFields?.size ?? 0}): ${fieldList}`,
          );
          // Dump elemObj raw 256 bytes — when klass pointer is implausible
          // (fields=0), the "elemObj" may be an inline ES3 struct / byte
          // stream rather than a managed object. Raw bytes let us inspect
          // the layout and locate BoxTypes/BoxQuantity inline.
          const elemObjBuf = ctx.reader.readBytes(elemObjPtr, 256);
          if (elemObjBuf != null && elemObjBuf.length >= 256) {
            for (let i = 0; i < 256; i += 64) {
              const qwords: string[] = [];
              for (let j = 0; j < 64; j += 8) {
                qwords.push(
                  `+0x${(i + j).toString(16).padStart(2, "0")}=0x${elemObjBuf.readBigUInt64LE(i + j).toString(16)}`,
                );
              }
              log(`[save-list-dump] Pass G   elemObjRaw+0x${i.toString(16)} ${qwords.join(" ")}`);
            }
            // Try inline ASCII (ES3 value may be a string blob)
            const asciiAttempt = readCString(ctx.reader, elemObjPtr, 128);
            if (asciiAttempt != null) {
              log(`[save-list-dump] Pass G   elemObjAscii = "${asciiAttempt}"`);
            }
          }
          // Dump elem0+0x38 target — elem0's 0x38 field points to another
          // object (possibly the value payload or a type descriptor).
          if (elemBuf != null && elemBuf.length >= 0x40) {
            const elem38Ptr = elemBuf.readBigUInt64LE(0x38);
            if (elem38Ptr !== 0n && isPlausibleHeapPtr(elem38Ptr)) {
              const t38Buf = ctx.reader.readBytes(elem38Ptr, 128);
              log(`[save-list-dump] Pass G   elem0+0x38 → 0x${elem38Ptr.toString(16)}:`);
              if (t38Buf != null && t38Buf.length >= 128) {
                for (let i = 0; i < 128; i += 64) {
                  const qwords: string[] = [];
                  for (let j = 0; j < 64; j += 8) {
                    qwords.push(
                      `+0x${(i + j).toString(16).padStart(2, "0")}=0x${t38Buf.readBigUInt64LE(i + j).toString(16)}`,
                    );
                  }
                  log(`[save-list-dump] Pass G   target38+0x${i.toString(16)} ${qwords.join(" ")}`);
                }
                const t38Class = ctx.instanceClassName(elem38Ptr);
                const t38Fields = ctx.instanceClassFields(elem38Ptr);
                const t38ClassLabel =
                  t38Class != null
                    ? t38Class
                    : (classPtrToName.get(readPtr(ctx.reader, elem38Ptr) ?? 0n) ??
                      `class@0x${(readPtr(ctx.reader, elem38Ptr) ?? 0n).toString(16)}`);
                const t38FieldList =
                  t38Fields != null && t38Fields.size > 0
                    ? Array.from(t38Fields.entries())
                        .map(([n, o]) => `${n}=0x${o.toString(16)}`)
                        .join(", ")
                    : "<no readable fields>";
                log(
                  `[save-list-dump] Pass G   target38 klass=${t38ClassLabel} fields(${t38Fields?.size ?? 0}): ${t38FieldList}`,
                );
                const t38Ascii = readCString(ctx.reader, elem38Ptr, 128);
                if (t38Ascii != null) {
                  log(`[save-list-dump] Pass G   target38Ascii = "${t38Ascii}"`);
                }
                // Probe target38+0x10 / +0x18 / +0x20 — these may be ES3
                // key/value string pointers or List/array pointers. The
                // 0x1fd16c... address range matches the "CommonSaveData"
                // string pointer seen in arrHdr+0x10, so they likely point
                // to inline ASCII or System.String objects.
                for (const subOff of [0x10, 0x18, 0x20]) {
                  const subPtr = readPtr(ctx.reader, elem38Ptr + BigInt(subOff));
                  if (subPtr == null || !isPlausibleHeapPtr(subPtr)) continue;
                  const subStr = readIl2CppString(ctx.reader, subPtr);
                  if (subStr != null) {
                    log(
                      `[save-list-dump] Pass G   target38+0x${subOff.toString(16)} → String "${subStr}"`,
                    );
                    continue;
                  }
                  const subAscii = readCString(ctx.reader, subPtr, 128);
                  if (subAscii != null) {
                    log(
                      `[save-list-dump] Pass G   target38+0x${subOff.toString(16)} → ASCII "${subAscii}"`,
                    );
                    continue;
                  }
                  // Try as List<T>: read +0x10 (items) and +0x18 (size)
                  const subArr = readPtr(ctx.reader, subPtr + BigInt(STRUCT_CONTAINER.listItems));
                  const subCount = readI32(ctx.reader, subPtr + BigInt(STRUCT_CONTAINER.listSize));
                  if (
                    subArr != null &&
                    isPlausibleHeapPtr(subArr) &&
                    subCount != null &&
                    subCount > 0 &&
                    subCount < 1000
                  ) {
                    log(
                      `[save-list-dump] Pass G   target38+0x${subOff.toString(16)} → List(count=${subCount}, arr=0x${subArr.toString(16)})`,
                    );
                    // Dump first 3 elements as ASCII/string (keys) and raw bytes
                    const elemSize = 8; // pointer array
                    for (let ei = 0; ei < Math.min(subCount, 3); ei++) {
                      const ePtr = readPtr(
                        ctx.reader,
                        subArr + BigInt(STRUCT_CONTAINER.arrayFirst + ei * elemSize),
                      );
                      if (ePtr == null || !isPlausibleHeapPtr(ePtr)) continue;
                      const eStr = readIl2CppString(ctx.reader, ePtr);
                      const eAscii = readCString(ctx.reader, ePtr, 64);
                      log(
                        `[save-list-dump] Pass G     elem[${ei}]=0x${ePtr.toString(16)} str="${eStr ?? ""}" ascii="${eAscii ?? ""}"`,
                      );
                    }
                    continue;
                  }
                  // Fallback: dump raw 64 bytes
                  const subBuf = ctx.reader.readBytes(subPtr, 64);
                  if (subBuf != null && subBuf.length >= 64) {
                    const qwords: string[] = [];
                    for (let i = 0; i < 8; i++) {
                      qwords.push(
                        `+0x${(i * 8).toString(16)}=0x${subBuf.readBigUInt64LE(i * 8).toString(16)}`,
                      );
                    }
                    log(
                      `[save-list-dump] Pass G   target38+0x${subOff.toString(16)} → raw@0x${subPtr.toString(16)}: ${qwords.join(" ")}`,
                    );
                  }
                }
              }
            }
          }
        }
        return true;
      }
      // Recurse one level deeper
      const subPath = path.concat([`+0x${foff.toString(16)}`]);
      if (findAndDumpList(subPtr, subPath, depth + 1)) return true;
    }
    return false;
  };
  const passGDumped = findAndDumpList(recurseHolder.inst, [`"${recurseHolder.name}"`], 0);
  if (!passGDumped) {
    log(`[save-list-dump] Pass G — no List element found to dump`);
  }

  // ── Pass H: Structural BoxData candidate scan ────────────────────────────
  // v1.01.02 hypothesis: if the game deserialized CommonSaveData via
  // ES3.Load<CommonSaveData>(), the resulting object graph should be somewhere
  // in managed heap — a BoxData instance with two List<int> fields of equal
  // length (BoxTypes + BoxQuantity). Pass H scans ALL class entries' static
  // field blocks and recurses 2 levels into instance fields, looking for this
  // "twin List<int> equal-count" structural signature. No field-name matching
  // — pure shape detection. If Pass H finds candidates, v1.01.02 live
  // boxData is recoverable via structural anchor; if not, the game likely
  // uses ES3 streaming (field-level lazy read) and live boxData stays on the
  // save-file fallback path.
  const PASS_H_MAX_VISITED = 5000;
  const PASS_H_MAX_CANDIDATES = 10;
  const PASS_H_MAX_DEPTH = 2;
  const PASS_H_MAX_LIST_COUNT = 100; // BoxTypes/BoxQuantity plausible upper bound
  const passHVisited = new Set<bigint>();
  const boxDataCandidates: Array<{
    obj: bigint;
    klass: bigint;
    klassName: string | null;
    list1Off: number;
    list2Off: number;
    count: number;
    firstElem1: number | null;
    firstElem2: number | null;
  }> = [];

  const scanForBoxData = (obj: bigint, depth: number): void => {
    if (boxDataCandidates.length >= PASS_H_MAX_CANDIDATES) return;
    if (passHVisited.size >= PASS_H_MAX_VISITED) return;
    if (passHVisited.has(obj)) return;
    passHVisited.add(obj);

    // Collect all List<int>-shaped fields on this object
    const intLists: Array<{ off: number; count: number; firstElem: number | null }> = [];
    for (let foff = 0x10; foff <= INSTANCE_SCAN_MAX; foff += 8) {
      const listPtr = readPtr(ctx.reader, obj + BigInt(foff));
      if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
      const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
      if (arr == null || !isPlausibleHeapPtr(arr)) continue;
      const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
      if (count == null || count <= 0 || count > PASS_H_MAX_LIST_COUNT) continue;
      // Validate int[]: read first element, must be plausible BoxType int
      const firstElem = readI32(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
      if (firstElem == null) continue;
      intLists.push({ off: foff, count, firstElem });
    }

    // BoxData signature: two List<int> with equal count
    if (intLists.length >= 2) {
      for (let i = 0; i < intLists.length; i++) {
        for (let j = i + 1; j < intLists.length; j++) {
          if (intLists[i].count === intLists[j].count) {
            const klass = readPtr(ctx.reader, obj);
            boxDataCandidates.push({
              obj,
              klass: klass ?? 0n,
              klassName: klass != null ? ctx.className(klass) : null,
              list1Off: intLists[i].off,
              list2Off: intLists[j].off,
              count: intLists[i].count,
              firstElem1: intLists[i].firstElem,
              firstElem2: intLists[j].firstElem,
            });
            if (boxDataCandidates.length >= PASS_H_MAX_CANDIDATES) return;
          }
        }
      }
    }

    // Recurse into instance pointer fields
    if (depth >= PASS_H_MAX_DEPTH) return;
    for (let foff = 0x10; foff <= INSTANCE_SCAN_MAX; foff += 8) {
      if (boxDataCandidates.length >= PASS_H_MAX_CANDIDATES) return;
      const subPtr = readPtr(ctx.reader, obj + BigInt(foff));
      if (subPtr == null || !isPlausibleHeapPtr(subPtr)) continue;
      scanForBoxData(subPtr, depth + 1);
    }
  };

  for (const entry of entries) {
    if (boxDataCandidates.length >= PASS_H_MAX_CANDIDATES) break;
    if (passHVisited.size >= PASS_H_MAX_VISITED) break;
    const slots = ctx.staticSlots(entry.classPtr);
    for (const { value: obj } of slots) {
      if (boxDataCandidates.length >= PASS_H_MAX_CANDIDATES) break;
      scanForBoxData(obj, 0);
    }
  }

  log(
    `[save-list-dump] Pass H — scanned ${passHVisited.size} objects (cap ${PASS_H_MAX_VISITED}), found ${boxDataCandidates.length} BoxData candidates (cap ${PASS_H_MAX_CANDIDATES})`,
  );
  for (const c of boxDataCandidates) {
    const fields = c.klass !== 0n ? ctx.classFields(c.klass) : null;
    const fieldList =
      fields != null && fields.size > 0
        ? Array.from(fields.entries())
            .map(([n, o]) => `${n}=0x${o.toString(16)}`)
            .join(", ")
        : "<no readable fields>";
    log(
      `[save-list-dump] Pass H   candidate obj=0x${c.obj.toString(16)} klass="${c.klassName ?? "null"}" count=${c.count} list1Off=0x${c.list1Off.toString(16)} (elem0=${c.firstElem1}) list2Off=0x${c.list2Off.toString(16)} (elem0=${c.firstElem2}) fields(${fields?.size ?? 0}): ${fieldList}`,
    );
    // Dump first 4 elements of each List to verify BoxTypes/BoxQuantity semantics
    const dumpListElems = (off: number, label: string): void => {
      const listPtr = readPtr(ctx.reader, c.obj + BigInt(off));
      if (listPtr == null || !isPlausibleHeapPtr(listPtr)) return;
      const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
      if (arr == null || !isPlausibleHeapPtr(arr)) return;
      const elems: string[] = [];
      for (let i = 0; i < Math.min(c.count, 4); i++) {
        const v = readI32(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst + i * 4));
        if (v == null) break;
        elems.push(String(v));
      }
      log(
        `[save-list-dump] Pass H     ${label}=[${elems.join(", ")}${c.count > 4 ? ", ..." : ""}]`,
      );
    };
    dumpListElems(c.list1Off, "list1");
    dumpListElems(c.list2Off, "list2");
    // Find the parent object that points at this BoxData candidate — that's
    // the CommonSaveData instance (its +N field = boxData offset).
    let parentInfo: string | null = null;
    for (const entry2 of entries) {
      if (parentInfo) break;
      const slots2 = ctx.staticSlots(entry2.classPtr);
      for (const { soff, value: inst } of slots2) {
        if (parentInfo) break;
        for (let foff = 0x10; foff <= INSTANCE_SCAN_MAX; foff += 8) {
          const p = readPtr(ctx.reader, inst + BigInt(foff));
          if (p === c.obj) {
            const parentClass = ctx.instanceClassName(inst);
            const parentFields = ctx.instanceClassFields(inst);
            // Find which field name matches this offset
            const fieldName = parentFields?.entries
              ? Array.from(parentFields.entries()).find(([, o]) => o === foff)?.[0]
              : undefined;
            parentInfo = `parent="${parentClass ?? entry2.name}" static+0x${soff.toString(16)}+0x${foff.toString(16)} (field="${fieldName ?? "?"}")`;
            break;
          }
        }
      }
    }
    log(`[save-list-dump] Pass H     ${parentInfo ?? "parent not found (orphan candidate)"}`);
  }

  log(`[save-list-dump] end`);
}

/**
 * Recursive helper for Pass C: walk `obj`'s pointer fields one level deep,
 * scan each sub-object for List<*> shapes, and recurse into each sub-object
 * up to `maxDepth` levels. `path` tracks the traversal chain for logging.
 * `visited` prevents infinite loops on circular references.
 */
function recurseForSaveLists(
  ctx: ScanContext,
  classPtrToName: Map<bigint, string>,
  obj: bigint,
  path: string[],
  depth: number,
  visited: Set<bigint>,
  maxLists: number,
  log: (line: string) => void,
): number {
  if (depth >= SAVE_LIST_DUMP_RECURSE_DEPTH) return 0;
  let count = 0;
  for (let foff = 0x10; foff <= SAVE_LIST_DUMP_RECURSE_MAX; foff += 8) {
    if (count >= maxLists) break;
    const subPtr = readPtr(ctx.reader, obj + BigInt(foff));
    if (subPtr == null || !isPlausibleHeapPtr(subPtr)) continue;
    if (visited.has(subPtr)) continue;
    visited.add(subPtr);
    const subClass = ctx.instanceClassName(subPtr);
    const subClassPtr = readPtr(ctx.reader, subPtr);
    const subClassLabel =
      subClass != null
        ? subClass
        : (classPtrToName.get(subClassPtr ?? 0n) ?? `class@0x${(subClassPtr ?? 0n).toString(16)}`);
    // Scan sub-object's fields for List<*> shapes
    for (let sfoff = 0x10; sfoff <= INSTANCE_SCAN_MAX; sfoff += 8) {
      if (count >= maxLists) break;
      const found = scanListAt(ctx, subPtr, sfoff);
      if (found == null) continue;
      const pathStr = path.concat([`+0x${foff.toString(16)}→${subClassLabel}`]).join("");
      log(
        `[save-list-dump] Pass C — ${pathStr} +0x${sfoff.toString(16)} → List<element="${found.elemClass ?? "null"}" count=${found.count}>` +
          (found.elemClass == null ? ` raw=${found.rawItemsHex}` : ""),
      );
      count++;
    }
    // Recurse one level deeper
    const subPath = path.concat([`+0x${foff.toString(16)}→${subClassLabel}`]);
    count += recurseForSaveLists(
      ctx,
      classPtrToName,
      subPtr,
      subPath,
      depth + 1,
      visited,
      maxLists - count,
      log,
    );
  }
  return count;
}

/**
 * Header-block scan fallback for finding a class's singleton instance when
 * `staticSlots()` returns empty (static_fields pointer is null). Mirrors
 * `probeClassLayout` in liveReader.ts: scan the class header's ptr-like
 * values (0x00..0xC0) as potential block pointers, and for each block scan
 * 0x00..0x400 for an instance whose IL2CPP header (`*inst`) matches
 * `classPtr` or whose header's parent chain includes `classPtr` (subclass).
 *
 * On v1.01.02 CommonSaveData: `+0xb0 = 0` (no static_fields block), but the
 * instance lives at `classPtr+0x90` directly — found when the scan treats
 * `classPtr` itself as a block candidate (header+0x40 points back to
 * classPtr on that build).
 */
function findInstanceViaHeaderScan(ctx: ScanContext, classPtr: bigint): bigint | null {
  const HEADER_SCAN_MAX = 0xc0;
  const BLOCK_SCAN_MAX = 0x400;
  // Read header ptr-like values one qword at a time (compatible with
  // MemoryReader implementations that only support 8-byte aligned reads).
  for (let off = 0; off < HEADER_SCAN_MAX; off += 8) {
    const block = readPtr(ctx.reader, classPtr + BigInt(off));
    if (block == null || !isPlausibleHeapPtr(block)) continue;
    for (let foff = 0; foff <= BLOCK_SCAN_MAX; foff += 8) {
      const inst = readPtr(ctx.reader, block + BigInt(foff));
      if (inst == null || !isPlausibleHeapPtr(inst)) continue;
      const instHeader = readPtr(ctx.reader, inst);
      if (instHeader == null) continue;
      // Direct match
      if (instHeader === classPtr) return inst;
      // Subclass match: walk parent chain (up to 4 levels)
      let cls = instHeader;
      for (let depth = 0; depth < 4; depth++) {
        const parent = readPtr(ctx.reader, cls + 0x58n);
        if (parent == null || !isPlausibleHeapPtr(parent)) break;
        if (parent === classPtr) return inst;
        cls = parent;
      }
    }
  }
  return null;
}

/**
 * Probe a single instance field offset for a List<*> shape.
 * Returns `{ count, elemClass, rawItemsHex }` when the pointer at `obj+foff`
 * looks like a `List<T>` (has a plausible `_items` array at +0x10 with
 * `_size` at +0x18). Returns null otherwise.
 *
 * `rawItemsHex` is a hex dump of the first 8 element slots (64 bytes) — used
 * when `elemClass` is null to distinguish:
 *   - all-zero slots (List genuinely emptied / nulled)
 *   - small-integer slots (value-type List<int> / List<enum>)
 *   - non-plausible-pointer slots (compressed ptrs / struct data)
 *
 * Scans up to the first 8 elements to find the first non-null plausible
 * pointer — C# `List<T>` may have null entries at the head when elements
 * were removed. The element class name comes from `instanceClassName`.
 */
function scanListAt(
  ctx: ScanContext,
  obj: bigint,
  foff: number,
): { count: number; elemClass: string | null; rawItemsHex: string } | null {
  const listPtr = readPtr(ctx.reader, obj + BigInt(foff));
  if (listPtr == null || !isPlausibleHeapPtr(listPtr)) return null;
  const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  if (arr == null || !isPlausibleHeapPtr(arr)) return null;
  const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (count == null || count <= 0 || count > MAX_SAVE_LIST) return null;
  // Scan up to 8 elements to find the first non-null plausible pointer.
  // C# List<T> may have null entries at the head after RemoveAt().
  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);
  const scanLimit = Math.min(count, 8);
  // Collect raw hex of first 8 slots (64 bytes) for diagnostics when
  // elemClass is null. Use readBytes directly (not readPtr) so small
  // integers and zero are preserved — readPtr filters out values < 0x10000.
  const rawHex: string[] = [];
  for (let i = 0; i < 8; i++) {
    const buf = ctx.reader.readBytes(first + BigInt(i * 8), 8);
    if (buf == null || buf.length < 8) {
      rawHex.push("??");
    } else {
      rawHex.push(`0x${buf.readBigUInt64LE(0).toString(16)}`);
    }
  }
  const rawItemsHex = `[${rawHex.join(",")}]`;
  for (let i = 0; i < scanLimit; i++) {
    const e = readPtr(ctx.reader, first + BigInt(i * 8));
    if (e == null || !isPlausibleHeapPtr(e)) continue;
    const elemClass = ctx.instanceClassName(e);
    return { count, elemClass, rawItemsHex };
  }
  // List has count > 0 but all probed elements are null — still report it
  // (could be a List<T> where all entries were nulled out, or a value-type
  // List<int>/List<struct> whose slots aren't object pointers).
  return { count, elemClass: null, rawItemsHex };
}
