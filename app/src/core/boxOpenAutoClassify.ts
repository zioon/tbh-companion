// Pure helpers for the auto-classify queue: FIFO matching of chest drops to
// subsequent unclassified box opens, plus grouping of BoxOpenLog bursts into
// single "open events" so one chest's multi-item drop consumes one queue slot.
// Pure: no Electron, no React, no fs.

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
  expiresAtMs: number;
  /**
   * Wall-clock ms when this chest is expected to auto-open
   * (`droppedAtMs + autoOpenSeconds * 1000`). The queue is kept sorted by
   * this field ascending so the head is always the next chest to open —
   * `dequeue` consumes the soonest-opening chest first, not the oldest drop.
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
 * Insert a new item in `autoOpenAtMs` ascending order. Keeping the queue
 * sorted on insert means `dequeue` can still pop from the head — but now
 * the head is the soonest-opening chest, not the oldest drop. This matches
 * the game's behavior: a chest dropped later with a shorter auto-open
 * cooldown will open before an earlier drop with a longer cooldown.
 *
 * Multiple chests of the same `boxKey` are queued serially: the game opens
 * one chest slot at a time per boxKey (auto-open doesn't fire two chests of
 * the same type simultaneously), so the second chest's actual open time is
 * `previousSameBoxKeyAutoOpenAtMs + autoOpenSeconds`, not
 * `droppedAtMs + autoOpenSeconds`. Without this, a burst of same-boxKey
 * drops (e.g. three common chests within a minute) would all compute the
 * same `autoOpenAtMs`, breaking the dequeue order and over-counting when
 * reconciling against slots.
 */
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  // Find the latest same-boxKey entry already queued — the new chest opens
  // strictly after it (one auto-open cycle later). If none exists, the chest
  // opens `autoOpenSeconds` after its own drop time.
  let prevSameBoxKeyAutoOpenAtMs: number | null = null;
  for (const existing of queue) {
    if (
      existing.boxKey === input.boxKey &&
      existing.autoOpenAtMs > (prevSameBoxKeyAutoOpenAtMs ?? 0)
    ) {
      prevSameBoxKeyAutoOpenAtMs = existing.autoOpenAtMs;
    }
  }
  const autoOpenAtMs =
    prevSameBoxKeyAutoOpenAtMs != null
      ? prevSameBoxKeyAutoOpenAtMs + input.autoOpenSeconds * 1000
      : input.droppedAtMs + input.autoOpenSeconds * 1000;
  const item: QueueItem = {
    boxKey: input.boxKey,
    droppedAtMs: input.droppedAtMs,
    stageKey: input.stageKey,
    expiresAtMs: input.droppedAtMs + ttlMs,
    autoOpenAtMs,
  };
  // Find the first item whose autoOpenAtMs is strictly greater than the new
  // item's — insert before it to keep ascending order. Items with equal
  // autoOpenAtMs keep their existing relative order (stable insertion).
  let insertIdx = queue.length;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i]!.autoOpenAtMs > autoOpenAtMs) {
      insertIdx = i;
      break;
    }
  }
  return [...queue.slice(0, insertIdx), item, ...queue.slice(insertIdx)];
}

/**
 * Pop the first live (non-expired) item from the head. Expired items skipped
 * during the pop are dropped. Returns `{ item: null, queue: [] }` when no live
 * items remain.
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
  }
  return { queue: [], item: null };
}

/** Drop all items whose `expiresAtMs <= now`. Does not mutate input. */
export function pruneExpired(queue: QueueItem[], nowMs: number): QueueItem[] {
  return queue.filter((item) => item.expiresAtMs > nowMs);
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
