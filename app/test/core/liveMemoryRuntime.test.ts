import { describe, it, expect, vi } from "vitest";
import {
  readRuntimeStage,
  readRuntimeGold,
  readRuntimeHeroes,
  readRuntimeChestLog,
  readRuntimeStageClears,
  readRuntimeBoxOpenLog,
  readRuntimeAllLogs,
  peekBoxOpenLogCount,
  peekGetBoxLogCount,
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
  makeAcquireRingPinState,
  readRuntimeAcquireLogs,
  ACQUIRE_HOLD_RELEASE_MS,
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
      alive: null,
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
      alive: null,
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
      alive: null,
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
      alive: null,
    });
  });

  it("returns null when the stage-cache chain can't be walked", () => {
    expect(readRuntimeStage(new FakeMemory(), GA_BASE, GA_SIZE, O, SM_SINGLETON)).toBeNull();
  });

  it("reads the StageManager alive count when the offset is derived (v1.01.05)", () => {
    const O5 = offsetsForVersion("1.01.05")!;
    const slot = GA_BASE + O5.typeInfoRva.stageCacheManager;
    const m = new FakeMemory()
      .writePtr(slot, STAGE_CLASS)
      .writePtr(STAGE_CLASS + BigInt(CAND), STAGE_BLOCK)
      .writePtr(STAGE_BLOCK + BigInt(O5.runtime.stage.currentCache), STAGE_CACHE)
      .writePtr(STAGE_CACHE + BigInt(O5.runtime.stage.cacheInfoData), STAGE_INFO)
      .writeI32(STAGE_INFO + BigInt(O5.runtime.stage.stageKey), 1234)
      .writeI32(SM_SINGLETON + BigInt(O5.runtime.stage.alive), 3);
    expect(readRuntimeStage(m, GA_BASE, GA_SIZE, O5, SM_SINGLETON)).toEqual({
      stageKey: 1234,
      wave: null,
      waveTotal: null,
      alive: 3,
    });
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
    const pin: GoldPinState = { entryPtr: STALE_PTR, lastKnown: null, lastKnownAt: null };

    const result = readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin);
    expect(result).toBe(77_001);
    // Pin updated to the real entry after successful dict walk
    expect(pin.entryPtr).toBe(CURR_ENTRY);
  });

  it("returns lastKnown when all read attempts fail (fresh lastKnown)", () => {
    const pin: GoldPinState = {
      entryPtr: null,
      lastKnown: 55_000,
      lastKnownAt: Date.now(),
    };
    // Empty memory — no currency manager resolvable
    expect(readRuntimeGold(new FakeMemory(), GA_BASE, GA_SIZE, O, pin)).toBe(55_000);
  });

  it("returns null when lastKnown expired (GOLD_STALE_MAX_MS of consecutive failures)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const pin: GoldPinState = {
        entryPtr: null,
        lastKnown: 55_000,
        lastKnownAt: Date.now(),
      };
      const empty = new FakeMemory();
      // Within the window the stale value is still returned (anti-flicker).
      vi.setSystemTime(1_700_000_000_000 + 4_000);
      expect(readRuntimeGold(empty, GA_BASE, GA_SIZE, O, pin)).toBe(55_000);
      // Past GOLD_STALE_MAX_MS the stale value must stop being replayed.
      vi.setSystemTime(1_700_000_000_000 + 6_000);
      expect(readRuntimeGold(empty, GA_BASE, GA_SIZE, O, pin)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records lastKnownAt on a successful read", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const m = seedGoldChain(new FakeMemory(), 99_000n);
      const pin = makeGoldPinState();
      expect(readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin)).toBe(99_000);
      expect(pin.lastKnownAt).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
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

    const pin: GoldPinState = { entryPtr: null, lastKnown: 1234, lastKnownAt: Date.now() };
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

