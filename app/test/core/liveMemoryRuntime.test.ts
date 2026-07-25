import { describe, it, expect } from "vitest";
import {
  readRuntimeStage,
  readRuntimeGold,
  readRuntimeHeroes,
  readRuntimeChestLog,
  readRuntimeStageClears,
  readRuntimeBoxOpenLog,
  peekBoxOpenLogCount,
  readRuntimeInventory,
  readRuntimePets,
  readRuntimeMonsterHp,
  resolveStageManager,
  makeGoldPinState,
  makeSmPinState,
  makeChestLogPinState,
  makeStageClearPinState,
  makeBoxOpenPinState,
  makeMonsterSpawnPinState,
  type GoldPinState,
} from "../../src/core/liveMemory/runtime";
import { offsetsForVersion } from "../../src/core/liveMemory/offsets";
import { FakeMemory } from "./liveMemoryFake";

const O = offsetsForVersion("1.00.21")!;
const GA_BASE = 0x140000000n;
const GA_SIZE = 0x6000000;

// Heap addresses used to wire the synthetic chain.
const STAGE_CLASS = 0x200000n;
const STAGE_BLOCK = 0x300000n;
const STAGE_CACHE = 0x210000n;
const STAGE_INFO = 0x220000n;
const SM_CLASS = 0x400000n;
const SM_BLOCK = 0x500000n;
const SM_SINGLETON = 0x510000n;

const CAND = O.il2cppClass.staticFieldsOffsets[0]; // 0xb0 — first static-field candidate

/** Seed the StageCacheManager → StageCache → StageInfoData chain up to StageInfoData. */
function seedStageChain(m: FakeMemory): FakeMemory {
  const slot = GA_BASE + O.typeInfoRva.stageCacheManager;
  return m
    .writePtr(slot, STAGE_CLASS)
    .writePtr(STAGE_CLASS + BigInt(CAND), STAGE_BLOCK)
    .writePtr(STAGE_BLOCK + BigInt(O.runtime.stage.currentCache), STAGE_CACHE)
    .writePtr(STAGE_CACHE + BigInt(O.runtime.stage.cacheInfoData), STAGE_INFO);
}

describe("readRuntimeStage", () => {
  it("reads the live stage key and wave from a resolved StageManager", () => {
    const m = seedStageChain(new FakeMemory()).writeI32(
      STAGE_INFO + BigInt(O.runtime.stage.stageKey),
      1234,
    );
    m.writeI32(SM_SINGLETON + BigInt(O.runtime.stage.runtimeWave), 5);
    expect(readRuntimeStage(m, GA_BASE, GA_SIZE, O, SM_SINGLETON)).toEqual({
      stageKey: 1234,
      wave: 5,
      waveTotal: null,
    });
  });

  it("returns wave null when the StageManager instance is unresolved", () => {
    const m = seedStageChain(new FakeMemory()).writeI32(
      STAGE_INFO + BigInt(O.runtime.stage.stageKey),
      42,
    );
    expect(readRuntimeStage(m, GA_BASE, GA_SIZE, O, null)).toEqual({
      stageKey: 42,
      wave: null,
      waveTotal: null,
    });
  });

  it("nulls an implausible stage key (never returns a wrong value)", () => {
    const m = seedStageChain(new FakeMemory()).writeI32(
      STAGE_INFO + BigInt(O.runtime.stage.stageKey),
      0, // implausible
    );
    m.writeI32(SM_SINGLETON + BigInt(O.runtime.stage.runtimeWave), 3);
    expect(readRuntimeStage(m, GA_BASE, GA_SIZE, O, SM_SINGLETON)).toEqual({
      stageKey: null,
      wave: 3,
      waveTotal: null,
    });
  });

  it("preserves wave 0 (challenge-fail reset / pre-wave state)", () => {
    const m = seedStageChain(new FakeMemory()).writeI32(
      STAGE_INFO + BigInt(O.runtime.stage.stageKey),
      77,
    );
    m.writeI32(SM_SINGLETON + BigInt(O.runtime.stage.runtimeWave), 0); // wave 0 is legitimate
    expect(readRuntimeStage(m, GA_BASE, GA_SIZE, O, SM_SINGLETON)).toEqual({
      stageKey: 77,
      wave: 0,
      waveTotal: null,
    });
  });

  it("returns null when the stage-cache chain can't be walked", () => {
    expect(readRuntimeStage(new FakeMemory(), GA_BASE, GA_SIZE, O, SM_SINGLETON)).toBeNull();
  });
});

// ── readRuntimeGold ───────────────────────────────────────────────────────────

const CURR_CLASS = 0x600000n;
const CURR_BLOCK = 0x700000n;
const DICT_OBJ = 0x710000n;
const ENTRIES_ARR = 0x720000n;
const CURR_ENTRY = 0x730000n;

/**
 * Seed an ACTk ObscuredLong into FakeMemory at `structAddr`.
 * FakeMemory is keyed by exact address, so each 8-byte field is seeded separately.
 * Layout: hidden@structAddr+8, cryptoKey@structAddr+16.
 * Decode: (hidden - cryptoKey) ^ cryptoKey === goldVal.
 */
function seedObscuredLong(
  m: FakeMemory,
  structAddr: bigint,
  goldVal: bigint,
  cryptoKey: bigint,
): void {
  const hidden = (goldVal ^ cryptoKey) + cryptoKey;
  const hBuf = Buffer.alloc(8);
  hBuf.writeBigInt64LE(hidden, 0);
  m.writeBytes(structAddr + 8n, hBuf);
  const kBuf = Buffer.alloc(8);
  kBuf.writeBigInt64LE(cryptoKey, 0);
  m.writeBytes(structAddr + 16n, kBuf);
}

/**
 * Seed the CurrencyManager → dict → entry chain.
 * `entryAddr` defaults to CURR_ENTRY; pass a different address to test pin staleness.
 */
function seedGoldChain(
  m: FakeMemory,
  goldVal: bigint,
  opts: { entryAddr?: bigint; cryptoKey?: bigint; goldKey?: number } = {},
): FakeMemory {
  const entryAddr = opts.entryAddr ?? CURR_ENTRY;
  const cryptoKey = opts.cryptoKey ?? 5678n;
  const goldKey = opts.goldKey ?? O.goldKey;

  const slot = GA_BASE + O.typeInfoRva.currencyManager;

  // TypeInfo → class → static_fields block → dict ptr
  m.writePtr(slot, CURR_CLASS)
    .writePtr(CURR_CLASS + BigInt(CAND), CURR_BLOCK)
    .writePtr(CURR_BLOCK + BigInt(O.runtime.currency.dict), DICT_OBJ);

  // Dict object: entries array ptr + count
  m.writePtr(DICT_OBJ + BigInt(O.dict.entries), ENTRIES_ARR).writeI32(
    DICT_OBJ + BigInt(O.dict.count),
    1,
  );

  // Entries array: one entry at arrayFirst — each field seeded at its read address
  const eBase = ENTRIES_ARR + BigInt(O.container.arrayFirst);
  m.writeI32(eBase + BigInt(O.dict.entryHash), 1); // positive = valid slot
  m.writeI32(eBase + BigInt(O.dict.entryKey), goldKey);
  m.writePtr(eBase + BigInt(O.dict.entryValue), entryAddr);

  // Currency entry: ObscuredLong at +entryObscuredQty (each field seeded at its read address)
  seedObscuredLong(m, entryAddr + BigInt(O.runtime.currency.entryObscuredQty), goldVal, cryptoKey);

  return m;
}

