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
   * Effective auto-open cooldown (ms) for this chest's boxKey. Stored on the
   * item so `dequeue` / reconcile can recompute the next head's auto-open
   * time without re-resolving the category mapping.
   */
  autoOpenSeconds: number;
  /**
   * Serial queueing key (typically the chest category: "common" / "rare" /
   * "act"). Chests sharing a `serialKey` queue serially — the game opens one
   * chest slot at a time per category, so the second chest's auto-open timer
   * only starts after the first chest is actually opened.
   */
  serialKey: string;
  /**
   * Wall-clock ms when this chest is expected to auto-open, OR `null` when
   * the chest is waiting behind another chest of the same `serialKey`.
   *
   * The game opens chest slots serially per category: the second chest's
   * auto-open timer only starts after the first chest is actually opened
   * (not when it was dropped). So only the head of each `serialKey` chain
   * has a concrete `autoOpenAtMs = droppedAtMs + autoOpenSeconds * 1000`;
   * non-head items have `null` and receive a concrete value when their
   * predecessor is consumed (via `dequeue` or reconcile prune).
   *
   * The queue is kept sorted with active (non-null) heads first by
   * `autoOpenAtMs` ascending, then waiting (null) items by `droppedAtMs`
   * ascending within their `serialKey` chain.
   */
  autoOpenAtMs: number | null;
}

/** Input for {@link enqueue}; TTL is derived from `autoOpenSeconds`. */
export interface EnqueueInput {
  boxKey: string;
  droppedAtMs: number;
  stageKey: number;
  autoOpenSeconds: number;
  /**
   * Serial queueing key (typically the chest category). Chests sharing this
   * key queue serially; chests with different keys queue in parallel.
   */
  serialKey: string;
}

/**
 * Insert a new item, keeping the queue sorted so the head is the next chest
 * to open. Sorting is by `autoOpenAtMs` ascending among active (non-null)
 * heads first, then waiting (null) items by `droppedAtMs` ascending. This
 * matches the game's behavior: a chest dropped later with a shorter auto-open
 * cooldown will open before an earlier drop with a longer cooldown.
 *
 * Multiple chests sharing the same `serialKey` are queued serially: the game
 * opens one chest slot at a time per category (common / rare / act), so the
 * second chest's auto-open timer only starts after the first chest is
 * actually opened. We model this by giving only the head of each `serialKey`
 * chain a concrete `autoOpenAtMs`; non-head items get `null` (waiting) and
 * receive a concrete value when their predecessor is consumed (via `dequeue`
 * or reconcile prune). Without this, a burst of same-category drops (e.g.
 * three common chests of different levels within a minute) would all compute
 * the same `autoOpenAtMs`, breaking the dequeue order and over-counting when
 * reconciling against slots.
 */
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  // If another chest of the same serialKey is already queued, the new chest
  // must wait behind it — its auto-open timer starts only when its
  // predecessor is actually opened. We mark it as waiting (null) here; the
  // predecessor's consumer (dequeue / reconcile) will assign a concrete
  // `autoOpenAtMs` when that happens. If no same-serialKey entry exists,
  // this chest is the head of its chain and opens `autoOpenSeconds` after
  // drop.
  const tailSameSerial = queue
    .filter((q) => q.serialKey === input.serialKey)
    .reduce<QueueItem | null>(
      (latest, q) => (q.expiresAtMs > (latest?.expiresAtMs ?? 0) ? q : latest),
      null,
    );
  const isHead = tailSameSerial == null;
  const autoOpenAtMs: number | null = isHead
    ? input.droppedAtMs + input.autoOpenSeconds * 1000
    : null;
  // TTL is anchored to the auto-open time (when the chest's timer actually
  // starts), not the drop time — this keeps the queue entry alive for one
  // full auto-open cycle plus buffer after the chest's auto-open fires.
  // For the head, autoOpenAtMs is known now, so expiresAtMs is concrete.
  // For waiting items, autoOpenAtMs is null (timer hasn't started), so we
  // chain expiresAtMs off the tail's expiresAtMs — the waiting chest expires
  // one full auto-open cycle after the tail's expiry, modeling serial
  // per-slot auto-open. `promoteNextHead` recomputes `expiresAtMs` from the
  // concrete `autoOpenAtMs` once the predecessor is consumed (the chain may
  // shorten if promote fires earlier than expected).
  const expiresAtMs = isHead
    ? autoOpenAtMs! + ttlMs
    : tailSameSerial!.expiresAtMs + input.autoOpenSeconds * 1000;
  const item: QueueItem = {
    boxKey: input.boxKey,
    droppedAtMs: input.droppedAtMs,
    stageKey: input.stageKey,
    expiresAtMs,
    autoOpenSeconds: input.autoOpenSeconds,
    serialKey: input.serialKey,
    autoOpenAtMs,
  };
  return insertSorted(queue, item);
}

