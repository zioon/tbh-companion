// Runtime IL2CPP reads — live stage (StageCache chain) and live gold
// (CurrencyManager Dictionary<int,T> → ACTk ObscuredLong). Pure: operates over
// an injected MemoryReader so it is unit-testable over synthetic memory maps.

import {
  readF32,
  readI32,
  readI64,
  readIl2CppString,
  readPtr,
  readU32,
  readU64,
  type MemoryReader,
} from "./memory";
import { plausibleGold, plausibleStage, plausibleWave, type LiveOffsets } from "./offsets";
import { readStaticFieldPtr, readStaticFieldsBlock, resolveClassPtr } from "./statics";
import { STRUCT_CONTAINER } from "./il2cppScanner";
import type {
  BoxOpenEntry,
  LiveHeroData,
  LiveInventoryItem,
  LivePetData,
} from "../../../shared/types";

export interface RuntimeStage {
  stageKey: number | null;
  wave: number | null;
  waveTotal: number | null;
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

  return {
    stageKey: plausibleStage(stageKey) ? stageKey : null,
    wave,
    waveTotal: waveTotal != null && waveTotal > 0 ? waveTotal : null,
  };
}

// ── Gold (CurrencyManager → Dictionary<int,T> → ACTk ObscuredLong) ──────────

/** Per-reader-instance pin state for gold: avoids re-walking the dict every tick. */
export interface GoldPinState {
  /** Cached pointer to the currency entry for `goldKey`; null when unknown/stale. */
  entryPtr: bigint | null;
  /** Last successfully decoded gold value; returned when all reads fail. */
  lastKnown: number | null;
}

export function makeGoldPinState(): GoldPinState {
  return { entryPtr: null, lastKnown: null };
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

/** Decode one ACTk ObscuredLong from its struct base address. */
function readObscuredLong(reader: MemoryReader, structAddr: bigint): bigint | null {
  const hidden = readI64(reader, structAddr + 8n);
  const crypto = readI64(reader, structAddr + 16n);
  if (hidden == null || crypto == null) return null;
  return (hidden - crypto) ^ crypto;
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
 * Returns `pin.lastKnown` when all reads fail (stale rather than null).
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
        return v;
      }
    }
  }

  // All paths failed — return last known rather than null to reduce UI flicker.
  return pin.lastKnown;
}

// ── COMBAT GOLD from PlayerSaveData.aggregateSaveDatas (tbh-meter approach) ─────
//
// The game tracks GoldEarn as a cumulative Dict<SubKey, long> in the save's
// AggregateSaveData list. SubKey 1 = COMBAT (pure combat gold, excludes sales/idle/quest).
// This is more accurate than wallet balance (CurrencyManager) which includes gear sales.
// Ported from tbh-meter/reader/metrics/gold.py -> combat_gold_save.
export function readRuntimeCombatGold(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
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

/** Reinterpret a uint32 bit pattern as an IEEE-754 float32. */
function u32ToF32(bits: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits >>> 0, true);
  return dv.getFloat32(0, true);
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
 *  Ported from tbh-meter's game/obscured.py -> decode_obscured_double. */
function decodeObscuredDouble(hidden: bigint | null, key: bigint | null): number | null {
  if (hidden == null || key == null) return null;
  const bits = (key ^ byteswap8(hidden)) & 0xffffffffffffffffn;
  // Reinterpret bigint bits as float64
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
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
    let exp: number | null = null;
    if (expIsDouble) {
      exp = decodeObscuredDouble(
        readU64(reader, runtimePtr + BigInt(o.heroRuntime.expHidden)),
        readU64(reader, runtimePtr + BigInt(o.heroRuntime.expKey)),
      );
    } else {
      exp = decodeObscuredFloat(
        readU32(reader, runtimePtr + BigInt(o.heroRuntime.expHidden)),
        readU32(reader, runtimePtr + BigInt(o.heroRuntime.expKey)),
      );
    }

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
  for (let off = 0; off <= SM_STATIC_SCAN_MAX; off += 8) {
    const cand = readPtr(reader, block + BigInt(off));
    if (cand == null) continue;
    scanned++;
    if (isLiveStageManager(reader, cand, o)) {
      pin.ptr = cand;
      pin.lastStatus = "";
      return cand;
    }
  }
  pin.lastStatus =
    scanned === 0
      ? "StageManager static block scan: no plausible pointers found"
      : `StageManager static block scan: ${scanned} candidate(s) but none passed isLiveStageManager (party not deployed / in menu / runtime.heroList offset suspect)`;
  return null;
}

// ── Live chest drops (LogManager → Dictionary<ELogType, List<GetBoxLog>>) ─────

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
}

