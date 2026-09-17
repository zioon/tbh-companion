// Runtime IL2CPP reads — live stage (StageCache chain) and live gold
// (CurrencyManager Dictionary<int,T> → ACTk ObscuredLong). Pure: operates over
// an injected MemoryReader so it is unit-testable over synthetic memory maps.

import {
  readF32,
  readI32,
  readI64,
  readIl2CppString,
  readPtr,
  readPtrArray,
  readU32,
  readU64,
  type MemoryReader,
} from "./memory";
import { plausibleGold, plausibleStage, plausibleWave, type LiveOffsets } from "./offsets";
import { readStaticFieldPtr, readStaticFieldsBlock, resolveClassPtr } from "./statics";
import { STRUCT_CONTAINER } from "./il2cppScanner";
import type {
  AcquireLogEntry,
  BoxOpenEntry,
  LiveHeroData,
  LiveInventoryItem,
  LivePetData,
  StageClearEntry,
} from "../../../shared/types";

export interface RuntimeStage {
  stageKey: number | null;
  wave: number | null;
  waveTotal: number | null;
  /** Live alive-monster count from StageManager (wave-clear signal on builds
   *  whose monster-HP offsets are unavailable). Null when not derivable. */
  alive: number | null;
}

/**
 * Live stage key from `StageCacheManager → StageCache → StageInfoData.StageKey`,
 * plus the wave counter from the `StageManager` singleton when set.
 * `smPtr` is the resolved StageManager instance (see {@link resolveStageManager});
 * pass null when it could not be resolved — wave then falls back to the save value.
 * Returns null when the cache chain can't be walked (fall back to the save value).
 */
export function readRuntimeStage(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  smPtr: bigint | null,
): RuntimeStage | null {
  const candidates = o.il2cppClass.staticFieldsOffsets;

  const stageCachePtr = readStaticFieldPtr(
    reader,
    gaBase,
    gaSize,
    o.typeInfoRva.stageCacheManager,
    o.runtime.stage.currentCache,
    candidates,
  );
  if (stageCachePtr == null) return null;

  const stageInfoPtr = readPtr(reader, stageCachePtr + BigInt(o.runtime.stage.cacheInfoData));
  if (stageInfoPtr == null) return null;

  const stageKey = readI32(reader, stageInfoPtr + BigInt(o.runtime.stage.stageKey));
  // waveAmount (StageInfoData+0x54) is the total number of waves for this stage.
  const waveTotal = readI32(reader, stageInfoPtr + BigInt(o.runtime.stage.waveAmount));

  // StageManager singleton runtimeWave — current wave counter when available.
  let wave: number | null = null;
  if (smPtr != null) {
    const runtimeWave = readI32(reader, smPtr + BigInt(o.runtime.stage.runtimeWave));
    if (plausibleWave(runtimeWave)) wave = runtimeWave;
  }

  // StageManager singleton alive-monster count — feeds DpsTracker wave-clear
  // detection on builds without monster-HP offsets (e.g. v1.01.05). Only read
  // when the offset is derived (> 0); null otherwise.
  let alive: number | null = null;
  if (smPtr != null && o.runtime.stage.alive > 0) {
    const aliveCount = readI32(reader, smPtr + BigInt(o.runtime.stage.alive));
    if (aliveCount != null && aliveCount >= 0 && aliveCount < 1000) alive = aliveCount;
  }

  return {
    stageKey: plausibleStage(stageKey) ? stageKey : null,
    wave,
    waveTotal: waveTotal != null && waveTotal > 0 ? waveTotal : null,
    alive,
  };
}

// ── Gold (CurrencyManager → Dictionary<int,T> → ACTk ObscuredLong) ──────────

/** Per-reader-instance pin state for gold: avoids re-walking the dict every tick. */
export interface GoldPinState {
  /** Cached pointer to the currency entry for `goldKey`; null when unknown/stale. */
  entryPtr: bigint | null;
  /** Last successfully decoded gold value; returned when all reads fail (while fresh). */
  lastKnown: number | null;
  /** Wall-clock ms (Date.now()) when `lastKnown` was captured; null when never read. */
  lastKnownAt: number | null;
}

/**
 * How long a stale `lastKnown` may keep being returned after reads start failing.
 * Prevents a game update that invalidates offsets from replaying the pre-update
 * gold value indefinitely: past this window readRuntimeGold returns null.
 */
export const GOLD_STALE_MAX_MS = 5_000;

export function makeGoldPinState(): GoldPinState {
  return { entryPtr: null, lastKnown: null, lastKnownAt: null };
}

/** Walk `Dictionary<int, T>` entries and return the value pointer for a matching int key. */
function dictLookupIntKey(
  reader: MemoryReader,
  dictPtr: bigint,
  key: number,
  o: LiveOffsets,
): bigint | null {
  const entriesArrPtr = readPtr(reader, dictPtr + BigInt(o.dict.entries));
  if (entriesArrPtr == null) return null;
  const count = readI32(reader, dictPtr + BigInt(o.dict.count));
  if (count == null || count <= 0 || count > 100_000) return null;
  const first = entriesArrPtr + BigInt(o.container.arrayFirst);
  for (let i = 0; i < count; i++) {
    const eBase = first + BigInt(i * o.dict.entrySize);
    const hash = readI32(reader, eBase + BigInt(o.dict.entryHash));
    if (hash == null || hash < 0) continue; // deleted / unused slot
    const entryKey = readI32(reader, eBase + BigInt(o.dict.entryKey));
    if (entryKey !== key) continue;
    return readPtr(reader, eBase + BigInt(o.dict.entryValue));
  }
  return null;
}

/**
 * Enumerate every bucket in the LogManager's `Dictionary<ELogType, List<...>>`
 * and report each bucket's integer key and log size. Diagnostics-only: used to
 * identify WHICH bucket backs the in-game "获得记录" timeline (the user reports
 * it holds every box-open, complete, unoverwritten — unlike BoxOpenLog).
 * `pin` is reused only for `resolveLogManager`'s cached lookup.
 */
export interface LogBucketSummary {
  key: number;
  count: number;
}
export function enumerateLogBucketCounts(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: LogManagerPinState,
): LogBucketSummary[] | null {
  if (o.typeInfoRva.logManager === 0n || o.runtime.log.logByType === 0) return null;
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const dictPtr = readPtr(reader, lmPtr + BigInt(o.runtime.log.logByType));
  if (dictPtr == null) return null;
  const entriesArrPtr = readPtr(reader, dictPtr + BigInt(o.dict.entries));
  if (entriesArrPtr == null) return null;
  const count = readI32(reader, dictPtr + BigInt(o.dict.count));
  if (count == null || count <= 0 || count > 100_000) return null;
  const first = entriesArrPtr + BigInt(o.container.arrayFirst);
  const out: LogBucketSummary[] = [];
  for (let i = 0; i < count; i++) {
    const eBase = first + BigInt(i * o.dict.entrySize);
    const hash = readI32(reader, eBase + BigInt(o.dict.entryHash));
    if (hash == null || hash < 0) continue; // deleted / unused slot
    const key = readI32(reader, eBase + BigInt(o.dict.entryKey));
    if (key == null) continue;
    const vPtr = readPtr(reader, eBase + BigInt(o.dict.entryValue));
    if (vPtr == null) continue;
    const c = readI32(reader, vPtr + BigInt(o.container.listSize));
    if (c == null) continue;
    out.push({ key, count: c });
  }
  return out;
}

/**
 * Probe the LogManager instance for candidate fields that look like a
 * `List<T>` (a qword field pointing to an object whose `listSize` is a sane
 * count). Diagnostics-only: scanning this alongside the per-type buckets helps
 * locate the game's holistic "获得记录" buffer, which the user reports holds
 * every item-get complete & unoverwritten. `limit` bounds the output to the
 * largest-count candidates (the most likely log buffers).
 */
export interface LogListCandidate {
  /** Byte offset of the List-pointer field relative to the LogManager object. */
  offset: number;
  count: number;
}
export function inspectLogManagerLists(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: LogManagerPinState,
  maxOffset = 0x400,
  limit = 12,
): LogListCandidate[] | null {
  if (o.typeInfoRva.logManager === 0n || o.container.listSize === 0) return null;
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const out: LogListCandidate[] = [];
  for (let off = 8; off <= maxOffset; off += 8) {
    const vPtr = readPtr(reader, lmPtr + BigInt(off));
    if (vPtr == null || vPtr === 0n) continue;
    const c = readI32(reader, vPtr + BigInt(o.container.listSize));
    if (c == null || c <= 0 || c > 200_000) continue;
    out.push({ offset: off, count: c });
  }
  if (out.length === 0) return [];
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, limit);
}

/**
 * Dump the leading 32-bit words of an object pointed to by a specific field on
 * the LogManager instance. Diagnostics for reverse-engineering the game's
 * holistic "获得记录" buffer (see {@link inspectLogManagerLists}): we read the
 * raw object header so we can recognize its item-buffer pointer / size /
 * capacity / element layout before rendering its entries.
 * Returns null if the slot offset yields no object.
 */
export interface LogManagerSlotDump {
  /** Absolute address of the object the field points to. */
  objPtr: bigint;
  /** First `words` 32-bit little-endian words of the object. */
  words: number[];
}
export function dumpLogManagerSlot(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: LogManagerPinState,
  slotOffset: number,
  words = 24,
): LogManagerSlotDump | null {
  if (o.typeInfoRva.logManager === 0n) return null;
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const vPtr = readPtr(reader, lmPtr + BigInt(slotOffset));
  if (vPtr == null || vPtr === 0n) return null;
  const result: number[] = [];
  for (let i = 0; i < words; i++) {
    const w = readI32(reader, vPtr + BigInt(i * 4));
    if (w == null) break;
    result.push(w);
  }
  return { objPtr: vPtr, words: result };
}

/**
 * Peek at the item buffer(s) reachable from the "获得记录" ring object. The
 * object found at {@link dumpLogManagerSlot} has a capacity of 2000 and a
 * monotonic total-event counter; its entries live in the QWORD buffer pointer
 * fields. We dump a few int32 words at each candidate buffer's start AND near
 * its end so we can tell whether entries are inline (itemId/grade/timestamp)
 * or pointers (a second indirection), without knowing element size yet.
 */
export interface LogBufferPeek {
  /** Absolute buffer address probed. */
  base: bigint;
  /** Leading int32 words (element-0 region). */
  head: number[];
  /** A sample near the tail of the buffer (wraps ring writes). */
  mid: number[];
}
export function peekLogBuffer(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: LogManagerPinState,
  slotOffset: number,
  bufferFieldOffsets: number[],
  headWords = 24,
  tailScanBytes = 0x40_000,
): LogBufferPeek[] | null {
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const objPtr = readPtr(reader, lmPtr + BigInt(slotOffset));
  if (objPtr == null || objPtr === 0n) return null;
  const out: LogBufferPeek[] = [];
  for (const fo of bufferFieldOffsets) {
    const base = readPtr(reader, objPtr + BigInt(fo));
    if (base == null || base === 0n) continue;
    const head: number[] = [];
    for (let i = 0; i < headWords; i++) {
      const w = readI32(reader, base + BigInt(i * 4));
      if (w == null) break;
      head.push(w);
    }
    const mid: number[] = [];
    for (let off = tailScanBytes - headWords * 4; off < tailScanBytes; off += 4) {
      const w = readI32(reader, base + BigInt(off));
      if (w == null) break;
      mid.push(w);
    }
    out.push({ base, head, mid });
  }
  return out;
}

/**
 * Dereference element pointers found in the "获得记录" ring buffer and dump each
 * target entry object's leading int32 words. The ring stores pointer→entry, so a
 * second indirection is needed to see itemKey / timestamp / type fields. We scan
 * the already-read buffer head for qwords that look like heap pointers and read
 * what they point at. Diagnostics-only.
 */
