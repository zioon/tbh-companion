// Runtime IL2CPP offset derivation for unknown game versions.
// Runs in the utilityProcess worker only. Impure: uses WinProcess for memory reads.
// On failure at any critical anchor, returns null (degraded mode — never wrong reads).
//
// The heavy lifting is pure and lives in core/liveMemory/il2cppScanner: bulk
// chunked region scan → class index → structural anchor detectors (validated
// live on v1.00.23, where per-build obfuscation had renamed StageManager,
// StageCacheManager, PlayerSaveData and every singleton wrapper).

import {
  collectClassEntries,
  collectLogManagerDiagnostics,
  dumpCatalogCandidates,
  dumpSaveListHolders,
  findBoxOpenLogDictDirect,
  findBoxOpenLogFields,
  findCurrencyManager,
  findCurrencyManagerStatic,
  findLogManager,
  findMonsterSpawnManager,
  findPlayerSaveData,
  findStageCacheManager,
  findStageCacheManagerStatic,
  findStageManager,
  ScanContext,
  STATIC_FIELDS_CANDIDATES,
  STRUCT_CONTAINER,
  STRUCT_DICT,
  type ScanRegion,
} from "../../core/liveMemory/il2cppScanner";
import type { LiveOffsets } from "../../core/liveMemory/offsets";
import type { WinProcess } from "./winProcess";

/**
 * Bump when the derivation strategy improves. Reopens the per-(game version,
 * app build) extraction-attempt budget so machines that exhausted it under an
 * older, weaker extractor try again without waiting for an app version bump.
 * Rev 3: static-class anchors (vb.tp / vb.uu) + full readable GA scan; v1.00.23
 * renamed uz.tm/uz.us and uses vb.StageCache — singleton-only scan failed live.
 * Rev 4: stage-clear log offsets (runtime.log.stageClearTypeKey, stageClearLog).
 * Rev 5: namespace-tolerant class matching (vb.PetSaveData / vb.GetBoxLog) +
 * dynamic logByType offset + dynamic ELogType.GetBox key discovery, so the
 * player/log anchors survive per-build obfuscation that v1.00.28 exposed.
 * Rev 6: emit stable pet/item struct offsets as defaults when the player anchor
 * isn't static-reachable (same as v1.00.27 bundled table). The runtime reader
 * guards on commonSaveData≠0 before using them, so wrong reads are impossible.
 * Rev 7: derive BoxOpenLog struct fields (itemStringKey, itemGradeType) from
 * the class metadata index and the ELogType.GetItemWithBoxOpen dict key from
 * the same LogManager dictionary walk — enables the loot tracker without a
 * manual IL2CPP dump. boxType/level remain 0 (obfuscated field names).
 * Rev 8: v1.00.28 GradeSO* grade support — identifyBoxOpenLogFieldsByValue
 * dumps GradeSO class fields + instance bytes for grade-offset derivation;
 * commonSaveData removed from ENRICHMENT_FIELDS (not derivable, was keeping
 * enrichmentComplete permanently false and the 30s heal timer running forever).
 * Rev 9: v1.01.02 auto-recovery — fallback RVA zeroing (liveReader forces full
 * critical re-derivation when bundled table is a same-major.minor fallback) +
 * GetBoxLog validation tolerance (probe EMonsterLogType offset candidates +
 * monsterLogType field-name fallback for obfuscated class names) +
 * findBoxOpenLogDictDirect fallback (locate BoxOpen bucket directly when
 * GetBoxLog validation rejects every candidate — restores loot tracking).
 * Rev 10: fallback RVA preservation — same-major.minor fallback no longer
 * zeroes TypeInfo RVAs. The fallback table's RVAs are kept as a working
 * baseline (reader's resolve* helpers validate pointers before use, so stale
 * RVAs degrade gracefully to null). The extractor still runs for enrichment
 * (boxOpenLog etc.) and overwrites RVAs it successfully re-derives. Fixes
 * "live 直接显示不支持了" on v1.01.02 where 3 extractor failures (player in
 * main menu at attach time) permanently blocked live tracking even though
 * v1.01.01 RVAs would have worked.
 * Rev 11: findStageManager now validates that the candidate instance's
 * HeroList points at a non-empty array. Without this, any class that happens
 * to declare `HeroList` (e.g. a UI preview or cache class added in v1.01.02)
 * would match, returning a slotRva that points at the wrong class — the
 * reader would scan that wrong class's static block and never find a live
 * StageManager instance, leaving live data permanently null ("party empty"
 * on every candidate). Fixes "实现实时了但 DPS/经验/通关记录都没数据" on
 * v1.01.02.
 * Rev 12: findStageManager layer-2 hero-walk validation — when the base
 * table supplies unit.cache / heroRuntime.info / heroInfoData.heroKey (all
 * stable across v1.00.27+), the candidate's HeroList array is sampled and
 * the first element must walk end-to-end to a plausible heroKey. This
 * rejects UI preview / cache classes that pass layer 1 (non-empty array of
 * non-Unit pointers) but cannot be StageManager. Also fixes the silent
 * diagnostic log: ScanContext now wires its `log` through to the worker
 * log, so "findStageManager: matched class=..." / "no match ..." lines
 * actually appear in the live log instead of being dropped. Fixes the
 * residual v1.01.02 regression where Rev 11 still matched a wrong class
 * with a transiently non-empty HeroList during the 5s extraction window.
 * Rev 13: version-adaptation hardening — five fixes that together break the
 * "fallback table → 3 critical failures → budget exhausted → never retries"
 * deadlock and the "BoxData live reads broken after every minor patch"
 * regression:
 *  1. `_criticalRvasValidated` flag on LiveOffsets: only set when the
 *     extractor actually confirmed stageManager/stageCacheManager RVAs.
 *     Replaces the `_extractorRev`-based trust check that always returned
 *     false after a single failed extraction attempt.
 *  2. LogManager name-scan fallback (`runLogManagerNameScan`): when the
 *     fallback table's LogManager RVA is stale for the current build,
 *     resolve the class by name ("LogManager" is not obfuscated) and pin
 *     the singleton instance on all three log pins.
 *  3. Cache-pollution detector expanded to match "LogManager singleton
 *     unresolved" (the v1.01.02-fallback-from-v1.01.01 signature).
 *  4. `findBoxDataFields` structural derivation of BoxData.BoxTypes /
 *     BoxQuantity — scans the BoxData instance for two List<int> fields of
 *     equal length, no field-name matching. Survives BoxTypes/BoxQuantity
 *     field-name obfuscation on versions like v1.00.28.
 *  5. StageManager-availability transition (worker Path 1.6) resets the
 *     CRITICAL budget when the player enters a stage — the recovery signal
 *     for the budget-exhausted deadlock.
 */