export function makeChestLogPinState(): ChestLogPinState {
  return { ptr: null, lastCount: 0, primed: false };
}

const MAX_CHEST_LOG = 5_000;
const LM_STATIC_SCAN_MAX = 0x100;

/** EMonsterLogType → chest category (0 common, 1 stage boss, 2 act boss). */
function chestCategoryFromMonsterType(t: number): LiveChestCategory | null {
  if (t === 0) return "common";
  if (t === 1) return "rare";
  if (t === 2) return "act";
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

/** A LogManager candidate is valid when its GetBox log list is walkable. */
function isLiveLogManager(reader: MemoryReader, ptr: bigint, o: LiveOffsets): boolean {
  return getBoxLogList(reader, ptr, o) != null;
}

/**
 * Resolve the live `LogManager` instance pointer by scanning its class static
 * block for the pointer whose GetBox log list is walkable. Pinned and revalidated
 * each tick. Returns null when the TypeInfo RVA has not been derived yet
 * (`logManager === 0n`) — the offset extractor fills it at runtime.
 */
/**
 * Resolve the live `LogManager` instance pointer. Shared by every log-tailing
 * reader (chest drops, stage clears, …) — the resolution itself only depends
 * on the class anchor + a walkable GetBox list as its liveness check, not on
 * which `ELogType` bucket the caller ultimately tails.
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
  debug?: { count: number; lastCountBefore: number; start: number; entriesRead: number };
}

export function readRuntimeChestLog(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: ChestLogPinState,
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
    return {
      drops: null,
      status: "GetBox log list not walkable (runtime.log.logByType dict lookup failed)",
    };
  }

  const { arr, count } = list;
  if (!pin.primed) {
    pin.lastCount = count;
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
  if (count < lastCountBefore) {
    pin.lastCount = count;
    return {
      drops: [],
      status: "",
      debug: { count, lastCountBefore, start: count, entriesRead: 0 },
    };
  }

  const start = lastCountBefore;
  const drops: LiveChestCategory[] = [];
  const first = arr + BigInt(o.container.arrayFirst);
  for (let i = start; i < count; i++) {
    const entryPtr = readPtr(reader, first + BigInt(i * 8));
    if (entryPtr == null) continue;
    const mt = readI32(reader, entryPtr + BigInt(o.runtime.getBoxLog.monsterType));
    const cat = mt == null ? null : chestCategoryFromMonsterType(mt);
    if (cat) drops.push(cat);
  }
  pin.lastCount = count;
  return {
    drops,
    status: "",
    debug: { count, lastCountBefore, start, entriesRead: count - start },
  };
}

// ── Live stage clears (LogManager → Dictionary<ELogType, List<StageClearLog>>) ─

/** Per-reader pin for the LogManager instance pointer and the StageClear-log tail position. */
export type StageClearPinState = ChestLogPinState;

export function makeStageClearPinState(): StageClearPinState {
  return { ptr: null, lastCount: 0, primed: false };
}

const MAX_STAGE_CLEAR_LOG = 5_000;
/** Reject implausible clear times (corrupted memory / mid-write read). */
const MAX_CLEAR_TIME_SEC = 36_000;

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
 * Clear times (whole seconds, as recorded by the game) added to the
 * StageClear log since the last read. Tails the log by index the same way
 * {@link readRuntimeChestLog} tails GetBox: primes to the current length on
 * first read (backlog not counted) and returns `[]`; when the log shrinks it
 * realigns the tail to `count` and returns `[]` (never re-reads history, see
 * {@link readRuntimeChestLog} for rationale). Returns null when the LogManager
 * can't be resolved — distinct from `[]` (resolved, no new clears this tick).
 * Stage attribution is the caller's job (the live/save stageKey at read time);
 * the log entry's own act/stage ints don't carry difficulty.
 */
export function readRuntimeStageClears(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  pin: StageClearPinState,
): number[] | null {
  const lmPtr = resolveLogManager(reader, gaBase, gaSize, o, pin);
  if (lmPtr == null) return null;
  const list = stageClearLogList(reader, lmPtr, o);
  if (list == null) return null;

  const { arr, count } = list;
  if (!pin.primed) {
    pin.lastCount = count;
    pin.primed = true;
    return [];
  }

  if (count < pin.lastCount) {
    pin.lastCount = count;
    return [];
  }

  const start = pin.lastCount;
  const clears: number[] = [];
  const first = arr + BigInt(o.container.arrayFirst);
  for (let i = start; i < count; i++) {
    const entryPtr = readPtr(reader, first + BigInt(i * 8));
    if (entryPtr == null) continue;
    const clearTimeSec = readI32(reader, entryPtr + BigInt(o.runtime.stageClearLog.clearTimeSec));
    if (clearTimeSec != null && clearTimeSec > 0 && clearTimeSec < MAX_CLEAR_TIME_SEC) {
      clears.push(clearTimeSec);
    }
  }
  pin.lastCount = count;
  return clears;
}

// ── Live box opens (LogManager → Dictionary<ELogType, List<BoxOpenLog>>) ─────

/** Per-reader pin for the BoxOpenLog tail. Same shape as chest/stage-clear pins. */
export type BoxOpenPinState = ChestLogPinState;

export function makeBoxOpenPinState(): BoxOpenPinState {
  return { ptr: null, lastCount: 0, primed: false };
}

const MAX_BOX_OPEN_LOG = 5_000;

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
    return { opens: null, status: "BoxOpenLog list not walkable (dict lookup failed)" };
  }

  const { arr, count } = list;
  if (!pin.primed) {
    pin.lastCount = count;
    pin.primed = true;
    return { opens: [], status: "" };
  }

  if (count < pin.lastCount) {
    pin.lastCount = count;
    return { opens: [], status: "" };
  }

  const start = pin.lastCount;
  const opens: BoxOpenEntry[] = [];
  const first = arr + BigInt(o.container.arrayFirst);
  for (let i = start; i < count; i++) {
    const entryPtr = readPtr(reader, first + BigInt(i * 8));
    if (entryPtr == null) continue;
    const itemKey = readBoxOpenLogField(reader, entryPtr, o.runtime.boxOpenLog.itemStringKey, true);
    if (itemKey == null || itemKey <= 0) continue;

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
    opens.push(entry);
  }
  pin.lastCount = count;
  return { opens, status: "" };
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
    }
  }

  // Plain int32 (v1.00.21/23/27): accept any non-negative value. For
  // boxType/level (allowString=false) this is the primary path — grade=0
  // and small boxType values are valid. For itemStringKey, this is the
  // fallback when the String-pointer path didn't apply (plain-int32 field
  // layout) or failed to decode.
  const raw = readI32(reader, entryPtr + BigInt(offset));
  if (raw != null && raw >= 0) return raw;

  // Negative or null: try ObscuredInt decode (hiddenValue + currentCryptoKey).
  const hidden = readI32(reader, entryPtr + BigInt(offset));
  const key = readI32(reader, entryPtr + BigInt(offset + 4));
  return decodeObscuredInt(hidden, key);
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

  for (let i = 0; i < count; i++) {
    const entryPtr = readPtr(reader, first + BigInt(i * 8));
    if (entryPtr == null) continue;

    const itemKey = readI32(reader, entryPtr + BigInt(o.inventoryItem.itemKey));
    if (itemKey == null || itemKey <= 0) continue;

    const isChaoticRaw = readI32(reader, entryPtr + BigInt(o.inventoryItem.isChaotic));

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

  for (let i = 0; i < count; i++) {
    const petPtr = readPtr(reader, first + BigInt(i * 8));
    if (petPtr == null) continue;

    const petKey = readI32(reader, petPtr + BigInt(o.petSaveData.petKey));
    if (petKey == null || petKey <= 0) continue;

    const isUnlockRaw = readI32(reader, petPtr + BigInt(o.petSaveData.isUnlock));

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

/** Per-reader pin for a resolved MonsterSpawnManager instance pointer. */
export interface MonsterSpawnPinState {
  ptr: bigint | null;
}

export function makeMonsterSpawnPinState(): MonsterSpawnPinState {
  return { ptr: null };
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
  // Fast path: cached pin (may be set by name-scan fallback in liveReader)
  if (pin.ptr != null) return pin.ptr;
  if (o.typeInfoRva.monsterSpawnManager === 0n) return null;
  pin.ptr = null;

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
          if (isValidMonsterManager(reader, bbwf)) {
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
      if (isValidMonsterManager(reader, cand)) {
        pin.ptr = cand;
        return cand;
      }
    }
  }
  return null;
}

/** Check that a candidate MonsterSpawnManager instance has at least one valid monster list.
 *  Reads monsterList@0x28 — must be non-null and point at a valid list with non-zero count. */
function isValidMonsterManager(reader: MemoryReader, inst: bigint): boolean {
  const listPtr = readPtr(reader, inst + 0x28n); // MONSTER_LIST
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

/** Scan a monster (Unit) for its health controller and read HP.
 *  Uses the configured HealthController offset (0xB0, tbh-meter verified).
 *  No fallback scanning — unlike meter, companion reads are not offline:
 *  a bad HP read silently produces garbage DPS for the rest of the session. */
function readMonsterHp(
  reader: MemoryReader,
  monsterPtr: bigint,
  o: LiveOffsets,
): [number, number] | null {
  const hcOff = o.runtime.monster.monsterHealth > 0 ? o.runtime.monster.monsterHealth : 0xb0;

  const hc = readPtr(reader, monsterPtr + BigInt(hcOff));
  if (hc == null || hc <= 0x10000n || hc >= 0x7ff0_0000_0000n) return null;
  return probeHealthController(reader, hc);
}

/** Try multiple known HP offset pairs within a controller struct. */
function probeHealthController(reader: MemoryReader, ctrlPtr: bigint): [number, number] | null {
  for (const [cOff, mOff] of HC_PROBE_PAIRS) {
    const current = readF32(reader, ctrlPtr + BigInt(cOff));
    const maxHp = readF32(reader, ctrlPtr + BigInt(mOff));
    if (current != null && maxHp != null && Number.isFinite(current) && Number.isFinite(maxHp)) {
      if (current >= 0 && maxHp > 0 && current <= maxHp * 1.1 && maxHp < 1e7) {
        return [current, maxHp];
      }
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
): void {
  const arr = readPtr(reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  if (arr == null || !isPlausibleHeapPtr(arr)) return;
  const count = readI32(reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (count == null || count <= 0 || count > MAX_MONSTERS) return;

  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);

  for (let i = 0; i < count; i++) {
    const monsterPtr = readPtr(reader, first + BigInt(i * 8));
    if (monsterPtr == null || !isPlausibleHeapPtr(monsterPtr)) continue;
    const hp = readMonsterHp(reader, monsterPtr, o);
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
    walkMonsterList(reader, listPtr, monsterHps, o);
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