export interface LogEntryPeek {
  /** Absolute address of the entry object. */
  entryPtr: bigint;
  /** Leading int32 words of the entry object. */
  words: number[];
}
export function peekLogRingEntries(
  reader: MemoryReader,
  bufferBase: bigint,
  scanWords = 24,
  perEntryWords = 12,
  fromWord = 4,
): LogEntryPeek[] | null {
  if (bufferBase === 0n) return null;
  const out: LogEntryPeek[] = [];
  for (let k = fromWord; k < scanWords - 1; k += 2) {
    const lo = readI32(reader, bufferBase + BigInt(k * 4));
    const hi = readI32(reader, bufferBase + BigInt((k + 1) * 4));
    if (lo == null || hi == null) break;
    if (hi <= 0 || hi >= 0x1_0000) continue; // only take obvious heap ptrs (0x..0001xxxx pattern)
    const ptr = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    if (ptr === 0n) continue;
    const words: number[] = [];
    for (let i = 0; i < perEntryWords; i++) {
      const w = readI32(reader, ptr + BigInt(i * 4));
      if (w == null) break;
      words.push(w);
    }
    if (words.length === 0) continue;
    out.push({ entryPtr: ptr, words });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Third-level indirection: for each "获得记录" entry object, read the QWORD
 * pointer fields at the given offsets and dump what each nested object holds.
 * This is where the concrete itemKey / amount / timestamp live (one level below
 * the entry), which earlier probes could not see because entries are pointer-boxed.
 */
export interface EntryNestedPeek {
  entryPtr: bigint;
  /** Byte offset of the pointer field within the entry object. */
  field: number;
  /** Absolute address the field points at (the nested item/amount object). */
  target: bigint;
  words: number[];
}
export function peekEntryNestedFields(
  reader: MemoryReader,
  entryPtrs: bigint[],
  fieldOffsets: number[],
  perTarget = 8,
): EntryNestedPeek[] | null {
  if (entryPtrs.length === 0) return null;
  const readQwordPtr = (base: bigint): bigint | null => {
    const lo = readI32(reader, base);
    const hi = readI32(reader, base + 4n);
    if (lo == null || hi == null) return null;
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  };
  const out: EntryNestedPeek[] = [];
  for (const ep of entryPtrs) {
    for (const fo of fieldOffsets) {
      const t = readQwordPtr(ep + BigInt(fo));
      if (t == null || t === 0n) continue;
      const words: number[] = [];
      for (let i = 0; i < perTarget; i++) {
        const w = readI32(reader, t + BigInt(i * 4));
        if (w == null) break;
        words.push(w);
      }
      if (words.length === 0) continue;
      out.push({ entryPtr: ep, field: fo, target: t, words });
    }
  }
  return out;
}

/**
 * Decode a .NET/Mono `System.String` from memory: object header, length
 * (`int32` at +0x10), then UTF-16LE chars from +0x14. Returns the text (best
 * effort; surrogate pairs collapse to lone halves). Used to read the actual
 * "获得记录" message lines the game UI renders.
 */
export function readDotNetString(reader: MemoryReader, strPtr: bigint): string | null {
  if (strPtr === 0n) return null;
  const hdr = reader.readBytes(strPtr, 0x14);
  if (!hdr || hdr.length < 0x14) return null;
  const len = hdr.readInt32LE(0x10);
  if (!Number.isFinite(len) || len < 0 || len > 5000) return null;
  const bytes = reader.readBytes(strPtr + 0x14n, len * 2);
  if (!bytes || bytes.length < len * 2) return null;
  return bytes.toString("utf16le", 0, len * 2);
}

/**
 * The game's holistic "获得记录" ring, reverse-engineered from a v1.2.2 live
 * probe. It lives on the LogManager instance and is the SAME data the in-game
 * "获得记录" UI renders — unlike BoxOpenLog it is complete & unoverwritten for
 * the current session (monotonic total counter, cap ~2000, restart-fresh).
 *
 * Layout (validated by live dumps):
 *   lm + 0x20  → ring object
 *   ring + 0x10 → element-pointer array (elements start at array base + 0x20)
 *   ring + 0x18 → capacity — live-verified 2026-09-15: **2000**, while the
 *   backing array is allocated 2048 (`buf + 0x18`); slot = counter % capacity
 *   (dump: #29700 → slot 1700, #29713 → slot 1713)
 *   ring + 0x1C → monotonic total-acquired counter (the "seq" source)
 *   each element = entry pointer; entry { +0x18 category string, +0x20 message
 *   string ("获得了…"), +0x28 time string ("[HH:MM]") }
 *
 * Delivery is seq-driven off the monotonic counter: new counter range →
 * slot (k mod CAPACITY) → entry → strings. This never under-reads the way the
 * per-type BoxOpenLog shrink did.
 *
 * IMPORTANT (measured 2026-09-15, same build): `ring + 0x1C` runs AHEAD of the
 * slot writes. A live attach read the window `[counter - 2000, counter)` and the
 * window's tail still held the PREVIOUS pass' entries (in-game stamps 6-7 h
 * behind), i.e. the counter claimed entries the slots did not hold yet. Treating
 * the counter as a committed watermark made every later incremental read hit
 * "same slot = previous pass" content — the newest lines were never delivered
 * (the record log stayed ~one full ring behind the game). The reader therefore
 * anchors on its own position and refuses to advance past a slot it can prove
 * is stale — see {@link acquireHoldReason}.
 */
export interface AcquireRingPinState {
  /** Last consumed ring index (the reader's own position, NOT the counter). */
  total: number;
  /** Cached LogManager pointer (shared with resolveLogManager). */
  ptr: bigint | null;
  /**
   * Content identity of the entry last delivered from each ring slot:
   * `entryPtr|msgPtr|message`. A slot read twice with an IDENTICAL identity has
   * not been rewritten by the game — see {@link AcquireHoldReason}.
   *
   * Deliberately built from POINTERS + the message text, **never from the time
   * string**: measured 2026-09-15, the game reuses/rewrites the `entry+0x28`
   * time-string object, so the same untouched ring entry reports a different
   * stamp 45 minutes later (a stale slot therefore looked "changed" and the
   * guard never fired). Message text + pointers are stable for an untouched
   * slot and change when it is rewritten. Rebuilt empty when the ring counter
   * restarts (new game session).
   */
  slotIdentity: (string | null)[];
  /** Last delivered stamp — diagnostics only, the game mutates these strings. */
  lastTime: string | null;
  /** Slot currently held back because it has not been rewritten this pass. */
  holdSlot: number | null;
  /** Wall-clock ms the current slot has been held while the counter kept moving. */
  holdActiveMs: number;
  /** Timestamp of the previous hold evaluation. */
  holdLastAt: number;
  /** Counter value at the previous hold evaluation (detects "game is idle"). */
  holdLastTotal: number;
  /**
   * Capacity probe: index at which `probeSlot`'s content was last seen to
   * change. The stride between two changes is the ring's true capacity — the
   * measurement that validates the hard-coded {@link ACQUIRE_RING_CAPACITY}.
   */
  probeSlot: number;
  probeIndex: number;
  probeIdentity: string | null;
  /** Measured ring capacity (stride between rewrites of `probeSlot`), or null. */
  capacityEstimate: number | null;
  /**
   * Persisted read position from the previous companion run (the "watermark").
   * When present, the first read resumes from it instead of replaying the whole
   * ring window — a companion restart then delivers ONLY the lines appended
   * since the last shutdown, never the backlog. Applied once; see
   * {@link readRuntimeAcquireLogs} for the validation rules.
   */
  resumeTotal: number | null;
  resumeApplied: boolean;
  /**
   * Counter value at which the current game session's record ring started
   * (`base = counter - fill` while the ring is not full). The slot for ring
   * index `k` is `(k - base) % capacity` — NOT `k % capacity`, which is only
   * correct while the session started at counter 0. The game wipes the ring on
   * a new in-game session WITHOUT resetting the monotonic counter (verified
   * 2026-09-16), so the base must be tracked and re-calibrated. null until the
   * first calibration (ring not full); while null the legacy `k % capacity`
   * mapping (base 0) applies.
   */
  sessionBase: number | null;
  /**
   * Base candidate awaiting confirmation. The counter (+0x1C) and fill (+0x18)
   * are separate fields — mid-append the counter may briefly lead, which makes
   * `counter - fill` wobble by ±1. A new base is only adopted when two
   * consecutive polls agree, so a real wipe (a permanent, large jump) costs
   * one 10 ms poll while append skew is ignored entirely.
   */
  sessionBasePending: number | null;
}
export function makeAcquireRingPinState(): AcquireRingPinState {
  return {
    total: 0,
    ptr: null,
    slotIdentity: new Array<string | null>(ACQUIRE_RING_CAPACITY).fill(null),
    lastTime: null,
    holdSlot: null,
    holdActiveMs: 0,
    holdLastAt: 0,
    holdLastTotal: 0,
    probeSlot: 0,
    probeIndex: 0,
    probeIdentity: null,
    capacityEstimate: null,
    resumeTotal: null,
    resumeApplied: false,
    sessionBase: null,
    sessionBasePending: null,
  };
}
export const ACQUIRE_RING_CAPACITY = 2000;
export const ACQUIRE_SLOT_COUNTER_OFF = 0x1c;
/**
 * The ring object's field at +0x18. Dual semantics, resolved by value: while
 * the ring is FULL it equals the capacity (live-verified 2000 on v1.2.2, the
 * backing array is allocated 2048 at `buf + 0x18`); below capacity it is the
 * ring's FILL count — entries appended in the current game session. The game
 * wipes the ring on a new in-game session and the fill restarts from ~0 while
 * the monotonic counter (+0x1C) keeps running (live-verified 2026-09-16: fill
 * 20 / counter 36181), which is exactly what pins down the session base:
 * `base = counter - fill`.
 */
export const ACQUIRE_RING_FILL_OFF = 0x18;
export const ACQUIRE_ELEM_BASE_REL = 0x20;
export const ACQUIRE_RING_FIELD_REL = 0x20;

/**
 * Why a read stopped early instead of delivering the entry at `heldAt`.
 *  - `stale-slot`: the slot's identity equals the previous pass' entry, so the
 *    game has not rewritten it yet (the counter over-leads the slot writes).
 *  - `released`: the hold persisted while the counter kept advancing, so the
 *    staleness assumption is judged wrong and the entry is delivered anyway
 *    (loud, last-resort escape hatch — see {@link ACQUIRE_HOLD_RELEASE_MS}).
 */
export type AcquireHoldReason = "stale-slot" | "released" | null;

/**
 * Last-resort escape hatch. A slot held back for this long WHILE the counter
 * keeps moving means the freshness model is wrong (e.g. the game reuses fixed
 * per-slot entry structs so the identity never changes) — deliver rather than
 * stall forever. Holds during an idle game (counter not moving) never expire:
 * there is nothing to deliver.
 */
export const ACQUIRE_HOLD_RELEASE_MS = 5_000;

export function readRuntimeAcquireLogs(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: AcquireRingPinState,
  nowMs: number = Date.now(),
): {
  entries: AcquireLogEntry[];
  total: number;
  heldAt: number | null;
  heldReason: AcquireHoldReason;
  /** Measured ring capacity (see {@link AcquireRingPinState.probeSlot}), or null. */
  capacityEstimate: number | null;
  /**
   * Capacity the ring object itself declares — only readable while the ring is
   * FULL: `ring + 0x18` holds the fill count while below capacity and equals
   * the capacity (live-verified 2026-09-15: 2000, backing array 2048 at
   * `buf + 0x18`) once full. Read every poll so a future game update that
   * changes the modulus cannot silently mis-align slot lookups.
   * null while the ring is not full (the field is the fill count then).
   */
  declaredCapacity: number | null;
  /**
   * Ring fill count (`ring + 0x18`): entries appended in the current game
   * session, capped at the capacity. null when implausible.
   */
  fillCount: number | null;
  /**
   * When the game wiped the record ring mid-process (a fill count below
   * capacity implies a session base different from what the pin tracked), the
   * pin was re-anchored at the new session start — this is that base.
   * Diagnostics only: ring indices keep running across the wipe, so the fresh
   * backlog delivers as a plain increment (no restart semantics).
   */
  reanchoredBase: number | null;
  /**
   * True when this read resumed from the persisted watermark instead of
   * replaying the ring window — the caller must treat the batch as a plain
   * increment (no initial-batch dedupe).
   */
  resumed: boolean;
  /**
   * True when the persisted watermark is ABOVE the ring counter: the counter
   * restarted, i.e. a new game session whose backlog is genuinely new (the
   * caller must bypass the archive dedupe for this batch).
   */
  restartDetected: boolean;
} | null {
  if (o.typeInfoRva.logManager === 0n) return null;
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin as unknown as LogManagerPinState);
  if (lmPtr == null) return null;

  const ringObj = readPtr(reader, lmPtr + BigInt(ACQUIRE_RING_FIELD_REL));
  if (ringObj == null || ringObj === 0n) return null;
  const total = readI32(reader, ringObj + BigInt(ACQUIRE_SLOT_COUNTER_OFF));
  if (total == null || total < 0) return null;
  const fillRaw = readI32(reader, ringObj + BigInt(ACQUIRE_RING_FILL_OFF));
  // Dual-semantics field, resolved by value: >= capacity reads as the declared
  // capacity (a future build changing the modulus must still surface loudly);
  // below capacity it is the session fill count (a wipe makes it restart from
  // ~0 while the counter keeps running). Fill == capacity (a full ring) is
  // reported as the capacity only — the base cannot be calibrated from it.
  const declaredCapacity = fillRaw != null && fillRaw >= ACQUIRE_RING_CAPACITY ? fillRaw : null;
  const fillCount =
    fillRaw != null && fillRaw >= 0 && fillRaw < ACQUIRE_RING_CAPACITY ? fillRaw : null;
  // Watermark resume (once per reader): a companion restart continues from the
  // last shutdown's read position instead of replaying the ring window, so the
  // first batch contains ONLY the lines appended since then.
  //  - counter >= watermark and within one ring → resume at the watermark;
  //  - counter < watermark → the counter restarted (new game session): report it
  //    so the batch bypasses the archive dedupe, and let the rewind below reset;
  //  - counter more than one ring above → the gap is partially overwritten, the
  //    watermark is unusable → fall through to the fresh full-window anchor.
  let resumed = false;
  let restartDetected = false;
  if (!pin.resumeApplied && pin.resumeTotal != null) {
    pin.resumeApplied = true;
    const rt = pin.resumeTotal;
    if (total >= rt && total - rt <= ACQUIRE_RING_CAPACITY) {
      pin.total = rt;
      resumed = true;
    } else if (total < rt) {
      restartDetected = true;
    }
  }
  // Ring restart (new game session / re-attach to a fresh process): the counter
  // is monotonic, so a value below the reader's own position means the ring was
  // cleared and re-counted from 0 — rewind the pin AND drop the freshness
  // bookkeeping (slot identities / last stamp) of the previous ring. The
  // session base is also dropped: the new process starts at counter 0 again.
  if (pin.total > total) {
    pin.total = 0;
    pin.lastTime = null;
    pin.holdSlot = null;
    pin.holdActiveMs = 0;
    pin.slotIdentity.fill(null);
    pin.sessionBase = null;
    pin.sessionBasePending = null;
  }

  // Session-base calibration / mid-process wipe detection. While the ring is
  // not full, `fill = counter - base` pins the session start down exactly, and
  // the slot for ring index k is `(k - base) % capacity` — NOT `k % capacity`,
  // which only holds while the session started at counter 0. A base that MOVES
  // under a tracked pin means the game wiped the record ring for a new
  // in-game session without resetting the counter (live-verified 2026-09-16:
  // fill 4 / counter 36165 right after the wipe, slots 173+ all null while the
  // fresh backlog sat at slots 0..3). Re-anchor the pin at the new start.
  // Deliberately NOT `restartDetected`: ring indices keep running across the
  // wipe, so the fresh backlog is brand-new to the archive dedupe and delivers
  // as a plain increment — no UI rewind, no bypass needed.
  let reanchoredBase: number | null = null;
  if (fillCount != null) {
    const newBase = total - fillCount;
    if (newBase === pin.sessionBase) {
      pin.sessionBasePending = null;
    } else if (pin.sessionBasePending === newBase) {
      // Confirmed on two consecutive polls — a real wipe. A transient
      // counter/fill skew (counter briefly ahead of fill mid-append) bounces
      // back to the previous base instead of being adopted.
      pin.sessionBase = newBase;
      pin.sessionBasePending = null;
      if (pin.total < newBase) {
        // The pin sits before the new session start (the wipe happened after
        // the pin's position, or a resumed watermark predates it): jump
        // forward — nothing readable exists between the two, the old slots
        // were cleared by the wipe.
        pin.total = newBase;
        pin.slotIdentity.fill(null);
        pin.lastTime = null;
        pin.holdSlot = null;
        pin.holdActiveMs = 0;
        reanchoredBase = newBase;
      }
    } else {
      pin.sessionBasePending = newBase;
    }
  }
  // A SATURATED ring (fill == capacity) has no calibration signal at all: the
  // fill count is pinned at the capacity while the counter keeps running, so
  // neither `counter - fill` nor `counter - capacity` yields the session base.
  // By then, however, the base has long been calibrated (fill < capacity on
  // every earlier poll of the session — a base-0 session reads base 0, a wiped
  // session re-anchors at the wipe), and `slotBase` below keeps that value, so
  // slot lookups stay aligned across the wrap. The only uncoverable case is a
  // companion attaching to an ALREADY-saturated ring whose base is non-zero
  // (the game wiped and re-saturated while no reader was attached) — there the
  // base-0 fallback mis-maps slots by a constant offset; entries still deliver
  // (the hold guard paces them) but ring indices are shifted until the next
  // wipe recalibrates. 17+ in-game hours of unattended play are needed to hit
  // it, so the fallback stands.

  const bufPtr = readPtr(reader, ringObj + BigInt(0x10));
  if (bufPtr == null || bufPtr === 0n) return null;
  const elemBase = bufPtr + BigInt(ACQUIRE_ELEM_BASE_REL);

  const entries: AcquireLogEntry[] = [];
  const start = Math.max(0, pin.total);
  // Read anchor. A fresh reader (pin 0) anchors on the calibrated session base
  // when known — the backlog IS the current session (base..counter), while
  // `total - capacity` may predate the wipe that started it — and on the
  // newest window otherwise. Steady state anchors on the PIN, never on
  // `total - CAPACITY`: the counter may over-lead the slot writes (see the
  // header comment), and anchoring on it would silently skip entries the pin
  // has not consumed yet.
  const from =
    start === 0
      ? pin.sessionBase != null && pin.sessionBase <= total
        ? pin.sessionBase
        : Math.max(0, total - ACQUIRE_RING_CAPACITY)
      : start;
  // Slot mapping follows the calibrated session base (see the calibration
  // comment above); the positive-mod guard is belt-and-braces.
  const slotBase = pin.sessionBase ?? 0;
  // Bounded catch-up: at most one ring length per poll. A starved reader
  // (worker paused for longer than the ring holds) catches up over successive
  // 10 ms polls instead of jumping its pin past unread entries.
  const limit = Math.min(total, from + ACQUIRE_RING_CAPACITY);
  // Delivered watermark. Two reasons to stop early, both retried by the next
  // poll (never skipped, never delivered):
  //  1. slot pointer not committed yet / message still mid-write (pre-existing);
  //  2. the slot still holds the PREVIOUS ring pass' entry (identical identity)
  //     — the counter runs ahead of the slot writes. Measuring the in-game stamp
  //     is NOT usable here: the game reuses/rewrites the time-string object, so
  //     the stamp of an untouched slot changes under us.
  // Everything up to that point decoded cleanly, so only those advance the pin.
  let deliveredUpTo = start;
  let heldAt: number | null = null;
  let heldReason: AcquireHoldReason = null;
  for (let k = from; k < limit; k++) {
    const slot =
      (((k - slotBase) % ACQUIRE_RING_CAPACITY) + ACQUIRE_RING_CAPACITY) % ACQUIRE_RING_CAPACITY;
    const eAddr = elemBase + BigInt(slot * 8);
    const entryPtr = readPtr(reader, eAddr);
    if (entryPtr == null || entryPtr === 0n) break; // slot not committed yet (mid-write)
    const msgPtr = readPtr(reader, entryPtr + 0x20n);
    const message = msgPtr ? readDotNetString(reader, msgPtr) : null;
    if (!message) break; // mid-write: stop here; retry the tail next poll
    const catPtr = readPtr(reader, entryPtr + 0x18n);
    const timePtr = readPtr(reader, entryPtr + 0x28n);
    const rawTime = timePtr ? readDotNetString(reader, timePtr) : null;
    const time = (rawTime ?? "").replace(/[[]/g, "").replace(/]/g, "").trim();
    const identity = acquireIdentity(entryPtr, msgPtr, message);

    const hold = acquireHoldReason(pin, slot, k, identity, total, nowMs);
    // "released" = the freshness assumption was judged wrong; deliver this entry
    // anyway, surface it through `heldReason` (the caller logs it loudly) and
    // stop — the slots after it belong to the same unwritten region.
    const released = hold === "released";
    if (hold != null && !released) {
      heldAt = k;
      heldReason = hold;
      break;
    }

    entries.push({
      seq: k + 1,
      time,
      message,
      category: catPtr ? (readDotNetString(reader, catPtr) ?? undefined) : undefined,
    });
    pin.slotIdentity[slot] = identity;
    pin.lastTime = time;
    pin.holdSlot = null;
    pin.holdActiveMs = 0;
    probeAcquireCapacity(pin, slot, k, identity);
    deliveredUpTo = k + 1;
    if (released) {
      heldReason = "released";
      break;
    }
  }

  if (deliveredUpTo > pin.total) pin.total = deliveredUpTo;
  return {
    entries,
    total,
    heldAt,
    heldReason,
    capacityEstimate: pin.capacityEstimate,
    declaredCapacity,
    fillCount,
    reanchoredBase,
    resumed,
    restartDetected,
  };
}

/**
 * Identity of one ring slot's content: entry pointer + message pointer +
 * message text. Pointers catch a replaced entry object, the text catches an
 * in-place overwrite — and neither is affected by the game rewriting the time
 * string object (which is why the stamp is not part of it).
 */
function acquireIdentity(entryPtr: bigint, msgPtr: bigint | null, message: string): string {
  return `${entryPtr.toString(16)}|${msgPtr == null ? "null" : msgPtr.toString(16)}|${message}`;
}

/**
 * Measure the ring's true capacity: remember where `probeSlot`'s content was
 * last seen to CHANGE — two consecutive changes are exactly one ring length
 * apart. This is the runtime check of the hard-coded {@link ACQUIRE_RING_CAPACITY}
 * (a wrong modulus silently mis-aligns every slot lookup).
 */
function probeAcquireCapacity(
  pin: AcquireRingPinState,
  slot: number,
  k: number,
  identity: string,
): void {
  if (slot !== pin.probeSlot) return;
  if (pin.probeIdentity == null) {
    pin.probeIndex = k;
    pin.probeIdentity = identity;
    return;
  }
  if (pin.probeIdentity === identity) return;
  const stride = k - pin.probeIndex;
  if (stride > 0) pin.capacityEstimate = stride;
  pin.probeIndex = k;
  pin.probeIdentity = identity;
}

/**
 * Decide whether the entry at ring index `k` / slot `slot` is a not-yet-rewritten
 * (stale) slot rather than a fresh append. Returns the hold reason, or null when
 * the entry may be delivered. Also owns the hold bookkeeping (which slot is held
 * and for how long the counter kept moving while holding).
 */
function acquireHoldReason(
  pin: AcquireRingPinState,
  slot: number,
  k: number,
  identity: string,
  total: number,
  nowMs: number,
): AcquireHoldReason {
  // Slot identities only mean something once the slot has been written at least
  // once before (index >= capacity) and we have read it on that earlier pass.
  const sameAsPreviousPass =
    k >= ACQUIRE_RING_CAPACITY &&
    pin.slotIdentity[slot] != null &&
    pin.slotIdentity[slot] === identity;

  if (!sameAsPreviousPass) {
    pin.holdSlot = null;
    pin.holdActiveMs = 0;
    return null;
  }
  const reason: AcquireHoldReason = "stale-slot";

  // Hold bookkeeping + last-resort release valve. The held slot IS the next
  // write target, so the hold normally resolves on the game's next append; the
  // valve only counts time during which the counter kept advancing (an idle
  // game has nothing to deliver, so its holds never expire).
  if (pin.holdSlot !== slot) {
    pin.holdSlot = slot;
    pin.holdActiveMs = 0;
    pin.holdLastAt = nowMs;
    pin.holdLastTotal = total;
    return reason;
  }
  if (total > pin.holdLastTotal) pin.holdActiveMs += Math.max(0, nowMs - pin.holdLastAt);
  else pin.holdActiveMs = 0;
  pin.holdLastAt = nowMs;
  pin.holdLastTotal = total;
  if (pin.holdActiveMs >= ACQUIRE_HOLD_RELEASE_MS) {
    pin.holdSlot = null;
    pin.holdActiveMs = 0;
    return "released";
  }
  return reason;
}

/**
 * Raw "获得记录" ring dump for offset/behaviour investigations, gated behind
 * `TBH_ACQUIRE_DUMP=1` on the worker side. Prints the ring geometry (counter,
 * ring/buffer/element-base pointers, candidate length probes at +0x18 / +0x1C)
 * plus the tail window's slot pointers and decoded stamps. Two consecutive
 * dumps answer the open questions: does the counter move before the slot
 * content, and does a slot's entry pointer change when it is rewritten?
 */
export function dumpRuntimeAcquireRing(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: AcquireRingPinState,
  windowSize = 24,
): string | null {
  if (o.typeInfoRva.logManager === 0n) return null;
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin as unknown as LogManagerPinState);
  if (lmPtr == null) return null;
  const ringObj = readPtr(reader, lmPtr + BigInt(ACQUIRE_RING_FIELD_REL));
  if (ringObj == null || ringObj === 0n) return null;
  const total = readI32(reader, ringObj + BigInt(ACQUIRE_SLOT_COUNTER_OFF));
  const bufPtr = readPtr(reader, ringObj + BigInt(0x10));
  if (total == null || bufPtr == null) return null;
  const elemBase = bufPtr + BigInt(ACQUIRE_ELEM_BASE_REL);
  const hex = (v: bigint | null): string => (v == null ? "null" : `0x${v.toString(16)}`);
  // Capacity probes. `bufPtr` looks like a ring container: the array whose data
  // starts at +0x20 (matching ACQUIRE_ELEM_BASE_REL) sits behind a pointer at
  // +0x10, and +0x18 / +0x1C read like capacity / committed-count ints. A sane
  // length there settles the hard-coded 2000 without waiting for the runtime
  // stride probe to complete a full ring.
  const inner = readPtr(reader, bufPtr + 0x10n);
  const innerLen = inner == null ? null : readI32(reader, inner + 0x18n);
  const sane = (v: number | null): string =>
    v != null && v >= 16 && v <= 100_000 ? String(v) : "?";
  const lines: string[] = [
    `acquire dump: total=${total} pin=${pin.total} fill=${readI32(reader, ringObj + BigInt(ACQUIRE_RING_FILL_OFF)) ?? "?"} base=${pin.sessionBase ?? "-"} slotCounter=+0x1C ring=${hex(ringObj)} buf=${hex(bufPtr)} elemBase=${hex(elemBase)}`,
    `  len probes: buf+0x18=${readI32(reader, bufPtr + 0x18n) ?? "?"} buf+0x1C=${readI32(reader, bufPtr + 0x1cn) ?? "?"} ring+0x18=${readI32(reader, ringObj + 0x18n) ?? "?"} inner=${hex(inner)} innerLen=${sane(innerLen)} (assumed capacity=${ACQUIRE_RING_CAPACITY})`,
    `  state: holdSlot=${pin.holdSlot ?? "-"} capacityEstimate=${pin.capacityEstimate ?? "-"} lastStamp=${pin.lastTime ?? "-"}`,
  ];
  const slotBase = pin.sessionBase ?? 0;
  const from = Math.max(0, total - windowSize);
  for (let k = from; k < total; k++) {
    const slot =
      (((k - slotBase) % ACQUIRE_RING_CAPACITY) + ACQUIRE_RING_CAPACITY) % ACQUIRE_RING_CAPACITY;
    const entryPtr = readPtr(reader, elemBase + BigInt(slot * 8));
    const msgPtr = entryPtr == null ? null : readPtr(reader, entryPtr + 0x20n);
    const timePtr = entryPtr == null ? null : readPtr(reader, entryPtr + 0x28n);
    const message = msgPtr ? readDotNetString(reader, msgPtr) : null;
    const rawTime = timePtr ? readDotNetString(reader, timePtr) : null;
    lines.push(
      `  #${k} slot=${slot} entry=${hex(entryPtr)} t=${(rawTime ?? "?").replace(/[[\]]/g, "")} ` +
        `fp="${(message ?? "<undecodable>").slice(0, 28)}"`,
    );
  }
  return lines.join("\n");
}

