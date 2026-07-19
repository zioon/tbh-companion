// P1-6: Host-side wrapper around the inventory-resolve utilityProcess.
//
// `InventoryService` owns an `InventoryWorker` instance and delegates the
// heavy `resolveInventory` call (10万件 items, map/filter/price-lookup) to
// a separate OS process. When the worker isn't ready yet (still spawning,
// crashed, or stopped) the host falls back to the synchronous resolve path
// — this guarantees the UI never loses inventory updates while the worker
// is unavailable, mirroring the pre-P1-6 behavior on a best-effort basis.
//
// Lifecycle follows `LiveMemoryService`:
//   - `init()` spawns the child + sends `init` message, awaits `ready`
//   - `resolve()` posts a request and awaits the matching response
//   - `stop()` sends `stop` then kills the child (synchronous exit)
//   - Unexpected `exit` rejects all pending requests and re-enables fallback

import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import {
  resolveInventory,
  type PriceLookup,
  type ResolveInventoryOptions,
} from "../../core/inventory";
import type { SteamMarketFeeRates } from "../../core/steamMarketFee";
import type { GameItem } from "../../core/gamedata";
import type {
  InventoryPriceInfo,
  InventorySnapshot,
  ResolvedInventory,
} from "../../../shared/types";
import { createLogger } from "../log";
import type {
  InventoryWorkerInbound,
  InventoryWorkerOutbound,
  InventoryWorkerResolveMessage,
} from "./inventoryWorkerProtocol";

const log = createLogger("inventoryWorker");

interface PendingRequest {
  resolve: (value: ResolvedInventory) => void;
  reject: (error: Error) => void;
  /** Auto-reject timer so a silent worker doesn't leak pending promises. */
  timer: NodeJS.Timeout;
}

const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Returns the absolute path to the worker entry bundle.
 *
 * electron-vite emits utility-process entries next to the main bundle
 * (`out/main/<name>.js`). The name is configured in `electron.vite.config.ts`
 * under `main.build.rollupOptions.input`. Mirrors how `LiveMemoryService`
 * resolves its own worker path.
 */
function resolveWorkerPath(): string {
  return join(__dirname, "inventoryWorkerEntry.js");
}

export class InventoryWorker {
  private child: UtilityProcess | null = null;
  private ready = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private cachedFeeRates: SteamMarketFeeRates;
  private cachedGameDataLookup: Map<number, GameItem> | null = null;

  constructor(feeRates: SteamMarketFeeRates) {
    this.cachedFeeRates = feeRates;
  }

  /** Update the cached fee rates used by the sync fallback path. The worker
   *  receives the rates through `init()` — call `reinit()` to push them. */
  setFeeRates(feeRates: SteamMarketFeeRates): void {
    this.cachedFeeRates = feeRates;
  }

  /** Spawn the worker and push the initial state. Resolves once the worker
   *  has acknowledged `init` with a `ready` message. Safe to call again to
   *  push a fresh `gameDataMap` (e.g. after `GameDataProvider.reload`). */
  init(gameDataLookup: Map<number, GameItem>, feeRates: SteamMarketFeeRates): Promise<void> {
    this.cachedGameDataLookup = gameDataLookup;
    this.cachedFeeRates = feeRates;
    if (this.child) {
      // Already running — push a fresh `init` without re-spawning.
      this.child.postMessage({
        type: "init",
        gameDataEntries: [...gameDataLookup.entries()],
        feeRates,
      } satisfies InventoryWorkerInbound);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const workerPath = resolveWorkerPath();
      try {
        this.child = utilityProcess.fork(workerPath, [], {
          serviceName: "tbh-inventory",
          stdio: "pipe",
        });
      } catch (err) {
        log.error(`Failed to fork inventory worker: ${String(err)}`);
        this.child = null;
        this.ready = false;
        resolve();
        return;
      }

      const onReady = (): void => {
        this.ready = true;
        log.info("Inventory worker ready.");
        resolve();
      };
      const onMessage = (msg: InventoryWorkerOutbound): void => {
        this.handleWorkerMessage(msg, onReady);
      };
      this.child.on("message", onMessage);
      this.child.on("exit", (code) => this.handleExit(code));

      const stderrChunks: string[] = [];
      this.child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        log.warn(`[worker stderr] ${text.trimEnd()}`);
      });

