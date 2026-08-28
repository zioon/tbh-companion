import type { MarketVolumeItem, MarketVolumeRefreshProgress } from "../../../shared/types";

// Module-level store replaces the three TbhProvider context fields
// (marketVolumeProgress / marketVolumePending / setMarketVolumePending).
// Rationale: onMarketVolumeRefreshProgress fires once per completed item during
// a history refresh (tens to hundreds of pushes). Keeping that in the global
// context re-rendered every useTbhContext() consumer on every push — including
// LootBoxSection cards that only read `inventory.currency`. Only the Trading
// tab (via useMarketVolumeItems) needs this data.

const EMPTY_PROGRESS: MarketVolumeRefreshProgress = {
  running: false,
  total: 0,
  done: 0,
  currentHash: null,
};

let progress: MarketVolumeRefreshProgress = EMPTY_PROGRESS;
let pending: MarketVolumeItem[] = [];
let subscribed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Idempotent IPC subscription; lives for the app's renderer lifetime. */
export function ensureMarketVolumeRefreshSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  window.tbh.onMarketVolumeRefreshProgress((p) => {
    if (!p.running) {
      // Refresh finished (running -> false): clear the pending placeholder list
      // so `refreshStatusByHash` doesn't leave stale lit-rings behind.
      progress = p;
      pending = [];
    } else {
      progress = p;
      // Refresh start publishes this batch's placeholder cards (auto/manual share).
      if (p.pending) pending = p.pending;
      // Each completed item swaps in its latest card in place of the placeholder.
      if (p.updatedItem) {
        const updated = p.updatedItem;
        const idx = pending.findIndex((it) => it.hash === updated.hash);
        if (idx >= 0) {
          pending = pending.map((it, i) => (i === idx ? updated : it));
        }
      }
    }
    emit();
  });
}

export function subscribeMarketVolumeRefresh(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getMarketVolumeRefreshProgress(): MarketVolumeRefreshProgress {
  return progress;
}

export function getMarketVolumePending(): MarketVolumeItem[] {
  return pending;
}

export function setMarketVolumePending(items: MarketVolumeItem[]): void {
  pending = items;
  emit();
}