describe("peekGetBoxLogCount", () => {
  it("returns null when logManager RVA is 0 (not derived for this version)", () => {
    const peek = peekGetBoxLogCount(
      new FakeMemory(),
      GA_BASE,
      GA_SIZE,
      O, // unpatched: logManager RVA = 0n
      makeChestLogPinState(),
    );
    expect(peek).toBeNull();
  });

  it("returns null when the log manager can't be resolved (no battle yet)", () => {
    const peek = peekGetBoxLogCount(
      new FakeMemory(), // empty heap: no LogManager instance to scan
      GA_BASE,
      GA_SIZE,
      LOG_O,
      makeChestLogPinState(),
    );
    expect(peek).toBeNull();
  });

  it("returns the current GetBox entry count without scanning or updating the tail", () => {
    const pin = makeChestLogPinState();
    const m = seedLogChain(new FakeMemory(), [0, 1, 2]);
    expect(peekGetBoxLogCount(m, GA_BASE, GA_SIZE, LOG_O, pin)).toBe(3);
    // A cheap probe must not advance the tail or park anything for settle —
    // those are owned by readRuntimeChestLog.
    expect(pin.lastCount).toBe(0);
    expect(pin.pendingIdx).toBeNull();
    expect(pin.retryFrom).toBeNull();
  });

  it("observes a count increase via a later probe", () => {
    const pin = makeChestLogPinState();
    const m = seedLogChain(new FakeMemory(), [0]);
    expect(peekGetBoxLogCount(m, GA_BASE, GA_SIZE, LOG_O, pin)).toBe(1);
    seedLogChain(m, [0, 1, 2]); // drops appended
    expect(peekGetBoxLogCount(m, GA_BASE, GA_SIZE, LOG_O, pin)).toBe(3);
  });
});

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
    // The newest entry is withheld one tick for cross-tick settle.
    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1.drops).toEqual(["common", "rare"]);
    expect(pin.pendingCat).toBe("act");
    // Next tick confirms the withheld act entry with no change.
    const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2.drops).toEqual(["act"]);
    expect(pin.pendingIdx).toBeNull();
    expect(pin.lastCount).toBe(3);
  });

  it("returns only drops appended since the last read", () => {
    const pin = makeChestLogPinState();
    const m = seedLogChain(new FakeMemory(), [0]);
    readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin); // prime at length 1
    seedLogChain(m, [0, 1, 2]); // two new drops appended (rare + act boss)
    // Newest (act) withheld → only rare returns this tick.
    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1.drops).toEqual(["rare"]);
    expect(r1.debug?.entriesRead).toBe(2);
    // Next tick confirms the withheld act.
    const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2.drops).toEqual(["act"]);
    expect(pin.lastCount).toBe(3);
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

  it("clears withheld-entry state when the log shrinks (no phantom drop next run)", () => {
    // Regression: a new-run log clear invalidates the absolute pendingIdx, but
    // the shrink branch only reset the retry state. The stale pendingIdx then
    // made the next run re-read an unrelated index (phantom drop) and, combined
    // with the settle resume path, skip the run's first real drop.
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 2;
    pin.pendingIdx = 1; // withheld from the previous run
    pin.pendingCat = "rare";
    const m = seedLogChain(new FakeMemory(), [0]); // new run cleared the log
    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1.drops).toEqual([]);
    expect(pin.lastCount).toBe(1); // realigned
    expect(pin.pendingIdx).toBeNull();
    expect(pin.pendingCat).toBeNull();

    // First drop of the new run: must be classified fresh (not settled from a
    // stale index) and then withheld normally.
    seedLogChain(m, [0, 1]);
    const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2.drops).toEqual([]); // idx1 rare withheld — no phantom drop from stale pendingIdx
    expect(pin.pendingCat).toBe("rare");
  });

  it("parks the tail on a mid-write entry and recovers it on the next tick", () => {
    // Boss deaths / stage transitions can commit a GetBoxLog entry's slot
    // before monsterType is written. Previously the failing entry was dropped
    // and `pin.lastCount` advanced past it — the chest was lost permanently.
    // Now the tail should park on the failing index and re-read it next tick.
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Index 1 is "mid-write": monsterType garbage that never decodes to 0/1/2.
    const m = seedLogChain(new FakeMemory(), [0, 999, 2]);
    const first = GETBOX_ARR + BigInt(O.container.arrayFirst);

    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1.drops).toEqual(["common"]); // only clean entries returned
    expect(pin.lastCount).toBe(0); // tail NOT advanced past the failing index
    expect(pin.retryFrom).toBe(1);
    expect(r1.debug?.retryFrom).toBe(1);
    expect(r1.debug?.retryConsecutive).toBe(1);

    // The writer commits monsterType → next tick re-reads the parked index.
    m.writeI32(first + BigInt(8), 0 /* entry 1 index => first + 1*8 */);
    seedLogChain(m, [0, 1, 2]); // re-seed also reassigns entries; force index 1 = rare
    // Since seedLogChain rewrites pointers, recompute: index 1 = rare now.
    const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // r2 recovers the parked rare; the still-pending act is withheld this tick.
    expect(r2.drops).toEqual(["rare"]);
    expect(pin.lastCount).toBe(3);
    expect(pin.retryFrom).toBeNull();
    expect(pin.pendingCat).toBe("act");
    // Next tick confirms the withheld act.
    const r3 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r3.drops).toEqual(["act"]);
    expect(pin.lastCount).toBe(3);
  });

  it("force-skips a permanently corrupt entry after MAX retries to avoid a wedged tail", () => {
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Index 1 is permanently corrupt (garbage monsterType on every read).
    const m = seedLogChain(new FakeMemory(), [0, 999, 2]);

    // Tick 1: parks at index 1.
    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1.drops).toEqual(["common"]);
    expect(pin.retryFrom).toBe(1);
    expect(pin.retryConsecutive).toBe(1);

    // Ticks 2,3: same corrupt index keeps failing, retryConsecutive climbs.
    readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin); // c=2
    readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin); // c=3
    expect(pin.retryConsecutive).toBe(3);

    // Tick 4: exceeds MAX_CHEST_LOG_RETRIES → force-skip index 1, move tail past it.
    const r4 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(pin.retryFrom).toBeNull();
    expect(pin.retryConsecutive).toBe(0);
    // index 0 (common) was already emitted by r1; index 2 (act) is withheld.
    expect(r4.drops).toEqual([]);
    expect(pin.lastCount).toBe(3);
    expect(pin.pendingCat).toBe("act");
    // Next tick confirms the withheld act.
    const r5 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r5.drops).toEqual(["act"]);
    expect(pin.lastCount).toBe(3);
  });

  it("corrects a provisional 'common' → settled 'rare' cross-tick", () => {
    // This is exactly the bug that caused your 15:03 Lv80 stage-boss drop:
    // the game allocates the entry, sets pointer, writes monsterType=0 (default),
    // writes the other fields, then finally writes monsterType=1 (rare). If the
    // reader ticks between the 0 write and the 1 write, it sees a *valid* 0 →
    // classifies "common" and the rare is lost forever (the one-time write is done).
    // Cross-tick settle re-reads the entry one tick later to see the committed value.
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Tick 1: monsterType for the boss drop (index 0) is still 0 (provisional).
    const m = seedLogChain(new FakeMemory(), [0]);
    // Tick 1: reads 0 → classifies "common" and withholds it for settle.
    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1.drops).toEqual([]); // nothing emitted yet; withheld → next tick
    expect(pin.lastCount).toBe(1);
    expect(pin.pendingIdx).toBe(0);
    expect(pin.pendingCat).toBe("common");

    // Tick 2: game finally commits monsterType = 1 (stage boss rare).
    seedLogChain(m, [1]); // index 0 is now fully committed as rare; log length 1.

    const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // Re-read gets the committed 1 → emits "rare" (not "common").
    expect(r2.drops).toEqual(["rare"]);
    expect(pin.pendingIdx).toBeNull();
    expect(pin.lastCount).toBe(1);
  });

  it("does not skip the first newly appended entry while settling the withheld one", () => {
    // Off-by-one regression: when a settle is pending AND a new drop landed in
    // the same tick, the scan used to resume at lastCount+1 and permanently
    // skip the entry at lastCount (the first new one).
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 1;
    pin.pendingIdx = 0; // previous tick withheld index 0
    pin.pendingCat = "common";
    // Log now has 3 entries: idx0 (withheld, settled common) + idx1 rare + idx2 act.
    const m = seedLogChain(new FakeMemory(), [0, 1, 2]);
    const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // settle emits idx0; scan must emit idx1 (rare) and withhold idx2 (act).
    expect(r1.drops).toEqual(["common", "rare"]);
    expect(pin.pendingCat).toBe("act");
    expect(pin.pendingIdx).toBe(2);
    expect(pin.lastCount).toBe(3);
    // Next tick settles the withheld act; nothing new.
    const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2.drops).toEqual(["act"]);
    expect(pin.lastCount).toBe(3);
  });

  it("rejects non-LogManager objects whose +logByType offset holds an unrelated dict", () => {
    // v1.01.02 regression: resolveLogManager scans the LogManager static block
    // for the first pointer whose `+logByType` offset holds a dict-like struct
    // (count 1-1000 + non-null entries). Without a key-presence check, any
    // unrelated object with a dict at that offset passes — but its dict won't
    // contain the GetBox log-type key, so every dictLookupIntKey returns null
    // and the reader reports "dict lookup failed" forever.
    //
    // Seed two candidates in the static block: a decoy (unrelated dict with
    // no getBoxTypeKey entry) at +0x00, and the real LogManager at +0x08.
    // isLiveLogManager must reject the decoy and accept the real one.
    const pin = makeChestLogPinState();
    const m = new FakeMemory();
    m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS).writePtr(
      LOG_CLASS + BigInt(CAND),
      LOG_BLOCK,
    );

    // Decoy instance at static block +0x00: dict with 5 entries, none of which
    // match getBoxTypeKey. Structurally valid as a dict, but not a LogManager.
    const DECOY_INSTANCE = 0xd21000n;
    const DECOY_DICT = 0xd31000n;
    const DECOY_DICT_ENTRIES = 0xd41000n;
    m.writePtr(LOG_BLOCK + 0n, DECOY_INSTANCE)
      .writePtr(DECOY_INSTANCE + BigInt(O.runtime.log.logByType), DECOY_DICT)
      .writePtr(DECOY_DICT + BigInt(O.dict.entries), DECOY_DICT_ENTRIES)
      .writeI32(DECOY_DICT + BigInt(O.dict.count), 5);
    // Decoy dict entries: keys 100, 101, 102, 103, 104 — none match getBoxTypeKey.
    for (let i = 0; i < 5; i++) {
      const e = DECOY_DICT_ENTRIES + BigInt(O.container.arrayFirst) + BigInt(i * O.dict.entrySize);
      m.writeI32(e + BigInt(O.dict.entryHash), 1)
        .writeI32(e + BigInt(O.dict.entryKey), 100 + i)
        .writePtr(e + BigInt(O.dict.entryValue), 0xd50000n + BigInt(i * 0x1000));
    }

    // Real LogManager at static block +0x08: dict with getBoxTypeKey entry.
    m.writePtr(LOG_BLOCK + 0x8n, LM_INSTANCE);
    seedLogChain(m, [0]); // seeds LM_INSTANCE with a valid GetBox bucket

    const result = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // Should resolve the real LogManager (not the decoy) and prime successfully.
    expect(result.drops).toEqual([]);
    expect(pin.ptr).toBe(LM_INSTANCE);
  });

  it("recovers a chest drop that was force-skipped once its monsterType commits (overscan)", () => {
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Ticks 1..4: the single slot fails to decode (monsterType uncommitted) →
    // retried, then force-skipped after MAX_CHEST_LOG_RETRIES (3). It is NOT
    // marked delivered, so a later overscan re-read can recover it.
    for (let t = 0; t < 4; t++) {
      const m = seedLogChain(new FakeMemory(), [99]);
      const r = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
      expect(r.drops).toEqual([]);
    }
    expect(pin.lastCount).toBe(1);
    // Tick 5: monsterType now committed → overscan re-read recovers it as rare.
    const m2 = seedLogChain(new FakeMemory(), [1]);
    const r2 = readRuntimeChestLog(m2, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2.drops).toEqual(["rare"]);
  });

  it("records repeated same-kind drops from separate chests (index-level dedup, not category)", () => {
    const pin = makeChestLogPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Two chests dropping the same kind must NOT collapse to one — each is a
    // distinct slot. The newest is withheld one tick for settle, so the two
    // drops surface across the settle ticks (one per tick), not as one.
    const m = seedLogChain(new FakeMemory(), [0, 0]);
    expect(readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin).drops).toEqual(["common"]);
    expect(readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin).drops).toEqual(["common"]);
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

  it("accepts plague (Contaminated) stage clears (act 21-23)", () => {
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 0;
    const m = seedStageClearChain(new FakeMemory(), [
      [21, 1, 85], // Nightmare 21-1
      [22, 7, 63], // Hell 22-7
      [23, 20, 41], // Torment 23-20
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 21, stage: 1, clearTimeSec: 85, valid: true },
      { act: 22, stage: 7, clearTimeSec: 63, valid: true },
      { act: 23, stage: 20, clearTimeSec: 41, valid: true },
    ]);
  });

  it("recovers a stage clear whose act/stage committed a tick after its first read (overscan re-read)", () => {
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Tick 1: the entry is present but half-written (act/stage unreadable) →
    // surfaced as valid=false (new-region probe) and dropped by the caller.
    const m = seedStageClearChain(new FakeMemory(), [[0, 0, 42]]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 0, stage: 0, clearTimeSec: 42, valid: false },
    ]);
    expect(pin.lastCount).toBe(1);
    // Tick 2: the same slot has now fully committed → recovered via overscan.
    seedStageClearChain(m, [[3, 1, 42]]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 3, stage: 1, clearTimeSec: 42, valid: true },
    ]);
  });

  it("does not re-deliver an entry on a later overscan re-read (fingerprint dedup)", () => {
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 0;
    const m = seedStageClearChain(new FakeMemory(), [
      [3, 1, 85],
      [3, 2, 63],
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 3, stage: 1, clearTimeSec: 85, valid: true },
      { act: 3, stage: 2, clearTimeSec: 63, valid: true },
    ]);
    expect(pin.lastCount).toBe(2);
    // No new entries — both now sit in the overscan window but were already
    // delivered, so the fingerprint suppresses them.
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([]);
  });

  it("never re-delivers the attach backlog after priming", () => {
    const pin = makeStageClearPinState();
    const m = seedStageClearChain(new FakeMemory(), [
      [3, 1, 85],
      [3, 2, 63],
      [3, 3, 41],
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([]); // prime
    expect(pin.lastCount).toBe(3);
    expect(pin.tailBase).toBe(3);
    // Same state on the next tick: overscan must not reach below the prime
    // point, so the backlog is not re-reported.
    seedStageClearChain(m, [
      [3, 1, 85],
      [3, 2, 63],
      [3, 3, 41],
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([]);
  });

  it("only surfaces a newly-seen invalid entry once (no overscan spam)", () => {
    const pin = makeStageClearPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Slot 0 is permanently corrupt (act/stage unreadable); slot 1 is valid.
    const m = seedStageClearChain(new FakeMemory(), [
      [0, 0, 42],
      [3, 1, 85],
    ]);
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([
      { act: 0, stage: 0, clearTimeSec: 42, valid: false },
      { act: 3, stage: 1, clearTimeSec: 85, valid: true },
    ]);
    expect(pin.lastCount).toBe(2);
    // Same state again: slot 0 is in the overscan window but still invalid → not
    // re-emitted (avoids per-tick spam); slot 1 is deduped.
    expect(readRuntimeStageClears(m, GA_BASE, GA_SIZE, LOG_O, pin)).toEqual([]);
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

  it("parks the tail on a mid-write entry instead of dropping it permanently", () => {
    // Slot is allocated but itemKey never becomes valid this tick (e.g. the
    // game's write was preempted — the classic FIRST item of an open-burst).
    // After BOX_OPEN_LOG_SAMPLES samples the tail is PARKED at the failing
    // index (lastCount does NOT advance) so the next tick can re-read it,
    // instead of the entry being dropped permanently.
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1 }]);
    readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin); // prime (lastCount=1)

    // Append a phantom slot: pointer is null (unreadable). All 3 samples fail.
    const first = BOX_OPEN_ARR + BigInt(BOX_LOG_O.container.arrayFirst);
    m.writePtr(first + 8n, 0n); // null pointer
    m.writeI32(BOX_OPEN_LIST + BigInt(BOX_LOG_O.container.listSize), 2);

    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toEqual([]); // nothing decodes this tick
    expect(pin.lastCount).toBe(1); // tail parked — NOT advanced past the bad slot
    expect(pin.retryFrom).toBe(1); // next tick re-reads index 1
    expect(result.debug?.retryFrom).toBe(1);
  });

  it("recovers a parked mid-write entry on the next tick", () => {
    // First tick sees a mid-write slot (itemKey still 0) and parks the tail.
    // The writer then commits; the next tick re-reads from retryFrom and
    // surfaces the entry — the "first item of a multi-box open" survives.
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1 }]);
    readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin); // prime (lastCount=1)

    const first = BOX_OPEN_ARR + BigInt(BOX_LOG_O.container.arrayFirst);
    const newEntry = 0xb70000n;
    m.writePtr(first + 8n, newEntry);
    m.writeI32(newEntry + BigInt(BOX_LOG_O.runtime.boxOpenLog.itemStringKey), 0); // mid-write
    m.writeI32(BOX_OPEN_LIST + BigInt(BOX_LOG_O.container.listSize), 2);

    const r1 = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(r1.opens).toEqual([]);
    expect(pin.retryFrom).toBe(1);
    expect(pin.retryConsecutive).toBe(1);

    // Writer commits itemKey; next tick recovers the parked entry.
    m.writeI32(newEntry + BigInt(BOX_LOG_O.runtime.boxOpenLog.itemStringKey), 530018);
    const r2 = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(r2.opens).toHaveLength(1);
    expect(r2.opens![0].itemKey).toBe(530018);
    expect(pin.lastCount).toBe(2);
    expect(pin.retryFrom).toBeNull();
  });

  it("force-skips a permanently corrupt entry after MAX retries to avoid a wedged tail", () => {
    // The same entry fails to decode across MAX_BOX_OPEN_LOG_RETRIES ticks —
    // a genuinely corrupt slot. The tail must eventually skip it (and keep
    // moving) rather than wedge forever.
    const pin = makeBoxOpenPinState();
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017, boxType: 1 }]);
    readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin); // prime (lastCount=1)

    const first = BOX_OPEN_ARR + BigInt(BOX_LOG_O.container.arrayFirst);
    m.writePtr(first + 8n, 0n); // permanently unreadable slot
    m.writeI32(BOX_OPEN_LIST + BigInt(BOX_LOG_O.container.listSize), 2);

    // Ticks #1..6: park (consecutive 1..6) — still within MAX(6).
    for (let t = 1; t <= 6; t++) {
      const r = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
      expect(r.opens).toEqual([]);
      expect(pin.retryFrom).toBe(1);
      expect(pin.retryConsecutive).toBe(t);
    }
    // Tick #7: consecutive (7) exceeds MAX (6) → force-skip, tail advances.
    const r = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(r.opens).toEqual([]);
    expect(pin.lastCount).toBe(2);
    expect(pin.retryFrom).toBeNull();
    expect(pin.retryConsecutive).toBe(0);
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
    const STRING_OBJ = 0x0000_0001_15d9_5800n;

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

  it("records identical item drops from separate boxes (index-level dedup, not value)", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Two boxes in a burst can drop the same item — value-based dedup would
    // wrongly collapse them; index-level dedup keeps both.
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017 }, { itemKey: 530017 }]);
    const result = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(result.opens).toHaveLength(2);
    expect(result.opens!.every((o) => o.itemKey === 530017)).toBe(true);
    expect(pin.lastCount).toBe(2);
  });

  it("does not re-deliver an already-delivered slot on overscan (index dedup)", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017 }, { itemKey: 601171 }]);
    expect(readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin).opens).toHaveLength(2);
    // Same state again: both slots sit in the overscan window but were already
    // delivered → suppressed (no duplicates).
    expect(readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin).opens).toEqual([]);
  });

  it("recovers a box-open slot that was force-skipped once its itemKey commits", () => {
    const pin = makeBoxOpenPinState();
    pin.primed = true;
    pin.lastCount = 0;
    // Ticks 1..7: the single slot fails to decode (itemKey uncommitted) →
    // retried, then force-skipped after MAX_BOX_OPEN_LOG_RETRIES (6). It is NOT
    // marked delivered, so a later overscan re-read can recover it.
    for (let t = 0; t < 7; t++) {
      const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 0 }]);
      const r = readRuntimeBoxOpenLog(m, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
      expect(r.opens).toEqual([]);
      expect(r.debug?.parsed ?? 0).toBe(0);
    }
    expect(pin.lastCount).toBe(1);
    // Tick 8: itemKey now committed → overscan re-read recovers the slot.
    const m2 = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017 }]);
    const r2 = readRuntimeBoxOpenLog(m2, GA_BASE, GA_SIZE, BOX_LOG_O, pin);
    expect(r2.opens).toHaveLength(1);
    expect(r2.opens![0].itemKey).toBe(530017);
  });
});

