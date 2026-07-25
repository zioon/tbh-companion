// Pure, version-keyed IL2CPP offset tables for the live memory reader.
// No node / electron / koffi imports — keep this unit-testable.
//
// Derivation method and validation: see _research/live-memory/ (not committed).
// Offsets anchor on REAL class/field names that survive per-build name
// randomization; they must be re-derived per game version.
//
// SHARED SCHEMA (locked, Phase 1): `LiveOffsets` is the single offset-table
// shape used by BOTH the bundled tables here AND the runtime self-healing
// extractor (Phase 3). The extractor must emit exactly this shape — do not let
// the two drift. See STATE.md [D24].

export interface LiveOffsets {
  gameVersion: string;
  /**
   * Extractor revision that produced this table. Used by the disk-cache loader
   * to invalidate caches from older extractor revisions (so a new revision that
   * fixes a derivation bug actually re-runs instead of loading stale offsets).
   * Absent on bundled tables and pre-Rev 11 caches (treated as 0 → always
   * re-derive when a new revision ships).
   */
  _extractorRev?: number;
  /** ScriptMetadata TypeInfo RVA whose slot holds `Il2CppClass*`. */
  typeInfoRva: {
    /** TaskbarHero.CommonSaveData — save-layer anchor for hero/party discovery. */
    commonSaveData: bigint;
    /** Runtime currency-manager static class (obfuscated name; re-found structurally in Phase 3). */
    currencyManager: bigint;
    /** Runtime stage-cache-manager static class. */
    stageCacheManager: bigint;
    /** `np<StageManager>` — battle singleton for the live wave counter. */
    stageManager: bigint;
    /** LocalInventoryManager — real-named class; derive TypeInfo RVA per game version. */
    localInventoryManager: bigint;
    /** `np<LogManager>` — battle-log singleton; source of live chest-drop entries. */
    logManager: bigint;
    /** MonsterSpawnManager — runtime monster list singleton. */
    monsterSpawnManager: bigint;
  };
  player: {
    commonSaveData: number;
    currency: number;
    heroSaveDatas: number;
    petSaveDatas: number;
    /** PlayerSaveData.itemSaveDatas — List<ItemSaveData> (live bag via save snapshot). */
    itemSaveDatas: number;
    /**
     * PlayerSaveData.aggregateSaveDatas — List<AggregateSaveData>.
     * Used by combat gold reader (GoldEarn[SubKey=1]). 0 = known fallback to wallet balance.
     */
    aggregates: number;
    /**
     * PlayerSaveData.BoxData — BoxData instance field offset. Holds the runtime
     * equivalent of the save `BoxData` struct (BoxTypes[] + BoxQuantity[]).
     * 0 = not derived; reader falls back to save path for slot quantities.
     */
    boxData: number;
  };
  /**
   * BoxData struct field offsets. BoxData is held by PlayerSaveData and contains
   * two parallel int arrays: BoxTypes (chest type IDs) and BoxQuantity (per-type
   * counts). Used by readRuntimeChestSlots for live slot-quantity reading.
   */
  boxData: {
    /** BoxData.BoxTypes — List<int> field offset. 0 = not derived. */
    boxTypes: number;
    /** BoxData.BoxQuantity — List<int> field offset. 0 = not derived. */
    boxQuantity: number;
  };
  common: {
    playTime: number;
    arrangedHeroKey: number;
    maxCompletedStage: number;
    currentStageKey: number;
    currentStageWave: number;
  };
  /** Save-layer HeroSaveData struct offsets (ES3 heap path) — NOT the runtime Hero object. */
  hero: { heroKey: number; level: number; unlock: number; exp: number; equipped: number };
  /** Runtime Hero (a `Unit`) reached from `StageManager.HeroList`. */
  unit: { cache: number };
  /**
   * Runtime hero progression wrapper (`Unit.cache` → HeroRuntime). Level/exp are
   * ACTk Obscured values stored as (hiddenValue, currentCryptoKey) pairs.
   */
  heroRuntime: {
    info: number;
    levelHidden: number;
    levelKey: number;
    expHidden: number;
    expKey: number;
  };
  /** Runtime hero identity block (`HeroRuntime.info` → HeroInfoData). */
  heroInfoData: { heroKey: number };
  /** Save-layer CurrencySaveData — lags the UI; not used for live gold display. */
  currency: { key: number; quantity: number };
  /** PetSaveData struct field offsets (save-layer heap path via CommonSaveData). */
  petSaveData: { petKey: number; isUnlock: number };
  /** ItemSaveData struct field offsets (live bag via PlayerSaveData.itemSaveDatas snapshot). */
  inventoryItem: { itemKey: number; isChaotic: number };
  /** Runtime IL2CPP field offsets (live tick paths). */
  runtime: {
    currency: {
      list: number;
      dict: number;
      entryInfoData: number;
      entryObscuredQty: number;
    };
    stage: {
      currentCache: number;
      cacheInfoData: number;
      stageKey: number;
      waveAmount: number;
      runtimeWave: number;
    };
    currencyInfoKey: number;
    /** StageManager.HeroList field offset (real field name; stable across patches). */
    heroList: number;
    /**
     * Live chest-drop log path. LogManager keeps a `Dictionary<ELogType, List<LogData>>`;
     * the GetBox bucket holds `GetBoxLog` entries whose EMonsterLogType field classifies
     * the drop (0 common, 1 stage boss; 2 act boss is ignored by the companion). Field
     * names are obfuscated but the struct offsets are stable across patches.
     */
    log: {
      /** LogManager.<logByType> — Dictionary<ELogType, List<LogData>>. */
      logByType: number;
      /** ELogType.GetBox dictionary key. */
      getBoxTypeKey: number;
      /** ELogType.StageClear dictionary key. */
      stageClearTypeKey: number;
      /** ELogType.GetItemWithBoxOpen dictionary key (box-open log). 0 = not derived for this version. */
      getItemWithBoxOpenTypeKey: number;
    };
    /** GetBoxLog struct offsets (obfuscated field names, stable offsets). */
    getBoxLog: {
      /** EMonsterLogType: 0 = common, 1 = stage boss (2 = act boss, not tracked). */
      monsterType: number;
    };
    /** BoxOpenLog struct offsets (obfuscated field names, stable offsets). 0 = not derived. */
    boxOpenLog: {
      /** Produced item key (int) or string-key pointer; resolved at read time. */
      itemStringKey: number;
      /**
       * ItemGradeType enum value (plain int field on v1.00.21/23/27).
       * On v1.00.28 this field is 0 — the actual grade moved to a GradeSO
       * ScriptableObject reference (see `gradeSO`), which must be dereferenced
       * and read at `gradeSOGrade` inside it.
       */
      itemGradeType: number;
      /**
       * Offset to the GradeSO* reference inside BoxOpenLog (v1.00.28 only).
       * The pointed-at GradeSO has an `eGRADE` int field at `gradeSOGrade`.
       * 0 = not derived; the reader falls back to `itemGradeType` then to the
       * catalog grade.
       */
      gradeSO: number;
      /** Offset of the `eGRADE` int field inside the GradeSO object. 0 = not derived. */
      gradeSOGrade: number;
      /** Source box type (0=common, 1=rare, 2=act); 0 = not available in struct. */
      boxType: number;
      /** Source box level; 0 = not available in struct. */
      level: number;
    };
    /**
     * StageClearLog struct offset (real class name, dump.cs-confirmed; obfuscated
     * private field). Live-verified against a real clear on v1.00.23: a run's
     * `+0x40 act, +0x44 stage, +0x48 clearTimeSec (int), +0x4c isBoss` layout.
     *
     * `act` and `stage` carry the **cleared** stage's act/stage (the log entry
     * is appended on clear, before StageManager advances to the next stage).
     * The log entry does NOT carry difficulty — callers must combine act/stage
     * with the difficulty digit of the current live/save stageKey to form a
     * full stageKey (`difficulty*1000 + act*100 + stage`). This is the fix for
     * the off-by-one stage attribution bug where a clear of 3-1 was recorded
     * as 3-2 because `snap.stageKey` had already advanced by the time the
     * reader polled the next tick.
     */
    stageClearLog: {
      /** Cleared stage's act (1-digit, from StageClearLog+0x40). */
      act: number;
      /** Cleared stage's stage (1-99, from StageClearLog+0x44). */
      stage: number;
      /** Clear time in whole seconds, as recorded by the game itself. */
      clearTimeSec: number;
    };
    /**
     * Monster tracking offsets. These are derived from MonsterSpawnManager fields.
     * All set to 0 by default; filled in by the dynamic extractor or bundled tables.
     * monsterList: offset to List<Monster> of alive monsters
     * summonedList: offset to List<Monster> of summoned monsters
     * deadMonsterList: offset to List<dead monster> of killed monsters
     * monsterHealth: offset within Monster to UnitHealthController
     * hpCurrent: offset of current HP within UnitHealthController
     * hpMax: offset of max HP within UnitHealthController
     */
    monster: {
      monsterList: number;
      summonedList: number;
      deadMonsterList: number;
      monsterHealth: number;
      hpCurrent: number;
      hpMax: number;
    };
  };
  /** Standard IL2CPP container / dictionary layout. */
  container: { objectHeader: number; listItems: number; listSize: number; arrayFirst: number };
  dict: {
    entries: number;
    count: number;
    entrySize: number;
    entryHash: number;
    /** Inline int32 key (`Dictionary<int, T>` — not boxed). */
    entryKey: number;
    entryValue: number;
  };
  il2cppClass: { staticFieldsOffsets: readonly number[] };
  goldKey: number;
}

