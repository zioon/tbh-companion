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
 */
export const EXTRACTOR_REVISION = 6;

// Structural offsets whose field names ARE obfuscated but whose byte offsets are
// stable across patches. Emitted as constants rather than derived by name.
const STRUCT_LOG_BY_TYPE = 0x28;
const STRUCT_GETBOX_TYPE = 0x50;
const STRUCT_GETBOX_KEY = 3; // ELogType.GetBox
const STRUCT_STAGE_CLEAR_KEY = 1; // ELogType.StageClear
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
 * Attempt runtime offset derivation from GameAssembly.dll memory.
 * Returns a `LiveOffsets` table (possibly with unresolved enrichment fields
 * left 0) or null when any critical anchor fails.
 *
 * Critical anchors: stage manager (+ HeroList offset), stage-cache manager,
 * currency manager. Enrichment: log manager (chest drops), player save data
 * (pets/inventory).
 */
export function extractOffsets(
  proc: WinProcess,
  ga: { base: bigint; size: number },
  version: string,
  log: ExtractorLog = noopLog,
): LiveOffsets | null {
  const t0 = Date.now();
  const regions = gaScanRegions(proc, ga);
  const totalBytes = regions.reduce((sum, r) => sum + r.size, 0);
  log(
    `extract: scanning ${regions.length} readable GA regions (${Math.round(totalBytes / 1024)} KiB)`,
  );

  const ctx = new ScanContext(proc);
  const { entries, stats } = collectClassEntries(ctx, ga.base, regions);
  log(
    `extract: indexed ${stats.namedClasses} named classes ` +
      `(${stats.slotsScanned} slots, ${stats.pointerTargets} pointer targets, ${Date.now() - t0} ms)`,
  );

  // ── Critical anchors (structural) ──────────────────────────────────────────
  const sm = findStageManager(ctx, entries);
  if (!sm) {
    log(`extract: FAILED — no StageManager singleton (static slot with HeroList field)`);
    return null;
  }
  log(
    `extract: stageManager rva=0x${sm.slotRva.toString(16)} heroList=0x${sm.heroList.toString(16)}`,
  );

  const scm = findStageCacheManagerStatic(ctx, entries) ?? findStageCacheManager(ctx, entries);
  if (!scm) {
    log(`extract: FAILED — no stage-cache static store (vb.uu / StageCache at +0x88)`);
    return null;
  }
  log(
    `extract: stageCacheManager rva=0x${scm.slotRva.toString(16)} currentCache=0x${scm.currentCache.toString(16)}`,
  );

  const cm =
    findCurrencyManagerStatic(ctx, entries, GOLD_KEY) ??
    findCurrencyManager(ctx, entries, GOLD_KEY);
  if (!cm) {
    log(`extract: FAILED — no currency manager passed the gold probe (key ${GOLD_KEY})`);
    return null;
  }
  log(`extract: currencyManager rva=0x${cm.slotRva.toString(16)}`);

  // ── Enrichment anchors (zero-value fallback, retried while incomplete) ─────
  const lm = findLogManager(ctx, entries);
  log(
    lm
      ? `extract: logManager rva=0x${lm.slotRva.toString(16)} logByType=0x${lm.logByType.toString(16)} getBoxKey=${lm.getBoxTypeKey}`
      : `extract: logManager not derived (no validated GetBoxLog list — chest drops degrade)`,
  );

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
          `static+0x${player.playerStaticOff.toString(16)} pets=0x${player.petSaveDatas.toString(16)} items=0x${player.itemSaveDatas.toString(16)}`
      : `extract: player save-data anchor not derived (pets/inventory degrade to save file)`,
  );

  log(`extract: done in ${Date.now() - t0} ms`);

  return {
    gameVersion: version,

    typeInfoRva: {
      commonSaveData: player?.commonSaveData ?? 0n,
      currencyManager: cm.slotRva,
      stageCacheManager: scm.slotRva,
      stageManager: sm.slotRva,
      localInventoryManager: 0n, // unused; inventory reads via the player save snapshot
      logManager: lm?.slotRva ?? 0n,
      monsterSpawnManager: msm?.slotRva ?? 0n,
    },

    player: {
      commonSaveData: player?.playerStaticOff ?? 0x10,
      currency: 0x48,
      heroSaveDatas: 0x50,
      petSaveDatas: player?.petSaveDatas ?? STRUCT_PET_SAVE_DATAS,
      itemSaveDatas: player?.itemSaveDatas ?? STRUCT_ITEM_SAVE_DATAS,
      aggregates: player?.aggregateSaveDatas ?? STRUCT_AGGREGATE_SAVE_DATAS,
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
      expHidden: 0x110,
      expKey: 0x114,
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
        currentCache: scm.currentCache,
        cacheInfoData: 0x10,
        stageKey: 0x30,
        waveAmount: 0x54,
        runtimeWave: STRUCT_RUNTIME_WAVE,
      },
      currencyInfoKey: 0x30,
      heroList: sm.heroList,
      log: {
        logByType: lm?.logByType ?? STRUCT_LOG_BY_TYPE,
        getBoxTypeKey: lm?.getBoxTypeKey ?? STRUCT_GETBOX_KEY,
        stageClearTypeKey: STRUCT_STAGE_CLEAR_KEY,
        getItemWithBoxOpenTypeKey: 0,
      },
      getBoxLog: { monsterType: STRUCT_GETBOX_TYPE },
      boxOpenLog: { itemStringKey: 0, itemGradeType: 0, boxType: 0, level: 0 },
      stageClearLog: { clearTimeSec: STRUCT_STAGE_CLEAR_TIME },
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
  };
}
