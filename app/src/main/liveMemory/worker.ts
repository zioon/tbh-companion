// Live-memory utilityProcess entry point.
//
// Runs in a SEPARATE OS process so the high-frequency read loop + native FFI
// never touch the Electron main thread or renderer (perf-isolation requirement).
// Streams snapshots + status to the main process via parentPort.

import type { LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";
import { LiveMemoryReader } from "./liveReader";

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
  reader.setLogger((message) => post({ type: "log", message }));
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
 * Two paths trigger a heal:
 *  1. Event-driven: `LiveMemoryReader` watches the BoxOpenLog list length on
 *     every read tick. A 0→>0 transition (player opened a box) sets
 *     `boxOpenEventPending`. This function consumes that flag, resets the
 *     enrichment attempt budget, and triggers an immediate heal.
 *  2. Fallback timer: when `getItemWithBoxOpenTypeKey` itself is 0 (not yet
 *     derived), `peekBoxOpenLogCount` returns null and no event is ever
 *     raised — so path 1 is deadlocked. The fallback resets the budget and
 *     re-runs the extractor every `HEAL_ENRICHMENT_FALLBACK_MS` until
 *     enrichment completes.
 *
 * The attach-time extraction (MAX_ENRICHMENT_ATTEMPTS=1) covers the "log
 * already has BoxOpenLog entries from a prior session" case; further retries
 * happen via path 1 (immediate, after the player opens a box) or path 2
 * (every 30s while enrichment is incomplete).
 */
function maybeHealEnrichment(): void {
  if (!reader?.attached || !reader.supported || reader.enrichmentComplete) {
    enrichmentHealDueAt = 0;
    return;
  }
  // Path 1: event-driven immediate heal.
  if (reader.consumeBoxOpenEvent()) {
    reader.resetEnrichmentBudget();
    reader.healOffsets();
    postStatusIfChanged();
    enrichmentHealDueAt = 0;
    return;
  }
  // Path 2: fallback timer to break the event-detector deadlock when
  // `getItemWithBoxOpenTypeKey` itself is the missing offset.
  const now = Date.now();
  if (enrichmentHealDueAt === 0) enrichmentHealDueAt = now + HEAL_ENRICHMENT_FALLBACK_MS;
  if (now >= enrichmentHealDueAt) {
    reader.resetEnrichmentBudget();
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