const RUNTIME_V1_00_21 = {
  currency: { list: 0x0, dict: 0x8, entryInfoData: 0x10, entryObscuredQty: 0x28 },
  stage: {
    currentCache: 0x88,
    cacheInfoData: 0x10,
    stageKey: 0x30,
    waveAmount: 0x54,
    runtimeWave: 0x138,
  },
  currencyInfoKey: 0x30,
  heroList: 0x30, // StageManager.HeroList — real field name, stable across patches
  log: {
    logByType: 0x28, // LogManager Dictionary<ELogType, List<LogData>>
    getBoxTypeKey: 3, // ELogType.GetBox
    stageClearTypeKey: 1, // ELogType.StageClear
    getItemWithBoxOpenTypeKey: 0, // ELogType.GetItemWithBoxOpen — not yet derived for v1.00.21/23/27
  },
  getBoxLog: {
    monsterType: 0x50, // GetBoxLog EMonsterLogType (0 common, 1 stage boss, 2 act boss)
  },
  boxOpenLog: {
    itemStringKey: 0, // not yet derived — reader returns null when 0
    itemGradeType: 0,
    gradeSO: 0,
    gradeSOGrade: 0,
    boxType: 0,
    level: 0,
  },
  stageClearLog: {
    act: 0x40, // StageClearLog.act — live-verified on v1.00.23 (see phase-4-stage-times/design.md)
    stage: 0x44, // StageClearLog.stage
    clearTimeSec: 0x48, // StageClearLog.clearTimeSec
  },
  monster: {
    monsterList: 0x28,
    summonedList: 0x38,
    deadMonsterList: 0x30,
    monsterHealth: 0xb0,
    hpCurrent: 0x40,
    hpMax: 0x4c,
  },
} as const;

