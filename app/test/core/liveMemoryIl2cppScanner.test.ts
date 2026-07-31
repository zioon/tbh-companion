import { describe, it, expect } from "vitest";
import {
  collectClassEntries,
  collectLogManagerDiagnostics,
  dumpSaveListHolders,
  findBoxOpenLogDictDirect,
  findBoxOpenLogFields,
  findCurrencyManager,
  findLogManager,
  findPlayerSaveData,
  findStageCacheManager,
  findStageCacheManagerStatic,
  findStageManager,
  readCString,
  readClassFields,
  validateGetBoxList,
  ScanContext,
  STRUCT_CONTAINER,
  type ClassEntry,
} from "../../src/core/liveMemory/il2cppScanner";
import { FakeMemory } from "./liveMemoryFake";

// ── Helpers ────────────────────────────────────────────────────────────────────

const GA_BASE = 0x140000000n;

/** Write a null-terminated string to FakeMemory at `addr`.
 *  Always pads to at least 128 bytes so readCString's maxLen=128 readBytes call succeeds. */
function writeString(m: FakeMemory, addr: bigint, s: string, minLen = 128): void {
  const b = Buffer.alloc(Math.max(s.length + 1, minLen), 0);
  b.write(s, 0, "utf8");
  m.writeBytes(addr, b);
}

/** Seed a minimal named Il2CppClass* at `classPtr` (name string at classPtr+0x200). */
function seedClass(m: FakeMemory, classPtr: bigint, name: string): void {
  const nameAddr = classPtr + 0x200n;
  writeString(m, nameAddr, name);
  m.writePtr(classPtr + 0x10n, nameAddr); // Il2CppClass.name
}

/** Seed Il2CppFieldInfo entries at `fieldsPtr` off classPtr+0x80. */
function seedFields(
  m: FakeMemory,
  classPtr: bigint,
  fields: Array<{ name: string; offset: number }>,
): void {
  const fieldsPtr = classPtr + 0x1000n;
  m.writePtr(classPtr + 0x80n, fieldsPtr); // Il2CppClass.fields
  for (let i = 0; i < fields.length; i++) {
    const base = fieldsPtr + BigInt(i * 0x20);
    const nameAddr = fieldsPtr + 0x1000n + BigInt(i * 0x100);
    writeString(m, nameAddr, fields[i].name);
    m.writePtr(base, nameAddr); // name
    m.writeI32(base + 0x18n, fields[i].offset); // offset
  }
  // sentinel: null name ptr at next entry
  m.writePtr(fieldsPtr + BigInt(fields.length * 0x20), 0n);
}

/** Seed a static_fields block at classPtr+0xb0 and return its address. */
function seedStaticBlock(m: FakeMemory, classPtr: bigint, blockAddr: bigint): bigint {
  m.writePtr(classPtr + 0xb0n, blockAddr);
  return blockAddr;
}

/** Give an object instance a class header (`*obj` = Il2CppClass*). */
function seedInstance(m: FakeMemory, objPtr: bigint, classPtr: bigint): void {
  m.writePtr(objPtr, classPtr);
}

/**
 * Seed a List<T> shape at `listPtr`: writes the _items array pointer at
 * +0x10, the _size int32 at +0x18, and the first element pointer at
 * arrayPtr+0x20. The element's class header must be set separately via
 * seedInstance.
 */
function seedList<T extends bigint>(
  m: FakeMemory,
  listPtr: bigint,
  arrayPtr: bigint,
  count: number,
  firstElemPtr: T,
): void {
  m.writePtr(listPtr + BigInt(STRUCT_CONTAINER.listItems), arrayPtr);
  m.writeI32(listPtr + BigInt(STRUCT_CONTAINER.listSize), count);
  m.writePtr(arrayPtr + BigInt(STRUCT_CONTAINER.arrayFirst), firstElemPtr);
}

/** A hand-built index entry (detector tests skip the region scan). */
function entry(m: FakeMemory, classPtr: bigint, slotRva: bigint, name: string): ClassEntry {
  seedClass(m, classPtr, name);
  return { classPtr, slotRva, name };
}

// ── readCString ────────────────────────────────────────────────────────────────

describe("readCString", () => {
  it("reads a null-terminated ASCII string", () => {
    const m = new FakeMemory();
    writeString(m, 0x500000n, "StageManager");
    expect(readCString(m, 0x500000n)).toBe("StageManager");
  });

  it("returns null for a pointer below 0x10000 (implausible)", () => {
    const m = new FakeMemory();
    expect(readCString(m, 0x1000n)).toBeNull();
  });

  it("returns null when the string is empty (leading NUL)", () => {
    const m = new FakeMemory();
    m.writeBytes(0x500000n, Buffer.alloc(8, 0));
    expect(readCString(m, 0x500000n)).toBeNull();
  });

  it("returns null when the string contains non-printable characters", () => {
    const m = new FakeMemory();
    const buf = Buffer.alloc(128, 0);
    buf.write("Stage", 0, "utf8");
    buf[5] = 0x01; // control character inside the name
    buf.write("Manager", 6, "utf8");
    m.writeBytes(0x500000n, buf);
    expect(readCString(m, 0x500000n)).toBeNull();
  });

  it("returns null when the memory region is unreadable (empty FakeMemory)", () => {
    expect(readCString(new FakeMemory(), 0x500000n)).toBeNull();
  });

  it("truncates at maxLen without crashing", () => {
    const m = new FakeMemory();
    // 128 bytes of printable ASCII, no null terminator → readCString returns all 128 chars
    const buf = Buffer.alloc(128, 0x41); // 'A' * 128
    m.writeBytes(0x500000n, buf);
    const result = readCString(m, 0x500000n, 128);
    expect(result).toHaveLength(128);
  });
});

// ── readClassFields ───────────────────────────────────────────────────────────

describe("readClassFields", () => {
  it("returns a map of field name → instance offset", () => {
    const m = new FakeMemory();
    const classPtr = 0x7ff000100n;
    seedFields(m, classPtr, [
      { name: "HeroList", offset: 0x30 },
      { name: "boxCount", offset: 0xf8 },
    ]);

    const result = readClassFields(m, classPtr);
    expect(result).not.toBeNull();
    expect(result!.get("HeroList")).toBe(0x30);
    expect(result!.get("boxCount")).toBe(0xf8);
  });

  it("returns null when both fields-pointer candidates are unreadable", () => {
    expect(readClassFields(new FakeMemory(), 0x7ff000100n)).toBeNull();
  });

  it("falls back to +0x88 when +0x80 yields null", () => {
    const m = new FakeMemory();
    const classPtr = 0x7ff000200n;
    const fieldsPtr = classPtr + 0x1000n;
    m.writePtr(classPtr + 0x88n, fieldsPtr);
    const nameAddr = fieldsPtr + 0x1000n;
    writeString(m, nameAddr, "someField");
    m.writePtr(fieldsPtr, nameAddr);
    m.writeI32(fieldsPtr + 0x18n, 0x40);
    m.writePtr(fieldsPtr + 0x20n, 0n); // sentinel

    const result = readClassFields(m, classPtr);
    expect(result).not.toBeNull();
    expect(result!.get("someField")).toBe(0x40);
  });

  it("stops at a null name pointer (end-of-array sentinel)", () => {
    const m = new FakeMemory();
    const classPtr = 0x7ff000300n;
    seedFields(m, classPtr, [{ name: "OnlyField", offset: 0x10 }]);

    const result = readClassFields(m, classPtr);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(1);
  });
});

// ── collectClassEntries ───────────────────────────────────────────────────────

describe("collectClassEntries", () => {
  it("indexes named classes from region slots and records their slot RVAs", () => {
    const m = new FakeMemory();
    const classA = 0x7ff000000n;
    const classB = 0x7ff100000n;
    seedClass(m, classA, "StageCache");
    seedClass(m, classB, "GetBoxLog");

    // Region buffer: [garbage, classA, low value, classB]
    const regionBase = GA_BASE + 0x1000n;
    const buf = Buffer.alloc(32);
    buf.writeBigUInt64LE(0xdeadbeefdeadbeefn, 0); // implausible (> 0x7ff0...)
    buf.writeBigUInt64LE(classA, 8);
    buf.writeBigUInt64LE(0x10n, 16); // below plausible range
    buf.writeBigUInt64LE(classB, 24);
    m.writeBytes(regionBase, buf);

    const ctx = new ScanContext(m);
    const { entries, stats } = collectClassEntries(ctx, GA_BASE, [{ base: regionBase, size: 32 }]);

    expect(stats.slotsScanned).toBe(4);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === "StageCache")?.slotRva).toBe(0x1008n);
    expect(entries.find((e) => e.name === "GetBoxLog")?.slotRva).toBe(0x1018n);
  });

  it("dedupes repeated class pointers, keeping the first slot", () => {
    const m = new FakeMemory();
    const classA = 0x7ff000000n;
    seedClass(m, classA, "StageCache");
    const regionBase = GA_BASE + 0x2000n;
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(classA, 0);
    buf.writeBigUInt64LE(classA, 8);
    m.writeBytes(regionBase, buf);

    const ctx = new ScanContext(m);
    const { entries } = collectClassEntries(ctx, GA_BASE, [{ base: regionBase, size: 16 }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].slotRva).toBe(0x2000n);
  });

  it("reads regions in chunks (slot RVAs stay correct across chunk boundaries)", () => {
    const m = new FakeMemory();
    const classA = 0x7ff000000n;
    const classB = 0x7ff100000n;
    seedClass(m, classA, "First");
    seedClass(m, classB, "Second");

    const regionBase = GA_BASE + 0x3000n;
    const chunk1 = Buffer.alloc(16);
    chunk1.writeBigUInt64LE(classA, 0);
    const chunk2 = Buffer.alloc(16);
    chunk2.writeBigUInt64LE(classB, 8);
    m.writeBytes(regionBase, chunk1);
    m.writeBytes(regionBase + 16n, chunk2);

    const ctx = new ScanContext(m);
    const { entries } = collectClassEntries(
      ctx,
      GA_BASE,
      [{ base: regionBase, size: 32 }],
      16, // chunkSize
    );
    expect(entries.find((e) => e.name === "First")?.slotRva).toBe(0x3000n);
    expect(entries.find((e) => e.name === "Second")?.slotRva).toBe(0x3018n);
  });

  it("skips unreadable regions", () => {
    const ctx = new ScanContext(new FakeMemory());
    const { entries, stats } = collectClassEntries(ctx, GA_BASE, [
      { base: GA_BASE + 0x1000n, size: 64 },
    ]);
    expect(entries).toHaveLength(0);
    expect(stats.slotsScanned).toBe(0);
  });
});

