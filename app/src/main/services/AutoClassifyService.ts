import type {
  AutoClassifyStatePayload,
  BoxCategory,
  BoxOpenHistoryEntry,
  BoxTimerCatalogEntry,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import type { ChestDropCategory, ChestDropTracker } from "../../core/chestDropTracker";
import type { BoxOpenTracker } from "../../core/boxOpenTracker";
import { categoryFromBoxKey, UNCLASSIFIED_BOX_KEY } from "../../core/boxOpenLog";
import { inferLevelFromStage } from "../../core/stageBoxTracker";
import {
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
   * the head item's remaining auto-open time. Called via IPC at 1 Hz by the
   * renderer when auto-classify is enabled.
   */
  getQueueSnapshot(): AutoClassifyStatePayload {
    const autoOpen = this.deps.chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN;
    const now = Date.now();
    const order: ReadonlyArray<BoxCategory> = ["common", "rare", "act"];
    const byCategory = order.map((category) => {
      const items = this.queue.filter((item) => categoryFromBoxKey(item.boxKey) === category);
      const head = items[0];
      let nextAutoOpenInMs: number | null = null;
      if (head) {
        const autoOpenSeconds = this.autoOpenForBoxKey(head.boxKey, autoOpen);
        nextAutoOpenInMs = Math.max(0, head.droppedAtMs + autoOpenSeconds * 1000 - now);
      }
      return { category, count: items.length, nextAutoOpenInMs };
    });
    return { enabled: this.enabled, totalQueued: this.queue.length, byCategory };
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
    // stage catalog; falls back to category-only when no match. Act boss
    // chests have no level (single per-act drop), so they stay category-only.
    const cat: BoxCategory = event.category;
    if (cat === "act") return "act";
    const level = this.levelForStage(stageKey);
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
