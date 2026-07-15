import { useSyncExternalStore } from "react";
import type { Stats } from "../../../shared/types";
import { reportIpcError } from "./reportError";

// Module-level singleton for stats. Stats update at ~5 Hz (200ms throttle);
// keeping them in TbhContext forces every context consumer to re-render on
// every stats tick, even components that only need inventory/priceStatus.
// useSyncExternalStore ensures only components that actually read stats
// re-render.
let stats: Stats | null = null;
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
    .getStats()
    ?.then((s) => {
      if (s) {
        stats = s;
        notify();
      }
    })
    .catch((err: unknown) => reportIpcError(err, "useStats:getStats"));
  const off = window.tbh.onStats((s) => {
    stats = s;
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
  stats = null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  start();
  return () => {
    listeners.delete(onChange);
    // When the last subscriber leaves, tear down the IPC listener so the
    // module doesn't hold references to stale snapshots (and HMR can't
    // accumulate duplicate listeners).
    if (listeners.size === 0) {
      stop();
    }
  };
}

function getSnapshot(): Stats | null {
  return stats;
}

export function useStats(): Stats | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
