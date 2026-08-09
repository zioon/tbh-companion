import { useEffect, useSyncExternalStore } from "react";
import { useLookupPrices } from "./useLookupPrices";

/**
 * A single observed price change. Captured client-side by diffing consecutive
 * `LookupPriceSnapshot.prices` push events (CI snapshot refresh + local
 * polling merge both arrive on the same `LOOKUP_PRICES` channel). The market
 * tab renders the most recent `MAX_ENTRIES` entries as a "recent changes" log
 * so users can see what the polling cycle just updated.
 *
 * 同时跟踪 `prices`（USD，CI 来源）和 `pricesLocal`（目标货币，本地 polling
 * 来源）的变化。当本地 polling 写入新价格时，两个字典可能同时变化；日志
 * 会分别记录 USD 变动和本地货币变动，让用户看到完整的价目轨迹。
 */
export interface LookupPriceChange {
  /** market_hash_name */
  hash: string;
  /** Previous USD price; null = previously unlisted / unknown. */
  oldUsd: number | null;
  /** New USD price; null = now unlisted. */
  newUsd: number | null;
  /** Previous local-currency price; null/undefined = previously unlisted / unknown. */
  oldLocal: number | null | undefined;
  /** New local-currency price; null/undefined = now unlisted. */
  newLocal: number | null | undefined;
  /** Epoch ms when the snapshot carrying the new price arrived. */
  atMs: number;
}

export const MAX_LOOKUP_PRICE_CHANGES = 50;

// App-lifetime singleton: the change log lives at module scope so it survives
// tab switches (and component unmounts). Diffing still happens against the
// live `LOOKUP_PRICES` snapshot via `useLookupPrices`, but the accumulated
// entries and the previous-snapshot reference are not reset when the Market
// tab is hidden — only `useLookupPrices` tears down its IPC listener when the
// last subscriber leaves, and the retained `prevPrices`/`prevLocal` let the
// next snapshot resume diffing from where it left off.
//
// Pure client-side: no new IPC, no persistence — the log resets on a full app
// reload, but not on tab switches.
let history: LookupPriceChange[] = [];
let prevPrices: Record<string, number | null> | null = null;
let prevLocal: Record<string, number | null> | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): LookupPriceChange[] {
  return history;
}

/**
 * Diff an incoming snapshot against the retained previous one and append any
 * changes to the module-level log. No-op while the Market tab is unmounted
 * (only reached through the hook's `useLookupPrices` subscription).
 */
function processSnapshot(snapshot: ReturnType<typeof useLookupPrices>["snapshot"]): void {
  if (!snapshot) {
    prevPrices = null;
    prevLocal = null;
    return;
  }
  const oldPrices = prevPrices;
  const oldLocal = prevLocal;
  prevPrices = snapshot.prices;
  prevLocal = snapshot.pricesLocal ?? null;
  if (!oldPrices && !oldLocal) return; // first snapshot — nothing to diff

  const nowMs = Date.now();
  const newEntries: LookupPriceChange[] = [];
  const seenHashes = new Set<string>();

  // Diff USD prices
  for (const [hash, newUsd] of Object.entries(snapshot.prices)) {
    seenHashes.add(hash);
    const oldUsd = oldPrices?.[hash] ?? null;
    const newLocal = snapshot.pricesLocal?.[hash] ?? null;
    const oldLocalVal = oldLocal?.[hash] ?? null;
    // USD 变了，或 local 变了，或两者从无到有
    const usdChanged = oldUsd !== newUsd && !(oldUsd == null && newUsd == null);
    const localChanged = oldLocalVal !== newLocal && !(oldLocalVal == null && newLocal == null);
    if (!usdChanged && !localChanged) continue;
    newEntries.push({
      hash,
      oldUsd: oldUsd ?? null,
      newUsd: newUsd ?? null,
      oldLocal: oldLocalVal,
      newLocal,
      atMs: nowMs,
    });
  }

  // Hashes that disappeared from prices (USD)
  if (oldPrices) {
    for (const [hash, oldUsd] of Object.entries(oldPrices)) {
      if (seenHashes.has(hash)) continue;
      if (oldUsd == null) continue;
      newEntries.push({
        hash,
        oldUsd,
        newUsd: null,
        oldLocal: oldLocal?.[hash] ?? null,
        newLocal: null,
        atMs: nowMs,
      });
    }
  }

  // Hashes only in pricesLocal (not in prices) — rare but possible
  if (snapshot.pricesLocal) {
    for (const [hash, newLocal] of Object.entries(snapshot.pricesLocal)) {
      if (seenHashes.has(hash)) continue;
      const oldLocalVal = oldLocal?.[hash] ?? null;
      const localChanged = oldLocalVal !== newLocal && !(oldLocalVal == null && newLocal == null);
      if (!localChanged) continue;
      newEntries.push({
        hash,
        oldUsd: oldPrices?.[hash] ?? null,
        newUsd: oldPrices?.[hash] ?? null,
        oldLocal: oldLocalVal,
        newLocal,
        atMs: nowMs,
      });
    }
  }

  if (newEntries.length === 0) return;
  newEntries.sort((a, b) => b.atMs - a.atMs);
  const merged = [...newEntries, ...history];
  history =
    merged.length > MAX_LOOKUP_PRICE_CHANGES ? merged.slice(0, MAX_LOOKUP_PRICE_CHANGES) : merged;
  emit();
}

/**
 * Rolling log of price changes observed on the `LOOKUP_PRICES` push channel.
 * Diffing happens against the live snapshot; the accumulated entries live at
 * module scope so they are preserved across tab switches. Capped at
 * {@link MAX_LOOKUP_PRICE_CHANGES} entries (newest first).
 */
export function useLookupPriceHistory(): LookupPriceChange[] {
  const { snapshot } = useLookupPrices();
  const changes = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    processSnapshot(snapshot);
  }, [snapshot]);

  return changes;
}
