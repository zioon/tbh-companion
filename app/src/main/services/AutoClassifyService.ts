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
  dequeue,
  enqueue,
  groupBoxOpenEvents,
  promoteNextHead,
  pruneExpired,
  type QueueItem,
} from "../../core/boxOpenAutoClassify";
import { createLogger } from "../log";

const log = createLogger("autoClassify");

/** Fallback auto-open seconds when ChestService has no save yet. */
const FALLBACK_AUTO_OPEN = { common: 300, stageBoss: 600, actBoss: 60 } as const;

/** Pending prompt lifetime (ms). Items left unclassified after timeout stay unclassified. */
const PROMPT_TIMEOUT_MS = 60_000;

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

  constructor(deps: AutoClassifyServiceDeps) {
    this.deps = deps;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.queue = [];
      this.pending = null;
    }
    log.info(`auto-classify ${enabled ? "enabled" : "disabled"}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Snapshot of the queue for renderer display. Grouped by BoxCategory with
   * the head item's remaining auto-open time, plus a per-item view for the
   * detailed queue list. Called via IPC at 1 Hz by the renderer when
   * auto-classify is enabled.
   */
  getQueueSnapshot(): AutoClassifyStatePayload {
    const now = Date.now();
    const order = ["common", "rare", "act"] as const;
    const byCategory = order.map((category) => {
      const items = this.queue.filter((item) => categoryFromBoxKey(item.boxKey) === category);
      const head = items[0];
      let nextAutoOpenInMs: number | null = null;
      if (head?.autoOpenAtMs != null) {
        nextAutoOpenInMs = Math.max(0, head.autoOpenAtMs - now);
      }
      return { category, count: items.length, nextAutoOpenInMs };
    });
    const items: AutoClassifyQueueItem[] = this.queue.map((q) => {
      // Queue items are only ever enqueued with valid category boxKeys (see
      // resolveDropBoxKey), so categoryFromBoxKey won't return null here in
      // practice — but it returns `BoxCategory | null` at the type level, so
      // fall back to "unclassified" to satisfy the non-null item shape.
      const category = categoryFromBoxKey(q.boxKey) ?? "unclassified";
      // autoOpenAtMs is null when this chest is waiting behind another chest
      // of the same boxKey (serial per-slot auto-open). In that case the
      // renderer shows "waiting" instead of a countdown.
      const autoOpenInMs: number | null =
        q.autoOpenAtMs != null ? Math.max(0, q.autoOpenAtMs - now) : null;
      return {
        boxKey: q.boxKey,
        category,
        droppedAtMs: q.droppedAtMs,
        stageKey: q.stageKey,
        autoOpenInMs,
        expiresInMs: Math.max(0, q.expiresAtMs - now),
      };
    });
    return { enabled: this.enabled, totalQueued: this.queue.length, byCategory, items };
  }

  /** Called by TrackingService when a chest drop is recorded. */
  handleChestDrop(event: {
    category: ChestDropCategory;
    wallTime: number;
    itemKey?: number;
  }): void {
    if (!this.enabled) return;
    const stageKey = this.deps.getCurrentStageKey() ?? 0;
    const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
    const boxKey = this.resolveDropBoxKey(event, stageKey);
    if (!boxKey) {
      log.warn(`could not resolve boxKey for drop category=${event.category} stageKey=${stageKey}`);
      return;
    }
    this.queue = enqueue(this.queue, {
      boxKey,
      droppedAtMs: event.wallTime * 1000,
      stageKey,
      autoOpenSeconds: this.autoOpenForBoxKey(boxKey, autoOpen),
      // Serial queueing is per-category (common / rare / act): the game opens
      // one chest slot at a time per category regardless of level, so chests
      // of the same category queue serially while different categories run
      // in parallel. event.category is already the canonical serialKey.
      serialKey: event.category,
    });
    log.info(`queued drop boxKey=${boxKey} stageKey=${stageKey} queueLen=${this.queue.length}`);
  }

  /** Called by TrackingService when unclassified box-open entries are recorded. */
  handleUnclassifiedBatch(entries: readonly BoxOpenHistoryEntry[]): void {
    if (!this.enabled || entries.length === 0) return;
    const events = groupBoxOpenEvents(
      entries.map((e) => ({ itemKey: e.itemKey, wallTime: e.wallTime })),
    );
    for (const evt of events) {
      this.processEvent(evt.itemKeys);
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
   */
  reconcileWithChestSlots(slots: { common: number; rare: number; act: number }): void {
    if (!this.enabled) return;
    const order = ["common", "rare", "act"] as const;
    const now = Date.now();
    let prunedTotal = 0;
    for (const category of order) {
      const slotCount = slots[category];
      const matching = this.queue.filter((q) => categoryFromBoxKey(q.boxKey) === category);
      const queueCount = matching.length;
      if (queueCount <= slotCount) {
        if (queueCount < slotCount) {
          log.info(
            `reconcile: ${category} queue (${queueCount}) < slots (${slotCount}); ` +
              `${slotCount - queueCount} chest(s) predate live tracking or were missed`,
          );
        }
        continue;
      }
      const excess = queueCount - slotCount;
      // Queue is sorted with active heads first (by autoOpenAtMs ascending),
      // then waiting (null) items by droppedAtMs ascending. The first
      // `excess` matching items in array order are the ones that should have
      // opened already (they're either the active head or a waiting item
      // whose predecessor was among the pruned). Prune them.
      const toRemove = new Set(matching.slice(0, excess));
      this.queue = this.queue.filter((q) => !toRemove.has(q));
      prunedTotal += excess;
      // After pruning, the next waiting item of this category (if any) must
      // be promoted to active head — its timer starts now, modeling the
      // serial per-slot auto-open. Serial queueing is per-category, so a
      // single promote call covers all chests of this category regardless of
      // their boxKey levels. `now` is used as an upper bound (the pruned
      // chests opened at or before now).
      this.queue = promoteNextHead(this.queue, category, now);
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

  private processEvent(itemKeys: number[]): void {
    if (this.pending) {
      // Accumulate into pending; do not re-broadcast.
      this.pending.itemKeys.push(...itemKeys);
      return;
    }
    const now = Date.now();
    const { queue, item } = dequeue(this.queue, now);
    this.queue = queue;
    if (item) {
      for (const itemKey of itemKeys) {
        this.deps.boxOpenTracker.reclassifyItem(UNCLASSIFIED_BOX_KEY, itemKey, item.boxKey);
      }
      log.info(`matched ${itemKeys.length} items to queued boxKey=${item.boxKey}`);
      return;
    }
    // Queue empty: prompt the user.
    const promptId = this.nextPromptId++;
    this.pending = { promptId, itemKeys: [...itemKeys], createdAtMs: now };
    this.deps.broadcast(IPC.LOOT_PROMPT_CLASSIFY, { promptId, itemKeys: [...itemKeys] });
    log.info(`broadcast LOOT_PROMPT_CLASSIFY promptId=${promptId} items=${itemKeys.length}`);
  }

  private resolveDropBoxKey(
    event: { category: ChestDropCategory; itemKey?: number },
    stageKey: number,
  ): string | null {
    // ChestDropCategory is "common" | "rare" | "act". Level comes from the
    // tracker catalog: RARE stage boss routes for common/rare, LEGENDARY act
    // boss routes for act. Falls back to category-only when no match.
    const cat: BoxCategory = event.category;
    const routes = cat === "act" ? this.deps.actBossRoutes() : null;
    const level = routes
      ? this.actBossLevelForStage(stageKey, routes)
      : this.levelForStage(stageKey);
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
   * Infer the act boss chest level for `stageKey` from the LEGENDARY act boss
   * tracker routes. Matches the route whose `dropStageKeys` includes
   * `stageKey`; falls back to the lowest level when no match (e.g. catalog
   * not loaded or stage is not an act boss stage).
   */
  private actBossLevelForStage(
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