export const EXTRACTOR_REVISION = 13;

/**
 * Module-level flag: `dumpSaveListHolders` has run once this process lifetime.
 * Mirrors `catalogDumpDone` in liveReader.ts — the dump only needs to fire
 * once per session to reveal the renamed save-list holder class. Without
 * this guard, Rev 13's Path 1.6 (StageManager transition) and Path 1.5
 * (cache pollution) can reset the critical budget and re-trigger the
 * extractor multiple times, re-running the multi-hundred-line dump on
 * every retry. The dump reuses the already-built ScanContext + entries,
 * so it's cheap memory-wise, but the log volume is the problem.
 */
let saveListDumpDone = false;

// Structural offsets whose field names ARE obfuscated but whose byte offsets are
// stable across patches. Emitted as constants rather than derived by name.
const STRUCT_LOG_BY_TYPE = 0x28;
const STRUCT_GETBOX_TYPE = 0x50;
const STRUCT_STAGE_CLEAR_KEY = 1; // ELogType.StageClear
const STRUCT_STAGE_CLEAR_ACT = 0x40; // StageClearLog.act — live-verified on v1.00.23
const STRUCT_STAGE_CLEAR_STAGE = 0x44; // StageClearLog.stage
const STRUCT_STAGE_CLEAR_TIME = 0x48;
const STRUCT_RUNTIME_WAVE = 0x138;

