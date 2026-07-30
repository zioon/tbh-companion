import { useEffect, useRef, useState } from "react";
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

/**
 * Maintain a rolling log of price changes observed on the
 * `LOOKUP_PRICES` push channel. Diffs the previous snapshot's `prices`
 * and `pricesLocal` against each incoming snapshot and records entries
 * where the price or listing state changed. Capped at
 * {@link MAX_LOOKUP_PRICE_CHANGES} entries (newest first).
 *
 * Pure client-side: no new IPC, no persistence — the log lives only for the
 * current app session. Reload resets it.
 */
export function useLookupPriceHistory(): LookupPriceChange[] {
  const { snapshot } = useLookupPrices();
  const prevPricesRef = useRef<Record<string, number | null> | null>(null);
  const prevLocalRef = useRef<Record<string, number | null> | null>(null);
  const [changes, setChanges] = useState<LookupPriceChange[]>([]);

  useEffect(() => {
    if (!snapshot) {
      prevPricesRef.current = null;
      prevLocalRef.current = null;
      return;
    }
    const prevPrices = prevPricesRef.current;
    const prevLocal = prevLocalRef.current;
    prevPricesRef.current = snapshot.prices;
    prevLocalRef.current = snapshot.pricesLocal ?? null;
    if (!prevPrices && !prevLocal) return; // first snapshot — nothing to diff

    const nowMs = Date.now();
    const newEntries: LookupPriceChange[] = [];
    const seenHashes = new Set<string>();

    // Diff USD prices
    for (const [hash, newUsd] of Object.entries(snapshot.prices)) {
      seenHashes.add(hash);
      const oldUsd = prevPrices?.[hash] ?? null;
      const newLocal = snapshot.pricesLocal?.[hash] ?? null;
      const oldLocal = prevLocal?.[hash] ?? null;
      // USD 变了，或 local 变了，或两者从无到有
      const usdChanged = oldUsd !== newUsd && !(oldUsd == null && newUsd == null);
      const localChanged = oldLocal !== newLocal && !(oldLocal == null && newLocal == null);
      if (!usdChanged && !localChanged) continue;
      newEntries.push({
        hash,
        oldUsd: oldUsd ?? null,
        newUsd: newUsd ?? null,
        oldLocal,
        newLocal,
        atMs: nowMs,
      });
    }

    // Hashes that disappeared from prices (USD)
    if (prevPrices) {
      for (const [hash, oldUsd] of Object.entries(prevPrices)) {
        if (seenHashes.has(hash)) continue;
        if (oldUsd == null) continue;
        newEntries.push({
          hash,
          oldUsd,
          newUsd: null,
          oldLocal: prevLocal?.[hash] ?? null,
          newLocal: null,
          atMs: nowMs,
        });
      }
    }

    // Hashes only in pricesLocal (not in prices) — rare but possible
    if (snapshot.pricesLocal) {
      for (const [hash, newLocal] of Object.entries(snapshot.pricesLocal)) {
        if (seenHashes.has(hash)) continue;
        const oldLocal = prevLocal?.[hash] ?? null;
        const localChanged = oldLocal !== newLocal && !(oldLocal == null && newLocal == null);
        if (!localChanged) continue;
        newEntries.push({
          hash,
          oldUsd: prevPrices?.[hash] ?? null,
          newUsd: prevPrices?.[hash] ?? null,
          oldLocal,
          newLocal,
          atMs: nowMs,
        });
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
