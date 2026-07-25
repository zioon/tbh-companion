import { useEffect, useRef, useState } from "react";
import { useLookupPrices } from "./useLookupPrices";

/**
 * A single observed price change. Captured client-side by diffing consecutive
 * `LookupPriceSnapshot.prices` push events (CI snapshot refresh + local
 * polling merge both arrive on the same `LOOKUP_PRICES` channel). The market
 * tab renders the most recent `MAX_ENTRIES` entries as a "recent changes" log
 * so users can see what the polling cycle just updated.
 */
export interface LookupPriceChange {
  /** market_hash_name */
  hash: string;
  /** Previous USD price; null = previously unlisted / unknown. */
  oldUsd: number | null;
  /** New USD price; null = now unlisted. */
  newUsd: number | null;
  /** Epoch ms when the snapshot carrying the new price arrived. */
  atMs: number;
}

export const MAX_LOOKUP_PRICE_CHANGES = 50;

/**
 * Maintain a rolling log of price changes observed on the
 * `LOOKUP_PRICES` push channel. Diffs the previous snapshot's `prices`
 * against each incoming snapshot and records entries where the price or
 * listing state changed. Capped at {@link MAX_LOOKUP_PRICE_CHANGES} entries
 * (newest first).
 *
 * Pure client-side: no new IPC, no persistence — the log lives only for the
 * current app session. Reload resets it.
 */
export function useLookupPriceHistory(): LookupPriceChange[] {
  const { snapshot } = useLookupPrices();
  const prevPricesRef = useRef<Record<string, number | null> | null>(null);
  const [changes, setChanges] = useState<LookupPriceChange[]>([]);

  useEffect(() => {
    if (!snapshot) {
      prevPricesRef.current = null;
      return;
    }
    const prev = prevPricesRef.current;
    prevPricesRef.current = snapshot.prices;
    if (!prev) return; // first snapshot — nothing to diff

    const nowMs = Date.now();
    const newEntries: LookupPriceChange[] = [];
    for (const [hash, newUsd] of Object.entries(snapshot.prices)) {
      const oldUsd = prev[hash];
      // Skip if the value is identical (typeof null === "object", so handle
      // both null and number uniformly)
      if (oldUsd === newUsd) continue;
      // Skip null→null (no actual change)
      if (oldUsd == null && newUsd == null) continue;
      newEntries.push({ hash, oldUsd: oldUsd ?? null, newUsd: newUsd ?? null, atMs: nowMs });
    }
    // Also detect hashes that disappeared (price was a number, now absent
    // from snapshot) — rare, but CI re-runs can prune stale entries.
    for (const [hash, oldUsd] of Object.entries(prev)) {
      if (oldUsd == null) continue;
      if (!(hash in snapshot.prices)) {
        newEntries.push({ hash, oldUsd, newUsd: null, atMs: nowMs });
      }
    }

    if (newEntries.length === 0) return;
    newEntries.sort((a, b) => b.atMs - a.atMs);
    setChanges((cur) => {
      const merged = [...newEntries, ...cur];
      return merged.length > MAX_LOOKUP_PRICE_CHANGES
        ? merged.slice(0, MAX_LOOKUP_PRICE_CHANGES)
        : merged;
    });
  }, [snapshot]);

  return changes;
}
