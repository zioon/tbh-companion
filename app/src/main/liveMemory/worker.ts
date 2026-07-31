// Live-memory utilityProcess entry point.
//
// Runs in a SEPARATE OS process so the high-frequency read loop + native FFI
// never touch the Electron main thread or renderer (perf-isolation requirement).
// Streams snapshots + status to the main process via parentPort.

import type { LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";
import { LiveMemoryReader } from "./liveReader";
import { setWinProcessLogger } from "./winProcess";

// utilityProcess exposes parentPort on the global process object.
const parentPort = (
  process as unknown as {
    parentPort?: {
      postMessage: (m: unknown) => void;
      on: (e: string, cb: (m: unknown) => void) => void;
    };
  }
).parentPort;

const POLL_ATTACHED_MS = 40; // ~25 Hz while attached (read costs ~0.2 ms)
const POLL_DETACHED_MS = 1500; // retry attach while the game is closed
const HEAL_UNSUPPORTED_MS = 10_000; // re-try offset resolution while degraded
/**
 * Fallback heal cadence for enrichment fields (e.g. BoxOpenLog struct offsets)
 * when the event-driven path is blocked. The box-open event detector relies
 * on `getItemWithBoxOpenTypeKey`, which is itself an enrichment field — when
 * it is 0, `peekBoxOpenLogCount` returns null and no event is ever raised,
 * so the budget never resets and the offsets stay 0 forever. This timer
 * breaks that deadlock by resetting the enrichment budget and re-running
 * the extractor on a fixed cadence, regardless of event signals. 30s keeps
 * the CPU cost negligible (one extractor run every 30s at most) while
 * bounding the player's wait after opening their first box.
 */
const HEAL_ENRICHMENT_FALLBACK_MS = 30_000;

let reader: LiveMemoryReader | null = null;
let loadError: string | null = null;
let healDueAt = 0;
let enrichmentHealDueAt = 0;

try {
  reader = new LiveMemoryReader();
  const forward = (message: string) => post({ type: "log", message });
  reader.setLogger(forward);
  // WinProcess emits module-enumeration fallback diagnostics (ToolHelp/PSAPI/
  // PowerShell) through this logger so they surface in main.log alongside
  // the reader's own logs — essential for diagnosing sandbox-blocked attach.
  setWinProcessLogger(forward);
  reader.onScanningChange = () => postStatusIfChanged();
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
}

type WorkerMessage =
  | { type: "snapshot"; snapshot: LiveMemorySnapshot }
  | { type: "status"; status: LiveMemoryStatus }
  | { type: "log"; message: string };

function post(msg: WorkerMessage): void {
  parentPort?.postMessage(msg);
}

let lastStatusKey = "";
function postStatusIfChanged(): void {
  const status: LiveMemoryStatus = reader
    ? reader.status()
    : {
        running: true,
        attached: false,
        pid: null,
        gameVersion: null,
        supported: false,
        note: loadError ?? "reader unavailable",
      };
  const key = JSON.stringify(status);
  if (key !== lastStatusKey) {
    lastStatusKey = key;
    post({ type: "status", status });
  }
}

let timer: NodeJS.Timeout | null = null;
function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, ms);
}

function maybeHealUnsupported(): void {
  if (!reader?.attached || reader.supported) {
    healDueAt = 0;
    return;
  }
  const now = Date.now();
  if (healDueAt === 0) healDueAt = now + HEAL_UNSUPPORTED_MS;
  if (now >= healDueAt) {
    reader.healOffsets();
    postStatusIfChanged();
    healDueAt = now + HEAL_UNSUPPORTED_MS;
  }
}