const CONTAINER = { objectHeader: 0x10, listItems: 0x10, listSize: 0x18, arrayFirst: 0x20 };
const DICT = {
  entries: 0x18,
  count: 0x20,
  entrySize: 24,
  entryHash: 0,
  entryKey: 8,
  entryValue: 16,
};
const IL2CPP_CLASS = { staticFieldsOffsets: [0xb0, 0xb8, 0xa8] as const };

const V1_00_23: LiveOffsets = {
  gameVersion: "1.00.23",
  typeInfoRva: {
    // Il2CppDumper script.json — vb.tp / vb.uu replaced uz.tm / uz.us; singletons use nq<T>.
    commonSaveData: 0x5de0d08n,
    currencyManager: 0x5db9758n, // vb.tp static List<vb.tq> + Dictionary<int, vb.tq>
    stageCacheManager: 0x5dba2f8n, // vb.uu static StageCache at +0x88
    stageManager: 0x5e30318n, // nq<StageManager>
    localInventoryManager: 0n,
    logManager: 0x5e2fb58n, // nq<LogManager>
    monsterSpawnManager: 0n,
  },
  player: {
    commonSaveData: 0x10,
    currency: 0x48,
    heroSaveDatas: 0x50,
    petSaveDatas: 0x70, // PlayerSaveData.PetSaveData (was 0x68 in v1.00.21)
    itemSaveDatas: 0xa8, // PlayerSaveData.itemSaveDatas (was 0xa0 in v1.00.21)
    aggregates: 0xb8, // PlayerSaveData.aggregateSaveDatas (GoldEarn combat gold fallback)
    boxData: 0, // PlayerSaveData.BoxData — derived at runtime via findPlayerSaveData
  },
  boxData: {
    boxTypes: 0, // BoxData.BoxTypes — derived at runtime
    boxQuantity: 0, // BoxData.BoxQuantity — derived at runtime
  },
  common: {
    playTime: 0x20,
    arrangedHeroKey: 0x48,
    maxCompletedStage: 0x54,
    currentStageKey: 0x58,
    currentStageWave: 0x5c,
  },
  hero: { heroKey: 0x10, level: 0x14, unlock: 0x18, exp: 0x1c, equipped: 0x28 },
  unit: { cache: 0x3a8 },
  heroRuntime: {
    info: 0x30,
    levelHidden: 0xd0,
    levelKey: 0xd4,
    // v1.00.27 WIDENED exp ObscuredFloat→ObscuredDouble: hidden now @+0x8 (long), key @+0x10 (long)
    expHidden: 0x118, // ObscuredDouble hiddenValue @+0x8 from record 0x110 (was 0x110 for ObscuredFloat)
    expKey: 0x120, // ObscuredDouble currentCryptoKey @+0x10 from record 0x110 (was 0x114 for ObscuredFloat)
  },
  heroInfoData: { heroKey: 0x30 },
  currency: { key: 0x10, quantity: 0x18 },
  petSaveData: { petKey: 0x10, isUnlock: 0x14 },
  inventoryItem: { itemKey: 0x10, isChaotic: 0x20 },
  runtime: RUNTIME_V1_00_21,
  container: CONTAINER,
  dict: DICT,
  il2cppClass: IL2CPP_CLASS,
  goldKey: 100001,
};

