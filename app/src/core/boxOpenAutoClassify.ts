// Pure helpers for the auto-classify queue: FIFO matching of chest drops to
// subsequent unclassified box opens, plus grouping of BoxOpenLog bursts into
// single "open events" so one chest's multi-item drop consumes one queue slot.
// Pure: no Electron, no React, no fs.

import { categoryFromBoxKey } from "./boxOpenLog";

/**
 * Serial-queue auto-open model (per-category shared timer).
 *
 * The game runs ONE shared auto-open timer per category (common / rare /
 * act). The timer targets the head of the category's queue; when it elapses,
 * the head chest is opened, the timer immediately retargets the new head
 * (whose `autoOpenAtMs` was precomputed at its drop time and does NOT
 * change), and so on. A new chest dropped into a non-empty category queue
 * is appended to the tail with
 *   `autoOpenAtMs = prevTail.autoOpenAtMs + autoOpenSeconds * 1000`
 * — NOT `droppedAtMs + autoOpenSeconds * 1000`, because the timer is busy
 * with the head and won't reach this chest until all preceding chests have
 * opened. When the category queue is empty, the timer is idle and the next
 * drop starts it fresh with `autoOpenAtMs = droppedAtMs + autoOpenSeconds`.
 *
 * Manual opens of the head do not affect other items' timers — the new head
 * keeps its original precomputed `autoOpenAtMs`. Slot pools are per-category
 * and independent (a common chest drop never delays a rare chest's timer).
 * When a category's slot pool is full, the game rate-limits drops, so the
 * companion never has to handle "no slot available" for an incoming drop.
 *
 * Consequence for the queue: every queued item always has a concrete
 * `autoOpenAtMs` (no "waiting" state). The queue is sorted by `autoOpenAtMs`
 * ascending so the head is the next chest expected to auto-open globally
 * (across all categories, since `insertSorted` is global).
 */

/** Min TTL floor (ms). Prevents rune-reduced autoOpen from expiring entries instantly. */
const MIN_TTL_MS = 60_000;
/** Buffer added on top of autoOpen (ms). Covers reader latency + burst aggregation. */
const TTL_BUFFER_MS = 30_000;

/**
 * Compute the TTL for a queue entry from the chest's effective auto-open
 * seconds. TTL is anchored to `autoOpenAtMs` (the chest's real auto-open
 * moment, already including any queue-wait time under the serial model),
 * so one autoOpen cycle of coverage after that moment is sufficient for the
 * unclassified burst to arrive and be matched. `MIN_TTL_MS` guards against
 * runes reducing autoOpen to 0.
 */
export function computeTtlMs(autoOpenSeconds: number): number {
  return Math.max(autoOpenSeconds * 1000, MIN_TTL_MS) + TTL_BUFFER_MS;
}

/** A queued chest drop awaiting its subsequent open event. */
export interface QueueItem {
  boxKey: string;
  droppedAtMs: number;
  stageKey: number;
  /**
   * Wall-clock ms when this queue entry expires. TTL is anchored to the
   * chest's auto-open time (not its drop time), so
   * `expiresAtMs = autoOpenAtMs + ttlMs`. `pruneExpired` drops entries
   * whose `expiresAtMs <= now`; `reconcileWithChestSlots` drops entries
   * when the save reports fewer chest slots than the queue holds.
   */
  expiresAtMs: number;
  /**
   * Effective auto-open cooldown (ms) for this chest's boxKey. Stored on the
   * item so `dequeue` / reconcile can re-resolve the category mapping
   * without re-reading the catalog.
   */
  autoOpenSeconds: number;
  /**
   * Wall-clock ms when this chest is expected to auto-open. Under the
   * serial-queue model each category has one shared timer, so the chest's
   * auto-open moment is computed at drop time relative to the previous
   * same-category tail:
   *   - queue empty for this category: `autoOpenAtMs = droppedAtMs +
   *     autoOpenSeconds * 1000` (timer starts fresh)
   *   - queue non-empty for this category: `autoOpenAtMs = prevTail.
   *     autoOpenAtMs + autoOpenSeconds * 1000` (timer is busy, this chest
   *     must wait for all preceding same-category chests to open)
   *
   * Once computed, the value never changes — manual opens of the head
   * promote the new head without altering its precomputed `autoOpenAtMs`,
   * matching the game's per-category shared timer behavior.
   *
   * The queue is kept sorted by `autoOpenAtMs` ascending so the global head
   * is the next chest expected to auto-open across all categories.
   */
  autoOpenAtMs: number;
}

/** Input for {@link enqueue}; TTL is derived from `autoOpenSeconds`. */
export interface EnqueueInput {
  boxKey: string;
  droppedAtMs: number;
  stageKey: number;
  autoOpenSeconds: number;
}

/**
 * Insert a new item, keeping the queue sorted by `autoOpenAtMs` ascending so
 * the head is the next chest to auto-open. Serial-queue model: the new
 * item's `autoOpenAtMs` is computed relative to the previous same-category
 * tail (NOT its `droppedAtMs`), because each category has one shared timer
 * that must finish with all preceding chests before reaching this one. When
 * no same-category item exists, the timer is idle and the new item anchors
 * to its `droppedAtMs`. Stable on ties — equal `autoOpenAtMs` items keep
 * their existing relative order.
 */
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  const sameCategoryTail = findSameCategoryTail(queue, input.boxKey);
  const autoOpenAtMs = sameCategoryTail
    ? sameCategoryTail.autoOpenAtMs + input.autoOpenSeconds * 1000
    : input.droppedAtMs + input.autoOpenSeconds * 1000;
  const expiresAtMs = autoOpenAtMs + ttlMs;
  const item: QueueItem = {
    boxKey: input.boxKey,
    droppedAtMs: input.droppedAtMs,
    stageKey: input.stageKey,
    expiresAtMs,
    autoOpenSeconds: input.autoOpenSeconds,
    autoOpenAtMs,
  };
  return insertSorted(queue, item);
}