// ── findStageManager ──────────────────────────────────────────────────────────

describe("findStageManager", () => {
  it("finds the wrapper whose static slot holds an instance with a HeroList field", () => {
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const smClass = 0x7ff210000n;
    const smInst = 0x7ff220000n;
    const heroArr = 0x7ff240000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    m.writePtr(block + 0x20n, smInst);
    seedInstance(m, smInst, smClass);
    seedClass(m, smClass, "StageManager");
    seedFields(m, smClass, [{ name: "HeroList", offset: 0x30 }]);
    // findStageManager validates the HeroList points at a non-empty array
    // (count > 0 at +0x18). Without this, non-StageManager classes that also
    // declare HeroList would match — see findStageManager's doc comment.
    m.writePtr(smInst + 0x30n, heroArr);
    m.writeI32(heroArr + 0x18n, 3); // count = 3 heroes

    const result = findStageManager(new ScanContext(m), [e]);
    expect(result).toEqual({ slotRva: 0x5000n, heroList: 0x30 });
  });

  it("rejects a wrapper whose HeroList is an empty array (non-StageManager class)", () => {
    // v1.01.02 regression: a non-StageManager class (UI preview / cache) also
    // declares HeroList but its array is always empty. findStageManager must
    // skip it and continue scanning for the real StageManager with a non-empty
    // party. Without this check, the extractor returns the wrong class's
    // slotRva and the reader never finds a live StageManager instance.
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const wrongClass = 0x7ff210000n;
    const wrongInst = 0x7ff220000n;
    const wrongArr = 0x7ff240000n;
    const realClass = 0x7ff250000n;
    const realInst = 0x7ff260000n;
    const realArr = 0x7ff270000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    // Wrong class first (empty HeroList — should be rejected).
    m.writePtr(block + 0x10n, wrongInst);
    seedInstance(m, wrongInst, wrongClass);
    seedClass(m, wrongClass, "HeroPreviewCache");
    seedFields(m, wrongClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(wrongInst + 0x30n, wrongArr);
    m.writeI32(wrongArr + 0x18n, 0); // empty party
    // Real StageManager second (non-empty HeroList — should match).
    m.writePtr(block + 0x20n, realInst);
    seedInstance(m, realInst, realClass);
    seedClass(m, realClass, "StageManager");
    seedFields(m, realClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(realInst + 0x30n, realArr);
    m.writeI32(realArr + 0x18n, 4); // 4 heroes deployed

    const result = findStageManager(new ScanContext(m), [e]);
    expect(result).toEqual({ slotRva: 0x5000n, heroList: 0x30 });
  });

  it("returns null when no static instance has a HeroList field", () => {
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const someClass = 0x7ff210000n;
    const inst = 0x7ff220000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    m.writePtr(block, inst);
    seedInstance(m, inst, someClass);
    seedClass(m, someClass, "SomethingElse");
    seedFields(m, someClass, [{ name: "otherField", offset: 0x18 }]);

    expect(findStageManager(new ScanContext(m), [e])).toBeNull();
  });

  // ── Layer-2 hero-walk validation (Rev 12) ──────────────────────────────────
  // A non-StageManager class (UI preview / cache) can declare HeroList and
  // briefly hold a non-empty array of non-Unit pointers. Layer 1 (non-empty
  // count) would match it; layer 2 walks the first hero end-to-end and
  // rejects it because the pointers don't lead to a plausible heroKey.

  /** Seed a full hero walk: heroPtr → unit.cache(0x3b0) → runtime.info(0x30) → heroKey(0x30). */
  function seedHeroWalk(
    m: FakeMemory,
    heroPtr: bigint,
    runtimePtr: bigint,
    infoPtr: bigint,
    heroKey: number,
  ): void {
    m.writePtr(heroPtr + 0x3b0n, runtimePtr);
    m.writePtr(runtimePtr + 0x30n, infoPtr);
    m.writeI32(infoPtr + 0x30n, heroKey);
  }

  it("layer-2 accepts a StageManager whose first hero walks to a valid heroKey", () => {
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const smClass = 0x7ff210000n;
    const smInst = 0x7ff220000n;
    const heroArr = 0x7ff240000n;
    const heroPtr = 0x7ff250000n;
    const runtimePtr = 0x7ff260000n;
    const infoPtr = 0x7ff270000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    m.writePtr(block + 0x20n, smInst);
    seedInstance(m, smInst, smClass);
    seedClass(m, smClass, "StageManager");
    seedFields(m, smClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(smInst + 0x30n, heroArr);
    m.writeI32(heroArr + 0x18n, 1); // count = 1 hero
    m.writePtr(heroArr + 0x20n, heroPtr); // first element
    seedHeroWalk(m, heroPtr, runtimePtr, infoPtr, 100001); // valid heroKey

    const result = findStageManager(new ScanContext(m), [e], {
      heroOffsets: { unitCache: 0x3b0, heroRuntimeInfo: 0x30, heroInfoDataKey: 0x30 },
    });
    expect(result).toEqual({ slotRva: 0x5000n, heroList: 0x30 });
  });

  it("layer-2 rejects a non-StageManager class whose HeroList holds non-Unit pointers", () => {
    // v1.01.02 regression: a UI preview class declares HeroList with count > 0,
    // but the array elements are not Unit objects — they don't have a valid
    // cache pointer at +0x3b0. Layer 2 must reject it and continue scanning.
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const wrongClass = 0x7ff210000n;
    const wrongInst = 0x7ff220000n;
    const wrongArr = 0x7ff240000n;
    const wrongHeroPtr = 0x7ff250000n;
    const realClass = 0x7ff2a0000n;
    const realInst = 0x7ff2b0000n;
    const realArr = 0x7ff2c0000n;
    const realHeroPtr = 0x7ff2d0000n;
    const realRuntime = 0x7ff2e0000n;
    const realInfo = 0x7ff2f0000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    // Wrong class first (non-Unit HeroList — layer 2 must reject).
    m.writePtr(block + 0x10n, wrongInst);
    seedInstance(m, wrongInst, wrongClass);
    seedClass(m, wrongClass, "HeroPreviewCache");
    seedFields(m, wrongClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(wrongInst + 0x30n, wrongArr);
    m.writeI32(wrongArr + 0x18n, 3); // count = 3 (passes layer 1)
    m.writePtr(wrongArr + 0x20n, wrongHeroPtr); // first element
    // wrongHeroPtr + 0x3b0 is 0 (not a plausible pointer) → hero-walk fails
    // Real StageManager second (valid hero walk — layer 2 passes).
    m.writePtr(block + 0x20n, realInst);
    seedInstance(m, realInst, realClass);
    seedClass(m, realClass, "StageManager");
    seedFields(m, realClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(realInst + 0x30n, realArr);
    m.writeI32(realArr + 0x18n, 2); // count = 2
    m.writePtr(realArr + 0x20n, realHeroPtr);
    seedHeroWalk(m, realHeroPtr, realRuntime, realInfo, 100002);

    const result = findStageManager(new ScanContext(m), [e], {
      heroOffsets: { unitCache: 0x3b0, heroRuntimeInfo: 0x30, heroInfoDataKey: 0x30 },
    });
    expect(result).toEqual({ slotRva: 0x5000n, heroList: 0x30 });
  });

  it("layer-2 skips a hero with out-of-range heroKey and accepts the next valid one", () => {
    // The first hero's heroKey is 0 (invalid); the second hero walks cleanly.
    // Layer 2 must probe up to maxHeroesProbe and accept the class.
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const smClass = 0x7ff210000n;
    const smInst = 0x7ff220000n;
    const heroArr = 0x7ff240000n;
    const hero1 = 0x7ff250000n;
    const hero2 = 0x7ff260000n;
    const rt1 = 0x7ff270000n;
    const rt2 = 0x7ff280000n;
    const info1 = 0x7ff290000n;
    const info2 = 0x7ff2a0000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    m.writePtr(block + 0x20n, smInst);
    seedInstance(m, smInst, smClass);
    seedClass(m, smClass, "StageManager");
    seedFields(m, smClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(smInst + 0x30n, heroArr);
    m.writeI32(heroArr + 0x18n, 2); // count = 2
    m.writePtr(heroArr + 0x20n, hero1); // hero[0]
    m.writePtr(heroArr + 0x28n, hero2); // hero[1]
    seedHeroWalk(m, hero1, rt1, info1, 0); // invalid heroKey
    seedHeroWalk(m, hero2, rt2, info2, 100003); // valid

    const result = findStageManager(new ScanContext(m), [e], {
      heroOffsets: { unitCache: 0x3b0, heroRuntimeInfo: 0x30, heroInfoDataKey: 0x30 },
    });
    expect(result).toEqual({ slotRva: 0x5000n, heroList: 0x30 });
  });

  it("layer-2 returns null when every candidate fails hero-walk (party all garbage)", () => {
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const smClass = 0x7ff210000n;
    const smInst = 0x7ff220000n;
    const heroArr = 0x7ff240000n;
    const hero1 = 0x7ff250000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    m.writePtr(block + 0x20n, smInst);
    seedInstance(m, smInst, smClass);
    seedClass(m, smClass, "StageManager");
    seedFields(m, smClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(smInst + 0x30n, heroArr);
    m.writeI32(heroArr + 0x18n, 1);
    m.writePtr(heroArr + 0x20n, hero1);
    // hero1 + 0x3b0 = 0 → runtimePtr null → hero-walk fails

    const result = findStageManager(new ScanContext(m), [e], {
      heroOffsets: { unitCache: 0x3b0, heroRuntimeInfo: 0x30, heroInfoDataKey: 0x30 },
    });
    expect(result).toBeNull();
  });

  it("layer-2 is skipped when heroOffsets is undefined (back-compat with no opts)", () => {
    // Existing callers that don't pass opts must still get layer-1-only behavior.
    const m = new FakeMemory();
    const wrapper = 0x7ff200000n;
    const smClass = 0x7ff210000n;
    const smInst = 0x7ff220000n;
    const heroArr = 0x7ff240000n;

    const e = entry(m, wrapper, 0x5000n, "nq`1");
    const block = seedStaticBlock(m, wrapper, 0x7ff230000n);
    m.writePtr(block + 0x20n, smInst);
    seedInstance(m, smInst, smClass);
    seedClass(m, smClass, "StageManager");
    seedFields(m, smClass, [{ name: "HeroList", offset: 0x30 }]);
    m.writePtr(smInst + 0x30n, heroArr);
    m.writeI32(heroArr + 0x18n, 3); // non-empty, but no hero pointers seeded

    // No opts → layer 2 skipped → layer 1 passes → match returned.
    const result = findStageManager(new ScanContext(m), [e]);
    expect(result).toEqual({ slotRva: 0x5000n, heroList: 0x30 });
  });
});

// ── findStageCacheManager ─────────────────────────────────────────────────────

describe("findStageCacheManager", () => {
  function seedStageCacheHolder(m: FakeMemory, opts: { infoClassName: string }): ClassEntry {
    const wrapper = 0x7ff300000n;
    const cacheClass = 0x7ff310000n;
    const infoClass = 0x7ff320000n;
    const cacheInst = 0x7ff330000n;
    const infoInst = 0x7ff340000n;

    const e = entry(m, wrapper, 0x6000n, "uu");
    const block = seedStaticBlock(m, wrapper, 0x7ff350000n);
    m.writePtr(block + 0x88n, cacheInst);
    seedInstance(m, cacheInst, cacheClass);
    seedClass(m, cacheClass, "StageCache");
    m.writePtr(cacheInst + 0x10n, infoInst);
    seedInstance(m, infoInst, infoClass);
    seedClass(m, infoClass, opts.infoClassName);
    return e;
  }

  it("finds the static slot pointing at StageCache → StageInfoData", () => {
    const m = new FakeMemory();
    const e = seedStageCacheHolder(m, { infoClassName: "StageInfoData" });
    const result = findStageCacheManager(new ScanContext(m), [e]);
    expect(result).toEqual({ slotRva: 0x6000n, currentCache: 0x88 });
  });

  it("accepts vb.StageCache as the cache instance class name (v1.00.23)", () => {
    const m = new FakeMemory();
    const wrapper = 0x7ff300000n;
    const cacheClass = 0x7ff310000n;
    const infoClass = 0x7ff320000n;
    const cacheInst = 0x7ff330000n;
    const infoInst = 0x7ff340000n;

    const e = entry(m, wrapper, 0x6000n, "uu");
    const block = seedStaticBlock(m, wrapper, 0x7ff350000n);
    m.writePtr(block + 0x88n, cacheInst);
    seedInstance(m, cacheInst, cacheClass);
    seedClass(m, cacheClass, "vb.StageCache");
    m.writePtr(cacheInst + 0x10n, infoInst);
    seedInstance(m, infoInst, infoClass);
    seedClass(m, infoClass, "StageInfoData");

    expect(findStageCacheManagerStatic(new ScanContext(m), [e])).toEqual({
      slotRva: 0x6000n,
      currentCache: 0x88,
    });
  });

  it("rejects a StageCache whose info object is not a StageInfoData", () => {
    const m = new FakeMemory();
    const e = seedStageCacheHolder(m, { infoClassName: "SomethingElse" });
    expect(findStageCacheManager(new ScanContext(m), [e])).toBeNull();
  });
});

// ── findLogManager ────────────────────────────────────────────────────────────

/** Seed a LogManager-shaped holder; returns the index entry. */
function seedLogManager(
  m: FakeMemory,
  opts: {
    entryClassName: string;
    monsterTypes: number[];
    /** Offset of the logByType dict within the LogManager instance (default 0x28). */
    dictOff?: number;
    /** ELogType.GetBox enum value in the dict (default 3). */
    getBoxKey?: number;
    /** Optional second dict bucket: List<BoxOpenLog>. */
    boxOpen?: {
      key: number;
      entryClassName?: string;
      /** Extra index entries to add (e.g. a BoxOpenLog class with fields). */
      extraEntries?: ClassEntry[];
    };
  },
): ClassEntry {
  const dictOff = opts.dictOff ?? 0x28;
  const getBoxKey = opts.getBoxKey ?? 3;
  const wrapper = 0x7ff400000n;
  const lmInst = 0x7ff410000n;
  const dict = 0x7ff420000n;
  const dictEntries = 0x7ff430000n;
  const list = 0x7ff440000n;
  const listArr = 0x7ff450000n;
  const logClass = 0x7ff460000n;

  const e = entry(m, wrapper, 0x7000n, "nq`1");
  const block = seedStaticBlock(m, wrapper, 0x7ff470000n);
  m.writePtr(block, lmInst);
  seedInstance(m, lmInst, logClass); // header irrelevant for detection but keep valid
  m.writePtr(lmInst + BigInt(dictOff), dict);

  const hasBoxOpen = opts.boxOpen != null;
  const dictCount = hasBoxOpen ? 2 : 1;

  // Dictionary<int, List<GetBoxLog>> with one entry: getBoxKey → list
  m.writePtr(dict + 0x18n, dictEntries);
  m.writeI32(dict + 0x20n, dictCount);
  const eBase = dictEntries + 0x20n;
  m.writeI32(eBase, 42); // hash ≥ 0
  m.writeI32(eBase + 8n, getBoxKey);
  m.writePtr(eBase + 16n, list);

  // List<GetBoxLog>
  m.writePtr(list + 0x10n, listArr);
  m.writeI32(list + 0x18n, opts.monsterTypes.length);
  const entryClass = 0x7ff480000n;
  seedClass(m, entryClass, opts.entryClassName);
  for (let i = 0; i < opts.monsterTypes.length; i++) {
    const logObj = 0x7ff490000n + BigInt(i * 0x100);
    m.writePtr(listArr + 0x20n + BigInt(i * 8), logObj);
    seedInstance(m, logObj, entryClass);
    m.writeI32(logObj + 0x50n, opts.monsterTypes[i]);
  }

  // Optional second dict entry: BoxOpenLog bucket
  if (hasBoxOpen) {
    const bo = opts.boxOpen!;
    const e2Base = eBase + 24n; // entrySize = 24
    const boList = 0x7ff4a0000n;
    const boListArr = 0x7ff4b0000n;
    const boEntryClass = 0x7ff4c0000n;
    const boClassName = bo.entryClassName ?? "BoxOpenLog";
    m.writeI32(e2Base, 99); // hash ≥ 0
    m.writeI32(e2Base + 8n, bo.key);
    m.writePtr(e2Base + 16n, boList);
    // List<BoxOpenLog> with 1 entry
    m.writePtr(boList + 0x10n, boListArr);
    m.writeI32(boList + 0x18n, 1);
    seedClass(m, boEntryClass, boClassName);
    const boObj = 0x7ff4d0000n;
    m.writePtr(boListArr + 0x20n, boObj);
    seedInstance(m, boObj, boEntryClass);
  }

  return e;
}

describe("findLogManager", () => {
  it("finds the holder whose GetBox list contains valid GetBoxLog entries", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, { entryClassName: "GetBoxLog", monsterTypes: [0, 1, 2] });
    expect(findLogManager(new ScanContext(m), [e])).toEqual({
      slotRva: 0x7000n,
      logByType: 0x28,
      getBoxTypeKey: 3,
      boxOpenTypeKey: 0,
      boxOpenLog: { itemStringKey: 0, itemGradeType: 0, gradeSO: 0, gradeSOGrade: 0 },
    });
  });

  it("discovers a non-default logByType offset (v1.00.28 field-shifted dict)", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "GetBoxLog",
      monsterTypes: [0, 1],
      dictOff: 0x20,
    });
    expect(findLogManager(new ScanContext(m), [e])).toEqual({
      slotRva: 0x7000n,
      logByType: 0x20,
      getBoxTypeKey: 3,
      boxOpenTypeKey: 0,
      boxOpenLog: { itemStringKey: 0, itemGradeType: 0, gradeSO: 0, gradeSOGrade: 0 },
    });
  });

  it("discovers a non-default ELogType.GetBox enum value", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "GetBoxLog",
      monsterTypes: [0, 1],
      getBoxKey: 7,
    });
    expect(findLogManager(new ScanContext(m), [e])).toEqual({
      slotRva: 0x7000n,
      logByType: 0x28,
      getBoxTypeKey: 7,
      boxOpenTypeKey: 0,
      boxOpenLog: { itemStringKey: 0, itemGradeType: 0, gradeSO: 0, gradeSOGrade: 0 },
    });
  });

  it("accepts a namespaced GetBoxLog class name (vb.GetBoxLog)", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "vb.GetBoxLog",
      monsterTypes: [0, 1, 2],
    });
    expect(findLogManager(new ScanContext(m), [e])).toEqual({
      slotRva: 0x7000n,
      logByType: 0x28,
      getBoxTypeKey: 3,
      boxOpenTypeKey: 0,
      boxOpenLog: { itemStringKey: 0, itemGradeType: 0, gradeSO: 0, gradeSOGrade: 0 },
    });
  });

  it("rejects a structurally-similar dict whose entries are not GetBoxLog", () => {
    // Live regression: a compiler-generated `<>c` class matched the loose shape.
    const m = new FakeMemory();
    const e = seedLogManager(m, { entryClassName: "SomethingElse", monsterTypes: [0, 0] });
    expect(findLogManager(new ScanContext(m), [e])).toBeNull();
  });

  it("rejects entries with an out-of-range monster type", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, { entryClassName: "GetBoxLog", monsterTypes: [0, -88672624] });
    expect(findLogManager(new ScanContext(m), [e])).toBeNull();
  });

  it("rejects an empty GetBox list (cannot validate entry shape)", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, { entryClassName: "GetBoxLog", monsterTypes: [] });
    expect(findLogManager(new ScanContext(m), [e])).toBeNull();
  });

  it("derives boxOpenTypeKey when the dict has a BoxOpenLog bucket", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "GetBoxLog",
      monsterTypes: [0, 1],
      boxOpen: { key: 5 },
    });
    // BoxOpenLog class entry with real-named fields
    const boClass = 0x7ff4c0000n; // same addr seedLogManager used for the class
    const boEntry = entry(m, boClass, 0x8000n, "BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);
    expect(findLogManager(new ScanContext(m), [e, boEntry])).toEqual({
      slotRva: 0x7000n,
      logByType: 0x28,
      getBoxTypeKey: 3,
      boxOpenTypeKey: 5,
      boxOpenLog: { itemStringKey: 0x18, itemGradeType: 0x1c, gradeSO: 0, gradeSOGrade: 0 },
    });
  });

  it("accepts a namespaced BoxOpenLog class name (vb.BoxOpenLog)", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "GetBoxLog",
      monsterTypes: [0],
      boxOpen: { key: 4, entryClassName: "vb.BoxOpenLog" },
    });
    const boClass = 0x7ff4c0000n;
    const boEntry = entry(m, boClass, 0x8000n, "vb.BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x20 },
      { name: "itemGradeType", offset: 0x24 },
    ]);
    expect(findLogManager(new ScanContext(m), [e, boEntry])).toEqual({
      slotRva: 0x7000n,
      logByType: 0x28,
      getBoxTypeKey: 3,
      boxOpenTypeKey: 4,
      boxOpenLog: { itemStringKey: 0x20, itemGradeType: 0x24, gradeSO: 0, gradeSOGrade: 0 },
    });
  });

  it("returns boxOpenTypeKey=0 when no BoxOpenLog bucket is in the dict", () => {
    const m = new FakeMemory();
    const e = seedLogManager(m, { entryClassName: "GetBoxLog", monsterTypes: [0, 1] });
    // BoxOpenLog class exists in the index, but no bucket in the dict
    const boClass = 0x7ff480000n + 0x10000n;
    const boEntry = entry(m, boClass, 0x8000n, "BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);
    const result = findLogManager(new ScanContext(m), [e, boEntry]);
    expect(result?.boxOpenTypeKey).toBe(0);
    // Fields are still resolved from the class metadata
    expect(result?.boxOpenLog).toEqual({
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("resolves boxOpenLog fields from the live instance even when BoxOpenLog is absent from the index", () => {
    // Regression for v1.00.28: BoxOpenLog is not static-reachable, so the class
    // never enters the entries index. findLogManager must still resolve field
    // offsets by reading the class metadata of a live BoxOpenLog object captured
    // during the dict walk. Without this, boxOpenLog.fields stays at {0x0,0x0}
    // and the loot tracker never reads item keys.
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "GetBoxLog",
      monsterTypes: [0, 1],
      boxOpen: { key: 5 },
    });
    // seedLogManager already seeds the BoxOpenLog class metadata (name + class
    // header) at 0x7ff4c0000n and an instance at 0x7ff4d0000n pointing at it.
    // Add the fields to that class.
    const boClass = 0x7ff4c0000n;
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);
    // Note: NO boEntry is added to the index — entries only has the LogManager
    // wrapper. The instance-pointer path must carry the field resolution.
    const result = findLogManager(new ScanContext(m), [e]);
    expect(result).not.toBeNull();
    expect(result!.boxOpenTypeKey).toBe(5);
    expect(result!.boxOpenLog).toEqual({
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });
});

// ── collectLogManagerDiagnostics ─────────────────────────────────────────────

describe("collectLogManagerDiagnostics", () => {
  it("dumps candidate dict buckets when findLogManager would return null", () => {
    // A dict whose entries are NOT GetBoxLog (class name mismatch) — the same
    // scenario as the "rejects a structurally-similar dict" test above.
    const m = new FakeMemory();
    const e = seedLogManager(m, { entryClassName: "SomethingElse", monsterTypes: [0, 0] });
    // Sanity: findLogManager returns null for this layout.
    expect(findLogManager(new ScanContext(m), [e])).toBeNull();
    // Diagnostics should describe what was seen.
    const diag = collectLogManagerDiagnostics(new ScanContext(m), [e]);
    expect(diag).toContain("[logManager-diag]");
    expect(diag).toContain("bucketCount=2"); // monsterTypes.length === 2
    expect(diag).toContain("firstEntryClassName=");
  });

  it("returns a no-dict message when no static slot has a dict-shaped field", () => {
    const m = new FakeMemory();
    // A class with no dict at any candidate offset.
    const e = entry(m, 0x7ff600000n, 0x8000n, "EmptyClass");
    seedStaticBlock(m, 0x7ff600000n, 0x7ff610000n);
    const diag = collectLogManagerDiagnostics(new ScanContext(m), [e]);
    expect(diag).toContain("[logManager-diag]");
    expect(diag).toContain("no dict-shaped static slot found");
  });
});

// ── findBoxOpenLogFields ─────────────────────────────────────────────────────

describe("findBoxOpenLogFields", () => {
  it("resolves itemStringKey and itemGradeType from the BoxOpenLog class metadata", () => {
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const e = entry(m, boClass, 0x9000n, "BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);
    expect(findBoxOpenLogFields(new ScanContext(m), [e])).toEqual({
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("returns 0 for fields absent from the BoxOpenLog class", () => {
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const e = entry(m, boClass, 0x9000n, "BoxOpenLog");
    seedFields(m, boClass, [{ name: "someOtherField", offset: 0x10 }]);
    expect(findBoxOpenLogFields(new ScanContext(m), [e])).toEqual({
      itemStringKey: 0,
      itemGradeType: 0,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("returns 0 when no BoxOpenLog class is in the index", () => {
    const m = new FakeMemory();
    const e = entry(m, 0x7ff500000n, 0x9000n, "SomethingElse");
    expect(findBoxOpenLogFields(new ScanContext(m), [e])).toEqual({
      itemStringKey: 0,
      itemGradeType: 0,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("accepts a namespaced BoxOpenLog class (vb.BoxOpenLog)", () => {
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const e = entry(m, boClass, 0x9000n, "vb.BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x20 },
      { name: "itemGradeType", offset: 0x24 },
    ]);
    expect(findBoxOpenLogFields(new ScanContext(m), [e])).toEqual({
      itemStringKey: 0x20,
      itemGradeType: 0x24,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("resolves fields from a live instance ptr even when the class is absent from the index", () => {
    // Regression for v1.00.28: BoxOpenLog class is not static-reachable, so it
    // never appears in the entries index. Field offsets must be read directly
    // from the live object's IL2CPP class header.
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const boInstance = 0x7ff510000n;
    // Seed the class metadata (name + fields) but do NOT add it to `entries`.
    seedClass(m, boClass, "BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);
    seedInstance(m, boInstance, boClass);
    // entries contains only an unrelated class — named search would return 0.
    const unrelated = entry(m, 0x7ff520000n, 0x9000n, "SomethingElse");
    expect(findBoxOpenLogFields(new ScanContext(m), [unrelated], boInstance)).toEqual({
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("resolves fields from a live instance with a namespace-prefixed class name", () => {
    // The instance-pointer path does not match class names; it reads the field
    // map straight from the object's class. So `vb.BoxOpenLog` works even when
    // the entries index is empty.
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const boInstance = 0x7ff510000n;
    seedClass(m, boClass, "vb.BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x20 },
      { name: "itemGradeType", offset: 0x24 },
    ]);
    seedInstance(m, boInstance, boClass);
    expect(findBoxOpenLogFields(new ScanContext(m), [], boInstance)).toEqual({
      itemStringKey: 0x20,
      itemGradeType: 0x24,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("falls back to named search when instancePtr is null", () => {
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const e = entry(m, boClass, 0x9000n, "BoxOpenLog");
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);
    // No instancePtr — must use the named-index path.
    expect(findBoxOpenLogFields(new ScanContext(m), [e], null)).toEqual({
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("fills gaps from the named index when the instance resolves only one field", () => {
    // Instance class has itemStringKey but not itemGradeType; the named index
    // has a BoxOpenLog entry with itemGradeType. The merger should combine them.
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const boInstance = 0x7ff510000n;
    seedClass(m, boClass, "BoxOpenLog");
    seedFields(m, boClass, [{ name: "itemStringKey", offset: 0x18 }]);
    seedInstance(m, boInstance, boClass);
    const indexedClass = 0x7ff520000n;
    const e = entry(m, indexedClass, 0x9000n, "BoxOpenLog");
    seedFields(m, indexedClass, [{ name: "itemGradeType", offset: 0x1c }]);
    expect(findBoxOpenLogFields(new ScanContext(m), [e], boInstance)).toEqual({
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
    });
  });

  it("identifies obfuscated fields by value when itemStringKey is a System.String pointer (v1.01.02)", () => {
    // v1.01.02 BoxOpenLog: field names are obfuscated (bfpc/bfpd/bfpe) and
    // itemStringKey is a System.String pointer (not a plain int32). The
    // scanner must:
    //   1. See that readI32 at +0x40 returns a positive but non-plausible
    //      value (the String pointer's low 32 bits, e.g. 0x57509000).
    //   2. Fall through to the pointer → String → number path.
    //   3. Extract the trailing digit run from the string as the itemKey.
    //   4. Match +0x48=0 as itemGradeType (plausible grade 0).
    const m = new FakeMemory();
    const boClass = 0x7ff500000n;
    const boInstance = 0x7ff510000n;
    seedClass(m, boClass, "BoxOpenLog");
    // Obfuscated field names — name-based lookup returns 0 for both.
    seedFields(m, boClass, [
      { name: "bfpc", offset: 0x40 },
      { name: "bfpd", offset: 0x48 },
      { name: "bfpe", offset: 0x50 },
    ]);
    seedInstance(m, boInstance, boClass);

    // +0x40: System.String pointer → "ItemName_530017"
    const strClass = 0x7ff520000n;
    const strObj = 0x7ff530000n;
    seedClass(m, strClass, "String");
    seedInstance(m, strObj, strClass);
    const str = "ItemName_530017";
    m.writeI32(strObj + 0x10n, str.length);
    m.writeBytes(strObj + 0x14n, Buffer.from(str, "utf16le"));
    m.writePtr(boInstance + 0x40n, strObj);

    // +0x48: itemGradeType = 0 (plain int32)
    m.writeI32(boInstance + 0x48n, 0);

    // +0x50: GradeSO pointer (v1.01.02 layout). Must NOT be null — null would
    // make readI32 return 0, which is a plausible grade and would compete
    // with +0x48 for bestGradeOffset. A real GradeSO pointer has negative
    // low 32 bits, so the scanner enters the pointer path and doesn't match.
    const gradeClass = 0x7ff540000n;
    const gradeObj = 0x7ff550000n;
    seedClass(m, gradeClass, "GradeSO");
    seedInstance(m, gradeObj, gradeClass);
    m.writePtr(boInstance + 0x50n, gradeObj);

    const result = findBoxOpenLogFields(new ScanContext(m), [], boInstance);
    expect(result.itemStringKey).toBe(0x40);
    expect(result.itemGradeType).toBe(0x48);
  });
});

// ── findCurrencyManager ───────────────────────────────────────────────────────

const GOLD_KEY = 100001;

/** Seed a currency-manager-shaped class; gold=null omits the gold entry. */
function seedCurrencyManager(m: FakeMemory, base: bigint, gold: bigint | null): ClassEntry {
  const wrapper = base;
  const block = seedStaticBlock(m, wrapper, base + 0x10000n);
  const list = base + 0x20000n;
  const dict = base + 0x30000n;
  const dictEntries = base + 0x40000n;
  const valueObj = base + 0x50000n;

  const e = entry(m, wrapper, base - GA_BASE, "tp");
  m.writePtr(block, list);
  m.writePtr(block + 8n, dict);
  m.writePtr(list + 0x10n, base + 0x60000n); // list internals irrelevant

  m.writePtr(dict + 0x18n, dictEntries);
  m.writeI32(dict + 0x20n, 1);
  const eBase = dictEntries + 0x20n;
  m.writeI32(eBase, 7); // hash
  if (gold != null) {
    m.writeI32(eBase + 8n, GOLD_KEY);
    m.writePtr(eBase + 16n, valueObj);
    // ObscuredLong at valueObj+0x28: hidden@+8, crypto@+16; raw = (hidden - crypto) ^ crypto
    const crypto = 0x1234n;
    const hidden = (gold ^ crypto) + crypto;
    m.writePtr(valueObj + 0x28n + 8n, hidden);
    m.writePtr(valueObj + 0x28n + 16n, crypto);
  } else {
    m.writeI32(eBase + 8n, 55555); // some other currency key
    m.writePtr(eBase + 16n, valueObj);
  }
  return e;
}

describe("findCurrencyManager", () => {
  it("accepts the class whose dict decodes a plausible gold value for goldKey", () => {
    const m = new FakeMemory();
    const e = seedCurrencyManager(m, GA_BASE + 0x1000000n, 3916784446n);
    expect(findCurrencyManager(new ScanContext(m), [e], GOLD_KEY)).toEqual({
      slotRva: 0x1000000n,
    });
  });

  it("rejects the two-pointer shape when the gold probe fails", () => {
    // Live regression: the shape alone matched 783 classes; the gold probe is the filter.
    const m = new FakeMemory();
    const e = seedCurrencyManager(m, GA_BASE + 0x1000000n, null);
    expect(findCurrencyManager(new ScanContext(m), [e], GOLD_KEY)).toBeNull();
  });

  it("rejects an implausible decoded gold value", () => {
    const m = new FakeMemory();
    const e = seedCurrencyManager(m, GA_BASE + 0x1000000n, -5n & 0xffffffffffffffffn);
    expect(findCurrencyManager(new ScanContext(m), [e], GOLD_KEY)).toBeNull();
  });

  it("picks the gold-valid candidate among shape-matching decoys", () => {
    const m = new FakeMemory();
    const decoy = seedCurrencyManager(m, GA_BASE + 0x1000000n, null);
    const real = seedCurrencyManager(m, GA_BASE + 0x2000000n, 123456n);
    const result = findCurrencyManager(new ScanContext(m), [decoy, real], GOLD_KEY);
    expect(result).toEqual({ slotRva: 0x2000000n });
  });
});

// ── findPlayerSaveData ────────────────────────────────────────────────────────

describe("findPlayerSaveData", () => {
  /** Seed pet/item element classes into the index for struct-offset lookup. */
  function seedElementClasses(m: FakeMemory): ClassEntry[] {
    const petClass = 0x7ff600000n;
    const itemClass = 0x7ff610000n;
    const pet = entry(m, petClass, 0x8100n, "PetSaveData");
    seedFields(m, petClass, [
      { name: "PetKey", offset: 0x10 },
      { name: "IsUnlock", offset: 0x14 },
    ]);
    const item = entry(m, itemClass, 0x8200n, "ItemSaveData");
    seedFields(m, itemClass, [
      { name: "ItemKey", offset: 0x10 },
      { name: "IsChaotic", offset: 0x20 },
    ]);
    return [pet, item];
  }

  it("resolves via serialization-stable field names on the holder class", () => {
    const m = new FakeMemory();
    const elements = seedElementClasses(m);

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x10n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "PlayerSaveData");
    seedFields(m, holderClass, [
      { name: "PetSaveData", offset: 0x68 },
      { name: "itemSaveDatas", offset: 0xa0 },
    ]);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).toEqual({
      commonSaveData: 0x8000n,
      playerStaticOff: 0x10,
      petSaveDatas: 0x68,
      itemSaveDatas: 0xa0,
      boxData: 0,
      // BoxData field-name absent → findBoxDataFields can't reach a BoxData
      // instance (no offset to read the pointer from), so the struct offsets
      // stay 0. chestSlots.ts falls back to the save path.
      boxTypes: 0,
      boxQuantity: 0,
      // "BoxData" field name is absent → dumpClassFields fires and surfaces the
      // holder class name + field table so the extractor log shows what the
      // field is actually called on this build.
      boxDataDiagnostics: expect.stringContaining("PlayerSaveData"),
      petKey: 0x10,
      petIsUnlock: 0x14,
      itemKey: 0x10,
      itemIsChaotic: 0x20,
    });
  });

  it("derives boxTypes/boxQuantity structurally when BoxData is named and reachable", () => {
    // Rev 13 findBoxDataFields: when the BoxData field-name match succeeds,
    // read the BoxData instance pointer and scan it for two List<int> fields
    // of equal length. This survives BoxTypes/BoxQuantity field-name
    // obfuscation (e.g. v1.00.28 where BoxData is named but its inner List<int>
    // fields are renamed). Both lists must be non-empty (count > 0) and have
    // matching _size for the parallel-arrays signature.
    const m = new FakeMemory();
    const elements = seedElementClasses(m);

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const boxDataObj = 0x7ff780000n;
    const typesList = 0x7ff781000n;
    const typesArr = 0x7ff782000n;
    const qtyList = 0x7ff783000n;
    const qtyArr = 0x7ff784000n;

    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x10n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "PlayerSaveData");
    seedFields(m, holderClass, [
      { name: "PetSaveData", offset: 0x68 },
      { name: "itemSaveDatas", offset: 0xa0 },
      { name: "BoxData", offset: 0xb8 },
    ]);
    // holder+0xb8 → boxDataObj
    m.writePtr(holder + 0xb8n, boxDataObj);
    // boxDataObj+0x18 → List<int> BoxTypes (count=3, first elem=1001)
    m.writePtr(boxDataObj + 0x18n, typesList);
    m.writePtr(typesList + 0x10n, typesArr); // _items
    m.writeI32(typesList + 0x18n, 3); // _size
    m.writeI32(typesArr + 0x20n, 1001); // first elem
    // boxDataObj+0x20 → List<int> BoxQuantity (count=3, first elem=5)
    m.writePtr(boxDataObj + 0x20n, qtyList);
    m.writePtr(qtyList + 0x10n, qtyArr);
    m.writeI32(qtyList + 0x18n, 3);
    m.writeI32(qtyArr + 0x20n, 5);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).not.toBeNull();
    expect(result!.boxData).toBe(0xb8);
    expect(result!.boxTypes).toBe(0x18);
    expect(result!.boxQuantity).toBe(0x20);
  });

  it("leaves boxTypes/boxQuantity at 0 when BoxData lists are empty (count=0)", () => {
    // When the player owns no chests, BoxData's List<int> fields have _size=0.
    // The equal-count signature doesn't match (count must be > 0), so
    // findBoxDataFields returns null. The 30s enrichment heal timer will
    // re-run the extractor once the player opens a chest and the lists
    // become non-empty.
    const m = new FakeMemory();
    const elements = seedElementClasses(m);

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const boxDataObj = 0x7ff780000n;
    const typesList = 0x7ff781000n;
    const qtyList = 0x7ff783000n;

    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x10n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "PlayerSaveData");
    seedFields(m, holderClass, [
      { name: "PetSaveData", offset: 0x68 },
      { name: "itemSaveDatas", offset: 0xa0 },
      { name: "BoxData", offset: 0xb8 },
    ]);
    m.writePtr(holder + 0xb8n, boxDataObj);
    m.writePtr(boxDataObj + 0x18n, typesList);
    m.writePtr(typesList + 0x10n, 0x7ff782000n); // _items (null would also work)
    m.writeI32(typesList + 0x18n, 0); // _size=0 — empty list
    m.writePtr(boxDataObj + 0x20n, qtyList);
    m.writePtr(qtyList + 0x10n, 0x7ff784000n);
    m.writeI32(qtyList + 0x18n, 0);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).not.toBeNull();
    expect(result!.boxData).toBe(0xb8);
    expect(result!.boxTypes).toBe(0);
    expect(result!.boxQuantity).toBe(0);
  });

  it("leaves boxDataDiagnostics undefined when the BoxData field name is present", () => {
    const m = new FakeMemory();
    const elements = seedElementClasses(m);

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x10n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "PlayerSaveData");
    seedFields(m, holderClass, [
      { name: "PetSaveData", offset: 0x68 },
      { name: "itemSaveDatas", offset: 0xa0 },
      { name: "BoxData", offset: 0xb8 },
    ]);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).not.toBeNull();
    expect(result!.boxData).toBe(0xb8);
    expect(result!.boxDataDiagnostics).toBeUndefined();
  });

  it("emits boxDataDiagnostics naming the obfuscated holder class when BoxData is renamed (v1.01.02 shape)", () => {
    // v1.01.02-style: holder class is renamed and "BoxData" is missing, but
    // PetSaveData/itemSaveDatas field names still match (so the holder is
    // detected). The dump must surface the actual holder class name + the
    // fields that ARE present, so we can pick the renamed BoxData field
    // offline.
    const m = new FakeMemory();
    const elements = seedElementClasses(m);

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x10n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "csd.PlayerSaveData");
    seedFields(m, holderClass, [
      { name: "PetSaveData", offset: 0x68 },
      { name: "itemSaveDatas", offset: 0xa0 },
      // Renamed BoxData — would appear in the dump as bfpc=0xb8 or similar.
      { name: "bfpc", offset: 0xb8 },
    ]);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).not.toBeNull();
    expect(result!.boxData).toBe(0);
    expect(result!.boxDataDiagnostics).toBeDefined();
    expect(result!.boxDataDiagnostics).toContain("csd.PlayerSaveData");
    expect(result!.boxDataDiagnostics).toContain("bfpc=0xb8");
    expect(result!.boxDataDiagnostics).not.toContain("BoxData=");
  });

  it("falls back to hunting for a List<PetSaveData> among raw instance fields", () => {
    const m = new FakeMemory();
    const elements = seedElementClasses(m);
    const petClassPtr = elements[0].classPtr;

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const list = 0x7ff740000n;
    const listArr = 0x7ff750000n;
    const petObj = 0x7ff760000n;

    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x8n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "ObfuscatedHolder");
    seedFields(m, holderClass, [{ name: "renamed", offset: 0x30 }]); // no stable names
    m.writePtr(holder + 0x30n, list);
    m.writePtr(list + 0x10n, listArr);
    m.writeI32(list + 0x18n, 1);
    m.writePtr(listArr + 0x20n, petObj);
    seedInstance(m, petObj, petClassPtr);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).not.toBeNull();
    expect(result!.commonSaveData).toBe(0x8000n);
    expect(result!.playerStaticOff).toBe(0x8);
    expect(result!.petSaveDatas).toBe(0x30);
    expect(result!.petKey).toBe(0x10);
  });

  it("falls back to List<element> discovery with namespaced class names (vb.PetSaveData)", () => {
    // v1.00.28-style obfuscation: element classes renamed `PetSaveData` → `vb.PetSaveData`.
    // findListField + namedClassField must still resolve via the short suffix.
    const m = new FakeMemory();
    const petClass = 0x7ff600000n;
    const pet = entry(m, petClass, 0x8100n, "vb.PetSaveData");
    seedFields(m, petClass, [
      { name: "PetKey", offset: 0x10 },
      { name: "IsUnlock", offset: 0x14 },
    ]);
    const itemClass = 0x7ff610000n;
    const item = entry(m, itemClass, 0x8200n, "vb.ItemSaveData");
    seedFields(m, itemClass, [
      { name: "ItemKey", offset: 0x10 },
      { name: "IsChaotic", offset: 0x20 },
    ]);
    const elements = [pet, item];

    const wrapper = 0x7ff700000n;
    const holderClass = 0x7ff710000n;
    const holder = 0x7ff720000n;
    const list = 0x7ff740000n;
    const listArr = 0x7ff750000n;
    const petObj = 0x7ff760000n;

    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block + 0x8n, holder);
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "ObfuscatedHolder");
    // No stable field names — forces findListField fallback.
    seedFields(m, holderClass, [{ name: "renamed", offset: 0x30 }]);
    m.writePtr(holder + 0x30n, list);
    m.writePtr(list + 0x10n, listArr);
    m.writeI32(list + 0x18n, 1);
    m.writePtr(listArr + 0x20n, petObj);
    seedInstance(m, petObj, petClass);

    const result = findPlayerSaveData(new ScanContext(m), [e, ...elements]);
    expect(result).not.toBeNull();
    expect(result!.petSaveDatas).toBe(0x30);
    expect(result!.petKey).toBe(0x10);
    expect(result!.petIsUnlock).toBe(0x14);
  });

  it("returns null when no static-reachable object carries save lists", () => {
    const m = new FakeMemory();
    const wrapper = 0x7ff700000n;
    const someClass = 0x7ff710000n;
    const inst = 0x7ff720000n;
    const e = entry(m, wrapper, 0x8000n, "csd");
    const block = seedStaticBlock(m, wrapper, 0x7ff730000n);
    m.writePtr(block, inst);
    seedInstance(m, inst, someClass);
    seedClass(m, someClass, "NotThePlayer");
    seedFields(m, someClass, [{ name: "unrelated", offset: 0x18 }]);

    expect(findPlayerSaveData(new ScanContext(m), [e])).toBeNull();
  });
});

// ── validateGetBoxList tolerance ──────────────────────────────────────────────

/** Build a minimal List<GetBoxLog> in FakeMemory for direct validateGetBoxList
 *  testing. Poisons all EMonsterLogType candidate offsets with an out-of-range
 *  value (99) then writes the valid value at `monsterTypeOffset`, so the test
 *  actually exercises offset probing rather than relying on FakeMemory's
 *  default 0. */
function buildFakeGetBoxLogList(opts: {
  entryClassName: string;
  monsterTypeOffset: number;
  monsterTypeValue: number;
  count: number;
  entryFields?: Array<{ name: string; offset: number }>;
}): { ctx: ScanContext; listPtr: bigint } {
  const m = new FakeMemory();
  const list = 0x7ff800000n;
  const listArr = 0x7ff810000n;
  const entryClass = 0x7ff820000n;

  m.writePtr(list + 0x10n, listArr);
  m.writeI32(list + 0x18n, opts.count);

  const POISON_OFFSETS = [0x50, 0x48, 0x58, 0x40, 0x60];
  for (let i = 0; i < opts.count; i++) {
    const logObj = 0x7ff830000n + BigInt(i * 0x100);
    m.writePtr(listArr + 0x20n + BigInt(i * 8), logObj);
    seedInstance(m, logObj, entryClass);
    // Poison all candidate offsets with 99 so only the right one validates.
    for (const off of POISON_OFFSETS) {
      m.writeI32(logObj + BigInt(off), 99);
    }
    m.writeI32(logObj + BigInt(opts.monsterTypeOffset), opts.monsterTypeValue);
  }

  seedClass(m, entryClass, opts.entryClassName);
  if (opts.entryFields) {
    seedFields(m, entryClass, opts.entryFields);
  }

  return { ctx: new ScanContext(m), listPtr: list };
}

describe("validateGetBoxList tolerance", () => {
  it("accepts a GetBoxLog entry whose EMonsterLogType is at 0x48 instead of 0x50", () => {
    // Simulate v1.01.02 shifting the EMonsterLogType field offset.
    // 0x50 is poisoned with 99, so the old hardcoded-0x50 implementation
    // would reject this; the new candidate-probing implementation should
    // find 0x48.
    const { ctx, listPtr } = buildFakeGetBoxLogList({
      entryClassName: "GetBoxLog",
      monsterTypeOffset: 0x48,
      monsterTypeValue: 1,
      count: 1,
    });
    expect(validateGetBoxList(ctx, listPtr)).toBe(true);
  });

  it("accepts a GetBoxLog entry with obfuscated class name but monsterLogType field", () => {
    // Simulate v1.01.02 renaming GetBoxLog → vb.bfne (namespace + obfuscated).
    // classNameMatches tolerates namespace prefix but NOT obfuscated short name.
    // Fallback: if the entry's class fields include "monsterLogType" (ES3-stable
    // name), accept it.
    const { ctx, listPtr } = buildFakeGetBoxLogList({
      entryClassName: "vb.bfne",
      entryFields: [
        { name: "monsterLogType", offset: 0x50 },
        { name: "stageKey", offset: 0x10 },
      ],
      monsterTypeOffset: 0x50,
      monsterTypeValue: 2,
      count: 1,
    });
    expect(validateGetBoxList(ctx, listPtr)).toBe(true);
  });

  it("rejects a list whose entries are neither GetBoxLog nor have monsterLogType field", () => {
    const { ctx, listPtr } = buildFakeGetBoxLogList({
      entryClassName: "SomeOtherClass",
      entryFields: [{ name: "unrelated", offset: 0x10 }],
      monsterTypeOffset: 0x50,
      monsterTypeValue: 1,
      count: 1,
    });
    expect(validateGetBoxList(ctx, listPtr)).toBe(false);
  });

  it("rejects a list where no candidate offset yields a valid EMonsterLogType", () => {
    // All candidate offsets poisoned with 99, no valid value written.
    const m = new FakeMemory();
    const list = 0x7ff800000n;
    const listArr = 0x7ff810000n;
    const entryClass = 0x7ff820000n;
    m.writePtr(list + 0x10n, listArr);
    m.writeI32(list + 0x18n, 1);
    const logObj = 0x7ff830000n;
    m.writePtr(listArr + 0x20n, logObj);
    seedInstance(m, logObj, entryClass);
    seedClass(m, entryClass, "GetBoxLog");
    for (const off of [0x50, 0x48, 0x58, 0x40, 0x60]) {
      m.writeI32(logObj + BigInt(off), 99);
    }
    expect(validateGetBoxList(new ScanContext(m), list)).toBe(false);
  });
});

// ── findBoxOpenLogDictDirect fallback ─────────────────────────────────────────

describe("findBoxOpenLogDictDirect fallback", () => {
  it("locates a BoxOpenLog bucket without going through GetBoxLog validation", () => {
    // Scenario: LogManager's dict has a BoxOpen bucket (key=2) whose entries
    // ARE valid BoxOpenLog instances (class name matches, itemStringKey field
    // present), but the GetBox bucket (key=3) has "SomethingElse" entries that
    // fail validateGetBoxList. findLogManager returns null, but
    // findBoxOpenLogDictDirect should still find the BoxOpen bucket and
    // resolve its field offsets.
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "SomethingElse", // GetBox bucket fails class-name + field gate
      monsterTypes: [0],
      boxOpen: { key: 2 },
    });
    // Add fields to the BoxOpenLog class that seedLogManager created
    const boClass = 0x7ff4c0000n;
    seedFields(m, boClass, [
      { name: "itemStringKey", offset: 0x18 },
      { name: "itemGradeType", offset: 0x1c },
    ]);

    // Sanity: findLogManager returns null for this layout.
    expect(findLogManager(new ScanContext(m), [e])).toBeNull();

    const result = findBoxOpenLogDictDirect(new ScanContext(m), [e]);
    expect(result).not.toBeNull();
    expect(result!.slotRva).toBe(0x7000n);
    expect(result!.logByType).toBe(0x28);
    expect(result!.boxOpenTypeKey).toBe(2);
    expect(result!.boxOpenLog.itemStringKey).toBe(0x18);
    expect(result!.boxOpenLog.itemGradeType).toBe(0x1c);
  });

  it("returns null when no dict has a valid BoxOpenLog bucket", () => {
    // Only a GetBox bucket with invalid entries; no BoxOpen bucket at all.
    const m = new FakeMemory();
    const e = seedLogManager(m, {
      entryClassName: "SomethingElse",
      monsterTypes: [0],
      // no boxOpen option → dict has only 1 entry (GetBox)
    });
    expect(findBoxOpenLogDictDirect(new ScanContext(m), [e])).toBeNull();
  });

  it("returns null when no static slot has a dict-shaped field", () => {
    const m = new FakeMemory();
    const e = entry(m, 0x7ff600000n, 0x8000n, "EmptyClass");
    seedStaticBlock(m, 0x7ff600000n, 0x7ff610000n);
    expect(findBoxOpenLogDictDirect(new ScanContext(m), [e])).toBeNull();
  });
});

// ── dumpSaveListHolders ───────────────────────────────────────────────────────

describe("dumpSaveListHolders", () => {
  /** Capture log lines into an array for assertion. */
  function captureLog(): { log: (line: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { log: (line: string) => lines.push(line), lines };
  }

  it("Pass B finds a static-reachable List<PetSaveData> and reports its holder + element class", () => {
    const m = new FakeMemory();
    // Element class: PetSaveData
    const petClass = 0x7ff600000n;
    seedClass(m, petClass, "PetSaveData");
    // A pet instance (first element of the list)
    const petObj = 0x7ff610000n;
    seedInstance(m, petObj, petClass);
    // List<PetSaveData> at holder+0x68
    const list = 0x7ff620000n;
    const listArr = 0x7ff630000n;
    seedList(m, list, listArr, 3, petObj);
    // Holder class with a static block pointing at an instance
    const holderClass = 0x7ff640000n;
    const holder = 0x7ff650000n;
    const e = entry(m, holderClass, 0x8000n, "SomeHolder");
    const block = seedStaticBlock(m, holderClass, 0x7ff660000n);
    m.writePtr(block + 0x10n, holder);
    seedInstance(m, holder, holderClass);
    // Holder's field table — doesn't matter for Pass B (structural scan),
    // but seed an empty field table so instanceClassFields returns empty.
    seedFields(m, holderClass, [{ name: "renamed", offset: 0x68 }]);
    m.writePtr(holder + 0x68n, list);

    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e], log);

    const passBLine = lines.find((l) => l.includes("Pass B — holder="));
    expect(passBLine).toBeDefined();
    expect(passBLine).toContain("SomeHolder");
    expect(passBLine).toContain("+0x68");
    expect(passBLine).toContain('element="PetSaveData"');
    expect(passBLine).toContain("count=3");
  });

  it("Pass C finds save lists moved into a CommonSaveData sub-object (v1.01.02 shape)", () => {
    // v1.01.02 scenario: CommonSaveData no longer holds PetSaveData/ItemSaveData
    // directly. Its instance references a sub-object (e.g. SaveDataHolder)
    // which holds the actual List<PetSaveData>.
    const m = new FakeMemory();

    // Element classes
    const petClass = 0x7ff600000n;
    seedClass(m, petClass, "PetSaveData");
    const itemClass = 0x7ff610000n;
    seedClass(m, itemClass, "ItemSaveData");

    // Pet + Item instances (first elements)
    const petObj = 0x7ff620000n;
    seedInstance(m, petObj, petClass);
    const itemObj = 0x7ff630000n;
    seedInstance(m, itemObj, itemClass);

    // Sub-object (SaveDataHolder) holds the lists
    const subObjClass = 0x7ff640000n;
    const subObj = 0x7ff650000n;
    seedInstance(m, subObj, subObjClass);
    seedClass(m, subObjClass, "SaveDataHolder");
    // List<PetSaveData> at subObj+0x40
    const petList = 0x7ff660000n;
    const petListArr = 0x7ff670000n;
    seedList(m, petList, petListArr, 5, petObj);
    m.writePtr(subObj + 0x40n, petList);
    // List<ItemSaveData> at subObj+0x48
    const itemList = 0x7ff680000n;
    const itemListArr = 0x7ff690000n;
    seedList(m, itemList, itemListArr, 120, itemObj);
    m.writePtr(subObj + 0x48n, itemList);

    // CommonSaveData instance — its +0x20 field points at SaveDataHolder
    const csdClass = 0x7ff6a0000n;
    const csdInst = 0x7ff6b0000n;
    seedClass(m, csdClass, "CommonSaveData");
    seedInstance(m, csdInst, csdClass);
    // CommonSaveData's own field table has NO save lists (the v1.01.02 case)
    seedFields(m, csdClass, [
      { name: "version", offset: 0x10 },
      { name: "playTime", offset: 0x18 },
    ]);
    m.writePtr(csdInst + 0x20n, subObj); // reference to sub-object

    // Static block: CommonSaveData class has a static slot pointing at the instance
    const e = entry(m, csdClass, 0x8000n, "CommonSaveData");
    const block = seedStaticBlock(m, csdClass, 0x7ff6c0000n);
    m.writePtr(block + 0x10n, csdInst);

    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e], log);

    // Pass C should have recursed into CommonSaveData and found both lists.
    // New format: `[save-list-dump] Pass C — "CommonSaveData"+0x20→SaveDataHolder(0x...) +0x40 → List<...>`
    const passCLines = lines.filter((l) => l.includes("Pass C — ") && l.includes("→ List<"));
    expect(passCLines.length).toBeGreaterThanOrEqual(2);

    const petLine = passCLines.find((l) => l.includes("PetSaveData"));
    expect(petLine).toBeDefined();
    expect(petLine).toContain("CommonSaveData");
    expect(petLine).toContain("+0x20");
    expect(petLine).toContain("SaveDataHolder");
    expect(petLine).toContain("+0x40");
    expect(petLine).toContain("count=5");

    const itemLine = passCLines.find((l) => l.includes("ItemSaveData"));
    expect(itemLine).toBeDefined();
    expect(itemLine).toContain("+0x48");
    expect(itemLine).toContain("count=120");
  });

  it("Pass A lists class names matching save-data hints", () => {
    const m = new FakeMemory();
    const e1 = entry(m, 0x7ff600000n, 0x8000n, "CommonSaveData");
    const e2 = entry(m, 0x7ff610000n, 0x8100n, "PlayerInventoryManager");
    const e3 = entry(m, 0x7ff620000n, 0x8200n, "TotallyUnrelated");

    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e1, e2, e3], log);

    const passAHeader = lines.find((l) => l.includes("Pass A — name-probe hits:"));
    expect(passAHeader).toBeDefined();
    // e3 "TotallyUnrelated" should NOT appear in the name probe hits
    const nameLine = lines.find((l) => l.includes("CommonSaveData | PlayerInventoryManager"));
    expect(nameLine).toBeDefined();
    const unrelatedLine = lines.find((l) => l.includes("TotallyUnrelated"));
    expect(unrelatedLine).toBeUndefined();
  });

  it("scanListAt skips null head elements and reports the first non-null element's class (HeroSaveData with 16 entries)", () => {
    // v1.01.02 case: List<HeroSaveData> with count=16, but the first 3
    // entries are null (heroes removed/locked). scanListAt must scan past
    // nulls and find the first non-null HeroSaveData element.
    const m = new FakeMemory();
    const heroClass = 0x7ff600000n;
    seedClass(m, heroClass, "HeroSaveData");
    const heroObj = 0x7ff620000n;
    seedInstance(m, heroObj, heroClass);

    const list = 0x7ff630000n;
    const listArr = 0x7ff640000n;
    // _size = 16, but first 3 slots are null. seedList writes firstElemPtr
    // at arrayFirst+0; overwrite it and the next two slots with null, then
    // put heroObj at index 3.
    seedList(m, list, listArr, 16, 0n);
    const arrFirst = listArr + BigInt(STRUCT_CONTAINER.arrayFirst);
    m.writePtr(arrFirst + 0n * 8n, 0n);
    m.writePtr(arrFirst + 1n * 8n, 0n);
    m.writePtr(arrFirst + 2n * 8n, 0n);
    m.writePtr(arrFirst + 3n * 8n, heroObj);

    // Holder has the list at +0x68
    const holderClass = 0x7ff650000n;
    const holder = 0x7ff660000n;
    seedInstance(m, holder, holderClass);
    seedClass(m, holderClass, "SomeHolder");
    const e = entry(m, holderClass, 0x8000n, "SomeHolder");
    const block = seedStaticBlock(m, holderClass, 0x7ff670000n);
    m.writePtr(block + 0x10n, holder);
    m.writePtr(holder + 0x68n, list);

    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e], log);

    const passBLine = lines.find((l) => l.includes("Pass B — holder="));
    expect(passBLine).toBeDefined();
    expect(passBLine).toContain('element="HeroSaveData"');
    expect(passBLine).toContain("count=16");
  });

  it("Pass C reports class@<ptr> label when sub-object's class name is unreadable", () => {
    // Sub-object has a valid class pointer but the class's name field is
    // unreadable (e.g. unmapped region). Pass C should still report the
    // List with a class@0x... label.
    const m = new FakeMemory();
    const petClass = 0x7ff600000n;
    seedClass(m, petClass, "PetSaveData");
    const petObj = 0x7ff620000n;
    seedInstance(m, petObj, petClass);

    // Sub-object with unreadable class name — write a class pointer but
    // don't seed the class's name field.
    const subObjClass = 0x7ff640000n;
    const subObj = 0x7ff650000n;
    seedInstance(m, subObj, subObjClass); // inst → subObjClass, but no seedClass
    const petList = 0x7ff660000n;
    const petListArr = 0x7ff670000n;
    seedList(m, petList, petListArr, 5, petObj);
    m.writePtr(subObj + 0x40n, petList);

    const csdClass = 0x7ff6a0000n;
    seedClass(m, csdClass, "CommonSaveData");
    const csdInst = 0x7ff6b0000n;
    const block = seedStaticBlock(m, csdClass, 0x7ff6c0000n);
    m.writePtr(block + 0x10n, csdInst);
    seedInstance(m, csdInst, csdClass);
    m.writePtr(csdInst + 0x20n, subObj);

    const e = entry(m, csdClass, 0x8000n, "CommonSaveData");
    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e], log);

    const passCLine = lines.find((l) => l.includes("Pass C — ") && l.includes("PetSaveData"));
    expect(passCLine).toBeDefined();
    expect(passCLine).toContain("class@0x");
  });

  it("Pass C dumps raw items hex when all List elements are null (value-type or emptied List)", () => {
    // List<int> or List with all-null head elements: scanListAt can't find
    // a plausible element pointer, so elemClass is null. The log must
    // include `raw=[...]` showing the first 8 qwords so we can distinguish
    // all-zero (emptied) from small-int (value-type) from struct data.
    const m = new FakeMemory();
    const subObjClass = 0x7ff640000n;
    const subObj = 0x7ff650000n;
    seedInstance(m, subObj, subObjClass);
    seedClass(m, subObjClass, "SaveDataHolder");

    // List with count=16, all elements are small integers (value-type
    // List<int>-like: each slot holds an int32 like 1,2,3... packed in a
    // qword). scanListAt won't find any plausible heap pointer.
    const list = 0x7ff660000n;
    const listArr = 0x7ff670000n;
    seedList(m, list, listArr, 16, 0n);
    const arrFirst = listArr + BigInt(STRUCT_CONTAINER.arrayFirst);
    // Write small-integer values (value-type List<int> pattern)
    m.writePtr(arrFirst + 0n * 8n, 1n);
    m.writePtr(arrFirst + 1n * 8n, 2n);
    m.writePtr(arrFirst + 2n * 8n, 3n);
    m.writePtr(arrFirst + 3n * 8n, 0n);
    m.writePtr(subObj + 0x80n, list);

    const csdClass = 0x7ff6a0000n;
    seedClass(m, csdClass, "CommonSaveData");
    const csdInst = 0x7ff6b0000n;
    const block = seedStaticBlock(m, csdClass, 0x7ff6c0000n);
    m.writePtr(block + 0x10n, csdInst);
    seedInstance(m, csdInst, csdClass);
    m.writePtr(csdInst + 0x20n, subObj);

    const e = entry(m, csdClass, 0x8000n, "CommonSaveData");
    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e], log);

    const passCLine = lines.find((l) => l.includes("Pass C — ") && l.includes("count=16"));
    expect(passCLine).toBeDefined();
    expect(passCLine).toContain('element="null"');
    expect(passCLine).toContain("raw=[");
    // raw should contain the small-integer values we wrote
    expect(passCLine).toContain("0x1");
    expect(passCLine).toContain("0x2");
    expect(passCLine).toContain("0x3");
  });

  it("Pass C finds CommonSaveData instance via header-block scan when static_fields is null (v1.01.02 shape)", () => {
    // v1.01.02: CommonSaveData's static_fields block (+0xb0) is null, so
    // staticSlots() returns empty. The instance lives at a non-standard
    // header offset — findInstanceViaHeaderScan must scan the class header's
    // ptr-like values as block candidates and find the instance.
    const m = new FakeMemory();

    // Element class
    const petClass = 0x7ff600000n;
    seedClass(m, petClass, "PetSaveData");
    const petObj = 0x7ff620000n;
    seedInstance(m, petObj, petClass);

    // Sub-object that holds the List<PetSaveData>
    const subObjClass = 0x7ff640000n;
    const subObj = 0x7ff650000n;
    seedInstance(m, subObj, subObjClass);
    seedClass(m, subObjClass, "SaveDataHolder");
    const petList = 0x7ff660000n;
    const petListArr = 0x7ff670000n;
    seedList(m, petList, petListArr, 7, petObj);
    m.writePtr(subObj + 0x40n, petList);

    // CommonSaveData class — static_fields (+0xb0) left as 0 (no seedStaticBlock)
    const csdClass = 0x7ff6a0000n;
    seedClass(m, csdClass, "CommonSaveData");
    // Put a block pointer at header+0x40 (the offset probeClassLayout found
    // on v1.01.02). The block itself holds the instance at +0x90.
    const blockPtr = 0x7ff6c0000n;
    m.writePtr(csdClass + 0x40n, blockPtr);
    const csdInst = 0x7ff6b0000n;
    m.writePtr(blockPtr + 0x90n, csdInst);
    seedInstance(m, csdInst, csdClass); // inst header → classPtr
    // CommonSaveData instance references sub-object at +0x20
    m.writePtr(csdInst + 0x20n, subObj);

    const e = entry(m, csdClass, 0x8000n, "CommonSaveData");

    const { log, lines } = captureLog();
    dumpSaveListHolders(new ScanContext(m), [e], log);

    // Pass C should have found the instance via header-block scan (not via
    // staticSlots, which returns empty for this class).
    const passCHeader = lines.find((l) => l.includes('Pass C — recursing into "CommonSaveData"'));
    expect(passCHeader).toBeDefined();
    expect(passCHeader).toContain(`0x${csdInst.toString(16)}`);

    const petLine = lines.find((l) => l.includes("PetSaveData"));
    expect(petLine).toBeDefined();
    expect(petLine).toContain("CommonSaveData");
    expect(petLine).toContain("+0x20");
    expect(petLine).toContain("SaveDataHolder");
    expect(petLine).toContain("+0x40");
    expect(petLine).toContain("count=7");
  });
});