/** Decode one ACTk ObscuredLong from its struct base address. */
function readObscuredLong(reader: MemoryReader, structAddr: bigint): bigint | null {
  const hidden = readI64(reader, structAddr + 8n);
  const crypto = readI64(reader, structAddr + 16n);
  if (hidden == null || crypto == null) return null;
  // ACTk decodes in ulong (mod-2^64) arithmetic; JS BigInt subtraction has no
  // wraparound, so without the u64 mask a hidden value with the sign bit set
  // makes (hidden - crypto) negative and the XOR result negative — the decoded
  // gold is then rejected by plausibleGold even though its low 64 bits are the
  // correct balance (observed on v1.2.4: live gold permanently null). Mirror
  // the ObscuredInt decoder's masking.
  const U64 = (1n << 64n) - 1n;
  return (((hidden - crypto) & U64) ^ crypto) & U64;
}

const BURST_ATTEMPTS = 4;

/** Burst-read the ObscuredLong from a pinned currency entry (up to 4 attempts). */
function readGoldFromEntry(reader: MemoryReader, entryPtr: bigint, o: LiveOffsets): number | null {
  const structAddr = entryPtr + BigInt(o.runtime.currency.entryObscuredQty);
  for (let attempt = 0; attempt < BURST_ATTEMPTS; attempt++) {
    const raw = readObscuredLong(reader, structAddr);
    if (raw == null) continue;
    const v = Number(raw);
    if (plausibleGold(v)) return v;
  }
  return null;
}

/**
 * Live gold from `CurrencyManager → Dictionary<int, uz.tn> → ObscuredLong`.
 * Uses a per-caller `GoldPinState` to cache the entry pointer across ticks.
 * Returns `pin.lastKnown` when all reads fail, but only while it is younger
 * than GOLD_STALE_MAX_MS; past that window returns null (stale expiry).
 */
export function readRuntimeGold(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: GoldPinState,
): number | null {
  const candidates = o.il2cppClass.staticFieldsOffsets;

  // Fast path: try the cached entry pointer.
  if (pin.entryPtr != null) {
    const v = readGoldFromEntry(reader, pin.entryPtr, o);
    if (v != null) {
      pin.lastKnown = v;
      pin.lastKnownAt = Date.now();
      return v;
    }
    pin.entryPtr = null; // stale — GC may have moved the entry; re-walk
  }

  // Dict walk: CurrencyManager static field → dict → entry for goldKey.
  const dictPtr = readStaticFieldPtr(
    reader,
    gaBase,
    gaSize,
    o.typeInfoRva.currencyManager,
    o.runtime.currency.dict,
    candidates,
  );
  if (dictPtr != null) {
    const entryPtr = dictLookupIntKey(reader, dictPtr, o.goldKey, o);
    if (entryPtr != null) {
      const v = readGoldFromEntry(reader, entryPtr, o);
      if (v != null) {
        pin.entryPtr = entryPtr;
        pin.lastKnown = v;
        pin.lastKnownAt = Date.now();
        return v;
      }
    }
  }

  // All paths failed — return last known rather than null to reduce UI flicker,
  // but only while the value is fresh. After GOLD_STALE_MAX_MS of consecutive
  // failures (e.g. a game update invalidating offsets), report null so the UI
  // does not keep replaying a pre-update value as current.
  if (
    pin.lastKnown != null &&
    pin.lastKnownAt != null &&
    Date.now() - pin.lastKnownAt <= GOLD_STALE_MAX_MS
  ) {
    return pin.lastKnown;
  }
  return null;
}

// ── COMBAT GOLD from PlayerSaveData.aggregateSaveDatas (tbh-meter approach) ─────
//
// The game tracks GoldEarn as a cumulative Dict<SubKey, long> in the save's
// AggregateSaveData list. SubKey 1 = COMBAT (pure combat gold, excludes sales/idle/quest).
// This is more accurate than wallet balance (CurrencyManager) which includes gear sales.
// Ported from tbh-meter/reader/metrics/gold.py -> combat_gold_save.
//
// Per-reader pin (combat gold entry pointer cached across ticks): the
// AggregateSaveData list is small but the previous implementation walked it
// every tick (up to 2000 entries × 2-3 reads = 4-6k IPC calls per tick).
// The combat-gold entry is stable across a session — cache its index once.
export interface CombatGoldPinState {
  /** Cached list pointer + entry index, or null when not yet located. */
  listPtr: bigint | null;
  arrPtr: bigint | null;
  /** Cached index of the GoldEarn[SubKey=1] entry within the list. */
  entryIndex: number;
}
export function makeCombatGoldPinState(): CombatGoldPinState {
  return { listPtr: null, arrPtr: null, entryIndex: -1 };
}

export function readRuntimeCombatGold(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin?: CombatGoldPinState,
): number | null {
  if (o.player.aggregates === 0) return null; // offset not yet derived

  const candidates = o.il2cppClass.staticFieldsOffsets;

  // CommonSaveData -> player -> aggregateSaveDatas
  const playerPtr = readStaticFieldPtr(
    reader,
    gaBase,
    gaSize,
    o.typeInfoRva.commonSaveData,
    o.player.commonSaveData,
    candidates,
  );
  if (playerPtr == null) return null;

  const listPtr = readPtr(reader, playerPtr + BigInt(o.player.aggregates));
  if (listPtr == null) return null;

  const arrPtr = readPtr(reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  if (arrPtr == null) return null;

  const count = readI32(reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (count == null || count <= 0 || count > 2000) return null;

  const first = arrPtr + BigInt(STRUCT_CONTAINER.arrayFirst);

  // Fast path: try the cached entry index. The list pointer must match (GC
  // may rebuild the list) and the cached index must still be in range. Even
  // with caching, we re-validate type/subKey so a stale index into a
  // reshuffled list doesn't return garbage.
  if (pin != null && pin.listPtr === listPtr && pin.arrPtr === arrPtr && pin.entryIndex >= 0) {
    if (pin.entryIndex < count) {
      const entryPtr = readPtr(reader, first + BigInt(pin.entryIndex * 8));
      if (entryPtr != null) {
        const type = readI32(reader, entryPtr + 0x10n);
        const subKey = readI32(reader, entryPtr + 0x14n);
        if (type === 2 && subKey === 1) {
          const value = readI64(reader, entryPtr + 0x18n);
          if (value != null) {
            const v = Number(value);
            if (plausibleGold(v) && v > 0) return v;
          }
        }
      }
    }
    // Cached entry no longer valid — fall through to full scan.
    pin.listPtr = null;
    pin.arrPtr = null;
    pin.entryIndex = -1;
  }

  // AggregateSaveData: TYPE@0x10 (int), SUB_KEY@0x14 (int), VALUE@0x18 (long)
  // Find GoldEarn(2) with SubKey=1 (COMBAT)
  for (let i = 0; i < count; i++) {
    const entryPtr = readPtr(reader, first + BigInt(i * 8));
    if (entryPtr == null) continue;

    const type = readI32(reader, entryPtr + 0x10n);
    if (type !== 2) continue; // EAggregateType.GoldEarn == 2

    const subKey = readI32(reader, entryPtr + 0x14n);
    if (subKey !== 1) continue; // COMBAT subkey

    const value = readI64(reader, entryPtr + 0x18n);
    if (value == null) return null;
    const v = Number(value);
    // Cache the located entry so subsequent ticks skip the full scan.
    if (pin != null) {
      pin.listPtr = listPtr;
      pin.arrPtr = arrPtr;
      pin.entryIndex = i;
    }
    return plausibleGold(v) && v > 0 ? v : null;
  }
  return null;
}

// ── ACTk Obscured value decode (level = ObscuredInt, exp = ObscuredFloat) ─────

/** Swap bytes [1] and [2] of a 32-bit little-endian word (ObscuredFloat quirk). */
function byteswap12(v: number): number {
  return (
    ((v & 0xff) | (((v >>> 16) & 0xff) << 8) | (((v >>> 8) & 0xff) << 16) | (v & 0xff000000)) >>> 0
  );
}

// Module-level reusable buffers for bit reinterpretation. read loop is
// single-threaded (utilityProcess runs one event loop), so reuse is safe.
// Avoids ~125-250 ArrayBuffer allocations per second from 25 Hz × hero decode.
const _F32_BUF = new ArrayBuffer(4);
const _F32_VIEW = new DataView(_F32_BUF);
const _F64_BUF = new ArrayBuffer(8);
const _F64_VIEW = new DataView(_F64_BUF);

/** Reinterpret a uint32 bit pattern as an IEEE-754 float32. */
function u32ToF32(bits: number): number {
  _F32_VIEW.setUint32(0, bits >>> 0, true);
  return _F32_VIEW.getFloat32(0, true);
}

/** Decode an ACTk ObscuredInt to a signed int32: `(hidden - key) ^ key`. */
function decodeObscuredInt(hidden: number | null, key: number | null): number | null {
  if (hidden == null || key == null) return null;
  const raw = ((((hidden - key) & 0xffffffff) >>> 0) ^ key) >>> 0;
  return raw | 0; // reinterpret as signed
}

/** Decode an ACTk ObscuredFloat to a float32: `f32(key ^ byteswap12(hidden))`. */
function decodeObscuredFloat(hidden: number | null, key: number | null): number | null {
  if (hidden == null || key == null) return null;
  return u32ToF32((key ^ byteswap12(hidden)) >>> 0);
}

// ── ACTk ObscuredDouble decode (1.00.27+ widened ObscuredFloat→ObscuredDouble) ──

/** ACTkByte8 `yub` permutation for ObscuredDouble decode (read from 1.00.27 binary).
 *  out[i] = in[_BYTE8_PERM[i]] — not its own inverse (3-cycle on 4/5/7). */
const _BYTE8_PERM = [1, 0, 2, 3, 7, 4, 6, 5];

/** Apply the ACTkByte8 shuffle to a 64-bit little-endian word. */
function byteswap8(v: bigint): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    const srcByte = Number((v >> BigInt(_BYTE8_PERM[i] * 8)) & 0xffn);
    result |= BigInt(srcByte) << BigInt(i * 8);
  }
  return result;
}

/** Decode an ACTk ObscuredDouble to a float64: `f64(key ^ byteswap8(hidden))`.
 *  hidden/key are unsigned 64-bit values read via readU64.
 *  Ported from tbh-meter's game/obscured.py -> decode_obscured_double.
 *  Uses a module-level DataView — this is on the per-hero hot path (v1.00.27+
 *  heroes have ObscuredDouble exp). */
function decodeObscuredDouble(hidden: bigint | null, key: bigint | null): number | null {
  if (hidden == null || key == null) return null;
  const bits = (key ^ byteswap8(hidden)) & 0xffffffffffffffffn;
  // Reuse module-level buffer (see _F64_VIEW declaration above).
  _F64_VIEW.setBigUint64(0, bits, true);
  return _F64_VIEW.getFloat64(0, true);
}

// ── Heroes (StageManager.HeroList → Hero[] → Unit.cache → HeroRuntime) ────────

const MAX_HEROES = 20; // sanity cap: game has far fewer party slots
/** Reject decoded runtime exp above this (corrupted memory / bad Obscured decode). */
const MAX_HERO_RUNTIME_EXP = 1e12;

/**
 * Read the live party off a resolved StageManager instance.
 *
 * `HeroList` is a `Hero[]` of deployed party members. Each element is a runtime
 * `Unit`, whose identity/level/exp live behind `Unit.cache → HeroRuntime`
 * (NOT the save-layer HeroSaveData offsets). Level/exp are ACTk Obscured values.
 */
export interface ReadHeroesResult {
  heroes: LiveHeroData[] | null;
  status: string;
}

function readParty(reader: MemoryReader, smPtr: bigint, o: LiveOffsets): ReadHeroesResult {
  const heroListPtr = readPtr(reader, smPtr + BigInt(o.runtime.heroList));
  if (heroListPtr == null) {
    return { heroes: null, status: "HeroList ptr null (runtime.heroList offset suspect)" };
  }

  // HeroList is Hero[] (direct IL2CPP array): length at +listSize, elements at +arrayFirst.
  const count = readI32(reader, heroListPtr + BigInt(o.container.listSize));
  if (count == null) {
    return {
      heroes: null,
      status: "HeroList count unreadable (container.listSize offset suspect)",
    };
  }
  if (count <= 0) {
    return {
      heroes: null,
      status: "party empty (in menu/lobby — StageManager live but no party deployed)",
    };
  }
  if (count > MAX_HEROES) {
    return {
      heroes: null,
      status: `count=${count} exceeds MAX_HEROES (container.listSize offset suspect)`,
    };
  }

  // Detect exp field type: 8-byte gap → ObscuredDouble (v1.00.27+), 4-byte → ObscuredFloat (pre-1.00.27)
  const expIsDouble = o.heroRuntime.expKey - o.heroRuntime.expHidden >= 8;

  const heroes: LiveHeroData[] = [];
  let filtered = 0;
  const first = heroListPtr + BigInt(o.container.arrayFirst);

  for (let i = 0; i < count; i++) {
    const heroPtr = readPtr(reader, first + BigInt(i * 8));
    if (heroPtr == null) {
      filtered++;
      continue;
    }

    const runtimePtr = readPtr(reader, heroPtr + BigInt(o.unit.cache));
    if (runtimePtr == null) {
      filtered++;
      continue;
    }

    const infoPtr = readPtr(reader, runtimePtr + BigInt(o.heroRuntime.info));
    if (infoPtr == null) {
      filtered++;
      continue;
    }

    const heroKey = readI32(reader, infoPtr + BigInt(o.heroInfoData.heroKey));
    if (heroKey == null || heroKey <= 0 || heroKey >= 10_000_000) {
      filtered++;
      continue;
    }

    const level = decodeObscuredInt(
      readU32(reader, runtimePtr + BigInt(o.heroRuntime.levelHidden)),
      readU32(reader, runtimePtr + BigInt(o.heroRuntime.levelKey)),
    );

    // Decode exp: ObscuredDouble (8-byte) for v1.00.27+, ObscuredFloat (4-byte) for older versions
    const exp = expIsDouble
      ? decodeObscuredDouble(
          readU64(reader, runtimePtr + BigInt(o.heroRuntime.expHidden)),
          readU64(reader, runtimePtr + BigInt(o.heroRuntime.expKey)),
        )
      : decodeObscuredFloat(
          readU32(reader, runtimePtr + BigInt(o.heroRuntime.expHidden)),
          readU32(reader, runtimePtr + BigInt(o.heroRuntime.expKey)),
        );

    heroes.push({
      heroKey,
      level: level != null && level > 0 && level <= 200 ? level : 1,
      exp: exp != null && exp >= 0 && Number.isFinite(exp) && exp <= MAX_HERO_RUNTIME_EXP ? exp : 0,
    });
  }

  if (heroes.length === 0) {
    return {
      heroes: null,
      status: `all ${count} heroes filtered (filtered=${filtered}, unit.cache / heroRuntime offsets suspect)`,
    };
  }
  return { heroes, status: "" };
}

