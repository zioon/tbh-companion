import { expandPath } from "../config";
import { SaveWatcher } from "../saveWatcher";
import { buildStats } from "../stats";
import { makeHistoryLogger } from "../historyLog";
import { XpTracker, evaluateGoldDivergence } from "../../core/tracker";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../core/localeCatalog";
import {
  ChestDropTracker,
  LiveChestDropAggregator,
  resolveLiveDropCategory,
  type ChestDropCategory,
} from "../../core/chestDropTracker";
import {
  BoxOpenTracker,
  type BoxOpenPriceResolver,
  type BoxOpenAccessoryResolver,
} from "../../core/boxOpenTracker";
import {
  resolveBoxKey,
  UNCLASSIFIED_BOX_KEY,
  levelFromBoxKey,
  isBoxItemKey,
} from "../../core/boxOpenLog";
import { catalogItemKeyFromSave, gameItemName, type GameItem } from "../../core/gamedata";
import { GRADE_ORDER } from "../../core/grades";
import { instantSellValue } from "../../core/inventory/buyOrder";
import { marketHashName } from "../../core/marketName";
import { buildMaterialSynthesisPoints } from "../../core/synthesisPoints";
import { loadLookupSources, loadOfferings } from "../../core/lookup/catalog";
import { resolveClearedStageKey } from "../../core/stages";
import { DpsTracker } from "../../core/liveMemory/dpsTracker";
import { StageRunFailDetector } from "../../core/stageRunFailDetector";
import { RecordLogTracker } from "../../core/recordLogTracker";
import { WishTracker } from "../../core/wishTracker";
import { parseWishLine } from "../../core/wishLine";
import { fitAcquireSources, FIT_WINDOW_SEC, type ClearFitEvent } from "../../core/recordLogFit";
import {
  backfillOpensFromLog,
  toBackfillTrackerEntry,
  BACKFILL_WINDOW_SEC,
  type BackfillBoxRoutes,
} from "../../core/boxOpenBackfill";
import { parseAcquireMessage, stripRichText, gradeFromAcquireColor } from "../../core/acquireLog";
import type {
  AcquireLogEntry,
  AppConfig,
  BoxOpenEntry,
  InventorySnapshot,
  LiveChestSlots,
  LiveMemorySnapshot,
  LookupItem,
  LookupPriceSnapshot,
  RecordLogPage,
  ResolvedInventory,
  ResolvedInventoryRow,
  SaveSnapshot,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { detectHeroLevelUps, type HeroLevelUpEvent } from "../../core/heroes/detectLevelUps";
import { createLogger } from "../log";
import type { SessionStateService } from "./SessionStateService";
import type { AutoClassifyService } from "./AutoClassifyService";
import { RecordLogService } from "./RecordLogService";
import { WishRecordService } from "./WishRecordService";

const log = createLogger("tracking");

/** Live-memory frames arrive at ~25 Hz; the UI doesn't need a broadcast that often. */
const LIVE_BROADCAST_INTERVAL_MS = 200;

/**
 * Bounded history of live stage-clear events for the record page's source fit
 * (see `core/recordLogFit.ts`). The record log itself only archives the game's
 * own acquire ring, but the fit needs the clear moments to attribute reward
 * lines; 200 events comfortably exceeds any window of acquire lines the fit
 * ever sees (the visible record-log slice is 200 lines, and one clear explains
 * several lines at most).
 */
const STAGE_CLEAR_FIT_LIMIT = 200;
/**
 * How long a live gold read may stay BELOW the last save gold before it is
 * treated as a stale-offset "rollback" (not a legitimate spend) and flagged for
 * the UI warning. The save watcher polls every ~5 s, so a genuine spend
 * self-corrects from the save within one poll; a rollback (v1.2.4 reusing the
 * v1.2.2 CurrencyManager RVA) persists. 8 s is longer than one save poll, so
 * only a sustained divergence trips the flag (matches StaleWaveGuard's window).
 */
const GOLD_DIVERGE_SUSTAIN_SEC = 8;
/**
 * Freshness window for `lastLiveFrame`. The worker produces a frame every ~40 ms
 * while attached; if no frame has arrived for this long, treat the cached frame
 * as stale and clear it so `buildStats`/`dpsTracker` fall back to save values.
 * Without this, a worker crash leaves the last frame cached with `connected=true`
 * forever — stage/wave/DPS freeze on the pre-crash value (heroes self-heal via
 * `tracker.xpLiveActive()` 5s timeout, but stage/DPS had no such guard).
 */
const LIVE_FRAME_FRESH_MS = 5000;

/**
 * How long a "获得了…" log line must sit before the backfill is allowed to
 * record it. The box-open reader is deliberately patient — it parks slots that
 * look mid-write and retries them (`MAX_BOX_OPEN_LOG_RETRIES`), so it can
 * legitimately commit an open a few hundred milliseconds after the ring line
 * was already visible. Without this delay every chest would be counted twice:
 * once when the reader catches up and once by the backfill. 20 s is two orders
 * of magnitude more slack than the reader ever needs, and the backfill only
 * repairs statistics — it is not a realtime path — so waiting costs nothing.
 */
const BACKFILL_GRACE_SEC = 20;
/**
 * Minimum gap between two backfill passes. The 1 Hz tick asks on every pass;
 * the grace period means anything under ~20 s of work is wasted, so 10 s keeps
 * recovery snappy (a lost open shows up at most ~30 s later) without running
 * the reconciliation more than ~6×/min.
 */
const BACKFILL_INTERVAL_MS = 10_000;
/**
 * Consecutive save read/parse errors after which the last snapshot is treated
 * as stale (`saveStale` in the stats payload). One error is often a transient
 * mid-write read; three in a row — with a poll interval of seconds — means the
 * save can no longer be read at all (e.g. a game update changed the ES3
 * password/layout) and every displayed value predates the failure.
 */
const SAVE_STALE_ERROR_THRESHOLD = 3;

export class TrackingService {
  private tracker!: XpTracker;
  private chestDropTracker!: ChestDropTracker;
  /**
   * 祈愿产出聚合器（对标 {@link ChestDropTracker}）。数据源复用 acquire 文本行
   * 管道（"获得记录"环），在 {@link ingestAcquireBatch} 中识别祈愿行后喂入。
   * 双计数（offeringCount / itemCount）与 bulk 护栏见 `core/wishTracker.ts`。
   */
  private wishTracker!: WishTracker;
  private chestAggregator!: LiveChestDropAggregator;
  private boxOpenTracker!: BoxOpenTracker;
  private dpsTracker!: DpsTracker;
  /**
   * Unified record log, now fed ONLY from the game's own "获得记录" ring (the
   * complete session timeline), persisted independently of the session so it
   * survives session resets and the in-memory LogManager wipeout.
   */
  private recordLog = new RecordLogTracker();
  private recordLogService: RecordLogService | null = null;
  /**
   * 祈愿记录的长期归档（P1-1，`wish_record.json`）。启动时一次性 load、每次
   * 识别到祈愿行后防抖落盘。**不随会话重置清空** —— `wishTracker.reset()` 只
   * 归零 *Session，归档的累计口径天然与之解耦（见 `WishRecordService`）。
   */
  private wishRecordService: WishRecordService | null = null;
  private watcher: SaveWatcher | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastSnap: SaveSnapshot | null = null;
  private lastLiveFrame: LiveMemorySnapshot | null = null;
  private lastLiveBroadcastMs = 0;
  /**
   * Account-wide stage-wave reduction from purchased Rune of Brevity nodes
   * (computed from the save's RuneSaveData by appState and pushed in). Applied
   * at `ingestLiveFrame` to the live `stageWaveTotal`. Archive property — NOT
   * reset on live-memory toggle. 0 = no reduction (identity behaviour).
   */
  private runeWaveReduction = 0;
  /**
   * Throttle for the "wave total clamped to 1" warn: keyed by
   * `${stageKey}|${raw}|${reduction}`. `null` = no clamp logged yet, so the
   * first occurrence always warns. A repeated identical clamp is ignored until
   * a different triple arrives (or `warnClampedWaveTotal` is reset). Keep cheap
   * — it only tracks the most recent triple, not a growing set.
   */
  private lastClampedWaveKey: string | null = null;
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
  /**
   * Wall-clock (snapshot `at`/1000) at which the live gold read first dropped
   * below the last save gold. Persisting past {@link GOLD_DIVERGE_SUSTAIN_SEC}
   * means stale v1.2.4 offsets are decoding an old balance (a "rollback"), not a
   * legitimate spend — `tracker.goldLiveSuspect` is then set for the UI warning.
   * Null when the live read currently meets/exceeds the save floor.
   */
  private goldDivergeSinceSec: number | null = null;
  /**
   * Recent live stage clears (wallTime + cleared stageKey) for the record
   * page's source fit. In-memory only — the fit explains visible acquire
   * lines, which never predate a companion restart by more than the ring
   * window, so persistence would add nothing. Cleared on session resets.
   */
  private stageClearHistory: ClearFitEvent[] = [];
  /**
   * Per-category box drop routes, used by the box-open backfill to turn a
   * category-only attribution into a levelled one from the stage-clear
   * evidence — see `core/boxOpenBackfill.ts`. Injected via {@link setBoxRoutes}
   * because core cannot read the bundled catalog itself; null until wired,
   * which makes the backfill fall back to category-only boxKeys (the previous
   * behaviour) rather than guess.
   */
  private boxRoutes: BackfillBoxRoutes | null = null;
  /** Last stage seen in a live frame — used to detect stage/wave changes for per-map DPS. */
  private lastLiveStage: { stageKey: number; stageWave: number } | null = null;
  /** Wall-clock (ms) of the last map-time diagnostic log; throttles output. */
  private lastMapTimeDiagAt = 0;
  /**
   * Whether the wave counter has been seeded from the save's static wave on
   * the first live frame of this tracking session. Seeding happens exactly
   * once per attach (see `ingestLiveFrame`): on later stage changes the
   * counter is already tracking the run from its start and must count from 1.
   */
  private waveSeeded = false;
  /** Heuristic stage-run failure detector (see `core/stageRunFailDetector.ts`). */
  private readonly failDetector = new StageRunFailDetector();
  private lastError: string | null = null;
  /** Consecutive save read/parse errors (reset on the next success). */
  private saveErrorCount = 0;
  /**
   * True once {@link SAVE_STALE_ERROR_THRESHOLD} consecutive save errors — every
   * stat derived from `lastSnap` is then a pre-failure value (e.g. after a game
   * update changed the encryption/layout) and the UI must say so.
   */
  private saveStale = false;
  /** Warn once when a parsed save looks structurally empty (format drift). */
  private warnedEmptySaveParse = false;
  private config!: AppConfig;
  private restoreApplied = false;
  private readonly onInventory: (snap: InventorySnapshot) => void;
  private readonly parseInventorySnapshot?: (text: string, mtime: number) => InventorySnapshot;
  /** GameData index for resolving box-open item names/grades; set by appState. */
  private gameDataLookup: Map<number, GameItem> | null = null;
  /**
   * Lookup-catalog index (`lookup_items.json`) keyed by item id. Source of
   * truth for variant id remapping — same source the renderer's `itemIndex`
   * is built from, so any variant id returned by `resolveVariantId` is
   * guaranteed to exist in the renderer. Set by appState via
   * {@link setLookupCatalog}. Kept separate from {@link gameDataLookup}
   * (gamedata.json) because the two files can desync in userData —
   * `CatalogRefreshService` only refreshes gamedata.json, so gamedata may
   * contain variant ids lookup_items.json doesn't have yet (which would
   * render as "item not found" in the entity panel / peek card).
   */
  private lookupItems: Map<number, LookupItem> | null = null;
  /**
   * Reverse index `name → grade → variantId` built from
   * {@link lookupItems} (i.e. `lookup_items.json`).
   *
   * Game saves store items as `(baseItemKey, gradeType)` — the base id (e.g.
   * 530017) is shared across all rarity variants of the same item, while
   * `gradeType` distinguishes COMMON / UNCOMMON / RARE / LEGENDARY. But the
   * bundled catalog has independent ids per variant (530017=COMMON,
   * 531171=UNCOMMON, 532171=RARE, 533171=LEGENDARY all share the name
   * "Dimensional Boots"). Without remapping, UI that looks the item up by
   * `itemKey` (entity panel, peek card, ItemLink) always hits the COMMON
   * variant. This index lets `resolveBoxOpenEntry` translate the save's
   * (baseId, grade) pair to the correct catalog variant id.
   */
  private lookupVariantIndex: Map<string, Map<string, number>> | null = null;
  /** Wall-clock (ms) of the last box-open backfill pass; throttles it. */
  private lastBackfillMs = 0;
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
   * User's display currency (ISO, uppercase). The CI lookup-price snapshot is
   * priced in USD; fallback box-open prices must be converted via the
   * snapshot's fx table. Defaults to USD until {@link setCurrency} is called.
   */
  private currency = "USD";
  /**
   * AutoClassifyService instance wired via `setAutoClassifyService`. The
   * tracker callbacks (chest-drop onDrop, box-open onUnclassified) reference
   * this field with `?.` so it can be set after `start()` runs — appState
   * calls `setAutoClassifyService` right after `tracking.start`.
   */
  private autoClassify: AutoClassifyService | null = null;
  /**
   * LocaleCatalog used for hero/stage name localization in getStats. Set
   * once at construction (defaults to emptyLocaleCatalog) and swapped via
   * {@link setLocaleCatalog} when the user changes language. Kept as a
   * field (not threaded through every call) so getStats stays parameterless.
   */
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();

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
    /**
     * Called when a stage run is inferred to have failed (ended without a
     * stage-clear event while mid-run). `stageKey` is the stage being played
     * (fallback to the current live/save stage); `failedWave` is the furthest
     * wave reached. Live-memory only. See `docs/BUSINESS-FLOWS.md` §12.
     */
    private readonly onLiveStageFail?: (stageKey: number, failedWave: number) => void,
    /**
     * Called at ~5 Hz with live chest slot counts read from
     * `PlayerSaveData.BoxData` runtime. `null` = reader active but offsets
     * unavailable this tick; callers should fall back to save-derived counts.
     * Used by AutoClassifyService for high-frequency reconcile.
     */
    private readonly onLiveChestSlots?: (slots: LiveChestSlots | null) => void,
    initialCatalog: LocaleCatalog = emptyLocaleCatalog(),
  ) {
    this.onInventory = onInventory;
    this.parseInventorySnapshot = parseInventorySnapshot;
    this.localeCatalog = initialCatalog;
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
    this.wishTracker = new WishTracker();
    // 长期归档（P1-1）：构造时 load() 一次，把 `wish_record.json` 的累计 / 历史
    // 灌入 wishTracker（在喂入任何新行之前），随后由 ingest 路径防抖落盘。
    // 复用既有实例（若存在），避免每次 start() 重复 load 覆盖实时数据。
    if (!this.wishRecordService) {
      this.wishRecordService = new WishRecordService(this.wishTracker);
    }
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
    // Load the persisted record log exactly once (re-create the debounced writer
    // each start so a previously-flushed writer doesn't linger after stop()).
    if (!this.recordLogService) {
      this.recordLogService = new RecordLogService(this.recordLog);
    }
    this.stageEventBaseline = null;
    this.lastLiveStage = null;
    this.waveSeeded = false;
    this.failDetector.reset();
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
      // Stale-frame guard: if the live-memory worker crashed or stalled, the
      // last received frame stays cached with `connected=true` and `buildStats`
      // keeps serving its (now stale) stage/wave/DPS values forever. Heroes
      // self-heal via `tracker.xpLiveActive()` 5s timeout, but stage/DPS had
      // no such guard — clear the cached frame once it's older than the
      // freshness window so stats fall back to save values.
      if (this.lastLiveFrame != null && Date.now() - this.lastLiveFrame.at > LIVE_FRAME_FRESH_MS) {
        this.lastLiveFrame = null;
        this.lastLiveStage = null;
      }
      // Statistics-side repair for box opens the `GetItemWithBoxOpen` reader
      // dropped (see `runBoxOpenBackfill`). Runs off the 1 Hz tick rather than
      // the live frame so it also fires when read() is stalled; self-throttled.
      this.runBoxOpenBackfill();
      // Skip the redundant push if a live-memory frame already broadcast recently —
      // avoids the 1 Hz safety-net tick doubling up with the ~5 Hz live broadcast.
      if (Date.now() - this.lastLiveBroadcastMs < LIVE_BROADCAST_INTERVAL_MS) return;
      this.pushStats();
    }, 1000);
    this.sessionState?.startAutosave(() => ({
      tracker: this.tracker,
      chestDropTracker: this.chestDropTracker,
      boxOpenTracker: this.boxOpenTracker,
      wishTracker: this.wishTracker,
      lastSnap: this.lastSnap,
      config: this.config,
    }));
  }

  stop(): void {
    // Force any pending record-log change to disk before tearing down timers.
    this.recordLogService?.flush();
    // 祈愿长期归档同样强制落盘（防抖窗口内可能有未写入的累计）。
    this.wishRecordService?.flush();
    this.sessionState?.stopAutosave();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.watcher?.stop();
    this.watcher = null;
  }

  /** Clear the in-memory record log after `record_log.json` was deleted from Settings. */
  resetRecordLog(): void {
    this.recordLogService?.resetStorage();
  }

  /**
   * 设置页删除 `wish_record.json` 后丢弃内存归档标记。
   *
   * 注意：**不清空 `wishTracker` 的累计** —— 与 `resetRecordLog()`（会
   * `tracker.reset()` 抹掉内存）不同，祈愿累计是 stats 展示口径，删除归档文件
   * 只应停止后续落盘，不应让当前会话的展示数据凭空消失（PRD §2.5：清归档 ≠
   * 清会话）。下次会话重置 / 重启后累计自然从 0 重新累积。
   */
  resetWishRecord(): void {
    this.wishRecordService?.resetStorage();
  }

  /**
   * One archived record-log page for the embedded record panel's pagination
   * (renderer → main IPC; page 0 is the newest window). Sliced straight off
   * the tracker archive, then source-fitted against the same three event
   * buckets the stats push uses — so badges/filters look identical whether a
   * page arrives live or fetched. Older pages can only lose their fit when
   * the in-memory bucket histories have wrapped (fit stays absent = no badge).
   */
  getRecordLogPage(page: number, pageSize: number): RecordLogPage {
    const { entries, total } = this.recordLog.getPage(page, pageSize);
    return {
      entries,
      total,
      sources: fitAcquireSources(
        entries.filter((e) => e.kind === "acquire"),
        this.chestDropTracker.fitHistory(),
        this.boxOpenTracker.fitHistory(),
        this.stageClearHistory,
        FIT_WINDOW_SEC,
      ),
    };
  }

  /** The persisted acquire-list read position (resume watermark), or null. */
  getAcquireWatermark(): number | null {
    return this.recordLogService?.getAcquireWatermark() ?? null;
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
      this.buildBoxOpenAccessoryResolver(),
      this.getMaterialPointsOverride(),
      null,
      this.localeCatalog,
      this.recordLog,
      this.stageClearHistory,
      this.saveStale,
      this.wishTracker,
    );
  }

  /**
   * Reset session stats: XP / gold / DPS / chest drops (counts + history) /
   * stage-event baseline. Stage-run history is cleared separately via
   * {@link StageRunService.resetStorage} in the appState resetTracker
   * wrapper. The persisted session_state.json and stage_run_history.json
   * files are not deleted — use {@link clearSession} (Settings → Clear
   * session snapshot) or {@link onSavePathChanged} for a permanent wipe.
   */
  reset(): void {
    this.tracker.reset();
    this.chestDropTracker.reset();
    this.wishTracker.reset();
    this.chestAggregator.reset();
    this.dpsTracker.reset();
    this.stageEventBaseline = null;
    this.stageClearHistory = [];
    // Prime the tracker with the last save snapshot so the first live frame
    // after reset can be ingested immediately (takeover on the same tick).
    // Without this, updateLive() early-returns on `!initialized` for the
    // entire save-watcher poll interval (default 5s), and the first save
    // re-read only seeds prevHero/prevGold with no gain — so the next gain
    // takes 2 save polls to surface, which the user perceives as a long
    // blank period after pressing reset.
    if (this.lastSnap) {
      this.tracker.update(this.lastSnap);
    }
    this.sessionState?.onTrackerReset(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.config,
      this.lastSnap,
      this.wishTracker,
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
    this.wishTracker.reset();
    this.chestAggregator.reset();
    this.boxOpenTracker.resetAll();
    this.dpsTracker.reset();
    this.stageEventBaseline = null;
    this.stageClearHistory = [];
    // Same baseline prime as reset() so XP/gold appear promptly when the
    // caller follows up with a non-null lastSnap. When lastSnap is null
    // (true cold-start) the tracker stays uninitialized and the next save
    // read takes its place — no behavior change in that case.
    if (this.lastSnap) {
      this.tracker.update(this.lastSnap);
    }
    this.sessionState?.onTrackerReset(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.config,
      this.lastSnap,
      this.wishTracker,
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
      this.wishTracker,
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
    this.rebuildVariantIndex();
    // If a restore already happened before the catalog was loaded (rare race
    // during startup), the entries recorded then didn't get variant remap or
    // garbage-drop. Run a pass now so they look right.
    this.runReResolveNames();
  }

  /**
   * Provide the lookup catalog (`lookup_items.json`) — the same source the
   * renderer's `itemIndex` is built from. Used to build
   * {@link lookupVariantIndex} so any variant id returned by
   * {@link resolveVariantId} is guaranteed to exist in the renderer (which
   * would otherwise show "item not found" if gamedata.json had a variant id
   * lookup_items.json lacked — they can desync because
   * `CatalogRefreshService` only refreshes gamedata.json).
   */
  setLookupCatalog(items: LookupItem[]): void {
    const byId = new Map<number, LookupItem>();
    for (const item of items) {
      byId.set(item.id, item);
    }
    this.lookupItems = byId;
    this.materialPointsOverride = null;
    this.rebuildVariantIndex();
    // If a restore happened before the lookup catalog loaded, re-resolve so
    // the (baseId, grade) → variantId remap now uses lookup-sourced ids.
    this.runReResolveNames();
  }

  /**
   * Rebuild {@link lookupVariantIndex} from whatever catalogs are loaded.
   *
   * Called from {@link setLookupCatalog}, {@link setGameDataLookup} and
   * {@link setLocaleCatalog} — the index keys off names, and a name only
   * resolves once the catalog AND the locale agree, so a late-arriving or
   * swapped locale must rebuild it.
   *
   * Three name spellings are indexed per item, because the strings being
   * matched come from three different places:
   *  - `item.name` — the localized display name (matches the game UI when the
   *    app language tracks the game language);
   *  - `item.sourceName` — the English source name (stable across languages);
   *  - the locale catalog's own entry for the id — the game-language name,
   *    which is what a "获得了…" ring line actually contains even when the
   *    app is running in a different UI language.
   *
   * First spelling wins for a given (name, grade) so the result never depends
   * on which catalog happened to be loaded last.
   */
  private rebuildVariantIndex(): void {
    const byNameGrade = new Map<string, Map<string, number>>();
    const add = (key: string | null | undefined, grade: string, id: number): void => {
      if (!key) return;
      let byGrade = byNameGrade.get(key);
      if (!byGrade) {
        byGrade = new Map();
        byNameGrade.set(key, byGrade);
      }
      if (!byGrade.has(grade)) byGrade.set(grade, id);
    };
    for (const item of this.lookupItems?.values() ?? []) {
      add(item.name, item.grade, item.id);
      add(item.sourceName, item.grade, item.id);
      add(this.localeCatalog.items[String(item.id)], item.grade, item.id);
    }
    // gamedata.json carries base rows lookup_items.json lacks; only used for
    // ids lookup has no row for (lookup stays the preferred source).
    for (const [id, item] of this.gameDataLookup ?? []) {
      if (this.lookupItems?.has(id)) continue;
      add(item.name, item.grade, id);
      add(gameItemName(item, this.localeCatalog), item.grade, id);
    }
    this.lookupVariantIndex = byNameGrade;
  }

  /**
   * Resolve a catalog variant id from a (baseItemKey, grade) pair. Sources
   * variant ids exclusively from {@link lookupVariantIndex} (built from
   * lookup_items.json) so the returned id is guaranteed to exist in the
   * renderer's `itemIndex`. Falls back to `baseItemKey` when no variant with
   * the requested grade exists — strictly better than returning a gamedata
   * variantId the renderer can't find (which would render as "item not found").
   *
   * The base item's name can come from either catalog: lookup_items.json has
   * only the variant rows (611171 UNCOMMON, 612171 RARE, ...), while
   * gamedata.json additionally has a placeholder row at the base id
   * (610017, grade=""). When the save stores `(610017, UNCOMMON)` we look up
   * the name via gamedata (since lookup lacks the base id) and then resolve
   * the variant id via `lookupVariantIndex` by name+grade.
   */
  private resolveVariantId(baseItemKey: number, grade: string | null): number {
    if (grade == null) return baseItemKey;
    const lookupBase = this.lookupItems?.get(baseItemKey);
    if (lookupBase) {
      if (lookupBase.grade === grade) return baseItemKey;
      return this.lookupVariantIndex?.get(lookupBase.name)?.get(grade) ?? baseItemKey;
    }
    // lookup_items.json doesn't have the base id (it only stores variant
    // rows). Fall back to gamedata for the name so we can still resolve the
    // variant via lookup's name→grade→id index.
    const gameBase = this.gameDataLookup?.get(baseItemKey);
    if (!gameBase) return baseItemKey;
    return this.lookupVariantIndex?.get(gameBase.name)?.get(grade) ?? baseItemKey;
  }

  /**
   * Re-resolve every recorded box-open entry through the catalog. Called once
   * after `tryRestoreOnSnapshot` (so restored snapshot data gets the same
   * (baseId, grade) → variantId remap and garbage drop that fresh drops get
   * in `resolveBoxOpenEntry`) and again from `setLookupCatalog` /
   * `setGameDataLookup` if the catalogs weren't loaded at restore time.
   * Idempotent — safe to call multiple times.
   */
  private runReResolveNames(): void {
    if (!this.lookupItems && !this.gameDataLookup) return;
    this.boxOpenTracker.reResolveNames((rawItemKey, grade) => {
      const catalogId = rawItemKey < 1_000_000 ? rawItemKey : Math.trunc(rawItemKey / 1000);
      // Box items must never be dropped here, whatever their id happens to be.
      // The backfill records rows under a levelled boxKey whose item may not be
      // in the loot catalog at all — a test/production catalog gap would
      // otherwise delete the recovered row on the next locale change (the
      // range check below only ever rescued out-of-range BOX ids, which is why
      // this went unnoticed). `reResolveNames` is idempotent, so preserving the
      // id unchanged and re-running on the next catalog swap is safe.
      if (isBoxItemKey(catalogId)) return { itemKey: catalogId, name: `#${catalogId}` };
      // Drop garbage itemKeys (e.g. v1.00.28 String-pointer low bits) that
      // don't fall in the catalog id range — they'd otherwise render as
      // `#1703973696` forever.
      if (catalogId < 110_001 || catalogId > 939_999) {
        if (this.gameDataLookup?.has(catalogId)) {
          return {
            itemKey: catalogId,
            name: gameItemName(this.gameDataLookup.get(catalogId)!, this.localeCatalog),
          };
        }
        return null;
      }
      // Remap (baseId, grade) → catalog variant id so tooltips / peek cards
      // render the correct rarity variant, not the COMMON one. Variant id is
      // sourced from lookup_items.json (same as renderer's itemIndex).
      const variantId = this.resolveVariantId(catalogId, grade);
      // Prefer the lookup catalog for the display name (matches what the
      // renderer shows); fall back to gamedata when lookup lacks the id.
      const item = this.lookupItems?.get(variantId) ?? this.gameDataLookup?.get(variantId);
      if (!item) {
        // Catalog doesn't have this id yet (e.g. newer game version): keep
        // the id with a `#id` placeholder name so the entry isn't lost.
        return { itemKey: variantId, name: `#${variantId}` };
      }
      return { itemKey: variantId, name: gameItemName(item, this.localeCatalog) };
    });
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
   * Set the user's display currency (ISO code, e.g. "USD" / "CNY"). The
   * lookup-price CI snapshot is priced in USD; the fallback resolver converts
   * it via the snapshot's fx table so the Loot page buyout column shows the
   * correct local amount instead of a raw USD value mislabeled as the local
   * currency (e.g. $0.03 shown as ¥0.03 when CNY floor is ¥0.10).
   */
  setCurrency(iso: string): void {
    this.currency = iso.toUpperCase();
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

  /**
   * Inject the per-category drop routes the box-open backfill uses to derive a
   * chest level from a stage-clear stageKey. Built by appState from the bundled
   * stage-box catalog (the same tables AutoClassifyService consumes), because
   * `core/` may not read files. Safe to call repeatedly — the backfill reads
   * the field on each pass — but in practice it is called once at startup.
   */
  setBoxRoutes(routes: BackfillBoxRoutes): void {
    this.boxRoutes = routes;
  }
  /** Drop routes currently wired into the backfill (diagnostics / tests). */
  getBoxRoutes(): BackfillBoxRoutes | null {
    return this.boxRoutes;
  }

  /**
   * Swap the LocaleCatalog used for hero/stage/item name localization.
   * Called by appState at startup and when the user changes language. Also
   * re-resolves every recorded box-open entry so the history / breakdown
   * names pick up the new language (otherwise the Loot tab would keep
   * showing the old language until new drops arrive). Does NOT re-broadcast
   * — callers should invoke getStats() afterwards to emit a fresh payload.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
    this.rebuildVariantIndex();
    this.runReResolveNames();
  }

  getBoxOpenTracker(): BoxOpenTracker {
    return this.boxOpenTracker;
  }

  getChestDropTracker(): ChestDropTracker {
    return this.chestDropTracker;
  }

  /** 祈愿聚合器（供测试与 P1 归档服务读取快照）。 */
  getWishTracker(): WishTracker {
    return this.wishTracker;
  }

  /**
   * Current stage key from the most recent live frame or save snapshot.
   * Used by AutoClassifyService to infer chest level for queue entries and
   * prompt resolution. Returns null when no frame/snap has been ingested.
   */
  getCurrentStageKey(): number | null {
    return this.lastLiveFrame?.stageKey ?? this.lastSnap?.stageKey ?? null;
  }

  /**
   * Set the account-wide stage-wave reduction (Rune of Brevity) derived from
   * the save. Logs only on an actual change (low frequency — once per save
   * rewrite at most). Non-finite / non-positive values are coerced to 0.
   */
  setRuneWaveReduction(n: number): void {
    const next = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    if (next === this.runeWaveReduction) return;
    log.info(`rune wave reduction: ${this.runeWaveReduction} → ${next}`);
    this.runeWaveReduction = next;
  }

  /**
   * Warn (throttled per stage/raw/reduction triple) that the wave total was
   * clamped to 1 because the rune reduction meets or exceeds the live total.
   * A `raw <= reduction` result almost always means the live `waveAmount`
   * already incorporated the reduction — so subtracting it again over-shoots
   * and produces a double-count. This warn is the signal a maintainer watches
   * for to decide whether the assumption in `ingestLiveFrame` still holds or
   * a static-baseline correction is needed.
   */
  private warnClampedWaveTotal(stageKey: number | null, raw: number, reduction: number): void {
    const key = `${stageKey ?? "?"}|${raw}|${reduction}`;
    if (key === this.lastClampedWaveKey) return; // throttled
    this.lastClampedWaveKey = key;
    log.warn(
      `rune wave reduction ${reduction} >= live wave total ${raw} for stage ${stageKey ?? "?"} ` +
        `— total clamped to 1 (possible double-count: game may already apply the reduction)`,
    );
  }

  resetLootBox(boxKey: string): void {
    this.boxOpenTracker.resetBox(boxKey);
    this.sessionState?.flush(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.lastSnap,
      this.config,
      this.wishTracker,
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
      this.wishTracker,
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
      this.wishTracker,
    );
    this.pushStats();
  }

  /**
   * Independent "获得记录" ingestion, driven by the worker's acquire-ring monitor
   * (initial full sync + periodic incremental sync) and delivered OUTSIDE the
   * live snapshot frame — never gated on `read()` succeeding (stage-null /
   * name-scan frames can't stall or drop these lines).
   *
   * This is the ONLY feeder of the record log: the RecordLog tab is a faithful
   * mirror of the game's own "获得记录" UI, so every line is recorded as an
   * `acquire` entry (raw text + parsed name / count / rarity color / in-game
   * time). Bucket-derived drop/open/clear events are NOT mixed in.
   *
   * `initial` (first batch after attach = the whole session backlog) is deduped
   * against the already-archived log by (acquireTime, acquireRaw) signature:
   * when the companion restarts in the same game session, the re-attach full
   * sync must not re-append lines already persisted. Duplicates WITHIN one
   * initial batch (e.g. two identical boxes opened in the same minute) are kept.
   */
  ingestAcquireBatch(
    entries: AcquireLogEntry[],
    initial = false,
    ringRestarted = false,
    watermark?: number,
  ): void {
    if (!this.recordLogService) return;
    if (entries.length === 0) return;
    const ts = Date.now() / 1000;
    let dirty = false;
    // Re-attach initial-batch dedupe by RING INDEX (`AcquireLogEntry.seq`).
    //  - `(acquireTime, acquireRaw)` is unusable: the game reuses and rewrites
    //    the ring's time-string object, so an already-archived line comes back
    //    with a different stamp (measured 2026-09-15) and was re-appended as new
    //    — companion restarts pushed 100-2000 old rows to the top of the list.
    //  - Delivery-order overlap and per-text budgets are unusable too: the texts
    //    repeat verbatim and sporadic delivery gaps break exact alignment, which
    //    re-appended the whole 2000-line window (16:40:53, deduped=0).
    // The ring index is exact and stable within a game session: skip lines whose
    // index is already archived; an index NOT in the archive is a line the
    // previous session missed → delivered now (recovered). A ring RESTART (new
    // game session) reuses indices from 1, so it bypasses the dedupe entirely.
    const dedupe = initial && !ringRestarted;
    let skipped = 0;
    // 本批次识别为祈愿行、并喂入 `wishTracker` 的条数（诊断日志用）。
    let wishCount = 0;
    // Feed in ring order (ascending `seq`) so the record log's archive order is
    // always chronological even if a batch ever arrives out of order.
    const ordered = [...entries].sort((a, b) => a.seq - b.seq);
    for (const a of ordered) {
      if (dedupe && this.recordLog.hasRingSeq(a.seq)) {
        skipped += 1;
        continue;
      }
      const raw = stripRichText(a.message);
      const parsed = parseAcquireMessage(a.message);
      if (!parsed.name) continue;
      this.recordLog.feed("acquire", ts, {
        ringSeq: a.seq,
        acquireRaw: raw,
        acquireName: parsed.name,
        acquireCount: parsed.count,
        acquireColor: parsed.color,
        acquireTime: a.time,
        // Initial-attach rows replay the whole session backlog at one ingest
        // moment — their wallTime is NOT the event moment, so the record
        // page's source fit must skip them (the `bulk` flag travels with the
        // persisted entry).
        bulk: initial,
      });
      // 祈愿行识别转发：与掉落同源（acquire 文本行），但走独立的识别/聚合器。
      // 只在**通过去重**的行上喂入（与 recordLog 完全同步），复用已解析的
      // `raw` / `parsed` 与同一 `ts` / `initial`；非祈愿行零副作用。
      // 见 `core/wishLine.ts`（识别多语言前缀 + 结构兜底 + 排除表）与
      // `core/wishTracker.ts`（双计数 offering/item + bulk 护栏）。
      const wishItem = parseWishLine(a.message);
      if (wishItem) {
        this.wishTracker.feed(wishItem, ts, {
          raw,
          gameTime: a.time,
          // initial 批量回灌 → bulk（计入累计/会话/历史，但不进滚动窗）。
          bulk: initial,
        });
        wishCount += 1;
      }
      dirty = true;
    }
    // Persist the reader's ring position so the next companion start resumes
    // incrementally instead of replaying the whole window. Advanced even when
    // every line of the batch was deduped — the position moved regardless.
    if (watermark != null) this.recordLogService.setAcquireWatermark(watermark);
    if (dirty) {
      log.info(
        `acquire ingest: ${entries.length} lines initial=${initial} ringRestarted=${ringRestarted} ` +
          `deduped=${skipped} first="${stripRichText(entries[0].message).slice(0, 40)}" @${entries[0].time} ` +
          `last="${stripRichText(entries[entries.length - 1].message).slice(0, 40)}" @${entries[entries.length - 1].time} ` +
          `-> recordLog total=${this.recordLog.getStats().total} wish=${wishCount}`,
      );
      this.recordLogService.schedulePersist();
      // 有祈愿行时才触发长期归档落盘（防抖），非祈愿批次零额外 IO。
      if (wishCount > 0) this.wishRecordService?.schedulePersist();
      // Push to the renderer right away. The acquire channel is independent of
      // the snapshot / read() frame, so when read() stalls (main menu / town,
      // stage null) the live-frame broadcast below never fires — without this
      // the UI would stay stale even though new "获得记录" lines arrived.
      // Throttled to LIVE_BROADCAST_INTERVAL_MS, shared with the live frame.
      const now = Date.now();
      if (now - this.lastLiveBroadcastMs >= LIVE_BROADCAST_INTERVAL_MS) {
        this.lastLiveBroadcastMs = now;
        this.pushStats();
      }
    }
  }

  private resolveBoxOpenEntry(entry: BoxOpenEntry): {
    boxKey: string;
    itemKey: number;
    name: string;
    grade: string | null;
  } {
    const boxKey = resolveBoxKey(entry.boxType, entry.level) ?? UNCLASSIFIED_BOX_KEY;

    const catalogId = catalogItemKeyFromSave(entry.itemKey);
    // Prefer lookup catalog for the base item (same source as renderer's
    // itemIndex); fall back to gamedata for items lookup hasn't indexed yet.
    const baseItem = this.lookupItems?.get(catalogId) ?? this.gameDataLookup?.get(catalogId);
    // Prefer the runtime grade (actual drop grade read from GetBoxLog) over
    // the catalog base grade. v1.00.28 can drop the same itemKey at different
    // grades, so the catalog grade is only a fallback when the runtime grade
    // offset is unavailable.
    const grade =
      entry.gradeType != null && entry.gradeType >= 0
        ? (GRADE_ORDER[entry.gradeType] ?? baseItem?.grade ?? null)
        : (baseItem?.grade ?? null);
    // Remap (baseId, grade) → catalog variant id. Without this, UI tooltips /
    // peek cards / entity panel would always render the COMMON variant when
    // the dropped grade differs (e.g. RARE Dimensional Boots showing as
    // COMMON Dimensional Boots).
    const variantId = this.resolveVariantId(catalogId, grade);
    const variantItem =
      variantId !== catalogId
        ? (this.lookupItems?.get(variantId) ?? this.gameDataLookup?.get(variantId))
        : baseItem;
    const item = variantItem ?? baseItem;
    const name = item ? gameItemName(item, this.localeCatalog) : `#${entry.itemKey}`;
    return { boxKey, itemKey: variantId, name, grade };
  }

  /**
   * Resolve a backfill candidate's display name to a catalog id + grade.
   *
   * Multi-variant gear (one id per grade) is disambiguated by the log line's
   * own `<color=#RRGGBB>` tint; when the tint is one this build has never
   * measured, the base (COMMON) variant is used rather than inventing a grade
   * — a wrong variant id would mis-file the item in a per-box breakdown.
   *
   * Returns `null` when the name is not in the catalog at all. That is the
   * filter that keeps heroes ("牧师"), stages and chest notices out of the
   * loot stats: they simply have no catalog row. Confirmed against a real
   * archive on 2026-09-16 — all 91 grant lines resolved, 0 dropped.
   */
  private resolveBackfillItem(
    name: string,
    color: string | null,
  ): { itemKey: number; grade: string | null } | null {
    const byGrade = this.lookupVariantIndex?.get(name);
    if (!byGrade || byGrade.size === 0) return null;
    if (byGrade.size === 1) {
      const [grade, id] = byGrade.entries().next().value!;
      return { itemKey: id, grade };
    }
    const grade = gradeFromAcquireColor(color);
    const id = grade != null ? byGrade.get(grade) : undefined;
    if (id != null) return { itemKey: id, grade };
    const fallback = byGrade.has("COMMON") ? "COMMON" : byGrade.keys().next().value!;
    return { itemKey: byGrade.get(fallback)!, grade: fallback };
  }

  /**
   * Repair under-counted box-open statistics from the "获得记录" ring.
   *
   * The box-open reader tails `GetItemWithBoxOpen`, a bucket the game writes
   * incrementally (list length first, each slot's `itemKey` last). Slots read
   * mid-write get parked and eventually force-skipped, so a large "open all"
   * burst, an offset drift or a worker restart can drop real opens — the Loot
   * tab then shows fewer items than the player actually received.
   *
   * The ring is an INDEPENDENT channel for the same events (one "获得了…" line
   * per granted item, read on its own ~10 ms path), so lines with no tracker
   * counterpart are exactly the opens that were lost. Those are recorded here.
   * See `core/boxOpenBackfill.ts` for the matching discipline.
   *
   * Deliberately does NOT touch `this.recordLog`: the record page stays a
   * faithful mirror of the game's own UI, so this is a statistics-side repair
   * only. It is also idempotent — once a candidate is recorded, the next pass
   * finds it via the normal name+time match and reports it as already tracked,
   * so no explicit "already backfilled" bookkeeping is needed.
   *
   * Public only so tests can drive it deterministically (real runs come from
   * the 1 Hz tick). `force` bypasses the throttle and is NOT part of the
   * production path.
   */
  runBoxOpenBackfill(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastBackfillMs < BACKFILL_INTERVAL_MS) return;
    this.lastBackfillMs = now;

    const trackerEntries = this.boxOpenTracker.fitHistory().map(toBackfillTrackerEntry);
    // Nothing recorded at all → there is no evidence to attribute against
    // (live memory is off, or no chest has been opened yet). Bailing out keeps
    // this pass from turning every stray stage reward into `unclassified`.
    if (trackerEntries.length === 0) return;

    // Judge only the span both channels can still speak about: old enough that
    // the box-open reader has certainly had its chance, and new enough that
    // the tracker's bounded history still holds the surrounding opens. Lines
    // outside it are unjudgeable, not missing — skipping them is what stops a
    // trimmed history from being misread as a run of lost opens.
    let oldestOpen = Number.POSITIVE_INFINITY;
    for (const e of trackerEntries) if (e.wallTime < oldestOpen) oldestOpen = e.wallTime;
    const newestAt = now / 1000 - BACKFILL_GRACE_SEC;
    const oldestAt = oldestOpen - BACKFILL_WINDOW_SEC;
    if (newestAt < oldestAt) return;

    const logLines = this.recordLog
      .getStats()
      .entries.filter(
        (e) => e.kind === "acquire" && e.wallTime <= newestAt && e.wallTime >= oldestAt,
      );
    if (logLines.length === 0) return;

    const chestEvents = this.chestDropTracker
      .fitHistory()
      .map((e) => ({ wallTime: e.wallTime, category: e.category }));

    // Stage-clear evidence for the level step. The history entries carry a
    // resolved stageKey (difficulty included) and cover ~200 clears, which
    // comfortably brackets the judged window. The ring's own clear lines are
    // read inside `backfillOpensFromLog` from `logLines`, so a clear that the
    // live reader has not surfaced yet is still usable there — the history is
    // only the preferred (difficulty-resolved) reference.
    const clearEvents = this.stageClearHistory.map((e) => ({
      wallTime: e.wallTime,
      stageKey: e.stageKey,
    }));

    const { candidates, scanned, alreadyTracked, excluded, unattributed } = backfillOpensFromLog(
      logLines,
      trackerEntries,
      chestEvents,
      this.boxRoutes ? { clears: clearEvents, boxRoutes: this.boxRoutes } : { clears: clearEvents },
    );

    let recorded = 0;
    let unresolved = 0;
    let levelled = 0;
    for (const c of candidates) {
      const resolved = this.resolveBackfillItem(c.itemName, c.color);
      if (!resolved) {
        unresolved += 1;
        continue;
      }
      // Record under the log's own name (not the catalog's) so the next pass's
      // name+time match is an exact string comparison and idempotency holds.
      this.boxOpenTracker.recordOpen(
        c.boxKey,
        resolved.itemKey,
        c.itemName,
        resolved.grade,
        c.count,
        c.wallTime,
      );
      if (levelFromBoxKey(c.boxKey) != null) levelled += 1;
      recorded += 1;
    }

    if (recorded > 0) {
      log.info(
        `box-open backfill: recorded ${recorded} missing opens ` +
          `(scanned=${scanned} tracked=${alreadyTracked} excluded=${excluded} ` +
          `unattributed=${unattributed} unresolved=${unresolved} levelled=${levelled})`,
      );
      this.sessionState?.flush(
        this.tracker,
        this.chestDropTracker,
        this.boxOpenTracker,
        this.lastSnap,
        this.config,
        this.wishTracker,
      );
      this.pushStats();
    } else if (unattributed > 0 || unresolved > 0) {
      // Nothing recovered but lines were left over — worth a line in the log
      // because a sudden jump in `unattributed` is the signal that the two
      // channels have drifted apart (clock skew, stalled reader), which is
      // exactly what this feature exists to make visible.
      log.info(
        `box-open backfill: nothing to record (scanned=${scanned} tracked=${alreadyTracked} ` +
          `excluded=${excluded} unattributed=${unattributed} unresolved=${unresolved})`,
      );
    }
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
      // 2. Lookup-price snapshot fallback. `prices` is USD (CI snapshot);
      //    prefer the local-currency polling fields when present, otherwise
      //    convert USD via the snapshot fx so the shown amount is the user's
      //    currency — not a raw USD value mislabeled as local (¥0.03 vs $0.03).
      if (this.lookupPriceSnapshot && this.gameDataLookup) {
        const catalogId = catalogItemKeyFromSave(itemKey);
        const item = this.gameDataLookup.get(catalogId);
        if (item) {
          const hash = marketHashName(item);
          if (hash) {
            const snap = this.lookupPriceSnapshot;
            // Local polling prices are fetched directly in the target currency
            // (no FX rounding). Buy-order price matches the main path's
            // "instant sell" semantics; listing price is the next best proxy.
            const local = snap.buyOrderLocal?.[hash] ?? snap.pricesLocal?.[hash] ?? null;
            if (local != null) {
              return { buyOrderValue: local * count, coveredCount: count };
            }
            const usd = snap.prices[hash] ?? null;
            if (usd != null) {
              const fx = this.currency !== "USD" ? (snap.fx[this.currency] ?? null) : 1;
              const unit = fx != null ? usd * fx : usd;
              return { buyOrderValue: unit * count, coveredCount: count };
            }
          }
        }
      }
      return null;
    };
  }

  /**
   * Accessory resolver for synthesis points. The box-open breakdown's itemKey is
   * a lookup-catalog variant id (see reResolveNames), so gearGroup can be read
   * straight off `lookupItems`. Null when the lookup catalog isn't loaded yet —
   * the tracker then scores every item at its general (non-accessory) points.
   */
  private buildBoxOpenAccessoryResolver(): BoxOpenAccessoryResolver {
    const items = this.lookupItems;
    if (!items) return null;
    return (itemKey: number) => items.get(itemKey)?.gearGroup === "ACCESSORY";
  }

  /** 由数据现算的特殊材料覆盖点（灵魂石/纪念硬币）；懒构建、缓存，目录刷新时失效。 */
  private materialPointsOverride: Record<number, number> | null = null;

  /**
   * 由 lookup_sources / offerings / lookup_items 现算灵魂石与纪念硬币的合成点覆盖表
   * （运行时数据驱动，不手写数值）。lookup 目录未加载或计算失败时返回 null（消费方
   * 回退到按品质估值）。
   */
  private getMaterialPointsOverride(): Record<number, number> | null {
    if (this.materialPointsOverride) return this.materialPointsOverride;
    const items = this.lookupItems;
    if (!items) return null;
    try {
      const sources = loadLookupSources();
      const offerings = loadOfferings();
      const boxes = sources.boxes as Record<
        number,
        { drops?: Array<{ itemKey: number; grade?: string | null; dropPct: number }> }
      >;
      this.materialPointsOverride = buildMaterialSynthesisPoints({
        itemByKey: (itemKey) => items.get(itemKey),
        boxDrops: (boxKey) => boxes[boxKey]?.drops,
        offerings,
      });
    } catch {
      this.materialPointsOverride = {};
    }
    return this.materialPointsOverride;
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
    this.wishTracker.reset();
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
      this.wishTracker,
    );
    this.pushStats();
  }

  /**
   * Reset session stats when switching between live-memory and save-only tracking.
   * Save-layer and runtime values use different baselines, so totals must not carry over.
   */
  onLiveMemoryToggled(): void {
    this.lastLiveFrame = null;
    this.lastLiveStage = null;
    this.waveSeeded = false;
    this.tracker.reset();
    this.chestDropTracker.reset();
    this.wishTracker.reset();
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
      this.wishTracker,
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

    // Account-wide Rune of Brevity reduction applied to the live stage-total.
    // Single choke point: both `buildStats` (reads lastLiveFrame) and the
    // wave-total run-end reset below read `snap`, so correcting here keeps the
    // two consumers consistent. Only the total is touched — stageWave/stageKey/
    // stageAlive/heroes/DPS are passed through untouched. The caller's frame
    // object is never mutated (we swap in a copy only when a reduction applies).
    if (this.runeWaveReduction > 0 && snap.stageWaveTotal != null && snap.stageWaveTotal > 0) {
      const raw = snap.stageWaveTotal;
      const effective = raw - this.runeWaveReduction;
      if (effective < 1) {
        this.warnClampedWaveTotal(snap.stageKey, raw, this.runeWaveReduction);
        snap = { ...snap, stageWaveTotal: 1 };
      } else {
        snap = { ...snap, stageWaveTotal: effective };
      }
    }

    // ── Live gold vs save divergence guard (v1.2.4 defense) ──
    // The save is the authoritative gold balance floor: the true balance is
    // always ≥ the most recent save read (gold only grows, or is spent). A live
    // read that comes back BELOW the last save gold means the v1.2.4 offsets
    // (which reuse the v1.2.2 CurrencyManager RVA) decoded a stale/old value —
    // a "rollback" showing the pre-update balance. A genuine spend self-corrects
    // from the save within ~5 s; a rollback persists, so after
    // GOLD_DIVERGE_SUSTAIN_SEC we flag `goldLiveSuspect` and substitute the save
    // value so no stale balance is ever displayed or fed to the tracker.
    const saveGold = this.lastSnap?.gold ?? null;
    const div = evaluateGoldDivergence(
      snap.gold,
      saveGold,
      this.goldDivergeSinceSec,
      snap.at / 1000,
      GOLD_DIVERGE_SUSTAIN_SEC,
    );
    if (div.substitute) {
      if (this.goldDivergeSinceSec == null) this.goldDivergeSinceSec = snap.at / 1000;
      this.tracker.goldLiveSuspect = div.suspect;
      snap = { ...snap, gold: saveGold! };
    } else {
      this.goldDivergeSinceSec = null;
      this.tracker.goldLiveSuspect = false;
    }

    this.lastLiveFrame = snap;

    const stage =
      snap.stageKey != null
        ? { stageKey: snap.stageKey, stageWave: snap.stageWave ?? 0 }
        : undefined;

    this.tracker.updateLive({ gold: snap.gold, heroes: snap.heroes }, snap.at / 1000, stage);

    // Prime the stage-event baseline on the first live frame after live memory
    // enables (or after a reset/clearSession). Without this, the first stage
    // clear's XP/gold gain can't be diffed (baseline is null → the whole
    // onLiveStageClear callback block is skipped), so the first clear is
    // silently dropped — the user sees nothing until the SECOND clear arrives.
    // Priming here (after tracker.updateLive, before stageClears handling)
    // means the baseline captures the pre-clear xp/gold, so the first clear's
    // diff is the real gain, not 0.
    if (!this.stageEventBaseline) {
      this.stageEventBaseline = {
        xp: this.tracker.cumulativeGained,
        gold: this.tracker.currentGold,
      };
    }

    // DPS / Damage / Mobs tracking from monster HP data (address-based, per tbh-meter)
    const timestamp = snap.at / 1000;

    // Detect stage (map) change for per-map reset (also handles first live frame).
    // Only stageKey change triggers beginMap() — wave advancement within the
    // same stage (1→2→3...) must NOT reset dpsTracker, otherwise _wavesCleared
    // resets to 0 every wave and currentWave gets stuck at 1 (the "wave counter
    // stuck" bug). Per-map counters (mapDamage/mapMobsKilled) accumulate across
    // wave advancements within a stage, matching "current map total" semantics.
    const stageKey = snap.stageKey;
    const stageWave = snap.stageWave ?? 0;
    const stageChanged =
      stageKey != null && (this.lastLiveStage == null || stageKey !== this.lastLiveStage.stageKey);
    if (stageChanged) {
      this.dpsTracker.beginMap();
      this.lastLiveStage = { stageKey, stageWave };
      // First live frame of a tracking session while a run is already in
      // progress (mid-run attach / app restart): without a seed the wave
      // detector counts from wave 1 and would show a wrong "1/N" until the
      // next stage change. The save snapshot's static wave is the best
      // available baseline — seed the counter with it ONCE per attach; later
      // stage changes must keep counting from 1 (the counter then tracked
      // the run start). See `DpsTracker.seedStageWave`.
      //
      // NOTE: the first live frame (~40 ms after attach) usually lands BEFORE
      // the first save read (5s watcher poll), so `lastSnap` is often still
      // null here. On that miss the seed is NOT dropped — `waveSeeded` stays
      // false and the retry runs in the save watcher's onSnapshot once the
      // first snapshot arrives.
      if (!this.waveSeeded) {
        const saveWave = this.lastSnap?.stageWave ?? 0;
        if (saveWave > 0) {
          this.dpsTracker.seedStageWave(saveWave);
          this.waveSeeded = true;
          log.info(
            `wave: seeded from save stage wave ${saveWave} (mid-run attach on first live frame)`,
          );
        } else {
          log.info("wave: no save stage wave yet — deferring seed to first save read");
        }
      }
    }

    // DPS / Damage / Mobs tracking from monster HP data (address-based, per tbh-meter).
    // `readRuntimeMonsterHp` returns null only when the MonsterSpawnManager
    // instance is unresolvable; otherwise it returns an array that may be empty
    // (read attempted but no monsters found — e.g. between waves) or non-empty.
    // Update DPS/HP/alive from the array whenever it is present (even empty: an
    // empty array correctly drives `alive → 0` between waves, and DpsTracker's
    // wave-clear detection still advances on the 0→N transition). Only when the
    // monster data source is entirely absent (null) do we fall back to the
    // StageManager alive count for wave detection.
    if (snap.monsterHp != null) {
      this.dpsTracker.update(snap.monsterHp, snap.deadMonsterCount, timestamp);
    } else if (snap.stageAlive != null) {
      // No monster-HP data source at all (e.g. offsets unresolvable): drive
      // wave-clear detection from StageManager's alive count so the wave
      // counter still advances live. DPS/damage stats stay 0 in that case.
      this.dpsTracker.updateAlive(snap.stageAlive, timestamp);
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
    // Feed map-farming time so chest per-hour rates use a map-type-aware
    // denominator (normal chests / normal-map time, plague chests / plague-map
    // time) instead of total wall-clock time — a session that mixes normal +
    // plague maps would otherwise dilute each chest type's rate with time the
    // other map type was being farmed. Use the same stageKey fallback as the
    // chest-drop category resolution below so a live frame whose stageKey is
    // momentarily null (between runs / reader) still accumulates under the last
    // known stage — otherwise the map-time bucket silently stalls.
    this.chestDropTracker.noteMapTime(snap.stageKey ?? this.lastLiveStage?.stageKey, chestAt);
    // Map-time diagnostic (throttled to 5s) — pin down why the chest-card map
    // annotation may stall: is noteMapTime seeing a null stageKey (no bucket),
    // and is the accumulated map-seconds actually growing? `getStats` reuses
    // cached breakdowns so 0.2 Hz is negligible.
    const nowDiag = Date.now();
    if (nowDiag - this.lastMapTimeDiagAt >= 5000) {
      this.lastMapTimeDiagAt = nowDiag;
      const d = this.chestDropTracker.getStats(this.tracker.elapsed);
      log.info(
        `map-time diag: rawStageKey=${snap.stageKey} feedStage=${snap.stageKey ?? this.lastLiveStage?.stageKey} ` +
          `normal=${Math.round(d.normalMapSeconds)}s plague=${Math.round(d.plagueMapSeconds)}s ` +
          `(reader ${d.readerRequired ? "live" : "save"})`,
      );
    }
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
    // Cross-tick settle diagnostic: a withheld boss entry that had been read as
    // a provisional category (e.g. "common") settled to its committed category
    // (e.g. "rare") a tick later. Logging it lets us confirm the 关卡/Lv80 boss
    // chest is being corrected live rather than misrecorded as common.
    if (snap.chestLogDebug?.settled) {
      const s = snap.chestLogDebug.settled;
      log.info(
        `chest settle: idx=${s.idx} ${s.from}→${s.to}` +
          (s.to === "rare" ? " (boss chest corrected)" : ""),
      );
    }
    const chestCategories = this.chestAggregator.feed(snap.chestDrops ?? [], chestAt);
    for (const baseCategory of chestCategories) {
      // The GetBox log only carries monsterType (common/rare/act); on a plague
      // (Contaminated) map that drop is a plague box. Upgrade the category by
      // the current map so the tracker buckets plague drops separately.
      const currentStageKey = snap.stageKey ?? this.lastLiveStage?.stageKey;
      const category: ChestDropCategory =
        baseCategory === "common" || baseCategory === "rare" || baseCategory === "act"
          ? resolveLiveDropCategory(currentStageKey, baseCategory)
          : baseCategory;
      if (this.chestDropTracker.recordLiveChestDrop(category, chestAt)) {
        if (baseCategory === "rare") {
          // A delayed flush may land on a tick whose snap has no stageKey
          // (e.g. reader between battles); fall back to the last live stage.
          const stageKey = snap.stageKey ?? this.lastLiveStage?.stageKey;
          if (stageKey != null && stageKey > 0) {
            this.onLiveStageBossDrop?.(stageKey);
          }
        }
      }
    }

    // Live chest slot counts (5 Hz) → forwarded to the onLiveChestSlots
    // callback. The appState wiring layer routes non-null values to
    // AutoClassifyService.reconcileWithChestSlots; null is observed by the
    // renderer to fall back to save-derived counts.
    this.onLiveChestSlots?.(snap.chestSlots);

    if (snap.stageClears && snap.stageClears.length > 0) {
      // A stage clear also resets the per-map damage/kill counters even if the
      // player stays on the same stageKey (e.g. replaying the same map).
      this.dpsTracker.beginMap();

      const fallbackStageKey =
        snap.stageKey ?? this.lastLiveStage?.stageKey ?? this.lastSnap?.stageKey ?? 0;
      if (fallbackStageKey <= 0) {
        log.warn(
          `clear skipped: ${snap.stageClears.length} entry(ies) but no fallback stageKey ` +
            `(snap=${snap.stageKey} lastLive=${this.lastLiveStage?.stageKey ?? "-"} ` +
            `lastSnap=${this.lastSnap?.stageKey ?? "-"})`,
        );
      }
      if (fallbackStageKey > 0) {
        // Use cumulativeGained (cap-filtered) instead of currentTotalXp (raw
        // hero exp sum). At max level, perHeroGain returns 0 so cumulativeGained
        // stays constant — no phantom XP attributed to stage clears.
        const xp = this.tracker.cumulativeGained;
        const gold = this.tracker.currentGold;
        // Drop invalid entries (act/stage unreadable — mid-write race /
        // corrupted memory). Attributing them to the live stageKey would
        // re-introduce the off-by-one bug: by the time we poll the next tick,
        // stageKey has already advanced past the cleared stage.
        const clears = snap.stageClears.filter((c) => c.valid);
        if (clears.length < snap.stageClears.length) {
          log.info(
            `clear invalid: dropped ${snap.stageClears.length - clears.length} of ` +
              `${snap.stageClears.length} stageClear entry(ies) (mid-write read)`,
          );
        }
        if (this.stageEventBaseline) {
          const totalXpGained = xp - this.stageEventBaseline.xp;
          const totalGoldGained = gold - this.stageEventBaseline.gold;
          const n = clears.length;
          // All clears observed in this frame share one wall-clock stamp —
          // they were read from the same memory tick.
          const clearWallTime = Date.now() / 1000;
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
            // Each clear is attributed to the stage carried by its own log
            // entry (act/stage), NOT the current live stageKey — by the time
            // we poll the next tick, stageKey has already advanced to the
            // next stage (e.g. clear of 3-1 arrived with stageKey=3-2).
            // Difficulty is recovered from the fallback stageKey.
            const clearedStageKey = resolveClearedStageKey(
              clears[i].act,
              clears[i].stage,
              fallbackStageKey,
            );
            this.onLiveStageClear?.(clearedStageKey, clears[i].clearTimeSec, xpGained, goldGained);
            // Feed the record page's source fit (bounded ring; cleared on reset).
            this.stageClearHistory.push({ wallTime: clearWallTime, stageKey: clearedStageKey });
          }
          if (this.stageClearHistory.length > STAGE_CLEAR_FIT_LIMIT) {
            this.stageClearHistory.splice(0, this.stageClearHistory.length - STAGE_CLEAR_FIT_LIMIT);
          }
        }
        this.stageEventBaseline = { xp, gold };
      }
    }

    // Stage-run failure detection (live only). No game log records a failure, so
    // we infer it with StageRunFailDetector from the deployed party
    // (StageManager.HeroList): heroes are on the field for an entire run and
    // only leave when the run ends — either cleared (a win) or lost. A run that
    // ends WITHOUT a stage-clear is a failure. Unlike an alive-monster count,
    // hero presence doesn't flicker between waves, so no "empty for how long"
    // threshold is needed and fast auto-retries are caught naturally.
    const hadClear = !!(snap.stageClears && snap.stageClears.some((c) => c.valid));
    // A clear definitively means the run WON, so it cancels any pending failure
    // judgement (defensive against clear/party ordering jitter). The detector
    // also refuses to fail a run that saw a clear inside its confirm window.
    if (hadClear) this.failDetector.reset();
    const heroesPresent = !!(snap.heroes && snap.heroes.length > 0);
    const feedStageKey = snap.stageKey ?? this.lastLiveStage?.stageKey ?? 0;
    // Debounce against dirty reads: a single tick whose hero list reads blank
    // (hero-exp rollback / offset bounce) must NOT be mistaken for a withdrawal,
    // otherwise it would zero the wave counter mid-run and record a phantom
    // failed stage. `update` only reports a run end once the party has been
    // absent for a sustained confirm window, so both `fail` (failure only) and
    // `runEnded` (clear or defeat) land on the confirmed tick together. Judge
    // the failure FIRST so its `failedWave` reads the pre-reset wave count, then
    // reset the wave counter so a fast auto-retry starts at wave 1 again.
    const judgement = this.failDetector.update(
      heroesPresent,
      hadClear,
      feedStageKey,
      this.dpsTracker.currentWave,
      snap.at,
    );
    if (judgement.fail) this.onLiveStageFail?.(judgement.fail.stageKey, judgement.fail.failedWave);
    if (judgement.runEnded) this.dpsTracker.onRunEnd();

    // Wave-total run-end catch. When the alive-monster count drops to 0 while
    // the wave counter has reached the stage's total wave count, the run's last
    // wave just cleared and a new run is starting. On fast auto-retry builds
    // (e.g. v1.01.05) the settlement gap can be < 2s — slipping past the
    // alive-based stage-end detector (STAGE_END_ALIVE_ZERO_SEC) — and heroes
    // stay present across runs (never triggering the onRunEnd hero-withdrawal
    // path above), so neither reset fires and `_wavesCleared` accumulates
    // forever (wave stuck at "31/31" or higher, capped at the stage total by
    // stats.ts). Reset here so the next run starts at wave 1 again.
    //
    // Runs AFTER failDetector so its failedWave still reads the pre-reset wave
    // count (a last-wave wipe without a clear must still judge as a failure).
    if (
      snap.stageAlive === 0 &&
      snap.stageWaveTotal != null &&
      snap.stageWaveTotal > 0 &&
      this.dpsTracker.currentWave >= snap.stageWaveTotal
    ) {
      this.dpsTracker.onRunEnd();
      log.info(
        `wave: alive=0 at stage total ${snap.stageWaveTotal} — run-end reset (wave counter → 0)`,
      );
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

    // The record log is fed ONLY by the independent acquire-ring channel
    // (`ingestAcquireBatch`), mirroring the game's own "获得记录" UI — no
    // bucket-derived drop/open/clear events are mixed in here.

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
        this.saveErrorCount = 0;
        this.saveStale = false;
        if (!this.warnedEmptySaveParse && snap.heroes.length === 0 && snap.gold === 0) {
          this.warnedEmptySaveParse = true;
          log.warn(
            "parsed save has zero heroes and zero gold — save format may have changed in a game update; stats may be wrong until the companion supports the new format",
          );
        }
        if (this.lastSnap) {
          const levelUps = detectHeroLevelUps(this.lastSnap.heroes, snap.heroes);
          if (levelUps.length > 0) {
            this.onHeroLevelUp?.(levelUps);
          }
        }
        this.lastSnap = snap;
        this.lastError = null;
        // Wave-seed retry (mid-run attach): the first live frame usually
        // arrives before the first save read, so `ingestLiveFrame` deferred the
        // seed. Once a snapshot is available and live tracking has started
        // (`lastLiveStage` set by the first live frame's beginMap), seed the
        // wave counter here — later polls skip this because `waveSeeded` is
        // already true. A stale wave in the snapshot (written a few seconds
        // ago) only costs the 1–2 waves cleared since attach, far better than
        // counting from wave 1 for the whole run.
        if (!this.waveSeeded && this.lastLiveStage != null && snap.stageWave > 0) {
          this.dpsTracker.seedStageWave(snap.stageWave);
          this.waveSeeded = true;
          log.info(
            `wave: seeded from save stage wave ${snap.stageWave} (first save read after attach)`,
          );
        }
        if (!this.restoreApplied && this.sessionState) {
          this.sessionState.tryRestoreOnSnapshot(
            this.tracker,
            this.chestDropTracker,
            this.boxOpenTracker,
            snap,
            this.wishTracker,
          );
          this.restoreApplied = true;
          // After restore, re-resolve every recorded box-open entry through
          // the catalog so (a) garbage itemKey strings recorded by the v1.00.28
          // String-pointer-bits-as-int bug are dropped, and (b) the save's
          // (baseId, grade) pair is remapped to the correct catalog variant id
          // — otherwise tooltips / peek cards / entity panel would render the
          // COMMON variant for high-rarity drops. No-op when gameDataLookup
          // isn't loaded yet; setGameDataLookup runs its own pass in that case.
          this.runReResolveNames();
        }
        this.tracker.update(snap);
        this.onStageKey?.(snap.stageKey);
        this.pushStats();
      },
      onError: (message) => {
        this.lastError = message;
        this.saveErrorCount++;
        if (this.saveErrorCount >= SAVE_STALE_ERROR_THRESHOLD) {
          this.saveStale = true;
        }
        this.pushStats();
      },
      onInventory: this.onInventory,
      parseInventorySnapshot: this.parseInventorySnapshot,
    });
  }
}
