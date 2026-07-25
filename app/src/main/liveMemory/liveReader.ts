// Attaches read-only to the game, resolves offsets by version, and produces a
// live snapshot. Impure glue: the read algorithm lives in core/liveMemory; this
// wires it to the real koffi-backed WinProcess. utilityProcess only.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { offsetsForVersionMeta, type LiveOffsets } from "../../core/liveMemory/offsets";
import {
  hasCriticalOffsets,
  isOffsetTableComplete,
  mergeOffsets,
  missingOffsetFields,
} from "../../core/liveMemory/offsetCompleteness";
import { buildClassNameIndex, extractOffsets, EXTRACTOR_REVISION } from "./offsetExtractor";
import { loadCachedOffsets, saveCachedOffsets } from "./offsetCache";
import {
  enrichmentAttempts,
  extractionAttempts,
  mayAttemptEnrichment,
  mayAttemptExtraction,
  MAX_ENRICHMENT_ATTEMPTS,
  MAX_EXTRACTION_ATTEMPTS,
  recordEnrichmentAttempt,
  recordExtractionAttempt,
  resetEnrichmentAttempts,
} from "./offsetHealing";
import {
  resolveLiveMemoryOffsetCacheDir,
  resolveLiveMemoryUserDataDir,
} from "./liveMemoryCacheDir";
import {
  makeBoxOpenPinState,
  makeChestLogPinState,
  makeGoldPinState,
  makeMonsterSpawnPinState,
  makeSmPinState,
  makeStageClearPinState,
  peekBoxOpenLogCount,
  readRuntimeBoxOpenLog,
  readRuntimeChestLog,
  readRuntimeCombatGold,
  readRuntimeGold,
  readRuntimeHeroes,
  readRuntimeInventory,
  readRuntimeMonsterHp,
  readRuntimePets,
  readRuntimeStage,
  readRuntimeStageClears,
  resolveStageManager,
  type BoxOpenPinState,
  type ChestLogPinState,
  type GoldPinState,
  type MonsterSpawnPinState,
  type SmPinState,
  type StageClearPinState,
  type ReadInventoryResult,
  type ReadPetsResult,
} from "../../core/liveMemory/runtime";
import { resolveClassByName, singletonFromClass } from "./winProcess";
import { WinProcess } from "./winProcess";
import { readRuntimeChestSlots, type ReadChestSlotsResult } from "../../core/liveMemory/chestSlots";
import { readClassFields } from "../../core/liveMemory/il2cppScanner";
import { loadBoxTypeCatalog, boxTypeIndex } from "../../core/boxes/catalog";
import type { BoxCategory, LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";

const PROCESS_NAMES = ["TaskBarHero.exe", "TaskbarHero.exe"];

export type LiveMemoryLogFn = (message: string) => void;
export type OffsetResolutionSource = "bundled" | "cache" | "extracted" | "merged" | "none";

/** Companion build id used to reset the extraction attempt budget on upgrade. */
function resolveAppBuild(): string {
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, rel), "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

function gameAssembly(p: WinProcess): { base: bigint; size: number } | null {
  const m = p.listModules().find((mod) => /^gameassembly\.dll$/i.test(mod.name));
  return m ? { base: m.baseAddress, size: m.size } : null;
}

/** Read Version.txt next to the running exe (e.g. "1.00.21"). Returns version + install dir. */
function detectGameVersion(p: WinProcess): { version: string; installDir: string } | null {
  try {
    const exe = p.listModules().find((m) => /taskbarhero\.exe$/i.test(m.name))?.path;
    if (!exe) return null;
    const installDir = dirname(exe);
    const versionFile = join(installDir, "Version.txt");
    if (!existsSync(versionFile)) return null;
    const v = readFileSync(versionFile, "utf-8").trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
    return { version: v, installDir };
  } catch {
    return null;
  }
}

/**
 * Module-level flag: the catalog-dump diagnostic has run once this process
 * lifetime. Prevents re-running the 8-second extractor on every heal tick
 * when TBH_DUMP_CATALOG_CANDIDATES=1 — the dump only needs to fire once per
 * session, and re-running it would starve the live-tracking tick loop.
 */
let catalogDumpDone = false;

export class LiveMemoryReader {
  private proc: WinProcess | null = null;
  private ga: { base: bigint; size: number } | null = null;
  private offsets: LiveOffsets | null = null;
  private offsetSource: OffsetResolutionSource = "none";
  private goldPin: GoldPinState = makeGoldPinState();
  private smPin: SmPinState = makeSmPinState();
  private chestPin: ChestLogPinState = makeChestLogPinState();
  private stageClearPin: StageClearPinState = makeStageClearPinState();
  private boxOpenPin: BoxOpenPinState = makeBoxOpenPinState();
  private monsterPin: MonsterSpawnPinState = makeMonsterSpawnPinState();
  /** Throttle for the "read: stage null" diagnostic log (avoid spamming every tick). */
  private lastSmFailLogAt: number | null = null;
  private gameInstallDir: string | null = null;
  private readonly userDataDir: string;
  private log: LiveMemoryLogFn = () => undefined;
  /** True once we've attempted name-based MonsterSpawnManager resolution (avoid re-scan). */
  private monsterNameScanAttempted = false;
  /** True once we've attempted name-based PlayerSaveData resolution (avoid re-scan). */
  private playerNameScanAttempted = false;
  /** Resolved PlayerSaveData instance pointer (name-scan fallback cache). */
  private playerPtr: bigint | null = null;
  /**
   * Name → Il2CppClass* index built by the last successful extraction. Used as
   * a fast path for the MonsterSpawnManager / PlayerSaveData name-scan
   * fallbacks so they can skip the ~30–60s whole-address-space scan when the
   * class is already in the GA-derived index. Null when the reader attached
   * from a complete bundled/cache table and never ran the extractor.
   */
  private classIndex: Map<string, bigint> | null = null;
  /** True while resolving offsets or scanning for a class name. */
  private _scanning = false;
  /** Optional callback invoked whenever the scanning flag changes. */
  onScanningChange?: (scanning: boolean) => void;
  gameVersion: string | null = null;
  supported = false;

  // Slow-changing fields are read on a low-frequency cadence to avoid
  // allocating large arrays (inventory up to 100k items, pets up to 500) at
  // the full 25 Hz read rate. The cache is repopulated every N ticks and
  // reused on the intervening frames; cleared on detach.
  private static readonly LOW_FREQ_EVERY_N_TICKS = 50; // ~2s at 25 Hz
  private lowFreqTick = 0;
  private lowFreqLoaded = false;
  private cachedInventory: ReadInventoryResult | null = null;
  private cachedPets: ReadPetsResult | null = null;
  /**
   * boxType → BoxCategory map for readRuntimeChestSlots. Built once from the
   * bundled `box_types.json` catalog and reused for the reader's lifetime.
   * Null until first use (lazy init keeps tests that don't touch chest slots
   * from needing to mock the catalog).
   */
  private boxTypeCatalogMap: ReadonlyMap<number, BoxCategory> | null = null;

  // BoxOpenLog list length observed on the previous tick. Used by the heal
  // scheduler to detect "player just opened a box" — the only precondition
  // under which the BoxOpenLog struct field offsets become derivable (the
  // class must be instantiated at least once). `peekBoxOpenLogCount` is
  // cheap (a few pointer reads) and only runs while enrichment is incomplete.
  private boxOpenCountPrev: number | null = null;
  private boxOpenEventPending = false;

  constructor(userDataDir: string = resolveLiveMemoryUserDataDir()) {
    this.userDataDir = userDataDir;
  }

  get scanning(): boolean {
    return this._scanning;
  }

  private setScanning(value: boolean): void {
    if (this._scanning === value) return;
    this._scanning = value;
    this.onScanningChange?.(value);
  }

  private offsetCacheDir(): string | null {
    if (!this.gameInstallDir) return null;
    return resolveLiveMemoryOffsetCacheDir(this.userDataDir, this.gameInstallDir);
  }

  /** Wire a logger (utilityProcess posts these to the main process). */
  setLogger(fn: LiveMemoryLogFn): void {
    this.log = fn;
  }

  get attached(): boolean {
    return this.proc != null && this.proc.isAlive();
  }

  /** True when every wanted field (critical + enrichment) is present. */
  get enrichmentComplete(): boolean {
    return this.offsets != null && isOffsetTableComplete(this.offsets);
  }

  /**
   * True when the enrichment extraction budget is not exhausted for this game
   * version under the current app build. When false, the periodic heal
   * scheduler stops hammering the extractor — but a detected box-open event
   * (see {@link consumeBoxOpenEvent}) can reset the budget and re-arm it.
   */
  get enrichmentHealAvailable(): boolean {
    const cacheDir = this.offsetCacheDir();
    const version = this.gameVersion;
    if (!cacheDir || !version) return true;
    return mayAttemptEnrichment(cacheDir, version, resolveAppBuild());
  }

  /** True when a "player just opened a box" event is pending consumption. */
  get hasBoxOpenEventPending(): boolean {
    return this.boxOpenEventPending;
  }

  /**
   * Consume and clear the pending box-open event flag. Returns true when an
   * event was pending (caller should reset the enrichment budget and trigger
   * an immediate heal). Idempotent — calling twice in a row returns false
   * the second time.
   */
  consumeBoxOpenEvent(): boolean {
    const pending = this.boxOpenEventPending;
    this.boxOpenEventPending = false;
    return pending;
  }

  /**
   * Reset the enrichment attempt counter to 0 so the next heal tick is allowed
   * to retry. Called by the worker after consuming a box-open event.
   */
  resetEnrichmentBudget(): void {
    const cacheDir = this.offsetCacheDir();
    const version = this.gameVersion;
    if (cacheDir && version) {
      resetEnrichmentAttempts(cacheDir, version, resolveAppBuild());
    }
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** Attach to the game and resolve version + offsets. Idempotent. */
  attach(appBuild: string = resolveAppBuild()): boolean {
    if (this.attached) {
      this.healOffsets(appBuild);
      return true;
    }
    this.detach();
    const proc = WinProcess.findByNames(PROCESS_NAMES);
    if (!proc) {
      this.log("attach: game process not found");
      return false;
    }
    this.proc = proc;
    this.refreshGameContext();
    this.log(
      `attach: pid=${proc.pid} version=${this.gameVersion ?? "?"} ga=${this.ga ? "ok" : "missing"}`,
    );
    try {
      this.setScanning(true);
      this.applyResolvedOffsets(this.resolveOffsets(proc, appBuild), appBuild);
    } finally {
      this.setScanning(false);
    }
    return true;
  }

  /**
   * Re-run offset resolution while already attached — used when the first attempt
   * happened too early (menu / singletons not up) or the extractor shipped an
   * improvement and the attempt budget reopened.
   */
  healOffsets(appBuild: string = resolveAppBuild()): void {
    const proc = this.proc;
    if (!proc?.isAlive()) return;

    const wasSupported = this.supported;
    this.refreshGameContext();
    try {
      this.setScanning(true);
      const resolved = this.resolveOffsets(proc, appBuild);
      this.applyResolvedOffsets(resolved, appBuild);
    } finally {
      this.setScanning(false);
    }

    if (!wasSupported && this.supported) {
      this.log(`heal: offsets now supported (source=${this.offsetSource})`);
    } else if (!this.supported) {
      const missing = this.offsets
        ? missingOffsetFields(this.offsets, "critical").join(", ")
        : "no table";
      this.log(`heal: still unsupported — source=${this.offsetSource} critical=${missing}`);
    }
  }

  private refreshGameContext(): void {
    const proc = this.proc;
    if (!proc) return;
    const versionInfo = detectGameVersion(proc);
    this.gameVersion = versionInfo?.version ?? this.gameVersion;
    this.gameInstallDir = versionInfo?.installDir ?? this.gameInstallDir;
    this.ga = gameAssembly(proc);
  }

  private applyResolvedOffsets(
    resolved: {
      table: LiveOffsets | null;
      source: OffsetResolutionSource;
      classIndex: Map<string, bigint> | null;
    },
    appBuild: string,
  ): void {
    this.offsets = resolved.table;
    this.offsetSource = resolved.source;
    if (resolved.classIndex) this.classIndex = resolved.classIndex;
    this.supported = this.offsets != null && this.ga != null && hasCriticalOffsets(this.offsets);
    if (this.supported && this.offsets && !isOffsetTableComplete(this.offsets)) {
      const missing = missingOffsetFields(this.offsets).join(", ");
      this.log(`offsets: supported but enrichment incomplete — missing ${missing}`);
    }
    if (!this.supported && this.attached) {
      const missing = this.offsets
        ? missingOffsetFields(this.offsets, "critical").join(", ")
        : "no table";
      const cacheDir = this.offsetCacheDir();
      const attempts =
        cacheDir && this.gameVersion ? extractionAttempts(cacheDir, this.gameVersion, appBuild) : 0;
      this.log(
        `offsets: unsupported for v${this.gameVersion ?? "?"} (source=${resolved.source}, critical missing: ${missing}, extract attempts=${attempts})`,
      );
    }
  }

  /**
   * Self-healing offset resolution:
   *   1. seed from the bundled table, else the disk cache;
   *   2. if the seed is missing OR incomplete (any wanted field still 0), and the
   *      per-version+build attempt budget is not exhausted, run the runtime
   *      extractor and MERGE its findings into the seed (filling only the gaps);
   *   3. persist the improved table so a future launch loads a complete cache.
   */
  private resolveOffsets(
    proc: WinProcess,
    appBuild: string,
  ): {
    table: LiveOffsets | null;
    source: OffsetResolutionSource;
    classIndex: Map<string, bigint> | null;
  } {
    const ga = this.ga;
    const version = this.gameVersion;
    const cacheDir = this.offsetCacheDir();

    let base: LiveOffsets | null = null;
    let source: OffsetResolutionSource = "none";

    const meta = offsetsForVersionMeta(version);
    // Track whether `base` came from a fallback table. Fallback RVAs may be
    // stale (the real game build moved TypeInfo slots), so the extractor MUST
    // run the full critical path (enrichmentOnly=false) to re-derive them —
    // even though hasCriticalOffsets(base) is true. Without this, the extractor
    // would take the enrichment-only path (because isSupported=true) and never
    // re-derive StageManager/StageCacheManager, leaving the reader with stale
    // RVAs that resolve to null → no DPS/XP/stage-clear data.
    let isFallbackTable = false;
    if (meta) {
      if (meta.fallback) {
        // Fallback to a same-major.minor version. Two-phase strategy:
        //
        //  Phase 1 (optimistic baseline): keep the fallback table's TypeInfo
        //  RVAs as a working baseline so `hasCriticalOffsets` returns true and
        //  the reader is marked supported. If the RVAs happen to match the
        //  real game build (common for small patches), live tracking flows
        //  immediately. The reader's resolve* helpers validate each pointer
        //  before use, so stale RVAs degrade gracefully to null.
        //
        //  Phase 2 (critical re-derivation): the extractor runs with
        //  enrichmentOnly=false (forced via isFallbackTable below) so it
        //  re-derives StageManager/StageCacheManager/CurrencyManager from
        //  live memory. Successfully derived RVAs overwrite the fallback
        //  baseline via mergeOffsets. If extraction fails (budget exhausted),
        //  the fallback RVAs remain in use — the reader stays supported but
        //  may return null data for stale anchors.
        //
        //  This is the fix for both "live 直接显示不支持了" AND "实现实时了但
        //  DPS/经验/通关记录都没数据": the old Rev 9 behavior zeroed every
        //  RVA on fallback (permanently unsupported after 3 failures); the
        //  Rev 10 bug kept the RVAs but ran the extractor in enrichment-only
        //  mode (never re-deriving critical anchors). Rev 10 + this fix keeps
        //  the RVAs AND forces critical re-derivation.
        isFallbackTable = true;
        base = meta.table;
        this.log(
          `resolve: bundled table for v${version} (fallback from v${meta.table.gameVersion} — RVAs kept as baseline; extractor will re-derive critical anchors)`,
        );
      } else {
        base = meta.table;
        this.log(`resolve: bundled table for v${version}`);
      }
      source = "bundled";
    } else if (cacheDir && version) {
      const cached = loadCachedOffsets(cacheDir, version, EXTRACTOR_REVISION);
      if (cached) {
        base = cached;
        source = "cache";
        this.log(`resolve: loaded disk cache for v${version}`);
      }
    }

    const complete = base != null && isOffsetTableComplete(base);
    // Catalog-dump diagnostic mode (TBH_DUMP_CATALOG_CANDIDATES=1): force the
    // extractor to run ONCE so the dump can fire, even when the cached table is
    // complete. After the first run, catalogDumpDone is set and subsequent
    // resolveOffsets calls take the normal fast path — otherwise the diagnostic
    // mode would re-run the 8-second extractor on every heal tick, breaking
    // live tracking.
    const forceExtractForCatalogDump =
      process.env.TBH_DUMP_CATALOG_CANDIDATES === "1" && !catalogDumpDone;
    if (complete && !forceExtractForCatalogDump) {
      this.log(`resolve: table complete (source=${source})`);
      return { table: base, source, classIndex: null };
    }

    if (complete && forceExtractForCatalogDump) {
      this.log(
        `resolve: table complete (source=${source}) — re-running extractor for catalog dump`,
      );
    } else {
      const missing = base ? missingOffsetFields(base).join(", ") : "entire table";
      this.log(`resolve: incomplete — missing ${missing}`);
    }

    if (ga && version && cacheDir) {
      const isSupported = base != null && hasCriticalOffsets(base);
      // Fallback tables keep their RVAs as a baseline (so isSupported=true), but
      // those RVAs may be stale for the real game build. Force the extractor to
      // run the FULL critical path (enrichmentOnly=false) so it re-derives
      // StageManager/StageCacheManager/CurrencyManager from live memory and
      // overwrites the stale baseline via mergeOffsets. Without this, the
      // extractor would take the enrichment-only path (because isSupported=true)
      // and never re-derive the critical anchors — the reader would stay
      // "supported" but return null for every live read (no DPS/XP/stage-clears).
      const forceCriticalPath = isFallbackTable;
      const useCriticalBudget = !isSupported || forceCriticalPath;
      // Enrichment and critical extractions have independent attempt budgets.
      // Critical (unsupported) scans are bounded by MAX_EXTRACTION_ATTEMPTS;
      // enrichment (supported) scans are bounded by MAX_ENRICHMENT_ATTEMPTS so
      // a version where BoxOpenLog is genuinely underivable until the player
      // opens a box does not get re-scanned every heal tick forever. A detected
      // box-open event resets the enrichment budget (see consumeBoxOpenEvent).
      // Catalog-dump mode bypasses the budget so the user can collect diagnostics
      // even after prior attempts exhausted the cap.
      const mayExtract =
        forceExtractForCatalogDump ||
        (useCriticalBudget
          ? mayAttemptExtraction(cacheDir, version, appBuild)
          : mayAttemptEnrichment(cacheDir, version, appBuild));
      if (mayExtract) {
        // Catalog-dump mode does not consume the attempt budget — it is a
        // diagnostic run, not a real extraction attempt.
        if (!forceExtractForCatalogDump) {
          if (useCriticalBudget) recordExtractionAttempt(cacheDir, version, appBuild);
          else recordEnrichmentAttempt(cacheDir, version, appBuild);
        }
        this.log(
          useCriticalBudget
            ? `resolve: running extractor (attempt ${extractionAttempts(cacheDir, version, appBuild)}/${MAX_EXTRACTION_ATTEMPTS})${forceCriticalPath ? " — fallback table, re-deriving critical anchors" : ""}`
            : `resolve: running extractor for enrichment (attempt ${enrichmentAttempts(cacheDir, version, appBuild)}/${MAX_ENRICHMENT_ATTEMPTS})`,
        );
        const derived = extractOffsets(
          proc,
          ga,
          version,
          (msg) => this.log(msg),
          !useCriticalBudget,
          base ?? undefined,
        );
        // Catalog dump completes after one extractor run regardless of outcome
        // (the dump fires inside extractOffsets when the env var is set).
        if (forceExtractForCatalogDump) catalogDumpDone = true;
        if (derived) {
          const merged = base ? mergeOffsets(base, derived.offsets) : derived.offsets;
          // Tag the persisted cache with the extractor revision so a future
          // reader launch with a newer revision knows to re-derive instead of
          // loading this stale cache.
          merged._extractorRev = EXTRACTOR_REVISION;
          saveCachedOffsets(cacheDir, merged);
          const mergedSource: OffsetResolutionSource = base ? "merged" : "extracted";
          this.log(`resolve: extractor ok → ${mergedSource}, persisted cache (rev ${EXTRACTOR_REVISION})`);
          return { table: merged, source: mergedSource, classIndex: derived.classIndex };
        }
        this.log(
          useCriticalBudget
            ? "resolve: extractor returned null (critical anchor failed)"
            : "resolve: extractor returned null (enrichment extraction failed)",
        );
      } else {
        const attempts = useCriticalBudget
          ? extractionAttempts(cacheDir, version, appBuild)
          : enrichmentAttempts(cacheDir, version, appBuild);
        const kind = useCriticalBudget ? "critical" : "enrichment";
        this.log(`resolve: extractor skipped (${kind} budget exhausted: ${attempts} attempts)`);
      }
    } else {
      this.log("resolve: extractor skipped (missing ga, version, or install dir)");
    }

    return { table: base, source, classIndex: null };
  }

  /**
   * Ensure {@link classIndex} is populated. When the reader attached from a
   * complete bundled/cache table (extractor skipped) or the extractor failed,
   * classIndex is still null — but the MonsterSpawnManager / PlayerSaveData
   * name-scan fallbacks need it. This builds the index on demand by scanning
   * only the GameAssembly.dll region (a few seconds), which is dramatically
   * faster than `resolveClassByName`'s whole-address-space scan (30–60s).
   * No-op when the index is already built or the GA/process is gone.
   */
  private ensureClassIndex(): void {
    if (this.classIndex != null) return;
    const p = this.proc;
    const ga = this.ga;
    if (!p || !ga || !p.isAlive()) return;
    const t0 = Date.now();
    this.classIndex = buildClassNameIndex(p, ga);
    this.log(
      `classIndex: built ${this.classIndex.size} entries from GA scan (${Date.now() - t0} ms)`,
    );
  }

  detach(): void {
    this.proc?.close();
    this.proc = null;
    this.ga = null;
    this.offsets = null;
    this.offsetSource = "none";
    this.supported = false;
    this.gameInstallDir = null;
    this.monsterNameScanAttempted = false;
    this.playerNameScanAttempted = false;
    this.playerPtr = null;
    this.classIndex = null;
    this.goldPin = makeGoldPinState();
    this.smPin = makeSmPinState();
    this.chestPin = makeChestLogPinState();
    this.stageClearPin = makeStageClearPinState();
    this.boxOpenPin = makeBoxOpenPinState();
    this.monsterPin = makeMonsterSpawnPinState();
    this.lowFreqTick = 0;
    this.lowFreqLoaded = false;
    this.cachedInventory = null;
    this.cachedPets = null;
    this.boxTypeCatalogMap = null;
    this.boxOpenCountPrev = null;
    this.boxOpenEventPending = false;
  }

  /** Live stage snapshot, or null when unattached/unsupported/unreadable. */
  read(): LiveMemorySnapshot | null {
    const p = this.proc;
    const o = this.offsets;
    const ga = this.ga;
    if (!p || !o || !ga) return null;
    if (!p.isAlive()) {
      this.detach();
      return null;
    }
    const t0 = Date.now();
    const smPtr = resolveStageManager(p, ga.base, ga.size, o, this.smPin);
    const stage = readRuntimeStage(p, ga.base, ga.size, o, smPtr);
    if (!stage) {
      // Diagnostic: when stage reads null after a successful offset resolution,
      // log the StageManager pin's last failure reason so the user (and dev)
      // can see WHY live data isn't flowing. Without this log, the worker
      // silently retries forever and the UI shows "supported but no data"
      // with no clue about the root cause (e.g. isLiveStageManager failing
      // because the party isn't deployed, or heroList offset wrong for this
      // game version). Throttled to once per 10s to avoid log spam.
      const now = Date.now();
      if (this.smPin.lastStatus && now - (this.lastSmFailLogAt ?? 0) > 10_000) {
        this.lastSmFailLogAt = now;
        this.log(`read: stage null — smPtr=${smPtr ? "0x" + smPtr.toString(16) : "null"} ${this.smPin.lastStatus}`);
      }
      return null;
    }

    // Resolve MonsterSpawnManager: bundled RVA may point to wrong class in some versions.
    // Try RVA first; if no monsters found, fall back to name-string scan (meter approach).
    // Name scan is expensive (~30–60s) — only run once, cache pin for subsequent ticks.
    let monsterData = readRuntimeMonsterHp(p, ga.base, ga.size, o, this.monsterPin);
    if (
      !this.monsterNameScanAttempted &&
      (this.monsterPin.ptr == null || (monsterData?.monsterHps?.length ?? 0) === 0)
    ) {
      this.monsterNameScanAttempted = true;
      this.log("MonsterSpawnManager: RVA resolution produced no monsters, resolving class...");
      try {
        this.setScanning(true);
        // Fast path: the GA-derived class index usually has MonsterSpawnManager
        // already (its TypeInfo sits in a GA static slot). Only fall back to the
        // ~30–60s whole-address-space scan when the index misses.
        this.ensureClassIndex();
        const msClassFromIndex = this.classIndex?.get("MonsterSpawnManager") ?? null;
        const msClass = msClassFromIndex ?? resolveClassByName(p, "MonsterSpawnManager", ga);
        if (msClassFromIndex) {
          this.log("MonsterSpawnManager: class resolved via GA index (skipped name scan)");
        }
        if (msClass) {
          const inst = singletonFromClass(p, msClass);
          if (inst) {
            this.monsterPin.ptr = inst;
            this.log(`MonsterSpawnManager: resolved at 0x${inst.toString(16)}`);
            monsterData = readRuntimeMonsterHp(p, ga.base, ga.size, o, this.monsterPin);
          }
        }
      } finally {
        this.setScanning(false);
      }
    }
    const monsterHp = monsterData?.monsterHps ?? null;
    const deadMonsterCount = monsterData?.deadCount ?? null;

    const heroesResult = readRuntimeHeroes(p, o, smPtr);
    const heroesStatus =
      heroesResult.heroes == null &&
      this.smPin.lastStatus &&
      heroesResult.status.includes("StageManager unresolved")
        ? this.smPin.lastStatus
        : heroesResult.status || undefined;

    const chestResult = readRuntimeChestLog(p, ga.base, ga.size, o, this.chestPin);
    const boxOpenResult = readRuntimeBoxOpenLog(p, ga.base, ga.size, o, this.boxOpenPin);

    // Box-open event detection: when enrichment is incomplete (typically
    // boxOpenLog.itemStringKey/itemGradeType still 0), probe the BoxOpenLog
    // list length cheaply (no entry reads, no itemStringKey needed). A
    // 0→>0 transition means the player just opened a box → the BoxOpenLog
    // class is now instantiated → the next enrichment extraction will succeed.
    // The flag is consumed by the worker to reset the enrichment budget and
    // trigger an immediate heal instead of waiting up to 15s.
    if (this.supported && !this.enrichmentComplete) {
      const peek = peekBoxOpenLogCount(p, ga.base, ga.size, o, this.boxOpenPin);
      if (peek.count != null) {
        const prev = this.boxOpenCountPrev ?? 0;
        if (prev === 0 && peek.count > 0 && !this.boxOpenEventPending) {
          this.boxOpenEventPending = true;
          this.log(
            `box-open event detected: BoxOpenLog count 0→${peek.count}, will trigger enrichment heal`,
          );
        }
        this.boxOpenCountPrev = peek.count;
      }
    }

    // Inventory and pets change slowly (only on save events / menu actions),
    // so re-read them on a low-frequency cadence and reuse the cached arrays
    // on intervening ticks. This avoids allocating up to 100k inventory items
    // 25 times per second.
    this.lowFreqTick++;
    if (!this.lowFreqLoaded || this.lowFreqTick >= LiveMemoryReader.LOW_FREQ_EVERY_N_TICKS) {
      this.lowFreqTick = 0;
      this.lowFreqLoaded = true;
      this.cachedInventory = readRuntimeInventory(p, ga.base, ga.size, o, this.playerPtr);
      this.cachedPets = readRuntimePets(p, ga.base, ga.size, o, this.playerPtr);

      // PlayerSaveData name-scan fallback: when RVA resolution produced no player
      // instance (CommonSaveData static field unreadable), fall back to scanning
      // memory for the singleton class. The save-layer anchor is
      // `TaskbarHero.CommonSaveData` (a static singleton holding the player's
      // PetSaveData / itemSaveDatas / BoxData fields). `PlayerSaveData` is a
      // distinct class that is NOT singleton-held — searching for it directly
      // finds the class but no instance. Try CommonSaveData first; if that
      // fails, fall back to PlayerSaveData for legacy versions where the
      // naming/structure differed.
      if (
        !this.playerNameScanAttempted &&
        this.playerPtr == null &&
        this.cachedInventory.items == null &&
        this.cachedPets.pets == null &&
        (/\bCommonSaveData singleton.*static field unreadable/i.test(this.cachedInventory.status) ||
          /\bCommonSaveData singleton.*static field unreadable/i.test(this.cachedPets.status))
      ) {
        this.playerNameScanAttempted = true;
        this.log("PlayerSaveData: RVA resolution produced no player instance, resolving class...");
        try {
          this.setScanning(true);
          // Fast path: GA-derived class index (see MonsterSpawnManager above).
          this.ensureClassIndex();
          // Candidate singleton class names in priority order. CommonSaveData
          // is the real anchor (per LiveOffsets.typeInfoRva.commonSaveData
          // comment); PlayerSaveData is a legacy fallback.
          const candidates = ["CommonSaveData", "PlayerSaveData"];
          for (const name of candidates) {
            const classFromIndex = this.classIndex?.get(name) ?? null;
            const cls = classFromIndex ?? resolveClassByName(p, name, ga);
            if (cls == null) continue;
            if (classFromIndex) {
              this.log(`${name}: class resolved via GA index (skipped name scan)`);
            }
            let inst = this.findPlayerInstanceByClass(p, cls);
            if (inst == null) {
              // TEMPORARY DIAGNOSTIC: wider scan with class layout dump.
              inst = this.probeClassLayout(p, name, cls);
            }
            if (inst) {
              this.playerPtr = inst;
              this.log(`${name}: singleton resolved at 0x${inst.toString(16)}`);
              this.cachedInventory = readRuntimeInventory(p, ga.base, ga.size, o, this.playerPtr);
              this.cachedPets = readRuntimePets(p, ga.base, ga.size, o, this.playerPtr);
              break;
            } else {
              this.log(`${name}: class found but no static-held instance`);
            }
          }
        } finally {
          this.setScanning(false);
        }
      }
    }

    // Live chest slot counts (high-frequency, every tick). Falls back to null
    // when offsets unavailable — the renderer falls back to save-derived counts.
    const chestSlotsResult: ReadChestSlotsResult = readRuntimeChestSlots(
      p,
      ga.base,
      ga.size,
      o,
      this.getBoxTypeCatalogMap(),
      this.playerPtr,
    );

    return {
      connected: true,
      stageKey: stage.stageKey,
      stageWave: stage.wave,
      stageWaveTotal: stage.waveTotal,
      // Combat gold (AggregateSaveData GoldEarn[SubKey=1]) — pure combat earnings.
      // Falls back to wallet balance (CurrencyManager) when aggregate offset unavailable.
      gold:
        readRuntimeCombatGold(p, ga.base, ga.size, o) ??
        readRuntimeGold(p, ga.base, ga.size, o, this.goldPin),
      heroes: heroesResult.heroes,
      heroesStatus,
      chestDrops: chestResult.drops,
      chestDropsStatus: chestResult.status || undefined,
      chestLogDebug: chestResult.debug,
      chestSlots: chestSlotsResult.slots,
      chestSlotsStatus: chestSlotsResult.status || undefined,
      boxOpens: boxOpenResult.opens,
      boxOpensStatus: boxOpenResult.status || undefined,
      stageClears: readRuntimeStageClears(p, ga.base, ga.size, o, this.stageClearPin),
      inventoryItems: this.cachedInventory?.items ?? null,
      inventoryItemsStatus: this.cachedInventory?.status || undefined,
      petData: this.cachedPets?.pets ?? null,
      petDataStatus: this.cachedPets?.status || undefined,
      monsterHp,
      deadMonsterCount,
      source: `memory v${o.gameVersion}`,
      readMs: Date.now() - t0,
      at: Date.now(),
    };
  }

  /** Lazy-init the boxType → BoxCategory map from the bundled catalog. */
  private getBoxTypeCatalogMap(): ReadonlyMap<number, BoxCategory> {
    if (this.boxTypeCatalogMap == null) {
      try {
        const catalog = loadBoxTypeCatalog();
        const idx = boxTypeIndex(catalog);
        this.boxTypeCatalogMap = new Map(
          Array.from(idx.entries()).map(([k, v]) => [k, v.category] as const),
        );
      } catch (err) {
        // Catalog missing/unreadable — fall back to empty map (all BoxTypes
        // become "unknown" and slots stays {0,0,0}; better than crashing).
        this.log(`boxType catalog load failed: ${(err as Error).message}`);
        this.boxTypeCatalogMap = new Map();
      }
    }
    return this.boxTypeCatalogMap;
  }

  /**
   * Scan a class's static block (and its parent's) for a pointer whose IL2CPP
   * header class matches `classPtr`. Returns the instance pointer or null.
   */
  private findPlayerInstanceByClass(proc: WinProcess, classPtr: bigint): bigint | null {
    const targets = [classPtr];
    const parentBuf = proc.readBytes(classPtr + 0x58n, 8);
    if (parentBuf) {
      const parent = parentBuf.readBigUInt64LE();
      if (parent > 0x10000n && parent < 0x7ff0_0000_0000n) targets.push(parent);
    }

    for (const target of targets) {
      for (const soff of [0xb0, 0xb8, 0xa8]) {
        const blockBuf = proc.readBytes(target + BigInt(soff), 8);
        if (!blockBuf) continue;
        const block = blockBuf.readBigUInt64LE();
        if (block <= 0x10000n || block >= 0x7ff0_0000_0000n) continue;

        const SCAN_MAX = 0x200;
        for (let foff = 0; foff <= SCAN_MAX; foff += 8) {
          const instBuf = proc.readBytes(block + BigInt(foff), 8);
          if (!instBuf) continue;
          const inst = instBuf.readBigUInt64LE();
          if (inst <= 0x10000n || inst >= 0x7ff0_0000_0000n) continue;

          const headerBuf = proc.readBytes(inst, 8);
          if (!headerBuf) continue;
          const header = headerBuf.readBigUInt64LE();
          if (header === classPtr) return inst;
        }
      }
    }
    return null;
  }

  /**
   * TEMPORARY DIAGNOSTIC: dump a class's memory layout (0x00–0xC0) and
   * scan a wider range of static-field-block candidates to find a singleton
   * instance. Used when `findPlayerInstanceByClass` fails — logs the class
   * header, parent pointer, and any plausible static field blocks + their
   * pointer-like contents, so the player can identify where the singleton
   * is stored on the current game version.
   *
   * Returns the instance pointer if found via the wider scan, else null.
   */
  private probeClassLayout(proc: WinProcess, className: string, classPtr: bigint): bigint | null {
    // 1) Dump class header (0x00–0xC0) to find static field block offset.
    this.log(`┌─ probeClassLayout: ${className} @ 0x${classPtr.toString(16)}`);
    const HEADER_SIZE = 0xc0;
    const headerBytes = proc.readBytes(classPtr, HEADER_SIZE);
    if (headerBytes == null) {
      this.log("│  class header unreadable");
      this.log("└─ probeClassLayout done");
      return null;
    }
    // Log 8-byte chunks as hex + flag pointer-like values.
    for (let off = 0; off < HEADER_SIZE; off += 8) {
      const v = headerBytes.readBigUInt64LE(off);
      const isPtr = v > 0x10000n && v < 0x7ff0_0000_0000n;
      this.log(
        `│  +0x${off.toString(16).padStart(2, "0")}: 0x${v.toString(16).padStart(16, "0")}${isPtr ? "  [ptr]" : ""}`,
      );
    }

    // 2) Wider scan: try all pointer-like values in the class header as
    //    potential static-field-block pointers. For each, scan 0x400 bytes
    //    (wider than findPlayerInstanceByClass's 0x200) for instances whose
    //    header matches classPtr OR whose header's parent chain includes
    //    classPtr (subclass instance).
    const ptrCandidates: { off: number; block: bigint }[] = [];
    for (let off = 0; off < HEADER_SIZE; off += 8) {
      const v = headerBytes.readBigUInt64LE(off);
      if (v > 0x10000n && v < 0x7ff0_0000_0000n) {
        ptrCandidates.push({ off, block: v });
      }
    }
    this.log(`│  ${ptrCandidates.length} pointer-like candidates in class header`);

    for (const { off, block } of ptrCandidates) {
      const SCAN_MAX = 0x400;
      let foundCount = 0;
      for (let foff = 0; foff <= SCAN_MAX; foff += 8) {
        const instBuf = proc.readBytes(block + BigInt(foff), 8);
        if (!instBuf) continue;
        const inst = instBuf.readBigUInt64LE();
        if (inst <= 0x10000n || inst >= 0x7ff0_0000_0000n) continue;

        const instHeaderBuf = proc.readBytes(inst, 8);
        if (!instHeaderBuf) continue;
        const instHeader = instHeaderBuf.readBigUInt64LE();

        // Direct match
        if (instHeader === classPtr) {
          this.log(
            `│  ✓ FOUND at header+0x${off.toString(16)} block+0x${foff.toString(16)}: instance 0x${inst.toString(16)} (klass matches directly)`,
          );
          // TEMPORARY DIAGNOSTIC: dump the instance's class fields so we can
          // see the actual field names on v1.00.28 (may be obfuscated short
          // random strings). This tells us whether BoxData / PetSaveData /
          // itemSaveDatas fields exist with their original names or have
          // been renamed, which determines whether we can use name-based
          // field lookup or need structural detection.
          try {
            const fields = readClassFields(proc, instHeader);
            if (fields == null) {
              this.log("│  instance class fields: <unreadable>");
            } else if (fields.size === 0) {
              this.log("│  instance class fields: <empty>");
            } else {
              const fieldList: string[] = [];
              for (const [fname, foff2] of fields) {
                fieldList.push(`${fname}=0x${foff2.toString(16)}`);
              }
              this.log(`│  instance class fields (${fields.size}): ${fieldList.join(", ")}`);
            }
          } catch (err) {
            this.log(`│  instance class fields dump failed: ${String(err)}`);
          }
          this.log("└─ probeClassLayout done");
          return inst;
        }

        // Subclass match: walk instHeader's parent chain (up to 4 levels).
        let cls = instHeader;
        for (let depth = 0; depth < 4; depth++) {
          const parentBuf2 = proc.readBytes(cls + 0x58n, 8);
          if (!parentBuf2) break;
          const parent = parentBuf2.readBigUInt64LE();
          if (parent <= 0x10000n || parent >= 0x7ff0_0000_0000n) break;
          if (parent === classPtr) {
            this.log(
              `│  ✓ FOUND at header+0x${off.toString(16)} block+0x${foff.toString(16)}: instance 0x${inst.toString(16)} (klass=0x${instHeader.toString(16)} is subclass at depth ${depth + 1})`,
            );
            this.log("└─ probeClassLayout done");
            return inst;
          }
          cls = parent;
        }

        // Track for diagnostics: log first few pointer-like values that
        // aren't a match, so the player can see what's in the static block.
        if (foundCount < 5) {
          this.log(
            `│  header+0x${off.toString(16)} block+0x${foff.toString(16)}: → 0x${inst.toString(16)} (klass=0x${instHeader.toString(16)})`,
          );
        }
        foundCount++;
      }
      if (foundCount > 0) {
        this.log(`│  header+0x${off.toString(16)}: ${foundCount} pointer-like values scanned`);
      }
    }

    this.log("│  no singleton instance found via wider scan");
    this.log("└─ probeClassLayout done");
    return null;
  }

  status(appBuild: string = resolveAppBuild()): LiveMemoryStatus {
    const cacheDir = this.offsetCacheDir();
    const attempts =
      cacheDir && this.gameVersion
        ? extractionAttempts(cacheDir, this.gameVersion, appBuild)
        : undefined;
    return {
      running: true,
      attached: this.attached,
      pid: this.pid,
      gameVersion: this.gameVersion,
      supported: this.supported,
      scanning: this.scanning,
      note:
        this.attached && !this.supported
          ? `live stats unavailable for game v${this.gameVersion ?? "?"}`
          : undefined,
      offsetHealth: this.offsets
        ? {
            complete: isOffsetTableComplete(this.offsets),
            missing: missingOffsetFields(this.offsets),
            source: this.offsetSource,
            extractionAttempts: attempts,
          }
        : this.attached
          ? {
              complete: false,
              missing: [],
              source: this.offsetSource,
              extractionAttempts: attempts,
            }
          : undefined,
    };
  }
}