describe("readRuntimeGold", () => {
  it("decodes gold from a valid dict entry", () => {
    const m = seedGoldChain(new FakeMemory(), 99_000n);
    const pin = makeGoldPinState();
    expect(readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin)).toBe(99_000);
    expect(pin.entryPtr).toBe(CURR_ENTRY);
    expect(pin.lastKnown).toBe(99_000);
  });

  it("hits the pin cache on a second read without re-walking the dict", () => {
    const m = seedGoldChain(new FakeMemory(), 42_000n);
    const pin = makeGoldPinState();
    readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin); // primes the pin

    // Poison the dict so a re-walk would return null
    const poisonedDictObj = 0x1n; // below 0x10000 — readPtr rejects it
    m.writePtr(CURR_BLOCK + BigInt(O.runtime.currency.dict), poisonedDictObj);

    // Second read must still succeed via the cached entry pointer
    expect(readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin)).toBe(42_000);
  });

  it("retries the dict walk when the cached entry pointer goes stale", () => {
    // Seed the dict normally pointing at CURR_ENTRY with gold = 77_001
    const m = seedGoldChain(new FakeMemory(), 77_001n);

    // Give pin a stale pointer to an address never seeded — readGoldFromEntry returns null
    const STALE_PTR = 0x7f0000n;
    const pin: GoldPinState = { entryPtr: STALE_PTR, lastKnown: null };

    const result = readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin);
    expect(result).toBe(77_001);
    // Pin updated to the real entry after successful dict walk
    expect(pin.entryPtr).toBe(CURR_ENTRY);
  });

  it("returns lastKnown when all read attempts fail", () => {
    const pin: GoldPinState = { entryPtr: null, lastKnown: 55_000 };
    // Empty memory — no currency manager resolvable
    expect(readRuntimeGold(new FakeMemory(), GA_BASE, GA_SIZE, O, pin)).toBe(55_000);
  });

  it("returns null when currency manager is not found and no lastKnown", () => {
    const pin = makeGoldPinState();
    expect(readRuntimeGold(new FakeMemory(), GA_BASE, GA_SIZE, O, pin)).toBeNull();
  });

  it("rejects an implausible decoded value (negative) and falls back to lastKnown", () => {
    // Seed the chain structure but plant an ObscuredLong that decodes to -1 (implausible)
    const m = seedGoldChain(new FakeMemory(), 0n); // seeds the pointer chain
    // Overwrite the ObscuredLong fields so it decodes to -1
    const cryptoKey = 1n;
    const badVal = -1n; // BigInt signed: decodes to negative → rejected by plausibleGold
    seedObscuredLong(
      m,
      CURR_ENTRY + BigInt(O.runtime.currency.entryObscuredQty),
      badVal,
      cryptoKey,
    );

    const pin: GoldPinState = { entryPtr: null, lastKnown: 1234 };
    expect(readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin)).toBe(1234);
  });
});

// ── readRuntimeHeroes ─────────────────────────────────────────────────────────

const HERO_LIST_OBJ = 0x800000n;
const HERO_PTRS = [0x820000n, 0x830000n];
const HERO_RT = [0x821000n, 0x831000n]; // Unit.cache → HeroRuntime
const HERO_INFO = [0x822000n, 0x832000n]; // HeroRuntime.info → HeroInfoData
const LEVEL_KEY = 0x1234; // arbitrary ACTk crypto keys for the fake
const EXP_KEY = 0x5678;

/** Byte-swap [1]/[2] — mirrors the ObscuredFloat quirk in runtime.ts. */
function byteswap12(v: number): number {
  return (
    ((v & 0xff) | (((v >>> 16) & 0xff) << 8) | (((v >>> 8) & 0xff) << 16) | (v & 0xff000000)) >>> 0
  );
}

/** Encode an ACTk ObscuredInt (inverse of the reader's decode). */
function seedObscuredInt(m: FakeMemory, hiddenAddr: bigint, keyAddr: bigint, value: number): void {
  const u = value >>> 0;
  const hidden = (((u ^ LEVEL_KEY) >>> 0) + LEVEL_KEY) >>> 0;
  m.writeU32(hiddenAddr, hidden).writeU32(keyAddr, LEVEL_KEY);
}

/** Encode an ACTk ObscuredFloat (inverse of the reader's decode). */
function seedObscuredFloat(
  m: FakeMemory,
  hiddenAddr: bigint,
  keyAddr: bigint,
  value: number,
): void {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, value, true);
  const bits = dv.getUint32(0, true);
  const hidden = byteswap12((bits ^ EXP_KEY) >>> 0);
  m.writeU32(hiddenAddr, hidden).writeU32(keyAddr, EXP_KEY);
}

/** Seed a live party off `smPtr`: HeroList → Hero[] → Unit.cache → HeroRuntime chain. */
function seedParty(
  m: FakeMemory,
  smPtr: bigint,
  heroes: Array<{ heroKey: number; level: number; exp: number }>,
): FakeMemory {
  m.writePtr(smPtr + BigInt(O.runtime.heroList), HERO_LIST_OBJ);
  m.writeI32(HERO_LIST_OBJ + BigInt(O.container.listSize), heroes.length);

  const first = HERO_LIST_OBJ + BigInt(O.container.arrayFirst);
  for (let i = 0; i < heroes.length; i++) {
    const rt = HERO_RT[i];
    m.writePtr(first + BigInt(i * 8), HERO_PTRS[i])
      .writePtr(HERO_PTRS[i] + BigInt(O.unit.cache), rt)
      .writePtr(rt + BigInt(O.heroRuntime.info), HERO_INFO[i])
      .writeI32(HERO_INFO[i] + BigInt(O.heroInfoData.heroKey), heroes[i].heroKey);
    seedObscuredInt(
      m,
      rt + BigInt(O.heroRuntime.levelHidden),
      rt + BigInt(O.heroRuntime.levelKey),
      heroes[i].level,
    );
    seedObscuredFloat(
      m,
      rt + BigInt(O.heroRuntime.expHidden),
      rt + BigInt(O.heroRuntime.expKey),
      heroes[i].exp,
    );
  }

  return m;
}

describe("readRuntimeHeroes", () => {
  it("reads the party with heroKey and decoded (obscured) level and exp", () => {
    const m = seedParty(new FakeMemory(), SM_SINGLETON, [
      { heroKey: 1001, level: 50, exp: 12345 },
      { heroKey: 1002, level: 30, exp: 6789 },
    ]);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes).toHaveLength(2);
    expect(result.heroes![0]).toEqual({ heroKey: 1001, level: 50, exp: 12345 });
    expect(result.heroes![1]).toEqual({ heroKey: 1002, level: 30, exp: 6789 });
  });

  it("returns null when smPtr is null (unresolved StageManager)", () => {
    const result = readRuntimeHeroes(new FakeMemory(), O, null);
    expect(result.heroes).toBeNull();
    expect(result.status).toMatch(/StageManager unresolved/i);
  });

  it("returns null when the HeroList pointer is missing", () => {
    // smPtr provided but no HeroList seeded off it
    const result = readRuntimeHeroes(new FakeMemory(), O, SM_SINGLETON);
    expect(result.heroes).toBeNull();
    expect(result.status).toMatch(/HeroList ptr null/i);
  });

  it("skips hero slots with an invalid heroKey", () => {
    const m = seedParty(new FakeMemory(), SM_SINGLETON, [
      { heroKey: 0, level: 1, exp: 0 }, // invalid — heroKey 0 skipped
      { heroKey: 1003, level: 10, exp: 500 },
    ]);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes).toHaveLength(1);
    expect(result.heroes![0].heroKey).toBe(1003);
  });

  it("returns null when the party is empty", () => {
    const m = seedParty(new FakeMemory(), SM_SINGLETON, []);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes).toBeNull();
    expect(result.status).toMatch(/party empty/i);
  });

  it("returns null when hero count exceeds MAX_HEROES (21)", () => {
    const m = new FakeMemory()
      .writePtr(SM_SINGLETON + BigInt(O.runtime.heroList), HERO_LIST_OBJ)
      .writeI32(HERO_LIST_OBJ + BigInt(O.container.listSize), 21); // exceeds MAX_HEROES
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes).toBeNull();
    expect(result.status).toMatch(/exceeds MAX_HEROES/i);
  });
});

// ── resolveStageManager ───────────────────────────────────────────────────────

/** Seed the StageManager class → static block; the instance lives at block+field. */
function seedSmClass(m: FakeMemory, instanceFieldOffset: number, instance: bigint): FakeMemory {
  return m
    .writePtr(GA_BASE + O.typeInfoRva.stageManager, SM_CLASS)
    .writePtr(SM_CLASS + BigInt(CAND), SM_BLOCK)
    .writePtr(SM_BLOCK + BigInt(instanceFieldOffset), instance);
}

