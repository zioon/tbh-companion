import { describe, it, expect } from "vitest";
import {
  missingOffsetFields,
  hasCriticalOffsets,
  isOffsetTableComplete,
  mergeOffsets,
} from "../../src/core/liveMemory/offsetCompleteness";
import { offsetsForVersion, type LiveOffsets } from "../../src/core/liveMemory/offsets";

const BASE = offsetsForVersion("1.00.21")!; // complete-critical, missing logManager RVA

function withLogManager(o: LiveOffsets, rva: bigint): LiveOffsets {
  return { ...o, typeInfoRva: { ...o.typeInfoRva, logManager: rva } };
}

function withMonsterFields(o: LiveOffsets): LiveOffsets {
  return {
    ...o,
    typeInfoRva: { ...o.typeInfoRva, monsterSpawnManager: 0x5e50000n },
    runtime: {
      ...o.runtime,
      monster: { ...o.runtime.monster, monsterList: 0x20, deadMonsterList: 0x30 },
    },
  };
}

function withAllEnrichment(o: LiveOffsets): LiveOffsets {
  const withLM = withMonsterFields(withLogManager(o, 0x5e40000n));
  return {
    ...withLM,
    runtime: {
      ...withLM.runtime,
      log: { ...withLM.runtime.log, getItemWithBoxOpenTypeKey: 42 },
      boxOpenLog: {
        itemStringKey: 0x18,
        itemGradeType: 0x1c,
        gradeSO: 0,
        gradeSOGrade: 0,
        boxType: 0,
        level: 0,
      },
    },
  };
}

