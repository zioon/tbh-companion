// Pure completeness validation + merge for LiveOffsets tables.
// Drives the self-healing resolver: a table missing any WANTED field triggers
// runtime extraction, and derived values are merged into the base table.
// No node / electron imports — unit-testable.

import type { LiveOffsets } from "./offsets";

interface FieldCheck {
  /** Dotted path, e.g. "typeInfoRva.logManager" — used for diagnostics + tests. */
  path: string;
  get: (o: LiveOffsets) => number | bigint;
}

/**
 * Fields the live reader cannot function without. A zero here means core stats
 * (stage, heroes) are unavailable → the reader degrades to save-only.
 * These are never legitimately zero when correctly derived.
 *
 * `typeInfoRva.currencyManager` is intentionally excluded (same reasoning as
 * `commonSaveData` below): on v1.00.28 the runtime save-data / currency-manager
 * class structure was restructured and the gold probe no longer matches, so the
 * extractor can never derive it. Listing it here would keep the reader
 * permanently unsupported on v1.00.28 even though stage/hero/heroList anchors
 * succeed. Live gold degrades to the save-snapshot path (5s latency) when
 * currencyManager=0; other live stats (XP, stage wave, chest drops, DPS) flow
 * normally.
 */
const CRITICAL_FIELDS: readonly FieldCheck[] = [
  { path: "typeInfoRva.stageCacheManager", get: (o) => o.typeInfoRva.stageCacheManager },
  { path: "typeInfoRva.stageManager", get: (o) => o.typeInfoRva.stageManager },
  { path: "runtime.heroList", get: (o) => o.runtime.heroList },
];

/**
 * Enrichment fields — live chest drops, pets, inventory. A zero here disables
 * that one feature (the reader still works), but we still want them all mapped,
 * so their absence triggers the extractor. None are legitimately zero.
 *
 * `typeInfoRva.commonSaveData` is intentionally excluded: it has no static root
 * reachable on v1.00.23/28 (per offsets.ts comment "not derivable by structural
 * anchor"), so the extractor can never fill it. Listing it here would keep
 * `enrichmentComplete` permanently false and cause the 30s fallback heal timer
 * (worker.ts `HEAL_ENRICHMENT_FALLBACK_MS`) to re-run the extractor every 30s
 * forever — each run ~6s of CPU for zero benefit. pets/inventory gracefully
 * degrade to the save-snapshot path when commonSaveData=0; the per-version base
 * offsets for petSaveDatas/itemSaveDatas/petSaveData.* /inventoryItem.* are
 * still checked here so we notice if those struct offsets go missing.
 */
const ENRICHMENT_FIELDS: readonly FieldCheck[] = [
  { path: "typeInfoRva.logManager", get: (o) => o.typeInfoRva.logManager },
  { path: "typeInfoRva.monsterSpawnManager", get: (o) => o.typeInfoRva.monsterSpawnManager },
  { path: "player.petSaveDatas", get: (o) => o.player.petSaveDatas },
  { path: "player.itemSaveDatas", get: (o) => o.player.itemSaveDatas },
  { path: "petSaveData.petKey", get: (o) => o.petSaveData.petKey },
  { path: "petSaveData.isUnlock", get: (o) => o.petSaveData.isUnlock },
  { path: "inventoryItem.itemKey", get: (o) => o.inventoryItem.itemKey },
  { path: "inventoryItem.isChaotic", get: (o) => o.inventoryItem.isChaotic },
  { path: "runtime.log.stageClearTypeKey", get: (o) => o.runtime.log.stageClearTypeKey },
  {
    path: "runtime.log.getItemWithBoxOpenTypeKey",
    get: (o) => o.runtime.log.getItemWithBoxOpenTypeKey,
  },
  { path: "runtime.stageClearLog.clearTimeSec", get: (o) => o.runtime.stageClearLog.clearTimeSec },
  { path: "runtime.stageClearLog.act", get: (o) => o.runtime.stageClearLog.act },
  { path: "runtime.stageClearLog.stage", get: (o) => o.runtime.stageClearLog.stage },
  // BoxOpenLog struct fields — class-metadata-derived (real ES3 field names).
  // boxType/level are intentionally excluded: obfuscated field names mean the
  // extractor can never derive them, so listing them would perpetually mark the
  // table incomplete and trigger fruitless re-extraction.
  // gradeSO/gradeSOGrade are also excluded: they are v1.00.28-specific (grade
  // moved to a GradeSO ScriptableObject reference). Pre-1.00.28 versions never
  // populate them, so listing them would perpetually block those versions. The
  // runtime reader falls back to itemGradeType then to the catalog grade when
  // gradeSO is 0, so completeness is driven by itemStringKey/itemGradeType.
  {
    path: "runtime.boxOpenLog.itemStringKey",
    get: (o) => o.runtime.boxOpenLog?.itemStringKey ?? 0,
  },
  {
    path: "runtime.boxOpenLog.itemGradeType",
    get: (o) => o.runtime.boxOpenLog?.itemGradeType ?? 0,
  },
];

const ALL_FIELDS: readonly FieldCheck[] = [...CRITICAL_FIELDS, ...ENRICHMENT_FIELDS];

function isPresent(v: number | bigint): boolean {
  return typeof v === "bigint" ? v !== 0n : v !== 0;
}

export type CompletenessLevel = "critical" | "full";

/**
 * List the dotted paths of required fields that are still zero/undefined.
 * `level` "critical" checks only the reader-blocking fields; "full" (default)
 * checks every wanted field.
 */