describe("resolveStageManager", () => {
  it("finds the party-bearing instance by scanning the static block", () => {
    const m = seedSmClass(new FakeMemory(), 0x40, SM_SINGLETON);
    seedParty(m, SM_SINGLETON, [{ heroKey: 1001, level: 5, exp: 10 }]);
    const pin = makeSmPinState();
    expect(resolveStageManager(m, GA_BASE, GA_SIZE, O, pin)).toBe(SM_SINGLETON);
    expect(pin.ptr).toBe(SM_SINGLETON);
  });

  it("reuses the pinned pointer without rescanning the block", () => {
    const m = seedSmClass(new FakeMemory(), 0x40, SM_SINGLETON);
    seedParty(m, SM_SINGLETON, [{ heroKey: 1001, level: 5, exp: 10 }]);
    const pin = makeSmPinState();
    resolveStageManager(m, GA_BASE, GA_SIZE, O, pin);

    // Break the static-block link — a rescan would now fail, but the pin holds.
    m.writePtr(SM_BLOCK + BigInt(0x40), 0x1n);
    expect(resolveStageManager(m, GA_BASE, GA_SIZE, O, pin)).toBe(SM_SINGLETON);
  });

  it("returns null when no party-bearing instance is in the block", () => {
    const m = new FakeMemory()
      .writePtr(GA_BASE + O.typeInfoRva.stageManager, SM_CLASS)
      .writePtr(SM_CLASS + BigInt(CAND), SM_BLOCK); // block resolves, no instance seeded
    const pin = makeSmPinState();
    expect(resolveStageManager(m, GA_BASE, GA_SIZE, O, pin)).toBeNull();
  });
});

// ── readRuntimeChestLog ───────────────────────────────────────────────────────

// V1_00_21 leaves logManager RVA at 0n (derived at runtime); patch a fake one in.
const LOG_O = { ...O, typeInfoRva: { ...O.typeInfoRva, logManager: 0x120000n } };

const LOG_CLASS = 0xd00000n;
const LOG_BLOCK = 0xd10000n;
const LM_INSTANCE = 0xd20000n;
const LOG_DICT = 0xd30000n;
const LOG_DICT_ENTRIES = 0xd40000n;
const GETBOX_LIST = 0xd50000n;
const GETBOX_ARR = 0xd60000n;

/** Seed LogManager → logByType dict → GetBox List<GetBoxLog> with the given types. */
function seedLogChain(m: FakeMemory, monsterTypes: number[]): FakeMemory {
  // LogManager TypeInfo → class → static block → instance (found by static-block scan)
  m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
    .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
    .writePtr(LOG_BLOCK, LM_INSTANCE); // instance at static block +0

  // instance + logByType(0x28) → Dictionary<ELogType, List<LogData>>
  m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
    .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
    .writeI32(LOG_DICT + BigInt(O.dict.count), 1);

  // one dict entry: key = ELogType.GetBox → value = GetBox list
  const de = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
  m.writeI32(de + BigInt(O.dict.entryHash), 1)
    .writeI32(de + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
    .writePtr(de + BigInt(O.dict.entryValue), GETBOX_LIST);

  // GetBox List<GetBoxLog>: backing array + size + entries
  m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
    GETBOX_LIST + BigInt(O.container.listSize),
    monsterTypes.length,
  );
  const first = GETBOX_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < monsterTypes.length; i++) {
    const entry = 0xe00000n + BigInt(i * 0x100);
    m.writePtr(first + BigInt(i * 8), entry).writeI32(
      entry + BigInt(O.runtime.getBoxLog.monsterType),
      monsterTypes[i],
    );
  }
  return m;
}

describe("readRuntimeChestLog", () => {
  it("returns null when logManager RVA is 0 (not derived for this version)", () => {
    const result = readRuntimeChestLog(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      O,
      makeChestLogPinState(),
    );
    expect(result.drops).toBeNull();
    expect(result.status).toMatch(/logManager RVA = 0/i);
  });

  it("primes to the current log length on first read (backlog not counted)", () => {
    const pin = makeChestLogPinState();
    const m = seedLogChain(new FakeMemory(), [0, 1]); // pre-existing backlog
    const result = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(result.drops).toEqual([]);
    expect(pin.lastCount).toBe(2);
  });

  it("classifies new drops by EMonsterLogType (0 common, 1 rare, 2 act boss)", () => {
    const pin = makeChestLogPinState();
    pin.primed = true; // skip priming so all entries are treated as new
    pin.lastCount = 0;
    const m = seedLogChain(new FakeMemory(), [0, 1, 2]);
    const result = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(result.drops).toEqual(["common", "rare", "act"]);
  });

  it("returns only drops appended since the last read", () => {
    const pin = makeChestLogPinState();
    const m = seedLogChain(new FakeMemory(), [0]);
    readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin); // prime at length 1
    seedLogChain(m, [0, 1, 2]); // two new drops appended (rare + act boss)
    const result = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(result.drops).toEqual(["rare", "act"]);
  });

  it("realigns the tail and returns no drops when the log shrinks", () => {
    // A shrink is either a memory-read race, a ring-buffer eviction, or a new
    // run clearing the log. In every case the tail must NOT re-read history
    // from 0 — that would classify the entire backlog as new drops and fire
    // phantom chest-drop events. The tail realigns to `count` and returns [].
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 5; // pretend we had seen 5 entries
    const m = seedLogChain(new FakeMemory(), [1]); // log now shorter (count=1)
    const result = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(result.drops).toEqual([]);
    expect(pin.lastCount).toBe(1); // realigned, not reset to 0
  });
});

// ── readRuntimeStageClears ─────────────────────────────────────────────────────

const STAGE_CLEAR_LIST = 0xd70000n;
const STAGE_CLEAR_ARR = 0xd80000n;

/**
 * Seed LogManager → logByType dict → StageClear List<StageClearLog> with the
 * given entries. Each entry is `[act, stage, clearTimeSec]`. `act`/`stage` are
 * written to StageClearLog+0x40 / +0x44; pass `0` for either to simulate a
 * corrupted / mid-write read (the reader should then surface `act:0`/`stage:0`
 * so the caller falls back to the current stageKey).
 */
function seedStageClearChain(m: FakeMemory, entries: [number, number, number][]): FakeMemory {
  m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
    .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
    .writePtr(LOG_BLOCK, LM_INSTANCE);

  m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
    .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
    .writeI32(LOG_DICT + BigInt(O.dict.count), 2);

  const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
  m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
    .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
    .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);

  const de1 = LOG_DICT_ENTRIES + BigInt(1 * O.dict.entrySize) + BigInt(O.container.arrayFirst);
  m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
    .writeI32(de1 + BigInt(O.dict.entryKey), O.runtime.log.stageClearTypeKey)
    .writePtr(de1 + BigInt(O.dict.entryValue), STAGE_CLEAR_LIST);

  // GetBox list must stay walkable — it's the LogManager liveness check.
  m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
    GETBOX_LIST + BigInt(O.container.listSize),
    0,
  );

  m.writePtr(STAGE_CLEAR_LIST + BigInt(O.container.listItems), STAGE_CLEAR_ARR).writeI32(
    STAGE_CLEAR_LIST + BigInt(O.container.listSize),
    entries.length,
  );
  const first = STAGE_CLEAR_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < entries.length; i++) {
    const entry = 0xe10000n + BigInt(i * 0x100);
    const [act, stage, clearTimeSec] = entries[i]!;
    m.writePtr(first + BigInt(i * 8), entry)
      .writeI32(entry + BigInt(O.runtime.stageClearLog.act), act)
      .writeI32(entry + BigInt(O.runtime.stageClearLog.stage), stage)
      .writeI32(entry + BigInt(O.runtime.stageClearLog.clearTimeSec), clearTimeSec);
  }
  return m;
}