/**
 * Heal enrichment fields (e.g. boxOpenLog offsets) even when the reader is
 * already supported. These often fail on the first extraction because the
 * game's LogManager dictionary has no BoxOpenLog entries yet (player hasn't
 * opened a box). Once the player opens one, the dictionary becomes non-empty
 * and a re-extraction can derive the key.
 *
 * Five paths trigger a heal:
 *  1. Event-driven: `LiveMemoryReader` watches the BoxOpenLog list length on
 *     every read tick. A 0→>0 transition (player opened a box) sets
 *     `boxOpenEventPending`. This function consumes that flag, resets the
 *     enrichment attempt budget, and triggers an immediate heal.
 *  1.5. Cache-pollution self-heal: when `readRuntimeBoxOpenLog` has been
 *     failing "dict lookup failed" / "LogManager singleton unresolved" for
 *     >60s, the cached offset values are unvalidated baseline copies. The
 *     reader's `detectCachePollution` sets `needsForcedReextract` — trigger
 *     an immediate heal here, bypassing the budget cap.
 *  1.6. StageManager transition: when the reader is on a fallback table
 *     whose critical RVAs have NOT been validated (`isCriticalStaleOnFallback`)
 *     and StageManager transitions from null to non-null (player entered a
 *     stage), `read()` sets `smTransitionPending`. This path consumes the
 *     flag, resets the CRITICAL budget (not enrichment), and triggers an
 *     immediate heal. This is the key fix for the version-adaptation
 *     deadlock: attach during main menu → 3 critical failures → budget
 *     exhausted → player enters stage → smTransition resets budget →
 *     extractor succeeds. Without this, the reader would stay on stale
 *     baseline RVAs forever (the old `_extractorRev` deadlock).
 *  2. Enrichment fallback timer: when `getItemWithBoxOpenTypeKey` itself is 0
 *     (not yet derived), `peekBoxOpenLogCount` returns null and no event is
 *     ever raised — so path 1 is deadlocked. The fallback resets the budget
 *     and re-runs the extractor every `HEAL_ENRICHMENT_FALLBACK_MS` until
 *     enrichment completes.
 *  3. Critical-stale-on-fallback timer: when the reader is on a fallback
 *     table whose critical RVAs have NOT been validated, all live reads
 *     resolve to wrong classes → null data. This path reuses the 30s cadence
 *     to keep retrying, but the critical budget cap (3 attempts) prevents
 *     infinite re-extraction — Path 1.6 (StageManager transition) is the
 *     real recovery signal.
 *
 * The attach-time extraction (MAX_ENRICHMENT_ATTEMPTS=1) covers the "log
 * already has BoxOpenLog entries from a prior session" case; further retries
 * happen via path 1 (immediate, after the player opens a box), path 1.5
 * (immediate, cache pollution), path 1.6 (immediate, StageManager
 * transition), path 2 (every 30s while enrichment is incomplete), or path 3
 * (every 30s while critical RVAs are still unvalidated — but budget-capped).
 */