describe("missingOffsetFields", () => {
  it("reports logManager and monsterSpawnManager as gaps in the bundled v1.00.21 table", () => {
    expect(missingOffsetFields(BASE, "full")).toEqual([
      "typeInfoRva.logManager",
      "typeInfoRva.monsterSpawnManager",
      "runtime.log.getItemWithBoxOpenTypeKey",
      "runtime.boxOpenLog.itemStringKey",
      "runtime.boxOpenLog.itemGradeType",
    ]);
  });

  it("reports no gaps at the critical level for the bundled table", () => {
    expect(missingOffsetFields(BASE, "critical")).toEqual([]);
  });

  it("reports a zeroed critical field", () => {
    const broken = { ...BASE, typeInfoRva: { ...BASE.typeInfoRva, stageManager: 0n } };
    expect(missingOffsetFields(broken, "critical")).toContain("typeInfoRva.stageManager");
  });

  it("reports every wanted enrichment gap when they are all zero", () => {
    const stripped: LiveOffsets = {
      ...BASE,
      typeInfoRva: { ...BASE.typeInfoRva, logManager: 0n, commonSaveData: 0n },
      player: { ...BASE.player, petSaveDatas: 0, itemSaveDatas: 0 },
      petSaveData: { petKey: 0, isUnlock: 0 },
      inventoryItem: { itemKey: 0, isChaotic: 0 },
      runtime: {
        ...BASE.runtime,
        log: { ...BASE.runtime.log, stageClearTypeKey: 0 },
        stageClearLog: { act: 0, stage: 0, clearTimeSec: 0 },
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
    expect(missingOffsetFields(stripped, "full").sort()).toEqual(
      [
        "inventoryItem.isChaotic",
        "inventoryItem.itemKey",
        "petSaveData.isUnlock",
        "petSaveData.petKey",
        "player.itemSaveDatas",
        "player.petSaveDatas",
        "runtime.boxOpenLog.itemGradeType",
        "runtime.boxOpenLog.itemStringKey",
        "runtime.log.getItemWithBoxOpenTypeKey",
        "runtime.log.stageClearTypeKey",
        "runtime.stageClearLog.act",
        "runtime.stageClearLog.clearTimeSec",
        "runtime.stageClearLog.stage",
        "typeInfoRva.logManager",
        "typeInfoRva.monsterSpawnManager",
      ].sort(),
    );
  });

  it("treats commonSaveData as non-blocking (not derivable on v1.00.23/28, degrades gracefully)", () => {
    const noCsd = { ...BASE, typeInfoRva: { ...BASE.typeInfoRva, commonSaveData: 0n } };
    expect(missingOffsetFields(noCsd, "critical")).toEqual([]);
    // commonSaveData is intentionally excluded from ENRICHMENT_FIELDS — see
    // offsetCompleteness.ts comment. A zero commonSaveData must NOT keep the
    // table incomplete (otherwise the 30s fallback heal timer re-runs forever).
    expect(missingOffsetFields(noCsd, "full")).not.toContain("typeInfoRva.commonSaveData");
  });

  it("treats currencyManager as non-blocking (v1.00.28 gold probe fails; live gold degrades to save)", () => {
    const noCm = { ...BASE, typeInfoRva: { ...BASE.typeInfoRva, currencyManager: 0n } };
    // currencyManager is intentionally excluded from CRITICAL_FIELDS — v1.00.28
    // restructured the currency-manager class so the gold probe can't derive it.
    // Other live stats (XP, stage, heroes) must still flow.
    expect(missingOffsetFields(noCm, "critical")).toEqual([]);
    // Same exclusion from ENRICHMENT_FIELDS as commonSaveData — otherwise the
    // 30s fallback heal timer would re-run the extractor forever on v1.00.28.
    expect(missingOffsetFields(noCm, "full")).not.toContain("typeInfoRva.currencyManager");
    expect(hasCriticalOffsets(noCm)).toBe(true);
  });
});

describe("hasCriticalOffsets / isOffsetTableComplete", () => {
  it("bundled table has critical offsets but is not fully complete", () => {
    expect(hasCriticalOffsets(BASE)).toBe(true);
    expect(isOffsetTableComplete(BASE)).toBe(false);
  });

  it("filling all enrichment fields makes the table complete", () => {
    const complete = withAllEnrichment(BASE);
    expect(isOffsetTableComplete(complete)).toBe(true);
  });

  it("a zeroed critical field fails hasCriticalOffsets", () => {
    const broken = { ...BASE, runtime: { ...BASE.runtime, heroList: 0 } };
    expect(hasCriticalOffsets(broken)).toBe(false);
  });
});

describe("mergeOffsets", () => {
  it("fills a missing base field from the derived table", () => {
    const derived = withAllEnrichment(BASE);
    const merged = mergeOffsets(BASE, derived);
    expect(merged.typeInfoRva.logManager).toBe(0x5e40000n);
    expect(merged.typeInfoRva.monsterSpawnManager).toBe(0x5e50000n);
    expect(isOffsetTableComplete(merged)).toBe(true);
  });

  it("keeps the base value when both are present (fills only gaps)", () => {
    const derived: LiveOffsets = {
      ...BASE,
      runtime: { ...BASE.runtime, heroList: 0x999 },
      typeInfoRva: { ...BASE.typeInfoRva, logManager: 0x5e40000n },
    };
    const merged = mergeOffsets(BASE, derived);
    expect(merged.runtime.heroList).toBe(BASE.runtime.heroList); // base wins
    expect(merged.typeInfoRva.logManager).toBe(0x5e40000n); // gap filled
  });

  it("fills zeroed pet/inventory struct offsets from the derived table", () => {
    const stripped: LiveOffsets = {
      ...BASE,
      petSaveData: { petKey: 0, isUnlock: 0 },
      inventoryItem: { itemKey: 0, isChaotic: 0 },
      player: { ...BASE.player, petSaveDatas: 0, itemSaveDatas: 0 },
    };
    const derived = withLogManager(BASE, 0x5e40000n);
    const merged = mergeOffsets(stripped, derived);
    expect(merged.petSaveData.petKey).toBe(BASE.petSaveData.petKey);
    expect(merged.inventoryItem.itemKey).toBe(BASE.inventoryItem.itemKey);
    expect(merged.player.itemSaveDatas).toBe(BASE.player.itemSaveDatas);
  });

  it("fills zeroed stage-clear log offsets from the derived table", () => {
    const stripped: LiveOffsets = {
      ...BASE,
      runtime: {
        ...BASE.runtime,
        log: { ...BASE.runtime.log, stageClearTypeKey: 0 },
        stageClearLog: { act: 0, stage: 0, clearTimeSec: 0 },
      },
    };
    const derived = withAllEnrichment(BASE);
    const merged = mergeOffsets(stripped, derived);
    expect(merged.runtime.log.stageClearTypeKey).toBe(BASE.runtime.log.stageClearTypeKey);
    expect(merged.runtime.stageClearLog.act).toBe(BASE.runtime.stageClearLog.act);
    expect(merged.runtime.stageClearLog.stage).toBe(BASE.runtime.stageClearLog.stage);
    expect(merged.runtime.stageClearLog.clearTimeSec).toBe(BASE.runtime.stageClearLog.clearTimeSec);
    expect(isOffsetTableComplete(merged)).toBe(true);
  });

  // ── Fallback merge semantics ────────────────────────────────────────────
  // When base is a same-major.minor fallback (e.g. v1.01.02 → v1.01.01),
  // the extractor is forced onto the critical path to re-derive fresh RVAs.
  // Derived values MUST win over the stale fallback baseline, otherwise the
  // merged table keeps the wrong RVAs and live reads return null data —
  // the symptom reported as "实时数据都是回退" on v1.01.02.
  describe("fallback table merge (derived wins over stale baseline)", () => {
    const FALLBACK_STAGE_MGR = 0x5dd8878n; // v1.01.01's stageManager RVA
    const DERIVED_STAGE_MGR = 0x5dd9999n; // freshly re-derived for v1.01.02
    const DERIVED_HERO_LIST = 0x40; // hypothetical shift in v1.01.02

    function makeFallbackBase(): LiveOffsets {
      // Simulate the table returned by offsetsForVersionMeta("1.01.02"):
      // v1.01.01's structure with gameVersion overwritten and the fallback
      // provenance marker set.
      return {
        ...offsetsForVersion("1.01.01")!,
        gameVersion: "1.01.02",
        _fallbackFromVersion: "1.01.01",
      };
    }

    function makeDerived(): LiveOffsets {
      // Extractor succeeded: derived has fresh v1.01.02 RVAs for the critical
      // anchors (stageManager, stageCacheManager). Other fields are 0 (not
      // derived) — those should keep the fallback baseline.
      const fb = makeFallbackBase();
      return {
        ...fb,
        _fallbackFromVersion: undefined,
        typeInfoRva: {
          ...fb.typeInfoRva,
          stageManager: DERIVED_STAGE_MGR,
          stageCacheManager: 0x5ddaaaan,
          // logManager / monsterSpawnManager left as 0 (extractor couldn't derive)
          logManager: 0n,
          monsterSpawnManager: 0n,
        },
        runtime: {
          ...fb.runtime,
          heroList: DERIVED_HERO_LIST,
        },
      };
    }

    it("derived RVAs win over stale fallback RVAs when base is a fallback table", () => {
      const base = makeFallbackBase();
      const derived = makeDerived();
      // Sanity: base has the fallback RVA, derived has the fresh one.
      expect(base.typeInfoRva.stageManager).toBe(FALLBACK_STAGE_MGR);
      expect(derived.typeInfoRva.stageManager).toBe(DERIVED_STAGE_MGR);

      const merged = mergeOffsets(base, derived);

      // Derived wins for critical RVAs.
      expect(merged.typeInfoRva.stageManager).toBe(DERIVED_STAGE_MGR);
      expect(merged.typeInfoRva.stageCacheManager).toBe(0x5ddaaaan);
      // heroList (runtime field) also derived-wins.
      expect(merged.runtime.heroList).toBe(DERIVED_HERO_LIST);
    });

    it("derived zero values keep the fallback baseline (graceful degrade)", () => {
      const base = makeFallbackBase();
      const derived = makeDerived();
      // logManager/monsterSpawnManager are 0 in derived — fallback baseline
      // must be preserved so the reader still has a working RVA to try.
      expect(derived.typeInfoRva.logManager).toBe(0n);
      expect(derived.typeInfoRva.monsterSpawnManager).toBe(0n);

      const merged = mergeOffsets(base, derived);

      expect(merged.typeInfoRva.logManager).toBe(base.typeInfoRva.logManager);
      expect(merged.typeInfoRva.monsterSpawnManager).toBe(base.typeInfoRva.monsterSpawnManager);
    });

    it("non-fallback base still uses base-wins semantics (regression guard)", () => {
      // Same version (no _fallbackFromVersion) — base wins, derived fills gaps.
      // This is the original behavior; the fallback fix must not regress it.
      const base = BASE; // offsetsForVersion("1.00.21") — no fallback marker
      const derived: LiveOffsets = {
        ...BASE,
        runtime: { ...BASE.runtime, heroList: 0x999 }, // DIFFERENT from base
        typeInfoRva: { ...BASE.typeInfoRva, logManager: 0x5e40000n },
      };
      const merged = mergeOffsets(base, derived);
      // base wins (not a fallback table)
      expect(merged.runtime.heroList).toBe(BASE.runtime.heroList);
      // gap filled
      expect(merged.typeInfoRva.logManager).toBe(0x5e40000n);
    });
  });
});
