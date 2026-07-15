import { expandPath } from "../config";
import { SaveWatcher } from "../saveWatcher";
import { buildStats } from "../stats";
import { makeHistoryLogger } from "../historyLog";
import { XpTracker } from "../../core/tracker";
import { ChestDropTracker } from "../../core/chestDropTracker";
import { BoxOpenTracker, type BoxOpenPriceResolver } from "../../core/boxOpenTracker";
import { resolveBoxKey } from "../../core/boxOpenLog";
import { catalogItemKeyFromSave, type GameItem } from "../../core/gamedata";
import { marketHashName } from "../../core/marketName";
import { DpsTracker } from "../../core/liveMemory/dpsTracker";
import type {
  AppConfig,
  BoxOpenEntry,
  InventorySnapshot,
  LiveMemorySnapshot,
  LookupPriceSnapshot,
  ResolvedInventory,
  SaveSnapshot,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { detectHeroLevelUps, type HeroLevelUpEvent } from "../../core/heroes/detectLevelUps";
import { createLogger } from "../log";
import type { SessionStateService } from "./SessionStateService";

const log = createLogger("tracking");

/** Live-memory frames arrive at ~25 Hz; the UI doesn't need a broadcast that often. */
const LIVE_BROADCAST_INTERVAL_MS = 200;

export class TrackingService {
  private tracker!: XpTracker;
  private chestDropTracker!: ChestDropTracker;
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
  /** Latest resolved inventory snapshot for buy-order price resolution. */
  private inventorySnapshot: ResolvedInventory | null = null;
  /** Latest lookup-price snapshot for fallback price resolution. */
  private lookupPriceSnapshot: LookupPriceSnapshot | null = null;

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
    this.chestDropTracker = new ChestDropTracker();
    this.boxOpenTracker = new BoxOpenTracker();
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

  reset(): void {
    this.tracker.reset();
    this.chestDropTracker.reset();
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
    this.inventorySnapshot = snap;
  }

  /** Provide the latest lookup-price snapshot for fallback price resolution. */
  setLookupPriceSnapshot(snap: LookupPriceSnapshot | null): void {
    this.lookupPriceSnapshot = snap;
  }

  getBoxOpenTracker(): BoxOpenTracker {
    return this.boxOpenTracker;
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

  /**
   * Resolve a raw BoxOpenEntry into a tracker record: derive boxKey from
   * boxType/level, look up item name/grade from gamedata. Returns null when
   * the boxType is unknown or the item can't be resolved.
   */
  private resolveBoxOpenEntry(entry: BoxOpenEntry): {
    boxKey: string;
    itemKey: number;
    name: string;
    grade: string | null;
  } | null {
    const boxKey = resolveBoxKey(entry.boxType, entry.level);
    if (boxKey == null) return null;

    const catalogId = catalogItemKeyFromSave(entry.itemKey);
    const item = this.gameDataLookup?.get(catalogId);
    const name = item?.name ?? `#${entry.itemKey}`;
    const grade = item?.grade ?? null;
    return { boxKey, itemKey: catalogId, name, grade };
  }

  /**
   * Build the price resolver for box-open stats: inventory buy-order first,
   * lookup-price snapshot (lowest ask) as fallback for consumed items.
   */
  private buildBoxOpenPriceResolver(): BoxOpenPriceResolver {
    return (itemKey: number) => {
      // 1. Inventory buy-order (precise instant-sell).
      if (this.inventorySnapshot) {
        const invRow = this.inventorySnapshot.rows.find((r) => r.itemKey === itemKey);
        if (invRow?.buyOrderUnit != null) {
          return { buyOrderUnit: invRow.buyOrderUnit };
        }
      }
      // 2. Lookup-price snapshot (lowest ask as proxy).
      if (this.lookupPriceSnapshot && this.gameDataLookup) {
        const catalogId = catalogItemKeyFromSave(itemKey);
        const item = this.gameDataLookup.get(catalogId);
        if (item) {
          const hash = marketHashName(item);
          if (hash) {
            const usd = this.lookupPriceSnapshot.prices[hash] ?? null;
            if (usd != null) return { buyOrderUnit: usd };
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

    // Diagnostic: throttle log to every 5s
    if (snap.chestDrops && snap.chestDrops.length > 0) {
      for (const category of snap.chestDrops) {
        if (this.chestDropTracker.recordLiveChestDrop(category, snap.at / 1000)) {
          if (category === "rare" && snap.stageKey != null && snap.stageKey > 0) {
            this.onLiveStageBossDrop?.(snap.stageKey);
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
        const xp = this.tracker.currentTotalXp;
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
        if (resolved) {
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
