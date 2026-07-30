// Attaches read-only to the game, resolves offsets by version, and produces a
// live snapshot. Impure glue: the read algorithm lives in core/liveMemory; this
// wires it to the real koffi-backed WinProcess. utilityProcess only.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  offsetsForVersion,
  offsetsForVersionMeta,
  type LiveOffsets,
} from "../../core/liveMemory/offsets";
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
  resetExtractionAttempts,
} from "./offsetHealing";
import {
  resolveLiveMemoryOffsetCacheDir,
  resolveLiveMemoryUserDataDir,
} from "./liveMemoryCacheDir";
import {
  makeBoxOpenPinState,
  makeChestLogPinState,
  makeCombatGoldPinState,
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
  type CombatGoldPinState,
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
import type {
  BoxCategory,
  BoxOpenEntry,
  LiveMemorySnapshot,
  LiveMemoryStatus,
} from "../../../shared/types";
import type { LiveChestCategory } from "../../core/liveMemory/runtime";

const PROCESS_NAMES = ["TaskBarHero.exe", "TaskbarHero.exe"];

/**
 * Throttle window for the per-status failure diagnostic log. When chest drops
 * / box opens / chest slots return a non-empty status, the worker emits a
 * log line at most once per window so silent degradation is visible in
 * main.log without spamming the 25 Hz tick loop.
 */
const STATUS_FAIL_LOG_THROTTLE_MS = 30_000;

/**
 * How long `readRuntimeBoxOpenLog` must continuously return "list not
 * walkable" / "dict lookup failed" while chest drops resolve normally
 * (LogManager itself is fine) before the reader concludes the cached
 * `getItemWithBoxOpenTypeKey` / `boxOpenLog.itemStringKey` values are
 * unvalidated baseline copies (cache pollution) and forces the extractor
 * to re-derive them. 60 s balances "give the game time to actually open a
 * box" against "don't make the user wait too long after a bad cache".
 */
const BOX_OPEN_FAIL_HEAL_MS = 60_000;

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
 * True when `offsets` carries a `_fallbackFromVersion` marker AND its critical
 * RVAs (stageManager / stageCacheManager) still match the original bundled
 * fallback baseline. When they match, the extractor has not yet re-derived
 * fresh anchors for the current build — live reads may resolve to wrong
 * classes (returning null). When they differ, a previous session's extractor
 * already overwrote the stale baseline via mergeOffsets, so the table is
 * safe to use without forcing the critical path again.
 *
 * Extractor-ran exception: if `offsets._extractorRev` is present, the
 * extractor already ran in a prior session. Two outcomes are possible:
 *  (a) derived critical RVAs were non-zero → mergeOffsets overwrote the
 *      baseline → the RVA-equality check above returns false anyway;
 *  (b) derived critical RVAs were zero (StageManager singleton not
 *      instantiated, e.g. user was at the main menu) → mergeOffsets kept
 *      the baseline → RVA-equality check returns true, but re-running the
 *      extractor will produce the same outcome (StageManager still not
 *      instantiated, or the game genuinely didn't change so derived == 0
 *      again). Without this exception, the reader enters an infinite loop:
 *      every 30s Path 3 triggers healOffsets → extractor runs ~8-10s →
 *      same result → cache saved → next 30s same trigger. User-visible
 *      symptom: live page flips to "scanning" for ~10s every ~30s.
 * The extractor-ran marker lets the reader trust that the baseline is
 * either confirmed-correct or unrecoverable (the user must enter a stage
 * for StageManager to instantiate; the reader can't force that). The user
 * can still manually clear the cache to force a fresh extraction.
 *
 * Pure (no `this`), so it can be called from `resolveOffsets` before
 * `this.offsets` is updated.
 */
function isCriticalStaleOnBaseline(offsets: LiveOffsets | null): boolean {
  if (!offsets?._fallbackFromVersion) return false;
  // Extractor already ran — trust its outcome (see comment above).
  if (offsets._extractorRev != null) return false;
  const baseline = offsetsForVersion(offsets._fallbackFromVersion);
  if (!baseline) return false;
  return (
    offsets.typeInfoRva.stageManager === baseline.typeInfoRva.stageManager &&
    offsets.typeInfoRva.stageCacheManager === baseline.typeInfoRva.stageCacheManager
  );
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
  private combatGoldPin: CombatGoldPinState = makeCombatGoldPinState();
  private smPin: SmPinState = makeSmPinState();
  private chestPin: ChestLogPinState = makeChestLogPinState();
  private stageClearPin: StageClearPinState = makeStageClearPinState();
  private boxOpenPin: BoxOpenPinState = makeBoxOpenPinState();
  private monsterPin: MonsterSpawnPinState = makeMonsterSpawnPinState();
  /** Throttle for the "read: stage null" diagnostic log (avoid spamming every tick). */
  private lastSmFailLogAt: number | null = null;
  /**
   * Throttle for the per-status failure diagnostic log. When any of
   * chestDrops / boxOpens / chestSlots returns a non-empty status (offset
   * derived but runtime lookup failed, etc.), the worker emits a throttled
   * log line every ~30s so silent degradation is visible in main.log.
   */
  private lastStatusFailLogAt: number | null = null;
  /**
   * Cache-pollution self-heal detector. Fires when a runtime dict lookup
   * keeps failing for `BOX_OPEN_FAIL_HEAL_MS` — the cached offset values
   * are non-zero but invalid (unvalidated baseline copies from a fallback
   * table, or a stale RVA the extractor never re-derived).
   *
   * Covers two failure signatures:
   *  - **boxOpen dict-fail** (`readRuntimeBoxOpenLog` returns "list not
   *    walkable" / "dict lookup failed"): `getItemWithBoxOpenTypeKey` /
   *    `boxOpenLog.itemStringKey` are polluted. Originally the ONLY signal;
   *    required chest drops to be healthy so a genuinely missing LogManager
   *    didn't trigger a pointless extractor run.
   *  - **chest drops dict-fail** (`readRuntimeChestDrops` returns "GetBox
   *    log list not walkable (runtime.log.logByType dict lookup failed)"):
   *    the `logManager` TypeInfo RVA itself is stale/invalid for the
   *    current build, or `runtime.log.logByType` is a polluted baseline.
   *    This is the v1.01.02-fallback-from-v1.01.01 signature: the cache
   *    carries v1.01.01's LogManager RVA which doesn't resolve to the
   *    correct class on v1.01.02, so the dict lookup fails on every tick.
   *    When BOTH chest drops AND boxOpen fail, LogManager itself is the
   *    problem — the extractor MUST re-run to re-derive the RVA (the
   *    `isCriticalStaleOnBaseline` guard intentionally skips this when
   *    `_extractorRev` is set, so the cache-pollution path is the only
   *    remaining trigger).
   *
   * When either signal persists for 60s, set `forceExtractorNextHeal` so
   * the worker bypasses the `isOffsetTableComplete` short-circuit AND the
   * per-budget attempt cap, forcing a fresh extractor run. The flag is
   * one-shot (cleared after the extractor runs) so we can't loop forever.
   */
  private dictFailSince: number | null = null;
  /**
   * One-shot flag consumed by `resolveOffsets`. When true, the next
   * `resolveOffsets` call skips the `isOffsetTableComplete` short-circuit
   * AND bypasses the per-budget attempt cap, forcing the extractor to run
   * even on a "complete" cached/bundled table. Cleared after the extractor
   * runs (success or failure) so we don't loop forever.
   */
  private forceExtractorNextHeal = false;
  private gameInstallDir: string | null = null;
  private readonly userDataDir: string;
  private log: LiveMemoryLogFn = () => undefined;
  /** True once we've attempted name-based MonsterSpawnManager resolution (avoid re-scan). */
  private monsterNameScanAttempted = false;
  /** True once we've attempted name-based PlayerSaveData resolution (avoid re-scan). */
  private playerNameScanAttempted = false;
  /**
   * Set by `read()` when MonsterSpawnManager RVA produced no monsters and the
   * expensive name-scan fallback should run. Consumed by
   * {@link runPendingNameScans}, which the worker calls BEFORE the next read
   * tick — this keeps the read path pure (no 30–60s blocking FFI inside the
   * 25 Hz loop) and lets the worker continue emitting snapshots at the
   * pre-scan rate during the scan itself.
   */
  private monsterNameScanPending = false;
  /** Same as {@link monsterNameScanPending} but for PlayerSaveData resolution. */
  private playerNameScanPending = false;
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
   * True when the offset table carries an `_extractorRev` marker, indicating
   * the extractor already ran at least once for this game version (either in
   * a prior session and persisted to cache, or earlier this session). Used by
   * the worker's Path 2 (fallback enrichment heal) to decide whether to
   * `resetEnrichmentBudget` before calling `healOffsets`:
   *
   *  - false (first launch, no prior extractor run): Path 2 resets the
   *    enrichment budget so the extractor gets its first turn.
   *  - true (extractor already ran): Path 2 does NOT reset the budget. If
   *    enrichment succeeded, `enrichmentComplete` is true and Path 2 skips
   *    entirely. If enrichment failed (e.g. scanner can't identify the
   *    version's BoxOpenLog field layout — see v1.01.02 obscured field bug),
   *    `enrichmentComplete` is false but `mayAttemptEnrichment` returns false
   *    (budget exhausted) → `resolveOffsets` short-circuits the extractor →
   *    `healOffsets` returns in milliseconds instead of ~9s. Without this
   *    guard, Path 2 would reset the budget every 30s, re-running the ~9s
   *    extractor with the same validation failure forever — user-visible
   *    symptom: live page flips to "scanning" for ~9s every ~30s.
   *
   * Path 1 (box-open event) and Path 1.5 (cache-pollution) still call
   * `resetEnrichmentBudget` unconditionally because they carry new signals
   * (player opened a box / cache values confirmed invalid) that warrant a
   * fresh extractor run regardless of prior attempts.
   */
  get enrichmentAlreadyAttempted(): boolean {
    return this.offsets?._extractorRev != null;
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
   * True when the reader has detected a likely cache-pollution condition
   * (box-open dict lookup failing continuously while chest drops resolve)
   * and the next `healOffsets` should force the extractor to re-derive
   * enrichment fields, bypassing the `isOffsetTableComplete` short-circuit
   * and the per-budget attempt cap. Consumed by the worker's
   * `maybeHealEnrichment` to trigger an immediate heal, and by
   * `resolveOffsets` to bypass the complete-table short-circuit.
   */
  get needsForcedReextract(): boolean {
    return this.forceExtractorNextHeal;
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

  /**
   * Reset the critical extraction attempt counter to 0 so the next heal tick
   * is allowed to retry critical anchor derivation. Called by the worker while
   * the reader is on a fallback table whose critical RVAs have not yet been
   * re-derived by the extractor — breaks the "3 critical failures → permanently
   * stuck on stale baseline" deadlock when attach happened before the
   * StageManager singleton was instantiated (e.g. player in main menu).
   */
  resetCriticalExtractionBudget(): void {
    const cacheDir = this.offsetCacheDir();
    const version = this.gameVersion;
    if (cacheDir && version) {
      resetExtractionAttempts(cacheDir, version, resolveAppBuild());
    }
  }

  /**
   * True when the current offset table is a same-major.minor fallback whose
   * critical RVAs (stageManager / stageCacheManager) have NOT yet been
   * re-derived by the extractor. Detection: compare current RVAs against the
   * original bundled fallback table's RVAs. When they match the baseline,
   * derived has not overwritten yet — the reader is reading from stale RVAs
   * that may resolve to wrong classes (returning null data).
   *
   * Used by the worker to drive a periodic critical-budget reset + heal while
   * the player remains in main menu, so the extractor retries the moment the
   * player enters a stage and StageManager instantiates. Without this, the
   * 3-failure critical budget would permanently block re-derivation.
   */
  get isCriticalStaleOnFallback(): boolean {
    return isCriticalStaleOnBaseline(this.offsets);
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
   *
   * When the reader is on a fallback table whose critical RVAs have NOT been
   * re-derived yet (StageManager singleton was not instantiated at attach
   * time), the critical extraction budget is reset before resolving. This
   * breaks the "3 critical failures → permanently stuck on stale baseline"
   * deadlock when the player later enters a stage. Without the reset, the
   * extractor would never retry, the reader would stay "supported" (fallback
   * baseline has critical fields) but all live reads would resolve to wrong
   * classes → null data — the symptom reported as "全部都没有" on v1.01.02
   * when attach happened from the main menu.
   */
  healOffsets(appBuild: string = resolveAppBuild()): void {
    const proc = this.proc;
    if (!proc?.isAlive()) return;

    if (this.isCriticalStaleOnFallback) {
      this.log(
        `heal: fallback table critical RVAs still on baseline (v${this.offsets?._fallbackFromVersion}); resetting critical budget to retry`,
      );
      this.resetCriticalExtractionBudget();
    }

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
    } else if (this.isCriticalStaleOnFallback) {
      // Still stale after heal — extractor either failed (singleton not up
      // yet) or returned derived RVAs that happened to match the baseline.
      // The worker's fallback heal timer will retry on the 30s cadence.
      this.log(
        `heal: still on stale baseline RVAs for v${this.gameVersion} (fallback from v${this.offsets?._fallbackFromVersion})`,
      );
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
    // Track whether `base` carries a `_fallbackFromVersion` marker — either
    // from a fresh fallback table OR from a prior session's merged cache (the
    // marker is preserved across mergeOffsets for provenance). When the marker
    // is present AND critical RVAs still match the baseline, the extractor
    // must run the full critical path to re-derive them. Once derived RVAs
    // have overwritten the baseline (detected via isCriticalStaleOnBaseline),
    // the critical path is no longer forced — the cache is trusted.
    let isFallbackTable = false;
    if (meta) {
      base = meta.table;
      isFallbackTable = meta.fallback;
      source = "bundled";
      this.log(
        meta.fallback
          ? `resolve: bundled table for v${version} (fallback from v${meta.table.gameVersion} — RVAs kept as baseline; extractor will re-derive critical anchors if still stale)`
          : `resolve: bundled table for v${version}`,
      );
    }

    // Even when a bundled/fallback table exists, prefer a more complete (or
    // equally complete but extractor-validated) disk cache. Without this, a
    // version whose bundled table is enrichment-incomplete (typical —
    // logManager/boxOpenLog/stageClearLog struct offsets are runtime-derived)
    // would re-run the ~8s extractor on every launch, even though the previous
    // session already persisted a fully-derived table. Same applies to fallback
    // versions: once the extractor has re-derived fresh critical RVAs and
    // merged them into the cache, the cache is more authoritative than the
    // stale baseline. The cache's `_extractorRev` stamp gates staleness — a
    // newer extractor revision automatically invalidates the cache and falls
    // back to the bundled table.
    if (cacheDir && version) {
      const cached = loadCachedOffsets(cacheDir, version, EXTRACTOR_REVISION);
      if (cached) {
        const baseMissing = base ? missingOffsetFields(base).length : Infinity;
        const cacheMissing = missingOffsetFields(cached).length;
        // Prefer cache when:
        //   - no bundled/fallback table (unknown version), OR
        //   - cache is strictly more complete (extractor filled gaps), OR
        //   - cache is equally complete but is the previously live-validated
        //     extractor output (vs the static bundled table).
        if (!base || cacheMissing <= baseMissing) {
          base = cached;
          // Preserve fallback marker — a prior session's merged cache carries
          // `_fallbackFromVersion` for provenance, and the stale-on-baseline
          // check below uses it to decide whether critical re-derivation is
          // still needed.
          isFallbackTable = !!cached._fallbackFromVersion;
          source = "cache";
          this.log(
            `resolve: loaded disk cache for v${version} (cache missing=${cacheMissing}, bundled missing=${baseMissing === Infinity ? "n/a" : baseMissing})`,
          );
        }
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
    // Cache-pollution self-heal: when `readRuntimeBoxOpenLog` has been failing
    // "dict lookup failed" for >60s while chest drops resolve normally, the
    // cached `getItemWithBoxOpenTypeKey` / `boxOpenLog.itemStringKey` values
    // are unvalidated baseline copies. The complete-table short-circuit below
    // would otherwise trust them forever. Snapshot the flag here so the rest
    // of this function sees a stable value (it is cleared after the extractor
    // runs, see below).
    const forceReextract = this.forceExtractorNextHeal;
    if (complete && !forceExtractForCatalogDump && !forceReextract) {
      this.log(`resolve: table complete (source=${source})`);
      return { table: base, source, classIndex: null };
    }

    if (complete && (forceExtractForCatalogDump || forceReextract)) {
      this.log(
        forceReextract
          ? `resolve: table complete (source=${source}) — re-running extractor (cache pollution detected: boxOpenLog dict lookup failing)`
          : `resolve: table complete (source=${source}) — re-running extractor for catalog dump`,
      );
    } else {
      const missing = base ? missingOffsetFields(base).join(", ") : "entire table";
      this.log(`resolve: incomplete — missing ${missing}`);
    }

    if (ga && version && cacheDir) {
      const isSupported = base != null && hasCriticalOffsets(base);
      // Force the extractor to run the FULL critical path (enrichmentOnly=false)
      // ONLY when the base carries a `_fallbackFromVersion` marker AND its
      // critical RVAs still match the stale baseline. Once a prior session's
      // extractor has re-derived fresh RVAs and merged them into the cache,
      // `isCriticalStaleOnBaseline(base)` returns false — the cache is trusted
      // and the extractor (if still needed for enrichment gaps) takes the
      // cheaper enrichment-only path. This is the key change that lets a
      // fallback version's second launch skip the ~8s critical extraction.
      const forceCriticalPath = isFallbackTable && isCriticalStaleOnBaseline(base);
      const useCriticalBudget = !isSupported || forceCriticalPath;
      // Enrichment and critical extractions have independent attempt budgets.
      // Critical (unsupported) scans are bounded by MAX_EXTRACTION_ATTEMPTS;
      // enrichment (supported) scans are bounded by MAX_ENRICHMENT_ATTEMPTS so
      // a version where BoxOpenLog is genuinely underivable until the player
      // opens a box does not get re-scanned every heal tick forever. A detected
      // box-open event resets the enrichment budget (see consumeBoxOpenEvent).
      // Catalog-dump mode AND cache-pollution forced re-extraction both bypass
      // the budget — the former is a diagnostic run, the latter is a one-shot
      // signal-driven run whose flag is cleared after the extractor runs (so
      // it cannot loop forever even if the extractor fails to fix the issue).
      const mayExtract =
        forceReextract ||
        forceExtractForCatalogDump ||
        (useCriticalBudget
          ? mayAttemptExtraction(cacheDir, version, appBuild)
          : mayAttemptEnrichment(cacheDir, version, appBuild));
      if (mayExtract) {
        // Neither catalog-dump nor forced-reextract consumes the attempt
        // budget — both are diagnostic / signal-driven runs that should not
        // exhaust the permanent budget. Forced re-extract is a one-shot flag
        // cleared below after the extractor runs (success or failure), so it
        // can't loop.
        if (!forceExtractForCatalogDump && !forceReextract) {
          if (useCriticalBudget) recordExtractionAttempt(cacheDir, version, appBuild);
          else recordEnrichmentAttempt(cacheDir, version, appBuild);
        }
        this.log(
          forceReextract
            ? `resolve: running extractor (forced — cache pollution)`
            : useCriticalBudget
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
        // Consume the cache-pollution flag — one extractor run per detection
        // event. Whether the extractor succeeded or failed, we don't re-arm
        // until the next 60s failure streak (see detectCachePollution). On
        // success the merged table overwrites the bad cache; on failure the
        // reader stays degraded but the user sees the status-failure log and
        // can manually delete the cache directory.
        if (forceReextract) {
          this.forceExtractorNextHeal = false;
          this.dictFailSince = null;
        }
        if (derived) {
          // Note: the attempt budget was already recorded above (before the
          // extractor ran). Both successful AND failed extractions consume one
          // budget unit — that is intentional, so 3 consecutive failures
          // permanently stop the heal loop and don't keep re-running the ~8s
          // extractor every tick. A detected state change (box-open event,
          // fallback critical-stale) resets the budget via the dedicated
          // reset functions; do NOT record a second time here on success or
          // every productive run would count as 2 attempts.
          //
          // Cache-pollution exception: `mergeOffsets` keeps non-zero base
          // values (the standard "base is trusted" rule). But in
          // force-reextract mode the base's BoxOpen enrichment fields are
          // explicitly suspected invalid — that's why we're here. Clear
          // them before merge so derived values can fill the gaps. The
          // LogManager TypeInfo RVA is NOT cleared here: when chest drops
          // also fail (LogManager RVA stale on a fallback build), the
          // extractor re-derives it and `mergeOffsets`'s `derivedWins`
          // rule (fallback table) lets the fresh value override the
          // baseline. If the extractor can't re-derive it (e.g.
          // StageManager not yet instantiated), the baseline RVA is
          // preserved so the reader stays in its previous state rather
          // than degrading further to "RVA = 0".
          let baseForMerge = base;
          if (forceReextract && base) {
            baseForMerge = {
              ...base,
              runtime: {
                ...base.runtime,
                log: {
                  ...base.runtime.log,
                  getItemWithBoxOpenTypeKey: 0,
                },
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
          }
          const merged = baseForMerge
            ? mergeOffsets(baseForMerge, derived.offsets)
            : derived.offsets;
          // Tag the persisted cache with the extractor revision so a future
          // reader launch with a newer revision knows to re-derive instead of
          // loading this stale cache.
          merged._extractorRev = EXTRACTOR_REVISION;
          saveCachedOffsets(cacheDir, merged);
          const mergedSource: OffsetResolutionSource = baseForMerge ? "merged" : "extracted";
          this.log(
            forceReextract
              ? `resolve: extractor ok → ${mergedSource}, persisted cache (rev ${EXTRACTOR_REVISION}) — cache pollution fields overwritten`
              : `resolve: extractor ok → ${mergedSource}, persisted cache (rev ${EXTRACTOR_REVISION})`,
          );
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
    this.monsterNameScanPending = false;
    this.playerNameScanPending = false;
    this.playerPtr = null;
    this.classIndex = null;
    this.goldPin = makeGoldPinState();
    this.combatGoldPin = makeCombatGoldPinState();
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
    // Reset cache-pollution detector state — a fresh attach should not
    // inherit the previous session's failure streak or forced-reextract flag.
    this.dictFailSince = null;
    this.forceExtractorNextHeal = false;
    this.lastStatusFailLogAt = null;
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
        this.log(
          `read: stage null — smPtr=${smPtr ? "0x" + smPtr.toString(16) : "null"} ${this.smPin.lastStatus}`,
        );
      }
      return null;
    }

    // Resolve MonsterSpawnManager: bundled RVA may point to wrong class in some versions.
    // Try RVA first; if no monsters found, request the name-scan fallback (meter approach).
    // The scan is expensive (~30–60s) and runs in `runPendingNameScans` BEFORE the
    // next read tick — not inline here — so this read path stays pure and the
    // worker can keep emitting pre-scan snapshots during the scan itself.
    const monsterData = readRuntimeMonsterHp(p, ga.base, ga.size, o, this.monsterPin);
    if (
      !this.monsterNameScanAttempted &&
      (this.monsterPin.ptr == null || (monsterData?.monsterHps?.length ?? 0) === 0)
    ) {
      this.monsterNameScanAttempted = true;
      this.monsterNameScanPending = true;
      this.log("MonsterSpawnManager: RVA resolution produced no monsters, name-scan requested");
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
      // instance (CommonSaveData static field unreadable), request the
      // expensive class-name scan. The scan runs in `runPendingNameScans`
      // BEFORE the next read tick — not inline here — so this read path stays
      // pure. After the scan writes `this.playerPtr`, the next low-freq tick
      // re-reads inventory/pets with the resolved pointer.
      //
      // Anchor notes: `TaskbarHero.CommonSaveData` is the save-layer singleton
      // holding PetSaveData / itemSaveDatas / BoxData. `PlayerSaveData` is a
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
        this.playerNameScanPending = true;
        this.log("PlayerSaveData: RVA resolution produced no player instance, name-scan requested");
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

    // Per-status failure diagnostics + cache-pollution self-heal trigger.
    // Without this block, a derived-but-invalid offset (e.g. a baseline
    // `getItemWithBoxOpenTypeKey` value that doesn't match the live dict)
    // fails silently — `readRuntimeBoxOpenLog` returns null with a status
    // string, but nothing logs it and nothing triggers re-derivation. The
    // user sees "chest drops work but box opens never fire" with no clue.
    this.emitStatusFailLog(chestResult.status, boxOpenResult.status, chestSlotsResult.status);
    this.detectCachePollution(boxOpenResult, chestResult);

    return {
      connected: true,
      stageKey: stage.stageKey,
      stageWave: stage.wave,
      stageWaveTotal: stage.waveTotal,
      // Combat gold (AggregateSaveData GoldEarn[SubKey=1]) — pure combat earnings.
      // Falls back to wallet balance (CurrencyManager) when aggregate offset unavailable.
      gold:
        readRuntimeCombatGold(p, ga.base, ga.size, o, this.combatGoldPin) ??
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

  /**
   * Emit a throttled diagnostic log when any of the per-feature read paths
   * returns a non-empty status (chest drops / box opens / chest slots). The
   * status strings come from `runtime.ts` and pinpoint the failure mode
   * (e.g. "typeInfoRva.logManager RVA = 0", "BoxOpenLog list not walkable
   * (dict lookup failed)"). Without this log, derived-but-invalid offsets
   * fail completely silently — the snapshot just carries `null` and the user
   * sees "no data" with no clue in main.log. Throttled to once per
   * `STATUS_FAIL_LOG_THROTTLE_MS` window to avoid spamming the 25 Hz tick.
   */
  private emitStatusFailLog(
    chestStatus: string,
    boxOpenStatus: string,
    chestSlotsStatus: string,
  ): void {
    if (!chestStatus && !boxOpenStatus && !chestSlotsStatus) {
      this.lastStatusFailLogAt = null;
      return;
    }
    const now = Date.now();
    if (
      this.lastStatusFailLogAt != null &&
      now - this.lastStatusFailLogAt < STATUS_FAIL_LOG_THROTTLE_MS
    ) {
      return;
    }
    this.lastStatusFailLogAt = now;
    const parts: string[] = [];
    if (chestStatus) parts.push(`chest="${chestStatus}"`);
    if (boxOpenStatus) parts.push(`boxOpen="${boxOpenStatus}"`);
    if (chestSlotsStatus) parts.push(`chestSlots="${chestSlotsStatus}"`);
    this.log(`read: status failures — ${parts.join(", ")}`);
  }

  /**
   * Detect the cache-pollution signature: a runtime dict lookup keeps
   * returning "list not walkable" / "dict lookup failed" (offsets are
   * non-zero but the live dict lookup fails). This means cached offset
   * values are unvalidated baseline copies, not real extractor output —
   * set `forceExtractorNextHeal` so the worker triggers an immediate
   * forced re-extraction that bypasses the `isOffsetTableComplete`
   * short-circuit.
   *
   * Two failure signals are tracked through the same 60s timer:
   *  1. **boxOpen dict-fail** with chest drops healthy → BoxOpen field
   *     pollution (`getItemWithBoxOpenTypeKey` / `boxOpenLog.itemStringKey`).
   *  2. **chest drops dict-fail** (with or without boxOpen also failing) →
   *     LogManager RVA or `runtime.log.logByType` is the polluted value.
   *     This is the v1.01.02 fallback signature where the cache inherits
   *     v1.01.01's LogManager RVA and it doesn't resolve on the new build.
   *
   * Only "dict lookup failed" / "list not walkable" qualifies — earlier
   * failure modes (logManager RVA = 0, getItemWithBoxOpenTypeKey = 0) mean
   * the offsets ARE zero, so the existing enrichment budget / heal timer
   * already handles them. Both signals clearing resets the tracker so the
   * next failure streak starts a fresh timer.
   */
  private detectCachePollution(
    boxOpenResult: { opens: BoxOpenEntry[] | null; status: string },
    chestResult: { drops: LiveChestCategory[] | null; status: string },
  ): void {
    const isDictLookupFail = (s: string): boolean =>
      /dict lookup failed|list not walkable/i.test(s);
    const boxOpenFail = boxOpenResult.opens == null && isDictLookupFail(boxOpenResult.status);
    const chestFail = chestResult.drops == null && isDictLookupFail(chestResult.status);

    if (boxOpenFail || chestFail) {
      if (this.dictFailSince == null) {
        this.dictFailSince = Date.now();
        return;
      }
      // Already triggered — wait for the worker to consume the flag and
      // re-derive. Don't re-arm to avoid hammering the 8 s extractor.
      if (this.forceExtractorNextHeal) return;
      if (Date.now() - this.dictFailSince >= BOX_OPEN_FAIL_HEAL_MS) {
        this.forceExtractorNextHeal = true;
        const which =
          boxOpenFail && chestFail
            ? "boxOpen + chest drops"
            : boxOpenFail
              ? "boxOpen"
              : "chest drops";
        this.log(
          `read: ${which} dict lookup failed for ${BOX_OPEN_FAIL_HEAL_MS}ms — cache pollution suspected; forcing extractor re-run on next heal`,
        );
      }
      return;
    }
    // Both signals recovered — reset the tracker so the next failure
    // streak starts a fresh timer.
    if (this.dictFailSince != null) {
      this.log("read: dict lookup recovered — clearing cache-pollution tracker");
    }
    this.dictFailSince = null;
    // NOTE: forceExtractorNextHeal is NOT cleared here — it is consumed by
    // resolveOffsets after the extractor runs. Clearing it here would let a
    // single successful tick (e.g. mid-extraction) cancel a forced heal
    // that hasn't actually run yet.
  }

  /**
   * Run any pending name-scan fallbacks (MonsterSpawnManager / PlayerSaveData)
   * requested by the previous `read()`. Returns true if a scan ran — the
   * worker should skip that tick's `read()` call (the scan itself takes
   * 30–60s when the GA index misses, so re-reading immediately is pointless;
   * the next tick will pick up the new pin). Returns false when no scan is
   * pending, leaving the worker free to call `read()` normally.
   *
   * This method is the only place that performs the expensive
   * `resolveClassByName` whole-address-space scan, keeping `read()` pure.
   * The worker calls it BEFORE `read()` so the read path never blocks.
   */
  runPendingNameScans(): boolean {
    if (!this.monsterNameScanPending && !this.playerNameScanPending) return false;
    const p = this.proc;
    const o = this.offsets;
    const ga = this.ga;
    if (!p || !o || !ga) {
      this.monsterNameScanPending = false;
      this.playerNameScanPending = false;
      return false;
    }
    try {
      this.setScanning(true);
      // Build the GA class index once and reuse it for both scans.
      if (this.monsterNameScanPending || this.playerNameScanPending) {
        this.ensureClassIndex();
      }
      if (this.monsterNameScanPending) {
        this.monsterNameScanPending = false;
        this.runMonsterNameScan(p, ga);
      }
      if (this.playerNameScanPending) {
        this.playerNameScanPending = false;
        this.runPlayerNameScan(p, ga, o);
      }
    } finally {
      this.setScanning(false);
    }
    return true;
  }

  /** Name-scan fallback for MonsterSpawnManager when RVA produced no monsters. */
  private runMonsterNameScan(p: WinProcess, ga: { base: bigint; size: number }): void {
    this.log("MonsterSpawnManager: running name-scan fallback...");
    // Fast path: the GA-derived class index usually has MonsterSpawnManager
    // already (its TypeInfo sits in a GA static slot). Only fall back to the
    // ~30–60s whole-address-space scan when the index misses.
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
      } else {
        this.log("MonsterSpawnManager: class found but no static-held instance");
      }
    } else {
      this.log("MonsterSpawnManager: class not found by name scan");
    }
  }

  /** Name-scan fallback for PlayerSaveData when RVA produced no player instance. */
  private runPlayerNameScan(
    p: WinProcess,
    ga: { base: bigint; size: number },
    o: LiveOffsets,
  ): void {
    this.log("PlayerSaveData: running name-scan fallback...");
    // Candidate singleton class names in priority order. CommonSaveData is the
    // real anchor (per LiveOffsets.typeInfoRva.commonSaveData comment);
    // PlayerSaveData is a legacy fallback.
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
        // Re-read inventory/pets immediately so the next read tick has them
        // cached without waiting for the low-freq cadence.
        this.cachedInventory = readRuntimeInventory(p, ga.base, ga.size, o, this.playerPtr);
        this.cachedPets = readRuntimePets(p, ga.base, ga.size, o, this.playerPtr);
        break;
      } else {
        this.log(`${name}: class found but no static-held instance`);
      }
    }
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
            fallbackFromVersion: this.offsets._fallbackFromVersion,
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
