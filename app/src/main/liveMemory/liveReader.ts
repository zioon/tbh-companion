// Attaches read-only to the game, resolves offsets by version, and produces a
// live snapshot. Impure glue: the read algorithm lives in core/liveMemory; this
// wires it to the real koffi-backed WinProcess. utilityProcess only.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { offsetsForVersion, type LiveOffsets } from "../../core/liveMemory/offsets";
import {
  hasCriticalOffsets,
  isOffsetTableComplete,
  mergeOffsets,
  missingOffsetFields,
} from "../../core/liveMemory/offsetCompleteness";
import { buildClassNameIndex, extractOffsets } from "./offsetExtractor";
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

    const bundled = offsetsForVersion(version);
    if (bundled) {
      base = bundled;
      source = "bundled";
      this.log(`resolve: bundled table for v${version}`);
    } else if (cacheDir && version) {
      const cached = loadCachedOffsets(cacheDir, version);
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
        (isSupported
          ? mayAttemptEnrichment(cacheDir, version, appBuild)
          : mayAttemptExtraction(cacheDir, version, appBuild));
      if (mayExtract) {
        // Catalog-dump mode does not consume the attempt budget — it is a
        // diagnostic run, not a real extraction attempt.
        if (!forceExtractForCatalogDump) {
          if (!isSupported) recordExtractionAttempt(cacheDir, version, appBuild);
          else recordEnrichmentAttempt(cacheDir, version, appBuild);
        }
        this.log(
          isSupported
            ? `resolve: running extractor for enrichment (attempt ${enrichmentAttempts(cacheDir, version, appBuild)}/${MAX_ENRICHMENT_ATTEMPTS})`
            : `resolve: running extractor (attempt ${extractionAttempts(cacheDir, version, appBuild)}/${MAX_EXTRACTION_ATTEMPTS})`,
        );
        const derived = extractOffsets(proc, ga, version, (msg) => this.log(msg), isSupported);
        // Catalog dump completes after one extractor run regardless of outcome
        // (the dump fires inside extractOffsets when the env var is set).
        if (forceExtractForCatalogDump) catalogDumpDone = true;
        if (derived) {
          const merged = base ? mergeOffsets(base, derived.offsets) : derived.offsets;
          saveCachedOffsets(cacheDir, merged);
          const mergedSource: OffsetResolutionSource = base ? "merged" : "extracted";
          this.log(`resolve: extractor ok → ${mergedSource}, persisted cache`);
          return { table: merged, source: mergedSource, classIndex: derived.classIndex };
        }
        this.log(
          isSupported
            ? "resolve: extractor returned null (enrichment extraction failed)"
            : "resolve: extractor returned null (critical anchor failed)",
        );
      } else {
        const attempts = isSupported
          ? enrichmentAttempts(cacheDir, version, appBuild)
          : extractionAttempts(cacheDir, version, appBuild);
        const kind = isSupported ? "enrichment" : "critical";
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
    if (!stage) return null;

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
      // memory for the PlayerSaveData class and its static-held singleton. This
      // mirrors the MonsterSpawnManager fallback above and is cached on the pin.
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
          const playerClassFromIndex = this.classIndex?.get("PlayerSaveData") ?? null;
          const playerClass = playerClassFromIndex ?? resolveClassByName(p, "PlayerSaveData", ga);
          if (playerClassFromIndex) {
            this.log("PlayerSaveData: class resolved via GA index (skipped name scan)");
          }
          if (playerClass) {
            const inst = this.findPlayerInstanceByClass(p, playerClass);
            if (inst) {
              this.playerPtr = inst;
              this.log(`PlayerSaveData: resolved at 0x${inst.toString(16)}`);
              this.cachedInventory = readRuntimeInventory(p, ga.base, ga.size, o, this.playerPtr);
              this.cachedPets = readRuntimePets(p, ga.base, ga.size, o, this.playerPtr);
            } else {
              this.log("PlayerSaveData: class found but no static-held instance");
            }
          } else {
            this.log("PlayerSaveData: class not found by name scan");
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