const V1_00_21: LiveOffsets = {
  gameVersion: "1.00.21",
  typeInfoRva: {
    commonSaveData: 0x5df05f8n,
    currencyManager: 0x5dc8db8n, // uz.tm
    stageCacheManager: 0x5dc9958n, // uz.us
    stageManager: 0x5e3ff98n, // np<StageManager>
    localInventoryManager: 0n, // unused since inventory reads via PlayerSaveData.itemSaveDatas
    logManager: 0n, // SPEC_DEVIATION: TypeInfo RVA derived at runtime by the extractor
    monsterSpawnManager: 0n,
  },
  player: {
    commonSaveData: 0x10,
    currency: 0x48,
    heroSaveDatas: 0x50,
    petSaveDatas: 0x68, // PlayerSaveData.PetSaveData (List<PetSaveData>)
    itemSaveDatas: 0xa0, // PlayerSaveData.itemSaveDatas (List<ItemSaveData>)
    aggregates: 0xb0, // PlayerSaveData.aggregateSaveDatas (GoldEarn combat gold fallback)
    boxData: 0, // PlayerSaveData.BoxData — derived at runtime via findPlayerSaveData
  },
  boxData: {
    boxTypes: 0, // BoxData.BoxTypes — derived at runtime
    boxQuantity: 0, // BoxData.BoxQuantity — derived at runtime
  },
  common: {
    playTime: 0x20,
    arrangedHeroKey: 0x48,
    maxCompletedStage: 0x54,
    currentStageKey: 0x58,
    currentStageWave: 0x5c,
  },
  hero: { heroKey: 0x10, level: 0x14, unlock: 0x18, exp: 0x1c, equipped: 0x28 },
  unit: { cache: 0x3a8 }, // Unit.cache → HeroRuntime (stable real field)
  heroRuntime: {
    info: 0x30, // → HeroInfoData
    levelHidden: 0xd0, // ObscuredInt level: hiddenValue
    levelKey: 0xd4, //    currentCryptoKey
    expHidden: 0x110, // ObscuredFloat xp: hiddenValue (4-byte, pre-1.00.27 format)
    expKey: 0x114, //    currentCryptoKey
  },
  heroInfoData: { heroKey: 0x30 },
  currency: { key: 0x10, quantity: 0x18 },
  petSaveData: {
    petKey: 0x10, // PetSaveData.PetKey
    isUnlock: 0x14, // PetSaveData.IsUnlock
  },
  inventoryItem: {
    itemKey: 0x10, // ItemSaveData.ItemKey
    isChaotic: 0x20, // ItemSaveData.IsChaotic
  },
  runtime: RUNTIME_V1_00_21,
  container: CONTAINER,
  dict: DICT,
  il2cppClass: IL2CPP_CLASS,
  goldKey: 100001,
};