describe("readRuntimeStageClears", () => {
  it("returns null when logManager RVA is 0 (not derived for this version)", () => {
    expect(
      readRuntimeStageClears(new FakeMemory(), GA_BASE, GA_SIZE, O, makeStageClearPinState()),
    ).toBeNull();
  });

  it("primes to the current log length on first read (backlog not counted)", () => {
    const pin = makeStageClearPinState();
    const m = seedStageClearChain(new FakeMemory(), [
      [3, 1, 42],
      [3, 1, 85],
    ]); // pre-existing backlog
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([]);
    expect(pin.lastCount).toBe(2);
  });

  it("returns entries (act/stage/clearTimeSec) appended since the last read", () => {
    const pin = makeStageClearPinState();
    const m = seedStageClearChain(new FakeMemory(), [[3, 1, 85]]);
    readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin); // prime at length 1
    seedStageClearChain(m, [
      [3, 1, 85],
      [3, 2, 63],
    ]); // one new clear appended (stage 3-2)
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 3, stage: 2, clearTimeSec: 63, valid: true },
    ]);
  });

  it("rejects implausible clear times (corrupted / mid-write read)", () => {
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 0;
    const m = seedStageClearChain(new FakeMemory(), [
      [3, 1, 0],
      [3, 1, -1],
      [3, 1, 999_999],
      [3, 1, 85],
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 3, stage: 1, clearTimeSec: 85, valid: true },
    ]);
  });

  it("marks valid=false when act/stage read out of plausibility range", () => {
    // Mid-write / corrupted act/stage: each out-of-range field is clamped to 0
    // independently and `valid` is set to false. The caller (TrackingService)
    // drops invalid entries instead of falling back to the live stageKey —
    // the fallback would re-introduce the off-by-one attribution bug.
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 0;
    const m = seedStageClearChain(new FakeMemory(), [
      [0, 0, 42], // both zero → valid=false
      [12, 1, 43], // act out of range (1-9) → act clamped to 0, valid=false
      [3, 200, 44], // stage out of range (1-99) → stage clamped to 0, valid=false
      [3, 1, 85], // valid
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 0, stage: 0, clearTimeSec: 42, valid: false },
      { act: 0, stage: 1, clearTimeSec: 43, valid: false },
      { act: 3, stage: 0, clearTimeSec: 44, valid: false },
      { act: 3, stage: 1, clearTimeSec: 85, valid: true },
    ]);
  });

  it("realigns the tail and returns no clears when the log shrinks", () => {
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 5;
    const m = seedStageClearChain(new FakeMemory(), [[3, 1, 12]]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([]);
    expect(pin.lastCount).toBe(1);
  });
});

// ── readRuntimeBoxOpenLog ────────────────────────────────────────────────────

const BOX_OPEN_LIST = 0xd90000n;
const BOX_OPEN_ARR = 0xda0000n;

// Patch offsets so boxOpenLog fields are non-zero (simulating a derived version).
const BOX_LOG_O = {
  ...LOG_O,
  runtime: {
    ...LOG_O.runtime,
    log: { ...LOG_O.runtime.log, getItemWithBoxOpenTypeKey: 99 },
    boxOpenLog: {
      itemStringKey: 0x10,
      itemGradeType: 0x0,
      gradeSO: 0,
      gradeSOGrade: 0,
      boxType: 0x14,
      level: 0x18,
    },
  },
};

/** Seed LogManager -> logByType dict -> GetItemWithBoxOpen List<BoxOpenLog>. */
function seedBoxOpenChain(
  m: FakeMemory,
  entries: Array<{ itemKey: number; boxType?: number; level?: number }>,
): FakeMemory {
  m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
    .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
    .writePtr(LOG_BLOCK, LM_INSTANCE);

  // Two dict entries: GetBox (liveness check) + GetItemWithBoxOpen
  m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
    .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
    .writeI32(LOG_DICT + BigInt(O.dict.count), 2);

  // Entry 0: GetBox list (must stay walkable for liveness check)
  const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
  m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
    .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
    .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);
  m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
    GETBOX_LIST + BigInt(O.container.listSize),
    0,
  );

  // Entry 1: GetItemWithBoxOpen list
  const de1 = de0 + BigInt(O.dict.entrySize);
  m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
    .writeI32(de1 + BigInt(O.dict.entryKey), 99) // matches BOX_LOG_O.runtime.log.getItemWithBoxOpenTypeKey
    .writePtr(de1 + BigInt(O.dict.entryValue), BOX_OPEN_LIST);

  m.writePtr(BOX_OPEN_LIST + BigInt(O.container.listItems), BOX_OPEN_ARR).writeI32(
    BOX_OPEN_LIST + BigInt(O.container.listSize),
    entries.length,
  );

  const first = BOX_OPEN_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < entries.length; i++) {
    const entry = 0xeb0000n + BigInt(i * 0x100);
    m.writePtr(first + BigInt(i * 8), entry);
    m.writeI32(entry + BigInt(0x10), entries[i].itemKey); // itemStringKey at +0x10 (test offset)
    if (entries[i].boxType != null) {
      m.writeI32(entry + BigInt(0x14), entries[i].boxType!); // boxType at +0x14
    }
    if (entries[i].level != null) {
      m.writeI32(entry + BigInt(0x18), entries[i].level!); // level at +0x18
    }
  }
  return m;
}