      // Send the init message *after* the listeners are attached so the
      // reply can be delivered.
      this.child.postMessage({
        type: "init",
        gameDataEntries: [...gameDataLookup.entries()],
        feeRates,
      } satisfies InventoryWorkerInbound);
    });
  }

  /** Re-push the cached gameData + feeRates without re-spawning the worker. */
  reinit(): void {
    if (!this.child || !this.cachedGameDataLookup) return;
    this.child.postMessage({
      type: "init",
      gameDataEntries: [...this.cachedGameDataLookup.entries()],
      feeRates: this.cachedFeeRates,
    } satisfies InventoryWorkerInbound);
  }

  /** Resolve an inventory snapshot. Returns a Promise that resolves when the
   *  worker replies, or rejects on error / timeout. Falls back to a sync
   *  `resolveInventory` call when the worker isn't ready. */
  resolve(
    snapshot: InventorySnapshot,
    priceLookup: Map<string, InventoryPriceInfo>,
    excludeItemKeys?: number[],
  ): Promise<ResolvedInventory> {
    if (!this.ready || !this.child) {
      return Promise.resolve(this.resolveSync(snapshot, priceLookup, excludeItemKeys));
    }
    const id = this.nextId++;
    const msg: InventoryWorkerResolveMessage = {
      type: "resolve",
      id,
      snapshot,
      priceLookupEntries: [...priceLookup.entries()],
      excludeItemKeys,
    };
    return new Promise<ResolvedInventory>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`inventory worker resolve timed out after ${RESOLVE_TIMEOUT_MS}ms`));
        }
      }, RESOLVE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.postMessage(msg satisfies InventoryWorkerInbound);
    });
  }

  /** Whether `resolve()` will take the async (worker) path. `InventoryService`
   *  uses this to decide whether to publish results synchronously (fallback)
   *  or wait for the worker callback. */
  isReady(): boolean {
    return this.ready && this.child != null;
  }

  /** Synchronous fallback used when the worker is unavailable. Mirrors the
   *  pre-P1-6 `InventoryService.resolveAndPushInventory` resolve path so the
   *  UX is identical when the worker is starting up or has crashed. Exposed
   *  publicly so the host can re-run resolve on worker failure without going
   *  through the async path. */
  resolveSync(
    snapshot: InventorySnapshot,
    priceLookup: Map<string, InventoryPriceInfo>,
    excludeItemKeys?: number[],
  ): ResolvedInventory {
    const excludeSet = excludeItemKeys ? new Set(excludeItemKeys) : null;
    const lookup = (key: number) => this.cachedGameDataLookup?.get(key);
    const priceLookupFn: PriceLookup = (hash) => priceLookup.get(hash);
    const options: ResolveInventoryOptions = {
      excludeItemKey: excludeSet ? (key: number) => excludeSet.has(key) : undefined,
      marketFeeRates: this.cachedFeeRates,
    };
    return resolveInventory(snapshot, lookup, true, priceLookupFn, options);
  }

  /** Drain a single worker→host message. `onReady` is invoked the first time
   *  we see `{type:"ready"}` so `init()` can resolve its promise. */
  private handleWorkerMessage(msg: InventoryWorkerOutbound, onReady: () => void): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      onReady();
      return;
    }
    if (msg.type === "log") {
      log.info(`[worker] ${msg.message}`);
      return;
    }
    if (msg.type === "resolve") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else if (msg.resolved) {
        pending.resolve(msg.resolved);
      } else {
        pending.reject(new Error("inventory worker returned empty resolve response"));
      }
    }
  }

  /** Unexpected exit handler. Reject all pending requests and re-enable the
   *  sync fallback path; the host can `init()` again later to restart. */
  private handleExit(code: number): void {
    log.warn(`Inventory worker exited (code ${code}).`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`inventory worker exited (code ${code})`));
    }
    this.pending.clear();
    this.child = null;
    this.ready = false;
  }

  /** Stop the worker gracefully: send `stop`, kill the child, clear state. */
  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      this.child.removeAllListeners();
      this.child.postMessage({ type: "stop" } satisfies InventoryWorkerInbound);
      this.child.kill();
    } catch {
      // already gone
    }
    this.child = null;
    this.ready = false;
    // Reject any in-flight requests — the host is shutting down.
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("inventory worker stopped"));
    }
    this.pending.clear();
  }
}
