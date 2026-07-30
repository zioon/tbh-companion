import { useSyncExternalStore } from "react";
import type { LookupPricePollingStatus, PollingCycleResult } from "../../../shared/types";
import { reportIpcError } from "./reportError";

// Module-level singleton for lookup-price polling status. Mirrors the pattern
// in usePrices.ts: useSyncExternalStore ensures only components that actually
// read polling status re-render (e.g. the Lookup tab's refresh button + status
// row, the Market tab's polling badge). The polling service pushes status
// updates on every cycle start / per-item progress / cycle end, so subscribers
// see live progress while a cycle is running.
//
// Teardown: when the last subscriber leaves, the IPC listener is removed and
// the cached status is cleared (mirrors usePrices.ts / useLookupPrices.ts so
// HMR can't accumulate duplicate listeners).
let pollStatus: LookupPricePollingStatus | null = null;
let started = false;
let cleanupIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function start(): void {
  if (started) return;
  started = true;
  window.tbh
    .getLookupPricePollStatus()
    ?.then((s) => {
      pollStatus = s;
      notify();
    })
    .catch((err: unknown) => reportIpcError(err, "useLookupPricePolling:init"));
  const off = window.tbh.onLookupPricePollStatus((s) => {
    pollStatus = s;
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
  pollStatus = null;
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

function getSnapshot(): LookupPricePollingStatus | null {
  return pollStatus;
}

export function useLookupPricePolling(): LookupPricePollingStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Imperative trigger: ask the main process to run a polling cycle now. Returns
 * the cycle result. Safe to call when polling is disabled (main returns
 * aborted) or when a cycle is already running (main returns aborted with
 * targets=0). The caller should reflect loading state via the `running` field
 * of `useLookupPricePolling()` instead of awaiting this promise.
 *
 * 传 `hash` 时只抓单个物品的三档价格（绕过 polling 配置和目标筛选），
 * 用于图鉴 UI「立即刷新此物品」按钮。不传则跑完整 cycle（含所有 owned +
 * watched 目标）。
 */
export async function triggerLookupPricePoll(hash?: string): Promise<PollingCycleResult | null> {
  try {
    return await window.tbh.pollLookupPrices(hash);
  } catch (err) {
    reportIpcError(err, "useLookupPricePolling:trigger");
    return null;
  }
}