function maybeHealEnrichment(): void {
  if (!reader?.attached || !reader.supported) {
    enrichmentHealDueAt = 0;
    return;
  }
  // Path 1: event-driven immediate heal (only relevant while enrichment is
  // still incomplete — boxOpenLog struct offsets pending first box-open).
  if (!reader.enrichmentComplete && reader.consumeBoxOpenEvent()) {
    reader.resetEnrichmentBudget();
    reader.healOffsets();
    postStatusIfChanged();
    enrichmentHealDueAt = 0;
    return;
  }
  // Path 1.5: cache-pollution self-heal. When `readRuntimeBoxOpenLog` has
  // been failing "dict lookup failed" / "LogManager singleton unresolved"
  // for >60s, the cached offset values are unvalidated baseline copies. The
  // reader's `detectCachePollution` sets `needsForcedReextract` — trigger
  // an immediate heal here. `resolveOffsets` sees the flag and bypasses the
  // complete-table short-circuit AND the per-budget attempt cap, then
  // clears the flag (one-shot, see resolveOffsets). This path runs BEFORE
  // Path 2/3's 30s timer because the reader is already
  // `enrichmentComplete=true` (the bad cache claims all fields are filled)
  // — Path 2/3 would otherwise never fire.
  if (reader.needsForcedReextract) {
    reader.healOffsets();
    postStatusIfChanged();
    enrichmentHealDueAt = 0;
    return;
  }
  // Path 1.6: StageManager transition — player entered a stage while the
  // reader is on a stale fallback baseline. `consumeSmTransition` resets
  // the CRITICAL budget (not enrichment) and returns true. Trigger an
  // immediate heal so the extractor re-derives fresh critical RVAs within
  // seconds of entering a stage. This is the key recovery path for the
  // version-adaptation deadlock (attach during main menu → budget exhausted
  // → never retries). Must run BEFORE Path 2/3's 30s timer.
  if (reader.consumeSmTransition()) {
    reader.healOffsets();
    postStatusIfChanged();
    enrichmentHealDueAt = 0;
    return;
  }
  // Path 2 & 3 share the same cadence. Path 2 covers enrichment gaps;
  // path 3 covers critical RVAs pending StageManager instantiation on
  // fallback tables (independent of enrichment completion — a reader can
  // have all enrichment offsets filled yet still be on stale baseline RVAs).
  // Note: Path 3 is now budget-capped (3 attempts) — `healOffsets` no
  // longer unconditionally resets the critical budget. The real recovery
  // signal is Path 1.6 (StageManager transition). Path 3 just ensures the
  // extractor gets its initial 3 attempts.
  const needsFallbackHeal = !reader.enrichmentComplete || reader.isCriticalStaleOnFallback;
  if (!needsFallbackHeal) {
    enrichmentHealDueAt = 0;
    return;
  }
  const now = Date.now();
  if (enrichmentHealDueAt === 0) enrichmentHealDueAt = now + HEAL_ENRICHMENT_FALLBACK_MS;
  if (now >= enrichmentHealDueAt) {
    // Reset the ENRICHMENT budget ONLY when the extractor has not yet had
    // its turn for this version. When `enrichmentAlreadyAttempted` is true
    // (cache carries `_extractorRev`), the extractor already ran — if
    // enrichment is still incomplete, it means validation failed. Re-running
    // with the same scanner would produce the same failure, so we do NOT
    // reset the budget. `resolveOffsets` sees the exhausted budget and
    // short-circuits the extractor, making `healOffsets` return in
    // milliseconds instead of ~9s. Without this guard, Path 2 would reset
    // the budget every 30s, re-running the ~9s extractor with the same
    // validation failure forever.
    //
    // CRITICAL budget is NOT reset here — that's now Path 1.6's job
    // (StageManager transition signal). Path 3 with an exhausted critical
    // budget becomes a cheap no-op (resolveOffsets short-circuits).
    if (!reader.enrichmentAlreadyAttempted) {
      reader.resetEnrichmentBudget();
    }
    reader.healOffsets();
    postStatusIfChanged();
    enrichmentHealDueAt = now + HEAL_ENRICHMENT_FALLBACK_MS;
  }
}

function loop(): void {
  try {
    if (!reader) {
      postStatusIfChanged();
      schedule(POLL_DETACHED_MS);
      return;
    }
    if (!reader.attached) {
      reader.attach();
      postStatusIfChanged();
    } else {
      maybeHealUnsupported();
      maybeHealEnrichment();
    }
    if (reader.attached && reader.supported) {
      // Run any pending name-scan fallbacks (MonsterSpawnManager / PlayerSaveData)
      // BEFORE the read tick. These scans take 30–60s when the GA index misses
      // and would block the 25 Hz loop if run inline inside read(). Running them
      // here lets the worker keep emitting pre-scan snapshots during the scan
      // itself, and the read path stays pure (no FFI inside the hot loop).
      // Returns true when a scan ran — skip this tick's read (the next tick
      // picks up the new pin).
      if (reader.runPendingNameScans()) {
        postStatusIfChanged();
        schedule(POLL_ATTACHED_MS);
        return;
      }
      const snap = reader.read();
      postStatusIfChanged();
      if (snap) {
        post({ type: "snapshot", snapshot: snap });
        schedule(POLL_ATTACHED_MS);
        return;
      }
    }
    schedule(reader.attached ? POLL_ATTACHED_MS : POLL_DETACHED_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    post({ type: "log", message: `loop error: ${msg}` });
    // If the reader is in a bad state, detach and retry attach on the next tick.
    try {
      reader?.detach();
    } catch {
      // ignore detach errors
    }
    postStatusIfChanged();
    schedule(POLL_DETACHED_MS);
  }
}

parentPort?.on("message", (msg) => {
  if (msg === "stop") {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      reader?.detach();
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      post({ type: "log", message: `detach error on stop: ${e}` });
    }
    // Exit the utility process so its resources (native FFI handles, memory)
    // are reclaimed. Without this, the parent must dispose the child
    // explicitly or it lingers as a zombie.
    process.exit(0);
  }
});

// Global handlers — log the error and exit gracefully instead of crashing silently.
process.on("uncaughtException", (err) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  post({ type: "log", message: `uncaughtException: ${msg}` });
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
  post({ type: "log", message: `unhandledRejection: ${msg}` });
});

postStatusIfChanged();
loop();