/**
 * Live hero data for the deployed party.
 * `smPtr` is the resolved StageManager instance (see {@link resolveStageManager});
 * returns null when it is unresolved or the party can't be walked.
 */
export function readRuntimeHeroes(
  reader: MemoryReader,
  o: LiveOffsets,
  smPtr: bigint | null,
): ReadHeroesResult {
  if (smPtr == null)
    return { heroes: null, status: "StageManager unresolved (in menu or scene transition)" };
  return readParty(reader, smPtr, o);
}

// ── StageManager singleton resolution ────────────────────────────────────────

/** Per-reader-instance pin for the StageManager instance pointer. */
export interface SmPinState {
  ptr: bigint | null;
  /** Last resolution outcome reason — dev-only diagnostics. Empty when resolved. */
  lastStatus: string;
}

export function makeSmPinState(): SmPinState {
  return { ptr: null, lastStatus: "" };
}

// The singleton `Instance` static field's offset within the class static block is
// not name-stable, so scan the block for the pointer that resolves a live party.
const SM_STATIC_SCAN_MAX = 0x100;

/** A candidate StageManager is "live" when it exposes a walkable, non-empty party. */
function isLiveStageManager(reader: MemoryReader, ptr: bigint, o: LiveOffsets): boolean {
  return readParty(reader, ptr, o).heroes != null;
}

/**
 * Resolve the live `StageManager` instance pointer.
 *
 * The instance is not stored in a name-stable static field, so we scan the
 * StageManager class static block for the pointer whose `HeroList` resolves a
 * real party (`readParty`). The winning pointer is pinned and re-validated each
 * tick; a full re-scan happens only when the pin goes stale (e.g. scene reload).
 * Returns null between stages when no party is deployed — callers fall back to
 * save-file values for the affected stats.
 */
export function resolveStageManager(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: SmPinState,
): bigint | null {
  if (pin.ptr != null && isLiveStageManager(reader, pin.ptr, o)) {
    pin.lastStatus = "";
    return pin.ptr;
  }
  pin.ptr = null;

  const block = readStaticFieldsBlock(
    reader,
    gaBase,
    gaSize,
    o.typeInfoRva.stageManager,
    o.il2cppClass.staticFieldsOffsets,
  );
  if (block == null) {
    pin.lastStatus =
      "StageManager static-fields block unreadable (typeInfoRva.stageManager suspect or staticFieldsOffsets mismatch)";
    return null;
  }

  let scanned = 0;
  let firstFailStatus: string | null = null;
  for (let off = 0; off <= SM_STATIC_SCAN_MAX; off += 8) {
    const cand = readPtr(reader, block + BigInt(off));
    if (cand == null) continue;
    scanned++;
    if (isLiveStageManager(reader, cand, o)) {
      pin.ptr = cand;
      pin.lastStatus = "";
      return cand;
    }
    // Capture the first candidate's failure reason for diagnostics.
    // readParty returns a status string explaining why heroes is null — this
    // lets us distinguish "HeroList ptr null" (offset wrong) from "party empty"
    // (offset right but no heroes) from "count exceeds MAX" (offset wrong).
    if (firstFailStatus == null) {
      const party = readParty(reader, cand, o);
      if (party.status) firstFailStatus = party.status;
    }
  }
  pin.lastStatus =
    scanned === 0
      ? "StageManager static block scan: no plausible pointers found"
      : `StageManager static block scan: ${scanned} candidate(s) but none passed isLiveStageManager (party not deployed / in menu / runtime.heroList offset suspect); first fail=${firstFailStatus ?? "n/a"}`;
  return null;
}

// ── Live chest drops (LogManager → Dictionary<ELogType, List<GetBoxLog>>) ─────

/**
 * Decide how to commit a log shrink to `pin.lastCount`.
 *
 * Returns:
 *   - `count`            when the shrink should be committed (realign tail to count).
 *   - `null`             when the shrink looks like a transient stale read
 *                        (large non-zero delta) — caller should KEEP lastCount
 *                        unchanged and skip this tick. The next tick re-reads
 *                        and either confirms (then realigns) or recovers.
 *
 * Heuristics:
 *   - count === 0                  ⇒ new-run clear; accept (return 0).
 *   - delta == 1 (ring-buffer evict) ⇒ accept (return count).
 *   - delta > SHRINK_TRANSIENT_THRESHOLD (with count > 0)
 *                                   ⇒ suspected transient; reject (return null).
 *   - small delta                   ⇒ accept (return count).
 *
 * Without this guard, a transient ReadProcessMemory read of a stale/partial
 * _size value would pollute `lastCount`. The next normal tick would then scan
 * entry[transientCount..realCount-1] again and re-classify them as new
 * drops — producing phantom duplicate chest-drop / box-open / stage-clear
 * events that pollute tracker statistics.
 */
const SHRINK_TRANSIENT_THRESHOLD = 100;
function handleLogShrink(count: number, lastCountBefore: number): number | null {
  if (count >= lastCountBefore) return count;
  if (count === 0) return 0;
  if (lastCountBefore - count > SHRINK_TRANSIENT_THRESHOLD) return null;
  return count;
}

/** Chest drop category derived from GetBoxLog's EMonsterLogType field. */
export type LiveChestCategory = "common" | "rare" | "act";

/** Per-reader pin for a resolved LogManager instance pointer. */
export interface LogManagerPinState {
  ptr: bigint | null;
}

/**
 * Per-reader pin for the LogManager instance pointer and a log-list tail
 * position. `primed` guards against counting the pre-attach log backlog.
 * Shared shape for every `ELogType` bucket tailed this way (chest drops,
 * stage clears, …).
 */
export interface ChestLogPinState extends LogManagerPinState {
  lastCount: number;
  primed: boolean;
  /**
   * Tail index to (re)start scanning from on the next tick, set when a
   * mid-write entry failed to decode this tick. See `readRuntimeChestLog` for
   * the retry-until-steady logic. When `null`, scan starts at `lastCount`.
   */
  retryFrom: number | null;
  /** Consecutive ticks a single `retryFrom` entry failed to decode.
   *  When it exceeds `MAX_CHEST_LOG_RETRIES` the stuck entry is force-skipped
   *  so a permanently corrupt slot can't wedge the tail forever. */
  retryConsecutive: number;
  /**
   * Cross-tick settle: the index (`pendingIdx`) of the newest GetBoxLog entry
   * withheld last tick, together with the category (`pendingCat`) decoded at
   * the time. See `readRuntimeChestLog` — the game commits an entry's
   * monsterType across a write window, so a same-tick read can decode a
   * *provisional* value (e.g. a stage-boss rare read while monsterType is
   * still its default 0 → misclassified "common"). The withheld index is
   * re-read one tick later and its settled value depends on `pendingCat`. Both
   * are `null` when there is nothing pending.
   */
  pendingIdx: number | null;
  pendingCat: LiveChestCategory | null;
}

export function makeChestLogPinState(): ChestDropPinState {
  return {
    ptr: null,
    lastCount: 0,
    primed: false,
    retryFrom: null,
    retryConsecutive: 0,
    pendingIdx: null,
    pendingCat: null,
    tailBase: 0,
    deliveredIndices: new Set(),
  };
}

/** Per-reader pin for the GetBox (chest-drop) log tail.
 *  Extends the shared tail shape with overscan state. Dedup is by SLOT INDEX
 *  (not chest category) because two chests can legitimately drop the same kind. */
export interface ChestDropPinState extends ChestLogPinState {
  /** Lowest tail index the overscan recovery window may re-read (prime/shrink gated). */
  tailBase: number;
  /** Indices already delivered as chest drops since prime/shrink. */
  deliveredIndices: Set<number>;
}

const MAX_CHEST_LOG = 5_000;
/** Maximum consecutive ticks a single GetBoxLog entry may fail to decode before
 *  it is force-skipped. A genuine mid-write race resolves within 1-2 ticks (the
 *  writer commits monsterType in <1ms; reader polls at ~25Hz); anything persisting
 *  longer is a corrupt slot that would otherwise wedge the tail forever. */
const MAX_CHEST_LOG_RETRIES = 3;
/** Maximum number of re-read attempts for a single GetBoxLog entry.
 *  Each sample is a few µs apart (kernel call latency); 3 samples gives the
 *  writer ~10µs total to finish committing the monsterType field — enough for
 *  the typical 2-3 store-instruction sequence. Mirrors BOX_OPEN_LOG_SAMPLES.
 *  Without this, a mid-write race during boss death / stage transition (the
 *  most memory-write-dense moment) silently drops the entry, and since
 *  pin.lastCount advances past it, the drop is lost permanently — which is
 *  why boss chests (rare/act) were occasionally missed while common drops
 *  (stable memory during normal farming) were not. */
const CHEST_LOG_SAMPLES = 3;
/**
 * Overscan depth: how many already-scanned GetBox tail slots are re-read on each
 * tick so a chest drop whose monsterType was force-skipped or still half-written
 * on its first pass can be recovered once it commits. Index-deduped; bounded — a
 * slot that falls out of this window is irretrievable (covered by the log).
 */
const CHEST_OVERSCAN = 4;
const LM_STATIC_SCAN_MAX = 0x100;

/** EMonsterLogType → chest category (0 common, 1 stage boss, 2 act boss). */
function chestCategoryFromMonsterType(t: number): LiveChestCategory | null {
  if (t === 0) return "common";
  if (t === 1) return "rare";
  if (t === 2) return "act";
  return null;
}

/**
 * Read and decode a single GetBoxLog entry's category, retrying up to
 * `CHEST_LOG_SAMPLES` times against a mid-write race (the game commits
 * monsterType across a few store instructions). Returns the first *plausible*
 * category, or a valid category if one decodes, else `null` when the slot is
 * unallocated or monsterType is still garbage.
 */
function readChestCategoryAt(
  reader: MemoryReader,
  first: bigint,
  index: number,
  o: LiveOffsets,
): LiveChestCategory | null {
  for (let s = 0; s < CHEST_LOG_SAMPLES; s++) {
    const entryPtr = readPtr(reader, first + BigInt(index * 8));
    if (entryPtr == null) continue;
    const mt = readI32(reader, entryPtr + BigInt(o.runtime.getBoxLog.monsterType));
    if (mt == null) continue;
    const cat = chestCategoryFromMonsterType(mt);
    if (cat != null) return cat;
  }
  return null;
}

/** Resolve the GetBox `List<GetBoxLog>` backing array + length from a LogManager instance. */
function getBoxLogList(
  reader: MemoryReader,
  lmPtr: bigint,
  o: LiveOffsets,
): { arr: bigint; count: number } | null {
  const dictPtr = readPtr(reader, lmPtr + BigInt(o.runtime.log.logByType));
  if (dictPtr == null) return null;
  const listPtr = dictLookupIntKey(reader, dictPtr, o.runtime.log.getBoxTypeKey, o);
  if (listPtr == null) return null;
  const arr = readPtr(reader, listPtr + BigInt(o.container.listItems));
  if (arr == null) return null;
  const count = readI32(reader, listPtr + BigInt(o.container.listSize));
  if (count == null || count < 0 || count > MAX_CHEST_LOG) return null;
  return { arr, count };
}

/**
 * A LogManager candidate is valid when its `logByType` Dictionary is
 * structurally sound (dict pointer non-null, count in a plausible range,
 * entries array pointer non-null) AND, when `getBoxTypeKey` is derived,
 * the dict actually contains that key. The key-presence check is critical:
 * without it, any object whose `+logByType` offset happens to hold a
 * dict-like struct (e.g. another manager's internal dict with count 1-1000
 * + non-null entries) passes validation, but that dict belongs to a
 * different class and won't contain the GetBox/BoxOpen log-type keys —
 * causing every `dictLookupIntKey` to return null with "list not walkable".
 *
 * When `getBoxTypeKey === 0` (fallback path couldn't derive the key),
 * degrades to pure structural validation — the key-presence check is
 * skipped because we don't know which key to look for.
 *
 * This is stricter than "dict pointer non-null" but looser than "GetBox
 * bucket fully walkable" (which fails during transient mid-write races on
 * the dict or when a specific log-type bucket hasn't been created yet).
 * The key-presence check is stable across races because `getBoxTypeKey`
 * identifies a log-type bucket that is created once during the first battle
 * and never removed — it may be transiently mid-write, but never absent.
 */
/**
 * Validate that `ptr` points at a live LogManager instance by checking its
 * `logByType` Dictionary is readable and (when `getBoxTypeKey` is derived)
 * contains the GetBox bucket. Exported so the name-scan fallback in
 * LiveMemoryReader can validate class-name-resolved candidates before
 * pinning them — without this check, a wrong class with a dict-like field
 * at the `logByType` offset would be pinned and every subsequent log read
 * would return null.
 */
export function isLiveLogManager(reader: MemoryReader, ptr: bigint, o: LiveOffsets): boolean {
  const dictPtr = readPtr(reader, ptr + BigInt(o.runtime.log.logByType));
  if (dictPtr == null) return false;
  const count = readI32(reader, dictPtr + BigInt(o.dict.count));
  if (count == null || count <= 0 || count > 1000) return false;
  const entries = readPtr(reader, dictPtr + BigInt(o.dict.entries));
  if (entries == null) return false;
  // When getBoxTypeKey is derived (non-zero), require the dict to actually
  // contain that key. Without this, any object whose `+logByType` offset
  // happens to hold a dict-like struct (count 1-1000 + non-null entries)
  // passes — but that dict belongs to a different class and won't contain
  // the GetBox/BoxOpen log-type keys, causing every dict lookup to fail
  // with "list not walkable". When getBoxTypeKey is 0 (fallback path
  // couldn't derive the key), degrade to pure structural validation.
  if (o.runtime.log.getBoxTypeKey !== 0) {
    const listPtr = dictLookupIntKey(reader, dictPtr, o.runtime.log.getBoxTypeKey, o);
    if (listPtr == null) return false;
  }
  return true;
}

/**
 * Resolve the live `LogManager` instance pointer by scanning its class static
 * block for the first pointer whose `logByType` Dictionary is readable. Pinned
 * and revalidated each tick. Returns null when the TypeInfo RVA has not been
 * derived yet (`logManager === 0n`) — the offset extractor fills it at runtime.
 *
 * Shared by every log-tailing reader (chest drops, stage clears, box opens) —
 * the resolution only depends on the class anchor + a readable `logByType`
 * dict pointer as its liveness check, not on which `ELogType` bucket the
 * caller ultimately tails. Per-bucket walkability is enforced at read time by
 * each reader's `*LogList` helper, so a transiently-unreadable bucket does
 * NOT invalidate the LogManager pin (which would cascade into all log
 * readers returning null for the entire battle).
 */
export function resolveLogManager(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: LogManagerPinState,
): bigint | null {
  if (o.typeInfoRva.logManager === 0n) return null;
  if (pin.ptr != null && isLiveLogManager(reader, pin.ptr, o)) return pin.ptr;
  pin.ptr = null;

  const block = readStaticFieldsBlock(
    reader,
    gaBase,
    gaSize,
    o.typeInfoRva.logManager,
    o.il2cppClass.staticFieldsOffsets,
  );
  if (block == null) return null;

  for (let off = 0; off <= LM_STATIC_SCAN_MAX; off += 8) {
    const cand = readPtr(reader, block + BigInt(off));
    if (cand == null) continue;
    if (isLiveLogManager(reader, cand, o)) {
      pin.ptr = cand;
      return cand;
    }
  }
  return null;
}

/**
 * Cheap single-count tail probe for the GetBox log, used by the high-frequency
 * chest-trap poller (`pollChestTailFast`). Resolves the log-manager singleton +
 * GetBox list and returns ONLY the current entry count — a handful of memory
 * reads, no per-entry scan and no array/object allocation. Returns null when
 * the manager/list can't be resolved (e.g. no battle yet); callers then defer
 * to the main 25 Hz read path rather than force a decode here.
 */
export function peekGetBoxLogCount(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: ChestLogPinState,
): number | null {
  if (o.typeInfoRva.logManager === 0n) return null;
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const list = getBoxLogList(reader, lmPtr, o);
  if (list == null) return null;
  return list.count;
}

/**
 * Chest drops added to the GetBox log since the last read, classified by
 * EMonsterLogType. Tails the log by index; on first read it primes to the
 * current length (so the pre-attach backlog is not counted) and returns `[]`.
 * When the log shrinks (a new run clears it) the tail restarts from 0.
 * Returns null when the LogManager can't be resolved (offset not derived / no
 * battle) — distinct from `[]` (resolved, no new drops).
 */
