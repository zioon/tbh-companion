import { useSyncExternalStore } from "react";
import { reportIpcError } from "./reportError";

// Module-level singleton: a `Set<string>` of the user's watched
// `market_hash_name` list, plus the full config (so toggling can call
// `saveConfig` with the merged patch). Subscribes to the polling-status
// push channel but only notifies subscribers when the watchedHashes *content*
// actually changes — this keeps the 5,885 ItemCard subscribers from
// re-rendering on every progress tick (the polling-status payload fires on
// every item priced, but watchedHashes only changes on user toggle).
//
// The toggle writes via `window.tbh.saveConfig({ lookupPricePolling: {...} })`;
// the main process applies the patch and calls `lookupPricePolling.setConfig`,
// which emits a new status. We see the new watchedHashes in the push and
// notify ItemCards to re-render their star state.

let watchedSet: Set<string> = new Set();
let lastConfig: {
  enabled: boolean;
  intervalMinutes: number;
  thresholdUsd: number;
  watchedHashes: string[];
} | null = null;
let started = false;
let cleanupIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function applyStatus(
  status: {
    config: { watchedHashes: string[] };
  } | null,
): void {
  const next = status?.config.watchedHashes ?? [];
  // Only notify when the watched set actually changed (content equality).
  // Progress ticks produce a new status object but identical watchedHashes,
  // so this guard prevents re-rendering every ItemCard on each priced item.
  const same = next.length === watchedSet.size && next.every((h) => watchedSet.has(h));
  if (same) return;
  watchedSet = new Set(next);
  notify();
}

function start(): void {
  if (started) return;
  started = true;
  window.tbh
    .getLookupPricePollStatus()
    ?.then((s) => {
      lastConfig = s?.config ?? null;
      applyStatus(s);
    })
    .catch((err: unknown) => reportIpcError(err, "useWatchedHashes:init"));
  const off = window.tbh.onLookupPricePollStatus((s) => {
    lastConfig = s.config;
    applyStatus(s);
  });
  cleanupIpc = typeof off === "function" ? off : null;
}

function stop(): void {
  if (cleanupIpc) {
    cleanupIpc();
    cleanupIpc = null;
  }
  started = false;
  watchedSet = new Set();
  lastConfig = null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  start();
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      stop();
    }
  };
}

function getSnapshot(): Set<string> {
  return watchedSet;
}

/** Read-only access to the watched-hash set. Re-renders only on actual change. */
export function useWatchedHashesSet(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Toggle a `market_hash_name` in the user's watched list. Writes via
 * `saveConfig`; the polling-status push that follows will update the set
 * returned by `useWatchedHashesSet`. Returns the new membership state.
 */
export async function toggleWatchedHash(hash: string): Promise<boolean> {
  if (!hash) return false;
  const current = lastConfig?.watchedHashes ?? Array.from(watchedSet);
  const exists = current.includes(hash);
  const next = exists ? current.filter((h) => h !== hash) : [...current, hash];
  // Optimistic local update so the star flips immediately; the push from main
  // is the source of truth and will reconcile.
  watchedSet = new Set(next);
  for (const l of listeners) l();
  try {
    const saved = await window.tbh.saveConfig({
      lookupPricePolling: {
        enabled: lastConfig?.enabled ?? false,
        intervalMinutes: lastConfig?.intervalMinutes ?? 10,
        thresholdUsd: lastConfig?.thresholdUsd ?? 1.0,
        watchedHashes: next,
      },
    });
    lastConfig = saved.lookupPricePolling ?? null;
    return !exists;
  } catch (err) {
    reportIpcError(err, "useWatchedHashes:toggle");
    // Revert on failure
    watchedSet = new Set(current);
    for (const l of listeners) l();
    return exists;
  }
}