/**
 * Find the last item in `queue` that belongs to the same category as
 * `boxKey` (the one with the largest `autoOpenAtMs`). Returns null if no
 * same-category item exists or if `boxKey`'s category cannot be resolved.
 * Used by `enqueue` to compute the serial-queue `autoOpenAtMs` for a new
 * same-category drop.
 */
function findSameCategoryTail(queue: QueueItem[], boxKey: string): QueueItem | null {
  const cat = categoryFromBoxKey(boxKey);
  if (!cat) return null;
  let tail: QueueItem | null = null;
  for (const item of queue) {
    if (categoryFromBoxKey(item.boxKey) === cat) {
      if (!tail || item.autoOpenAtMs > tail.autoOpenAtMs) tail = item;
    }
  }
  return tail;
}

/**
 * Insert `item` into `queue` keeping the sort order: by `autoOpenAtMs`
 * ascending, ties broken by `droppedAtMs` ascending (FIFO on equal keys).
 * Stable: equal-key items keep their existing relative order.
 */
function insertSorted(queue: QueueItem[], item: QueueItem): QueueItem[] {
  const key = sortKey(item);
  let insertIdx = queue.length;
  for (let i = 0; i < queue.length; i++) {
    if (compareItems(queue[i]!, item, key) > 0) {
      insertIdx = i;
      break;
    }
  }
  return [...queue.slice(0, insertIdx), item, ...queue.slice(insertIdx)];
}

/** Sort key for an item: always `autoOpenAtMs` (serial-queue model). */
function sortKey(item: QueueItem): number {
  return item.autoOpenAtMs;
}

/** Comparator using precomputed `key` for the new item. */
function compareItems(a: QueueItem, b: QueueItem, bKey: number): number {
  const aKey = sortKey(a);
  if (aKey !== bKey) return aKey - bKey;
  return a.droppedAtMs - b.droppedAtMs;
}

/**
 * Pop the first live (non-expired) item from the head. Expired items skipped
 * during the pop are dropped. Under the serial-queue model every queued
 * item already has a concrete `autoOpenAtMs` computed at drop time, so
 * there is no "waiting" state to promote — the new head is simply whatever
 * remains at the front of the sorted queue, with its original
 * `autoOpenAtMs` unchanged (matching the game's behavior when the head is
 * opened manually or auto-opened).
 *
 * Returns `{ item: null, queue: [] }` when no live items remain.
 */
export function dequeue(
  queue: QueueItem[],
  nowMs: number,
): { queue: QueueItem[]; item: QueueItem | null } {
  const remaining = [...queue];
  while (remaining.length > 0) {
    const head = remaining.shift()!;
    if (head.expiresAtMs > nowMs) {
      return { queue: remaining, item: head };
    }
    // Expired head: drop it and continue looping to find the next live head.
  }
  return { queue: [], item: null };
}

/**
 * Drop all items whose `expiresAtMs` is `<= nowMs`. Does not mutate input.
 * Under the serial-queue model every item always has a concrete
 * `expiresAtMs`, so there are no "waiting" items to special-case.
 */
export function pruneExpired(queue: QueueItem[], nowMs: number): QueueItem[] {
  if (queue.length === 0) return queue;
  const remaining: QueueItem[] = [];
  for (const item of queue) {
    if (item.expiresAtMs > nowMs) {
      remaining.push(item);
    }
  }
  return remaining.length === queue.length ? queue : remaining;
}

/** Minimal entry shape for {@link groupBoxOpenEvents}. */
export interface BoxOpenEntryLike {
  itemKey: number;
  /** Wall-clock seconds (matches BoxOpenHistoryEntry.wallTime). */
  wallTime: number;
}

/** A single chest's open event: one burst of items within the gap window. */
export interface BoxOpenEvent {
  itemKeys: number[];
  startMs: number;
  endMs: number;
}

/** Default gap (ms) between entries that closes one event and starts another. */
const DEFAULT_GAP_MS = 2000;

/**
 * Group BoxOpenLog entries into "open events". The game appends multiple
 * entries per chest open (one per item), all within a single frame burst
 * (~40ms apart at 25Hz reader). Different chests are separated by at least
 * one auto-open cycle (60s+). A 2s gap reliably distinguishes the two.
 *
 * Entries are sorted by wallTime first so callers don't have to pre-sort.
 * Returns events in chronological order.
 */
export function groupBoxOpenEvents(
  entries: BoxOpenEntryLike[],
  gapMs: number = DEFAULT_GAP_MS,
): BoxOpenEvent[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => a.wallTime - b.wallTime);

  const events: BoxOpenEvent[] = [];
  let currentItemKeys: number[] = [sorted[0]!.itemKey];
  let currentStart = sorted[0]!.wallTime;
  let currentEnd = sorted[0]!.wallTime;

  for (let i = 1; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const gapSeconds = gapMs / 1000;
    if (entry.wallTime - currentEnd > gapSeconds) {
      events.push({ itemKeys: currentItemKeys, startMs: currentStart, endMs: currentEnd });
      currentItemKeys = [entry.itemKey];
      currentStart = entry.wallTime;
      currentEnd = entry.wallTime;
    } else {
      currentItemKeys.push(entry.itemKey);
      currentEnd = entry.wallTime;
    }
  }
  events.push({ itemKeys: currentItemKeys, startMs: currentStart, endMs: currentEnd });
  return events;
}