const V1_00_27: LiveOffsets = {
  gameVersion: "1.00.27",
  typeInfoRva: {
    commonSaveData: 0n, // not derivable by structural anchor (enrichment—degrades gracefully)
    currencyManager: 0x5dd2f08n, // extractor-confirmed
    stageCacheManager: 0x5dd3aa8n, // extractor-confirmed, currentCache=0x88
    stageManager: 0x5dd1058n, // extractor-confirmed, heroList=0x30
    localInventoryManager: 0n,
    logManager: 0x5dced78n, // extractor-confirmed
    monsterSpawnManager: 0x5db2e70n, // extractor-confirmed
  },
  player: {
    commonSaveData: 0x10,
    currency: 0x48,
    heroSaveDatas: 0x50,
    petSaveDatas: 0x70, // PlayerSaveData.PetSaveData (same layout as v1.00.23)
    itemSaveDatas: 0xa8, // PlayerSaveData.itemSaveDatas
    aggregates: 0xb8, // PlayerSaveData.aggregateSaveDatas (GoldEarn combat gold fallback)
    boxData: 0, // PlayerSaveData.BoxData — derived at runtime via findPlayerSaveData
  },
  boxData: {
    boxTypes: 0, // BoxData.BoxTypes — derived at runtime
    boxQuantity: 0, // BoxData.BoxQuantity — derived at runtime
  },
  common: {
    playTime: 0x20,
    arrangedHeroKey: 0x48,
    maxCompletedStage: 0x54,
    currentStageKey: 0x58,
    currentStageWave: 0x5c,
  },
  hero: { heroKey: 0x10, level: 0x14, unlock: 0x18, exp: 0x1c, equipped: 0x28 },
  unit: { cache: 0x3b0 }, // Unit.cache (v1.00.27: +0x08 from v1.00.23)
  heroRuntime: {
    info: 0x30,
    levelHidden: 0xd0,
    levelKey: 0xd4,
    // v1.00.27: exp WIDENED ObscuredFloat→ObscuredDouble
    expHidden: 0x118, // ObscuredDouble hiddenValue @+0x8 from record 0x110 (long, ru64)
    expKey: 0x120, // ObscuredDouble currentCryptoKey @+0x10 from record 0x110 (long, ru64)
  },
  heroInfoData: { heroKey: 0x30 },
  currency: { key: 0x10, quantity: 0x18 },
  petSaveData: { petKey: 0x10, isUnlock: 0x14 },
  inventoryItem: { itemKey: 0x10, isChaotic: 0x20 },
  runtime: RUNTIME_V1_00_21,
  container: CONTAINER,
  dict: DICT,
  il2cppClass: IL2CPP_CLASS,
  goldKey: 100001,
};

