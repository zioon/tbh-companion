// Regression tests for the live hero-exp plausibility ceiling.
//
// Context (game v1.3.1, verified live 2026-10-26): the runtime exp is a
// WITHIN-LEVEL counter. At the level cap (101) a hero never levels up again, so
// nothing consumes that counter and it grows without bound — observed ~1.67e12
// (hero 401), ~2.47e12 (hero 301), ~2.50e12 (hero 201). The old 1e12 ceiling
// rejected every one of them: the reader clamped the exp to 0 and the tracker
// then skipped the hero entirely, leaving live hero XP permanently broken.
//
// The ceiling now matches the save-layer ceiling (MAX_HERO_SAVE_EXP = 1e15). It
// still rejects corrupt / misaligned Obscured decodes — that is its only job.
import { describe, it, expect } from "vitest";
import { readRuntimeHeroes } from "../../src/core/liveMemory/runtime";
import { offsetsForVersion } from "../../src/core/liveMemory/offsets";
import { XpTracker } from "../../src/core/tracker";
import type { SaveSnapshot } from "../../shared/types";
import { FakeMemory } from "./liveMemoryFake";

// v1.00.27+ uses the 8-byte ObscuredDouble exp layout, so the reader takes the
// ObscuredDouble branch (expKey - expHidden >= 8).
const O = offsetsForVersion("1.00.27")!;

const SM_SINGLETON = 0x510000n;
const HERO_LIST_OBJ = 0x800000n;
const HERO_PTR = 0x820000n;
const HERO_RT = 0x821000n; // Unit.cache → HeroRuntime
const HERO_INFO = 0x822000n; // HeroRuntime.info → HeroInfoData

const LEVEL_KEY = 0x1234;
const EXP_KEY = 0x5678n;

/**
 * The TRUE inverse of the reader's ACTk ObscuredDouble byte permutation.
 *
 * The reader's shuffle is out[i] = in[PERM[i]] with
 * PERM = [1, 0, 2, 3, 7, 4, 6, 5] (runtime.ts), and it is NOT an involution
 * (bytes 4/5/7 form a 3-cycle), so it cannot be inverted by applying itself.
 * Encoding must undo the shuffle with the inverse permutation — otherwise the
 * seeded bytes decode to garbage and the test would exercise a decoding accident
 * instead of the ceiling it claims to pin.
 */
const BYTE8_PERM_INV = [1, 0, 2, 3, 5, 7, 6, 4];

/** Apply a byte permutation to a 64-bit word: out[i] = in[P[i]]. */
function applyPerm(v: bigint, P: readonly number[]): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    const srcByte = Number((v >> BigInt(P[i] * 8)) & 0xffn);
    result |= BigInt(srcByte) << BigInt(i * 8);
  }
  return result;
}

/** Encode an ACTk ObscuredDouble (true inverse of the reader's decode). */
function seedObscuredDouble(
  m: FakeMemory,
  hiddenAddr: bigint,
  keyAddr: bigint,
  value: number,
): void {
  const bits = Buffer.alloc(8);
  bits.writeDoubleLE(value, 0);
  // reader: out = key ^ byteswap8(hidden)  ⇒  hidden = byteswap8⁻¹(key ^ out)
  const out = bits.readBigUInt64LE(0);
  const hidden = applyPerm(EXP_KEY ^ out, BYTE8_PERM_INV);
  const hiddenBuf = Buffer.alloc(8);
  hiddenBuf.writeBigUInt64LE(hidden, 0);
  const keyBuf = Buffer.alloc(8);
  keyBuf.writeBigUInt64LE(EXP_KEY, 0);
  m.writeBytes(hiddenAddr, hiddenBuf).writeBytes(keyAddr, keyBuf);
}

/** Encode an ACTk ObscuredInt (inverse of the reader's decode). */
function seedObscuredInt(m: FakeMemory, hiddenAddr: bigint, keyAddr: bigint, value: number): void {
  const u = value >>> 0;
  const hidden = (((u ^ LEVEL_KEY) >>> 0) + LEVEL_KEY) >>> 0;
  m.writeU32(hiddenAddr, hidden).writeU32(keyAddr, LEVEL_KEY);
}

