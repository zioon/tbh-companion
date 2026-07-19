// P1-6: IPC protocol + pure handlers for the inventory-resolve utilityProcess.
//
// Splitting the protocol/handlers into a framework-free module serves two
// purposes:
//   1. The worker entry script (`inventoryWorkerEntry.ts`) can stay thin —
//      it only wires `parentPort` to these handlers.
//   2. Tests can exercise the resolve pipeline (10万件 items, price lookup,
//      exclude rules) without spawning an Electron utilityProcess.
//
// `resolveInventory` itself lives in `core/inventory/` and stays pure — the
// worker imports it directly. This module just adapts the IPC payloads
// (which arrive as plain JSON-serializable values) into the function-shaped
// inputs `resolveInventory` expects (Map + callbacks).

import { resolveInventory } from "../../core/inventory";
import type { GameItem } from "../../core/gamedata";
import type { SteamMarketFeeRates } from "../../core/steamMarketFee";
import type {
  InventoryPriceInfo,
  InventorySnapshot,
  ResolvedInventory,
} from "../../../shared/types";

/** State held inside the worker process between IPC calls. */
export interface InventoryWorkerState {
  /** Catalog lookup: itemKey → GameItem. Rebuilt on every `init`. */
  gameDataMap: Map<number, GameItem>;
  /** Steam market fee rates snapshot at init time. */
  feeRates: SteamMarketFeeRates;
}

/** Host → worker: bootstrap or refresh state. Sent once at startup and again
 *  whenever `gameData` reloads or `feeRates` change. */
export interface InventoryWorkerInitMessage {
  type: "init";
  /** Map serialized as entries for structured-clone friendliness. */
  gameDataEntries: Array<[number, GameItem]>;
  feeRates: SteamMarketFeeRates;
}

/** Host → worker: a single resolve request. The worker replies with
 *  {@link InventoryWorkerResolveResponse} keyed by `id`. */
export interface InventoryWorkerResolveMessage {
  type: "resolve";
  /** Correlates the response back to the request. */
  id: number;
  snapshot: InventorySnapshot;
  /** `Map<hash, InventoryPriceInfo>` serialized as entries. */
  priceLookupEntries: Array<[string, InventoryPriceInfo]>;
  /** Optional itemKey exclusion list (e.g. stage boxes hidden from the
   *  inventory view). */
  excludeItemKeys?: number[];
}

/** Host → worker: stop the worker and exit. */
export interface InventoryWorkerStopMessage {
  type: "stop";
}

export type InventoryWorkerInbound =
  | InventoryWorkerInitMessage
  | InventoryWorkerResolveMessage
  | InventoryWorkerStopMessage;

/** Worker → host: resolve result (success or failure). */
export interface InventoryWorkerResolveResponse {
  type: "resolve";
  id: number;
  resolved?: ResolvedInventory;
  error?: string;
}

/** Worker → host: ready signal after `init` completes. */
export interface InventoryWorkerReadyMessage {
  type: "ready";
}

/** Worker → host: log line forwarded to the host logger. */
export interface InventoryWorkerLogMessage {
  type: "log";
  message: string;
}

export type InventoryWorkerOutbound =
  | InventoryWorkerResolveResponse
  | InventoryWorkerReadyMessage
  | InventoryWorkerLogMessage;

/**
 * Apply an `init` message: rebuild the state from scratch. We do NOT merge
 * with previous state — `gameData` reloads are full-snapshot (the catalog
 * file is small and reloaded wholesale by `GameDataProvider.load`), so a
 * fresh Map avoids any chance of stale entries lingering across a reload.
 */
export function handleInit(
  _prev: InventoryWorkerState | null,
  msg: InventoryWorkerInitMessage,
): InventoryWorkerState {
  return {
    gameDataMap: new Map(msg.gameDataEntries),
    feeRates: msg.feeRates,
  };
}

/**
 * Apply a `resolve` message against the worker state. Mirrors what
 * `InventoryService.resolveAndPushInventory` used to do synchronously on the
 * main thread — same `resolveInventory` call, same `gameDataLoaded=true`
 * invariant (the host only sends `init` after `GameDataProvider.load`), same
 * exclude + fee-rates wiring. The work now happens in a separate OS process,
 * so the main thread stays free for IPC + window management even when the
 * player's inventory grows to 10万件 items.
 */
export function handleResolve(
  state: InventoryWorkerState | null,
  msg: InventoryWorkerResolveMessage,
): ResolvedInventory {
  if (!state) {
    throw new Error("inventory worker not initialized — send init first");
  }
  const priceMap = new Map(msg.priceLookupEntries);
  const excludeSet = msg.excludeItemKeys ? new Set(msg.excludeItemKeys) : null;
  return resolveInventory(
    msg.snapshot,
    (key) => state.gameDataMap.get(key),
    true,
    (hash) => priceMap.get(hash),
    {
      excludeItemKey: excludeSet ? (key: number) => excludeSet.has(key) : undefined,
      marketFeeRates: state.feeRates,
    },
  );
}
