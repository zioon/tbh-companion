import { useSyncExternalStore } from "react";
import type { PriceStatus, PriceProgress } from "../../../shared/types";
import { reportIpcError } from "./reportError";
import { useTbhContext } from "../context/tbhContext";

// Module-level singletons for price status/progress. These were previously in
// TbhContext, but any context value change (e.g. inventory update) would
// re-render every useTbhContext() consumer — including the 5,885 LookupPrice
// components. Moving to useSyncExternalStore ensures only components that
// actually read priceStatus/priceProgress re-render.
//
// Teardown mirrors useStats.ts: when the last subscriber leaves, the IPC
// listeners are removed and the cached snapshots are cleared so the module
// doesn't hold references to large price snapshots (and HMR can't accumulate
// duplicate listeners at 5 Hz).
let priceStatus: PriceStatus | null = null;
let priceProgress: PriceProgress | null = null;
let started = false;
let cleanupIpcStatus: (() => void) | null = null;
let cleanupIpcProgress: (() => void) | null = null;
const statusListeners = new Set<() => void>();
const progressListeners = new Set<() => void>();

function notifyStatus(): void {
  for (const l of statusListeners) l();
}
function notifyProgress(): void {
  for (const l of progressListeners) l();
}

function start(): void {
  if (started) return;
  started = true;
  window.tbh
    .pricesStatus()
    ?.then((ps) => {
      priceStatus = ps;
      notifyStatus();
    })
    .catch((err: unknown) => reportIpcError(err, "usePriceStatus:init"));
  const offStatus = window.tbh.onPriceStatus((ps) => {
    priceStatus = ps;
    notifyStatus();
  });
  const offProgress = window.tbh.onPricesProgress((p) => {
    priceProgress = p.finished ? null : p;
    notifyProgress();
    if (p.finished) {
      void window.tbh
        .pricesStatus()
        .then((ps) => {
          priceStatus = ps;
          notifyStatus();
        })
        .catch((err: unknown) => reportIpcError(err, "usePriceStatus:refresh"));
    }
  });
  cleanupIpcStatus = typeof offStatus === "function" ? offStatus : null;
  cleanupIpcProgress = typeof offProgress === "function" ? offProgress : null;
}

function stop(): void {
  if (cleanupIpcStatus) {
    cleanupIpcStatus();
    cleanupIpcStatus = null;
  }
  if (cleanupIpcProgress) {
    cleanupIpcProgress();
    cleanupIpcProgress = null;
  }
  started = false;
  priceStatus = null;
  priceProgress = null;
}

function subscribeStatus(onChange: () => void): () => void {
  statusListeners.add(onChange);
  start();
  return () => {
    statusListeners.delete(onChange);
    // When the last subscriber leaves, tear down the IPC listeners so the
    // module doesn't hold references to stale price snapshots (and HMR can't
    // accumulate duplicate listeners).
    if (statusListeners.size === 0 && progressListeners.size === 0) {
      stop();
    }
  };
}

function subscribeProgress(onChange: () => void): () => void {
  progressListeners.add(onChange);
  start();
  return () => {
    progressListeners.delete(onChange);
    if (statusListeners.size === 0 && progressListeners.size === 0) {
      stop();
    }
  };
}

function getStatusSnapshot(): PriceStatus | null {
  return priceStatus;
}

function getProgressSnapshot(): PriceProgress | null {
  return priceProgress;
}

export function usePriceStatus(): PriceStatus | null {
  return useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusSnapshot);
}

export function usePriceProgress(): PriceProgress | null {
  return useSyncExternalStore(subscribeProgress, getProgressSnapshot, getProgressSnapshot);
}

/** Imperative setters for components that need to dispatch price updates. */
export function setPriceStatus(ps: PriceStatus | null): void {
  priceStatus = ps;
  notifyStatus();
}

export function clearPriceProgress(): void {
  if (priceProgress !== null) {
    priceProgress = null;
    notifyProgress();
  }
}

export function usePriceActions() {
  const { clearLastPriceRefreshMessage } = useTbhContext();
  return { setPriceStatus, clearPriceProgress, clearLastPriceRefreshMessage };
}

export function useLastPriceRefreshMessage(): string | null {
  return useTbhContext().lastPriceRefreshMessage;
}