// PlayerSaveData list field offsets — stable since v1.00.23 (v1.00.21 used
// 0x68/0xa0). Used as defaults when findPlayerSaveData can't reach the save
// object statically (same situation as v1.00.27's bundled table).
const STRUCT_PET_SAVE_DATAS = 0x70; // PlayerSaveData.petSaveDatas
const STRUCT_ITEM_SAVE_DATAS = 0xa8; // PlayerSaveData.itemSaveDatas
const STRUCT_AGGREGATE_SAVE_DATAS = 0xb8; // PlayerSaveData.aggregateSaveDatas
// PetSaveData / ItemSaveData struct field offsets — never changed across versions.
const STRUCT_PET_KEY = 0x10; // PetSaveData.PetKey
const STRUCT_PET_IS_UNLOCK = 0x14; // PetSaveData.IsUnlock
const STRUCT_ITEM_KEY = 0x10; // ItemSaveData.ItemKey
const STRUCT_ITEM_IS_CHAOTIC = 0x20; // ItemSaveData.IsChaotic

const GOLD_KEY = 100001;

/** Memory protection constants for readable GameAssembly pages (TypeInfo slots). */
const GA_READABLE_PROTECT = new Set([
  0x02, // PAGE_READONLY — .rdata holds many Il2Cpp metadata pointers
  0x04, // PAGE_READWRITE
  0x08, // PAGE_WRITECOPY
  0x20, // PAGE_EXECUTE_READ
  0x40, // PAGE_EXECUTE_READWRITE
  0x80, // PAGE_EXECUTE_WRITECOPY
]);

export type ExtractorLog = (msg: string) => void;

const noopLog: ExtractorLog = () => undefined;

/**
 * Result of {@link extractOffsets}: the resolved offset table plus a
 * name → Il2CppClass* index built from the same GA region scan that produced
 * the table. The class index lets callers resolve class pointers by name
 * WITHOUT falling back to the ~30–60s whole-address-space scan performed by
 * `resolveClassByName` (winProcess).
 *
 * Both the full IL2CPP name (`vb.MonsterSpawnManager`) and the short
 * serialization-stable name (`MonsterSpawnManager`) are indexed; short-name
 * collisions keep the first entry seen (same semantics as
 * {@link collectClassEntries}).
 */
export interface ExtractResult {
  offsets: LiveOffsets;
  classIndex: Map<string, bigint>;
}

/** Readable regions inside the GameAssembly range — Il2Cpp TypeInfo slot arrays. */
function gaScanRegions(proc: WinProcess, ga: { base: bigint; size: number }): ScanRegion[] {
  const gaEnd = ga.base + BigInt(ga.size);
  const out: ScanRegion[] = [];
  for (const region of proc.readableRegions(5000, ga.base)) {
    if (region.baseAddress >= gaEnd) break;
    if (region.baseAddress < ga.base || region.size < 8) continue;
    if (!GA_READABLE_PROTECT.has(region.protect)) continue;
    out.push({ base: region.baseAddress, size: region.size });
  }
  return out;
}

/**
 * Build a name → Il2CppClass* index by scanning GameAssembly.dll readable
 * regions. This is the same GA-only scan that {@link extractOffsets} runs
 * internally; exposed separately so callers that load a complete bundled/cache
 * table (and thus skip the extractor) can still resolve class pointers by name
 * WITHOUT falling back to the ~30–60s whole-address-space scan performed by
 * `resolveClassByName`.
 *
 * Both the full IL2CPP name (`vb.MonsterSpawnManager`) and the short
 * serialization-stable name (`MonsterSpawnManager`) are indexed; short-name
 * collisions keep the first entry seen.
 *
 * Returns an empty map when no readable GA regions are found (the caller
 * should then fall back to `resolveClassByName`).
 */
export function buildClassNameIndex(
  proc: WinProcess,
  ga: { base: bigint; size: number },
): Map<string, bigint> {
  const regions = gaScanRegions(proc, ga);
  if (regions.length === 0) return new Map();
  const ctx = new ScanContext(proc);
  const { entries } = collectClassEntries(ctx, ga.base, regions);
  const index = new Map<string, bigint>();
  for (const e of entries) {
    if (!e.name) continue;
    if (!index.has(e.name)) index.set(e.name, e.classPtr);
    const dot = e.name.lastIndexOf(".");
    if (dot >= 0) {
      const short = e.name.slice(dot + 1);
      if (!index.has(short)) index.set(short, e.classPtr);
    }
  }
  return index;
}