// v1.00.28 — derived from a successful runtime extraction (extractor Rev 8)
// captured on a working machine and frozen as the bundled table. The runtime
// extractor's currencyManager gold probe regressed on some v1.00.28 builds
// (class restructuring broke the shape match), so without this bundled table
// fresh installs degrade to "unsupported" until a lucky extraction succeeds
// and writes a disk cache. Fields verified live: stageManager / stageCacheManager
// RVAs match a fresh VM extraction; currencyManager / logManager / monsterSpawnManager
// RVAs come from a prior successful extraction on the dev machine.
//
// Known gaps (0): commonSaveData (not static-reachable; pets/inventory/chest-slots
// degrade to save-snapshot path), boxData.boxTypes/boxQuantity (obfuscated field
// names — runtime chest slots unsupported on v1.00.28), boxOpenLog.boxType/level
// (obfuscated field names).
//
// unit.cache and heroRuntime.* follow the v1.00.27+ layout (ObscuredDouble for
// exp). v1.00.28 inherited the same widened exp fields as v1.00.27.
const V1_00_28: LiveOffsets = {
  gameVersion: "1.00.28",
  typeInfoRva: {
    commonSaveData: 0n, // not derivable (save restructure) — pets/inventory degrade to save
    currencyManager: 0x5db6210n,
    stageCacheManager: 0x5db6db0n,
    stageManager: 0x5db4458n,
    localInventoryManager: 0n,
    logManager: 0x5db2178n,
    monsterSpawnManager: 0x732658n,
  },
  player: {
    commonSaveData: 0x10,
    currency: 0x48,
    heroSaveDatas: 0x50,
    petSaveDatas: 0x70,
    itemSaveDatas: 0xa8,
    aggregates: 0xb8,
    boxData: 0, // not derived — runtime chest slots unsupported on v1.00.28
  },
  boxData: {
    boxTypes: 0,
    boxQuantity: 0,
  },
  common: {
    playTime: 0x20,
    arrangedHeroKey: 0x48,
    maxCompletedStage: 0x54,
    currentStageKey: 0x58,
    currentStageWave: 0x5c,
  },
  hero: { heroKey: 0x10, level: 0x14, unlock: 0x18, exp: 0x1c, equipped: 0x28 },
  unit: { cache: 0x3b0 }, // v1.00.27+ layout (+0x08 from v1.00.21)
  heroRuntime: {
    info: 0x30,
    levelHidden: 0xd0,
    levelKey: 0xd4,
    // v1.00.28 widened exp to ObscuredDouble like v1.00.27
    expHidden: 0x118, // ObscuredDouble hiddenValue (ru64)
    expKey: 0x120, // ObscuredDouble currentCryptoKey (ru64)
  },
  heroInfoData: { heroKey: 0x30 },
  currency: { key: 0x10, quantity: 0x18 },
  petSaveData: { petKey: 0x10, isUnlock: 0x14 },
  inventoryItem: { itemKey: 0x10, isChaotic: 0x20 },
  runtime: {
    currency: { list: 0x0, dict: 0x8, entryInfoData: 0x10, entryObscuredQty: 0x28 },
    stage: {
      currentCache: 0x88,
      cacheInfoData: 0x10,
      stageKey: 0x30,
      waveAmount: 0x54,
      runtimeWave: 0x138,
    },
    currencyInfoKey: 0x30,
    heroList: 0x30,
    log: {
      logByType: 0x28,
      getBoxTypeKey: 3,
      stageClearTypeKey: 1,
      getItemWithBoxOpenTypeKey: 2,
    },
    getBoxLog: {
      monsterType: 0x50,
    },
    boxOpenLog: {
      itemStringKey: 0x40, // v1.00.28: System.String pointer (localization key)
      itemGradeType: 0x48, // preserved (non-obfuscated) — also accessible via gradeSO
      gradeSO: 0x50, // v1.00.28: GradeSO* reference
      gradeSOGrade: 0x10, // GradeSO.eGRADE int field
      boxType: 0, // obfuscated field name — not derivable
      level: 0, // obfuscated field name — not derivable
    },
    stageClearLog: {
      act: 0x40,
      stage: 0x44,
      clearTimeSec: 0x48,
    },
    monster: {
      monsterList: 0,
      summonedList: 0,
      deadMonsterList: 0,
      monsterHealth: 0,
      hpCurrent: 0,
      hpMax: 0,
    },
  },
  container: CONTAINER,
  dict: DICT,
  il2cppClass: IL2CPP_CLASS,
  goldKey: 100001,
};

