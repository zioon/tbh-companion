// Live-memory utilityProcess entry point.
//
// Runs in a SEPARATE OS process so the high-frequency read loop + native FFI
// never touch the Electron main thread or renderer (perf-isolation requirement).
// Streams snapshots + status to the main process via parentPort.

import type { LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";
import { LiveMemoryReader } from "./liveReader";
import { winProcessStats } from "./winProcess";

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

// Diagnostic: sample worker memory every 5s while running. Attributes RSS
// growth to external (koffi _Out_ marshalling), arrayBuffers (Buffer.alloc),
// or heapUsed (JS objects). Also reports read() and readBytes() rates so we
// can correlate allocation pressure with FFI call frequency. Remove once the
// leak is plugged.
const MEM_SAMPLE_MS = 5_000;
function mb(v: number): string {
  return (v / 1024 / 1024).toFixed(1);
}
let readCountSinceSample = 0;
let lastMem: NodeJS.MemoryUsage | null = null;
let lastMemAt = 0;
const memTimer = setInterval(() => {
  const cur = process.memoryUsage();
  const now = Date.now();
  const dtSec = lastMemAt > 0 ? (now - lastMemAt) / 1000 : 0;
  const readsPerSec = dtSec > 0 ? (readCountSinceSample / dtSec).toFixed(1) : "0";
  const ffiPerSec = dtSec > 0 ? (winProcessStats.readBytesCalls / dtSec).toFixed(0) : "0";
  const ffiMiBPerSec =
    dtSec > 0 ? (winProcessStats.readBytesBytes / 1024 / 1024 / dtSec).toFixed(2) : "0";

  let line = `mem rss=${mb(cur.rss)}MB heap=${mb(cur.heapUsed)}/${mb(cur.heapTotal)}MB ext=${mb(cur.external)}MB arrBuf=${mb(cur.arrayBuffers)}MB`;
  if (lastMem) {
    line += ` | Δ5s rss=+${mb(cur.rss - lastMem.rss)} heap=+${mb(cur.heapUsed - lastMem.heapUsed)} ext=+${mb(cur.external - lastMem.external)} arrBuf=+${mb(cur.arrayBuffers - lastMem.arrayBuffers)}`;
  }
  line += ` | reads=${readsPerSec}/s ffi=${ffiPerSec}/s (${ffiMiBPerSec} MiB/s)`;

  post({ type: "log", message: line });

  lastMem = cur;
  lastMemAt = now;
  readCountSinceSample = 0;
  winProcessStats.readBytesCalls = 0;
  winProcessStats.readBytesBytes = 0;
}, MEM_SAMPLE_MS);
memTimer.unref();

let reader: LiveMemoryReader | null = null;
let loadError: string | null = null;
let healDueAt = 0;

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

function loop(): void {
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
  }
  if (reader.attached && reader.supported) {
    const snap = reader.read();
    readCountSinceSample++;
    postStatusIfChanged();
    if (snap) {
      post({ type: "snapshot", snapshot: snap });
      schedule(POLL_ATTACHED_MS);
      return;
    }
  }
  schedule(reader.attached ? POLL_ATTACHED_MS : POLL_DETACHED_MS);
}

parentPort?.on("message", (msg) => {
  if (msg === "stop") {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    reader?.detach();
  }
});

postStatusIfChanged();
loop();