// ── readRuntimeAllLogs ─────────────────────────────────────────────────────────

/** Seed LogManager with all three ELogType buckets (chest drops, stage clears, box opens). */
function seedAllLogChain(
  m: FakeMemory,
  chestTypes: number[],
  clears: [number, number, number][],
  boxOpens: Array<{ itemKey: number; boxType?: number; level?: number }>,
): FakeMemory {
  m.writePtr(GA_BASE + LOG_O.typeInfoRva.logManager, LOG_CLASS)
    .writePtr(LOG_CLASS + BigInt(CAND), LOG_BLOCK)
    .writePtr(LOG_BLOCK, LM_INSTANCE);
  m.writePtr(LM_INSTANCE + BigInt(O.runtime.log.logByType), LOG_DICT)
    .writePtr(LOG_DICT + BigInt(O.dict.entries), LOG_DICT_ENTRIES)
    .writeI32(LOG_DICT + BigInt(O.dict.count), 3);

  // Entry 0: GetBox list
  const de0 = LOG_DICT_ENTRIES + BigInt(O.container.arrayFirst);
  m.writeI32(de0 + BigInt(O.dict.entryHash), 1)
    .writeI32(de0 + BigInt(O.dict.entryKey), O.runtime.log.getBoxTypeKey)
    .writePtr(de0 + BigInt(O.dict.entryValue), GETBOX_LIST);
  m.writePtr(GETBOX_LIST + BigInt(O.container.listItems), GETBOX_ARR).writeI32(
    GETBOX_LIST + BigInt(O.container.listSize),
    chestTypes.length,
  );
  const chestFirst = GETBOX_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < chestTypes.length; i++) {
    const e = 0xf00000n + BigInt(i * 0x100);
    m.writePtr(chestFirst + BigInt(i * 8), e).writeI32(
      e + BigInt(O.runtime.getBoxLog.monsterType),
      chestTypes[i],
    );
  }

  // Entry 1: StageClear list
  const de1 = de0 + BigInt(O.dict.entrySize);
  m.writeI32(de1 + BigInt(O.dict.entryHash), 1)
    .writeI32(de1 + BigInt(O.dict.entryKey), O.runtime.log.stageClearTypeKey)
    .writePtr(de1 + BigInt(O.dict.entryValue), STAGE_CLEAR_LIST);
  m.writePtr(STAGE_CLEAR_LIST + BigInt(O.container.listItems), STAGE_CLEAR_ARR).writeI32(
    STAGE_CLEAR_LIST + BigInt(O.container.listSize),
    clears.length,
  );
  const clearFirst = STAGE_CLEAR_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < clears.length; i++) {
    const e = 0xe10000n + BigInt(i * 0x100);
    const [act, stage, time] = clears[i]!;
    m.writePtr(clearFirst + BigInt(i * 8), e)
      .writeI32(e + BigInt(O.runtime.stageClearLog.act), act)
      .writeI32(e + BigInt(O.runtime.stageClearLog.stage), stage)
      .writeI32(e + BigInt(O.runtime.stageClearLog.clearTimeSec), time);
  }

  // Entry 2: GetItemWithBoxOpen list (key 99 to match BOX_LOG_O)
  const de2 = de1 + BigInt(O.dict.entrySize);
  m.writeI32(de2 + BigInt(O.dict.entryHash), 1)
    .writeI32(de2 + BigInt(O.dict.entryKey), 99)
    .writePtr(de2 + BigInt(O.dict.entryValue), BOX_OPEN_LIST);
  m.writePtr(BOX_OPEN_LIST + BigInt(O.container.listItems), BOX_OPEN_ARR).writeI32(
    BOX_OPEN_LIST + BigInt(O.container.listSize),
    boxOpens.length,
  );
  const boxFirst = BOX_OPEN_ARR + BigInt(O.container.arrayFirst);
  for (let i = 0; i < boxOpens.length; i++) {
    const e = 0xeb0000n + BigInt(i * 0x100);
    m.writePtr(boxFirst + BigInt(i * 8), e).writeI32(e + BigInt(0x10), boxOpens[i]!.itemKey);
    if (boxOpens[i]!.boxType != null) m.writeI32(e + BigInt(0x14), boxOpens[i]!.boxType!);
    if (boxOpens[i]!.level != null) m.writeI32(e + BigInt(0x18), boxOpens[i]!.level!);
  }
  return m;
}