export interface ReadChestLogResult {
  drops: LiveChestCategory[] | null;
  status: string;
  /**
   * Tail-position diagnostics for investigating duplicate-drop bugs. Present
   * only after priming (i.e. when `drops` is a real per-tick delta, not `null`).
   * `count` = current list length; `lastCountBefore` = tail position before
   * this read; `start` = index this read began at (0 when the log shrank);
   * `entriesRead` = number of entries scanned this tick.
   */
  debug?: {
    count: number;
    lastCountBefore: number;
    start: number;
    entriesRead: number;
    /** Index parked for the next tick because a mid-write entry couldn't decode. */
    retryFrom?: number;
    /** Consecutive ticks `retryFrom` has failed to decode (self-heal/force-skip counter). */
    retryConsecutive?: number;
    /**
     * Set when the cross-tick settle re-read last tick's withheld tail entry and
     * its category CHANGED (provisional → committed), e.g. a stage-boss chest
     * read as "common" mid-write that settled to "rare". `from` = value read
     * last tick, `to` = committed value this tick. Absent = no correction.
     */
    settled?: { idx: number; from: LiveChestCategory; to: LiveChestCategory };
  };
}

export function readRuntimeChestLog(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: ChestDropPinState,
): ReadChestLogResult {
  if (o.typeInfoRva.logManager === 0n) {
    return {
      drops: null,
      status: "typeInfoRva.logManager RVA = 0 (offset not derived for this game version)",
    };
  }
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) {
    return {
      drops: null,
      status:
        "LogManager singleton unresolved (static block scan failed — runtime.log offsets suspect or no battle yet)",
    };
  }
  const list = getBoxLogList(reader, lmPtr, o);
  if (list == null) {
    // Diagnostic: re-read the dict path to pinpoint the failure cause.
    // Without this, "dict lookup failed" gives no clue whether dictPtr is
    // null, count is 0, entries array is null, or the key simply isn't in
    // the dict — each points to a different root cause.
    const dictPtr = readPtr(reader, lmPtr + BigInt(o.runtime.log.logByType));
    let diag = "dictPtr=null";
    if (dictPtr != null) {
      const dCount = readI32(reader, dictPtr + BigInt(o.dict.count));
      const dEntries = readPtr(reader, dictPtr + BigInt(o.dict.entries));
      diag = `dictPtr=0x${dictPtr.toString(16)} count=${dCount ?? "null"} entries=${dEntries != null ? "ok" : "null"} getBoxTypeKey=${o.runtime.log.getBoxTypeKey}`;
    }
    return {
      drops: null,
      status: `GetBox log list not walkable (runtime.log.logByType dict lookup failed; ${diag})`,
    };
  }

  const { arr, count } = list;
  if (!pin.primed) {
    pin.lastCount = count;
    pin.tailBase = count; // never overscan into the attach backlog
    pin.deliveredIndices.clear();
    pin.primed = true;
    return { drops: [], status: "" };
  }

  const lastCountBefore = pin.lastCount;
  // When the log shrinks, never re-read already-tailed entries. The shrink is
  // either a memory-read race (a transient smaller value), a ring buffer
  // evicting the oldest entry, or a new run clearing the log. In every case,
  // re-reading from 0 would classify the entire history as new drops and fire
  // phantom chest-drop events. Instead, realign the tail to `count` and return
  // no drops this tick; subsequent ticks resume tailing from `count`.
  //
  // See `handleLogShrink` for the transient-race defense (large non-zero delta
  // ⇒ suspected stale _size read; keep `lastCount` unchanged and let the next
  // tick re-verify, so a transient value never pollutes `lastCount` and causes
  // phantom duplicate drops on the following tick).
  if (count < lastCountBefore) {
    const next = handleLogShrink(count, lastCountBefore);
    if (next == null) {
      return {
        drops: [],
        status: "",
        debug: { count, lastCountBefore, start: lastCountBefore, entriesRead: 0 },
      };
    }
    pin.lastCount = next;
    pin.tailBase = next;
    pin.deliveredIndices.clear();
    // A shrink invalidates any parked retry position (the log no longer has
    // that index), so reset the retry state; scanning resumes from `next`.
    pin.retryFrom = null;
    pin.retryConsecutive = 0;
    // A shrink also invalidates any withheld settle index: the log may be a
    // brand-new run whose indices mean something completely different, so a
    // stale pendingIdx would re-read an unrelated entry next tick.
    pin.pendingIdx = null;
    pin.pendingCat = null;
    return {
      drops: [],
      status: "",
      debug: { count, lastCountBefore, start: next, entriesRead: 0 },
    };
  }

  // Resume scanning from the retry position set by a prior mid-write entry
  // that failed to decode, or from the normal tail. The two are only ever set
  // together under the same list instance (an entry was being committed), so a
  // shrink-detection below that relies on `lastCountBefore` stays valid.
  const drops: LiveChestCategory[] = [];
  const first = arr + BigInt(o.container.arrayFirst);

  // Cross-tick settle for the withheld tail entry. The game commits a
  // GetBoxLog entry's monsterType across a sub-millisecond write window; a read
  // inside it can decode a *valid-looking but provisional* category — e.g. a
  // stage-boss (rare) chest read while monsterType is still its default 0 →
  // classified "common". Same-tick re-samples cannot help (all run before the
  // commit lands); only re-reading the entry on a later tick sees the committed
  // value. So the newest entry is withheld one tick: this tick we re-read last
  // tick's withheld index and emit its *settled* value (the current committed
  // category, falling back to the provisional one), then scan only *newer*
  // entries.
  const resumeFrom = pin.pendingIdx != null ? pin.pendingIdx + 1 : lastCountBefore;
  let debugSettled: { idx: number; from: LiveChestCategory; to: LiveChestCategory } | undefined =
    undefined;
  if (pin.pendingIdx != null) {
    const settledCat = readChestCategoryAt(reader, first, pin.pendingIdx, o) ?? pin.pendingCat;
    if (settledCat != null) {
      drops.push(settledCat);
      // Record a category correction (provisional → committed) for diagnostics,
      // e.g. a boss chest read as "common" that settled to "rare".
      if (settledCat !== pin.pendingCat && pin.pendingCat != null) {
        debugSettled = { idx: pin.pendingIdx, from: pin.pendingCat, to: settledCat };
      }
    }
    pin.deliveredIndices.add(pin.pendingIdx);
    pin.pendingIdx = null;
    pin.pendingCat = null;
  }

  // Overscan: besides the new entries [retryFrom-or-lastCount, count), when no
  // settle is pending also re-read the last CHEST_OVERSCAN already-scanned slots
  // so a chest drop whose monsterType was force-skipped on its first pass can be
  // recovered once it commits. Already-delivered indices are skipped (index
  // dedup); the window never goes below tailBase. When a settle is pending we
  // stick to resumeFrom = pendingIdx+1 to avoid re-reading the withheld entry.
  const settleActive = pin.pendingIdx != null;
  const overscanBottom = Math.max(pin.tailBase, lastCountBefore - CHEST_OVERSCAN);
  const baseStart = settleActive ? resumeFrom : overscanBottom;
  const start = pin.retryFrom ?? baseStart;
  let newestNewIdx: number | null = null;
  for (let i = start; i < count; i++) {
    const isNew = i >= lastCountBefore;
    // An already-delivered overscan slot is skipped (index dedup).
    if (!isNew && pin.deliveredIndices.has(i)) continue;
    // Re-read up to CHEST_LOG_SAMPLES times to defend against mid-write races:
    // the game may have allocated the entry slot but not yet committed the
    // monsterType field. A single sample in that window reads null (RPM fail)
    // or a garbage mt (non-0/1/2). Boss deaths (rare/act chests) coincide with
    // stage transitions (dense memory writes), making this race most likely
    // exactly when the drop matters most. Mirrors BOX_OPEN_LOG_SAMPLES defense.
    const cat = readChestCategoryAt(reader, first, i, o);
    if (cat != null) {
      drops.push(cat);
      pin.deliveredIndices.add(i);
      if (isNew) newestNewIdx = i;
      continue; // valid category decoded, this entry is settled *enough* to collect
    }
    // A slot we already scanned before (overscan region) that still won't decode
    // is left alone — it gets another shot on a later tick's overscan, and if it
    // never commits it silently falls out of the window (bounded).
    if (!isNew) continue;
    // A mid-write race in the NEW region: the entry slot exists but monsterType
    // isn't committed yet. Do NOT advance the tail past it (that would drop the
    // chest permanently). Park `retryFrom` at this index so the next tick
    // re-reads the same entry after the writer has finished. If the same index
    // keeps failing for MAX_CHEST_LOG_RETRIES ticks it's a corrupt slot —
    // force-skip it (pretend decoded) so we can't wedge the tail forever.
    const sameAsLast = pin.retryFrom === i;
    pin.retryConsecutive = sameAsLast ? pin.retryConsecutive + 1 : 1;
    pin.retryFrom = i;
    if (pin.retryConsecutive > MAX_CHEST_LOG_RETRIES) {
      // Force-skip a corrupt slot; keep the tail moving. NOT added to the dedup
      // set, so a later overscan re-read can still recover it. Reset counters so
      // a *later* genuine mid-write entry still gets its own retry budget.
      pin.retryFrom = null;
      pin.retryConsecutive = 0;
      continue;
    }
    // Park the tail at the failing entry; return whatever decoded so far.
    pin.lastCount = Math.min(pin.lastCount, i);
    return {
      drops,
      status: "",
      debug: {
        count,
        lastCountBefore,
        start,
        entriesRead: i - start + 1,
        retryFrom: i,
        retryConsecutive: pin.retryConsecutive,
      },
    };
  }

  // Reaching here means the scan completed without parking (no live mid-write):
  // every entry in [start, count) was decoded or force-skipped. When a genuine
  // NEW entry was decoded and it is the newest in the log (index count-1),
  // withhold it for cross-tick settle (re-read by its absolute index next tick
  // to see the committed monsterType). If the newest new slot was force-skipped
  // or the newest drop is an overscan recovery, there is nothing to settle —
  // don't withhold (withholding an already-delivered recovery would duplicate).
  pin.retryFrom = null;
  pin.retryConsecutive = 0;
  if (newestNewIdx === count - 1 && drops.length > 0) {
    // Hold the newest new entry: its category may still settle (e.g. common→rare).
    const tailCat = drops.pop() as LiveChestCategory;
    pin.pendingIdx = count - 1;
    pin.pendingCat = tailCat;
  } else {
    pin.pendingIdx = null;
    pin.pendingCat = null;
  }
  pin.lastCount = count;
  // Keep the dedup set bounded: only indices that could still be re-scanned by
  // a future overscan matter.
  const pruneBefore = Math.max(pin.tailBase, count - CHEST_OVERSCAN - 8);
  if (pruneBefore > 0) {
    for (const idx of pin.deliveredIndices) {
      if (idx < pruneBefore) pin.deliveredIndices.delete(idx);
    }
  }
  return {
    drops,
    status: "",
    debug: {
      count,
      lastCountBefore,
      start,
      entriesRead: count - start,
      settled: debugSettled,
    },
  };
}

// ── Live stage clears (LogManager → Dictionary<ELogType, List<StageClearLog>>) ─

/** Fingerprint of a fully-committed stage-clear entry — used to dedupe re-reads. */
export interface StageClearFingerprint {
  act: number;
  stage: number;
  clearTimeSec: number;
}

/** Per-reader pin for the LogManager instance pointer and the StageClear-log tail position. */
export interface StageClearPinState extends ChestLogPinState {
  /**
   * Lowest tail index the overscan recovery window may re-read. Set to `count`
   * when the reader primes (so the attach backlog is never re-delivered) and
   * when the log shrinks (old indices are gone). Without this gate, overscan
   * would re-report entries that were intentionally skipped at attach.
   */
  tailBase: number;
  /**
   * Fingerprints of stage-clear entries already delivered since prime/shrink
   * (FIFO, capped). Re-reads inside the overscan window are suppressed when
   * their fingerprint is already present — this is what prevents duplicates
   * while still letting a previously half-written entry be recovered once its
   * act/stage commit on a later tick.
   */
  delivered: StageClearFingerprint[];
}

export function makeStageClearPinState(): StageClearPinState {
  return {
    ptr: null,
    lastCount: 0,
    primed: false,
    retryFrom: null,
    retryConsecutive: 0,
    pendingIdx: null,
    pendingCat: null,
    tailBase: 0,
    delivered: [],
  };
}

const MAX_STAGE_CLEAR_LOG = 5_000;
/** Reject implausible clear times (corrupted memory / mid-write read). */
const MAX_CLEAR_TIME_SEC = 36_000;
/** Maximum number of re-read attempts for a single StageClearLog entry.
 *  Same mid-write race defense as CHEST_LOG_SAMPLES / BOX_OPEN_LOG_SAMPLES:
 *  stage clear entries are written right when the player finishes a stage
 *  (dense memory activity), so a single sample may read entryPtr allocated
 *  but clearTimeSec/act/stage fields not yet committed. Without retry the
 *  entry is dropped silently and pin.lastCount advances past it — the clear
 *  is lost permanently. */
const STAGE_CLEAR_LOG_SAMPLES = 3;
/**
 * Overscan depth: how many already-scanned tail slots are re-read on each tick
 * so a stage-clear entry that was half-written on its first read (act/stage not
 * yet committed) can be recovered on the next tick once it completes. Bounded —
 * a slot that falls out of this window is irretrievable (covered by the log).
 */
const STAGE_CLEAR_OVERSCAN = 4;
/** Max delivered fingerprints retained for overscan dedup. Must comfortably
 *  exceed STAGE_CLEAR_OVERSCAN plus any per-tick append burst so a re-read of a
 *  just-delivered slot is always caught. */
const STAGE_CLEAR_FINGERPRINT_CAP = 32;

function stageClearFpEqual(a: StageClearFingerprint, b: StageClearFingerprint): boolean {
  return a.act === b.act && a.stage === b.stage && a.clearTimeSec === b.clearTimeSec;
}
function stageClearFpHas(arr: StageClearFingerprint[], fp: StageClearFingerprint): boolean {
  return arr.some((x) => stageClearFpEqual(x, fp));
}
function stageClearFpPush(arr: StageClearFingerprint[], fp: StageClearFingerprint): void {
  arr.push(fp);
  const overflow = arr.length - STAGE_CLEAR_FINGERPRINT_CAP;
  if (overflow > 0) arr.splice(0, overflow);
}

/**
 * Plausible cleared-stage `act`: 1-digits (1-9) for normal stages, or the
 * plague (Contaminated) region acts 21/22/23. Anything else is a corrupted /
 * mid-write read.
 */
function isPlausibleClearAct(act: number | null): boolean {
  return act != null && act >= 1 && (act <= 9 || (act >= 21 && act <= 23));
}

/** Resolve the StageClear `List<StageClearLog>` backing array + length from a LogManager instance. */
function stageClearLogList(
  reader: MemoryReader,
  lmPtr: bigint,
  o: LiveOffsets,
): { arr: bigint; count: number } | null {
  const dictPtr = readPtr(reader, lmPtr + BigInt(o.runtime.log.logByType));
  if (dictPtr == null) return null;
  const listPtr = dictLookupIntKey(reader, dictPtr, o.runtime.log.stageClearTypeKey, o);
  if (listPtr == null) return null;
  const arr = readPtr(reader, listPtr + BigInt(o.container.listItems));
  if (arr == null) return null;
  const count = readI32(reader, listPtr + BigInt(o.container.listSize));
  if (count == null || count < 0 || count > MAX_STAGE_CLEAR_LOG) return null;
  return { arr, count };
}

/**
 * StageClearLog entries added since the last read. Tails the log by index the
 * same way {@link readRuntimeChestLog} tails GetBox: primes to the current
 * length on first read (backlog not counted) and returns `[]`; when the log
 * shrinks it realigns the tail to `count` and returns `[]` (never re-reads
 * history, see {@link readRuntimeChestLog} for rationale). Returns null when
 * the LogManager can't be resolved — distinct from `[]` (resolved, no new
 * clears this tick).
 *
 * Each entry carries the **cleared** stage's `act`/`stage` (read from
 * StageClearLog+0x40 / +0x44) plus `clearTimeSec`. The log entry does NOT
 * carry difficulty — the caller combines `act`/`stage` with the difficulty
 * digit of the current live/save stageKey to form a full stageKey. This
 * avoids the off-by-one stage attribution bug where a clear of 3-1 was
 * recorded as 3-2 because `stageKey` had already advanced by the next tick.
 *
 * Implausible `clearTimeSec` (≤0 or ≥MAX_CLEAR_TIME_SEC) entries are skipped
 * entirely. When `act`/`stage` read as 0 or out of plausibility range, the
 * entry is still returned (with `act`/`stage` set to 0) so the caller can
 * fall back to the current stageKey for that entry while preserving the
 * clear-time sample.
 */
