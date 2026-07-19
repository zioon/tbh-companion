// Owns the live-memory utilityProcess: spawn/lifecycle + broadcast to renderers.
// The heavy read loop runs in the worker process, so this service stays cheap on
// the main thread. Lifecycle is tied to the enable toggle (not tracking start).

import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { IPC } from "../../../shared/ipc";
import type { LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";
import { LIVE_MEMORY_USER_DATA_ENV } from "../liveMemory/liveMemoryCacheDir";
import { broadcast } from "./broadcast";
import { createLogger } from "../log";
import { resolveUserDataDir } from "./appData";

const log = createLogger("liveMemory");

/** Minimum interval between LIVE_MEMORY broadcasts to renderers (ms). */
const SNAPSHOT_BROADCAST_INTERVAL_MS = 200;

type WorkerMessage =
  | { type: "snapshot"; snapshot: LiveMemorySnapshot }
  | { type: "status"; status: LiveMemoryStatus }
  | { type: "log"; message: string };

export class LiveMemoryService {
  private child: UtilityProcess | null = null;
  private lastSnapshot: LiveMemorySnapshot | null = null;
  private lastStatus: LiveMemoryStatus | null = null;
  private snapshotCb: ((snap: LiveMemorySnapshot) => void) | null = null;
  private lastBroadcastMs = 0;
  private onGameVersionChanged?: () => void;

  /** Register a callback invoked on every snapshot frame from the reader worker. */
  setOnSnapshot(cb: (snap: LiveMemorySnapshot) => void): void {
    this.snapshotCb = cb;
  }

  /** Register a callback invoked once when the worker reports a new gameVersion
   * different from the previous one. Used by CatalogRefreshService to broadcast
   * stale-catalog status so the Loot tab can show a refresh banner. */
  setOnGameVersionChanged(cb: () => void): void {
    this.onGameVersionChanged = cb;
  }

  get running(): boolean {
    return this.child != null;
  }

  start(): void {
    if (this.child) return;
    // electron-vite emits the worker next to the main bundle (out/main/liveMemoryWorker.js).
    const workerPath = join(__dirname, "liveMemoryWorker.js");
    try {
      this.child = utilityProcess.fork(workerPath, [], {
        serviceName: "tbh-live-memory",
        stdio: "pipe",
        env: { ...process.env, [LIVE_MEMORY_USER_DATA_ENV]: resolveUserDataDir() },
      });
    } catch (err) {
      log.error(`Failed to fork live-memory worker: ${String(err)}`);
      const failed: LiveMemoryStatus = {
        running: false,
        attached: false,
        pid: null,
        gameVersion: null,
        supported: false,
        note: "failed to start live reader",
      };
      this.lastStatus = failed;
      broadcast(IPC.LIVE_MEMORY_STATUS, failed);
      return;
    }

    this.child.on("message", (msg: WorkerMessage) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "snapshot") {
        this.lastSnapshot = msg.snapshot;
        // Throttle the renderer broadcast — the worker produces ~25 Hz but the
        // UI only needs ~5 Hz (200 ms) for smooth display. The snapshotCb
        // (TrackingService ingestion) still receives every frame at full rate.
        const now = Date.now();
        if (now - this.lastBroadcastMs >= SNAPSHOT_BROADCAST_INTERVAL_MS) {
          this.lastBroadcastMs = now;
          broadcast(IPC.LIVE_MEMORY, msg.snapshot);
        }
        if (this.snapshotCb) {
          try {
            this.snapshotCb(msg.snapshot);
          } catch (err) {
            log.warn(`Live-memory snapshot callback failed: ${String(err)}`);
          }
        }
      } else if (msg.type === "status") {
        const prevVersion = this.lastStatus?.gameVersion ?? null;
        this.lastStatus = msg.status;
        broadcast(IPC.LIVE_MEMORY_STATUS, msg.status);
        const newVersion = msg.status.gameVersion ?? null;
        if (prevVersion !== null && newVersion !== null && prevVersion !== newVersion) {
          this.onGameVersionChanged?.();
        }
      } else if (msg.type === "log") {
        log.info(`[worker] ${msg.message}`);
      }
    });

    // Capture stderr so worker crashes are diagnosable instead of silent exit(1).
    // Cap at 64 KB to prevent unbounded growth if the worker spams stderr for
    // hours without crashing — keep only the most recent output.
    const STDERR_MAX_BYTES = 64 * 1024;
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      stderrBytes += text.length;
      // Evict oldest chunks until we're back under the cap.
      while (stderrBytes > STDERR_MAX_BYTES && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrBytes -= removed.length;
      }
      log.warn(`[worker stderr] ${text.trimEnd()}`);
    });

    this.child.on("exit", (code) => {
      const stderr = stderrChunks.join("").trim();
      log.warn(`Live-memory worker exited (code ${code}).${stderr ? `\n  stderr: ${stderr}` : ""}`);
      const crashed: LiveMemoryStatus = {
        running: false,
        attached: false,
        pid: null,
        gameVersion: this.lastStatus?.gameVersion ?? null,
        supported: false,
        note: "live reader stopped unexpectedly",
      };
      this.lastStatus = crashed;
      this.lastSnapshot = null;
      broadcast(IPC.LIVE_MEMORY_STATUS, crashed);
      this.child = null;
    });

    log.info("Live-memory worker started.");
  }

  stop(): void {
    if (this.child) {
      try {
        // Remove listeners before kill so the exit/message events fired during
        // shutdown can't trigger stray broadcasts on a service that's stopping.
        this.child.removeAllListeners();
        this.child.postMessage("stop");
        this.child.kill();
      } catch {
        // already gone
      }
      this.child = null;
    }
    this.lastSnapshot = null;
    // Terminal status so renderers revert every stat to its save-file source.
    const terminal: LiveMemoryStatus = {
      running: false,
      attached: false,
      pid: null,
      gameVersion: this.lastStatus?.gameVersion ?? null,
      supported: false,
    };
    this.lastStatus = terminal;
    broadcast(IPC.LIVE_MEMORY_STATUS, terminal);
    log.info("Live-memory worker stopped.");
  }

  getSnapshot(): LiveMemorySnapshot | null {
    return this.lastSnapshot;
  }

  getStatus(): LiveMemoryStatus | null {
    return this.lastStatus;
  }
}
