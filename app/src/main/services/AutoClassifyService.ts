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
  dequeue,
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
 * Relative-change threshold (fraction) for detecting autoOpenSeconds drift.
 * When `chestService.getAutoOpenSeconds()` changes by more than this fraction
 * on any category, the queue is recomputed to keep `autoOpenAtMs` accurate
 * under the serial-queue model (where any per-item error accumulates down
 * the tail). 1% is well above float noise but catches any meaningful rune
 * purchase or fallback→real-value transition.
 */
const AUTO_OPEN_DRIFT_THRESHOLD = 0.01;

/**
 * Half-width of the burst-matching window (ms). When an unclassified burst
 * arrives, `processEvent` looks for a queue item whose `autoOpenAtMs` is
 * within `±BURST_MATCH_GRACE_MS` of the burst's wall time. This defends
 * against head-vs-burst mismatch when: (a) the player manually opened a
 * non-head chest, (b) `autoOpenAtMs` drifted from the real auto-open moment
 * due to rune changes or wall-clock skew, or (c) the head's auto-open was
 * detected by `tick` but the burst arrived slightly late. If no item falls
 * within the window, `processEvent` falls back to dequeuing the head.
 */
const BURST_MATCH_GRACE_MS = 30_000;

interface PendingPrompt {
  promptId: number;
  itemKeys: number[];
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
   */
  private readonly autoOpenedItems = new WeakSet<QueueItem>();
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

