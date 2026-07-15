import { useEffect, useState, useSyncExternalStore, useRef } from "react";
import type { LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";
import { reportIpcError } from "./reportError";

/**
 * Subscribe only to live-memory status (low-frequency, state-change driven).
 * Use this in components that don't need the 25 Hz snapshot stream — e.g. the
 * toolbar indicator badge — to avoid unnecessary React re-renders and heap
 * pressure from large snapshot objects.
 */
export function useLiveMemoryStatus(): LiveMemoryStatus | null {
  const [status, setStatus] = useState<LiveMemoryStatus | null>(null);

  useEffect(() => {
    let active = true;
    window.tbh
      .getLiveMemoryStatus?.()
      ?.then((s) => {
        if (active && s) setStatus(s);
      })
      .catch((err: unknown) => reportIpcError(err, "useLiveMemoryStatus:getStatus"));
    const offStatus = window.tbh.onLiveMemoryStatus?.((s) => setStatus(s));
    return () => {
      active = false;
      offStatus?.();
    };
  }, []);

  return status;
}

// --- Module-level snapshot store for derived-field subscriptions ---
// The full snapshot is large (heroes[], inventoryItems[], petData[], monsterHp[],
// etc.) but most consumers only need a few scalar fields. useSyncExternalStore
// with a custom selector avoids re-rendering when only unrelated fields change.
let snapshot: LiveMemorySnapshot | null = null;
let started = false;
const listeners = new Set<() => void>();

function notifySnapshots(): void {
  for (const l of listeners) l();
}

function startSnapshotStore(): void {
  if (started) return;
  started = true;
  window.tbh
    .getLiveMemory?.()
    ?.then((s) => {
      if (s) {
        snapshot = s;
        notifySnapshots();
      }
    })
    .catch((err: unknown) => reportIpcError(err, "useLiveMemoryFields:init"));
  window.tbh.onLiveMemory?.((s) => {
    snapshot = s;
    notifySnapshots();
  });
  window.tbh.onLiveMemoryStatus?.((s) => {
    if (!s.running) {
      snapshot = null;
      notifySnapshots();
    }
  });
}

function subscribeSnapshot(onChange: () => void): () => void {
  listeners.add(onChange);
  startSnapshotStore();
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Subscribe to a derived slice of the live-memory snapshot. The selector runs
 * on every snapshot update, but the component only re-renders when the selected
 * value changes by reference equality. This prevents the large snapshot arrays
 * (heroes, inventoryItems, petData, monsterHp) from causing unnecessary
 * re-renders in components that only read scalar fields like `connected` or
 * `stageKey`.
 */
export function useLiveMemoryField<T>(
  selector: (snap: LiveMemorySnapshot | null) => T,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const getSlice = useRef((): T => selectorRef.current(snapshot)).current;

  return useSyncExternalStore(subscribeSnapshot, getSlice, getSlice);
}

/**
 * Convenience: subscribe to just the scalar fields Live.tsx needs without
 * pulling the full snapshot into React state. Returns a stable reference that
 * only changes when `connected`, `chestDrops`, `stageKey`, or `stageWave`
 * actually change.
 */
export interface LiveMemoryScalars {
  connected: boolean;
  hasChestDrops: boolean;
  stageKey: number | null;
  stageWave: number | null;
}

const NULL_SCALARS: LiveMemoryScalars = {
  connected: false,
  hasChestDrops: false,
  stageKey: null,
  stageWave: null,
};

let lastScalars: LiveMemoryScalars = NULL_SCALARS;
let lastSnapshotForScalars: LiveMemorySnapshot | null = null;

function getScalars(): LiveMemoryScalars {
  if (snapshot !== lastSnapshotForScalars) {
    lastSnapshotForScalars = snapshot;
    const next: LiveMemoryScalars = snapshot
      ? {
          connected: snapshot.connected === true,
          hasChestDrops: snapshot.chestDrops != null,
          stageKey: snapshot.stageKey ?? null,
          stageWave: snapshot.stageWave ?? null,
        }
      : NULL_SCALARS;
    // Shallow compare — only update if a value actually changed
    if (
      next.connected !== lastScalars.connected ||
      next.hasChestDrops !== lastScalars.hasChestDrops ||
      next.stageKey !== lastScalars.stageKey ||
      next.stageWave !== lastScalars.stageWave
    ) {
      lastScalars = next;
    }
  }
  return lastScalars;
}

export function useLiveMemoryScalars(): LiveMemoryScalars {
  return useSyncExternalStore(subscribeSnapshot, getScalars, getScalars);
}

/**
 * Standalone live-memory subscription. Intentionally NOT part of TbhProvider:
 * snapshots arrive at the poll rate and only the components that read live data
 * should re-render — never the whole app.
 *
 * When the reader stops (a `running: false` status), the snapshot is cleared so
 * every stat reverts to its save-file source (per-stat live/save blend).
 *
 * Only use this hook in components that actually render snapshot data (e.g. the
 * LiveMemoryDiagnostics dev tab). For status-only needs, prefer
 * useLiveMemoryStatus. For scalar fields, prefer useLiveMemoryScalars.
 */
export function useLiveMemory(): {
  snapshot: LiveMemorySnapshot | null;
  status: LiveMemoryStatus | null;
} {
  const [snap, setSnapshot] = useState<LiveMemorySnapshot | null>(null);
  const [status, setStatus] = useState<LiveMemoryStatus | null>(null);

  useEffect(() => {
    let active = true;
    window.tbh
      .getLiveMemory?.()
      ?.then((s) => {
        if (active && s) setSnapshot(s);
      })
      .catch((err: unknown) => reportIpcError(err, "useLiveMemory:getSnapshot"));
    window.tbh
      .getLiveMemoryStatus?.()
      ?.then((s) => {
        if (active && s) setStatus(s);
      })
      .catch((err: unknown) => reportIpcError(err, "useLiveMemory:getStatus"));
    const offSnap = window.tbh.onLiveMemory?.((s) => setSnapshot(s));
    const offStatus = window.tbh.onLiveMemoryStatus?.((s) => {
      setStatus(s);
      if (!s.running) setSnapshot(null);
    });
    return () => {
      active = false;
      offSnap?.();
      offStatus?.();
    };
  }, []);

  return { snapshot: snap, status };
}