describe("readRuntimeAllLogs", () => {
  it("reads all three buckets into one result (connected, arrays populated)", () => {
    const pins = {
      chest: makeChestLogPinState(),
      boxOpen: makeBoxOpenPinState(),
      stageClear: makeStageClearPinState(),
    };
    // Prime each tail non-empty so subsequent calls only see new entries.
    let m = seedAllLogChain(new FakeMemory(), [0], [[3, 1, 85]], [{ itemKey: 530017 }]);
    const prime = readRuntimeAllLogs(m, GA_BASE, GA_SIZE, BOX_LOG_O, pins);
    expect(prime.connected).toBe(true);
    expect(prime.chestDrops).toEqual([]);
    expect(prime.boxOpens).toEqual([]);
    expect(prime.stageClears).toEqual([]);

    // Append one of each kind → all three delivered by a single call.
    m = seedAllLogChain(
      new FakeMemory(),
      [0, 1],
      [
        [3, 1, 85],
        [3, 2, 63],
      ],
      [{ itemKey: 530017 }, { itemKey: 601171, boxType: 0, level: 5 }],
    );
    const all = readRuntimeAllLogs(m, GA_BASE, GA_SIZE, BOX_LOG_O, pins);
    expect(all.connected).toBe(true);
    // Box opens: new indices delivered immediately.
    expect(all.boxOpens).toEqual([{ itemKey: 601171, boxType: 0, level: 5 }]);
    // Stage clears: new clear delivered (old one deduped by fingerprint).
    expect(all.stageClears).toEqual([{ act: 3, stage: 2, clearTimeSec: 63, valid: true }]);
    // Chest drops are always an array in this wired LogManager.
    expect(Array.isArray(all.chestDrops)).toBe(true);
  });

  it("returns null for buckets missing from the LogManager, keeping the rest", () => {
    const pins = {
      chest: makeChestLogPinState(),
      boxOpen: makeBoxOpenPinState(),
      stageClear: makeStageClearPinState(),
    };
    // seedBoxOpenChain wires getBox (empty, active) + box open but NO stage bucket.
    // Prime the box tail first so the next read delivers its new opens.
    readRuntimeBoxOpenLog(
      seedBoxOpenChain(new FakeMemory(), []),
      GA_BASE,
      GA_SIZE,
      BOX_LOG_O,
      pins.boxOpen,
    );
    const m = seedBoxOpenChain(new FakeMemory(), [{ itemKey: 530017 }]);
    const all = readRuntimeAllLogs(m, GA_BASE, GA_SIZE, BOX_LOG_O, pins);
    expect(all.boxOpens).toEqual([{ itemKey: 530017 }]);
    expect(all.stageClears).toBeNull(); // no StageClear bucket → unavailable
    expect(Array.isArray(all.chestDrops)).toBe(true); // getBox present (empty) → active
  });

  it("returns all-null when no LogManager RVA is derived", () => {
    const pins = {
      chest: makeChestLogPinState(),
      boxOpen: makeBoxOpenPinState(),
      stageClear: makeStageClearPinState(),
    };
    const all = readRuntimeAllLogs(new FakeMemory(), GA_BASE, GA_SIZE, O, pins);
    expect(all.connected).toBe(false);
    expect(all.chestDrops).toBeNull();
    expect(all.boxOpens).toBeNull();
    expect(all.stageClears).toBeNull();
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

// ── readRuntimeAcquireLogs (LogManager@0x20 "获得记录" ring) ────────────────────

const ACQ_RING = 0xf00000n;
const ACQ_BUF = 0xf10000n;
const ACQ_ENTRY = 0xf20000n;

/** Write a .NET string object: header (length at +0x10) then UTF-16LE chars. */
function writeDotNetString(m: FakeMemory, addr: bigint, content: string): void {
  const hdr = Buffer.alloc(0x14);
  hdr.writeInt32LE(content.length, 0x10);
  m.writeBytes(addr, hdr);
  m.writeBytes(addr + 0x14n, Buffer.from(content, "utf16le"));
}

/**
 * Seed LogManager + the LogManager@0x20 ring with the given lines. A `null` line
 * writes the slot pointer but leaves the message uncommitted (mid-write).
 * Each line's strings are written as .NET objects at `objBase`; the entry fields
 * (+0x18 category / +0x20 message / +0x28 time) hold pointers to them.
 */
function seedAcquireRing(
  m: FakeMemory,
  lines: ({ msg: string; time?: string; cat?: string } | null)[],
): FakeMemory {
  m = seedLogChain(m, []);
  m.writePtr(LM_INSTANCE + 0x20n, ACQ_RING)
    .writeI32(ACQ_RING + 0x1cn, lines.length)
    .writeI32(ACQ_RING + 0x18n, lines.length)
    .writePtr(ACQ_RING + 0x10n, ACQ_BUF);
  const elemBase = ACQ_BUF + 0x20n;
  lines.forEach((line, k) => {
    const entryPtr = ACQ_ENTRY + BigInt(k * 0x100);
    const objBase = 0x300000n + BigInt(k * 0x300);
    m.writePtr(elemBase + BigInt(k * 8), entryPtr);
    if (line) {
      const msgAddr = objBase;
      writeDotNetString(m, msgAddr, line.msg);
      m.writePtr(entryPtr + 0x20n, msgAddr);
      if (line.time) {
        const timeAddr = objBase + 0x100n;
        writeDotNetString(m, timeAddr, `[${line.time}]`);
        m.writePtr(entryPtr + 0x28n, timeAddr);
      }
      if (line.cat) {
        const catAddr = objBase + 0x200n;
        writeDotNetString(m, catAddr, line.cat);
        m.writePtr(entryPtr + 0x18n, catAddr);
      }
    }
  });
  return m;
}

describe("readRuntimeAcquireLogs", () => {
  /**
   * Write one ring entry at absolute `index` (slot = index % capacity) and set
   * the counter to `index + 1`. Unlike `seedAcquireRing` this can address the
   * wrapped region (index >= capacity), which is where the counter/slot skew
   * lives.
   */
  function writeAcquireEntry(m: FakeMemory, index: number, msg: string, time: string): void {
    const slot = index % 2000;
    const entryPtr = ACQ_ENTRY + BigInt(slot * 0x100);
    const objBase = 0x300000n + BigInt(slot * 0x300);
    m.writePtr(ACQ_BUF + 0x20n + BigInt(slot * 8), entryPtr);
    writeDotNetString(m, objBase, msg);
    m.writePtr(entryPtr + 0x20n, objBase);
    writeDotNetString(m, objBase + 0x100n, `[${time}]`);
    m.writePtr(entryPtr + 0x28n, objBase + 0x100n);
    m.writeI32(ACQ_RING + 0x1cn, index + 1);
    // Ring fill count (session-scoped): a base-0 session that appended
    // `index + 1` entries, capped at the capacity once the ring wraps.
    m.writeI32(ACQ_RING + 0x18n, Math.min(index + 1, 2000));
  }

  /** Monotonic in-game stamp for ring index `index` (1 game-minute / 10 entries). */
  function acquireStampFor(index: number): string {
    const minutes = (600 + Math.floor(index / 10)) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  /** Wrapped ring whose slots hold indices `[from, to)`; counter left at `to`. */
  function seedWrappedRing(m: FakeMemory, from: number, to: number): FakeMemory {
    for (let i = from; i < to; i++) writeAcquireEntry(m, i, `msg ${i}`, acquireStampFor(i));
    return m;
  }

  it("reads the whole ring on the initial sync and advances the pin", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [
      { msg: "获得了<color=#D7D7D7>永恒之弓</color>。", time: "17:45" },
      { msg: "获得金币 x2", time: "17:46" },
    ]);
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.entries).toHaveLength(2);
    expect(res?.entries[0]).toMatchObject({ seq: 1, time: "17:45" });
    expect(res?.entries[0].message).toContain("永恒之弓");
    expect(res?.entries[1].message).toBe("获得金币 x2");
    expect(pin.total).toBe(2);
  });

  it("returns only the tail increment after the pin advanced", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [
      { msg: "获得了永恒之弓。", time: "17:45" },
      { msg: "获得金币 x2", time: "17:46" },
    ]);
    readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin); // initial full read
    expect(pin.total).toBe(2);

    // 打开一个箱子 → 环形区追加一条（slot 2）
    m.writeI32(ACQ_RING + 0x1cn, 3);
    const entryPtr = ACQ_ENTRY + BigInt(2 * 0x100);
    m.writePtr(ACQ_BUF + 0x20n + BigInt(2 * 8), entryPtr);
    const msgAddr = 0x300000n + BigInt(2 * 0x300);
    writeDotNetString(m, msgAddr, "获得了<color=#E8695A>骰子</color>。");
    m.writePtr(entryPtr + 0x20n, msgAddr);
    writeDotNetString(m, msgAddr + 0x100n, "[17:47]");
    m.writePtr(entryPtr + 0x28n, msgAddr + 0x100n);

    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.entries).toHaveLength(1);
    expect(res?.entries[0].message).toContain("骰子");
    expect(pin.total).toBe(3);
  });

  /**
   * Write an entry of a NON-zero-base session: ring index `k` maps to slot
   * `(k - base) % capacity` — the mapping the game actually uses after it
   * wipes the ring for a new in-game session (the monotonic counter keeps
   * running across the wipe, so `slot = k % capacity` mis-aligns).
   */
  function writeSessionEntry(
    m: FakeMemory,
    k: number,
    base: number,
    msg: string,
    time: string,
  ): void {
    const slot = (((k - base) % 2000) + 2000) % 2000;
    const entryPtr = 0x500000n + BigInt(slot * 0x100); // fresh object region
    const objBase = 0x400000n + BigInt(slot * 0x300);
    m.writePtr(ACQ_BUF + 0x20n + BigInt(slot * 8), entryPtr);
    writeDotNetString(m, objBase, msg);
    m.writePtr(entryPtr + 0x20n, objBase);
    writeDotNetString(m, objBase + 0x100n, `[${time}]`);
    m.writePtr(entryPtr + 0x28n, objBase + 0x100n);
  }

  it("re-anchors when the game wipes the ring mid-process (counter keeps running)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [
      { msg: "old A", time: "17:45" },
      { msg: "old B", time: "17:46" },
    ]);
    const r1 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1?.entries).toHaveLength(2);
    expect(pin.total).toBe(2);

    // The game wipes the ring (slots cleared) and starts a fresh session at
    // counter 36161 — live-verified 2026-09-16. The counter does NOT reset.
    m.writePtr(ACQ_BUF + 0x20n, 0n).writePtr(ACQ_BUF + 0x20n + 8n, 0n);
    writeSessionEntry(m, 36161, 36161, "new A", "18:01");
    writeSessionEntry(m, 36162, 36161, "new B", "18:02");
    m.writeI32(ACQ_RING + 0x1cn, 36163).writeI32(ACQ_RING + 0x18n, 2);

    // Two consecutive polls confirm the new base (guards against transient
    // counter/fill skew mid-append). The first read sees no readable slots.
    const r2a = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2a?.entries).toHaveLength(0);
    expect(r2a?.reanchoredBase).toBeNull();
    const r2 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // NOT a restart: indices keep running, the fresh backlog is a plain increment.
    expect(r2?.restartDetected).toBe(false);
    expect(r2?.reanchoredBase).toBe(36161);
    expect(r2?.entries.map((e) => e.message)).toEqual(["new A", "new B"]);
    expect(r2?.entries.map((e) => e.seq)).toEqual([36162, 36163]);
    expect(pin.total).toBe(36163);
    // Steady increment afterwards maps slots relative to the new base.
    writeSessionEntry(m, 36163, 36161, "new C", "18:03");
    m.writeI32(ACQ_RING + 0x1cn, 36164).writeI32(ACQ_RING + 0x18n, 3);
    const r3 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r3?.entries.map((e) => e.message)).toEqual(["new C"]);
    expect(r3?.reanchoredBase).toBeNull();
    expect(pin.total).toBe(36164);
  });

  it("resumes into an already-wiped ring by jumping to the new session start", () => {
    const pin = makeAcquireRingPinState();
    pin.resumeTotal = 36028; // persisted watermark from before the wipe
    const m = seedAcquireRing(new FakeMemory(), []);
    writeSessionEntry(m, 36161, 36161, "new A", "18:01");
    writeSessionEntry(m, 36162, 36161, "new B", "18:02");
    m.writeI32(ACQ_RING + 0x1cn, 36163).writeI32(ACQ_RING + 0x18n, 2);

    // The first poll applies the resume but only *candidates* the new base
    // (pending); the second poll confirms it and skips the pin forward —
    // the unread stretch between watermark and base holds only cleared slots.
    const r1 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1?.resumed).toBe(true);
    expect(r1?.entries).toHaveLength(0);
    expect(r1?.reanchoredBase).toBeNull();
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.restartDetected).toBe(false);
    expect(res?.reanchoredBase).toBe(36161);
    expect(res?.entries.map((e) => e.seq)).toEqual([36162, 36163]);
    expect(pin.total).toBe(36163);
  });

  it("calibrates the session base without disturbing a healthy mid-session pin", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [{ msg: "a", time: "17:45" }]);
    readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin); // initial, base calibrated to 0
    writeAcquireEntry(m, 1, "b", "17:46"); // fill 2, counter 2 → base still 0
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.entries.map((e) => e.message)).toEqual(["b"]);
    expect(res?.reanchoredBase).toBeNull();
    expect(res?.fillCount).toBe(2);
    expect(pin.total).toBe(2);
  });

  /**
   * Wrap coverage: a saturated ring (fill pinned at 2000) carries NO base
   * signal, so correctness across the wrap rests entirely on the base having
   * been calibrated while fill was still below capacity — base 0 for a session
   * that never wiped, the re-anchored base for a wiped one (§15). These three
   * cases walk the real "past the ring limit" paths.
   */

  it("keeps delivering across the wrap once the base is calibrated (base-0 session saturates)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), []);
    // Mid-session: fill < capacity pins base = 0 (counter 1500, fill 1500).
    seedWrappedRing(m, 0, 1500);
    const r1 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1?.entries).toHaveLength(1500);
    expect(r1?.fillCount).toBe(1500);
    expect(pin.total).toBe(1500);

    // The session grows past the capacity: counter 2500, fill pinned at 2000,
    // slots 0..499 overwritten by the wrap. The calibrated base stays 0, so
    // every wrapped slot still maps onto the entry the game wrote there.
    seedWrappedRing(m, 1500, 2500);
    const r2 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2?.entries).toHaveLength(1000);
    expect(r2?.entries[0]?.seq).toBe(1501);
    expect(r2?.entries[0]?.message).toBe("msg 1500");
    expect(r2?.entries[999]?.message).toBe("msg 2499");
    expect(r2?.fillCount).toBeNull(); // saturated — no base signal anymore
    expect(pin.total).toBe(2500);

    // Steady wrap: one more append lands on slot 0 (the overwritten oldest)
    // and delivers as a plain increment.
    writeAcquireEntry(m, 2500, "msg 2500", acquireStampFor(2500));
    const r3 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r3?.entries.map((e) => e.message)).toEqual(["msg 2500"]);
    expect(r3?.reanchoredBase).toBeNull();
    expect(pin.total).toBe(2501);
  });

  it("keeps a wiped session's calibrated base across its own wrap to saturation", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [{ msg: "old", time: "17:45" }]);
    readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin); // base-0 session, pin 1

    // Wipe → new session at 36161 (§15 scenario), calibrated via two polls.
    m.writePtr(ACQ_BUF + 0x20n, 0n);
    writeSessionEntry(m, 36161, 36161, "n0", "18:01");
    m.writeI32(ACQ_RING + 0x1cn, 36162).writeI32(ACQ_RING + 0x18n, 1);
    readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin); // pending
    const r2 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2?.reanchoredBase).toBe(36161);
    expect(pin.total).toBe(36162);

    // The wiped session itself runs to saturation (2000 entries) and wraps:
    // the oldest entries (slots 0..160) are overwritten while fill stays 2000.
    for (let k = 36162; k <= 38161; k++) {
      writeSessionEntry(m, k, 36161, `msg ${k}`, acquireStampFor(k % 2000));
    }
    m.writeI32(ACQ_RING + 0x1cn, 38162).writeI32(ACQ_RING + 0x18n, 2000);
    const r3 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r3?.entries).toHaveLength(2000);
    expect(r3?.entries[0]?.seq).toBe(36163);
    expect(r3?.entries[0]?.message).toBe("msg 36162");
    expect(r3?.entries[1999]?.seq).toBe(38162);
    expect(r3?.entries[1999]?.message).toBe("msg 38161");
    expect(pin.total).toBe(38162);
  });

  it("resumes into a saturated wrapped ring via the persisted session base", () => {
    const pin = makeAcquireRingPinState();
    // Same game session as the previous companion run (the §15 follow-up):
    // base 36161 was calibrated live, then persisted with the watermark. Since
    // the restart the ring saturated AND wrapped once (2001 appends, slot 0
    // already rewritten), so fill carries NO calibration signal on resume.
    // `setAcquireResume` restores the persisted base before the first read —
    // without it the base-0 fallback maps k=38156 to slot 156 (holding
    // "msg 36317") and delivers misaligned rows.
    pin.resumeTotal = 38156; // gate: 38162 - 38156 = 6 <= capacity → accepted
    pin.sessionBase = 36161;
    const m = seedAcquireRing(new FakeMemory(), []);
    for (let k = 36161; k <= 38161; k++) {
      writeSessionEntry(m, k, 36161, `msg ${k}`, acquireStampFor(k % 2000));
    }
    m.writeI32(ACQ_RING + 0x1cn, 38162).writeI32(ACQ_RING + 0x18n, 2000);

    // A watermark more than one ring behind the counter — e.g. one that
    // predates the wipe AND the re-saturation — is rejected by the resume gate
    // itself and falls through to the fresh full-window anchor (covered above).
    const r1 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1?.resumed).toBe(true);
    // seq is the ring index + 1 (1-based), mirroring the game's own numbering.
    expect(r1?.entries.map((e) => e.seq)).toEqual([38157, 38158, 38159, 38160, 38161, 38162]);
    // Correct slots — NOT the k % 2000 fallback, which would surface "msg 36317".
    expect(r1?.entries[0]?.message).toBe("msg 38156");
    expect(r1?.entries[0]?.time).toBe(acquireStampFor(156));
    expect(r1?.entries[5]?.message).toBe("msg 38161");
    expect(pin.total).toBe(38162);

    // Steady state across the wrap: the next append (slot 1, overwriting the
    // pre-wrap entry) delivers normally with no re-anchor needed.
    writeSessionEntry(m, 38162, 36161, "msg 38162", acquireStampFor(38162 % 2000));
    m.writeI32(ACQ_RING + 0x1cn, 38163).writeI32(ACQ_RING + 0x18n, 2000);
    const r2 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2?.entries.map((e) => e.message)).toEqual(["msg 38162"]);
    expect(r2?.reanchoredBase).toBeNull();
    expect(pin.total).toBe(38163);
  });

  it("stops at a mid-write entry and retries it on the next poll (no loss)", () => {
    const pin = makeAcquireRingPinState();
    // slot 2 is mid-write: pointer committed, message not yet.
    const m = seedAcquireRing(new FakeMemory(), [
      { msg: "获得了永恒之弓。", time: "17:45" },
      { msg: "获得金币 x2", time: "17:46" },
      null,
    ]);
    const r1 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1?.entries).toHaveLength(2); // only the committed lines
    expect(pin.total).toBe(2); // pin must NOT pass the mid-write entry

    // Game finishes writing before the next poll → the tail is retried.
    const entryPtr = ACQ_ENTRY + BigInt(2 * 0x100);
    const msgAddr = 0x300000n + BigInt(2 * 0x300);
    writeDotNetString(m, msgAddr, "获得了<color=#E8695A>骰子</color>。");
    m.writePtr(entryPtr + 0x20n, msgAddr);
    writeDotNetString(m, msgAddr + 0x100n, "[17:47]");
    m.writePtr(entryPtr + 0x28n, msgAddr + 0x100n);
    const r2 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r2?.entries).toHaveLength(1);
    expect(r2?.entries[0].message).toContain("骰子");
    expect(pin.total).toBe(3);
  });

  it("stops at an unwritten slot pointer (total advanced before the slot is committed)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [{ msg: "获得了永恒之弓。", time: "17:45" }]);
    // total becomes 2 but slot 1 has no pointer yet (mid-write).
    m.writeI32(ACQ_RING + 0x1cn, 2);
    const r1 = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(r1?.entries).toHaveLength(1);
    expect(pin.total).toBe(1);
  });

  it("rewinds the pin when the ring counter restarts (new game session)", () => {
    const pin = makeAcquireRingPinState();
    // Session 1: ring holds 2 lines; the pin is delivered to total=2.
    const m1 = seedAcquireRing(new FakeMemory(), [
      { msg: "获得了永恒之弓。", time: "12:52" },
      { msg: "获得金币 x2", time: "12:53" },
    ]);
    readRuntimeAcquireLogs(m1, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(pin.total).toBe(2);

    // Session 2 (game restarted): ring cleared, counter restarts from 1.
    const m2 = seedAcquireRing(new FakeMemory(), [
      { msg: "获得了<color=#E8695A>骰子</color>。", time: "00:05" },
    ]);
    const res = readRuntimeAcquireLogs(m2, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.entries).toHaveLength(1);
    expect(res?.entries[0].message).toContain("骰子");
    expect(pin.total).toBe(1);
  });

  // ── counter/slot skew (live 2026-09-15): the +0x1C counter runs ahead of the
  // slot writes, so the slots for the newest indices may still hold the PREVIOUS
  // ring pass' entries. Delivering those silently (the old behaviour) put the pin
  // a full ring behind the game for hours.

  it("holds the pin at a slot the game has not rewritten yet (counter over-leads the slots)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 500, 2500);
    const first = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(first?.entries).toHaveLength(2000);
    expect(first?.entries[0].message).toBe("msg 500");
    expect(first?.heldAt).toBeNull();
    expect(pin.total).toBe(2500);

    // The counter jumps 10 ahead but only 5 slots are rewritten: the slots for
    // indices 2505..2509 still hold the previous pass' entries.
    for (let i = 2500; i < 2505; i++) writeAcquireEntry(m, i, `msg ${i}`, acquireStampFor(i));
    m.writeI32(ACQ_RING + 0x1cn, 2510);

    const second = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(second?.entries.map((e) => e.message)).toEqual([
      "msg 2500",
      "msg 2501",
      "msg 2502",
      "msg 2503",
      "msg 2504",
    ]);
    expect(second?.heldAt).toBe(2505);
    expect(second?.heldReason).toBe("stale-slot");
    expect(pin.total).toBe(2505);

    // The guard must NOT depend on the ring's time string: the game rewrites and
    // reuses that object (measured 2026-09-15), so a stamp change on an untouched
    // slot is normal and must not defeat the hold.
    const slot505Entry = ACQ_ENTRY + BigInt(505 * 0x100);
    const timeAddr = 0x300000n + BigInt(505 * 0x300) + 0x100n;
    writeDotNetString(m, timeAddr, "[23:59]");
    m.writePtr(slot505Entry + 0x28n, timeAddr);
    const stillHeld = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(stillHeld?.heldAt).toBe(2505);
    expect(stillHeld?.heldReason).toBe("stale-slot");

    // Once the game rewrites the held slot the hold resolves — nothing is lost.
    writeAcquireEntry(m, 2505, "msg 2505", acquireStampFor(2505));
    m.writeI32(ACQ_RING + 0x1cn, 2510);
    const third = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(third?.entries.map((e) => e.message)).toEqual(["msg 2505"]);
    expect(pin.total).toBe(2506);
  });

  it("takes the whole window on a FRESH reader (a new session's archive dedupe is the main process' job)", () => {
    const pin = makeAcquireRingPinState();
    // Wrapped ring, head at 2490 (slots hold indices 490..2489), counter over-leads
    // by 10 — the tail slots still hold indices 490..499.
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 490, 2490);
    m.writeI32(ACQ_RING + 0x1cn, 2500);

    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // A fresh pin has no identities to compare, so the reader cannot tell fresh
    // from previous-pass content: it delivers the window as-is and lets
    // TrackingService.ingestAcquireBatch drop what the archive already holds
    // (counted raw-text budget). No hold is reported.
    expect(res?.entries).toHaveLength(2000);
    expect(res?.entries[1989].message).toBe("msg 2489");
    expect(res?.heldAt).toBeNull();
    expect(pin.total).toBe(2500);
  });

  it("reports the capacity the ring object declares (ring+0x18)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedAcquireRing(new FakeMemory(), [{ msg: "获得了银锭。", time: "10:00" }]);
    // Live-verified layout on v1.2.2: ring+0x18 = 2000 (backing array 2048).
    m.writeI32(ACQ_RING + 0x18n, 2000);
    expect(readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin)?.declaredCapacity).toBe(2000);
    // A future build changing it must surface instead of silently drifting.
    m.writeI32(ACQ_RING + 0x18n, 5000);
    expect(readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin)?.declaredCapacity).toBe(5000);
    // Absent / implausible → null (reader keeps its own default).
    m.writeI32(ACQ_RING + 0x18n, 0);
    expect(readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin)?.declaredCapacity).toBeNull();
  });

  it("resumes from the persisted watermark instead of replaying the window", () => {
    const pin = makeAcquireRingPinState();
    // The parent pushes the persisted read position (the last shutdown's pin).
    pin.resumeTotal = 29500;
    // The ring has since moved one entry ahead.
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 27501, 29501);
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.resumed).toBe(true);
    expect(res?.entries).toHaveLength(1);
    expect(res?.entries[0].message).toBe("msg 29500");
    expect(pin.total).toBe(29501);
  });

  it("reports a restart when the counter is below the watermark (new game session)", () => {
    const pin = makeAcquireRingPinState();
    pin.resumeTotal = 29500;
    // The game restarted: the ring counter restarted from 0 and is way below
    // the persisted watermark — the new session's backlog is genuinely new.
    const m = seedAcquireRing(new FakeMemory(), [
      { msg: "A", time: "00:01" },
      { msg: "B", time: "00:02" },
      { msg: "C", time: "00:03" },
    ]);
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.restartDetected).toBe(true);
    expect(res?.resumed).toBe(false);
    expect(res?.entries).toHaveLength(3);
    expect(pin.total).toBe(3);
  });

  it("ignores a watermark that is more than one ring behind the counter", () => {
    const pin = makeAcquireRingPinState();
    pin.resumeTotal = 500;
    // The companion was off for > one full ring: the gap is partially
    // overwritten, the watermark is unusable → fresh full-window anchor.
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 3000, 5000);
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.resumed).toBe(false);
    expect(res?.restartDetected).toBe(false);
    expect(res?.entries).toHaveLength(2000);
    expect(res?.entries[0].message).toBe("msg 3000");
    expect(pin.total).toBe(5000);
  });

  it("measures the ring capacity from the stride between two rewrites of one slot", () => {
    const pin = makeAcquireRingPinState();
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 500, 2500);
    const first = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    // Slot 0 is read at index 2000 → probe armed, no estimate yet.
    expect(first?.capacityEstimate).toBeNull();

    // One full ring later (index 4000 = slot 0 again) the content differs →
    // stride = 4000 - 2000 = the ring's true capacity.
    for (let i = 2500; i <= 4000; i++) writeAcquireEntry(m, i, `msg ${i}`, acquireStampFor(i));
    const res = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin);
    expect(res?.capacityEstimate).toBe(2000);
    expect(pin.capacityEstimate).toBe(2000);
  });

  it("releases the hold once the counter keeps moving past it (loud escape hatch)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 500, 2500);
    readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin, 0);
    expect(pin.total).toBe(2500);

    // Counter advances every second while slot 500 is never rewritten.
    m.writeI32(ACQ_RING + 0x1cn, 2501);
    expect(readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin, 1_000)?.heldReason).toBe(
      "stale-slot",
    );

    let released = false;
    for (let t = 2_000; t <= ACQUIRE_HOLD_RELEASE_MS + 5_000; t += 1_000) {
      m.writeI32(ACQ_RING + 0x1cn, 2501 + t / 1_000);
      const r = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin, t);
      if (r?.heldReason === "released") {
        released = true;
        expect(r.entries).toHaveLength(1);
        break;
      }
    }
    expect(released).toBe(true);
  });

  it("does not expire a hold while the game is idle (counter not moving)", () => {
    const pin = makeAcquireRingPinState();
    const m = seedWrappedRing(seedAcquireRing(new FakeMemory(), []), 500, 2500);
    readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin, 0);

    // Counter frozen at 2501, slot 2500 never rewritten → hold forever, silently.
    m.writeI32(ACQ_RING + 0x1cn, 2501);
    for (let t = 1_000; t <= ACQUIRE_HOLD_RELEASE_MS * 4; t += 1_000) {
      const r = readRuntimeAcquireLogs(m, GA_BASE, GA_SIZE, LOG_O, pin, t);
      expect(r?.heldReason).toBe("stale-slot");
      expect(r?.entries).toHaveLength(0);
    }
    expect(pin.total).toBe(2500);
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

    const m = seedMonsterList(new FakeMemory(), [{ addr: 0xd00000n, current: 99, max: 100 }]);
    // Seed the stale-offset slots with garbage so the cached-pair read returns
    // values that fail validHpPair (current > maxHp*1.1).
    m.writeF32(0xd00000n + 0x100n + 0x30n, 999).writeF32(0xd00000n + 0x100n + 0x3cn, 1);

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
    m.writePtr(MONSTER_ARR + BigInt(O.container.arrayFirst), monsterAddr).writePtr(
      monsterAddr + 0xb0n,
      monsterAddr + 0x100n,
    );
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

  it("falls back to v1.00.21 base offsets when monster list offsets are 0 (v1.00.28+/v1.01.05)", () => {
    // v1.01.05: MonsterSpawnManager RVA present + name-scan pinned the instance,
    // but runtime.monster.monsterList/summonedList are 0 (not derivable). The
    // reader must fall back to the v1.00.21 base offsets (0x28/0x38/0x30) so
    // DPS/alive/max-HP data keeps flowing where those offsets are still valid —
    // verified live on v1.01.05. (TrackingService then falls back to
    // `updateAlive(stageAlive)` only when the array is EMPTY.)
    const O5 = offsetsForVersion("1.01.05")!;
    expect(O5.runtime.monster.monsterList).toBe(0);
    expect(O5.runtime.monster.summonedList).toBe(0);
    const pin = makeMonsterSpawnPinState();
    pin.ptr = MSM_INSTANCE; // bypass resolveMonsterSpawnManager (as name-scan would)
    // seedMonsterList lays the list out at MSM_INSTANCE + 0x28 — exactly the
    // v1.00.21 base offset the fallback reads, so HP data is recovered.
    const m = seedMonsterList(new FakeMemory(), [{ addr: 0xd00000n, current: 50, max: 100 }]);
    const r = readRuntimeMonsterHp(m, GA_BASE, GA_SIZE, O5, pin);
    expect(r).not.toBeNull();
    expect(r!.monsterHps).toEqual([[0xd00000, 50, 100]]);
  });
});