  constructor(deps: AutoClassifyServiceDeps) {
    this.deps = deps;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.queue = [];
      this.pending = null;
      this.liveSlots = null;
      this.lastReconcileSlots = null;
      this.lastAutoOpenSeconds = null;
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
    const now = Date.now();
    const order = ["common", "rare", "act"] as const;
    const byCategory = order.map((category) => {
      const items = this.queue.filter((item) => categoryFromBoxKey(item.boxKey) === category);
      let nextAutoOpenInMs: number | null = null;
      let lastAutoOpenInMs: number | null = null;
      if (items.length > 0) {
        // Queue is sorted by autoOpenAtMs ascending, so head is the soonest
        // and tail is the latest.
        nextAutoOpenInMs = Math.max(0, items[0]!.autoOpenAtMs - now);
        lastAutoOpenInMs = Math.max(0, items[items.length - 1]!.autoOpenAtMs - now);
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
    this.queue = enqueue(this.queue, {
      boxKey,
      droppedAtMs: event.wallTime * 1000,
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
    // Recalibrate liveSlots to the save's absolute values. This discards any
    // real-time adjustments (drops/opens) accumulated since the last save parse
    // — the save is the ground truth, and the adjustments were only providing
    // sub-save-latency responsiveness between parses.
    this.liveSlots = { ...slots };

    // High-frequency reconcile (5 Hz from live snapshots) would emit the same
    // "queue < slots" info log on every tick when slots are unchanged. Suppress
    // by tracking the last-seen slots and only logging the deficit info when
    // slots actually change (or on the first call after enable). Pruning logs
    // are not suppressed — they only fire on actual excess, which is rare.
    const prev = this.lastReconcileSlots;
    const slotsChanged =
      prev == null ||
      prev.common !== slots.common ||
      prev.rare !== slots.rare ||
      prev.act !== slots.act;
    this.lastReconcileSlots = slots;

    const order = ["common", "rare", "act"] as const;
    let prunedTotal = 0;
    for (const category of order) {
      const slotCount = slots[category];
      const matching = this.queue.filter((q) => categoryFromBoxKey(q.boxKey) === category);
      const queueCount = matching.length;
      if (queueCount <= slotCount) {
        if (slotsChanged && queueCount < slotCount) {
          log.info(
            `reconcile: ${category} queue (${queueCount}) < slots (${slotCount}); ` +
              `${slotCount - queueCount} chest(s) predate live tracking or were missed`,
          );
        }
        continue;
      }
      const excess = queueCount - slotCount;
      // Queue is sorted by autoOpenAtMs ascending. The first `excess`
      // matching items are the ones with the soonest auto-open times — they
      // should have opened already. Prune them; remaining items keep their
      // original autoOpenAtMs (serial-queue model: each item's auto-open
      // moment was precomputed at drop time and is independent of the
      // pruned chests).
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
    const now = Date.now();
    // Real-time slot tracking under the serial-queue model: only the head's
    // `autoOpenAtMs` is the per-category timer's current target. When it
    // elapses, the chest is expected to have auto-opened and its slot is
    // freed. Tail items' `autoOpenAtMs` is a precomputed future moment and
    // must NOT trigger a decrement here — they will only become the timer
    // target after the current head is consumed (via this tick or via
    // `processEvent`). WeakSet tracks counted items so `processEvent` won't
    // double-decrement when the same item is later dequeued by an
    // unclassified burst.
    if (this.liveSlots && this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.autoOpenAtMs <= now && !this.autoOpenedItems.has(head)) {
        const cat = categoryFromBoxKey(head.boxKey);
        if (cat && cat !== "unclassified" && this.liveSlots[cat] > 0) {
          this.liveSlots[cat]--;
        }
        this.autoOpenedItems.add(head);
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
  }

  private processEvent(itemKeys: number[], burstWallTimeSec: number): void {
    if (this.pending) {
      // Accumulate into pending; do not re-broadcast.
      this.pending.itemKeys.push(...itemKeys);
      return;
    }
    const now = Date.now();
    const burstMs = burstWallTimeSec * 1000;
    // Burst-time window matching (serial-queue drift defense):
    // Instead of always dequeuing the head, find the queue item whose
    // `autoOpenAtMs` is closest to the burst's wall time and within the grace
    // window. This correctly handles:
    //   (a) manual opens of a non-head chest (head's autoOpenAtMs is far in
    //       the future; the manually-opened chest's autoOpenAtMs is closest
    //       to the burst time),
    //   (b) `autoOpenAtMs` drift after a rune change (old head's autoOpenAtMs
    //       no longer matches the real auto-open moment; recalibration should
    //       have fixed it, but this is the safety net),
    //   (c) normal auto-open of the head (head's autoOpenAtMs ≈ burst time,
    //       falls within the window → matched).
    // If no item is within the window, fall back to dequeuing the head so
    // that a burst with no good match still consumes a queue slot (matching
    // the pre-window-matching behavior) rather than spinning up a prompt
    // when the queue is non-empty.
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
    let item: QueueItem | null;
    if (matchedIdx >= 0) {
      // Dequeue the matched item (not necessarily the head).
      item = this.queue[matchedIdx]!;
      this.queue = this.queue.filter((_, i) => i !== matchedIdx);
    } else {
      // No item within the grace window — fall back to head (skipping
      // expired items as `dequeue` does). If head is also gone, prompt.
      const result = dequeue(this.queue, now);
      this.queue = result.queue;
      item = result.item;
      if (item) {
        log.warn(
          `no queue item within ±${BURST_MATCH_GRACE_MS}ms of burst=${burstMs}; ` +
            `falling back to head boxKey=${item.boxKey} autoOpenAtMs=${item.autoOpenAtMs}`,
        );
      }
    }
    if (item) {
      for (const itemKey of itemKeys) {
        this.deps.boxOpenTracker.reclassifyItem(UNCLASSIFIED_BOX_KEY, itemKey, item.boxKey);
      }
      // Real-time slot tracking: a chest opened (unclassified burst detected),
      // so its slot is freed. Skip if already counted as auto-opened in tick()
      // (WeakSet) to avoid double-decrement. This covers manual opens and
      // auto-opens whose burst arrived before the 1Hz tick.
      const cat = categoryFromBoxKey(item.boxKey);
      if (
        this.liveSlots &&
        cat &&
        cat !== "unclassified" &&
        !this.autoOpenedItems.has(item)
      ) {
        if (this.liveSlots[cat] > 0) {
          this.liveSlots[cat]--;
        }
        this.autoOpenedItems.add(item);
      }
      log.info(
        `matched ${itemKeys.length} items to queued boxKey=${item.boxKey} ` +
          `(burstMs=${burstMs}, autoOpenAtMs=${item.autoOpenAtMs}, delta=${matchedDelta === Infinity ? "fallback" : matchedDelta}ms)`,
      );
      return;
    }
    // Queue empty: prompt the user.
    const promptId = this.nextPromptId++;
    this.pending = { promptId, itemKeys: [...itemKeys], createdAtMs: now };
    this.deps.broadcast(IPC.LOOT_PROMPT_CLASSIFY, { promptId, itemKeys: [...itemKeys] });
    log.info(`broadcast LOOT_PROMPT_CLASSIFY promptId=${promptId} items=${itemKeys.length}`);
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
      const drift = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1);
      if (
        drift(current.common, prev.common) < AUTO_OPEN_DRIFT_THRESHOLD &&
        drift(current.stageBoss, prev.stageBoss) < AUTO_OPEN_DRIFT_THRESHOLD &&
        drift(current.actBoss, prev.actBoss) < AUTO_OPEN_DRIFT_THRESHOLD
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
    for (const item of sorted) {
      const cat = categoryFromBoxKey(item.boxKey) ?? "unclassified";
      const seconds = this.autoOpenForBoxKey(item.boxKey, autoOpen);
      const prevTail = tailsByCat[cat];
      item.autoOpenAtMs =
        prevTail != null ? prevTail + seconds * 1000 : item.droppedAtMs + seconds * 1000;
      item.autoOpenSeconds = seconds;
      item.expiresAtMs = item.autoOpenAtMs + computeTtlMs(seconds);
      tailsByCat[cat] = item.autoOpenAtMs;
    }
    // Re-sort the queue by the new autoOpenAtMs (ties broken by droppedAtMs).
    this.queue = sorted.sort((a, b) => {
      if (a.autoOpenAtMs !== b.autoOpenAtMs) return a.autoOpenAtMs - b.autoOpenAtMs;
      return a.droppedAtMs - b.droppedAtMs;
    });
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
