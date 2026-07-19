// Pure helpers for the auto-classify queue: FIFO matching of chest drops to
// subsequent unclassified box opens, plus grouping of BoxOpenLog bursts into
// single "open events" so one chest's multi-item drop consumes one queue slot.
// Pure: no Electron, no React, no fs.

/**
 * Slot-parallel auto-open model.
 *
 * The game runs an independent auto-open timer per chest slot. When a chest
 * drops, it occupies the next free slot and its timer starts immediately
 * (`autoOpenAtMs = droppedAtMs + autoOpenSeconds * 1000`). Manual opens do
 * not affect other slots' timers — opening a chest only frees its slot; the
 * next drop will occupy the freed slot with a fresh `autoOpenSeconds`
 * countdown. Different categories (common / rare / act) run fully in
 * parallel because they have independent slot pools and auto-open seconds.
 *
 * Consequence for the queue: every queued item always has a concrete
 * `autoOpenAtMs` (no "waiting" state). The queue is sorted by `autoOpenAtMs`
 * ascending so the head is the next chest expected to auto-open.
 */

/** Min TTL floor (ms). Prevents rune-reduced autoOpen from expiring entries instantly. */
const MIN_TTL_MS = 60_000;
/** Buffer added on top of 2*autoOpen (ms). Covers reader latency + burst aggregation. */
const TTL_BUFFER_MS = 30_000;

/**
 * Compute the TTL for a queue entry from the chest's effective auto-open
 * seconds. The queue must survive at least one full auto-open cycle (the
 * player drops the chest, then waits for auto-open), and the entry may be
 * enqueued at any point in the cycle, so we use 2x the auto-open time as a
 * safety margin. `MIN_TTL_MS` guards against runes reducing autoOpen to 0.
 */
export function computeTtlMs(autoOpenSeconds: number): number {
  return Math.max(autoOpenSeconds * 2 * 1000, MIN_TTL_MS) + TTL_BUFFER_MS;
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
   * slot-parallel model every queued chest has a concrete auto-open time
   * computed at drop time: `autoOpenAtMs = droppedAtMs + autoOpenSeconds *
   * 1000`. Manual opens of other chests do not move this timestamp — the
   * slot timer is independent of chest identity.
   *
   * The queue is kept sorted by `autoOpenAtMs` ascending so the head is
   * the next chest expected to auto-open.
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
 * the head is the next chest to auto-open. Slot-parallel model: every chest
 * gets a concrete `autoOpenAtMs = droppedAtMs + autoOpenSeconds * 1000` at
 * drop time, regardless of how many other chests of the same category are
 * already queued. Stable on ties — equal `autoOpenAtMs` items keep their
 * existing relative order.
 */
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  const autoOpenAtMs = input.droppedAtMs + input.autoOpenSeconds * 1000;
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

/** Sort key for an item: always `autoOpenAtMs` (slot-parallel model). */
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
 * during the pop are dropped. Under the slot-parallel model every queued
 * item already has a concrete `autoOpenAtMs`, so there is no "waiting"
 * state to promote — the next head is simply whatever remains at the front
 * of the sorted queue.
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
 * Under the slot-parallel model every item always has a concrete
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
