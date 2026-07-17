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
}

/** Input for {@link enqueue}; TTL is derived from `autoOpenSeconds`. */
export interface EnqueueInput {
  boxKey: string;
  droppedAtMs: number;
  stageKey: number;
  autoOpenSeconds: number;
}

/** Append a new item, computing its expiry from the chest's auto-open time. */
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  return [
    ...queue,
    {
      boxKey: input.boxKey,
      droppedAtMs: input.droppedAtMs,
      stageKey: input.stageKey,
      expiresAtMs: input.droppedAtMs + ttlMs,
    },
  ];
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