export function readRuntimeStageClears(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: StageClearPinState,
): StageClearEntry[] | null {
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const list = stageClearLogList(reader, lmPtr, o);
  if (list == null) return null;

  const { arr, count } = list;
  const actOff = BigInt(o.runtime.stageClearLog.act);
  const stageOff = BigInt(o.runtime.stageClearLog.stage);
  const clearTimeOff = BigInt(o.runtime.stageClearLog.clearTimeSec);
  const out = scanLogBucket<StageClearEntry>(
    reader,
    o,
    arr + BigInt(o.container.arrayFirst),
    count,
    {
      readSlot: (r, first, i, _o, isNew) => {
        // Re-read up to STAGE_CLEAR_LOG_SAMPLES times to defend against mid-write
        // races: stage clear entries are written exactly when the player finishes
        // a stage (dense memory activity). A single sample may read entryPtr
        // allocated but clearTimeSec/act/stage fields not yet committed.
        let clearTimeSec: number | null = null;
        let act: number | null = null;
        let stage: number | null = null;
        for (let s = 0; s < STAGE_CLEAR_LOG_SAMPLES; s++) {
          const entryPtr = readPtr(r, first + BigInt(i * 8));
          if (entryPtr == null) continue; // retry next sample
          clearTimeSec = readI32(r, entryPtr + clearTimeOff);
          if (clearTimeSec == null || clearTimeSec <= 0 || clearTimeSec >= MAX_CLEAR_TIME_SEC) {
            continue; // retry next sample
          }
          act = readI32(r, entryPtr + actOff);
          stage = readI32(r, entryPtr + stageOff);
          // act is 1-digit (1-9) for normal stages, 2-digit (21-23) for plague;
          // stage is 1-99. 0 or out-of-range ⇒ corrupted / mid-write read.
          const actValid = isPlausibleClearAct(act);
          const stageValid = stage != null && stage >= 1 && stage <= 99;
          if (actValid && stageValid) {
            return { kind: "ok", entry: { act: act!, stage: stage!, clearTimeSec, valid: true } };
          }
        }
        // Never read a fully-valid entry. If there's no plausible clear-time
        // either, skip entirely (cannot record a clear without one).
        if (clearTimeSec == null || clearTimeSec <= 0 || clearTimeSec >= MAX_CLEAR_TIME_SEC) {
          return { kind: "skip", bad: "bad" };
        }
        // Half-written act/stage with a plausible clear-time. Surface the
        // valid=false probe only for genuinely NEW entries so a chronically-corrupt
        // overscan slot isn't re-reported every tick; the caller drops it and once
        // it commits a later overscan re-read delivers it (valid). Falling back to
        // the live stageKey would re-introduce the off-by-one attribution bug.
        if (!isNew) return { kind: "skip", bad: "bad" };
        const actValid = isPlausibleClearAct(act);
        const stageValid = stage != null && stage >= 1 && stage <= 99;
        return {
          kind: "ok",
          entry: {
            act: actValid ? act! : 0,
            stage: stageValid ? stage! : 0,
            clearTimeSec,
            valid: actValid && stageValid,
          },
        };
      },
      overscan: STAGE_CLEAR_OVERSCAN,
      maxRetries: 3, // stage never parks; kept for the shared scanner contract
    },
    {
      // Stage clears dedup by fingerprint (act, stage, clearTimeSec).
      isDelivered: (e) =>
        stageClearFpHas(pin.delivered, {
          act: e.act,
          stage: e.stage,
          clearTimeSec: e.clearTimeSec,
        }),
      markDelivered: (e) =>
        stageClearFpPush(pin.delivered, {
          act: e.act,
          stage: e.stage,
          clearTimeSec: e.clearTimeSec,
        }),
      clearDelivered: () => {
        pin.delivered = [];
      },
      pruneDelivered: () => {
        /* fp capacity is bounded by stageClearFpPush; nothing to prune by index */
      },
    },
    pin,
  );

  if (out.mode === "prime" || out.mode === "shrink-stale" || out.mode === "shrink-realigned") {
    return [];
  }
  return out.added.map((x) => x.entry);
}

// ── Live box opens (LogManager → Dictionary<ELogType, List<BoxOpenLog>>) ─────

/** Per-reader pin for the BoxOpenLog tail. Same shape as chest/stage-clear pins. */
export interface BoxOpenPinState extends ChestLogPinState {
  /**
   * Lowest tail index the overscan recovery window may re-read. Set to `count`
   * on prime (so the attach backlog is never re-delivered) and on shrink (old
   * indices are gone). Mirrors {@link StageClearPinState.tailBase}.
   */
  tailBase: number;
  /**
   * Indices already delivered as valid box opens since prime/shrink. Overscan
   * re-reads of a just-delivered slot are suppressed by checking this — box
   * opens are deduped by SLOT INDEX, not by item value, because two boxes in a
   * burst can legitimately drop the same item and a value fingerprint would
   * wrongly collapse them.
   */
  deliveredIndices: Set<number>;
}

export function makeBoxOpenPinState(): BoxOpenPinState {
  return {
    ptr: null,
    lastCount: 0,
    primed: false,
    retryFrom: null,
    retryConsecutive: 0,
    pendingIdx: null,
    pendingCat: null,
    tailBase: 0,
    deliveredIndices: new Set(),
  };
}

const MAX_BOX_OPEN_LOG = 5_000;

/** Maximum number of re-read attempts for a single BoxOpenLog entry.
 *  Each sample is a few µs apart (kernel call latency); 3 samples gives the
 *  writer ~10µs total to finish committing fields — enough for the typical
 *  2-3 store-instruction sequence the game uses to append a log entry. */
const BOX_OPEN_LOG_SAMPLES = 3;
/**
 * Overscan depth — MUST be ≥ the largest plausible one-shot "open N boxes"
 * batch. When the game bumps the BoxOpenLog size first and then finishes
 * committing itemKey per slot, later slots of a batch (which the writer
 * commits in index order) are still half-written on the ticks we scan them,
 * get parked then force-skipped, and by the time their itemKey finally commits
 * the advancing tail has pushed them out of a small window → silent loss
 * proportional to batch size (open 20 → lose ~2). A wide window keeps every
 * force-skipped slot re-scanable until it either resolves or the log is
 * genuinely consumed/covered. Cost is negligible and bounded because
 * index-dedup suppresses re-emission of already-delivered slots.
 */
const BOX_OPEN_OVERSCAN = 64;

/**
 * Maximum consecutive ticks a single BoxOpenLog entry may fail to decode
 * before it is force-skipped. A genuine mid-write race resolves within 1-2
 * ticks, but the FIRST entry of a batch waits for its (String-ref) itemKey,
 * which the game commits last — give it a wider budget so it isn't force-skipped
 * while still eventually committing. Anything persisting this long is a corrupt
 * slot that would otherwise wedge the tail forever. Mirrors MAX_CHEST_LOG_RETRIES.
 */
const MAX_BOX_OPEN_LOG_RETRIES = 6;

/** Resolve the GetItemWithBoxOpen List<BoxOpenLog> backing array + length. */
function boxOpenLogList(
  reader: MemoryReader,
  lmPtr: bigint,
  o: LiveOffsets,
): { arr: bigint; count: number } | null {
  const dictPtr = readPtr(reader, lmPtr + BigInt(o.runtime.log.logByType));
  if (dictPtr == null) return null;
  const listPtr = dictLookupIntKey(reader, dictPtr, o.runtime.log.getItemWithBoxOpenTypeKey, o);
  if (listPtr == null) return null;
  const arr = readPtr(reader, listPtr + BigInt(o.container.listItems));
  if (arr == null) return null;
  const count = readI32(reader, listPtr + BigInt(o.container.listSize));
  if (count == null || count < 0 || count > MAX_BOX_OPEN_LOG) return null;
  return { arr, count };
}

export interface ReadBoxOpenLogResult {
  opens: BoxOpenEntry[] | null;
  status: string;
  /**
   * Entry-level diagnostics for investigating "box opens never fire" bugs.
   * Present only when the log was walked (i.e. `opens` is a real per-tick
   * delta, not null). `scanned` = entries examined this tick; `parsed` =
   * entries that decoded a valid itemKey; `nullEntry` = entry pointer read
   * failed across all samples; `badItemKey` = entry resolved but itemKey
   * couldn't be decoded. When `parsed` stays 0 while `scanned` grows, the
   * `boxOpenLog.itemStringKey` offset (or the field-layout decoder) is the
   * culprit — not the list walk.
   */
  debug?: {
    scanned: number;
    parsed: number;
    nullEntry: number;
    badItemKey: number;
    count: number;
    lastCountBefore: number;
    start: number;
    /** Decoded-ok slots suppressed by index-dedup (already delivered this lineage). */
    dedupSkipped?: number;
    /** Indexes force-skipped this tick (undecodable past MAX retries). */
    forcedIndexes?: number[];
    /** Index parked for the next tick because a mid-write entry couldn't decode. */
    retryFrom?: number;
    /** Consecutive ticks `retryFrom` has failed to decode (self-heal/force-skip counter). */
    retryConsecutive?: number;
  };
}

export interface PeekBoxOpenLogCountResult {
  count: number | null;
  status: string;
}

/**
 * Lightweight probe of the BoxOpenLog list length WITHOUT reading entries.
 *
 * Used by the heal scheduler to detect "player just opened a box" so it can
 * re-trigger enrichment extraction (which only succeeds once the game has
 * instantiated `BoxOpenLog`). Unlike {@link readRuntimeBoxOpenLog}, this does
 * NOT require `boxOpenLog.itemStringKey`/`itemGradeType` — only the
 * already-derived `logManager` + `logByType` + `getItemWithBoxOpenTypeKey`.
 * When those are 0 (very first launch, no anchor yet), the function returns
 * `{count: null}` and the caller treats it as "no signal yet".
 *
 * `pin` is used purely to cache the resolved LogManager pointer across ticks;
 * `lastCount`/`primed` are not touched (this probe is independent of the
 * tail-position bookkeeping used by {@link readRuntimeBoxOpenLog}).
 */
export function peekBoxOpenLogCount(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: LogManagerPinState,
): PeekBoxOpenLogCountResult {
  if (o.typeInfoRva.logManager === 0n) {
    return { count: null, status: "typeInfoRva.logManager RVA = 0" };
  }
  if (!o.runtime.log.getItemWithBoxOpenTypeKey) {
    return { count: null, status: "getItemWithBoxOpenTypeKey = 0" };
  }
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) {
    return { count: null, status: "LogManager singleton unresolved" };
  }
  const list = boxOpenLogList(reader, lmPtr, o);
  if (list == null) {
    return { count: null, status: "BoxOpenLog list not walkable" };
  }
  return { count: list.count, status: "" };
}

/**
 * One-slot decode result for the shared log-bucket scanner.
 *   - `ok`:    decoded a deliverable entry.
 *   - `skip`:  slot not decodable this tick and NOT a new-region mid-write —
 *              leave it; a later overscan re-read recovers it (bounded).
 *   - `park`:  a NEW-region mid-write — stop the tail at this index so the
 *              next tick retries it (box-open / chest semantics).
 * `bad` classifies the rejection for debug counters (null-ptr / bad-itemKey).
 */
type SlotDecode<T> =
  | { kind: "ok"; entry: T }
  | { kind: "skip"; bad: "null" | "bad" }
  | { kind: "park"; bad: "null" | "bad" };

/** Tail/retry state the scanner mutates (shared by every in-memory log bucket). */
interface LogScanState {
  lastCount: number;
  primed: boolean;
  tailBase: number;
  retryFrom: number | null;
  retryConsecutive: number;
}

/** Dedup container operations for a bucket (box/chest = slot index; stage = fingerprint). */
interface LogScanDeliver<T> {
  isDelivered(entry: T, index: number): boolean;
  markDelivered(entry: T, index: number): void;
  clearDelivered(): void;
  pruneDelivered(belowIndex: number): void;
}

interface LogScanOut<T> {
  mode: "prime" | "shrink-realigned" | "shrink-stale" | "scan";
  added: { index: number; entry: T }[];
  scanned: number;
  parsed: number;
  nullEntry: number;
  badItemKey: number;
  /** Decoded-ok slots that were suppressed by the bucket's dedup (already delivered). */
  dedupSkipped: number;
  /** Indexes force-skipped this call (undecodable past `maxRetries` ticks). */
  forcedIndexes?: number[];
  count: number;
  lastCountBefore: number;
  start: number;
  retryFrom?: number;
  retryConsecutive?: number;
}

/**
 * Shared log-bucket tail scanner used by the BoxOpen and StageClear readers.
 * It owns the parts the two readers share verbatim: prime, shrink handling,
 * overscan-window start, per-index scan, index/fingerprint dedup, mid-write
 * park+force-skip, and `lastCount` advancement. Each bucket injects how to
 * decode a slot (`readSlot`), how large its overscan window is, and how to
 * dedup delivered entries.
 */
function scanLogBucket<T>(
  reader: MemoryReader,
  o: LiveOffsets,
  first: bigint, // arr + container.arrayFirst
  count: number,
  cfg: {
    readSlot(
      reader: MemoryReader,
      first: bigint,
      i: number,
      o: LiveOffsets,
      isNew: boolean,
    ): SlotDecode<T>;
    overscan: number;
    maxRetries: number;
  },
  deliver: LogScanDeliver<T>,
  state: LogScanState,
): LogScanOut<T> {
  const lastCountBefore = state.lastCount;
  if (!state.primed) {
    state.lastCount = count;
    state.tailBase = count; // never overscan into the attach backlog
    state.retryFrom = null;
    state.retryConsecutive = 0;
    state.primed = true;
    return {
      mode: "prime",
      added: [],
      scanned: 0,
      parsed: 0,
      nullEntry: 0,
      badItemKey: 0,
      dedupSkipped: 0,
      count,
      lastCountBefore: count,
      start: count,
    };
  }

  if (count < lastCountBefore) {
    // See `handleLogShrink` for the transient-race defense rationale. A real
    // shrink invalidates any parked retry position and the dedup set — the old
    // indices are gone, so re-reading them would classify history as new.
    const next = handleLogShrink(count, lastCountBefore);
    if (next == null) {
      return {
        mode: "shrink-stale",
        added: [],
        scanned: 0,
        parsed: 0,
        nullEntry: 0,
        badItemKey: 0,
        dedupSkipped: 0,
        count,
        lastCountBefore,
        start: lastCountBefore,
      };
    }
    state.lastCount = next;
    state.tailBase = next;
    state.retryFrom = null;
    state.retryConsecutive = 0;
    deliver.clearDelivered();
    return {
      mode: "shrink-realigned",
      added: [],
      scanned: 0,
      parsed: 0,
      nullEntry: 0,
      badItemKey: 0,
      dedupSkipped: 0,
      count,
      lastCountBefore,
      start: next,
    };
  }

  // Overscan: besides the new entries [lastCount, count), also re-read the last
  // `overscan` already-scanned slots so an entry that was force-skipped or still
  // half-written on its first pass can be recovered once it commits. Re-reads of
  // already-delivered slots are suppressed (dedup); the window never goes below
  // tailBase (the attach backlog / post-shrink data is out of scope).
  const start = state.retryFrom ?? Math.max(state.tailBase, lastCountBefore - cfg.overscan);
  const added: { index: number; entry: T }[] = [];
  let scanned = 0;
  let parsed = 0;
  let nullEntry = 0;
  let badItemKey = 0;
  let dedupSkipped = 0;
  const forcedIndexes: number[] = [];
  for (let i = start; i < count; i++) {
    const isNew = i >= lastCountBefore;
    scanned++;
    const decode = cfg.readSlot(reader, first, i, o, isNew);
    if (decode.kind === "ok") {
      // Dedup is delegated to the bucket: index-dedup (box) lets genuinely-new
      // slots always deliver and only suppresses overscan re-reads; fingerprint
      // dedup (stage) suppresses any re-delivery, new or re-read.
      if (deliver.isDelivered(decode.entry, i)) {
        dedupSkipped++;
      } else {
        added.push({ index: i, entry: decode.entry });
        deliver.markDelivered(decode.entry, i);
        parsed++;
      }
      continue;
    }
    if (decode.bad === "null") nullEntry++;
    else badItemKey++;
    if (decode.kind === "skip") {
      // Overscan / half-write slot that stays undecodable — leave it; a later
      // overscan re-read may recover it once the writer commits (bounded).
      continue;
    }
    // `park`: a NEW-region mid-write. Do NOT advance the tail past it (that would
    // drop it permanently). Stop at this index so the next tick re-reads the same
    // entry after the writer finishes. If the same index keeps failing for
    // `maxRetries` ticks it's a corrupt slot — force-skip it so we can't wedge
    // the tail forever. (Not delivered, so an overscan re-read can still recover
    // a later commit.)
    const sameAsLast = state.retryFrom === i;
    state.retryConsecutive = sameAsLast ? state.retryConsecutive + 1 : 1;
    state.retryFrom = i;
    if (state.retryConsecutive > cfg.maxRetries) {
      state.retryFrom = null;
      state.retryConsecutive = 0;
      forcedIndexes.push(i);
      continue;
    }
    state.lastCount = Math.min(state.lastCount, i);
    state.retryFrom = i;
    return {
      mode: "scan",
      added,
      scanned,
      parsed,
      nullEntry,
      badItemKey,
      dedupSkipped,
      count,
      lastCountBefore,
      start,
      retryFrom: i,
      retryConsecutive: state.retryConsecutive,
    };
  }
  state.retryFrom = null;
  state.retryConsecutive = 0;
  state.lastCount = count;
  // Keep the dedup set bounded: only indices that could still be re-scanned by a
  // future overscan matter.
  deliver.pruneDelivered(Math.max(state.tailBase, count - cfg.overscan - 8));
  return {
    mode: "scan",
    added,
    scanned,
    parsed,
    nullEntry,
    badItemKey,
    dedupSkipped,
    forcedIndexes,
    count,
    lastCountBefore,
    start,
  };
}

/**
 * Box opens added to the GetItemWithBoxOpen log since the last read. Tails the
 * log by index the same way {@link readRuntimeChestLog} tails GetBox: primes
 * to the current length on first read (backlog not counted) and returns `[]`;
 * when the log shrinks it realigns the tail to `count` and returns `[]` (never
 * re-reads history, see {@link readRuntimeChestLog} for rationale). Returns
 * null when the LogManager can't be resolved or the
 * `getItemWithBoxOpenTypeKey` offset is not derived (0).
 */