export function missingOffsetFields(o: LiveOffsets, level: CompletenessLevel = "full"): string[] {
  const fields = level === "critical" ? CRITICAL_FIELDS : ALL_FIELDS;
  return fields.filter((f) => !isPresent(f.get(o))).map((f) => f.path);
}

/** True when every reader-blocking (critical) field is present. Gates `supported`. */
export function hasCriticalOffsets(o: LiveOffsets): boolean {
  return missingOffsetFields(o, "critical").length === 0;
}

/** True when every wanted field is present. When false, the extractor should run. */
export function isOffsetTableComplete(o: LiveOffsets): boolean {
  return missingOffsetFields(o, "full").length === 0;
}

function pickN(base: number, derived: number): number {
  return base !== 0 ? base : derived;
}
function pickB(base: bigint, derived: bigint): bigint {
  return base !== 0n ? base : derived;
}

/**
 * Fill the base table's missing (zero) fields from the derived table, keeping
 * every already-present base value. Structural constants stay from `base`.
 * Same-version merge: base values are trusted; the extractor only fills gaps.
 */
export function mergeOffsets(base: LiveOffsets, derived: LiveOffsets): LiveOffsets {
  return {
    ...base,
    typeInfoRva: {
      ...base.typeInfoRva,
      commonSaveData: pickB(base.typeInfoRva.commonSaveData, derived.typeInfoRva.commonSaveData),
      currencyManager: pickB(base.typeInfoRva.currencyManager, derived.typeInfoRva.currencyManager),
      stageCacheManager: pickB(
        base.typeInfoRva.stageCacheManager,
        derived.typeInfoRva.stageCacheManager,
      ),
      stageManager: pickB(base.typeInfoRva.stageManager, derived.typeInfoRva.stageManager),
      logManager: pickB(base.typeInfoRva.logManager, derived.typeInfoRva.logManager),
      monsterSpawnManager: pickB(
        base.typeInfoRva.monsterSpawnManager,
        derived.typeInfoRva.monsterSpawnManager,
      ),
    },
    player: {
      ...base.player,
      petSaveDatas: pickN(base.player.petSaveDatas, derived.player.petSaveDatas),
      itemSaveDatas: pickN(base.player.itemSaveDatas, derived.player.itemSaveDatas),
    },
    petSaveData: {
      petKey: pickN(base.petSaveData.petKey, derived.petSaveData.petKey),
      isUnlock: pickN(base.petSaveData.isUnlock, derived.petSaveData.isUnlock),
    },
    inventoryItem: {
      itemKey: pickN(base.inventoryItem.itemKey, derived.inventoryItem.itemKey),
      isChaotic: pickN(base.inventoryItem.isChaotic, derived.inventoryItem.isChaotic),
    },
    runtime: {
      ...base.runtime,
      heroList: pickN(base.runtime.heroList, derived.runtime.heroList),
      log: {
        ...base.runtime.log,
        logByType: pickN(base.runtime.log.logByType, derived.runtime.log.logByType),
        getBoxTypeKey: pickN(base.runtime.log.getBoxTypeKey, derived.runtime.log.getBoxTypeKey),
        stageClearTypeKey: pickN(
          base.runtime.log.stageClearTypeKey,
          derived.runtime.log.stageClearTypeKey,
        ),
        getItemWithBoxOpenTypeKey: pickN(
          base.runtime.log.getItemWithBoxOpenTypeKey ?? 0,
          derived.runtime.log.getItemWithBoxOpenTypeKey,
        ),
      },
      getBoxLog: {
        ...base.runtime.getBoxLog,
        monsterType: pickN(
          base.runtime.getBoxLog.monsterType,
          derived.runtime.getBoxLog.monsterType,
        ),
      },
      boxOpenLog: {
        ...base.runtime.boxOpenLog,
        itemStringKey: pickN(
          base.runtime.boxOpenLog?.itemStringKey ?? 0,
          derived.runtime.boxOpenLog.itemStringKey,
        ),
        itemGradeType: pickN(
          base.runtime.boxOpenLog?.itemGradeType ?? 0,
          derived.runtime.boxOpenLog.itemGradeType,
        ),
        gradeSO: pickN(base.runtime.boxOpenLog?.gradeSO ?? 0, derived.runtime.boxOpenLog.gradeSO),
        gradeSOGrade: pickN(
          base.runtime.boxOpenLog?.gradeSOGrade ?? 0,
          derived.runtime.boxOpenLog.gradeSOGrade,
        ),
      },
      stageClearLog: {
        ...base.runtime.stageClearLog,
        act: pickN(base.runtime.stageClearLog.act, derived.runtime.stageClearLog.act),
        stage: pickN(base.runtime.stageClearLog.stage, derived.runtime.stageClearLog.stage),
        clearTimeSec: pickN(
          base.runtime.stageClearLog.clearTimeSec,
          derived.runtime.stageClearLog.clearTimeSec,
        ),
      },
      monster: {
        monsterList: pickN(
          base.runtime.monster?.monsterList ?? 0,
          derived.runtime.monster.monsterList,
        ),
        summonedList: pickN(
          base.runtime.monster?.summonedList ?? 0,
          derived.runtime.monster.summonedList,
        ),
        deadMonsterList: pickN(
          base.runtime.monster?.deadMonsterList ?? 0,
          derived.runtime.monster.deadMonsterList,
        ),
        monsterHealth: pickN(
          base.runtime.monster?.monsterHealth ?? 0,
          derived.runtime.monster.monsterHealth,
        ),
        hpCurrent: pickN(base.runtime.monster?.hpCurrent ?? 0, derived.runtime.monster.hpCurrent),
        hpMax: pickN(base.runtime.monster?.hpMax ?? 0, derived.runtime.monster.hpMax),
      },
    },
  };
}
