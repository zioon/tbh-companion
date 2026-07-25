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
});