// v1.01.01 — inherits the v1.00.27+ struct layout (ObscuredDouble exp, unit.cache=0x3b0).
// TypeInfo RVAs extracted from a live run; struct offsets match v1.00.28.
const V1_01_01: LiveOffsets = {
  gameVersion: "1.01.01",
  typeInfoRva: {
    commonSaveData: 0n, // not derivable — pets/inventory degrade to save
    currencyManager: 0n, // gold probe regressed on v1.00.28+; live gold falls back to save
    stageCacheManager: 0x5ddb3c0n,
    stageManager: 0x5dd8878n,
    localInventoryManager: 0n,
    logManager: 0x5dd65a0n,
    monsterSpawnManager: 0x5dba4e8n,
  },
  player: {
    commonSaveData: 0x10,
    currency: 0x48,
    heroSaveDatas: 0x50,
    petSaveDatas: 0x70,
    itemSaveDatas: 0xa8,
    aggregates: 0xb8,
    boxData: 0,
  },
  boxData: {
    boxTypes: 0,
    boxQuantity: 0,
  },
  common: {
    playTime: 0x20,
    arrangedHeroKey: 0x48,
    maxCompletedStage: 0x54,
    currentStageKey: 0x58,
    currentStageWave: 0x5c,
  },
  hero: { heroKey: 0x10, level: 0x14, unlock: 0x18, exp: 0x1c, equipped: 0x28 },
  unit: { cache: 0x3b0 },
  heroRuntime: {
    info: 0x30,
    levelHidden: 0xd0,
    levelKey: 0xd4,
    expHidden: 0x118,
    expKey: 0x120,
  },
  heroInfoData: { heroKey: 0x30 },
  currency: { key: 0x10, quantity: 0x18 },
  petSaveData: { petKey: 0x10, isUnlock: 0x14 },
  inventoryItem: { itemKey: 0x10, isChaotic: 0x20 },
  runtime: {
    currency: { list: 0x0, dict: 0x8, entryInfoData: 0x10, entryObscuredQty: 0x28 },
    stage: {
      currentCache: 0x88,
      cacheInfoData: 0x10,
      stageKey: 0x30,
      waveAmount: 0x54,
      runtimeWave: 0x138,
    },
    currencyInfoKey: 0x30,
    heroList: 0x30,
    log: {
      logByType: 0x28,
      getBoxTypeKey: 3,
      stageClearTypeKey: 1,
      getItemWithBoxOpenTypeKey: 2,
    },
    getBoxLog: {
      monsterType: 0x50,
    },
    boxOpenLog: {
      itemStringKey: 0,
      itemGradeType: 0,
      gradeSO: 0,
      gradeSOGrade: 0,
      boxType: 0,
      level: 0,
    },
    stageClearLog: {
      act: 0x40,
      stage: 0x44,
      clearTimeSec: 0x48,
    },
    monster: {
      monsterList: 0,
      summonedList: 0,
      deadMonsterList: 0,
      monsterHealth: 0,
      hpCurrent: 0,
      hpMax: 0,
    },
  },
  container: CONTAINER,
  dict: DICT,
  il2cppClass: IL2CPP_CLASS,
  goldKey: 100001,
};

