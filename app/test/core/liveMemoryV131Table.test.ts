// Regression tests for the v1.3.1 live-memory fix.
//
// Context (all verified live against a running game v1.3.1 on 2026-10-26):
// the game updated to v1.3.1 and three live-memory features regressed — live
// gold fell back to the save snapshot, live hero XP fell back to the save, and
// DPS showed no usable data. Two independent causes:
//
//  1. There was NO bundled table for 1.3.x. offsetsForVersionMeta only falls
//     back within the SAME major.minor, so the extractor ran with base = null
//     and emitted currencyManager = 0 (→ live gold null) plus the stale
//     v1.00.27-era hero layout (→ every hero filtered out → heroes: null).
//  2. The poisoned disk cache kept WINNING the cache-vs-bundled comparison,
//     because the completeness metric cannot see currencyManager /
//     commonSaveData / runtime.monster.* — so the fix had no effect until the
//     cache-precedence rule was added.
import { describe, it, expect } from "vitest";
import {
  bundledOverrideDetails,
  bundledOverrideReasons,
  bundledOverridesCache,
  missingOffsetFields,
} from "../../src/core/liveMemory/offsetCompleteness";
import {
  offsetsForVersion,
  offsetsForVersionMeta,
  supportedVersions,
  type LiveOffsets,
} from "../../src/core/liveMemory/offsets";

describe("bundled V1_3_1 offset table", () => {
  it("is registered as an EXACT match (not a same-major.minor fallback)", () => {
    expect(supportedVersions()).toContain("1.3.1");
    const meta = offsetsForVersionMeta("1.3.1");
    expect(meta).not.toBeNull();
    // An exact match is what makes the cache-precedence rule apply.
    expect(meta!.fallback).toBe(false);
  });

  it("carries the live-verified v1.3.1 offsets", () => {
    const o = offsetsForVersion("1.3.1")!;
    // TypeInfo RVAs — re-derived for 1.3.1 (the 1.3.0 values drifted ~+0x1180).
    expect(o.typeInfoRva.currencyManager).toBe(0x615c840n);
    expect(o.typeInfoRva.stageCacheManager).toBe(0x615d978n);
    expect(o.typeInfoRva.stageManager).toBe(0x6121f98n);
    expect(o.typeInfoRva.logManager).toBe(0x6150e48n);
    expect(o.typeInfoRva.monsterSpawnManager).toBe(0x6121ca8n);
    // Hero struct layout — live-verified against the save snapshot: the heroKey
    // chain heroPtr+0x3d8 → +0x30 → +0x30 yields the deployed party 401/301/201.
    expect(o.unit.cache).toBe(0x3d8);
    expect(o.heroRuntime.info).toBe(0x30);
    expect(o.heroRuntime.levelHidden).toBe(0xd0);
    expect(o.heroRuntime.levelKey).toBe(0xd4);
    expect(o.heroRuntime.expHidden).toBe(0x118);
    expect(o.heroRuntime.expKey).toBe(0x120);
    expect(o.heroInfoData.heroKey).toBe(0x30);
    expect(o.runtime.heroList).toBe(0x68);
    // Monster layout — verified live against 21 live monsters.
    expect(o.runtime.monster.monsterList).toBe(0x28);
    expect(o.runtime.monster.summonedList).toBe(0x30);
    expect(o.runtime.monster.deadMonsterList).toBe(0);
    expect(o.runtime.monster.monsterHealth).toBe(0xb0);
    expect(o.runtime.monster.hpCurrent).toBe(0x40);
    expect(o.runtime.monster.hpMax).toBe(0x50);
  });

  it("pins the known BoxData gap that no version can derive", () => {
    // The ES3 byte-stream save layer makes BoxData non-derivable at runtime,
    // so these stay 0 (chest slots keep using the save-snapshot path).
    const o = offsetsForVersion("1.3.1")!;
    expect(o.player.boxData).toBe(0);
    expect(o.boxData.boxTypes).toBe(0);
    expect(o.boxData.boxQuantity).toBe(0);
  });
});

describe("bundled table overrides a poisoned disk cache", () => {
  const V131 = offsetsForVersion("1.3.1")!;

  it("overrides a cache that LOST currencyManager (the v1.3.1 poison)", () => {
    const poisoned: LiveOffsets = {
      ...V131,
      typeInfoRva: { ...V131.typeInfoRva, currencyManager: 0n },
    };
    expect(bundledOverridesCache(V131, poisoned)).toBe(true);
    const reasons = bundledOverrideReasons(V131, poisoned);
    expect(reasons).toContain("typeInfoRva.currencyManager");
    // The reason is classified as LOST (the cache holds 0), not merely stale.
    const detail = bundledOverrideDetails(V131, poisoned).find(
      (d) => d.path === "typeInfoRva.currencyManager",
    );
    expect(detail?.lost).toBe(true);
  });

  it("overrides a cache holding a STALE non-zero hero layout", () => {
    // The v1.3.1 failure mode was NOT a zeroed field: the extractor, running
    // with base = null, emitted the stale v1.00.27-era layout (unit.cache
    // 0x3b0 instead of 0x3d8) — non-zero, invisible to every zero-check, and
    // still reading the wrong memory.
    const stale: LiveOffsets = { ...V131, unit: { ...V131.unit, cache: 0x3b0 } };
    expect(bundledOverridesCache(V131, stale)).toBe(true);
    expect(bundledOverrideReasons(V131, stale)).toContain("unit.cache");
    const detail = bundledOverrideDetails(V131, stale).find((d) => d.path === "unit.cache");
    expect(detail?.lost).toBe(false);
  });

  it("does NOT override a cache that agrees with the bundled table", () => {
    expect(bundledOverridesCache(V131, V131)).toBe(false);
    expect(bundledOverrideReasons(V131, V131)).toEqual([]);
  });

  it("does NOT override with a bundled value of 0 (0 means 'not derivable')", () => {
    const bundled: LiveOffsets = {
      ...V131,
      typeInfoRva: { ...V131.typeInfoRva, currencyManager: 0n },
    };
    const cached: LiveOffsets = {
      ...V131,
      typeInfoRva: { ...V131.typeInfoRva, currencyManager: 0x615c840n },
    };
    // The bundled table has nothing to say about this field → it must not win.
    expect(bundledOverridesCache(bundled, cached)).toBe(false);
  });

  it("does NOT override a STRICTLY MORE COMPLETE cache that merely differs", () => {
    // A cache that re-derived values the bundled table lacks (e.g. logManager)
    // is strictly more complete and must keep winning — the bundled table must
    // not be allowed to undo that.
    const bundled = offsetsForVersion("1.00.21")!;
    const richerCache: LiveOffsets = {
      ...bundled,
      typeInfoRva: { ...bundled.typeInfoRva, logManager: 0x5e40000n },
      runtime: {
        ...bundled.runtime,
        monster: { ...bundled.runtime.monster, monsterList: 0x20 },
      },
    };
    // The cache differs (monsterList) but is more complete than the bundled
    // table (which is missing logManager) → the cache wins.
    expect(missingOffsetFields(richerCache).length).toBeLessThan(
      missingOffsetFields(bundled).length,
    );
    expect(bundledOverridesCache(bundled, richerCache)).toBe(false);
  });
});