export function readRuntimeBoxOpenLog(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: BoxOpenPinState,
): ReadBoxOpenLogResult {
  if (o.typeInfoRva.logManager === 0n) {
    return {
      opens: null,
      status: "typeInfoRva.logManager RVA = 0 (offset not derived for this game version)",
    };
  }
  if (!o.runtime.log.getItemWithBoxOpenTypeKey) {
    return {
      opens: null,
      status:
        "getItemWithBoxOpenTypeKey = 0 (ELogType.GetItemWithBoxOpen not derived for this game version)",
    };
  }
  if (!o.runtime.boxOpenLog?.itemStringKey) {
    return {
      opens: null,
      status: "boxOpenLog.itemStringKey = 0 (struct offsets not derived for this game version)",
    };
  }
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) {
    return { opens: null, status: "LogManager singleton unresolved (static block scan failed)" };
  }
  const list = boxOpenLogList(reader, lmPtr, o);
  if (list == null) {
    // Diagnostic: re-read the dict path to pinpoint the failure cause.
    const dictPtr = readPtr(reader, lmPtr + BigInt(o.runtime.log.logByType));
    let diag = "dictPtr=null";
    if (dictPtr != null) {
      const dCount = readI32(reader, dictPtr + BigInt(o.dict.count));
      const dEntries = readPtr(reader, dictPtr + BigInt(o.dict.entries));
      diag = `dictPtr=0x${dictPtr.toString(16)} count=${dCount ?? "null"} entries=${dEntries != null ? "ok" : "null"} boxOpenTypeKey=${o.runtime.log.getItemWithBoxOpenTypeKey}`;
    }
    return { opens: null, status: `BoxOpenLog list not walkable (dict lookup failed; ${diag})` };
  }

  const { arr, count } = list;
  const out = scanLogBucket<BoxOpenEntry>(
    reader,
    o,
    arr + BigInt(o.container.arrayFirst),
    count,
    {
      readSlot: (r, first, i, oo, isNew) => {
        // Multi-sample: the game appends BoxOpenLog entries while we iterate. A
        // single sample taken mid-write may see the slot allocated but the
        // itemKey/boxType/level fields not yet committed — yielding a null
        // itemKey and the entry being silently dropped. Re-read up to
        // BOX_OPEN_LOG_SAMPLES times until itemKey resolves; the few-µs delay
        // between samples is enough for the writer to finish committing fields.
        let result: BoxOpenEntryRead = { ok: false, reason: "null-ptr" };
        for (let s = 0; s < BOX_OPEN_LOG_SAMPLES; s++) {
          result = readBoxOpenLogEntry(r, first + BigInt(i * 8), oo);
          if (result.ok) break;
        }
        if (result.ok) return { kind: "ok", entry: result.entry };
        const bad = result.reason === "null-ptr" ? "null" : "bad";
        // Overscan re-read of a slot that still won't decode → skip (bounded).
        // A new-region mid-write → park so the next tick retries it.
        return isNew ? { kind: "park", bad } : { kind: "skip", bad };
      },
      overscan: BOX_OPEN_OVERSCAN,
      maxRetries: MAX_BOX_OPEN_LOG_RETRIES,
    },
    {
      // Box opens are deduped by slot index, not item value, so a burst that
      // drops the same item twice is still fully recorded.
      isDelivered: (_entry, i) => pin.deliveredIndices.has(i),
      markDelivered: (_entry, i) => {
        pin.deliveredIndices.add(i);
      },
      clearDelivered: () => pin.deliveredIndices.clear(),
      pruneDelivered: (below) => {
        if (below <= 0) return;
        for (const idx of pin.deliveredIndices) {
          if (idx < below) pin.deliveredIndices.delete(idx);
        }
      },
    },
    pin,
  );

  if (out.mode === "prime") return { opens: [], status: "" };
  if (out.mode === "shrink-stale") return { opens: [], status: "" };
  if (out.mode === "shrink-realigned") {
    return {
      opens: [],
      status: "",
      debug: {
        scanned: 0,
        parsed: 0,
        nullEntry: 0,
        badItemKey: 0,
        dedupSkipped: 0,
        count,
        lastCountBefore: out.lastCountBefore,
        start: out.start,
      },
    };
  }
  const opens = out.added.map((x) => x.entry);
  if (out.retryFrom != null) {
    // Parked the tail at a new-region mid-write; return what decoded so far.
    return {
      opens,
      status: "",
      debug: {
        scanned: out.scanned,
        parsed: out.parsed,
        nullEntry: out.nullEntry,
        badItemKey: out.badItemKey,
        dedupSkipped: out.dedupSkipped,
        forcedIndexes: out.forcedIndexes,
        count,
        lastCountBefore: out.lastCountBefore,
        start: out.start,
        retryFrom: out.retryFrom,
        retryConsecutive: out.retryConsecutive,
      },
    };
  }
  return {
    opens,
    status: "",
    debug: {
      scanned: out.scanned,
      parsed: out.parsed,
      nullEntry: out.nullEntry,
      badItemKey: out.badItemKey,
      dedupSkipped: out.dedupSkipped,
      forcedIndexes: out.forcedIndexes,
      count,
      lastCountBefore: out.lastCountBefore,
      start: out.start,
    },
  };
}

/** Pins for all three in-memory log buckets (tail state stays bucket-local). */
export interface UnifiedLogPins {
  chest: ChestDropPinState;
  boxOpen: BoxOpenPinState;
  stageClear: StageClearPinState;
}

/** Result of reading all three logs in one pass, ready to split into a snapshot. */
export interface UnifiedLogsResult {
  connected: boolean;
  chestDrops: LiveChestCategory[] | null;
  boxOpens: BoxOpenEntry[] | null;
  stageClears: StageClearEntry[] | null;
  statusByKind: { chest?: string; boxOpen?: string; stageClear?: string };
  debugByKind?: { chest?: unknown; boxOpen?: unknown; stageClear?: unknown };
}

/**
 * Read ALL in-memory logs (chest drops GetBox, box opens GetItemWithBoxOpen,
 * stage clears StageClear) in one call. Resolves the LogManager once, walks each
 * ELogType bucket, and returns a single result the three consumers split from.
 * Keeps the per-bucket null semantics of the individual readers (`[]` = active
 * but nothing new; `null` = log unavailable), so the caller can map these onto
 * `LiveMemorySnapshot` unchanged.
 */
export function readRuntimeAllLogs(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pins: UnifiedLogPins,
): UnifiedLogsResult {
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pins.chest);
  if (o.typeInfoRva.logManager === 0n || lmPtr == null) {
    // No live LogManager → all three logs are unavailable (null, not []).
    return {
      connected: false,
      chestDrops: null,
      boxOpens: null,
      stageClears: null,
      statusByKind: {
        chest: "LogManager unavailable (RVA not derived or singleton unresolved)",
        boxOpen: "LogManager unavailable (RVA not derived or singleton unresolved)",
        stageClear: "LogManager unavailable (RVA not derived or singleton unresolved)",
      },
    };
  }

  const chest = readRuntimeChestLog(reader, gaBase, gaSize, o, pins.chest);
  const box = readRuntimeBoxOpenLog(reader, gaBase, gaSize, o, pins.boxOpen);
  const stage = readRuntimeStageClears(reader, gaBase, gaSize, o, pins.stageClear);

  return {
    connected: chest.drops !== null || box.opens !== null || stage !== null,
    chestDrops: chest.drops,
    boxOpens: box.opens,
    stageClears: stage,
    statusByKind: {
      chest: chest.status || undefined,
      boxOpen: box.status || undefined,
      stageClear: stage !== null ? undefined : "StageClear log unavailable",
    },
    debugByKind: {
      chest: chest.debug,
      boxOpen: box.debug,
      stageClear: undefined,
    },
  };
}

/** Outcome of reading one BoxOpenLog entry, distinguishing the two rejection
 *  causes so the reader can report which one is dominating. */
type BoxOpenEntryRead =
  | { ok: true; entry: BoxOpenEntry }
  | { ok: false; reason: "null-ptr" | "bad-itemKey" };

/** Read one BoxOpenLog entry. Returns `null-ptr` when the slot pointer is
 *  unreadable, `bad-itemKey` when the entry resolved but the itemKey field
 *  couldn't be decoded (caller may retry). */
function readBoxOpenLogEntry(
  reader: MemoryReader,
  slotPtr: bigint,
  o: LiveOffsets,
): BoxOpenEntryRead {
  const entryPtr = readPtr(reader, slotPtr);
  if (entryPtr == null) return { ok: false, reason: "null-ptr" };
  const itemKey = readBoxOpenLogField(reader, entryPtr, o.runtime.boxOpenLog.itemStringKey, true);
  if (itemKey == null || itemKey <= 0) return { ok: false, reason: "bad-itemKey" };

  const entry: BoxOpenEntry = { itemKey };
  if (o.runtime.boxOpenLog.boxType) {
    const boxType = readBoxOpenLogField(reader, entryPtr, o.runtime.boxOpenLog.boxType);
    if (boxType != null) entry.boxType = boxType;
  }
  if (o.runtime.boxOpenLog.level) {
    const level = readBoxOpenLogField(reader, entryPtr, o.runtime.boxOpenLog.level);
    if (level != null && level > 0) entry.level = level;
  }
  // Grade: v1.00.28 moved this to a GradeSO ScriptableObject reference.
  // Pre-1.00.28 has it as a plain int field (itemGradeType).
  if (o.runtime.boxOpenLog.gradeSO && o.runtime.boxOpenLog.gradeSOGrade) {
    const gradeSO = readPtr(reader, entryPtr + BigInt(o.runtime.boxOpenLog.gradeSO));
    if (gradeSO != null) {
      const gradeType = readI32(reader, gradeSO + BigInt(o.runtime.boxOpenLog.gradeSOGrade));
      if (gradeType != null && gradeType >= 0) entry.gradeType = gradeType;
    }
  } else if (o.runtime.boxOpenLog.itemGradeType) {
    const gradeType = readBoxOpenLogField(reader, entryPtr, o.runtime.boxOpenLog.itemGradeType);
    if (gradeType != null && gradeType >= 0) entry.gradeType = gradeType;
  }
  return { ok: true, entry };
}

/**
 * Read one BoxOpenLog int field, transparently handling three field layouts
 * seen across game versions:
 *  - plain int32 (v1.00.21/23/27): non-negative int passes through unchanged.
 *  - System.String pointer (v1.00.28 itemStringKey): pointer → IL2CPP String
 *    → UTF-16 chars → parse as int. The string may be a localization key like
 *    "ItemName_530017"; trailing digits are extracted as the catalog itemKey.
 *    Only attempted when `allowString` is true (itemStringKey field) — boxType
 *    and level fields are never string pointers, so passing false avoids
 *    misreading unrelated managed-object pointers as strings.
 *  - ACTk ObscuredInt (v1.00.28+ renamed fields): hiddenValue + currentCryptoKey
 *    8-byte struct, decoded via local `decodeObscuredInt(hidden, key)`.
 *
 * For itemStringKey (`allowString=true`), the String-pointer path is tried
 * FIRST. This is critical because v1.00.28's String pointer's low 32 bits can
 * coincidentally fall in the catalog id range (e.g. 600017) — a plain
 * `readI32` would accept that garbage value as a "plausible" itemKey and
 * never reach the String decoder. Trying String first lets the IL2CPP String
 * reader validate the pointer: real String pointers decode to a stable
 * catalog id (so reclassify persists across app restarts — the heap address
 * changes each launch but the extracted id doesn't), while plain-int32 fields
 * fail the String read (address isn't a real String object) and fall back to
 * the raw int32.
 */
function readBoxOpenLogField(
  reader: MemoryReader,
  entryPtr: bigint,
  offset: number,
  allowString = false,
): number | null {
  if (offset <= 0) return null;

  // For itemStringKey: try String pointer path first. readPtr reads the full
  // 8-byte pointer and rejects implausibly-low values (< 0x10000). If the
  // field is actually a plain int32 (older game versions), the "pointer" read
  // either fails readPtr's plausibility gate or the target isn't a real
  // IL2CPP String, so we fall back to the raw int32 below. This ordering means
  // String-pointer fields always decode to the catalog id embedded in the
  // localization key, regardless of whether the pointer's low dword happens
  // to look like a plausible itemKey.
  if (allowString) {
    const ptrVal = readPtr(reader, entryPtr + BigInt(offset));
    if (ptrVal != null) {
      const s = readIl2CppString(reader, ptrVal);
      if (s != null) {
        // Accept pure-numeric strings ("530017") OR localization keys whose
        // trailing digit run is the catalog itemKey ("ItemName_530017" → 530017).
        const direct = /^[0-9]+$/.test(s) ? s : (s.match(/(\d+)$/) ?? [])[1];
        if (direct != null) {
          const parsed = Number.parseInt(direct, 10);
          if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
        }
      }
      // ptrVal is a plausible 64-bit pointer but its target isn't a readable
      // String. Two sub-cases:
      //   (a) Real String pointer (v1.00.28) with unreadable/uninitialized
      //       target → the low 32 bits are a heap-address low dword (garbage,
      //       usually outside [110001, 939999]). Returning it would let
      //       /1000-normalization accidentally map it into the valid catalog
      //       range (e.g. 0x15D95800 = 367177440 → /1000 = 367177) and surface
      //       a ghost "#367177440" entry in the loot list. Return null to drop
      //       the entry; do NOT fall through to readI32/ObscuredInt — those
      //       would return the pointer's low dword as a garbage int.
      //   (b) Plain int32 field (v1.00.21/23/27) misread as 8-byte pointer —
      //       the low 32 bits ARE the catalog id (6-digit [110001, 939999]).
      //       Fall through to the plain-int32 return below.
      //
      // Discriminator: in case (b) the high 32 bits of the 8-byte read are
      // always 0 (itemStringKey is followed by a zero-init'd padding or the
      // next field happens to be 0 at this offset alignment). In case (a)
      // the String pointer always has a non-zero high 32 bits (Windows user-
      // mode heap addresses are typically 0x00000200_xxxxxxxx or larger).
      // Requiring ptrVal === low32 (high dword 0) for fall-through eliminates
      // the residual ghost-itemKey risk where a real String pointer's low
      // dword happens to land in [110001, 939999] by coincidence.
      const low32 = readI32(reader, entryPtr + BigInt(offset));
      const looksLikeCatalogId = low32 != null && low32 >= 110_001 && low32 <= 939_999;
      const high32IsZero = ptrVal >> 32n === 0n;
      if (!looksLikeCatalogId || !high32IsZero) return null;
      // else: fall through to plain-int32 return.
    }
    // ptrVal == null: field value < 0x10000 (e.g. ObscuredInt with small
    // hidden, or zero/uninitialized). Fall through to plain-int32/ObscuredInt.
  }

  // Plain int32 (v1.00.21/23/27): accept any non-negative value. For
  // boxType/level (allowString=false) this is the primary path — grade=0
  // and small boxType values are valid. For itemStringKey, this is the
  // fallback when the String-pointer path didn't apply (plain-int32 field
  // layout) or the pointer's low dword happens to be a valid catalog id.
  const raw = readI32(reader, entryPtr + BigInt(offset));
  if (raw != null && raw >= 0) return raw;

  // Negative or null: try ObscuredInt decode (hiddenValue + currentCryptoKey).
  // Reuse the already-read `raw` as the hidden value instead of re-reading the
  // same offset — previously this performed a second readBytes for the same 4
  // bytes, doubling IPC calls per box-open entry.
  const key = readI32(reader, entryPtr + BigInt(offset + 4));
  return decodeObscuredInt(raw, key);
}

// ── Inventory (PlayerSaveData.itemSaveDatas → ItemSaveData entries) ───────────

const MAX_INVENTORY_ITEMS = 100_000;

/**
 * Live inventory listing from the `PlayerSaveData.itemSaveDatas` save snapshot
 * reached via `CommonSaveData → player`. This is the same anchor the pet reader
 * uses; it avoids depending on the LocalInventoryManager static instance.
 * Returns null when the item-list offset has not been derived for this version.
 */
export interface ReadInventoryResult {
  items: LiveInventoryItem[] | null;
  status: string;
}

export function readRuntimeInventory(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  playerPtrOverride?: bigint | null,
): ReadInventoryResult {
  if (o.player.itemSaveDatas === 0) {
    return { items: null, status: "player.itemSaveDatas offset = 0 (not derived)" };
  }
  if (o.inventoryItem.itemKey === 0) {
    return { items: null, status: "inventoryItem.itemKey offset = 0 (struct offsets not derived)" };
  }

  const candidates = o.il2cppClass.staticFieldsOffsets;

  let playerPtr = playerPtrOverride ?? null;
  if (playerPtr == null) {
    playerPtr = readStaticFieldPtr(
      reader,
      gaBase,
      gaSize,
      o.typeInfoRva.commonSaveData,
      o.player.commonSaveData,
      candidates,
    );
  }
  if (playerPtr == null) {
    return {
      items: null,
      status:
        "PlayerSaveData (CommonSaveData singleton) static field unreadable — typeInfoRva.commonSaveData suspect",
    };
  }

  const listPtr = readPtr(reader, playerPtr + BigInt(o.player.itemSaveDatas));
  if (listPtr == null) {
    return {
      items: null,
      status:
        "PlayerSaveData.itemSaveDatas list pointer null (player.itemSaveDatas offset suspect)",
    };
  }

  const itemsArrPtr = readPtr(reader, listPtr + BigInt(o.container.listItems));
  if (itemsArrPtr == null) {
    return {
      items: null,
      status: "itemSaveDatas backing array pointer null (container.listItems offset suspect)",
    };
  }

  const count = readI32(reader, listPtr + BigInt(o.container.listSize));
  if (count == null) {
    return {
      items: null,
      status: "itemSaveDatas count unreadable (container.listSize offset suspect)",
    };
  }
  if (count <= 0) {
    return { items: null, status: `itemSaveDatas count = ${count} (empty inventory snapshot)` };
  }
  if (count > MAX_INVENTORY_ITEMS) {
    return { items: null, status: `itemSaveDatas count = ${count} exceeds MAX_INVENTORY_ITEMS` };
  }

  const results: LiveInventoryItem[] = [];
  const first = itemsArrPtr + BigInt(o.container.arrayFirst);

  // Bulk-read all entry pointers in ONE ReadProcessMemory call. Falls back to
  // per-slot readPtr on partial/failed reads (see readPtrArray). This reduces
  // the kernel-call count for the pointer array from `count` to 1 (typical)
  // or `count` (fallback) — important for inventories up to 100k items.
  const entryPtrs = readPtrArray(reader, first, count) ?? [];

  // Per-entry field read: a single read covering both itemKey (0x10) and
  // isChaotic (0x20) when their span fits in a small read. Falls back to
  // per-field readI32 when the bulk read fails or the span is too large.
  const itemKeyOff = o.inventoryItem.itemKey;
  const isChaoticOff = o.inventoryItem.isChaotic;
  const fieldStart = Math.min(itemKeyOff, isChaoticOff);
  const fieldEnd = Math.max(itemKeyOff + 4, isChaoticOff + 4);
  const fieldSpan = fieldEnd - fieldStart;
  const bulkFields = fieldSpan > 0 && fieldSpan <= 64;

  for (let i = 0; i < count; i++) {
    const entryPtr = entryPtrs[i];
    if (entryPtr == null) continue;

    let itemKey: number | null = null;
    let isChaoticRaw: number | null = null;

    if (bulkFields) {
      const buf = reader.readBytes(entryPtr + BigInt(fieldStart), fieldSpan);
      if (buf && buf.length >= fieldSpan) {
        itemKey = buf.readInt32LE(itemKeyOff - fieldStart);
        isChaoticRaw = buf.readInt32LE(isChaoticOff - fieldStart);
      }
    }

    // Fallback to per-field reads when the bulk read didn't cover both fields.
    if (itemKey == null) itemKey = readI32(reader, entryPtr + BigInt(itemKeyOff));
    if (isChaoticRaw == null) isChaoticRaw = readI32(reader, entryPtr + BigInt(isChaoticOff));

    if (itemKey == null || itemKey <= 0) continue;

    results.push({ itemKey, isChaotic: (isChaoticRaw ?? 0) !== 0 });
  }

  if (results.length === 0) {
    return {
      items: null,
      status: `all ${count} inventory entries skipped as invalid (inventoryItem.itemKey offset suspect)`,
    };
  }
  return { items: results, status: "" };
}

