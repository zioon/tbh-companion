import { expandPath } from "../config";
import { SaveWatcher } from "../saveWatcher";
import { buildStats } from "../stats";
import { makeHistoryLogger } from "../historyLog";
import { XpTracker } from "../../core/tracker";
import { ChestDropTracker, LiveChestDropAggregator } from "../../core/chestDropTracker";
import { BoxOpenTracker, type BoxOpenPriceResolver } from "../../core/boxOpenTracker";
import { resolveBoxKey, UNCLASSIFIED_BOX_KEY } from "../../core/boxOpenLog";
import { catalogItemKeyFromSave, type GameItem } from "../../core/gamedata";
import { instantSellValue } from "../../core/inventory/buyOrder";
import { marketHashName } from "../../core/marketName";
import { DpsTracker } from "../../core/liveMemory/dpsTracker";
import type {
  AppConfig,
  BoxOpenEntry,
  InventorySnapshot,
  LiveMemorySnapshot,
  LookupPriceSnapshot,
  ResolvedInventory,
  ResolvedInventoryRow,
  SaveSnapshot,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { detectHeroLevelUps, type HeroLevelUpEvent } from "../../core/heroes/detectLevelUps";
import { createLogger } from "../log";
import type { SessionStateService } from "./SessionStateService";
import { AutoClassifyService } from "./AutoClassifyService";

const log = createLogger("tracking");

/** Live-memory frames arrive at ~25 Hz; the UI doesn't need a broadcast that often. */
const LIVE_BROADCAST_INTERVAL_MS = 200;

export class TrackingService {
  private tracker!: XpTracker;
  private chestDropTracker!: ChestDropTracker;
  private chestAggregator!: LiveChestDropAggregator;
  private boxOpenTracker!: BoxOpenTracker;
  private dpsTracker!: DpsTracker;
  private watcher: SaveWatcher | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastSnap: SaveSnapshot | null = null;
  private lastLiveFrame: LiveMemorySnapshot | null = null;
  private lastLiveBroadcastMs = 0;
  /**
   * XP/gold totals captured at the last recorded stage-clear event, used to
   * compute this run's gained XP/gold as a delta. `null` means the next clear
   * is the first since attach/reset — its true start is unknown, so it seeds
   * the baseline without being recorded (mirrors filtering out a partial run).
   *
   * XP uses `tracker.cumulativeGained` (cap-filtered: perHeroGain returns 0 at
   * max level) rather than `currentTotalXp` (raw hero exp sum, which keeps
   * growing at the cap — phantom XP).
   */
  private stageEventBaseline: { xp: number; gold: number } | null = null;
  /** Last stage seen in a live frame — used to detect stage/wave changes for per-map DPS. */
  private lastLiveStage: { stageKey: number; stageWave: number } | null = null;
  private lastError: string | null = null;
  private config!: AppConfig;
  private restoreApplied = false;
  private readonly onInventory: (snap: InventorySnapshot) => void;
  private readonly parseInventorySnapshot?: (text: string, mtime: number) => InventorySnapshot;
  /** GameData index for resolving box-open item names/grades; set by appState. */
  private gameDataLookup: Map<number, GameItem> | null = null;
  /**
   * Index over the latest resolved inventory's `rows`, keyed by `itemKey`.
   * Rebuilt on every `setInventorySnapshot` so `buildBoxOpenPriceResolver`
   * is O(1) per lookup instead of O(rows). Inventory can reach tens of
   * thousands of rows, and a burst of box opens used to scan the full array
   * for each entry.
   */
  private inventoryByItemKey: Map<number, ResolvedInventoryRow> | null = null;
  /** Latest lookup-price snapshot for fallback price resolution. */
  private lookupPriceSnapshot: LookupPriceSnapshot | null = null;
  /**
   * AutoClassifyService instance wired via `setAutoClassifyService`. The
   * tracker callbacks (chest-drop onDrop, box-open onUnclassified) reference
   * this field with `?.` so it can be set after `start()` runs — appState
   * calls `setAutoClassifyService` right after `tracking.start`.
   */
  private autoClassify: AutoClassifyService | null = null;

  constructor(
    onInventory: (snap: InventorySnapshot) => void,
    parseInventorySnapshot?: (text: string, mtime: number) => InventorySnapshot,
    private readonly onStageKey?: (stageKey: number) => void,
    private readonly sessionState?: SessionStateService,
    private readonly onHeroLevelUp?: (events: HeroLevelUpEvent[]) => void,
    private readonly onLiveStageBossDrop?: (stageKey: number) => void,
    private readonly onLiveStageClear?: (
      stageKey: number,
      clearTimeSec: number,
      xpGained: number,
      goldGained: number,
    ) => void,
  ) {
    this.onInventory = onInventory;
    this.parseInventorySnapshot = parseInventorySnapshot;
  }

  start(config: AppConfig): void {
    // Idempotent: tear down any prior watcher/tickTimer before re-initializing
    // so a second start() can't leak the previous intervals.
    this.stop();
    this.config = config;
    this.tracker = new XpTracker(config.rollingWindowMinutes * 60);
    this.chestDropTracker = new ChestDropTracker({
      onDrop: (e) => this.autoClassify?.handleChestDrop(e),
    });
    this.chestAggregator = new LiveChestDropAggregator(0.5, (e) => {
      // Diagnostic logging for chest-drop burst aggregation. Only logs on
      // meaningful events (input arriving or a flush firing), never on idle
      // ticks, so it can't flood the log. Uses info (not debug) so the lines
      // land in app.log even in packaged builds — file transport level is
      // "info" (see log.ts), so debug would only show on the console.
      if (e.inputCategories.length > 0) {
        log.info(
          `chestAgg feed: in=[${e.inputCategories.join(",")}] ` +
            `buf=${e.bufferSizeAfter} flushed=[${e.flushedCategories.join(",")}]` +
            (e.flushedStale ? " (stale-flush)" : ""),
        );
      }
      if (e.flushedCategories.length > 0) {
        log.info(
          `chestAgg flushed: [${e.flushedCategories.join(",")}] ` +
            `(buf_after=${e.bufferSizeAfter})`,
        );
      }
    });
    this.boxOpenTracker = new BoxOpenTracker({
      onUnclassified: (entries) => this.autoClassify?.handleUnclassifiedBatch(entries),
    });
    this.dpsTracker = new DpsTracker();
    this.stageEventBaseline = null;
    this.lastLiveStage = null;
    if (config.logHistoryCsv) {
      this.tracker.onHistory = makeHistoryLogger();
    }
    this.restoreApplied = false;
    this.watcher = this.createWatcher();
    this.watcher.start();
    this.tickTimer = setInterval(() => {
      // autoClassify tick runs every second regardless of the broadcast gate so
      // queue pruning and prompt timeouts stay accurate even when stats pushes
      // are suppressed by the live-memory throttle.
      this.autoClassify?.tick();
      // Skip the redundant push if a live-memory frame already broadcast recently —
      // avoids the 1 Hz safety-net tick doubling up with the ~5 Hz live broadcast.
      if (Date.now() - this.lastLiveBroadcastMs < LIVE_BROADCAST_INTERVAL_MS) return;
      this.pushStats();
    }, 1000);
    this.sessionState?.startAutosave(() => ({
      tracker: this.tracker,
      chestDropTracker: this.chestDropTracker,
      boxOpenTracker: this.boxOpenTracker,
      lastSnap: this.lastSnap,
      config: this.config,
    }));
  }

  stop(): void {
    this.sessionState?.stopAutosave();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.watcher?.stop();
    this.watcher = null;
  }

  pushStats(): void {
    const stats = this.getStats();
    broadcast(IPC.STATS, stats);
  }

  getStats() {
    return buildStats(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.dpsTracker,
      this.lastSnap,
      this.lastError,
      this.sessionState?.getStatusOverride() ?? null,
      this.lastLiveFrame,
      this.buildBoxOpenPriceResolver(),
    );
  }

  /**
   * Reset session rates (XP / gold / DPS / stage-event baseline) but preserve
   * loot history (chest drops + box opens). Loot is cumulative across session
   * resets — players often reset rates mid-session to measure a new farming
   * stretch without wiping their drop log. Use {@link clearSession} (Settings →
   * Clear session snapshot) or {@link onSavePathChanged} for a full wipe
   * including loot.
   */
  reset(): void {
    this.tracker.reset();
    this.dpsTracker.reset();
    this.stageEventBaseline = null;
    this.sessionState?.onTrackerReset(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.config,
      this.lastSnap,
    );
    this.pushStats();
  }

  /**
   * Full wipe: rates AND loot history. Called when the user clears the saved
   * session snapshot from Settings (the session_state.json file is deleted, so
   * in-memory loot must also go). For rate-only resets, use {@link reset}.
   */
  clearSession(): void {
    this.tracker.reset();
    this.chestDropTracker.reset();
    this.chestAggregator.reset();
    this.boxOpenTracker.resetAll();
    this.dpsTracker.reset();
    this.stageEventBaseline = null;
    this.sessionState?.onTrackerReset(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.config,
      this.lastSnap,
    );
    this.pushStats();
  }

  flushSession(): void {
    this.sessionState?.flush(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.lastSnap,
      this.config,
    );
  }

  getTracker(): XpTracker {
    return this.tracker;
  }

  setTracker(tracker: XpTracker): void {
    this.tracker = tracker;
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /** Provide the GameData index for box-open item name/grade resolution. */
  setGameDataLookup(lookup: Map<number, GameItem>): void {
    this.gameDataLookup = lookup;
  }

  /** Provide the latest resolved inventory for buy-order price resolution. */
  setInventorySnapshot(snap: ResolvedInventory | null): void {
    // Rebuild the lookup index in one pass; subsequent per-item lookups during
    // box-open bursts become O(1) instead of O(rows) each.
    if (snap) {
      const idx = new Map<number, ResolvedInventoryRow>();
      for (const row of snap.rows) idx.set(row.itemKey, row);
      this.inventoryByItemKey = idx;
    } else {
      this.inventoryByItemKey = null;
    }
  }

  /** Provide the latest lookup-price snapshot for fallback price resolution. */
  setLookupPriceSnapshot(snap: LookupPriceSnapshot | null): void {
    this.lookupPriceSnapshot = snap;
  }

  /**
   * Inject the AutoClassifyService. The chest-drop and box-open trackers were
   * constructed in `start()` with callbacks that delegate to
   * `this.autoClassify?.handle*`, so setting this field is enough to enable
   * the flow — no re-wiring needed. Toggling `setEnabled` on the service
   * itself decides whether events are processed.
   */
  setAutoClassifyService(svc: AutoClassifyService): void {
    this.autoClassify = svc;
  }

  getBoxOpenTracker(): BoxOpenTracker {
    return this.boxOpenTracker;
  }

  getChestDropTracker(): ChestDropTracker {
    return this.chestDropTracker;
  }

  /**
   * Current stage key from the most recent live frame or save snapshot.
   * Used by AutoClassifyService to infer chest level for queue entries and
   * prompt resolution. Returns null when no frame/snap has been ingested.
   */
  getCurrentStageKey(): number | null {
    return this.lastLiveFrame?.stageKey ?? this.lastSnap?.stageKey ?? null;
  }

  resetLootBox(boxKey: string): void {
    this.boxOpenTracker.resetBox(boxKey);
    this.sessionState?.flush(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.lastSnap,
      this.config,
    );
    this.pushStats();
  }

  resetLootAll(): void {
    this.boxOpenTracker.resetAll();
    this.sessionState?.flush(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.lastSnap,
      this.config,
    );
    this.pushStats();
  }

  reclassifyLootItem(itemKey: number, fromBoxKey: string, toBoxKey: string): void {
    this.boxOpenTracker.reclassifyItem(fromBoxKey, itemKey, toBoxKey);
    this.sessionState?.flush(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.lastSnap,
      this.config,
    );
    this.pushStats();
  }

  /**
   * Resolve a raw BoxOpenEntry into a tracker record: derive boxKey from
   * boxType/level, look up item name/grade from gamedata. When boxType is
   * unknown (offsets not derived), records under "unclassified" so the user
   * can manually reclassify later.
   */
  private resolveBoxOpenEntry(entry: BoxOpenEntry): {
    boxKey: string;
    itemKey: number;
    name: string;
    grade: string | null;
  } {
    const boxKey = resolveBoxKey(entry.boxType, entry.level) ?? UNCLASSIFIED_BOX_KEY;

    const catalogId = catalogItemKeyFromSave(entry.itemKey);
    const item = this.gameDataLookup?.get(catalogId);
    const name = item?.name ?? `#${entry.itemKey}`;
    const grade = item?.grade ?? null;
    return { boxKey, itemKey: catalogId, name, grade };
  }

  /**
   * Build the price resolver for box-open stats. Mirrors the inventory page's
   * "Instant sell" column: walks the Steam buy-order book level-by-level and
   * returns the wallet proceeds for selling `count` units (depth-aware, so
   * large drops that exceed the book return a partial `coveredCount`).
   * Falls back to the lookup-price snapshot's lowest ask (unit × count) when
   * the inventory has no buy-order levels yet — typical for items the user
   * has never owned.
   */
  private buildBoxOpenPriceResolver(): BoxOpenPriceResolver {
    return (itemKey: number, count: number) => {
      // 1. Inventory buy-order levels (depth-aware instant-sell proceeds).
      if (this.inventoryByItemKey) {
        const invRow = this.inventoryByItemKey.get(itemKey);
        if (invRow?.buyOrderLevels?.length) {
          const result = instantSellValue(count, invRow.buyOrderLevels);
          if (result.value != null) {
            return { buyOrderValue: result.value, coveredCount: result.coveredCount };
          }
        }
      }
      // 2. Lookup-price snapshot (lowest ask as proxy, unit * count).
      if (this.lookupPriceSnapshot && this.gameDataLookup) {
        const catalogId = catalogItemKeyFromSave(itemKey);
        const item = this.gameDataLookup.get(catalogId);
        if (item) {
          const hash = marketHashName(item);
          if (hash) {
            const usd = this.lookupPriceSnapshot.prices[hash] ?? null;
            if (usd != null) {
              return { buyOrderValue: usd * count, coveredCount: count };
            }
          }
        }
      }
      return null;
    };
  }

  restartWatcher(): void {
    this.sessionState?.invalidatePending();
    this.restoreApplied = false;
    this.watcher?.stop();
    this.watcher = this.createWatcher();
    this.watcher.start();
  }

  onSessionFileDeleted(): void {
    this.sessionState?.onFileDeleted();
  }

  onSavePathChanged(): void {
    this.lastSnap = null;
    this.restoreApplied = false;
    this.sessionState?.invalidatePending();
    this.tracker.reset();
    this.chestDropTracker.reset();
    this.chestAggregator.reset();
    this.boxOpenTracker.resetAll();
    this.dpsTracker.reset();
    this.stageEventBaseline = null;
    this.sessionState?.notifyNewSession();
    this.sessionState?.onTrackerReset(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.config,
      null,
    );
    this.pushStats();
  }

  /**
   * Reset session stats when switching between live-memory and save-only tracking.
   * Save-layer and runtime values use different baselines, so totals must not carry over.
   */
  onLiveMemoryToggled(): void {
    this.lastLiveFrame = null;
    this.tracker.reset();
    this.chestDropTracker.reset();
    this.chestAggregator.reset();
    this.boxOpenTracker.resetAll();
    this.dpsTracker.reset();
    this.stageEventBaseline = null;
    if (this.lastSnap) {
      this.tracker.update(this.lastSnap);
    }
    this.sessionState?.notifyNewSession();
    this.sessionState?.onTrackerReset(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.config,
      this.lastSnap,
    );
    this.pushStats();
  }

  /**
   * Ingest a live-memory snapshot frame into the tracker.
   * Called at ~25 Hz from LiveMemoryService; broadcasts to the renderer are throttled
   * to LIVE_BROADCAST_INTERVAL_MS (tracker sampling itself stays at full rate).
   */
  ingestLiveFrame(snap: LiveMemorySnapshot): void {
    if (!snap.connected) return;
    this.lastLiveFrame = snap;

    const stage =
      snap.stageKey != null
        ? { stageKey: snap.stageKey, stageWave: snap.stageWave ?? 0 }
        : undefined;

    this.tracker.updateLive({ gold: snap.gold, heroes: snap.heroes }, snap.at / 1000, stage);

    // DPS / Damage / Mobs tracking from monster HP data (address-based, per tbh-meter)
    if (snap.monsterHp != null) {
      const timestamp = snap.at / 1000;

      // Detect stage/wave change for per-map reset (also handles first live frame).
      // A wave change covers both map clears and failures that reset the wave counter.
      const stageKey = snap.stageKey;
      const stageWave = snap.stageWave ?? 0;
      const stageChanged =
        stageKey != null &&
        (this.lastLiveStage == null ||
          stageKey !== this.lastLiveStage.stageKey ||
          stageWave !== this.lastLiveStage.stageWave);
      if (stageChanged) {
        this.dpsTracker.beginMap();
        this.lastLiveStage = { stageKey, stageWave };
      }

      this.dpsTracker.update(snap.monsterHp, snap.deadMonsterCount, timestamp);
    }

    // Live chest drops from the GetBox battle log. The game appends a burst of
    // GetBoxLog entries per chest-drop event, and that burst can straddle
    // multiple reader ticks (the reader polls at ~25 Hz while the game appends
    // entries across frames). The aggregator buffers categories across ticks
    // and collapses a burst exactly once when it goes silent — so a single drop
    // is recorded exactly once even when its burst splits across ticks. A kept
    // "rare" fires onLiveStageBossDrop, which is idempotent across ticks
    // (BoxTimerService skips when the box is already on cooldown).
    const chestAt = snap.at / 1000;
    // Warn when the GetBox log shrank since the last tick — the tail restarts
    // from 0 and re-reads old entries as new, which can duplicate recordings.
    // This is the signature the aggregator cannot fully defend against.
    if (snap.chestLogDebug && snap.chestLogDebug.count < snap.chestLogDebug.lastCountBefore) {
      log.warn(
        `chest log shrank: count=${snap.chestLogDebug.count} ` +
          `lastCountBefore=${snap.chestLogDebug.lastCountBefore} ` +
          `start=${snap.chestLogDebug.start} entriesRead=${snap.chestLogDebug.entriesRead} ` +
          `in=[${(snap.chestDrops ?? []).join(",")}]`,
      );
    }
    const chestCategories = this.chestAggregator.feed(snap.chestDrops ?? [], chestAt);
    for (const category of chestCategories) {
      if (this.chestDropTracker.recordLiveChestDrop(category, chestAt)) {
        if (category === "rare") {
          // A delayed flush may land on a tick whose snap has no stageKey
          // (e.g. reader between battles); fall back to the last live stage.
          const stageKey = snap.stageKey ?? this.lastLiveStage?.stageKey;
          if (stageKey != null && stageKey > 0) {
            this.onLiveStageBossDrop?.(stageKey);
          }
        }
      }
    }

    if (snap.stageClears && snap.stageClears.length > 0) {
      // A stage clear also resets the per-map damage/kill counters even if the
      // player stays on the same stageKey (e.g. replaying the same map).
      this.dpsTracker.beginMap();

      const stageKey = snap.stageKey ?? this.lastSnap?.stageKey ?? 0;
      if (stageKey > 0) {
        // Use cumulativeGained (cap-filtered) instead of currentTotalXp (raw
        // hero exp sum). At max level, perHeroGain returns 0 so cumulativeGained
        // stays constant — no phantom XP attributed to stage clears.
        const xp = this.tracker.cumulativeGained;
        const gold = this.tracker.currentGold;
        const clears = snap.stageClears;
        if (this.stageEventBaseline) {
          const totalXpGained = xp - this.stageEventBaseline.xp;
          const totalGoldGained = gold - this.stageEventBaseline.gold;
          const n = clears.length;
          let xpAssigned = 0;
          let goldAssigned = 0;
          for (let i = 0; i < n; i++) {
            const isLast = i === n - 1;
            const xpGained = isLast ? totalXpGained - xpAssigned : Math.floor(totalXpGained / n);
            const goldGained = isLast
              ? totalGoldGained - goldAssigned
              : Math.floor(totalGoldGained / n);
            xpAssigned += xpGained;
            goldAssigned += goldGained;
            this.onLiveStageClear?.(stageKey, clears[i], xpGained, goldGained);
          }
        }
        this.stageEventBaseline = { xp, gold };
      }
    }

    // Box-open outcomes: each entry is one opened chest producing one item.
    if (snap.boxOpens && snap.boxOpens.length > 0) {
      for (const entry of snap.boxOpens) {
        const resolved = this.resolveBoxOpenEntry(entry);
        this.boxOpenTracker.recordOpen(
          resolved.boxKey,
          resolved.itemKey,
          resolved.name,
          resolved.grade,
          1,
          snap.at / 1000,
        );
      }
    }

    // Tracker ingestion above stays at full ~25 Hz for accurate rate sampling;
    // only the renderer broadcast is throttled to cut re-render/IPC pressure.
    const now = Date.now();
    if (now - this.lastLiveBroadcastMs >= LIVE_BROADCAST_INTERVAL_MS) {
      this.lastLiveBroadcastMs = now;
      this.pushStats();
    }
  }

  private createWatcher(): SaveWatcher {
    const savePath = expandPath(this.config.savePath);
    const pollMs = Math.max(1, this.config.pollIntervalSeconds) * 1000;
    log.info(`Save watcher started (poll ${pollMs / 1000}s, path ${savePath})`);
    return new SaveWatcher({
      path: savePath,
      password: this.config.es3Password,
      pollMs,
      onSnapshot: (snap) => {
        if (this.lastSnap) {
          const levelUps = detectHeroLevelUps(this.lastSnap.heroes, snap.heroes);
          if (levelUps.length > 0) {
            this.onHeroLevelUp?.(levelUps);
          }
        }
        this.lastSnap = snap;
        this.lastError = null;
        if (!this.restoreApplied && this.sessionState) {
          this.sessionState.tryRestoreOnSnapshot(
            this.tracker,
            this.chestDropTracker,
            this.boxOpenTracker,
            snap,
          );
          this.restoreApplied = true;
        }
        this.tracker.update(snap);
        this.onStageKey?.(snap.stageKey);
        this.pushStats();
      },
      onError: (message) => {
        this.lastError = message;
        this.pushStats();
      },
      onInventory: this.onInventory,
      parseInventorySnapshot: this.parseInventorySnapshot,
    });
  }
}