describe("readRuntimeBoxOpenLog", () => {
  it("returns null when logManager RVA is 0 (not derived)", () => {
    const result = readRuntimeBoxOpenLog(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      O,
      makeBoxOpenPinState(),
    );
    expect(result.opens).toBeNull();
    expect(result.status).toMatch(/logManager RVA = 0/i);
  });

  it("returns null when getItemWithBoxOpenTypeKey is 0 (not derived)", () => {
    const result = readRuntimeBoxOpenLog(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      LOG_O,
      makeBoxOpenPinState(),
    );
    expect(result.opens).toBeNull();
    expect(result.status).toMatch(/getItemWithBoxOpenTypeKey/i);
  });

  it("primes to the current log length on first read (backlog not counted)", () => {
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017 }]);
    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toEqual([]);
    expect(pin.lastCount).toBe(1);
  });

  it("reads new entries since the last read", () => {
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1, level: 3 }]);
    readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin); // prime
    seedBoxOpenChain(m, [
      { itemKey: 530017, boxType: 1, level: 3 },
      { itemKey: 530018, boxType: 0, level: 5 },
    ]);
    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toHaveLength(1);
    expect(result.opens![0].itemKey).toBe(530018);
    expect(result.opens![0].boxType).toBe(0);
    expect(result.opens![0].level).toBe(5);
  });

  it("realigns the tail and returns no opens when the log shrinks", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 5;
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1 }]);
    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toEqual([]);
    expect(pin.lastCount).toBe(1);
  });

  it("retries a mid-write entry: null itemKey on sample 1, valid on sample 2", () => {
    // Simulates the game appending a BoxOpenLog entry: the slot pointer is
    // already written but the itemKey field is still zero on the first read,
    // then becomes valid on the second read. The multi-sample loop should
    // retry and surface the entry instead of silently dropping it.
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1, level: 3 }]);
    readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin); // prime

    // Append a new entry at slot 1: pointer set, itemKey=0 initially.
    const newEntry = 0xb70000n;
    const first = BOX_OPEN_ARR + BigInt(BOX_LOG_O.container.arrayFirst);
    m.writePtr(first + 8n, newEntry);
    // Pre-seed itemKey=0: the slot is allocated but the writer hasn't yet
    // committed the real value. FakeMemory returns null for unseeded addresses,
    // so we must explicitly seed 0 to model "field exists but is zero".
    m.writeI32(newEntry + BigInt(BOX_LOG_O.runtime.boxOpenLog.itemStringKey), 0);
    // Bump the list size to 2 — the slot is "allocated" but itemKey not yet
    // committed. seedBoxOpenChain's I32 write at +itemStringKey hasn't run.
    m.writeI32(BOX_OPEN_LIST + BigInt(BOX_LOG_O.container.listSize), 2);

    // Track readBytes calls so we can flip the itemKey on the second sample.
    const origRead = m.readBytes.bind(m);
    let flipped = false;
    m.readBytes = (addr: bigint, size: number) => {
      // After the first itemStringKey read at the new entry, plant the value.
      // The first read of the new entry's itemKey returns 0 (plausible but
      // filtered as itemKey<=0). Subsequent reads return the real value.
      if (addr === newEntry + BigInt(BOX_LOG_O.runtime.boxOpenLog.itemStringKey)) {
        // Flip the I32 in the underlying map after the first 4-byte read returns.
        const v = origRead(addr, size);
        if (!flipped && v && v.length >= 4 && v.readInt32LE(0) === 0) {
          // Plant the real itemKey on the first probe; subsequent reads see it.
          m.writeI32(addr, 530018);
          flipped = true;
        }
        return v;
      }
      return origRead(addr, size);
    };

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toHaveLength(1);
    expect(result.opens![0].itemKey).toBe(530018);
  });

  it("drops an entry whose itemKey stays null across all samples", () => {
    // Slot is allocated but itemKey never becomes valid (e.g. the game's
    // write was preempted). After BOX_OPEN_LOG_SAMPLES samples, the entry
    // is dropped — no entry surfaces, but the tail still advances.
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1 }]);
    readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin); // prime

    // Append a phantom slot: pointer is null (unreadable). All 3 samples fail.
    const first = BOX_OPEN_ARR + BigInt(BOX_LOG_O.container.arrayFirst);
    m.writePtr(first + 8n, 0n); // null pointer
    m.writeI32(BOX_OPEN_LIST + BigInt(BOX_LOG_O.container.listSize), 2);

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toEqual([]); // phantom slot dropped
    expect(pin.lastCount).toBe(2); // tail still advances past the bad slot
  });

  // Regression: v1.00.28 stores itemStringKey as a System.String pointer.
  // readI32 on the pointer's low 4 bytes returns a non-negative garbage int
  // (e.g. 0x65909340 = 1703973696) that is NOT a plausible catalog itemKey.
  // The String-pointer path is tried FIRST, so the field is decoded from the
  // IL2CPP String's localization key ("ItemName_530017" → 530017) instead of
  // the garbage low dword. This also keeps the itemKey stable across app
  // restarts (heap address changes but the extracted id doesn't), so
  // reclassify persists across sessions.
  it("decodes itemStringKey from the String pointer even when the low dword is non-plausible", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;

    const m = new FakeMemory();
    // itemStringKey field at +0x10 holds a System.String pointer. The pointer's
    // low 32 bits = 0x65909340 (positive as int32, but NOT a plausible catalog
    // itemKey). The String object lives at the pointer's full 64-bit value.
    // We use STRING_OBJ as both the pointer value AND the object address.
    const STRING_OBJ = 0x0000_0001_6590_9340n;

    // Seed LogManager -> logByType dict -> GetItemWithBoxOpen List<BoxOpenLog>
    // with a single entry whose itemStringKey field holds a String pointer.
    m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
      .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
      .writePtr(LOG_BLOCK, LM_INSTANCE);
    m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
      .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
      .writeI32(LOG_DICT + BigInt(O.dict.count), 2);
    const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
    m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
      .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
      .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);
    m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
      GETBOX_LIST + BigInt(O.container.listSize),
      0,
    );
    const de1 = de0 + BigInt(O.dict.entrySize);
    m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
      .writeI32(de1 + BigInt(O.dict.entryKey), 99)
      .writePtr(de1 + BigInt(O.dict.entryValue), BOX_OPEN_LIST);
    m.writePtr(BOX_OPEN_LIST + BigInt(O.container.listItems), BOX_OPEN_ARR).writeI32(
      BOX_OPEN_LIST + BigInt(O.container.listSize),
      1,
    );
    const entry = 0xeb0000n;
    m.writePtr(BOX_OPEN_ARR + BigInt(O.container.arrayFirst), entry);
    // itemStringKey at +0x10 = String pointer (low dword = 0x65909340, non-plausible)
    m.writePtr(entry + BigInt(0x10), STRING_OBJ);
    // String object at STRING_OBJ: +0x10 = char length, +0x14 = UTF-16 chars
    const content = "ItemName_530017";
    m.writeI32(STRING_OBJ + 0x10n, content.length);
    m.writeBytes(STRING_OBJ + 0x14n, Buffer.from(content, "utf16le"));

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toHaveLength(1);
    // Extracted from "ItemName_530017" trailing digits, NOT 0x65909340.
    expect(result.opens![0].itemKey).toBe(530017);
  });

  // Regression: v1.00.28 String pointer's low 32 bits can coincidentally fall
  // IN the catalog id range (e.g. 600017, which is in 110001-939999). The
  // String-pointer path must still be tried FIRST — otherwise the garbage
  // 600017 would be accepted as a "plausible" itemKey and the loot table
  // would show #600017 (catalog has no such id) instead of the real item.
  // This is the root cause of #600017 appearing as an unknown item.
  it("decodes itemStringKey from the String pointer even when the low dword lands in the catalog range", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;

    const m = new FakeMemory();
    // Pointer low dword = 0x92711 = 600017 (IN catalog range, plausible as
    // int32). High dword makes the full pointer a plausible heap addr.
    const STRING_OBJ = 0x0000_0001_0009_2711n;

    m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
      .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
      .writePtr(LOG_BLOCK, LM_INSTANCE);
    m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
      .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
      .writeI32(LOG_DICT + BigInt(O.dict.count), 2);
    const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
    m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
      .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
      .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);
    m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
      GETBOX_LIST + BigInt(O.container.listSize),
      0,
    );
    const de1 = de0 + BigInt(O.dict.entrySize);
    m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
      .writeI32(de1 + BigInt(O.dict.entryKey), 99)
      .writePtr(de1 + BigInt(O.dict.entryValue), BOX_OPEN_LIST);
    m.writePtr(BOX_OPEN_LIST + BigInt(O.container.listItems), BOX_OPEN_ARR).writeI32(
      BOX_OPEN_LIST + BigInt(O.container.listSize),
      1,
    );
    const entry = 0xeb0000n;
    m.writePtr(BOX_OPEN_ARR + BigInt(O.container.arrayFirst), entry);
    // itemStringKey at +0x10 = String pointer (low dword = 600017, plausible)
    m.writePtr(entry + BigInt(0x10), STRING_OBJ);
    // String object at STRING_OBJ: localization key "ItemName_601171"
    // (Ethereal Amulet UNCOMMON — catalog id 601171, NOT 600017)
    const content = "ItemName_601171";
    m.writeI32(STRING_OBJ + 0x10n, content.length);
    m.writeBytes(STRING_OBJ + 0x14n, Buffer.from(content, "utf16le"));

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toHaveLength(1);
    // Extracted from "ItemName_601171" → 601171 (real catalog id), NOT 600017.
    expect(result.opens![0].itemKey).toBe(601171);
  });

  // Regression: v1.00.28 String pointer with an UNREADABLE target (string
  // memory paged out / freed / not yet initialized). The String-pointer path
  // fails (readIl2CppString returns null), and the pointer's low 32 bits are
  // a heap-address low dword OUTSIDE the catalog range (e.g. 0x15D95800 =
  // 367177440). Without the range guard in the allowString branch, the
  // readI32 fallback would return 367177440, which /1000-normalization
  // (catalogItemKeyFromSave) maps to 367177 — coincidentally IN [110001,
  // 939999] — bypassing garbage filters and surfacing a ghost "#367177440"
  // entry in the loot list (root cause of the user-reported #367177440
  // drop). With the guard, readBoxOpenLogField returns null and the entry
  // is dropped (opens stays empty).
  it("drops the entry when the String pointer is unreadable and the low dword is outside the catalog range", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;

    const m = new FakeMemory();
    // Pointer low dword = 0x15D95800 = 367177440 (OUTSIDE [110001, 939999]).
    // High dword makes the full pointer a plausible heap addr. The String
    // object at STRING_OBJ is intentionally NOT seeded — readIl2CppString
    // reads length from uninitialized memory → null → returns null.
    const STRING_OBJ = 0x0000_0001_15D9_5800n;

    m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
      .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
      .writePtr(LOG_BLOCK, LM_INSTANCE);
    m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
      .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
      .writeI32(LOG_DICT + BigInt(O.dict.count), 2);
    const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
    m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
      .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
      .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);
    m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
      GETBOX_LIST + BigInt(O.container.listSize),
      0,
    );
    const de1 = de0 + BigInt(O.dict.entrySize);
    m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
      .writeI32(de1 + BigInt(O.dict.entryKey), 99)
      .writePtr(de1 + BigInt(O.dict.entryValue), BOX_OPEN_LIST);
    m.writePtr(BOX_OPEN_LIST + BigInt(O.container.listItems), BOX_OPEN_ARR).writeI32(
      BOX_OPEN_LIST + BigInt(O.container.listSize),
      1,
    );
    const entry = 0xeb0000n;
    m.writePtr(BOX_OPEN_ARR + BigInt(O.container.arrayFirst), entry);
    // itemStringKey at +0x10 = String pointer whose target is never seeded.
    m.writePtr(entry + BigInt(0x10), STRING_OBJ);

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    // Entry dropped: no valid itemKey could be extracted (range guard
    // returned null instead of the garbage low dword 367177440).
    expect(result.opens).toHaveLength(0);
  });

  // Plain-int32 layout (v1.00.21/23/27): itemStringKey is a real int32 field.
  // The String-pointer path is tried first but fails (the int32 value isn't a
  // plausible heap pointer to a real String), so we fall back to the raw
  // int32. This guards against regressing older game versions.
  it("falls back to plain int32 when the String-pointer path fails (plain-int32 layout)", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;

    const m = new FakeMemory();
    // Seed a plain int32 itemKey (no String object backing it).
    m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
      .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
      .writePtr(LOG_BLOCK, LM_INSTANCE);
    m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
      .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
      .writeI32(LOG_DICT + BigInt(O.dict.count), 2);
    const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
    m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
      .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
      .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);
    m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
      GETBOX_LIST + BigInt(O.container.listSize),
      0,
    );
    const de1 = de0 + BigInt(O.dict.entrySize);
    m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
      .writeI32(de1 + BigInt(O.dict.entryKey), 99)
      .writePtr(de1 + BigInt(O.dict.entryValue), BOX_OPEN_LIST);
    m.writePtr(BOX_OPEN_LIST + BigInt(O.container.listItems), BOX_OPEN_ARR).writeI32(
      BOX_OPEN_LIST + BigInt(O.container.listSize),
      1,
    );
    const entry = 0xeb0000n;
    m.writePtr(BOX_OPEN_ARR + BigInt(O.container.arrayFirst), entry);
    // itemStringKey at +0x10 = plain int32 = 530017 (no String object).
    // readPtr will read 8 bytes but the address isn't a real String → null.
    m.writeI32(entry + BigInt(0x10), 530017);

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toHaveLength(1);
    expect(result.opens![0].itemKey).toBe(530017);
  });
});

