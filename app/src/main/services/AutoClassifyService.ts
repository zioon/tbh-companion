import type {
  AutoClassifyQueueItem,
  AutoClassifyStatePayload,
  BoxCategory,
  BoxOpenHistoryEntry,
  BoxTimerCatalogEntry,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import type { ChestDropCategory, ChestDropTracker } from "../../core/chestDropTracker";
import type { BoxOpenTracker } from "../../core/boxOpenTracker";
import { categoryFromBoxKey, UNCLASSIFIED_BOX_KEY } from "../../core/boxOpenLog";
import { inferLevelFromStage, type StageBoxTrackerRoute } from "../../core/stageBoxTracker";
import {
  computeTtlMs,
  enqueue,
  groupBoxOpenEvents,
  pruneExpired,
  type QueueItem,
} from "../../core/boxOpenAutoClassify";
import { createLogger } from "../log";

const log = createLogger("autoClassify");

/** Fallback auto-open seconds when ChestService has no save yet. */
const FALLBACK_AUTO_OPEN = { common: 300, stageBoss: 600, actBoss: 60 } as const;

/** Pending prompt lifetime (ms). Items left unclassified after timeout stay unclassified. */
const PROMPT_TIMEOUT_MS = 60_000;

/**
 * TTL for pending bursts (ms). A pending burst is an unclassified open event
 * that didn't match any queued slot within the burst-match grace window.
 * The burst is held pending the next save reconcile, which can classify it
 * by comparing save slot counts against live counts. Bursts older than this
 * TTL are pruned without classification (items stay in "unclassified" for
 * manual handling). 5 minutes covers multiple save parse cycles (saves are
 * typically 30s apart) while bounding memory growth.
 */
const PENDING_BURST_TTL_MS = 300_000;

/**
 * Relative-change threshold (fraction) for detecting autoOpenSeconds drift.
 * When `chestService.getAutoOpenSeconds()` changes by more than this fraction
 * on any category, the queue is recomputed to keep `autoOpenAtMs` accurate
 * under the serial-queue model (where any per-item error accumulates down
 * the tail). 1% is well above float noise but catches any meaningful rune
 * purchase or fallback→real-value transition.
 */
const AUTO_OPEN_DRIFT_THRESHOLD = 0.01;

/**
 * Absolute-change floor (seconds) for drift detection. Changes below this
 * magnitude are ignored even if the relative change exceeds
 * {@link AUTO_OPEN_DRIFT_THRESHOLD} — defends against tiny absolute deltas
 * (sub-second float noise or save-parse rounding) producing large relative
 * ratios when `prev` is small. In practice autoOpenSeconds is always ≥ 60s,
 * so this floor never masks a real rune-purchase change (which is tens of
 * seconds), but it keeps the drift detector well-behaved at the boundary.
 */
const AUTO_OPEN_ABSOLUTE_THRESHOLD = 1;

/**
 * Half-width of the burst-matching window (ms). When an unclassified burst
 * arrives, `processEvent` looks for a queue item whose `autoOpenAtMs` is
 * within `±BURST_MATCH_GRACE_MS` of the burst's wall time. This defends
 * against head-vs-burst mismatch when: (a) the player manually opened a
 * non-head chest, (b) `autoOpenAtMs` drifted from the real auto-open moment
 * due to rune changes or wall-clock skew, or (c) the head's auto-open was
 * detected by `tick` but the burst arrived slightly late. If no item falls
 * within the window, `processEvent` pends the burst for save-reconcile
 * classification (or broadcasts a prompt if the queue is empty) — it does
 * NOT fall back to dequeuing the head, since guessing wrong would
 * misclassify the burst's items.
 *
 * 5s keeps the window tight enough that two queue items from different
 * categories rarely both fall in-window simultaneously — that would force a
 * cross-category guess. 5s still comfortably covers the live-reader tick
 * interval (200ms) plus burst propagation latency (≈2s), and is well under
 * the shortest auto-open period (act=60s, so 5s is a twelfth period).
 * See audit M2/M5.
 */
const BURST_MATCH_GRACE_MS = 5_000;

interface PendingPrompt {
  promptId: number;
  itemKeys: number[];
  createdAtMs: number;
}

/**
 * A pending (unclassified) open burst awaiting classification via save
 * reconcile. Created when `processEvent` can't match a burst to any queued
 * slot within the burst-match grace window. The next `reconcileWithChestSlots`
 * call compares save slot counts against live counts: if exactly one category
 * decreased and there's exactly one pending burst, the burst is classified
 * to that category; otherwise the burst stays in "unclassified" for manual
 * handling.
 */
interface PendingBurst {
  burstId: number;
  itemKeys: number[];
  /** Wall-clock ms of the open burst (from BoxOpenLog wallTime). */
  burstMs: number;
  /** Wall-clock ms when this burst was enqueued (for TTL pruning). */
  createdAtMs: number;
}

export interface AutoClassifyServiceDeps {
  chestDropTracker: ChestDropTracker;
  boxOpenTracker: BoxOpenTracker;
  chestService: {
    getAutoOpenSeconds(): { common: number; stageBoss: number; actBoss: number } | null;
  };
  stageBoxCatalog: () => ReadonlyArray<BoxTimerCatalogEntry>;
  /** LEGENDARY act boss tracker routes, used to infer act boss level from stageKey. */
  actBossRoutes: () => ReadonlyArray<StageBoxTrackerRoute>;
  /** COMMON normal monster box tracker routes, used to infer common chest level
   * from stageKey. COMMON chests share the same stage boundaries as RARE stage
   * boss boxes but have different level numbering at low levels (Lv1/5/10 vs
   * RARE Lv4/5/7), so they need their own route table. */
  commonRoutes: () => ReadonlyArray<StageBoxTrackerRoute>;
  getCurrentStageKey: () => number | null;
  /**
   * Latest inventory (item bag) used/capacity from the save. When `used >=
   * capacity` the game pauses all chest auto-open timers (it cannot drop
   * loot into a full bag). AutoClassifyService freezes `effectiveNow` at
   * the moment the inventory becomes full, and on resume shifts queued
   * items' `autoOpenAtMs` / `expiresAtMs` forward by the paused duration.
   * `null` when no save has been parsed yet (pause detection disabled
   * until inventory state is known).
   */
  getInventoryStatus: () => { used: number; capacity: number } | null;
  broadcast: (channel: string, payload: unknown) => void;
}

/**
 * Orchestrates automatic classification of unclassified box-open loot by
 * matching subsequent opens to previously dropped chests via a FIFO queue.
 *
 * - On chest drop: enqueue { boxKey, droppedAt, stageKey } with a TTL derived
 *   from the chest's effective auto-open time.
 * - On unclassified open burst: group entries into "open events" and consume
 *   one queue slot per event, reclassifying all the event's items to the
 *   queued boxKey. When the queue is empty, broadcast LOOT_PROMPT_CLASSIFY so
 *   the user can pick a category.
 * - Pending prompts accumulate subsequent batches (no duplicate broadcasts)
 *   and expire after 60s, leaving items in unclassified for manual handling.
 *
 * The service does NOT wire tracker callbacks in its constructor — the caller
 * (TrackingService in Task 9, or tests) wires `handleChestDrop` /
 * `handleUnclassifiedBatch` to the tracker callbacks. Both methods check
 * `this.enabled` at call time so toggling the service on/off doesn't require
 * re-wiring.
 */
export class AutoClassifyService {
  private enabled = false;
  private queue: QueueItem[] = [];
  private pending: PendingPrompt | null = null;
  private nextPromptId = 1;
  private readonly deps: AutoClassifyServiceDeps;
  /**
   * Real-time per-category chest slot counts. Initialized from save data on
   * every save parse (`reconcileWithChestSlots`), then adjusted between saves:
   *   - `handleChestDrop`: `liveSlots[cat]++` (new chest occupies a slot)
   *   - `tick()`: `liveSlots[cat]--` for the head item when its
   *     `autoOpenAtMs <= now` (chest auto-opened, slot freed). Under the
   *     serial-queue model only the head's `autoOpenAtMs` is the timer's
   *     current target — tail items's `autoOpenAtMs` is a precomputed future
   *     moment and must NOT trigger a decrement.
   *   - `processEvent`: `liveSlots[cat]--` when `dequeue` removes an item not
   *     already counted as auto-opened (manual open detected via item drop)
   *
   * `WeakSet` tracks items already decremented (auto-opened in tick) to avoid
   * double-decrement when the same item is later dequeued by `processEvent`.
   *
   * Null before the first save parse completes. The renderer falls back to
   * save-derived `slot.quantity` in that case.
   */
  private liveSlots: { common: number; rare: number; act: number } | null = null;
  /**
   * Queue items whose `autoOpenAtMs` has elapsed and whose `liveSlots` decrement
   * has already been applied in `tick()`. Prevents double-decrement when
   * `processEvent` later dequeues the same item. WeakSet auto-cleans when
   * items are GC'd after leaving the queue.
   *
   * Not `readonly`: `recomputeQueueAutoOpenAtMs` rebuilds queue items as new
   * objects (immutability contract — see audit M3/Q7), so the WeakSet is
   * reset there to drop stale references to the pre-recompute items.
   */
  private slotDecrementedItems = new WeakSet<QueueItem>();
  /**
   * Last slot counts seen by `reconcileWithChestSlots`. Used to suppress the
   * "queue < slots" info log when slots are unchanged across high-frequency
   * reconcile calls. Null = first call (always log). Reset to null on disable
   * so re-enable re-logs the initial state.
   */
  private lastReconcileSlots: { common: number; rare: number; act: number } | null = null;
  /**
   * Last-seen `autoOpenSeconds` from ChestService, used to detect drift
   * (rune purchase, first save parse replacing FALLBACK_AUTO_OPEN, etc.).
   * When drift exceeds {@link AUTO_OPEN_DRIFT_THRESHOLD} on any category,
   * {@link maybeRecalibrateQueue} recomputes every queued item's
   * `autoOpenAtMs` and `expiresAtMs` to keep the serial-queue model
   * accurate over long sessions (per-item error otherwise accumulates
   * down the tail). Null before the first successful read.
   */
  private lastAutoOpenSeconds: { common: number; stageBoss: number; actBoss: number } | null = null;
  /**
   * Wall-clock ms when the inventory (item bag) became full, or `null` when
   * the inventory is not full (or has never been observed). While non-null,
   * {@link getEffectiveNow} returns this value instead of `Date.now()`, so
   * `autoOpenAtMs - effectiveNow` (the displayed countdown) freezes. `tick`
   * also skips slot decrement and prune while paused — the game's auto-open
   * timer is not advancing, so no item should be treated as elapsed.
   *
   * On transition from full → not-full, {@link shiftQueueTimes} shifts every
   * non-slot-decremented item's `autoOpenAtMs` / `expiresAtMs` forward by
   * the paused duration. Items already slot-decremented (their auto-open
   * moment was reached before the pause) keep their original timestamps —
   * they are awaiting their unclassified burst or TTL prune, and shifting
   * them would risk a double-decrement of `liveSlots` when the WeakSet is
   * not reset.
   */
  private inventoryFullSinceMs: number | null = null;
  /**
   * Pending (unclassified) open bursts awaiting classification via save
   * reconcile. Each entry is a burst that `processEvent` couldn't match to
   * any queued slot within the grace window. The next
   * `reconcileWithChestSlots` compares save slot counts against live counts
   * to classify these. See {@link PendingBurst} for the classification rules.
   */
  private pendingBursts: PendingBurst[] = [];
  private nextBurstId = 1;

  constructor(deps: AutoClassifyServiceDeps) {
    this.deps = deps;
  }

  /**
   * Effective "now" for auto-open timing. When the inventory is full
   * (`inventoryFullSinceMs != null`), returns the pause moment so countdowns
   * freeze and `tick`'s elapsed check sees no time progress. Otherwise
   * returns `Date.now()`.
   */
  private getEffectiveNow(): number {
    return this.inventoryFullSinceMs ?? Date.now();
  }

  /**
   * Detect inventory full / not-full transitions and apply pause/resume
   * effects. Called from `tick` (1 Hz) and `reconcileWithChestSlots` (save
   * parse). When the inventory transitions to full, records the moment
   * (`inventoryFullSinceMs`). When it transitions back to not-full, shifts
   * queued items' timestamps forward by the paused duration and clears
   * `inventoryFullSinceMs`.
   *
   * No-op when `getInventoryStatus` is not injected or returns `null`
   * (no save parsed yet — pause detection stays disabled).
   */
  private updateInventoryPauseState(): void {
    const inv = this.deps.getInventoryStatus?.();
    const isFull = inv != null && inv.capacity > 0 && inv.used >= inv.capacity;
    const wallNow = Date.now();
    if (isFull && this.inventoryFullSinceMs == null) {
      this.inventoryFullSinceMs = wallNow;
      log.info(`inventory full; auto-open timers paused`);
    } else if (!isFull && this.inventoryFullSinceMs != null) {
      const pausedMs = wallNow - this.inventoryFullSinceMs;
      this.inventoryFullSinceMs = null;
      if (pausedMs > 0 && this.queue.length > 0) {
        this.shiftQueueTimes(pausedMs);
        log.info(`inventory no longer full; resumed after ${pausedMs}ms pause`);
      }
    }
  }

  /**
   * Shift every non-slot-decremented queued item's `autoOpenAtMs` and
   * `expiresAtMs` forward by `pausedMs`. Called on inventory full → not-full
   * transition. Items already slot-decremented (their auto-open moment was
   * reached before the pause, and they are awaiting burst / prune) keep
   * their original timestamps — shifting them would either push them into
   * the future (suppressing a needed prune) or leave them in the past and
   * risk a double-decrement of `liveSlots` after the WeakSet is rebuilt.
   *
   * The `slotDecrementedItems` WeakSet is NOT reset here: the kept (already
   * decremented) items retain their old object identity so the WeakSet
   * still recognizes them; the shifted (new object) items were not in the
   * WeakSet and correctly become eligible for future tick decrement.
   */
  private shiftQueueTimes(pausedMs: number): void {
    if (pausedMs <= 0 || this.queue.length === 0) return;
    this.queue = this.queue.map((item) => {
      if (this.slotDecrementedItems.has(item)) return item;
      return {
        ...item,
        autoOpenAtMs: item.autoOpenAtMs + pausedMs,
        expiresAtMs: item.expiresAtMs + pausedMs,
      };
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.queue = [];
      this.pending = null;
      this.pendingBursts = [];
      this.liveSlots = null;
      this.lastReconcileSlots = null;
      this.lastAutoOpenSeconds = null;
      this.inventoryFullSinceMs = null;
    } else {
      // Re-enable: probe autoOpen immediately so any queue built up while
      // disabled (shouldn't happen, but defensive) is calibrated. First
      // handleChestDrop / reconcile will also call this.
      this.maybeRecalibrateQueue();
    }
    log.info(`auto-classify ${enabled ? "enabled" : "disabled"}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Snapshot of the queue for renderer display. Grouped by BoxCategory with
   * the head and tail items' remaining auto-open time, plus a per-item view
   * for the detailed queue list. Called via IPC at 1 Hz by the renderer when
   * auto-classify is enabled.
   *
   * Under the serial-queue model every queued chest has a concrete
   * `autoOpenAtMs` (computed at drop time relative to the previous
   * same-category tail), so `nextAutoOpenInMs` (head) and `lastAutoOpenInMs`
   * (tail) are always non-null when the category has queued items.
   */
  getQueueSnapshot(): AutoClassifyStatePayload {
    // Use effectiveNow so countdowns freeze while the inventory is full
    // (game pauses auto-open timers). On resume, shiftQueueTimes will have
    // already pushed autoOpenAtMs forward, so effectiveNow falls back to
    // Date.now() and countdowns resume from where they left off.
    const now = this.getEffectiveNow();
    const order = ["common", "rare", "act"] as const;
    const byCategory = order.map((category) => {
      const items = this.queue.filter((item) => categoryFromBoxKey(item.boxKey) === category);
      let nextAutoOpenInMs: number | null = null;
      let lastAutoOpenInMs: number | null = null;
      if (items.length > 0) {
        // Head's remaining time. Clamped to 0 when the head's auto-open
        // moment has already passed (the chest should have opened but its
        // burst hasn't arrived yet, or the inventory is full and the timer
        // is paused — in the latter case `paused: true` signals the UI to
        // show "paused" instead of the clamped 0).
        const head = items[0]!;
        const tail = items[items.length - 1]!;
        const headRemain = head.autoOpenAtMs - now;
        nextAutoOpenInMs = Math.max(0, headRemain);
        // Queue-clear time = tail's remaining time. Under the serial-queue
        // model, tail.autoOpenAtMs is computed at enqueue/recompute time by
        // chaining onto the previous same-category tail, so it already
        // encodes the full "head + (depth-1) * autoOpenSeconds" chain — and
        // stays accurate even when the queue mixes items with different
        // autoOpenSeconds (e.g. a rune purchase shortened autoOpen for
        // chests dropped after the purchase). Reading tail.autoOpenAtMs
        // directly is more robust than recomputing via a formula, since
        // any drift correction (maybeRecalibrateQueue) or partial shift
        // (shiftQueueTimes on inventory resume) is already reflected in
        // the stored value.
        lastAutoOpenInMs = Math.max(0, tail.autoOpenAtMs - now);
      }
      return { category, count: items.length, nextAutoOpenInMs, lastAutoOpenInMs };
    });
    const items: AutoClassifyQueueItem[] = this.queue.map((q) => {
      // Queue items are only ever enqueued with valid category boxKeys (see
      // resolveDropBoxKey), so categoryFromBoxKey won't return null here in
      // practice — but it returns `BoxCategory | null` at the type level, so
      // fall back to "unclassified" to satisfy the non-null item shape.
      const category = categoryFromBoxKey(q.boxKey) ?? "unclassified";
      return {
        boxKey: q.boxKey,
        category,
        droppedAtMs: q.droppedAtMs,
        stageKey: q.stageKey,
        autoOpenInMs: Math.max(0, q.autoOpenAtMs - now),
        expiresInMs: Math.max(0, q.expiresAtMs - now),
      };
    });
    return {
      enabled: this.enabled,
      totalQueued: this.queue.length,
      byCategory,
      items,
      liveSlots: this.liveSlots ? { ...this.liveSlots } : null,
      paused: this.inventoryFullSinceMs != null,
      pendingBurstsCount: this.pendingBursts.length,
    };
  }

  /** Called by TrackingService when a chest drop is recorded. */
  handleChestDrop(event: {
    category: ChestDropCategory;
    wallTime: number;
    itemKey?: number;
  }): void {
    if (!this.enabled) return;
    // Drift check first: if autoOpenSeconds changed since last drop / save,
    // recompute queued items so the new chest chains onto an accurate tail.
    this.maybeRecalibrateQueue();
    const stageKey = this.deps.getCurrentStageKey() ?? 0;
    const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
    const boxKey = this.resolveDropBoxKey(event, stageKey);
    if (!boxKey) {
      log.warn(`could not resolve boxKey for drop category=${event.category} stageKey=${stageKey}`);
      return;
    }
    // Serial-queue model: each category has one shared timer. `enqueue`
    // computes this chest's `autoOpenAtMs` relative to the previous
    // same-category tail (or `droppedAtMs` if the category queue is empty).
    //
    // When the inventory is full, the game's auto-open timer is paused.
    // A chest dropped during the pause (slots are still available — the
    // game only blocks auto-OPEN, not drops) should start its countdown at
    // `autoOpenSeconds` from the pause moment, not from the real drop time.
    // Anchoring `droppedAtMs` to `getEffectiveNow()` (= pauseStart) makes
    // `autoOpenAtMs = pauseStart + autoOpen*1000`, so the countdown reads
    // `autoOpen*1000` (full duration) while paused. On resume,
    // `shiftQueueTimes` pushes this item forward by `pausedMs`, landing at
    // `resumeTime + autoOpen*1000` — the correct moment the timer reaches
    // this chest after un-pausing. Without this anchoring, the countdown
    // would read `autoOpen*1000 + (droppedAtMs - pauseStart)`, overstating
    // the remaining time by the offset between the drop and the pause start.
    const droppedAtMs =
      this.inventoryFullSinceMs != null ? this.getEffectiveNow() : event.wallTime * 1000;
    this.queue = enqueue(this.queue, {
      boxKey,
      droppedAtMs,
      stageKey,
      autoOpenSeconds: this.autoOpenForBoxKey(boxKey, autoOpen),
    });
    // Real-time slot tracking: a dropped chest occupies a slot immediately.
    // Save path will recalibrate on the next save parse.
    const cat = categoryFromBoxKey(boxKey);
    if (this.liveSlots && cat && cat !== "unclassified") {
      this.liveSlots[cat]++;
    }
    log.info(`queued drop boxKey=${boxKey} stageKey=${stageKey} queueLen=${this.queue.length}`);
  }

  /** Called by TrackingService when unclassified box-open entries are recorded. */
  handleUnclassifiedBatch(entries: readonly BoxOpenHistoryEntry[]): void {
    if (!this.enabled || entries.length === 0) return;
    const events = groupBoxOpenEvents(
      entries.map((e) => ({ itemKey: e.itemKey, wallTime: e.wallTime })),
    );
    for (const evt of events) {
      // BoxOpenEvent.startMs is misnamed — its value is actually `wallTime`
      // (seconds), not ms. Pass it directly as the burst's wall time in
      // seconds so `processEvent` can match it against queued items'
      // `autoOpenAtMs` (ms) via `burstMs = burstWallTimeSec * 1000`.
      this.processEvent(evt.itemKeys, evt.startMs);
    }
  }

  /**
   * Reconcile the queue against the current chest-slot counts from the save.
   * Called by ChestService on every save parse. For each category, if the
   * queue holds more items than the actual slot count, the excess (oldest
   * `autoOpenAtMs` first — those should have opened already) is pruned. This
   * keeps the queue accurate even when:
   *   - a chest opened with correctly-classified runtime offsets (no
   *     unclassified burst fired to consume the entry via `processEvent`),
   *   - a chest was opened manually mid-session,
   *   - or a queue entry's TTL lapped without being consumed.
   *
   * When the queue holds fewer items than the slot count (chests that existed
   * before the live reader attached, or drops the live reader missed), the
   * queue is left alone — we can't synthesize drop metadata, and those chests
   * will still open on their own; only the loot-classification prompt path is
   * affected (the open will be classified via the unclassified-burst flow or
   * left under "unclassified" for manual reclassification).
   *
   * Under the serial-queue model every queued chest already has a concrete
   * `autoOpenAtMs` computed at drop time (relative to the previous
   * same-category tail), so pruning is just a filter — no "waiting" items
   * need promotion. Remaining items keep their original `autoOpenAtMs`,
   * which reflects the game's behavior: opening a chest (manual or auto)
   * promotes the new head without altering its precomputed auto-open moment.
   */
  reconcileWithChestSlots(slots: { common: number; rare: number; act: number }): void {
    if (!this.enabled) return;
    // Drift check: a save parse is the canonical moment when rune purchases
    // and other state changes become visible to ChestService, so this is the
    // primary trigger for queue recalibration.
    this.maybeRecalibrateQueue();

    const order = ["common", "rare", "act"] as const;

    // Step 1: Excess-prune FIRST (before classifyPendingBursts). Queue is
    // sorted by autoOpenAtMs ascending; the first `excess` matching items
    // are the ones with the soonest auto-open times — they should have
    // opened already. Prune them BEFORE reset so that reset only applies
    // to remaining items, making the new head's autoOpenAtMs = anchorMs
    // (= burstMs + autoOpenSec). Without this ordering, reset would chain
    // the already-opened chest into the new chain, pushing the new head's
    // autoOpenAtMs to anchorMs + N*autoOpenSec (N = opened count) — wrong.
    let prunedTotal = 0;
    for (const category of order) {
      const slotCount = slots[category];
      const matching = this.queue.filter((q) => categoryFromBoxKey(q.boxKey) === category);
      const queueCount = matching.length;
      if (queueCount <= slotCount) continue;
      const excess = queueCount - slotCount;
      const toRemove = new Set(matching.slice(0, excess));
      this.queue = this.queue.filter((q) => !toRemove.has(q));
      prunedTotal += excess;
      log.info(
        `reconcile: pruned ${excess} excess ${category} item(s) ` +
          `(queue ${queueCount} > slots ${slotCount})`,
      );
    }
    if (prunedTotal > 0) {
      log.info(`reconcile: total pruned ${prunedTotal} item(s) across categories`);
    }

    // Step 2: Classify pending bursts BEFORE overwriting liveSlots. The
    // classification compares the previous liveSlots (real-time, pre-save)
    // against the new save's slot counts to detect which categories
    // decreased — i.e., which slots had chests open since the last save.
    // This must happen before liveSlots is overwritten because the delta
    // is the signal. Reset anchors to burstMs + autoOpenSec (the new head's
    // autoOpenAtMs under the serial-queue model: the chest that opened at
    // burstMs is gone, the timer retargets the new head starting at
    // burstMs + autoOpenSec). After step 1's excess-prune, reset only
    // applies to remaining items, so the new head's autoOpenAtMs = anchorMs.
    this.classifyPendingBursts(slots);

    // Step 3: Recalibrate liveSlots to the save's absolute values. This
    // discards any real-time adjustments (drops/opens) accumulated since
    // the last save parse — the save is the ground truth.
    this.liveSlots = { ...slots };

    // Step 4: Backfill (queue < slots). Companion just opened or live reader
    // lagged — save has chests but the queue is empty/short. Backfill with
    // placeholder items anchored to "now", each getting a full autoOpenSeconds
    // countdown. `enqueue` handles serial-queue chaining.
    const prev = this.lastReconcileSlots;
    const slotsChanged =
      prev == null ||
      prev.common !== slots.common ||
      prev.rare !== slots.rare ||
      prev.act !== slots.act;
    this.lastReconcileSlots = slots;

    for (const category of order) {
      const slotCount = slots[category];
      const matching = this.queue.filter((q) => categoryFromBoxKey(q.boxKey) === category);
      const queueCount = matching.length;
      if (queueCount >= slotCount) continue;
      const deficit = slotCount - queueCount;
      const stageKey = this.deps.getCurrentStageKey() ?? 0;
      const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
      const boxKey = this.resolveDropBoxKey({ category }, stageKey);
      if (boxKey) {
        const seconds = this.autoOpenForBoxKey(boxKey, autoOpen);
        const anchorMs = this.getEffectiveNow();
        for (let i = 0; i < deficit; i++) {
          this.queue = enqueue(this.queue, {
            boxKey,
            droppedAtMs: anchorMs,
            stageKey,
            autoOpenSeconds: seconds,
          });
        }
        if (slotsChanged) {
          log.info(
            `reconcile: backfilled ${deficit} ${category} item(s) ` +
              `(queue ${queueCount} < slots ${slotCount}); each gets full ${seconds}s countdown`,
          );
        }
      } else if (slotsChanged) {
        log.warn(
          `reconcile: could not backfill ${deficit} ${category} item(s) ` +
            `(queue ${queueCount} < slots ${slotCount}); boxKey unresolved`,
        );
      }
    }
  }

  /**
   * Classify pending bursts by comparing the previous `liveSlots` (real-time,
   * pre-save) against the new save's slot counts. For each category, if
   * `liveSlots[cat] > saveSlots[cat]`, then `liveSlots[cat] - saveSlots[cat]`
   * chests opened since the last save but weren't matched to a queued slot
   * within the burst-match grace window — they're the pending bursts.
   *
   * Classification rules (per user spec):
   *   - Exactly ONE category decreased AND exactly ONE pending burst:
   *     classify the burst to that category (reclassify items), then reset
   *     that category's slot timers anchored to the burst's wall time.
   *   - MULTIPLE categories decreased (ambiguous): leave ALL bursts as
   *     unclassified (no reclassify), reset ALL slot timers anchored to the
   *     earliest burst's wall time.
   *   - NO categories decreased: leave pending bursts as-is (will be pruned
   *     by TTL in tick). This can happen when the save arrives before the
   *     slot is actually freed, or when drops cancelled out opens.
   *
   * The actual dequeue of opened chests is handled by the existing pruning
   * logic in {@link reconcileWithChestSlots} (queue > slots → prune oldest).
   * This method only handles classification (reclassify items to the right
   * boxKey) and timer reset (recompute remaining items' autoOpenAtMs).
   *
   * Called BEFORE `liveSlots` is overwritten with save values — the delta
   * is the classification signal.
   */
  private classifyPendingBursts(saveSlots: { common: number; rare: number; act: number }): void {
    if (this.pendingBursts.length === 0 || this.liveSlots == null) return;

    // Compute per-category deltas: positive = chests opened since last save
    // (real-time count was higher than what the save reports).
    const decreased: ChestDropCategory[] = [];
    for (const cat of ["common", "rare", "act"] as const) {
      if (this.liveSlots[cat] > saveSlots[cat]) {
        decreased.push(cat);
      }
    }

    if (decreased.length === 0) {
      // No slots decreased — pending bursts stay pending (TTL pruned later).
      log.info(
        `classifyPendingBursts: ${this.pendingBursts.length} pending burst(s) but no slot decrease; waiting`,
      );
      return;
    }

    if (decreased.length === 1 && this.pendingBursts.length === 1) {
      // Unambiguous: one category decreased, one pending burst.
      const cat = decreased[0]!;
      const burst = this.pendingBursts[0]!;
      const stageKey = this.deps.getCurrentStageKey() ?? 0;
      const toBoxKey = this.resolveDropBoxKey({ category: cat }, stageKey);
      if (toBoxKey) {
        for (const itemKey of burst.itemKeys) {
          this.deps.boxOpenTracker.reclassifyItem(UNCLASSIFIED_BOX_KEY, itemKey, toBoxKey);
        }
      }
      // Reset this category's slot timers anchored to the new head's
      // autoOpenAtMs (= burstMs + autoOpenSec). Under the serial-queue
      // model, the chest that opened at burstMs is dequeued/excess-pruned,
      // and the timer retargets the new head starting at burstMs + autoOpenSec.
      // Using burstMs + autoOpenSec (not burstMs alone) keeps the new head's
      // autoOpenAtMs in the future, preventing tick from immediately
      // decrementing liveSlots for items that haven't actually opened yet.
      const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
      const seconds = this.autoOpenForBoxKey(`${cat}:0`, autoOpen);
      const anchorMs = burst.burstMs + seconds * 1000;
      this.resetSlotTimersForCategory(cat, anchorMs);
      log.info(
        `classified pending burst ${burst.burstId} → ${cat} ` +
          `(burstMs=${burst.burstMs}, anchor=${anchorMs}, ${burst.itemKeys.length} items reclassified)`,
      );
      this.pendingBursts = [];
      return;
    }

    // Ambiguous: multiple categories decreased OR multiple pending bursts.
    // Per user spec: leave items as unclassified, reset ALL slot timers
    // anchored to the earliest burst time + autoOpenSec (per category).
    // Each category may have a different autoOpenSeconds, so the anchor is
    // computed per-category inside the loop.
    const earliestBurstMs = this.pendingBursts.reduce(
      (min, b) => (b.burstMs < min ? b.burstMs : min),
      this.pendingBursts[0]!.burstMs,
    );
    const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
    for (const cat of ["common", "rare", "act"] as const) {
      const seconds = this.autoOpenForBoxKey(`${cat}:0`, autoOpen);
      this.resetSlotTimersForCategory(cat, earliestBurstMs + seconds * 1000);
    }
    log.info(
      `ambiguous classification: ${decreased.length} categories decreased ` +
        `(${decreased.join(",")}), ${this.pendingBursts.length} pending burst(s); ` +
        `left unclassified, reset all slot timers (earliestBurstMs=${earliestBurstMs}, +per-cat autoOpenSec)`,
    );
    this.pendingBursts = [];
  }

  /**
   * Recompute `autoOpenAtMs` and `expiresAtMs` for all queued items in the
   * given category, anchored to `anchorMs`. `anchorMs` is the new head's
   * autoOpenAtMs — i.e., the moment the timer will retarget the new head
   * after the previous head opened. All callers MUST pass
   * `burstMs + autoOpenSeconds` (or equivalent future moment) as `anchorMs`,
   * NOT the burst time alone: passing a past moment would set every item's
   * `autoOpenAtMs` into the past, causing tick to immediately decrement
   * liveSlots for items that haven't actually opened yet.
   *
   * Chain layout after reset:
   *   head.autoOpenAtMs       = anchorMs
   *   item[1].autoOpenAtMs    = anchorMs + autoOpenSec*1000
   *   item[2].autoOpenAtMs    = anchorMs + 2*autoOpenSec*1000
   *   ...
   *
   * This is the "reset slot countdown based on the burst time" step from the
   * user spec: by re-anchoring the serial-queue chain to the actual open
   * moment (rather than the precomputed `autoOpenAtMs` which may have drifted
   * due to rune changes, inventory pauses, or wall-clock skew), the
   * remaining items' countdowns stay accurate.
   *
   * Creates new item objects (immutability contract — audit M3/Q7). The
   * `slotDecrementedItems` WeakSet is NOT reset: old item references become
   * dead (no longer in queue, GC'd naturally), and new item references are
   * NOT in the WeakSet — correct behavior, since their new `autoOpenAtMs`
   * values should be evaluated fresh by `tick`. WeakSet membership is
   * preserved across the old→new object transition to avoid double-decrement.
   */
  private resetSlotTimersForCategory(cat: ChestDropCategory, anchorMs: number): void {
    const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
    const seconds = this.autoOpenForBoxKey(`${cat}:0`, autoOpen);
    const ttlMs = computeTtlMs(seconds);

    // Sort this category's items by droppedAtMs ascending (FIFO order).
    const catItems = this.queue
      .filter((q) => categoryFromBoxKey(q.boxKey) === cat)
      .sort((a, b) => a.droppedAtMs - b.droppedAtMs);

    if (catItems.length === 0) return;

    // Recompute the chain: head's autoOpenAtMs = anchorMs (the new head's
    // expected open moment), subsequent items chain at +autoOpenSec*1000.
    let prevAutoOpenAtMs = anchorMs;
    const updatedItems = new Map<QueueItem, QueueItem>();
    for (const item of catItems) {
      const autoOpenAtMs = prevAutoOpenAtMs;
      const newItem: QueueItem = {
        ...item,
        autoOpenAtMs,
        autoOpenSeconds: seconds,
        expiresAtMs: autoOpenAtMs + ttlMs,
      };
      updatedItems.set(item, newItem);
      // Preserve WeakSet membership: if the old item was already counted as
      // auto-opened (slot decremented in tick), the new item object must
      // also be marked to avoid double-decrement when tick later sees the
      // new object with an elapsed autoOpenAtMs.
      if (this.slotDecrementedItems.has(item)) {
        this.slotDecrementedItems.add(newItem);
      }
      prevAutoOpenAtMs = autoOpenAtMs + seconds * 1000;
    }

    // Apply updates and re-sort the queue by the new autoOpenAtMs.
    this.queue = this.queue
      .map((q) => updatedItems.get(q) ?? q)
      .sort((a, b) => {
        if (a.autoOpenAtMs !== b.autoOpenAtMs) return a.autoOpenAtMs - b.autoOpenAtMs;
        return a.droppedAtMs - b.droppedAtMs;
      });
  }

  /** Resolve a user's category choice from the prompt dialog. */
  resolvePrompt(payload: { promptId: number; category: BoxCategory; itemKeys: number[] }): void {
    if (!this.pending || this.pending.promptId !== payload.promptId) {
      log.warn(
        `resolvePrompt: promptId ${payload.promptId} does not match pending ${this.pending?.promptId ?? "null"}`,
      );
      return;
    }
    const stageKey = this.deps.getCurrentStageKey();
    const level = this.levelForStage(stageKey ?? 0);
    const toBoxKey =
      level != null && payload.category !== "unclassified"
        ? `${payload.category}:${level}`
        : payload.category;
    for (const itemKey of this.pending.itemKeys) {
      this.deps.boxOpenTracker.reclassifyItem(UNCLASSIFIED_BOX_KEY, itemKey, toBoxKey);
    }
    log.info(
      `resolved prompt ${payload.promptId}: ${this.pending.itemKeys.length} items → ${toBoxKey}`,
    );
    this.pending = null;
  }

  /** 1Hz tick: prune expired queue items and pending prompt. Called by TrackingService. */
  tick(): void {
    if (!this.enabled) return;
    // Detect inventory full / not-full transitions first, so pause/resume
    // effects (effectiveNow freeze, shiftQueueTimes on resume) are applied
    // before any elapsed/expired checks below. This is the primary trigger
    // for pause detection — reconcileWithChestSlots also calls it as a
    // secondary trigger on save parse.
    this.updateInventoryPauseState();
    if (this.inventoryFullSinceMs != null) {
      // Inventory full: the game paused all chest auto-open timers (it
      // cannot drop loot into a full bag). Skip slot decrement and prune —
      // `effectiveNow` is frozen at the pause moment, so no item should be
      // treated as elapsed or expired while the timer is frozen. Pending
      // prompt timeout still uses wall-clock: user interaction is
      // independent of the game's auto-open pause. Pending burst TTL also
      // uses wall-clock: classification depends on save reconcile, not on
      // the game's auto-open timer.
      const wallNow = Date.now();
      if (this.pending && wallNow - this.pending.createdAtMs > PROMPT_TIMEOUT_MS) {
        log.info(
          `prompt ${this.pending.promptId} timed out, ${this.pending.itemKeys.length} items left unclassified`,
        );
        this.pending = null;
      }
      this.pruneExpiredPendingBursts(wallNow);
      return;
    }
    const now = Date.now();
    // Real-time slot tracking under the serial-queue model: each category
    // has its own independent timer, so multiple categories' current targets
    // may have elapsed since the last tick. Walk the queue prefix (sorted by
    // `autoOpenAtMs` ascending) and process every elapsed, unprocessed item
    // — not just the global head. Tail items whose `autoOpenAtMs` is still
    // in the future are skipped via the `break` (queue is sorted, so once
    // one item is in the future, all subsequent ones are too). WeakSet
    // tracks items already decremented so `processEvent` won't
    // double-decrement when the same item is later dequeued by an
    // unclassified burst.
    if (this.liveSlots && this.queue.length > 0) {
      for (let i = 0; i < this.queue.length; i++) {
        const item = this.queue[i]!;
        if (item.autoOpenAtMs > now) break; // queue sorted asc — rest are future
        if (this.slotDecrementedItems.has(item)) continue;
        const cat = categoryFromBoxKey(item.boxKey);
        if (cat && cat !== "unclassified" && this.liveSlots[cat] > 0) {
          this.liveSlots[cat]--;
        }
        this.slotDecrementedItems.add(item);
      }
    }
    const before = this.queue.length;
    this.queue = pruneExpired(this.queue, now);
    if (this.queue.length < before) {
      log.info(`pruned ${before - this.queue.length} expired queue items`);
    }
    if (this.pending && now - this.pending.createdAtMs > PROMPT_TIMEOUT_MS) {
      log.info(
        `prompt ${this.pending.promptId} timed out, ${this.pending.itemKeys.length} items left unclassified`,
      );
      this.pending = null;
    }
    this.pruneExpiredPendingBursts(now);
  }

  /**
   * Prune pending bursts older than {@link PENDING_BURST_TTL_MS}. Called from
   * both branches of {@link tick} (inventory-paused and normal) because
   * pending burst TTL is wall-clock based — classification depends on save
   * reconcile, not on the game's auto-open timer, so inventory pause should
   * not delay pruning.
   */
  private pruneExpiredPendingBursts(now: number): void {
    const before = this.pendingBursts.length;
    if (before === 0) return;
    this.pendingBursts = this.pendingBursts.filter(
      (b) => now - b.createdAtMs < PENDING_BURST_TTL_MS,
    );
    const pruned = before - this.pendingBursts.length;
    if (pruned > 0) {
      log.info(
        `pruned ${pruned} expired pending burst(s) ` +
          `(items left unclassified for manual handling)`,
      );
    }
  }

  private processEvent(itemKeys: number[], burstWallTimeSec: number): void {
    if (this.pending) {
      // Accumulate into pending prompt; do not re-broadcast.
      this.pending.itemKeys.push(...itemKeys);
      return;
    }
    const now = Date.now();
    const burstMs = burstWallTimeSec * 1000;
    const match = this.findBurstMatch(burstMs);
    if (match) {
      // Matched a queued slot within the grace window — classify and dequeue.
      const item = this.queue[match.idx]!;
      this.queue = this.queue.filter((_, i) => i !== match.idx);
      for (const itemKey of itemKeys) {
        this.deps.boxOpenTracker.reclassifyItem(UNCLASSIFIED_BOX_KEY, itemKey, item.boxKey);
      }
      // Real-time slot tracking: a chest opened (unclassified burst detected),
      // so its slot is freed. Skip if already counted as auto-opened in tick()
      // (WeakSet) to avoid double-decrement. This covers manual opens and
      // auto-opens whose burst arrived before the 1Hz tick.
      const cat = categoryFromBoxKey(item.boxKey);
      if (this.liveSlots && cat && cat !== "unclassified" && !this.slotDecrementedItems.has(item)) {
        if (this.liveSlots[cat] > 0) {
          this.liveSlots[cat]--;
        }
        this.slotDecrementedItems.add(item);
      }
      log.info(
        `matched ${itemKeys.length} items to queued boxKey=${item.boxKey} ` +
          `(burstMs=${burstMs}, autoOpenAtMs=${item.autoOpenAtMs}, delta=${match.delta}ms)`,
      );
      // Calibrate the remaining items in this category: the matched chest
      // opened at burstMs, so under the serial-queue model the timer
      // retargets the new head at burstMs, meaning the new head's
      // autoOpenAtMs = burstMs + autoOpenSeconds. Without this calibration,
      // timing error accumulates down the tail (e.g. if the head opened 5s
      // before its predicted autoOpenAtMs, every subsequent chest's
      // autoOpenAtMs would be 5s too late).
      if (cat && cat !== "unclassified") {
        const remaining = this.queue.some((q) => categoryFromBoxKey(q.boxKey) === cat);
        if (remaining) {
          this.resetSlotTimersForCategory(cat, burstMs + item.autoOpenSeconds * 1000);
          log.info(
            `calibrated ${cat} slot timers after burst match ` +
              `(anchor=${burstMs + item.autoOpenSeconds * 1000}ms = burstMs + ${item.autoOpenSeconds}s)`,
          );
        }
      }
      return;
    }
    // No match within grace window. If the queue is empty, prompt the user
    // to pick a category (no slots to match against). Otherwise, pend the
    // burst for classification via the next save reconcile — the save will
    // show which category's slot count decreased, letting us classify
    // without guessing. Previous behavior fell back to the head, which could
    // misclassify when the head's autoOpenAtMs was far from the burst time.
    if (this.queue.length === 0) {
      const promptId = this.nextPromptId++;
      this.pending = { promptId, itemKeys: [...itemKeys], createdAtMs: now };
      this.deps.broadcast(IPC.LOOT_PROMPT_CLASSIFY, { promptId, itemKeys: [...itemKeys] });
      log.info(`broadcast LOOT_PROMPT_CLASSIFY promptId=${promptId} items=${itemKeys.length}`);
      return;
    }
    const burstId = this.nextBurstId++;
    this.pendingBursts.push({
      burstId,
      itemKeys: [...itemKeys],
      burstMs,
      createdAtMs: now,
    });
    log.info(
      `pending burst ${burstId}: ${itemKeys.length} items, burstMs=${burstMs}, ` +
        `no queue match within ±${BURST_MATCH_GRACE_MS}ms; waiting for save reconcile`,
    );
  }

  /**
   * Find the queue item whose `autoOpenAtMs` is closest to `burstMs` and
   * within the ±{@link BURST_MATCH_GRACE_MS} grace window. Two-stage match
   * to avoid cross-category misclassification (audit M2):
   *
   *   Stage 1 — if the global head is within the grace window, match it.
   *     The head is the per-category timer's current target under the
   *     serial-queue model, so consuming it first preserves FIFO order and
   *     avoids a near-simultaneous tail item from a different category
   *     "stealing" the burst. Covers case (c) normal auto-open of head.
   *
   *   Stage 2 — head is NOT in window, expand search to the full queue and
   *     pick the closest item within the grace window. Covers:
   *     (a) manual opens of a non-head chest (head's autoOpenAtMs is far
   *         in the future; the manually-opened chest's autoOpenAtMs is
   *         closest to the burst time),
   *     (b) `autoOpenAtMs` drift after a rune change (old head's
   *         autoOpenAtMs no longer matches the real auto-open moment;
   *         recalibration should have fixed it, but this is the safety net).
   *
   * Returns `{ idx, delta }` for the matched item, or `null` if no item is
   * within the grace window. The caller (`processEvent`) pends the burst for
   * save-reconcile classification when `null` is returned (or broadcasts a
   * prompt if the queue is empty) — it does NOT fall back to dequeuing the
   * head, since guessing wrong would misclassify the burst's items.
   */
  private findBurstMatch(burstMs: number): { idx: number; delta: number } | null {
    // Stage 1: head-first match.
    if (this.queue.length > 0) {
      const head = this.queue[0]!;
      const headDelta = Math.abs(head.autoOpenAtMs - burstMs);
      if (headDelta <= BURST_MATCH_GRACE_MS) {
        return { idx: 0, delta: headDelta };
      }
    }
    // Stage 2: head not in window — search the full queue for the closest.
    let matchedIdx = -1;
    let matchedDelta = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const candidate = this.queue[i]!;
      const delta = Math.abs(candidate.autoOpenAtMs - burstMs);
      if (delta <= BURST_MATCH_GRACE_MS && delta < matchedDelta) {
        matchedDelta = delta;
        matchedIdx = i;
      }
    }
    return matchedIdx >= 0 ? { idx: matchedIdx, delta: matchedDelta } : null;
  }

  /**
   * Compare `chestService.getAutoOpenSeconds()` against the last-seen values.
   * If any category drifted by more than {@link AUTO_OPEN_DRIFT_THRESHOLD}
   * (relative), recompute every queued item's `autoOpenAtMs` and
   * `expiresAtMs` to keep the serial-queue model accurate. No-op when
   * ChestService returns null (no save parsed yet) or when the queue is
   * empty. Called from `handleChestDrop`, `reconcileWithChestSlots`, and
   * `setEnabled(true)` so drift is caught before any enqueue or save-driven
   * prune.
   */
  private maybeRecalibrateQueue(): void {
    const current = this.deps.chestService.getAutoOpenSeconds();
    if (!current) return; // No save parsed yet; FALLBACK_AUTO_OPEN still in use.
    const prev = this.lastAutoOpenSeconds;
    this.lastAutoOpenSeconds = current;
    if (this.queue.length === 0) return;
    if (prev) {
      // A category is "below threshold" when EITHER the absolute delta is
      // negligible (< AUTO_OPEN_ABSOLUTE_THRESHOLD, e.g. sub-second float
      // noise) OR the relative drift is small (< AUTO_OPEN_DRIFT_THRESHOLD).
      // Recompute only when ALL categories exceed the threshold. The
      // absolute floor prevents tiny deltas on small `prev` values from
      // producing large relative ratios that would trigger spurious
      // recomputation.
      const isBelowThreshold = (a: number, b: number) => {
        const absDelta = Math.abs(a - b);
        return (
          absDelta < AUTO_OPEN_ABSOLUTE_THRESHOLD ||
          absDelta / Math.max(b, 1) < AUTO_OPEN_DRIFT_THRESHOLD
        );
      };
      if (
        isBelowThreshold(current.common, prev.common) &&
        isBelowThreshold(current.stageBoss, prev.stageBoss) &&
        isBelowThreshold(current.actBoss, prev.actBoss)
      ) {
        return; // No significant drift.
      }
    }
    // First calibration (prev == null) or drift exceeded threshold: recompute.
    this.recomputeQueueAutoOpenAtMs(current);
  }

  /**
   * Recompute every queued item's `autoOpenAtMs` and `expiresAtMs` using the
   * current `autoOpenSeconds`, preserving the serial-queue model: items are
   * sorted by `droppedAtMs` ascending, then within each category the first
   * item anchors to `droppedAtMs + autoOpen*1000` and each subsequent item
   * chains onto the previous same-category tail. The queue is then re-sorted
   * by the new `autoOpenAtMs` so the global head is the soonest-opening chest.
   *
   * This is the key long-session correction: under the serial-queue model,
   * any per-item `autoOpenSeconds` error accumulates down the tail (N × δ),
   * so rune purchases, FALLBACK→real-value transitions, or save-driven
   * updates must trigger a full recomputation to prevent the tail's
   * `autoOpenAtMs` from drifting away from the real auto-open moment.
   */
  private recomputeQueueAutoOpenAtMs(autoOpen: {
    common: number;
    stageBoss: number;
    actBoss: number;
  }): void {
    if (this.queue.length === 0) return;
    // Sort by droppedAtMs ascending so we can chain tails in drop order.
    const sorted = [...this.queue].sort((a, b) => a.droppedAtMs - b.droppedAtMs);
    const tailsByCat: Partial<Record<BoxCategory, number>> = {};
    // Build new item objects (immutability contract — audit M3/Q7): mutating
    // existing items in place would break the `slotDecrementedItems` WeakSet,
    // which tracks item references to prevent double-decrement. By creating
    // new objects we force a clean WeakSet reset below.
    const newItems: QueueItem[] = sorted.map((item) => {
      const cat = categoryFromBoxKey(item.boxKey) ?? "unclassified";
      const seconds = this.autoOpenForBoxKey(item.boxKey, autoOpen);
      const prevTail = tailsByCat[cat];
      const autoOpenAtMs =
        prevTail != null ? prevTail + seconds * 1000 : item.droppedAtMs + seconds * 1000;
      tailsByCat[cat] = autoOpenAtMs;
      return {
        ...item,
        autoOpenAtMs,
        autoOpenSeconds: seconds,
        expiresAtMs: autoOpenAtMs + computeTtlMs(seconds),
      };
    });
    // Re-sort the queue by the new autoOpenAtMs (ties broken by droppedAtMs).
    this.queue = newItems.sort((a, b) => {
      if (a.autoOpenAtMs !== b.autoOpenAtMs) return a.autoOpenAtMs - b.autoOpenAtMs;
      return a.droppedAtMs - b.droppedAtMs;
    });
    // Reset WeakSet: new item objects have no history. Old entries pointed
    // at pre-recompute items that are no longer in the queue, and retaining
    // them would suppress tick's slot decrement for the new items whose
    // autoOpenAtMs may have moved from past to future (or vice versa).
    this.slotDecrementedItems = new WeakSet();
    log.info(
      `recalibrated queue (${this.queue.length} items): ` +
        `autoOpen common=${autoOpen.common} stageBoss=${autoOpen.stageBoss} actBoss=${autoOpen.actBoss}`,
    );
  }

  private resolveDropBoxKey(
    event: { category: ChestDropCategory; itemKey?: number },
    stageKey: number,
  ): string | null {
    // ChestDropCategory is "common" | "rare" | "act". COMMON and ACT chests
    // have their own tracker routes (independent level numbering from RARE).
    // RARE stage boss chests use the BoxTimer catalog's farmStageOptions via
    // levelForStage. Falls back to category-only when no match.
    const cat: BoxCategory = event.category;
    const routes =
      cat === "act"
        ? this.deps.actBossRoutes()
        : cat === "common"
          ? this.deps.commonRoutes()
          : null;
    const level = routes ? this.levelFromRoutes(stageKey, routes) : this.levelForStage(stageKey);
    return level != null ? `${cat}:${level}` : cat;
  }

  /**
   * Infer the chest level for `stageKey` from the stage-box catalog.
   * Filters out entries with null level (non-rare rows) before delegating to
   * `inferLevelFromStage`, whose catalog parameter requires `level: number`.
   */
  private levelForStage(stageKey: number): number | null {
    return inferLevelFromStage(
      this.deps
        .stageBoxCatalog()
        .filter((e): e is BoxTimerCatalogEntry & { level: number } => e.level != null),
      stageKey,
    );
  }

  /**
   * Infer the chest level for `stageKey` from a tracker route table. Matches
   * the route whose `dropStageKeys` includes `stageKey`; falls back to the
   * lowest level when no match (e.g. catalog not loaded or stage is not a
   * drop stage for this category). Used by both COMMON and ACT categories.
   */
  private levelFromRoutes(
    stageKey: number,
    routes: ReadonlyArray<StageBoxTrackerRoute>,
  ): number | null {
    if (routes.length === 0) return null;
    const fallback = routes.reduce(
      (min, route) => (route.level < min ? route.level : min),
      routes[0]!.level,
    );
    if (!Number.isFinite(stageKey) || stageKey <= 0) return fallback;
    const matches = routes.filter((route) => route.dropStageKeys.includes(stageKey));
    if (matches.length === 0) return fallback;
    return matches.reduce((max, route) => (route.level > max ? route.level : max), 0) || fallback;
  }

  private autoOpenForBoxKey(
    boxKey: string,
    autoOpen: { common: number; stageBoss: number; actBoss: number },
  ): number {
    const cat = categoryFromBoxKey(boxKey);
    if (cat === "common") return autoOpen.common;
    if (cat === "rare") return autoOpen.stageBoss;
    if (cat === "act") return autoOpen.actBoss;
    return FALLBACK_AUTO_OPEN.common;
  }
}
