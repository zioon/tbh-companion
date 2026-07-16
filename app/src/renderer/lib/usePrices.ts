import { useSyncExternalStore } from "react";
import type { PriceStatus, PriceProgress } from "../../../shared/types";
import { reportIpcError } from "./reportError";
import { useTbhContext } from "../context/tbhContext";

// Module-level singletons for price status/progress. These were previously in
// TbhContext, but any context value change (e.g. inventory update) would
// re-render every useTbhContext() consumer — including the 5,885 LookupPrice
// components. Moving to useSyncExternalStore ensures only components that
// actually read priceStatus/priceProgress re-render.
let priceStatus: PriceStatus | null = null;
let priceProgress: PriceProgress | null = null;
let started = false;
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
  window.tbh.onPriceStatus((ps) => {
    priceStatus = ps;
    notifyStatus();
  });
  window.tbh.onPricesProgress((p) => {
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
}

function subscribeStatus(onChange: () => void): () => void {
  statusListeners.add(onChange);
  start();
  return () => {
    statusListeners.delete(onChange);
  };
}

function subscribeProgress(onChange: () => void): () => void {
  progressListeners.add(onChange);
  start();
  return () => {
    progressListeners.delete(onChange);
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