/**
 * Insert `item` into `queue` keeping the sort order:
 *   1. active (autoOpenAtMs != null) items by autoOpenAtMs ascending
 *   2. waiting (autoOpenAtMs == null) items by droppedAtMs ascending
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

/** Sort key for an item: active items use autoOpenAtMs, waiting use Infinity. */
function sortKey(item: QueueItem): number {
  return item.autoOpenAtMs ?? Number.POSITIVE_INFINITY;
}

/** Comparator using precomputed `key` for the new item. */
function compareItems(a: QueueItem, b: QueueItem, bKey: number): number {
  const aKey = sortKey(a);
  if (aKey !== bKey) return aKey - bKey;
  // Same active/waiting tier — break ties by droppedAtMs (FIFO within chain).
  return a.droppedAtMs - b.droppedAtMs;
}

/**
 * Promote the next waiting item of `serialKey` to active head: assign it a
 * concrete `autoOpenAtMs = nowMs + autoOpenSeconds * 1000`. Called by
 * `dequeue` and `reconcileWithChestSlots` after a head is consumed. If no
 * waiting item exists for `serialKey`, the queue is unchanged.
 */
export function promoteNextHead(queue: QueueItem[], serialKey: string, nowMs: number): QueueItem[] {
  const nextIdx = queue.findIndex((q) => q.serialKey === serialKey);
  if (nextIdx < 0) return queue;
  const next = queue[nextIdx]!;
  if (next.autoOpenAtMs != null) return queue; // already active
  const newAutoOpenAtMs = nowMs + next.autoOpenSeconds * 1000;
  // Recompute expiresAtMs from the new autoOpenAtMs so the TTL covers one
  // full auto-open cycle plus buffer starting from when the chest's timer
  // actually starts (now), not from its original drop time.
  const ttlMs = computeTtlMs(next.autoOpenSeconds);
  const promoted: QueueItem = {
    ...next,
    autoOpenAtMs: newAutoOpenAtMs,
    expiresAtMs: newAutoOpenAtMs + ttlMs,
  };
  // Re-insert to maintain sort order (autoOpenAtMs changed from Infinity to
  // a concrete value, so the item likely moves toward the head).
  const without = [...queue.slice(0, nextIdx), ...queue.slice(nextIdx + 1)];
  return insertSorted(without, promoted);
}

/**
 * Pop the first live (non-expired) item from the head. Expired items skipped
 * during the pop are dropped. After consuming a head, the next waiting item
 * of the same `serialKey` (if any) is promoted to active head with
 * `autoOpenAtMs = nowMs + autoOpenSeconds * 1000` — this models the game's
 * serial per-slot auto-open: the second chest's timer starts when the first
 * chest is actually opened (i.e. now). Returns `{ item: null, queue: [] }`
 * when no live items remain.
 */
export function dequeue(
  queue: QueueItem[],
  nowMs: number,
): { queue: QueueItem[]; item: QueueItem | null } {
  const remaining = [...queue];
  while (remaining.length > 0) {
    const head = remaining.shift()!;
    if (head.expiresAtMs > nowMs) {
      const promoted = promoteNextHead(remaining, head.serialKey, nowMs);
      return { queue: promoted, item: head };
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