// ── peekBoxOpenLogCount ──────────────────────────────────────────────────────

// Same as BOX_LOG_O but with boxOpenLog.itemStringKey = 0 — exactly the
// scenario where readRuntimeBoxOpenLog early-returns null but the heal
// scheduler still needs to observe the list length to detect a box-open event.
const PEEK_O = {
  ...LOG_O,
  runtime: {
    ...LOG_O.runtime,
    log: { ...LOG_O.runtime.log, getItemWithBoxOpenTypeKey: 99 },
    boxOpenLog: {
      itemStringKey: 0,
      itemGradeType: 0,
      gradeSO: 0,
      gradeSOGrade: 0,
      boxType: 0,
      level: 0,
    },
  },
};

describe("peekBoxOpenLogCount", () => {
  it("returns null when logManager RVA is 0 (not derived)", () => {
    const result = peekBoxOpenLogCount(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      O,
      makeBoxOpenPinState(),
    );
    expect(result.count).toBeNull();
    expect(result.status).toMatch(/logManager RVA = 0/i);
  });

  it("returns null when getItemWithBoxOpenTypeKey is 0 (not derived)", () => {
    // LOG_O has logManager set but getItemWithBoxOpenTypeKey = 0
    const result = peekBoxOpenLogCount(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      LOG_O,
      makeBoxOpenPinState(),
    );
    expect(result.count).toBeNull();
    expect(result.status).toMatch(/getItemWithBoxOpenTypeKey/i);
  });

  it("returns the list count without requiring boxOpenLog.itemStringKey", () => {
    // PEEK_O: logManager + getItemWithBoxOpenTypeKey derived, itemStringKey = 0.
    // This is the exact scenario the heal scheduler faces on v1.00.28 before the
    // player opens a box: readRuntimeBoxOpenLog early-returns null, but peek
    // must still see the list length to detect the 0→>0 transition.
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 1001 }]);
    const result = peekBoxOpenLogCount(m, GA_BASE, GA_SIZE, PEEK_O, pin);
    expect(result.count).toBe(1);
    expect(result.status).toBe("");
  });

  it("reports count=0 when the list is walkable but empty", () => {
    // List walkable + count 0 is a valid state (player hasn't opened a box).
    // The heal scheduler treats 0→>0 as the box-open trigger, so 0 must be a
    // real number here, not null (null means "we couldn't even look").
    const m = seedBoxOpenChain(new FakeMemory(), []);
    const result = peekBoxOpenLogCount(m, GA_BASE, GA_SIZE, PEEK_O, makeBoxOpenPinState());
    expect(result.count).toBe(0);
    expect(result.status).toBe("");
  });

  it("does not touch the pin's lastCount/primed (independent of tail bookkeeping)", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 42;
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 1 }, { itemKey: 2 }]);
    peekBoxOpenLogCount(m, GA_BASE, GA_SIZE, PEEK_O, pin);
    expect(pin.primed).toBe(true);
    expect(pin.lastCount).toBe(42);
  });

  it("caches the resolved LogManager pointer on the pin across calls", () => {
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 1 }]);
    expect(pin.ptr).toBeNull();
    peekBoxOpenLogCount(m, GA_BASE, GA_SIZE, PEEK_O, pin);
    expect(pin.ptr).not.toBeNull();
    // A second peek on the same memory should reuse the cached ptr.
    const before = pin.ptr;
    peekBoxOpenLogCount(m, GA_BASE, GA_SIZE, PEEK_O, pin);
    expect(pin.ptr).toBe(before);
  });

  it("returns null when the LogManager singleton cannot be resolved", () => {
    // PEEK_O has logManager RVA set, but the memory is empty — static block
    // scan cannot find a live LogManager. resolveLogManager returns null.
    const m = new FakeMemory();
    m.writePtr(GA_BASE + PEEK_O.typeInfoRva.logManager, LOG_CLASS);
    // Don't seed the static block / instance — singleton scan fails.
    const result = peekBoxOpenLogCount(m, GA_BASE, GA_SIZE, PEEK_O, makeBoxOpenPinState());
    expect(result.count).toBeNull();
    expect(result.status).toMatch(/LogManager singleton unresolved|list not walkable/i);
  });
});

// ── readRuntimeInventory (PlayerSaveData.itemSaveDatas snapshot) ──────────────

const INV_CS_CLASS = 0xf00000n;
const INV_CS_BLOCK = 0xf10000n;
const INV_PLAYER = 0xf20000n;
const INV_LIST = 0xf30000n;
const INV_ARR = 0xf40000n;

function seedInventoryChain(
  m: FakeMemory,
  items: Array<{ itemKey: number; isChaotic: boolean }>,
): FakeMemory {
  // CommonSaveData TypeInfo → class → static block → playerPtr at +commonSaveData(0x10)
  m.writePtr(GA_BASE + O.typeInfoRva.commonSaveData, INV_CS_CLASS)
    .writePtr(INV_CS_CLASS + BigInt(CAND), INV_CS_BLOCK)
    .writePtr(INV_CS_BLOCK + BigInt(O.player.commonSaveData), INV_PLAYER);

  // player → itemSaveDatas List<ItemSaveData>
  m.writePtr(INV_PLAYER + BigInt(O.player.itemSaveDatas), INV_LIST)
    .writePtr(INV_LIST + BigInt(O.container.listItems), INV_ARR)
    .writeI32(INV_LIST + BigInt(O.container.listSize), items.length);

  const first = INV_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < items.length; i++) {
    const itemAddr = 0xf50000n + BigInt(i * 0x100);
    m.writePtr(first + BigInt(i * 8), itemAddr)
      .writeI32(itemAddr + BigInt(O.inventoryItem.itemKey), items[i].itemKey)
      .writeI32(itemAddr + BigInt(O.inventoryItem.isChaotic), items[i].isChaotic ? 1 : 0);
  }
  return m;
}

