// Box-queue state tracker — advances the predicted drop queue across ticks,
// deduplicates identical snapshots (the queue only changes when the game
// consumes or appends entries), and consumes the head when the player opens
// chests.
//
// Pure: takes a sequence of RawBoxQueue reads + a sequence of consumption
// events (per-category open counts) and produces the IPC-facing
// BoxQueueSnapshot. Unit-tested over synthetic tick sequences.
//
// Consumption semantics (per user spec):
//   - When the player opens N chests of category C this tick, remove the
//     first N items from the C bucket of the predicted queue.
//   - Removals happen on the *predicted* (stargaze-read) copy, not the live
//     one — the next tick's RawBoxQueue will reflect the actual game state
//     and re-align via snapKey dedup.
//   - If the queue is shorter than N (e.g. prediction lagged behind opens),
//     the bucket is cleared. No negative counts.

import type { BoxQueueItem, BoxQueueSnapshot } from "../../../shared/types";
import { toBoxQueueItems, type RawBoxQueue } from "./boxQueueScanner";

/** One consumption event: "player opened `count` chests of `category`". */
export interface BoxQueueConsumption {
  category: "common" | "rare" | "act";
  count: number;
}

/**
 * Per-tick snapshot key. Two reads with the same key produce identical
 * predicted queues, so we can skip re-emitting when nothing changed.
 *
 * Format: `bucket:eboxType:length:firstItemKey|...` (mirrors stargaze's
 * `snapKey`). Includes only the first item of each bucket to keep the key
 * short — full-equality comparison would require hashing every item.
 */
function snapKeyOf(queue: RawBoxQueue | null): string {
  if (queue == null) return "";
  const parts: string[] = [];
  for (const bucket of queue.buckets) {
    const first = bucket.items[0]?.itemKey ?? 0;
    parts.push(`${bucket.eboxType}:${bucket.items.length}:${first}`);
  }
  return parts.join("|");
}

/**
 * Apply consumption events to a set of per-category queues, returning the
 * post-consumption arrays. Mutates nothing; returns new arrays.
 *
 * Each event removes `count` items from the head of the matching category.
 * Events for the same category accumulate. Counts < 0 are treated as 0.
 */
export function applyConsumption(
  queues: { common: BoxQueueItem[]; rare: BoxQueueItem[]; act: BoxQueueItem[] },
  events: readonly BoxQueueConsumption[],
): { common: BoxQueueItem[]; rare: BoxQueueItem[]; act: BoxQueueItem[] } {
  let common = queues.common;
  let rare = queues.rare;
  let act = queues.act;
  for (const ev of events) {
    const n = Math.max(0, ev.count);
    if (n === 0) continue;
    if (ev.category === "common") {
      common = common.slice(n);
    } else if (ev.category === "rare") {
      rare = rare.slice(n);
    } else if (ev.category === "act") {
      act = act.slice(n);
    }
  }
  return { common, rare, act };
}

/**
 * Per-reader state machine for the box-queue prediction. One instance per
 * LiveMemoryReader; methods called from the reader's tick loop.
 *
 * The state advances as follows each tick:
 *   1. Receive the new RawBoxQueue (or null).
 *   2. If the snapKey matches the previous tick, reuse the previous
 *      predicted queues (the live queue didn't change).
 *   3. If the snapKey changed, re-base the predicted queues on the new
 *      RawBoxQueue (the game appended or consumed entries).
 *   4. Apply any pending consumption events (player opened chests).
 *   5. Emit the resulting BoxQueueSnapshot.
 *
 * Step 4 runs even when the snapKey matches (the live queue lags behind
 * box-open events by one or more ticks).
 */
export class BoxQueueState {
  private lastSnapKey = "";
  private predicted: { common: BoxQueueItem[]; rare: BoxQueueItem[]; act: BoxQueueItem[] } = {
    common: [],
    rare: [],
    act: [],
  };

  /**
   * Advance the state with a new raw queue read + consumption events.
   * Returns the snapshot to publish (always non-null; `status` reflects the
   * diagnostic state). When `rawQueue` is null, the previous predicted
   * queues are preserved (UI stays stable) but `status` reports the failure.
   */
  advance(
    rawQueue: RawBoxQueue | null,
    status: BoxQueueSnapshot["status"],
    consumption: readonly BoxQueueConsumption[],
    nowMs: number,
  ): BoxQueueSnapshot {
    // Re-base on a new raw queue (snapKey changed, or first successful read).
    const key = snapKeyOf(rawQueue);
    if (rawQueue != null && key !== this.lastSnapKey) {
      this.predicted = toBoxQueueItems(rawQueue);
      this.lastSnapKey = key;
    }

    // Apply consumption regardless of whether the snapKey changed — the live
    // queue may not have updated yet even though the player already opened.
    if (consumption.length > 0) {
      this.predicted = applyConsumption(this.predicted, consumption);
    }

    return {
      common: this.predicted.common,
      rare: this.predicted.rare,
      act: this.predicted.act,
      fetchedAt: nowMs,
      status,
    };
  }

  /** Reset all state (called on reader detach / re-attach). */
  reset(): void {
    this.lastSnapKey = "";
    this.predicted = { common: [], rare: [], act: [] };
  }
}