// ── Pets (PlayerSaveData.PetSaveData array) ───────────────────────────────────

const MAX_PETS = 500;

/**
 * Live pet data from the save-layer `PlayerSaveData.PetSaveData` array.
 * Returns null when struct offsets have not been derived for this version.
 */
export interface ReadPetsResult {
  pets: LivePetData[] | null;
  status: string;
}

export function readRuntimePets(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  playerPtrOverride?: bigint | null,
): ReadPetsResult {
  if (o.player.petSaveDatas === 0) {
    return { pets: null, status: "player.petSaveDatas offset = 0 (not derived)" };
  }
  if (o.petSaveData.petKey === 0) {
    return { pets: null, status: "petSaveData.petKey offset = 0 (struct offsets not derived)" };
  }

  const candidates = o.il2cppClass.staticFieldsOffsets;

  // CommonSaveData → player → petSaveDatas (List<PetSaveData>)
  let playerPtr = playerPtrOverride ?? null;
  if (playerPtr == null) {
    playerPtr = readStaticFieldPtr(
      reader,
      gaBase,
      gaSize,
      o.typeInfoRva.commonSaveData,
      o.player.commonSaveData,
      candidates,
    );
  }
  if (playerPtr == null) {
    return {
      pets: null,
      status:
        "PlayerSaveData (CommonSaveData singleton) static field unreadable — typeInfoRva.commonSaveData suspect",
    };
  }

  const petListPtr = readPtr(reader, playerPtr + BigInt(o.player.petSaveDatas));
  if (petListPtr == null) {
    return {
      pets: null,
      status: "PlayerSaveData.petSaveDatas list pointer null (player.petSaveDatas offset suspect)",
    };
  }

  const itemsArrPtr = readPtr(reader, petListPtr + BigInt(o.container.listItems));
  if (itemsArrPtr == null) {
    return {
      pets: null,
      status: "petSaveDatas backing array pointer null (container.listItems offset suspect)",
    };
  }

  const count = readI32(reader, petListPtr + BigInt(o.container.listSize));
  if (count == null) {
    return {
      pets: null,
      status: "petSaveDatas count unreadable (container.listSize offset suspect)",
    };
  }
  if (count <= 0) {
    return { pets: null, status: `petSaveDatas count = ${count} (empty pet snapshot)` };
  }
  if (count > MAX_PETS) {
    return { pets: null, status: `petSaveDatas count = ${count} exceeds MAX_PETS` };
  }

  const results: LivePetData[] = [];
  const first = itemsArrPtr + BigInt(o.container.arrayFirst);

  // Bulk-read all pet pointers in ONE ReadProcessMemory call. Same pattern as
  // readRuntimeInventory: one call for the whole pointer array, fallback to
  // per-slot readPtr on partial/failed reads.
  const petPtrs = readPtrArray(reader, first, count) ?? [];

  // Per-entry field read: a single read covering both petKey (0x10) and
  // isUnlock (0x14) when their span fits. Falls back to per-field readI32.
  const petKeyOff = o.petSaveData.petKey;
  const isUnlockOff = o.petSaveData.isUnlock;
  const fieldStart = Math.min(petKeyOff, isUnlockOff);
  const fieldEnd = Math.max(petKeyOff + 4, isUnlockOff + 4);
  const fieldSpan = fieldEnd - fieldStart;
  const bulkFields = fieldSpan > 0 && fieldSpan <= 64;

  for (let i = 0; i < count; i++) {
    const petPtr = petPtrs[i];
    if (petPtr == null) continue;

    let petKey: number | null = null;
    let isUnlockRaw: number | null = null;

    if (bulkFields) {
      const buf = reader.readBytes(petPtr + BigInt(fieldStart), fieldSpan);
      if (buf && buf.length >= fieldSpan) {
        petKey = buf.readInt32LE(petKeyOff - fieldStart);
        isUnlockRaw = buf.readInt32LE(isUnlockOff - fieldStart);
      }
    }

    if (petKey == null) petKey = readI32(reader, petPtr + BigInt(petKeyOff));
    if (isUnlockRaw == null) isUnlockRaw = readI32(reader, petPtr + BigInt(isUnlockOff));

    if (petKey == null || petKey <= 0) continue;

    results.push({ petKey, unlocked: (isUnlockRaw ?? 0) !== 0 });
  }

  if (results.length === 0) {
    return {
      pets: null,
      status: `all ${count} pet entries skipped as invalid (petSaveData.petKey offset suspect)`,
    };
  }
  return { pets: results, status: "" };
}

// ── Monster HP and dead count (MonsterSpawnManager) ──────────────────────────

/**
 * Per-reader pin for a resolved MonsterSpawnManager instance pointer and the
 * cached HP field offsets inside `UnitHealthController`.
 *
 * `cachedHpOffsets` is the last-known-good `[cOff, mOff]` pair found by
 * `probeHealthController`. All monsters in the same wave share the same
 * controller struct layout, so once one monster validates a pair, every
 * subsequent monster can skip the 4-pair probe and read HP directly —
 * dropping the per-monster read count from up to 8 readF32 calls (4 pairs × 2
 * fields) to 2 readF32 calls (the cached pair).
 *
 * The cache is invalidated when the cached pair fails validation for a
 * monster (e.g. controller in a transient mid-write state, or a struct layout
 * change between game versions). On invalidation, the next read re-runs the
 * full probe and re-populates the cache.
 */
export interface MonsterSpawnPinState {
  ptr: bigint | null;
  cachedHpOffsets: { cOff: number; mOff: number } | null;
}

export function makeMonsterSpawnPinState(): MonsterSpawnPinState {
  return { ptr: null, cachedHpOffsets: null };
}

const MAX_MONSTERS = 500;

function isPlausibleHeapPtr(v: bigint): boolean {
  return v > 0x10000n && v < 0x7ff0_0000_0000n;
}

/** Resolve MonsterSpawnManager instance using the TypeInfo RVA (extracted or bundled).
 *  Reads the class's static_fields block and scans for a plausible heap pointer
 *  (the singleton instance). Tries the parent class (nn<T>) first for the bbwf field,
 *  falls back to scanning the child class's static_fields.
 *  VALIDATES the instance by checking that at least monsterList resolves to a valid
 *  non-null pointer — if not, returns null so the caller falls back to name-scan. */
function resolveMonsterSpawnManager(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: MonsterSpawnPinState,
): bigint | null {
  // Fast path: cached pin (may be set by name-scan fallback in liveReader).
  // Re-validate on every call: StageManager and LogManager pins both re-check
  // liveness each tick — MonsterSpawnManager must do the same to avoid returning
  // a stale instance after scene swap / GC (HPs would silently degrade). When
  // the cached instance no longer passes isValidMonsterManager, drop the pin and
  // fall through to the regular resolution path.
  if (pin.ptr != null) {
    if (isValidMonsterManager(reader, pin.ptr, o)) return pin.ptr;
    pin.ptr = null;
  }
  if (o.typeInfoRva.monsterSpawnManager === 0n) return null;

  const klass = resolveClassPtr(reader, gaBase, gaSize, o.typeInfoRva.monsterSpawnManager);
  if (klass == null) return null;

  // Strategy 1: try via parent class (nn<T>) — bbwf at static_fields+0x00
  const parent = readPtr(reader, klass + 0x58n);
  if (parent != null && parent >= 0x10000n && parent < 0x7ff0_0000_0000n) {
    for (const off of o.il2cppClass.staticFieldsOffsets) {
      const block = readPtr(reader, parent + BigInt(off));
      if (block != null && block > 0x10000n && block < 0x7ff0_0000_0000n) {
        const bbwf = readPtr(reader, block);
        if (bbwf != null && bbwf > 0x10000n && bbwf < 0x7ff0_0000_0000n) {
          if (isValidMonsterManager(reader, bbwf, o)) {
            pin.ptr = bbwf;
            return bbwf;
          }
        }
      }
    }
  }

  // Strategy 2: fallback — read static_fields from the MonsterSpawnManager class
  // and scan for a plausible instance pointer (bbwf may be inherited)
  const block = readStaticFieldsBlock(
    reader,
    gaBase,
    gaSize,
    o.typeInfoRva.monsterSpawnManager,
    o.il2cppClass.staticFieldsOffsets,
  );
  if (block == null) return null;

  for (let off = 0; off <= 0x100; off += 8) {
    const cand = readPtr(reader, block + BigInt(off));
    if (cand == null) continue;
    if (cand !== 0n && cand > 0x10000n && cand < 0x7ff0_0000_0000n) {
      if (isValidMonsterManager(reader, cand, o)) {
        pin.ptr = cand;
        return cand;
      }
    }
  }
  return null;
}

/** Check that a candidate MonsterSpawnManager instance has at least one valid monster list.
 *  Uses the same `monsterList` offset the reader uses (`o.runtime.monster.monsterList`,
 *  defaulting to 0x28 when not derived) — previously hardcoded 0x28, which could
 *  diverge from the reader's actual offset on versions where the extractor
 *  derived a different value. */
function isValidMonsterManager(reader: MemoryReader, inst: bigint, o: LiveOffsets): boolean {
  const monsterListOff = o.runtime.monster.monsterList > 0 ? o.runtime.monster.monsterList : 0x28;
  const listPtr = readPtr(reader, inst + BigInt(monsterListOff));
  if (listPtr == null || listPtr <= 0x10000n || listPtr >= 0x7ff0_0000_0000n) return false;
  // Verify it has a non-empty backing array with sane count
  const arr = readPtr(reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  if (arr == null || arr <= 0x10000n || arr >= 0x7ff0_0000_0000n) return false;
  const count = readI32(reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  return count != null && count >= 0 && count <= MAX_MONSTERS;
}

/** Known HP offset pairs to probe within a UnitHealthController candidate. */
const HC_PROBE_PAIRS: [number, number][] = [
  [0x40, 0x4c], // tbh-meter verified layout
  [0x38, 0x44],
  [0x30, 0x3c],
  [0x48, 0x54],
];

/** Read HP from a `UnitHealthController`, using the cached offset pair when valid.
 *  Falls back to the full 4-pair probe when the cache is empty or the cached
 *  pair fails validation (transient mid-write / layout change). On successful
 *  probe, updates `pin.cachedHpOffsets` so subsequent monsters read HP directly. */
function readHpFromController(
  reader: MemoryReader,
  ctrlPtr: bigint,
  pin: MonsterSpawnPinState,
): [number, number] | null {
  // Fast path: try the cached offset pair first.
  const cached = pin.cachedHpOffsets;
  if (cached != null) {
    const current = readF32(reader, ctrlPtr + BigInt(cached.cOff));
    const maxHp = readF32(reader, ctrlPtr + BigInt(cached.mOff));
    if (validHpPair(current, maxHp)) {
      return [current!, maxHp!];
    }
    // Cached pair failed validation — drop the cache and re-probe below.
    pin.cachedHpOffsets = null;
  }
  // Fallback: probe all known pairs. On success, cache the winning pair so
  // subsequent monsters (which share the same controller struct layout) hit
  // the fast path on their first read.
  const probed = probeHealthController(reader, ctrlPtr);
  if (probed != null) {
    pin.cachedHpOffsets = { cOff: probed.cOff, mOff: probed.mOff };
    return [probed.current, probed.maxHp];
  }
  return null;
}

/** Validate a [current, maxHp] pair read from a `UnitHealthController`. */
function validHpPair(current: number | null, maxHp: number | null): boolean {
  return (
    current != null &&
    maxHp != null &&
    Number.isFinite(current) &&
    Number.isFinite(maxHp) &&
    current >= 0 &&
    maxHp > 0 &&
    current <= maxHp * 1.1 &&
    maxHp < 1e7
  );
}

/** Scan a monster (Unit) for its health controller and read HP.
 *  Uses the configured HealthController offset (0xB0, tbh-meter verified).
 *  No fallback scanning — unlike meter, companion reads are not offline:
 *  a bad HP read silently produces garbage DPS for the rest of the session. */
function readMonsterHp(
  reader: MemoryReader,
  monsterPtr: bigint,
  o: LiveOffsets,
  pin: MonsterSpawnPinState,
): [number, number] | null {
  const hcOff = o.runtime.monster.monsterHealth > 0 ? o.runtime.monster.monsterHealth : 0xb0;

  const hc = readPtr(reader, monsterPtr + BigInt(hcOff));
  if (hc == null || hc <= 0x10000n || hc >= 0x7ff0_0000_0000n) return null;
  return readHpFromController(reader, hc, pin);
}

/** Try multiple known HP offset pairs within a controller struct. Returns the
 *  winning pair's values AND offsets so the caller can cache them. */
function probeHealthController(
  reader: MemoryReader,
  ctrlPtr: bigint,
): { current: number; maxHp: number; cOff: number; mOff: number } | null {
  for (const [cOff, mOff] of HC_PROBE_PAIRS) {
    const current = readF32(reader, ctrlPtr + BigInt(cOff));
    const maxHp = readF32(reader, ctrlPtr + BigInt(mOff));
    if (validHpPair(current, maxHp)) {
      return { current: current!, maxHp: maxHp!, cOff, mOff };
    }
  }
  return null;
}

/** Walk a List<Monster> and extract HP from each Monster's UnitHealthController.
 *  Returns [addr, hpCurrent, hpMax] triples following tbh-meter's address-based approach. */
function walkMonsterList(
  reader: MemoryReader,
  listPtr: bigint,
  out: Array<[number, number, number]>, // [addr, hpCurrent, hpMax]
  o: LiveOffsets,
  pin: MonsterSpawnPinState,
): void {
  const arr = readPtr(reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  if (arr == null || !isPlausibleHeapPtr(arr)) return;
  const count = readI32(reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (count == null || count <= 0 || count > MAX_MONSTERS) return;

  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);

  for (let i = 0; i < count; i++) {
    const monsterPtr = readPtr(reader, first + BigInt(i * 8));
    if (monsterPtr == null || !isPlausibleHeapPtr(monsterPtr)) continue;
    const hp = readMonsterHp(reader, monsterPtr, o, pin);
    if (hp != null) {
      // Convert bigint address to number for IPC serialization (safe: Win64 user-mode < 2^53)
      out.push([Number(monsterPtr), hp[0], hp[1]]);
    }
  }
}

/**
 * Read live monster HP data from MonsterSpawnManager.
 * Returns the combined (monsterList + summonedList) HP array and the dead monster count.
 *
 * MonsterSpawnManager has:
 *   - monsterList: List<Monster> (alive on field)
 *   - summonedList: List<Monster> (summoned monsters)
 *   - deadMonsterList: List<dead_monster> (dead count via listSize)
 *
 * Each Monster (a runtime Unit) has a UnitHealthController whose exact field
 * offset is scanned dynamically.
 *
 * Returns null only when the MonsterSpawnManager instance itself cannot be
 * resolved. When the struct offsets aren't derived for this build (e.g.
 * v1.00.28 / v1.01.01 / v1.01.05 — `runtime.monster.monsterList`/`summonedList`
 * are 0), the reader falls back to the v1.00.21 base offsets (0x28/0x38/0x30)
 * so monster HP data keeps flowing where those offsets are still valid (verified
 * live: v1.01.05 shows DPS/alive/max-HP with the base-offset fallback).
 *
 * The empty-array-vs-null distinction is left to the CALLER: an empty array
 * means "read attempted but no monsters found" (TrackingService then falls back
 * to `updateAlive(stageAlive)` for wave detection), whereas null means "no data
 * source at all". This keeps DPS/HP alive whenever the lists are readable while
 * still letting the stageAlive-driven wave-clear path take over when they are
 * not.
 */
export function readRuntimeMonsterHp(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: MonsterSpawnPinState,
): { monsterHps: Array<[number, number, number]>; deadCount: number } | null {
  // If the pin is already set (via name-scan), skip RVA check
  if (pin.ptr == null && o.typeInfoRva.monsterSpawnManager === 0n) return null;

  const msmPtr = resolveMonsterSpawnManager(reader, gaBase, gaSize, o, pin);
  if (msmPtr == null) return null;

  // Use known offsets from tbh-meter: MONSTER_LIST=0x28, SUMMONED_LIST=0x38, DEAD_MONSTER_LIST=0x30
  const monsterListOff = o.runtime.monster.monsterList > 0 ? o.runtime.monster.monsterList : 0x28;
  const summonedListOff =
    o.runtime.monster.summonedList > 0 ? o.runtime.monster.summonedList : 0x38;
  const deadListOff =
    o.runtime.monster.deadMonsterList > 0 ? o.runtime.monster.deadMonsterList : 0x30;

  // Read monsters from monsterList and summonedList
  const monsterHps: Array<[number, number, number]> = []; // [addr, hpCurrent, hpMax]

  const listOffs = [monsterListOff];
  if (summonedListOff > 0) listOffs.push(summonedListOff);

  for (const loff of listOffs) {
    const listPtr = readPtr(reader, msmPtr + BigInt(loff));
    if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
    walkMonsterList(reader, listPtr, monsterHps, o, pin);
  }

  // Dead monster count
  let deadCount = 0;
  if (deadListOff > 0) {
    const deadListPtr = readPtr(reader, msmPtr + BigInt(deadListOff));
    if (deadListPtr != null && isPlausibleHeapPtr(deadListPtr)) {
      const dc = readI32(reader, deadListPtr + BigInt(STRUCT_CONTAINER.listSize));
      if (dc != null && dc >= 0 && dc < 100000) deadCount = dc;
    }
  }

  return { monsterHps, deadCount };
}