// ── v1.2.4 bundled table + ObscuredLong u64 mask ─────────────────────────────

describe("v1.2.4 offsets", () => {
  it("has an exact bundled table (no same-major.minor fallback)", () => {
    const t = offsetsForVersion("1.2.4")!;
    expect(t.gameVersion).toBe("1.2.4");
    expect(t._fallbackFromVersion).toBeUndefined();
    // Re-derived on a live v1.2.4 run 2026-09-17 (see offsets.ts comment).
    expect(t.typeInfoRva.currencyManager).toBe(0x5f4a068n);
  });
});

describe("readRuntimeGold u64 decode", () => {
  it("decodes an ObscuredLong whose hidden word has the sign bit set", () => {
    // v1.2.4 regression: (hidden - crypto) ^ crypto in signed BigInt yields a
    // negative value when hidden's top bit is set, even though the low 64 bits
    // are the correct balance — plausibleGold rejected it and live gold went
    // permanently null. The decoder must mask to u64 (like ObscuredInt).
    const goldVal = 49_979_096_419n; // ≈ the live wallet observed on v1.2.4
    const crypto = 0xc000_0000_0000_0005n; // top bits set → hidden gets the int64 sign bit
    const U64 = (1n << 64n) - 1n;
    // ACTk encode: hidden = (value ^ crypto) + crypto (u64 arithmetic).
    const hidden = ((goldVal ^ crypto) + crypto) & U64;
    // Sanity: hidden's int64 reinterpretation is negative — the exact input
    // that made the unmasked decoder produce a negative Number.
    expect(hidden > 1n << 63n).toBe(true);

    const m = seedGoldChain(new FakeMemory(), 0n); // chain only; overwrite value
    const structAddr = CURR_ENTRY + BigInt(O.runtime.currency.entryObscuredQty);
    const hBuf = Buffer.alloc(8);
    hBuf.writeBigUInt64LE(hidden, 0);
    m.writeBytes(structAddr + 8n, hBuf);
    const kBuf = Buffer.alloc(8);
    kBuf.writeBigUInt64LE(crypto, 0);
    m.writeBytes(structAddr + 16n, kBuf);

    const pin = makeGoldPinState();
    expect(readRuntimeGold(m, GA_BASE, GA_SIZE, O, pin)).toBe(Number(goldVal));
  });
});