/**
 * Attempt runtime offset derivation from GameAssembly.dll memory.
 * Returns a `LiveOffsets` table (possibly with unresolved enrichment fields
 * left 0) or null when any critical anchor fails.
 *
 * Critical anchors: stage manager (+ HeroList offset), stage-cache manager,
 * currency manager. Enrichment: log manager (chest drops), player save data
 * (pets/inventory).
 *
 * When `enrichmentOnly` is true, critical anchors are skipped — the caller
 * already has them in a supported base table. Only enrichment fields are
 * derived. This lets the healer fill gaps (e.g. boxOpenLog) even when a
 * critical anchor probe is temporarily failing (e.g. gold probe during game
 * loading). The returned table has 0 for critical fields; mergeOffsets keeps
 * the base values.
 */
export function extractOffsets(
  proc: WinProcess,
  ga: { base: bigint; size: number },
  version: string,
  log: ExtractorLog = noopLog,
  enrichmentOnly = false,
  base?: LiveOffsets,
): ExtractResult | null {
  const t0 = Date.now();
  const regions = gaScanRegions(proc, ga);
  const totalBytes = regions.reduce((sum, r) => sum + r.size, 0);
  log(
    `extract: scanning ${regions.length} readable GA regions (${Math.round(totalBytes / 1024)} KiB)` +
      (enrichmentOnly ? " (enrichment-only)" : ""),
  );

  const ctx = new ScanContext(proc, log);
  const { entries, stats } = collectClassEntries(ctx, ga.base, regions);
  log(
    `extract: indexed ${stats.namedClasses} named classes ` +
      `(${stats.slotsScanned} slots, ${stats.pointerTargets} pointer targets, ${Date.now() - t0} ms)`,
  );

  // ── Critical anchors (structural) ──────────────────────────────────────────
  // Skipped in enrichment-only mode — the base table already has them.
  let sm: { slotRva: bigint; heroList: number } | null = null;
  let scm: { slotRva: bigint; currentCache: number } | null = null;
  let cm: { slotRva: bigint } | null = null;

  if (!enrichmentOnly) {
    // Hero-walk validation offsets: prefer the base (bundled/cache) table's
    // unit.cache + heroRuntime.info + heroInfoData.heroKey. These are stable
    // across v1.00.27+ (0x3b0 / 0x30 / 0x30) so even a fallback table from
    // a neighboring version supplies correct values. When absent (e.g. a
    // completely unknown version with no fallback), layer-2 validation is
    // skipped and findStageManager falls back to layer-1 (non-empty array).
    const heroOffsets =
      base && base.unit.cache > 0 && base.heroRuntime.info > 0 && base.heroInfoData.heroKey > 0
        ? {
            unitCache: base.unit.cache,
            heroRuntimeInfo: base.heroRuntime.info,
            heroInfoDataKey: base.heroInfoData.heroKey,
          }
        : undefined;
    sm = findStageManager(ctx, entries, { heroOffsets });
    if (!sm) {
      log(`extract: FAILED — no StageManager singleton (static slot with HeroList field)`);
      return null;
    }
    log(
      `extract: stageManager rva=0x${sm.slotRva.toString(16)} heroList=0x${sm.heroList.toString(16)}`,
    );

    scm = findStageCacheManagerStatic(ctx, entries) ?? findStageCacheManager(ctx, entries);
    if (!scm) {
      log(`extract: FAILED — no stage-cache static store (vb.uu / StageCache at +0x88)`);
      return null;
    }
    log(
      `extract: stageCacheManager rva=0x${scm.slotRva.toString(16)} currentCache=0x${scm.currentCache.toString(16)}`,
    );

    cm =
      findCurrencyManagerStatic(ctx, entries, GOLD_KEY) ??
      findCurrencyManager(ctx, entries, GOLD_KEY);
    if (!cm) {
      // v1.00.28 restructured the currency-manager class — the gold probe no
      // longer matches. Don't fail the whole extraction: currencyManager is no
      // longer a CRITICAL_FIELDS entry (see offsetCompleteness.ts), and live
      // gold degrades to the save-snapshot path (5s latency). Other live stats
      // (XP, stage wave, chest drops, DPS) flow normally.
      log(
        `extract: currencyManager not derived — gold probe failed (key ${GOLD_KEY}); live gold degrades to save snapshot`,
      );
    } else {
      log(`extract: currencyManager rva=0x${cm.slotRva.toString(16)}`);
    }
  }

  // ── Enrichment anchors (zero-value fallback, retried while incomplete) ─────
  const lm = findLogManager(ctx, entries);
  // BoxOpenLog field offsets are class-metadata-derived, not LogManager-dependent —
  // resolve them unconditionally so the loot tracker gets field offsets even when
  // the LogManager singleton isn't static-reachable (the dict key is still 0 then,
  // so the reader won't read the list, but a later bundled-table merge can fill it).
  const boxOpenFields = findBoxOpenLogFields(ctx, entries);
  // Fallback: when findLogManager fails (GetBoxLog validation rejected every
  // candidate), try to locate the BoxOpen bucket directly. This restores
  // loot tracking even when chest-drop (GetBoxLog) tracking is unavailable.
  const lmFallback = lm == null ? findBoxOpenLogDictDirect(ctx, entries) : null;
  if (lm) {
    let msg = `extract: logManager rva=0x${lm.slotRva.toString(16)} logByType=0x${lm.logByType.toString(16)} getBoxKey=${lm.getBoxTypeKey} boxOpenKey=${lm.boxOpenTypeKey} boxOpenLog.fields={itemStringKey:0x${lm.boxOpenLog.itemStringKey.toString(16)},itemGradeType:0x${lm.boxOpenLog.itemGradeType.toString(16)},gradeSO:0x${lm.boxOpenLog.gradeSO.toString(16)},gradeSOGrade:0x${lm.boxOpenLog.gradeSOGrade.toString(16)}}`;
    if (lm.boxOpenDiagnostics) {
      const d = lm.boxOpenDiagnostics;
      const ptrStr = d.firstEntryPtr == null ? "null" : `0x${d.firstEntryPtr.toString(16)}`;
      const countStr = d.bucketCount == null ? "null" : String(d.bucketCount);
      const nameStr = d.firstEntryClassName == null ? "null" : `"${d.firstEntryClassName}"`;
      msg += ` — validation failed: bucketCount=${countStr} firstEntryPtr=${ptrStr} firstEntryClassName=${nameStr}`;
      if (d.fieldsProbe) {
        log(d.fieldsProbe);
      }
    }
    // Log field-identification diagnostics even on success — needed to debug
    // v1.00.28 grade mapping (GradeSO* fields, sample values, klass names).
    if (lm.boxOpenLog.diagnostics) {
      log(lm.boxOpenLog.diagnostics);
    }
    log(msg);
  } else if (lmFallback) {
    log(
      `extract: logManager fallback (BoxOpen bucket direct) rva=0x${lmFallback.slotRva.toString(16)} logByType=0x${lmFallback.logByType.toString(16)} boxOpenKey=${lmFallback.boxOpenTypeKey} boxOpenLog.fields={itemStringKey:0x${lmFallback.boxOpenLog.itemStringKey.toString(16)},itemGradeType:0x${lmFallback.boxOpenLog.itemGradeType.toString(16)}} — getBoxKey=0 (chest-drop log unavailable)`,
    );
  } else {
    log(
      `extract: logManager not derived (no validated GetBoxLog list — chest drops degrade); boxOpenLog.fields={itemStringKey:0x${boxOpenFields.itemStringKey.toString(16)},itemGradeType:0x${boxOpenFields.itemGradeType.toString(16)},gradeSO:0x${boxOpenFields.gradeSO.toString(16)},gradeSOGrade:0x${boxOpenFields.gradeSOGrade.toString(16)}}`,
    );
    // Dump candidate dict buckets so we can see WHY validation failed on
    // this game version. Capped at 5 candidates by collectLogManagerDiagnostics.
    const diag = collectLogManagerDiagnostics(ctx, entries);
    log(diag);
  }

  // ── MonsterSpawnManager (enrichment for DPS tracking) ──────────────
  const msm = findMonsterSpawnManager(ctx, entries);
  log(
    msm
      ? `extract: monsterSpawnManager rva=0x${msm.slotRva.toString(16)}`
      : `extract: monsterSpawnManager not derived (DPS tracking degrades)`,
  );

  // ── UnitHealthController HP field offsets (bundled from tbh-meter) ─────────
  // These are now bundled directly in the offset tables. The extractor emits zeros
  // so the bundled defaults (0x28/0x38/0x30/0xB0/0x40/0x4C) take priority in mergeOffsets.

  const player = findPlayerSaveData(ctx, entries);
  log(
    player
      ? `extract: player anchor rva=0x${player.commonSaveData.toString(16)} ` +
          `static+0x${player.playerStaticOff.toString(16)} pets=0x${player.petSaveDatas.toString(16)} items=0x${player.itemSaveDatas.toString(16)} boxData=0x${(player.boxData ?? 0).toString(16)} boxTypes=0x${(player.boxTypes ?? 0).toString(16)} boxQuantity=0x${(player.boxQuantity ?? 0).toString(16)}`
      : `extract: player save-data anchor not derived (pets/inventory degrade to save file)`,
  );
  // When the "BoxData" field-name match failed, dump the PlayerSaveData class
  // field table + raw bytes so we can see the actual (possibly obfuscated)
  // field name on versions like v1.01.02. The dump is one-shot per class
  // (probedClasses guard inside dumpClassFields), so this won't repeat.
  if (player?.boxDataDiagnostics) {
    log(player.boxDataDiagnostics);
  }
  // Diagnostic: when the player anchor couldn't be derived at all (holder
  // class restructured — v1.01.02 signature), dump every static-reachable
  // List<*> field + recurse one level into CommonSaveData's sub-objects so
  // we can see where PetSaveData/ItemSaveData/BoxData lists moved. Gated by
  // env var — zero impact on the production path when disabled. Reuses the
  // already-built ScanContext + entries, so it adds no extra memory scanning.
  if (!player && process.env.TBH_DUMP_SAVE_LIST_HOLDERS === "1" && !saveListDumpDone) {
    saveListDumpDone = true;
    try {
      dumpSaveListHolders(ctx, entries, log);
    } catch (e) {
      log(`[save-list-dump] error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(`extract: done in ${Date.now() - t0} ms`);

  // Catalog overlay spike: dump ItemSO / ItemManager candidates so we can
  // design a runtime catalog extractor. Gated by env var — zero impact on the
  // production path when disabled. The dump reuses the already-built ScanContext
  // + entries, so it adds no extra memory scanning, only field-table lookups.
  if (process.env.TBH_DUMP_CATALOG_CANDIDATES === "1") {
    try {
      dumpCatalogCandidates(ctx, entries, log);
    } catch (e) {
      log(`[catalog-dump] error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Build a name → Il2CppClass* index from the same GA scan that produced the
  // offset table. Both full (`vb.MonsterSpawnManager`) and short
  // (`MonsterSpawnManager`) names are stored so callers can look up by the
  // serialization-stable short name without a whole-address-space scan.
  const classIndex = new Map<string, bigint>();
  for (const e of entries) {
    if (!e.name) continue;
    if (!classIndex.has(e.name)) classIndex.set(e.name, e.classPtr);
    const dot = e.name.lastIndexOf(".");
    if (dot >= 0) {
      const short = e.name.slice(dot + 1);
      if (!classIndex.has(short)) classIndex.set(short, e.classPtr);
    }
  }

  return {
    offsets: {
      gameVersion: version,

      typeInfoRva: {
        commonSaveData: player?.commonSaveData ?? 0n,
        currencyManager: cm?.slotRva ?? 0n,
        stageCacheManager: scm?.slotRva ?? 0n,
        stageManager: sm?.slotRva ?? 0n,
        localInventoryManager: 0n, // unused; inventory reads via the player save snapshot
        logManager: lm?.slotRva ?? lmFallback?.slotRva ?? 0n,
        monsterSpawnManager: msm?.slotRva ?? 0n,
      },

      player: {
        commonSaveData: player?.playerStaticOff ?? 0x10,
        currency: 0x48,
        heroSaveDatas: 0x50,
        petSaveDatas: player?.petSaveDatas ?? STRUCT_PET_SAVE_DATAS,
        itemSaveDatas: player?.itemSaveDatas ?? STRUCT_ITEM_SAVE_DATAS,
        aggregates: player?.aggregateSaveDatas ?? STRUCT_AGGREGATE_SAVE_DATAS,
        boxData: player?.boxData ?? 0,
      },

      boxData: {
        boxTypes: player?.boxTypes ?? 0,
        boxQuantity: player?.boxQuantity ?? 0,
      },

      common: {
        playTime: 0x20,
        arrangedHeroKey: 0x48,
        maxCompletedStage: 0x54,
        currentStageKey: 0x58,
        currentStageWave: 0x5c,
      },

      hero: { heroKey: 0x10, level: 0x14, unlock: 0x18, exp: 0x1c, equipped: 0x28 },

      unit: { cache: 0x3b0 }, // v1.00.27+ layout (was 0x3a8 pre-1.00.27)

      heroRuntime: {
        info: 0x30,
        levelHidden: 0xd0,
        levelKey: 0xd4,
        // v1.00.27+ widened exp to ObscuredDouble (was 0x110/0x114 ObscuredFloat pre-1.00.27)
        expHidden: 0x118,
        expKey: 0x120,
      },

      heroInfoData: { heroKey: 0x30 },

      currency: { key: 0x10, quantity: 0x18 },

      petSaveData: {
        petKey: player?.petKey ?? STRUCT_PET_KEY,
        isUnlock: player?.petIsUnlock ?? STRUCT_PET_IS_UNLOCK,
      },

      inventoryItem: {
        itemKey: player?.itemKey ?? STRUCT_ITEM_KEY,
        isChaotic: player?.itemIsChaotic ?? STRUCT_ITEM_IS_CHAOTIC,
      },

      runtime: {
        currency: { list: 0x0, dict: 0x8, entryInfoData: 0x10, entryObscuredQty: 0x28 },
        stage: {
          currentCache: scm?.currentCache ?? 0,
          cacheInfoData: 0x10,
          stageKey: 0x30,
          waveAmount: 0x54,
          runtimeWave: STRUCT_RUNTIME_WAVE,
        },
        currencyInfoKey: 0x30,
        heroList: sm?.heroList ?? 0,
        log: {
          logByType: lm?.logByType ?? lmFallback?.logByType ?? STRUCT_LOG_BY_TYPE,
          getBoxTypeKey: lm?.getBoxTypeKey ?? 0, // fallback path can't derive GetBox key
          stageClearTypeKey: STRUCT_STAGE_CLEAR_KEY,
          getItemWithBoxOpenTypeKey: lm?.boxOpenTypeKey ?? lmFallback?.boxOpenTypeKey ?? 0,
        },
        getBoxLog: { monsterType: STRUCT_GETBOX_TYPE },
        boxOpenLog: {
          itemStringKey:
            lm?.boxOpenLog.itemStringKey ??
            lmFallback?.boxOpenLog.itemStringKey ??
            boxOpenFields.itemStringKey,
          itemGradeType:
            lm?.boxOpenLog.itemGradeType ??
            lmFallback?.boxOpenLog.itemGradeType ??
            boxOpenFields.itemGradeType,
          gradeSO:
            lm?.boxOpenLog.gradeSO ?? lmFallback?.boxOpenLog.gradeSO ?? boxOpenFields.gradeSO ?? 0,
          gradeSOGrade:
            lm?.boxOpenLog.gradeSOGrade ??
            lmFallback?.boxOpenLog.gradeSOGrade ??
            boxOpenFields.gradeSOGrade ??
            0,
          boxType: 0, // obfuscated field name — requires manual IL2CPP dump
          level: 0, // obfuscated field name — requires manual IL2CPP dump
        },
        stageClearLog: {
          act: STRUCT_STAGE_CLEAR_ACT,
          stage: STRUCT_STAGE_CLEAR_STAGE,
          clearTimeSec: STRUCT_STAGE_CLEAR_TIME,
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

      container: STRUCT_CONTAINER,
      dict: STRUCT_DICT,
      il2cppClass: { staticFieldsOffsets: STATIC_FIELDS_CANDIDATES },
      goldKey: GOLD_KEY,
    },

    classIndex,
  };
}
