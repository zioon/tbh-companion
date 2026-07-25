import { useMemo, useSyncExternalStore } from "react";
import type { LookupItem, LookupPriceSnapshot, ResolvedLookupPrice } from "../../../shared/types";
import { resolveLookupPrice } from "../../core/lookupPrice";
import { usePriceStatus } from "./usePrices";
import { reportIpcError } from "./reportError";

// App-lifetime singleton: fetch the snapshot once and subscribe to updates, so
// the hundreds of Lookup cards share one IPC fetch + listener instead of each
// fetching. Backed by useSyncExternalStore.
//
// Deviates from RENDERER.md rule #1 ("one IPC listener per channel in
// TbhProvider.tsx") on purpose: the snapshot can hold ~1k entries and is read
// by every Lookup card, so routing it through TbhProvider's context would
// re-render the whole tab tree on every update. A module-level singleton with
// useSyncExternalStore avoids that — same call pattern TbhProvider already
// makes, just outside the context tree.
//
// Teardown mirrors useStats.ts: when the last subscriber leaves, the IPC
// listener is removed and the cached snapshot is cleared so the module
// doesn't hold references to the ~1k-entry price snapshot (and HMR can't
// accumulate duplicate listeners).
let snapshot: LookupPriceSnapshot | null = null;
let started = false;
let cleanupIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  window.tbh
    .getLookupPrices()
    .then((next) => {
      snapshot = next;
      notify();
    })
    .catch(reportIpcError);
  const off = window.tbh.onLookupPrices((next) => {
    snapshot = next;
    notify();
  });
  cleanupIpc = typeof off === "function" ? off : null;
}

function stop(): void {
  if (cleanupIpc) {
    cleanupIpc();
    cleanupIpc = null;
  }
  started = false;
  snapshot = null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  start();
  return () => {
    listeners.delete(onChange);
    // When the last subscriber leaves, tear down the IPC listener so the
    // module doesn't hold references to the ~1k-entry price snapshot (and
    // HMR can't accumulate duplicate listeners).
    if (listeners.size === 0) {
      stop();
    }
  };
}

function getSnapshot(): LookupPriceSnapshot | null {
  return snapshot;
}

export interface LookupPrices {
  resolve: (item: LookupItem) => ResolvedLookupPrice;
  /** When the snapshot was generated, for "updated X ago"; null until loaded. */
  generatedUtc: string | null;
  /**
   * The raw snapshot (or null). Exposed so the Market tab can diff consecutive
   * snapshots to maintain a client-side price-change log without adding a new
   * IPC channel. Most consumers should use `resolve` instead.
   */
  snapshot: LookupPriceSnapshot | null;
}

/** Resolve any Lookup item to a display price in the user's currency. */
export function useLookupPrices(): LookupPrices {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const currency = usePriceStatus()?.currency ?? "USD";

  return useMemo(
    () => ({
      resolve: (item: LookupItem) => resolveLookupPrice(item, snap, currency),
      generatedUtc: snap?.generatedUtc ?? null,
      snapshot: snap,
    }),
    [snap, currency],
  );
}