describe("readRuntimeInventory", () => {
  it("returns null when itemSaveDatas offset is 0 (not derived)", () => {
    const patched = { ...O, player: { ...O.player, itemSaveDatas: 0 } };
    const result = readRuntimeInventory(
      seedInventoryChain(new FakeMemory(), []),
      GA_BASE,
      GA_SIZE,
      patched,
    );
    expect(result.items).toBeNull();
    expect(result.status).toMatch(/itemSaveDatas offset = 0/i);
  });

  it("reads items from the itemSaveDatas list", () => {
    const m = seedInventoryChain(new FakeMemory(), [
      { itemKey: 910151, isChaotic: false },
      { itemKey: 920201, isChaotic: true },
    ]);
    const result = readRuntimeInventory(m, GA_BASE, GA_SIZE, O);
    expect(result.items).toHaveLength(2);
    expect(result.items![0]).toEqual({ itemKey: 910151, isChaotic: false });
    expect(result.items![1]).toEqual({ itemKey: 920201, isChaotic: true });
  });

  it("skips entries with zero or negative itemKey", () => {
    const m = seedInventoryChain(new FakeMemory(), [
      { itemKey: 0, isChaotic: false }, // skipped
      { itemKey: 910152, isChaotic: false },
    ]);
    const result = readRuntimeInventory(m, GA_BASE, GA_SIZE, O);
    expect(result.items).toHaveLength(1);
    expect(result.items![0].itemKey).toBe(910152);
  });

  it("returns null when the player pointer is unreadable", () => {
    const result = readRuntimeInventory(new FakeMemory(), GA_BASE, GA_SIZE, O);
    expect(result.items).toBeNull();
    expect(result.status).toMatch(/CommonSaveData singleton.*static field unreadable/i);
  });

  it("uses the bulk pointer-array read path when the backing array is contiguous", () => {
    // Seed the pointer array as ONE contiguous buffer (the bulk-read fast path).
    // Per-entry structs are still seeded per-field (so the per-entry bulk-read
    // also takes the fast path: 8 bytes covering itemKey@0x10 + isChaotic@0x20).
    const items = [
      { itemKey: 930101, isChaotic: false },
      { itemKey: 930202, isChaotic: true },
      { itemKey: 930303, isChaotic: false },
    ];
    const m = new FakeMemory();
    // CommonSaveData → player chain
    m.writePtr(GA_BASE + O.typeInfoRva.commonSaveData, INV_CS_CLASS)
      .writePtr(INV_CS_CLASS + BigInt(CAND), INV_CS_BLOCK)
      .writePtr(INV_CS_BLOCK + BigInt(O.player.commonSaveData), INV_PLAYER);
    m.writePtr(INV_PLAYER + BigInt(O.player.itemSaveDatas), INV_LIST)
      .writePtr(INV_LIST + BigInt(O.container.listItems), INV_ARR)
      .writeI32(INV_LIST + BigInt(O.container.listSize), items.length);

    // Bulk pointer array: 3 × 8 bytes at INV_ARR + arrayFirst
    const first = INV_ARR + BigInt(O.container.arrayFirst);
    const ptrBuf = Buffer.alloc(items.length * 8);
    // Per-entry struct buffer: covers itemKey@0x10 → isChaotic+4@0x24 = 0x14 bytes
    const itemKeyOff = O.inventoryItem.itemKey;
    const isChaoticOff = O.inventoryItem.isChaotic;
    const fieldStart = Math.min(itemKeyOff, isChaoticOff);
    const fieldSpan = Math.max(itemKeyOff + 4, isChaoticOff + 4) - fieldStart;
    for (let i = 0; i < items.length; i++) {
      const itemAddr = 0xf50000n + BigInt(i * 0x100);
      ptrBuf.writeBigUInt64LE(itemAddr, i * 8);
      // Single bulk struct buffer per entry
      const structBuf = Buffer.alloc(fieldSpan);
      structBuf.writeInt32LE(items[i].itemKey, itemKeyOff - fieldStart);
      structBuf.writeInt32LE(items[i].isChaotic ? 1 : 0, isChaoticOff - fieldStart);
      m.writeBytes(itemAddr + BigInt(fieldStart), structBuf);
    }
    m.writeBytes(first, ptrBuf);

    const result = readRuntimeInventory(m, GA_BASE, GA_SIZE, O);
    expect(result.items).toHaveLength(3);
    expect(result.items).toEqual(items);
  });
});

// ── readRuntimePets ───────────────────────────────────────────────────────────

const PET_PET_SAVEDS_OFFSET = 0x60;
const PET_KEY_OFFSET = 0x10;
const PET_UNLOCK_OFFSET = 0x14;

const PET_O = {
  ...O,
  player: { ...O.player, petSaveDatas: PET_PET_SAVEDS_OFFSET },
  petSaveData: { petKey: PET_KEY_OFFSET, isUnlock: PET_UNLOCK_OFFSET },
};

const CS_CLASS_P = 0xb00000n;
const CS_BLOCK_P = 0xc00000n;
const PLAYER_OBJ = 0xc10000n;
const PET_LIST_OBJ = 0xc20000n;
const PET_ITEMS_ARR = 0xc30000n;
const PET1 = 0xc40000n;
const PET2 = 0xc50000n;

function seedPetChain(
  m: FakeMemory,
  pets: Array<{ petKey: number; unlocked: boolean }>,
): FakeMemory {
  // CommonSaveData TypeInfo → class → static fields → playerPtr at +commonSaveData(0x10)
  m.writePtr(GA_BASE + PET_O.typeInfoRva.commonSaveData, CS_CLASS_P)
    .writePtr(CS_CLASS_P + BigInt(CAND), CS_BLOCK_P)
    .writePtr(CS_BLOCK_P + BigInt(PET_O.player.commonSaveData), PLAYER_OBJ);

  // Player → petSaveDatas List at +0x60
  m.writePtr(PLAYER_OBJ + BigInt(PET_PET_SAVEDS_OFFSET), PET_LIST_OBJ)
    .writePtr(PET_LIST_OBJ + BigInt(O.container.listItems), PET_ITEMS_ARR)
    .writeI32(PET_LIST_OBJ + BigInt(O.container.listSize), pets.length);

  const petPtrs = [PET1, PET2];
  const first = PET_ITEMS_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < pets.length; i++) {
    const petAddr = petPtrs[i];
    m.writePtr(first + BigInt(i * 8), petAddr)
      .writeI32(petAddr + BigInt(PET_KEY_OFFSET), pets[i].petKey)
      .writeI32(petAddr + BigInt(PET_UNLOCK_OFFSET), pets[i].unlocked ? 1 : 0);
  }

  return m;
}

describe("readRuntimePets", () => {
  it("returns null when petSaveDatas offset is 0 (not yet derived)", () => {
    const patched = { ...O, player: { ...O.player, petSaveDatas: 0 } };
    const result = readRuntimePets(new FakeMemory(), GA_BASE, GA_SIZE, patched);
    expect(result.pets).toBeNull();
    expect(result.status).toMatch(/petSaveDatas offset = 0/i);
  });

  it("reads pet list with key and unlock status", () => {
    const m = seedPetChain(new FakeMemory(), [
      { petKey: 5001, unlocked: true },
      { petKey: 5002, unlocked: false },
    ]);
    const result = readRuntimePets(m, GA_BASE, GA_SIZE, PET_O);
    expect(result.pets).toHaveLength(2);
    expect(result.pets![0]).toEqual({ petKey: 5001, unlocked: true });
    expect(result.pets![1]).toEqual({ petKey: 5002, unlocked: false });
  });

  it("skips entries with zero petKey", () => {
    const m = seedPetChain(new FakeMemory(), [
      { petKey: 0, unlocked: false }, // invalid — skipped
      { petKey: 5003, unlocked: true },
    ]);
    const result = readRuntimePets(m, GA_BASE, GA_SIZE, PET_O);
    expect(result.pets).toHaveLength(1);
    expect(result.pets![0].petKey).toBe(5003);
  });

  it("returns null when CommonSaveData singleton is absent", () => {
    const result = readRuntimePets(new FakeMemory(), GA_BASE, GA_SIZE, PET_O);
    expect(result.pets).toBeNull();
    expect(result.status).toMatch(/CommonSaveData singleton.*static field unreadable/i);
  });

  it("returns null when pet list is empty", () => {
    const m = seedPetChain(new FakeMemory(), []);
    const result = readRuntimePets(m, GA_BASE, GA_SIZE, PET_O);
    expect(result.pets).toBeNull();
    expect(result.status).toMatch(/petSaveDatas count = 0/i);
  });

  it("uses the bulk pointer-array read path when the backing array is contiguous", () => {
    const pets = [
      { petKey: 5001, unlocked: true },
      { petKey: 5002, unlocked: false },
      { petKey: 5003, unlocked: true },
    ];
    const m = new FakeMemory();
    // CommonSaveData → player chain
    m.writePtr(GA_BASE + PET_O.typeInfoRva.commonSaveData, CS_CLASS_P)
      .writePtr(CS_CLASS_P + BigInt(CAND), CS_BLOCK_P)
      .writePtr(CS_BLOCK_P + BigInt(PET_O.player.commonSaveData), PLAYER_OBJ);
    m.writePtr(PLAYER_OBJ + BigInt(PET_PET_SAVEDS_OFFSET), PET_LIST_OBJ)
      .writePtr(PET_LIST_OBJ + BigInt(O.container.listItems), PET_ITEMS_ARR)
      .writeI32(PET_LIST_OBJ + BigInt(O.container.listSize), pets.length);

    // Bulk pointer array
    const first = PET_ITEMS_ARR + BigInt(O.container.arrayFirst);
    const ptrBuf = Buffer.alloc(pets.length * 8);
    // Per-entry struct buffer: covers petKey@0x10 + isUnlock@0x14 (span = 0x8 bytes)
    const petKeyOff = PET_KEY_OFFSET;
    const isUnlockOff = PET_UNLOCK_OFFSET;
    const fieldStart = Math.min(petKeyOff, isUnlockOff);
    const fieldSpan = Math.max(petKeyOff + 4, isUnlockOff + 4) - fieldStart;
    for (let i = 0; i < pets.length; i++) {
      const petAddr = 0xc40000n + BigInt(i * 0x100);
      ptrBuf.writeBigUInt64LE(petAddr, i * 8);
      const structBuf = Buffer.alloc(fieldSpan);
      structBuf.writeInt32LE(pets[i].petKey, petKeyOff - fieldStart);
      structBuf.writeInt32LE(pets[i].unlocked ? 1 : 0, isUnlockOff - fieldStart);
      m.writeBytes(petAddr + BigInt(fieldStart), structBuf);
    }
    m.writeBytes(first, ptrBuf);

    const result = readRuntimePets(m, GA_BASE, GA_SIZE, PET_O);
    expect(result.pets).toHaveLength(3);
    expect(result.pets).toEqual(pets);
  });
});