/** Seed a one-hero live party off `smPtr`. */
function seedParty(m: FakeMemory, heroKey: number, level: number, exp: number): FakeMemory {
  m.writePtr(SM_SINGLETON + BigInt(O.runtime.heroList), HERO_LIST_OBJ);
  m.writeI32(HERO_LIST_OBJ + BigInt(O.container.listSize), 1);
  const first = HERO_LIST_OBJ + BigInt(O.container.arrayFirst);
  m.writePtr(first, HERO_PTR)
    .writePtr(HERO_PTR + BigInt(O.unit.cache), HERO_RT)
    .writePtr(HERO_RT + BigInt(O.heroRuntime.info), HERO_INFO)
    .writeI32(HERO_INFO + BigInt(O.heroInfoData.heroKey), heroKey);
  seedObscuredInt(
    m,
    HERO_RT + BigInt(O.heroRuntime.levelHidden),
    HERO_RT + BigInt(O.heroRuntime.levelKey),
    level,
  );
  seedObscuredDouble(
    m,
    HERO_RT + BigInt(O.heroRuntime.expHidden),
    HERO_RT + BigInt(O.heroRuntime.expKey),
    exp,
  );
  return m;
}

/** The exp magnitude observed live on v1.3.1 (hero 401). */
const V131_LIVE_EXP = 1_671_182_739_335;

describe("live hero exp plausibility ceiling", () => {
  it("keeps a v1.3.1-magnitude within-level exp (2.5e12) instead of clamping it to 0", () => {
    const m = seedParty(new FakeMemory(), 401, 101, 2.5e12);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes).not.toBeNull();
    expect(result.heroes).toHaveLength(1);
    expect(result.heroes![0].exp).toBe(2.5e12);
    expect(result.heroes![0].level).toBe(101);
  });

  it("keeps the exact v1.3.1 observed exp value", () => {
    const m = seedParty(new FakeMemory(), 401, 101, V131_LIVE_EXP);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes![0].exp).toBe(V131_LIVE_EXP);
  });

  it("still clamps a corrupt exp above the ceiling to 0", () => {
    const m = seedParty(new FakeMemory(), 401, 101, 1e16);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes).not.toBeNull();
    expect(result.heroes![0].exp).toBe(0);
  });

  it("still clamps a negative exp to 0", () => {
    const m = seedParty(new FakeMemory(), 401, 101, -5);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes![0].exp).toBe(0);
  });

  it("still clamps a NaN exp to 0", () => {
    const m = seedParty(new FakeMemory(), 401, 101, Number.NaN);
    const result = readRuntimeHeroes(m, O, SM_SINGLETON);
    expect(result.heroes![0].exp).toBe(0);
  });
});

function saveSnap(mtime: number, heroExp: number): SaveSnapshot {
  return {
    heroes: [{ key: "401", level: 101, exp: heroExp, unlocked: true }],
    totalHeroExp: heroExp,
    playTime: 0,
    saveMtime: mtime,
    stageKey: 4309,
    stageWave: 1,
    maxStage: 4309,
    gold: 0,
  };
}

describe("XpTracker live hero exp plausibility", () => {
  it("accepts a v1.3.1-magnitude live exp (2.5e12) as a real hero", () => {
    const t = new XpTracker(300);
    t.update(saveSnap(1000, 0)); // init from save
    t.updateLive({ gold: null, heroes: [{ heroKey: 401, level: 101, exp: 2.5e12 }] }, 1000);
    // The hero is accepted, so its exp lands in the tracked total.
    expect(t.currentTotalXp).toBe(2.5e12);
  });

  it("counts live XP gain between two v1.3.1-magnitude samples", () => {
    const t = new XpTracker(300);
    t.update(saveSnap(1000, 0)); // init from save
    // Level 100 (NOT the cap) — at the cap the level curve is exhausted and the
    // within-level delta is phantom by design (levelCurve.isLevelCapped), so a
    // capped hero can never report a same-level gain. Use a level below the
    // cap so this case actually exercises the gain path.
    t.updateLive({ gold: null, heroes: [{ heroKey: 401, level: 100, exp: 2.5e12 }] }, 1000);
    t.updateLive({ gold: null, heroes: [{ heroKey: 401, level: 100, exp: 2.5e12 + 600 }] }, 1060);
    expect(t.cumulativeGained).toBe(600);
    expect(t.currentTotalXp).toBe(2.5e12 + 600);
  });

  it("skips a hero whose live exp is corrupt (above the ceiling)", () => {
    const t = new XpTracker(300);
    t.update(saveSnap(1000, 0)); // init from save
    t.updateLive({ gold: null, heroes: [{ heroKey: 401, level: 101, exp: 1e16 }] }, 1000);
    // Implausible exp is dropped entirely — it contributes no total and no gain.
    expect(t.currentTotalXp).toBe(0);
    expect(t.cumulativeGained).toBe(0);
  });

  it("skips a hero whose live exp is negative or NaN", () => {
    for (const bad of [-1, Number.NaN]) {
      const t = new XpTracker(300);
      t.update(saveSnap(1000, 0)); // init from save
      t.updateLive({ gold: null, heroes: [{ heroKey: 401, level: 101, exp: bad }] }, 1000);
      expect(t.currentTotalXp).toBe(0);
      expect(t.cumulativeGained).toBe(0);
    }
  });
});