const TABLE: Record<string, LiveOffsets> = {
  "1.00.21": V1_00_21,
  "1.00.23": V1_00_23,
  "1.00.27": V1_00_27,
  "1.00.28": V1_00_28,
  "1.01.01": V1_01_01,
};

/** Parse a "MAJOR.MINOR.PATCH" version string into a numeric tuple. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Returns the offset table for a detected game version, or null (degraded mode).
 *
 * Exact match first. When no exact match exists, falls back to the nearest
 * known version sharing the same major.minor components — minor game patches
 * typically inherit the memory layout from the prior version, and the runtime
 * extractor + plausibility filters catch any offsets that actually changed.
 * The returned table's `gameVersion` is set to the requested version string
 * so the extractor and disk-cache key by the real version.
 */
export function offsetsForVersion(version: string | null | undefined): LiveOffsets | null {
  if (!version) return null;
  const exact = TABLE[version];
  if (exact) return exact;

  const parsed = parseVersion(version);
  if (!parsed) return null;

  let bestVersion: string | null = null;
  let bestDiff = Infinity;
  for (const known of Object.keys(TABLE)) {
    const pk = parseVersion(known);
    if (!pk) continue;
    // Only fall back within the same major.minor (e.g. 1.00.29 → 1.00.28).
    if (pk[0] !== parsed[0] || pk[1] !== parsed[1]) continue;
    const diff = Math.abs(pk[2] - parsed[2]);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestVersion = known;
    }
  }

  if (bestVersion) {
    return { ...TABLE[bestVersion], gameVersion: version };
  }
  return null;
}

/**
 * Like {@link offsetsForVersion} but also reports whether the result came from a
 * same-major.minor fallback. Callers that need to decide whether to trust
 * bundled RVAs (which drift across game patches even within the same minor)
 * use this to force a full extractor run instead of enrichment-only mode.
 *
 * Returns `{ table, fallback: false }` on exact match, `{ table, fallback: true }`
 * on fallback, or `null` when no same-major.minor candidate exists.
 */
export function offsetsForVersionMeta(
  version: string | null | undefined,
): { table: LiveOffsets; fallback: boolean } | null {
  if (!version) return null;
  const exact = TABLE[version];
  if (exact) return { table: exact, fallback: false };

  const parsed = parseVersion(version);
  if (!parsed) return null;

  let bestVersion: string | null = null;
  let bestDiff = Infinity;
  for (const known of Object.keys(TABLE)) {
    const pk = parseVersion(known);
    if (!pk) continue;
    if (pk[0] !== parsed[0] || pk[1] !== parsed[1]) continue;
    const diff = Math.abs(pk[2] - parsed[2]);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestVersion = known;
    }
  }
  if (bestVersion) {
    return { table: { ...TABLE[bestVersion], gameVersion: version }, fallback: true };
  }
  return null;
}

export function supportedVersions(): string[] {
  return Object.keys(TABLE);
}

// --- pure plausibility helpers (used by the reader + tests) ---

export function plausiblePlayTime(v: number | null): boolean {
  return v != null && v > 100 && v < 1e9;
}

export function plausibleStage(v: number | null): boolean {
  return v != null && v > 0 && v < 1_000_000;
}

export function plausibleGold(v: number | null): boolean {
  return v != null && v >= 0 && v < 1e15;
}

export function plausibleWave(v: number | null): boolean {
  // 0 is a legitimate state: "not in any wave" — game-internal
  // StageManager.runtimeWave is 0 before the first wave and resets to 0 on
  // challenge failure. Treating 0 as implausible caused the mini overlay's
  // wave counter to stick at the pre-failure value (liveFrame.stageWave was
  // null'd here, so stats.ts fell back to the stale save snapshot).
  return v != null && v >= 0 && v < 1000;
}