// ── readRuntimeMonsterHp (MonsterSpawnManager → monsterList → HP) ─────────────

// GameAssembly base + size don't matter for these tests — we bypass
// resolveMonsterSpawnManager by pre-seeding pin.ptr with a fake instance.
// The monster list is laid out at fixed offsets matching v1.00.21 runtime.monster:
//   monsterList @ 0x28 (List<T>)
//   monsterHealth @ 0xb0 (Monster → UnitHealthController*)
// Then the controller struct has HP at HC_PROBE_PAIRS[0] = (0x40, 0x4c).

const MSM_INSTANCE = 0xa00000n;
const MONSTER_LIST_OBJ = 0xa10000n;
const MONSTER_ARR = 0xa20000n;
const HC_PROBE_C = 0x40; // current HP offset within HealthController (tbh-meter verified)
const HC_PROBE_M = 0x4c; // max HP offset

function seedMonsterList(
  m: FakeMemory,
  monsters: Array<{ addr: bigint; current: number; max: number }>,
): FakeMemory {
  // MSM_INSTANCE → monsterList List @ 0x28
  m.writePtr(MSM_INSTANCE + 0x28n, MONSTER_LIST_OBJ)
    .writePtr(MONSTER_LIST_OBJ + BigInt(O.container.listItems), MONSTER_ARR)
    .writeI32(MONSTER_LIST_OBJ + BigInt(O.container.listSize), monsters.length);
  const first = MONSTER_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < monsters.length; i++) {
    const { addr, current, max } = monsters[i];
    m.writePtr(first + BigInt(i * 8), addr)
      // monster + 0xb0 → HealthController*
      .writePtr(addr + 0xb0n, addr + 0x100n)
      .writeF32(addr + 0x100n + BigInt(HC_PROBE_C), current)
      .writeF32(addr + 0x100n + BigInt(HC_PROBE_M), max);
  }
  return m;
}

describe("readRuntimeMonsterHp HP offset cache", () => {
  it("probes all pairs on first read and caches the winning pair", () => {
    const pin = makeMonsterSpawnPinState();
    pin.ptr = MSM_INSTANCE; // bypass resolveMonsterSpawnManager
    const m = seedMonsterList(new FakeMemory(), [
      { addr: 0xd00000n, current: 50.5, max: 100 },
      { addr: 0xd10000n, current: 75, max: 100 },
      { addr: 0xd20000n, current: 100, max: 100 },
    ]);

    const r1 = readRuntimeMonsterHp(m, GA_BASE, GA_SIZE, O, pin);
    expect(r1).not.toBeNull();
    expect(r1!.monsterHps).toHaveLength(3);
    expect(r1!.monsterHps[0]).toEqual([0xd00000, 50.5, 100]);

    // After first read, the cache should hold the winning pair.
    expect(pin.cachedHpOffsets).toEqual({ cOff: HC_PROBE_C, mOff: HC_PROBE_M });
  });

  it("uses the cached pair directly on subsequent monsters (skips the probe loop)", () => {
    const pin = makeMonsterSpawnPinState();
    pin.ptr = MSM_INSTANCE;
    // Pre-seed the cache so the first monster hits the fast path.
    pin.cachedHpOffsets = { cOff: HC_PROBE_C, mOff: HC_PROBE_M };
    const m = seedMonsterList(new FakeMemory(), [
      { addr: 0xd00000n, current: 1, max: 2 },
      { addr: 0xd10000n, current: 3, max: 4 },
    ]);

    const r = readRuntimeMonsterHp(m, GA_BASE, GA_SIZE, O, pin);
    expect(r!.monsterHps).toEqual([
      [0xd00000, 1, 2],
      [0xd10000, 3, 4],
    ]);
    // Cache should remain valid.
    expect(pin.cachedHpOffsets).toEqual({ cOff: HC_PROBE_C, mOff: HC_PROBE_M });
  });

  it("invalidates the cache when validation fails and re-probes to repopulate it", () => {
    const pin = makeMonsterSpawnPinState();
    pin.ptr = MSM_INSTANCE;
    // Seed a STALE cache pointing at offsets that won't validate.
    pin.cachedHpOffsets = { cOff: 0x30, mOff: 0x3c };

    const m = seedMonsterList(new FakeMemory(), [
      { addr: 0xd00000n, current: 99, max: 100 },
    ]);
    // Seed the stale-offset slots with garbage so the cached-pair read returns
    // values that fail validHpPair (current > maxHp*1.1).
    m.writeF32(0xd00000n + 0x100n + 0x30n, 999)
      .writeF32(0xd00000n + 0x100n + 0x3cn, 1);

    const r = readRuntimeMonsterHp(m, GA_BASE, GA_SIZE, O, pin);
    expect(r!.monsterHps).toEqual([[0xd00000, 99, 100]]);
    // Cache should be updated to the winning pair.
    expect(pin.cachedHpOffsets).toEqual({ cOff: HC_PROBE_C, mOff: HC_PROBE_M });
  });

  it("returns null when no probe pair validates (corrupted controller)", () => {
    const pin = makeMonsterSpawnPinState();
    pin.ptr = MSM_INSTANCE;
    // Seed all probe offsets with NaN — none will validate.
    const m = new FakeMemory();
    m.writePtr(MSM_INSTANCE + 0x28n, MONSTER_LIST_OBJ)
      .writePtr(MONSTER_LIST_OBJ + BigInt(O.container.listItems), MONSTER_ARR)
      .writeI32(MONSTER_LIST_OBJ + BigInt(O.container.listSize), 1);
    const monsterAddr = 0xd00000n;
    m.writePtr(MONSTER_ARR + BigInt(O.container.arrayFirst), monsterAddr)
      .writePtr(monsterAddr + 0xb0n, monsterAddr + 0x100n);
    for (const [cOff, mOff] of [
      [0x40, 0x4c],
      [0x38, 0x44],
      [0x30, 0x3c],
      [0x48, 0x54],
    ] as const) {
      m.writeF32(monsterAddr + 0x100n + BigInt(cOff), NaN).writeF32(
        monsterAddr + 0x100n + BigInt(mOff),
        NaN,
      );
    }

    const r = readRuntimeMonsterHp(m, GA_BASE, GA_SIZE, O, pin);
    expect(r).not.toBeNull();
    expect(r!.monsterHps).toEqual([]); // monster skipped — no valid HP
    expect(pin.cachedHpOffsets).toBeNull(); // cache not populated
  });

  it("returns null when monsterSpawnManager RVA is 0 and pin is unset", () => {
    const pin = makeMonsterSpawnPinState();
    const patched = { ...O, typeInfoRva: { ...O.typeInfoRva, monsterSpawnManager: 0n } };
    const r = readRuntimeMonsterHp(new FakeMemory(), GA_BASE, GA_SIZE, patched, pin);
    expect(r).toBeNull();
  });
});
