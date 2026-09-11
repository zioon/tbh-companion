// Types shared across the Electron main, preload, and renderer processes.

import type { AppLanguage, ResolvedLanguage } from "./language";
import type { NotificationPrefs, NotificationSoundId } from "./notificationCatalog";

export type {
  NotificationKindId,
  NotificationKindPreference,
  NotificationPrefs,
  NotificationSoundId,
} from "./notificationCatalog";

/** Main → renderer: play a bundled notification WAV at 0–100% volume. */
export interface NotificationSoundPayload {
  soundId: NotificationSoundId;
  volumePercent: number;
}

export interface HeroSnapshot {
  key: string;
  level: number;
  exp: number;
  unlocked: boolean;
}

export interface SaveSnapshot {
  heroes: HeroSnapshot[];
  totalHeroExp: number;
  playTime: number;
  saveMtime: number; // epoch seconds (file mtime)
  stageKey: number;
  stageWave: number;
  maxStage: number;
  gold: number;
}

export interface HistoryEntry {
  wallTime: number; // epoch seconds when read
  delta: number; // XP gained on this read
  rate: number; // rolling XP/hour at this point
  totalXp: number;
  stageKey: number;
  stageWave: number;
  /** Localized stage name; populated by main via stageName(stageKey, catalog). Absent on cached entries from before this field was added. */
  stageName?: string;
}

export interface HeroRate {
  key: string;
  name: string;
  level: number;
  rate: number; // rolling XP/hour for this hero
  /** XP needed to reach the next level, or null if capped / unknown. */
  xpToNextLevel: number | null;
  /** Estimated seconds until next level-up at the current rate, or null if rate <= 0 or capped. */
  timeToLevelSec: number | null;
}

/** Box drop categories tracked by {@link ChestDropTracker}. Includes the
 * v1.02.00 plague (Contaminated) buckets, which only drop on plague maps. */
export type ChestDropCategory =
  | "common"
  | "rare"
  | "act"
  | "plagueCommon"
  | "plagueRare"
  | "plagueAct";

export interface ChestDropBreakdownRow {
  itemKey: number;
  name: string;
  category: ChestDropCategory;
  count: number;
}

export interface ChestDropHistoryEntry {
  wallTime: number;
  itemKey: number;
  name: string;
  category: ChestDropCategory;
}

export interface ChestDropStats {
  commonTotal: number;
  rareTotal: number;
  actTotal: number;
  plagueCommonTotal: number;
  plagueRareTotal: number;
  plagueActTotal: number;
  combinedTotal: number;
  commonPerHour: number;
  rarePerHour: number;
  actPerHour: number;
  plagueCommonPerHour: number;
  plagueRarePerHour: number;
  plagueActPerHour: number;
  /**
   * Rolling 1-hour drop rates: drops in the last `ROLLING_HOUR_SEC` seconds
   * (or since the first recent drop when the window is shorter), divided by
   * the window size in hours. Independent of `*PerHour` (which spans the full
   * session from `sessionDropStart`). Surfaced in the Live tab alongside the
   * session rate so short-term trends are visible during long sessions.
   */
  commonRecentPerHour: number;
  rareRecentPerHour: number;
  actRecentPerHour: number;
  plagueCommonRecentPerHour: number;
  plagueRareRecentPerHour: number;
  plagueActRecentPerHour: number;
  /**
   * Session-scoped drop counts. After `reset` these start at 0; after
   * `applySnapshot` (app restart) these include the restored history so
   * the displayed count matches the cumulative session totals. These share
   * the same time window as `*PerHour` (`sessionDropStart` → now), so
   * `commonSession` / `commonPerHour` are always consistent. Surfaced in
   * the Live tab so the displayed count and rate agree.
   */
  commonSession: number;
  rareSession: number;
  actSession: number;
  plagueCommonSession: number;
  plagueRareSession: number;
  plagueActSession: number;
  combinedSession: number;
  breakdown: ChestDropBreakdownRow[];
  history: ChestDropHistoryEntry[];
  /**
   * Epoch seconds of the most recent stage boss chest (category === "rare")
   * drop. Used by the mini overlay's boss-chest ring + "Box" countdown text,
   * which only track stage boss drops (common chests drop too frequently to
   * make a 7-min lap meaningful). null = no stage boss drops yet.
   */
  lastRareDropWallTime: number | null;
  /**
   * True when chest drop data requires the live reader (Player.log removed).
   * Renderer shows inactive/unavailable when the reader is off or detection is not wired yet.
   */
  readerRequired: boolean;
}

/** Serialized chest drop tracker for session_state.json restore. */
export interface ChestDropTrackerSnapshot {
  countsByKey: Record<string, number>;
  namesByKey: Record<string, string>;
  categoriesByKey: Record<string, ChestDropCategory>;
  history: ChestDropHistoryEntry[];
  /**
   * Epoch seconds anchoring the perHour rate window
   * (`min(trackingStartedAt, firstDropWallTime)` at the time the snapshot was
   * taken). Persisted so a restore keeps the true window start even when
   * `history` has been truncated at HISTORY_LIMIT — without it the restore
   * anchors to the oldest *kept* entry and inflates perHour (counts are not
   * truncated, so numerator/denominator time windows mismatch). Absent in
   * legacy snapshots; restore falls back to the oldest kept history entry.
   */
  sessionDropStart?: number | null;
}

// --- Box open loot tracking ---

/** A single recorded box open (history entry). */
export interface BoxOpenHistoryEntry {
  /** Epoch seconds. */
  wallTime: number;
  /** "common" | "rare" | "act" | "rare:3" | "common:5" ... */
  boxKey: string;
  /** Produced item id (resolved from BoxOpenLog.itemStringKey). */
  itemKey: number;
  itemName: string;
  grade: string | null;
  /** Typically 1; reserved for batch opens. */
  count: number;
}

/** Per-item aggregation row inside a boxKey bucket. */
export interface BoxOpenBreakdownRow {
  itemKey: number;
  name: string;
  grade: string | null;
  /** Total produced of this item under this boxKey. */
  count: number;
  /** Observed frequency = count / boxKey.totalItems. */
  dropPct: number;
  /** Steam buy-order unit price (instant-sell price); null = unavailable. */
  buyOrderUnit: number | null;
  /** count * buyOrderUnit. */
  buyOrderValue: number | null;
  /** Units actually covered by buyOrderValue, capped at count (may be less when the order book runs dry). */
  coveredCount: number | null;
  /**
   * buyOrderValue / count — the value contribution of each dropped unit of
   * this item (per-drop value). Differs from `buyOrderUnit` only when the
   * order book runs dry (coveredCount < count), in which case `buyOrderUnit`
   * is the realized instant-sell unit while this reflects the per-drop
   * metric. Box-level equivalent: {@link BoxOpenStats.perDropValue}.
   */
  perDropValue: number | null;
  /**
   * 合成点数（单件物品）：按品质给点（普通 1、罕见 9…，更高品质按合成成功率
   * 递归），饰品类 ×3。null = 品质未知，无法给点。
   * 见 `app/src/core/synthesisPoints.ts`。
   */
  synthesisPointsUnit: number | null;
  /** count * synthesisPointsUnit。null = 品质未知。 */
  synthesisPointsTotal: number | null;
}

/** Per-boxKey aggregation. */
export interface BoxOpenStats {
  boxKey: string;
  /** "Common chest" | "Stage boss chest Lv3" | ... */
  label: string;
  /** Tracker-side category. See {@link BoxCategory} / {@link toLookupCategory}. */
  category: BoxCategory;
  /** null = category-only fallback (BoxOpenLog lacks level). */
  level: number | null;
  totalItems: number;
  /** Sum of buyOrderValue across items; null when no items are priced. */
  totalBuyOrderValue: number | null;
  /**
   * totalBuyOrderValue / totalItems — the average realized value of opening
   * this chest once (value per drop). Time-independent: a per-drop metric
   * that reflects the chest's loot value rather than farming rate.
   */
  perDropValue: number | null;
  breakdown: BoxOpenBreakdownRow[];
  /**
   * Σ synthesisPointsTotal across items；null = 无任何物品有点数。
   * 宝箱内容物的合成点数总计（价值评价的一种度量）。
   */
  totalSynthesisPoints: number | null;
  /** Most recent N (visible window). */
  history: BoxOpenHistoryEntry[];
  /** Epoch seconds of the most recent open; null = no opens yet. */
  lastOpenWallTime: number | null;
  /**
   * Epoch seconds marking the start of the current accumulation window for
   * this boxKey — i.e. when the player last reset this chest's stats, or
   * (if never reset) the wall time of the first recorded drop. Surfaced to
   * the Loot UI as the "tracking since" timestamp. Null only when the
   * boxKey has counts but no surviving history and no recorded reset anchor
   * (corrupt snapshot).
   */
  trackingSinceWallTime: number | null;
}

/** Serialized box open tracker for session_state.json restore. */
export interface BoxOpenTrackerSnapshot {
  /**
   * boxKey -> compositeKey -> count. Composite key format is
   * `"${itemKey}|${grade ?? ""}"` (see `compositeKey` in boxOpenTracker.ts).
   * Legacy snapshots may use bare `"${itemKey}"` keys — applySnapshot migrates
   * them using gradesByKey.
   */
  countsByKey: Record<string, Record<string, number>>;
  /** compositeKey -> name (shared across all boxKeys). */
  namesByKey: Record<string, string>;
  /** compositeKey -> grade (shared across all boxKeys). */
  gradesByKey: Record<string, string | null>;
  history: BoxOpenHistoryEntry[];
  /**
   * boxKey -> epoch seconds of the current accumulation window's start
   * (last reset time, or first recorded drop when never reset). Optional:
   * absent on legacy snapshots, in which case `applySnapshot` derives it
   * from the earliest surviving history entry per boxKey (falling back to
   * `Date.now()/1000` when that boxKey has no history at all).
   */
  trackingSinceByKey?: Record<string, number>;
}

/** main → renderer: prompt the user to pick a category for unclassified loot. */
export interface ClassifyPromptPayload {
  promptId: number;
  itemKeys: number[];
  /** Suggested category when the queue has a hint; undefined otherwise. */
  defaultCategory?: BoxCategory;
}

/** renderer → main: user's category choice for a pending prompt. */
export interface ClassifyPromptResolvePayload {
  promptId: number;
  category: BoxCategory;
  itemKeys: number[];
}

/** main → renderer: snapshot of the auto-classify queue, polled at 1 Hz by the renderer. */
export interface AutoClassifyStatePayload {
  enabled: boolean;
  totalQueued: number;
  byCategory: ReadonlyArray<{
    category: BoxCategory;
    count: number;
    /**
     * Remaining ms until the head (soonest-opening) item of this category
     * auto-opens (`autoOpenAtMs - now`, clamped to >= 0). `null` when the
     * category has no queued items.
     */
    nextAutoOpenInMs: number | null;
    /**
     * Remaining ms until the tail (latest-opening) item of this category
     * auto-opens. Under the slot-parallel model every queued chest has its
     * own independent timer, so this is the time until all queued chests of
     * this category have auto-opened (i.e. the queue clears). `null` when
     * the category has no queued items.
     */
    lastAutoOpenInMs: number | null;
  }>;
  /**
   * Per-item view of the queue, oldest-first. Each entry corresponds to one
   * dropped chest awaiting its open event. The renderer uses this for the
   * detailed queue list; `byCategory` remains for the compact summary.
   */
  items: ReadonlyArray<AutoClassifyQueueItem>;
  /**
   * Real-time per-category chest slot counts. Initialized from save data on
   * every save parse (recalibration), then adjusted between saves by chest
   * drops (+1), chest opens via unclassified burst (-1), and chest auto-open
   * timer elapse (-1). Null before the first save parse completes.
   *
   * The renderer uses this for the "current/capacity" display — it gives
   * second-level responsiveness even on game versions where live memory
   * reading of `PlayerSaveData.BoxData` is unavailable (e.g. v1.00.28).
   * `capacity` always comes from the save path (`ChestState`).
   */
  liveSlots: {
    common: number;
    rare: number;
    act: number;
    plagueCommon: number;
    plagueRare: number;
    plagueAct: number;
  } | null;
  /**
   * Whether auto-open timers are currently paused because the player's
   * inventory (item bag) is full. The game pauses all chest auto-open
   * timers when the inventory is full (it cannot drop loot into a full
   * bag), and resumes them when the player clears space. While paused,
   * `nextAutoOpenInMs` / `lastAutoOpenInMs` freeze at their values as of
   * the pause moment (they do not count down), and `tick` skips slot
   * decrement and prune. On resume, queued items' `autoOpenAtMs` /
   * `expiresAtMs` are shifted forward by the paused duration.
   */
  paused: boolean;
  /**
   * Number of pending (unclassified) open bursts awaiting classification
   * via save reconcile. These are bursts that `processEvent` couldn't
   * match to any queued slot within the grace window. The next
   * `reconcileWithChestSlots` will attempt to classify them by comparing
   * save slot counts against live counts. The renderer can show this as a
   * "pending classification" indicator.
   */
  pendingBurstsCount: number;
}

/** One queued chest drop in {@link AutoClassifyStatePayload.items}. */
export interface AutoClassifyQueueItem {
  boxKey: string;
  category: BoxCategory;
  /** Wall-clock ms when the chest dropped (matches `QueueItem.droppedAtMs`). */
  droppedAtMs: number;
  stageKey: number;
  /**
   * Remaining ms until this chest's auto-open fires
   * (`autoOpenAtMs - now`, clamped to >= 0). Under the slot-parallel model
   * every queued chest has a concrete auto-open time computed at drop
   * time, so this is always a number — manual opens of other chests do
   * not move this timestamp.
   */
  autoOpenInMs: number;
  /** Remaining ms until this queue entry expires and is pruned (clamped to >= 0). */
  expiresInMs: number;
}

/** Raw entry from the live-memory BoxOpenLog tail. */
export interface BoxOpenEntry {
  /** Produced item id (resolved from itemStringKey). */
  itemKey: number;
  /**
   * ItemGradeType enum value (0=COMMON, 1=UNCOMMON, 2=RARE, ...; matches
   * GRADE_ORDER in core/grades.ts). Read from BoxOpenLog.itemGradeType
   * (pre-1.00.28) or GradeSO.eGRADE (v1.00.28+). Undefined when neither
   * offset is derived — the tracker falls back to the catalog grade.
   */
  gradeType?: number;
  /** 0=common, 1=rare(stage boss), 2=act; undefined when offset unavailable. */
  boxType?: number;
  /** Box level; undefined when offset unavailable (category-only fallback). */
  level?: number;
}

// Live payload pushed from main to the renderer.
export interface Stats {
  connected: boolean;
  status: string;
  rollingRate: number; // XP/hour
  sessionRate: number; // XP/hour
  goldSessionRate: number; // gold/hour (session average)
  goldRate: number; // gold/hour (earned)
  cumulativeGained: number; // XP gained this session
  goldGained: number; // gold earned this session
  elapsed: number; // seconds since session start
  secondsSinceGain: number | null;
  secondsSinceRead: number | null;
  stageKey: number;
  stageName: string; // localized stage name (e.g. "Pasture"), computed by main via stageName(stageKey, catalog)
  stageWave: number;
  /** Total waves in the current stage (from live memory, 0 if unavailable). */
  stageWaveTotal: number;
  heroes: HeroRate[];
  history: HistoryEntry[];
  chestDrops: ChestDropStats;
  /** Box-opening outcomes aggregated by box type/level. Empty when no opens recorded. */
  boxOpens: BoxOpenStats[];
  /**
   * Diagnostics for the loot subsystem when `boxOpens` is empty. Non-empty when
   * the live reader cannot read the BoxOpenLog (offsets not yet derived for
   * this game version). Lets the UI distinguish "no boxes opened" from
   * "loot tracking unavailable". Undefined when loot tracking is working.
   */
  lootStatus?: string;
  /** Damage per second (5-second rolling window). Only meaningful when live memory is active. */
  dps: number;
  /** Damage dealt on the current map. Resets when stage changes. Only meaningful when live memory is active. */
  mapDamage: number;
  /** Mobs killed on the current map. Resets when stage changes. Only meaningful when live memory is active. */
  mapMobsKilled: number;
  /** Total damage dealt this session (cumulative, never resets). Only meaningful when live memory is active. */
  sessionDamage: number;
  /** Total mobs killed this session (cumulative, never resets). Only meaningful when live memory is active. */
  sessionMobsKilled: number;
  /** Number of currently alive monsters (from the last live memory tick). */
  aliveMonsters: number;
  /** Sum of current HP of all alive monsters (from the last tick). */
  hpSum: number;
  /** Sum of max HP of all alive monsters (from the last tick). */
  hpMaxSum: number;
}

/** Serialized XP tracker internals for session_state.json restore. */
export interface TrackerRateMeterSnapshot {
  window: number;
  gained: number;
  rolling: number;
  samples: Array<[number, number]>;
}

/** Per-hero state including level and within-level exp. */
export interface PrevHeroState {
  level: number;
  exp: number;
}

export interface TrackerSnapshot {
  sessionStart: number;
  cumulativeGained: number;
  currentTotalXp: number;
  currentGold: number;
  goldGained: number;
  heroes: HeroSnapshot[];
  history: HistoryEntry[];
  lastGainMtime: number | null;
  /** @deprecated Use prevHeroState instead. Old format: heroKey → exp only. */
  prevHero: Record<string, number>;
  heroMeters: Record<string, TrackerRateMeterSnapshot>;
  samples: Array<[number, number]>;
  initialized: boolean;
  firstMtime: number | null;
  lastChangeMtime: number | null;
  rollingRateValue: number;
  sessionRateValue: number;
  prevGold: number | null;
  goldSamples: Array<[number, number]>;
  goldFirstMtime: number | null;
  goldLastChangeMtime: number | null;
  goldRollingRateValue: number;
  goldSessionRateValue: number;
  /**
   * Per-hero previous state (level + exp) for accurate level-up bridging.
   * Optional: absent means old format (use prevHero as fallback, level unknown → use 0).
   */
  prevHeroState?: Record<string, PrevHeroState>;
}

export interface SessionUiSnapshot {
  miniOverlayOpen: boolean;
  boxTrackerOpen: boolean;
}

/** On-disk session_state.json shape (tracker + overlay flags). */
export interface PersistedSessionState {
  version: 1;
  savePath: string;
  lastSaveMtime: number;
  rollingWindowMinutes: number;
  /** Whether the live-memory reader was active when this session was saved. */
  liveMemoryEnabled?: boolean;
  tracker: TrackerSnapshot;
  chestDropTracker?: ChestDropTrackerSnapshot;
  /** Box-open tracker state (loot tab). */
  boxOpenTracker?: BoxOpenTrackerSnapshot;
  ui: SessionUiSnapshot;
}

// --- Inventory ---

// Raw owned-item instance from itemSaveDatas (the master list of all owned
// items: inventory + stash + trading + equipped).
export type ItemLocation = "inventory" | "stash" | "trading" | "equipped" | "unknown";

export interface InventoryItemInstance {
  itemKey: number;
  isChaotic: boolean;
  inUse: boolean;
  location: ItemLocation;
}

export interface ChestHolding {
  type: number;
  quantity: number;
  /**
   * v1.2.2+：存档移除了 BoxData（BoxType 两列 int），未开箱子以普通物品形式
   * 存在于 itemSaveDatas（UniqueId ∈ BoxBucketGetBoxList）。此时 `type` 携带
   * 的是 gamedata 物品 id（如 910901），分类/标签由解析侧按物品名前缀给出，
   * resolve 层优先采用这两个字段而不再查 boxTypeCatalog。
   */
  category?: BoxCategory;
  label?: string;
}

export interface InventorySnapshot {
  items: InventoryItemInstance[];
  chests: ChestHolding[];
  saveMtime: number;
  /** Stack counts from aggregateSaveDatas when decoded (materials only). */
  materialStacks?: Map<number, number>;
  /** Count of inventorySaveDatas slots with IsUnlock true. */
  inventoryCapacity: number;
  /** Count of unlocked slots holding an item (ItemUniqueId !== 0). */
  inventoryUsed: number;
  /**
   * Parse-time only: catalog ids with pipeline (…900) rows and no assignable
   * itemSaveDatas instances. Used by resolve; not sent over IPC (renderer gets
   * ResolvedInventory).
   */
  marketPipelineOnlyCatalogKeys?: ReadonlySet<number>;
}

// Owned items grouped by ItemKey and resolved against the game catalog.
export interface BuyOrderLevel {
  price: number;
  quantity: number;
}

export interface ResolvedInventoryRow {
  itemKey: number;
  name: string; // "Unknown #<key>" when not in the catalog
  grade: string;
  type: string; // GEAR | MATERIAL | ...
  level: number | null;
  marketTradable: boolean;
  marketHashName: string | null;
  count: number;
  inUseCount: number;
  chaoticCount: number;
  known: boolean;
  priceRaw: string | null;
  rawMedian: string | null;
  rawLowest: string | null;
  unitPrice: number | null;
  priceSource: "median" | "lowest" | null;
  /** True when Steam was queried for this hash (even if no listing/sale price came back). */
  priceChecked: boolean;
  value: number | null;
  buyOrderRaw: string | null;
  buyOrderUnit: number | null;
  /** Units on the book at the highest buy price (from histogram). */
  buyOrderQuantity: number | null;
  /** Full buy-side order book, sorted descending by price. */
  buyOrderLevels: BuyOrderLevel[] | null;
  buyOrderValue: number | null;
  /** Units actually covered by buyOrderValue, capped at count (may be less than count if the book runs dry). */
  buyOrderCoveredCount: number | null;
  /** True when buy-order histogram was queried for this hash. */
  buyOrderChecked: boolean;
  inventoryCount: number;
  stashCount: number;
  tradingCount: number;
}

export interface InventoryPriceInfo {
  median: number | null;
  lowest: number | null;
  rawMedian: string | null;
  rawLowest: string | null;
  buyOrder: number | null;
  rawBuyOrder: string | null;
  /** Units available at the highest buy price (histogram depth). */
  buyOrderQuantity?: number | null;
  /** Full buy-side order book, sorted descending by price. */
  buyOrderLevels?: BuyOrderLevel[] | null;
  /** True after a successful itemordershistogram response (including zero buy orders). */
  buyOrderFetched?: boolean;
}

export interface InventoryComposition {
  total: number;
  byGrade: Record<string, number>;
  byType: Record<string, number>;
  tradableCount: number;
  unknownCount: number;
  chaoticCount: number;
  inUseCount: number;
  priceableCount: number;
  valuedTotal: number;
  feeTotal: number;
  netAfterFeesTotal: number;
  buyOrderValuedTotal: number;
  /** Instant-sell total net of Steam fees. */
  buyOrderNetTotal: number;
  /** Distinct priced rows with a non-null buy order unit. */
  buyOrderPricedRows: number;
  currency: string | null;
}

export interface ResolvedInventory {
  rows: ResolvedInventoryRow[];
  composition: InventoryComposition;
  chests: ChestHolding[];
  saveMtime: number;
  gameDataLoaded: boolean;
  currency: string | null;
  inventoryCapacity: number;
  inventoryUsed: number;
}

export interface PriceStatus {
  currency: string;
  /** Cached entries for owned market targets (after prune). */
  count: number;
  /** Unique market hash names for current inventory. */
  ownedTargets: number;
  /** Owned targets with cache younger than 24h. */
  freshCount: number;
  /** Owned targets needing a fetch. */
  staleCount: number;
  fetchedUtc: string | null;
  running: boolean;
}

export type PriceRefreshSummary = Pick<
  PriceRefreshResult,
  "priced" | "skipped" | "failed" | "stopped" | "noop" | "queued"
>;

export interface PriceProgress {
  done: number;
  total: number;
  current: string;
  priced: number;
  failed: number;
  /** Main sends this when a background price run ends or is cancelled. */
  finished?: boolean;
  result?: PriceRefreshSummary;
}

export interface PriceRefreshResult {
  ok: boolean;
  priced: number;
  skipped: number;
  failed: number;
  stopped: "completed" | "cancelled" | "rate-limited";
  currency: string;
  error?: string;
  /** All owned targets already fresh — no fetch started. */
  noop?: boolean;
  /** Refresh deferred until the current run finishes. */
  queued?: boolean;
}

/**
 * Shared Lookup price snapshot: a single file built server-side (GitHub Action)
 * holding USD listed prices for every priceable catalog item plus an FX table,
 * so the app prices the whole Lookup catalog from one download with no Steam
 * calls. Distinct from the owned-inventory price cache (`prices.{CUR}.json`).
 */
export interface LookupPriceSnapshot {
  schemaVersion: 1;
  /** ISO timestamp the snapshot was generated; drives "updated {age} ago". */
  generatedUtc: string;
  baseCurrency: "USD";
  /** market_hash_name -> lowest active listing in USD; null = no active listing. */
  prices: Record<string, number | null>;
  /**
   * market_hash_name -> 本地 polling 抓取的目标货币价格（非 USD）。
   * 由 LookupPricePollingService 写入：polling 时直接用用户当前货币调
   * Steam priceoverview，避免 FX 圆整误差。`localCurrency` 标明货币。
   * CI 快照不含此字段；polling merge 时追加。null = 本地确认无挂单。
   */
  pricesLocal?: Record<string, number | null>;
  /**
   * market_hash_name -> 本地 polling 抓取的「最近成交价中位数」（目标货币）。
   * 与 `pricesLocal` 同源：来自 priceoverview 的 `median_price` 字段。
   * null = 接口返回了但无成交记录；缺失 = polling 未抓取。
   */
  medianLocal?: Record<string, number | null>;
  /**
   * market_hash_name -> 本地 polling 抓取的「最高收购价」（目标货币）。
   * 来自 Steam `itemordershistogram` 的 `highest_buy_order`，需要先解析
   * `item_nameid`。null = 接口返回了但无收购单；缺失 = polling 未抓取
   * 或 nameid 解析失败。
   */
  buyOrderLocal?: Record<string, number | null>;
  /** `pricesLocal` 的货币代码（如 "BRL"/"CNY"/"USD"）。无 pricesLocal 时为 undefined。 */
  localCurrency?: string;
  /** market_hash_name -> ISO time that price was last fetched; drives rolling refresh. */
  fetchedUtc?: Record<string, string>;
  /** ISO currency code -> units per 1 USD (e.g. BRL: 5.1). */
  fx: Record<string, number>;
}

/** Work area snapshot used to match a monitor across restarts. */
export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Saved window position relative to a display work area (not global desktop coords). */
export interface WindowLayoutEntry {
  x: number;
  y: number;
  width?: number;
  height?: number;
  displayId: number;
  displayWorkArea: DisplayWorkArea;
}

export interface WindowLayoutPrefs {
  main?: WindowLayoutEntry;
  overlay?: Omit<WindowLayoutEntry, "width" | "height">;
  boxTracker?: WindowLayoutEntry;
}

/**
 * Per-window "keep on top" preferences. Each of the three windows
 * (main, mini overlay, stage-boss chest tracker) can be pinned independently.
 * Migrated from the legacy single `startTopmost: boolean` field; when loading
 * an old config the legacy value seeds all three windows.
 */
export interface WindowTopmostPrefs {
  main: boolean;
  overlay: boolean;
  boxTracker: boolean;
}

export type InventoryColumnId =
  | "grade"
  | "level"
  | "type"
  | "location"
  | "inUse"
  | "marketPrice"
  | "listValue"
  | "instantSell"
  | "instantTotal"
  | "instantSellAverage"
  | "synthesisPoints";

export interface InventoryTablePrefs {
  visibleColumns: InventoryColumnId[];
}

export interface ChestAutoOpenPrefs {
  common: boolean;
  stageBoss: boolean;
}

/**
 * Loot page chest-card border-ring lap duration (seconds) per tracked
 * category. `common` is the common-chest drop cooldown (default 5 min),
 * `stage` is the stage-boss chest cooldown (default 7 min, matches the mini
 * overlay's boss-chest ring). Keys intentionally use the short category
 * names so the renderer can index by `BoxCategory` (`"common"` / `"rare"`).
 */
export interface LootRingSeconds {
  common: number;
  stage: number;
  /** v1.02.00 Plague (Contaminated) chests — independent ring laps. */
  plagueCommon: number;
  plagueRare: number;
  plagueAct: number;
}

/** Opt-in live game-memory reader preferences (off by default). */
export interface LiveMemoryPrefs {
  /** Reader enabled — when false no reader process runs and the app is save-only. */
  enabled: boolean;
  /** The one-time read-only consent dialog has been accepted. Gates first enable. */
  consentAccepted: boolean;
}

/**
 * 本地轮询 Steam Market 高价值/重点物品价格的偏好设置。
 *
 * 与图鉴共享快照（CI 每 6h 抓取一次）互补：开启后客户端在本地周期性
 * 调用 Steam priceoverview 接口刷新「已拥有且估值达阈值」或「用户收藏」
 * 的物品价格，并 merge 进内存中的 {@link LookupPriceSnapshot}。默认关闭，
 * 避免给不需要的用户增加 API 配额压力。
 */
export interface LookupPricePollingPrefs {
  /** 是否启用本地轮询。默认 false。 */
  enabled: boolean;
  /** 轮询间隔（分钟）。默认 10，范围 [5, 60]。 */
  intervalMinutes: number;
  /** 「高价值」USD 价格阈值。默认 1.0。已拥有物品的快照价格 ≥ 此值才入选。 */
  thresholdUsd: number;
  /** 用户手动收藏的 market_hash_name 列表，无论价格/是否拥有都会被轮询。默认空。 */
  watchedHashes: string[];
}

/**
 * 单轮轮询的结果摘要。`aborted=true` 表示因连续 429 中止；`targets=0` 配
 * `aborted=false` 表示无目标（早退）。
 */
export interface PollingCycleResult {
  targets: number;
  priced: number;
  rateLimited: number;
  failed: number;
  aborted: boolean;
}

/**
 * 「近期市场交易额」的一次采样快照。
 *
 * 成交额 = Σ(物品成交量 × 成交价)。数据来源是本地轮询（LookupPricePolling）
 * 每次 priceoverview 返回的 24h 成交量 `volume` 与成交价中位数 `median`，
 * 因此只覆盖「被轮询到的高价值 / 收藏物品」这一子集，是相对的市场活跃度
 * 指标而非全市场总盘子。按类别拆分为装备组（WEAPON/ARMOR/ACCESSORY…）与
 * 材料类型（CRAFTING/DECORATION…）。
 */
export interface MarketVolumeSample {
  /** 采样时间（ISO UTC）。 */
  timestamp: string;
  /** 本采样覆盖的、有成交量的 hash 数量。 */
  items: number;
  /** 总交易额（目标货币）。 */
  total: number;
  /** 各类别交易额：类别 key -> 金额（目标货币）。 */
  byCategory: Record<string, number>;
  /** 计算交易额所用的货币代码。 */
  currency: string;
}

/** 按小时聚合后的历史成交额走势点（基于 Steam pricehistory 的真实小时增量）。 */
export interface MarketVolumeHourPoint {
  /** 小时桶起始时间（ISO UTC，整点）。 */
  hour: string;
  /** 该小时总成交额（目标货币）。 */
  total: number;
  /** 该小时各类别成交额：类别 key -> 金额（目标货币）。缺失时回退为 {}。 */
  byCategory?: Record<string, number>;
}

/** 单个物品的市场交易额（交易页卡片）。 */
export interface MarketVolumeItem {
  /** market_hash_name。 */
  hash: string;
  /** 展示名（本地化；未匹配到图鉴时用 hash）。 */
  name: string;
  /** 交易额分类 key（WEAPON/ARMOR/ACCESSORY/MATERIAL/COIN/OTHER）。 */
  category: string;
  /**
   * 物品品质等级（COMMON..COSMIC）。用于卡片颜色染色，跨所有物品保持一致。
   * 未匹配到图鉴时为 undefined。
   */
  grade?: string;
  /** 图鉴 itemKey（catalog id）。未匹配到图鉴时为 undefined。用于计算合成点数。 */
  itemKey?: number;
  /** 装备部位组（WEAPON/ARMOR/ACCESSORY…）。未匹配到图鉴时为 undefined。用于判饰品合成倍数。 */
  gearGroup?: string | null;
  /** 物品等级（1..LEVEL_MAX）。材料/未匹配到图鉴时为 null。用于等级筛选。 */
  level: number | null;
  /** 装备部位（仅 GEAR 物品有值，如 MAIN_WEAPON/HELMET…）。材料或未匹配时为 null。 */
  gearType: string | null;
  /** 材料种类（仅 MATERIAL 物品有值，如 OFFERING/CRAFTING…）。装备或未匹配时为 null。 */
  materialType: string | null;
  /** 总交易额（目标货币）。 */
  total: number;
  /**
   * 按小时的历史走势（升序，最新在最后），用于卡片小图。
   * 每个点含该小时的均价、成交量与成交额；无历史走势时为空数组。
   */
  points: { hour: string; price: number; volume: number; total: number }[];
  /**
   * 数据口径：`history`=pricehistory 真实小时增量（可按区间求和）；
   * `live`=轮询活跃度采样（24h 滚动累计，不可求和，取窗口内最新值）。
   * 缺省视为 `history`。
   */
  kind?: "history" | "live";
}

/** 交易页物品卡片数据（按总交易额降序）。 */
export interface MarketVolumeItemStats {
  items: MarketVolumeItem[];
  currency: string;
}

/** 交易页「刷新历史价格」的实时进度（主进程 push 给 renderer）。 */
export interface MarketVolumeRefreshProgress {
  /** 当前是否正在刷新。 */
  running: boolean;
  /** 待刷新的目标物品总数。 */
  total: number;
  /** 已处理的物品数。 */
  done: number;
  /** 当前正在拉取的 market_hash_name；无则 null。 */
  currentHash: string | null;
  /** 单个 hash 刷新完成后的最新卡片（仅当确实拉到数据时携带，供实时更新）。 */
  updatedItem?: MarketVolumeItem;
  /** 本次刷新开始时的待刷新占位卡片（自动/手动刷新共用，供前端展示亮环）。 */
  pending?: MarketVolumeItem[];
  /**
   * 本次刷新因 Steam Cookie 失效（pricehistory 返回 400）被提前终止时为 true。
   * 前端应收起刷新状态并提示用户前往设置更新 Cookie。
   */
  cookieExpired?: boolean;
}

/** 交易页「刷新历史价格」的返回：当前统计 + 待刷新的目标卡片（提前展示）。 */
export interface MarketVolumeRefreshResult {
  stats: MarketVolumeItemStats;
  /** 待刷新目标物品的占位卡片（刷新进行中、尚未有历史数据时展示）。 */
  pending: MarketVolumeItem[];
}

/** 交易页「导出历史数据」的结果。 */
export interface ExportMarketVolumeResult {
  /** 导出成功并写入文件。 */
  ok?: boolean;
  /** 用户取消对话框（无 ok 字段）。 */
  canceled?: boolean;
  /** 导出写入的文件路径（仅 ok=true 时）。 */
  path?: string;
  /** 失败原因（仅 ok=false 时）。 */
  reason?: string;
}

/** 交易页「导入历史数据」的结果。 */
export interface ImportMarketVolumeResult {
  /** 导入成功并已整体替换（无 ok 字段时为用户取消）。 */
  ok?: boolean;
  /** 用户取消对话框。 */
  canceled?: boolean;
  /** 导入后历史统计覆盖的物品种数（仅 ok=true 时）。 */
  itemCount?: number;
  /**
   * 备份货币与当前显示货币不一致但已按确认的汇率换算后导入（仅 ok=true 时）。
   * UI 可据此提示「已换算到当前币种」。
   */
  converted?: boolean;
  /** 失败原因（仅 ok=false 时，如 "invalid_backup"、"currency_mismatch"）。 */
  reason?: string;
}

/** 市场交易额统计（供 Market 页展示）。 */
export interface MarketVolumeStats {
  /** 最近一次采样的交易额统计（轮询 24h 滚动快照）；尚未采样时为 null。 */
  latest: MarketVolumeSample | null;
  /** 按小时聚合的总交易额走势（升序，最新在最后）。基于 pricehistory 真实小时数据。 */
  hourly: MarketVolumeHourPoint[];
  /** 历史统计覆盖的、有有效交易数据的物品种数。 */
  itemCount: number;
  /** 各分类覆盖的物品种数：类别 key -> 数量。 */
  itemCountsByCategory: Record<string, number>;
  /** 当前货币代码。 */
  currency: string;
}

/**
 * 主进程推给 renderer 的 polling 状态快照。`running=true` 表示当前正在跑
 * 一轮；`progress` 反映本轮实时进度。`lastCycleResult`/`lastCycleAtMs`
 * 来自上一轮结束时的快照，可能为 null（启动后从未跑过）。
 */
export interface LookupPricePollingStatus {
  running: boolean;
  enabled: boolean;
  config: LookupPricePollingPrefs;
  progress: {
    targets: number;
    processed: number;
    priced: number;
    rateLimited: number;
    failed: number;
  } | null;
  lastCycleResult: PollingCycleResult | null;
  lastCycleAtMs: number | null;
}

export interface AppConfig {
  savePath: string;
  es3Password: string;
  pollIntervalSeconds: number;
  rollingWindowMinutes: number;
  /**
   * Per-window "keep on top" preference (main / overlay / boxTracker).
   * Replaces the legacy single `startTopmost: boolean` field; migrated by
   * `normalizeConfigFromRaw` when an old config lacks `topmost`.
   */
  topmost: WindowTopmostPrefs;
  logHistoryCsv: boolean;
  currency: string;
  /**
   * Steam 社区 Cookie 的 `sessionid` 值（会话 ID）。与
   * `steamCookieLoginSecure` 合成为完整 Cookie 头 `sessionid=<sessionid>;
   * steamLoginSecure=<...>`。为空时 pricehistory（历史走势）未登录拉取会返回
   * 400 空数据，此时仅能展示轮询采样回退走势。仅存于本地 config.json，不随 App 上传。
   */
  steamCookieSessionid?: string;
  /**
   * Steam 社区 Cookie 的 `steamLoginSecure` 值（登录态令牌）。与
   * `steamCookieSessionid` 合成为完整 Cookie 头，供 `fetchSteamPriceHistory`
   * 原样作为 `Cookie` 请求头。仅存于本地 config.json，不随 App 上传。
   */
  steamCookieLoginSecure?: string;
  /**
   * 合成后的完整 Steam 社区 Cookie 头（`sessionid=<...>;
   * steamLoginSecure=<...>`），由 `steamCookieSessionid` +
   * `steamCookieLoginSecure` 计算得出，供 `fetchSteamPriceHistory` 原样作为
   * `Cookie` 请求头。旧版单字段配置（原始完整字符串，可能含 `id` / `sessionid` 等
   * 键）在加载时迁移解析到新字段后同样合成到本字段。
   */
  steamCookie?: string;
  notificationsEnabled: boolean;
  notifyOnUpdateAvailable: boolean;
  notificationVolume: number;
  notificationPrefs: NotificationPrefs;
  inventoryAlmostFullThresholdPercent: number;
  chestAutoOpenEnabled: ChestAutoOpenPrefs;
  /**
   * Whether the inventory update should auto-trigger a Steam Market price
   * refresh for stale owned targets. Default true (keeps the pre-toggle
   * behavior). When false, prices only refresh on an explicit user action
   * (Refresh / Force full refresh / per-item refresh).
   */
  marketAutoScanEnabled: boolean;
  /** Auto-classify unclassified loot via FIFO drop queue. Default false. */
  lootAutoClassifyEnabled: boolean;
  /**
   * Per-category lap duration (seconds) for the Loot page's "time since last
   * open" border ring rendered on Common / Stage-boss chest cards. Mirrors the
   * mini overlay's boss-chest ring (7-min lap there). Defaults: common=300
   * (5 min), stage=420 (7 min). The `act` category isn't tracked (no fixed
   * cooldown loop) and unclassified never renders a ring.
   */
  lootRingSeconds: LootRingSeconds;
  liveMemory: LiveMemoryPrefs;
  /** 本地高价值/重点物品价格轮询偏好。默认关闭。 */
  lookupPricePolling: LookupPricePollingPrefs;
  windowLayout?: WindowLayoutPrefs;
  inventoryTable?: InventoryTablePrefs;
  /**
   * Minimum listing price (USD) for an item to be included in auto-refresh
   * Steam Market scans. Items at or below this threshold are skipped to avoid
   * wasting rate-limit budget on Steam's $0.03 floor. Set to 0 to disable.
   * Default 0.05.
   */
  marketLowValueThresholdUsd: number;
  /** UI language; "auto" follows the system locale. Default "auto". */
  language: AppLanguage;
  /**
   * Game install directory override for catalog refresh. When non-empty, this
   * path's `TaskbarHero_Data` parent is used as the game install root. When
   * empty, the service falls back to the Steam default path
   * (`D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data`) and the
   * `TBH_GAME_INSTALL_DATA_DIR` env var (for headless/test overrides). Users
   * on non-standard installs (e.g. a secondary Steam library, a different
   * drive, or a VM sharing a host install) set this once via Settings → Item
   * Catalog so the catalog can be refreshed without code changes.
   */
  gameInstallDir?: string;
  /**
   * Runtime-only resolved language (never persisted to config.json). The main
   * process fills this on every `getConfig()` call so the renderer can boot
   * i18next directly without re-reading the registry. Omitted when the
   * persisted `language` is not "game".
   */
  resolvedLanguage?: ResolvedLanguage;
  /**
   * Runtime-only stageKey -> localized name map (never persisted to
   * config.json). The main process fills this on every `getConfig()` call so
   * the renderer's `boxLootFilters` text matching can resolve stage names
   * without re-reading the catalog. ~30 entries. Omitted when no catalog is
   * loaded.
   */
  stageMetadata?: Record<number, string>;
  /**
   * Price history refresh: how many items to fetch per batch (Steam rate limits
   * pricehistory requests heavily). Default: 10. Lower to be more conservative.
   */
  marketHistoryBatchSize: number;
  /**
   * Price history refresh: how many seconds to wait between batches (default
   * 120 = 2 minutes). Increase to avoid 429 rate limits when fetching many
   * items.
   */
  marketHistoryBatchDelaySec: number;
  /**
   * Price history auto-refresh coverage threshold (0~1, default 0.95). When
   * ordering targets by recent-24h trade volume, the auto path treats the
   * head that already covers this ratio of total volume as a priority group
   * (least refreshes to cover the most trade volume); the remaining tail is
   * picked up across the day so every target still gets refreshed once per day.
   */
  marketHistoryCoverageThreshold: number;
}

/** Scoped targets for Settings → Data & cache clear actions. */
export type AppDataClearTarget =
  | "prices"
  | "lookup-prices"
  | "box-timers"
  | "stage-runs"
  | "session"
  | "all-except-config";

/** A `LookupItem` resolved against the price snapshot for display. */
export interface ResolvedLookupPrice {
  /** market_hash_name, or null when the item isn't priceable/tradable. */
  hash: string | null;
  /** priced = has a USD listing; no-listing = tradable but no active listing; not-tradable = no affordance. */
  state: "priced" | "no-listing" | "not-tradable";
  /** USD lowest listing from the snapshot (null unless state === "priced"). */
  usd: number | null;
  /** Amount converted to the display currency (null unless priced). */
  amount: number | null;
  /** Formatted display string in the user's currency (null unless priced). */
  display: string | null;
  /** Steam Market listing URL for the hash (null when not-tradable). */
  listingUrl: string | null;
  /**
   * 价格来源：`"local"` = 本地 polling 直接用目标货币抓取（最准确）；
   * `"ci"` = CI 快照 USD 价格 × FX 汇率换算；`null` = 无价格（no-listing/not-tradable）。
   */
  source: "local" | "ci" | null;
  /**
   * 最近成交价中位数（目标货币）。来自本地 polling 的 priceoverview
   * `median_price`。null = polling 未抓取或该物品无成交记录；undefined =
   * 该字段未填充（CI 快照本身不含 median）。
   */
  median?: number | null;
  /**
   * 最高收购价（目标货币）。来自本地 polling 的 itemordershistogram
   * `highest_buy_order`。null = polling 未抓取/nameid 解析失败/无收购单；
   * undefined = 该字段未填充。
   */
  buyOrder?: number | null;
}

export interface AppDataPathEntry {
  id: AppDataClearTarget | "config" | "diagnostic-log";
  label: string;
  files: string[];
  exists: boolean;
}

export interface ClearDiagnosticLogResult {
  ok: boolean;
  cleared: string[];
  error?: string;
}

export interface RendererLogPayload {
  source: string;
  message: string;
  stack?: string;
}

export interface AppDataPaths {
  userDataDir: string;
  configPath: string;
  diagnosticLogPath: string;
  entries: AppDataPathEntry[];
}

export interface ClearAppDataResult {
  ok: boolean;
  cleared: string[];
  error?: string;
}

// --- Stage runs (live stage clear history: per-run duration + XP/gold) ---

/** Outcome of a stage run recorded in stage-clear history. */
export type StageRunOutcome = "clear" | "fail";

export interface StageRunHistoryEntry {
  wallTime: number;
  stageKey: number;
  stageName?: string; // localized stage name; absent on entries cached before v1.19.x
  /**
   * Absent on clear/legacy entries (defaults to "clear"); set to "fail" only
   * on stage runs inferred to have failed. Keeping it absent on clears keeps
   * the persisted `stage_run_history.json` and old tests/snapshots unchanged.
   */
  outcome?: StageRunOutcome;
  clearTimeSec: number;
  /** XP/gold gained since the previous recorded clear (this run's take). */
  xpGained: number;
  goldGained: number;
  /** Furthest wave reached on a failed run; only meaningful when outcome==="fail". */
  failedWave?: number;
}

export interface StageRunStats {
  history: StageRunHistoryEntry[];
  /** True when this feature has no save-file fallback — requires the live reader. */
  readerRequired: boolean;
}

/** Serialized StageRunTracker internals for stage_run_history.json persistence. */
export interface StageRunTrackerSnapshot {
  history: StageRunHistoryEntry[];
}

// --- Chests (BoxData holdings) ---

export interface ResolvedChestRow {
  boxType: number;
  label: string;
  category: string;
  quantity: number;
}

export interface BoxSlotStatus {
  quantity: number;
  capacity: number;
  isFull: boolean;
  slotsRemaining: number;
}

/** @deprecated use BoxSlotStatus */
export type CommonBoxStatus = BoxSlotStatus;

export interface ChestCapacityBreakdown {
  base: number;
  runeBonus: number;
  purchasedCapRuneNodes: number;
  runeLabel: string;
}

/** @deprecated use ChestCapacityBreakdown */
export type CommonCapacityBreakdown = ChestCapacityBreakdown;

export interface ChestState {
  rows: ResolvedChestRow[];
  common: BoxSlotStatus;
  stageBoss: BoxSlotStatus;
  actBoss: BoxSlotStatus;
  /** v1.02.00 Plague (Contaminated) chests — stored separately from normal ones. */
  plagueCommon: BoxSlotStatus;
  plagueRare: BoxSlotStatus;
  plagueAct: BoxSlotStatus;
  capacity: {
    common: ChestCapacityBreakdown;
    stageBoss: ChestCapacityBreakdown;
    actBoss: ChestCapacityBreakdown;
    plagueCommon: ChestCapacityBreakdown;
    plagueRare: ChestCapacityBreakdown;
    plagueAct: ChestCapacityBreakdown;
    totalRunePurchases: number;
  };
  /** Effective seconds to auto-open one chest of each type (base minus rune reduction). */
  autoOpen: {
    common: number;
    stageBoss: number;
    actBoss: number;
    plagueCommon: number;
    plagueRare: number;
    plagueAct: number;
  };
  totalHeld: number;
  saveMtime: number;
  /** @deprecated use capacity.common.runeBonus */
  runeBonusSlots: number;
}

// --- Pets ---

export interface PetAppearStage {
  act: number;
  stage: number;
  name: string;
  label: string;
}

export interface PetBestStage {
  stageKey: number;
  difficultyLabel: string;
  locationName: string;
  spawnPercent: number;
  expectedKillsPerClear: number;
  /** Present while the pet is still locked — clears needed on this stage. */
  runsMessage?: string;
}

export interface PetRow {
  petKey: number;
  name: string;
  unlocked: boolean;
  equipped: boolean;
  unlockKind: "kills" | "dlc";
  killCount?: number;
  killTarget?: number;
  killsRemaining?: number;
  progressPct?: number;
  bonuses: string[];
  dlcLabel?: string;
  appearsOnStages?: PetAppearStage[];
  bestStages?: PetBestStage[];
}

export interface PetState {
  pets: PetRow[];
  saveMtime: number;
  arrangedPetKey: number;
  unlockKillCount: number;
  dlcLabel: string;
}

// --- Box tracker (manual rare boss box timers) ---

export type BoxTrackerSortOrder = "cooldown-first" | "ready-first";

export interface BoxTimerFarmStageOption {
  stageKey: number;
  label: string;
}

export interface BoxTimerRow {
  boxId: number;
  name: string;
  level: number | null;
  idealStageKey: number;
  idealStageLabel: string;
  cooldownSeconds: number;
  cooldownIsCustom: boolean;
  active: boolean;
  remainingSeconds: number;
  progress: number;
  status: "ready" | "cooldown";
  atIdealStage: boolean;
}

export interface BoxTimerCatalogEntry {
  boxId: number;
  name: string;
  level: number | null;
  /**
   * Chest category of this tracker route, derived from the box name via
   * `categoryFromBoxItemName`. Normally `"rare"` (stage boss), but the game's
   * Contaminated Stage Box lines (925xxx) resolve to `"plagueRare"` — the
   * Chests tab groups settings by (level, category) so plague boxes get their
   * own row (they have a different auto-open time). null when the name doesn't
   * match a known prefix.
   */
  category: BoxCategory | null;
  idealStageKey: number;
  idealStageLabel: string;
  defaultIdealStageKey: number;
  defaultIdealStageLabel: string;
  idealStageIsCustom: boolean;
  farmStageOptions: BoxTimerFarmStageOption[];
  dropStageRangeLabel: string;
  cooldownSeconds: number;
  cooldownIsCustom: boolean;
  enabled: boolean;
  notifyWhenReady: boolean;
}

export interface BoxTimerState {
  rows: BoxTimerRow[];
  catalog: BoxTimerCatalogEntry[];
  enabledCount: number;
  readyCount: number;
  cooldownCount: number;
  sortOrder: BoxTrackerSortOrder;
  currentStageKey: number;
  currentStageLabel: string; // localized current stage name, computed by main via stageName(currentStageKey, catalog)
  defaultCooldownSeconds: number;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "ready"
  | "error"
  | "disabled";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
  lastCheckedAt?: string;
}

// --- Lookup tab (bundled item/source catalog) ---

export interface LookupStatRow {
  stat: string;
  mod: string;
  value: number;
  display: string;
}

export type LookupUniqueModParamKind =
  | "percent" // Raw_Divide1000 → value/10（百分数展示）
  | "number" // Divided 合法整数（如 500）
  | "scale100" // Raw_Divide100 → value/100（仅 SkillRangeUp，展示值待复核）
  | "element" // DamageAttribute: Cold/Fire/Lightning，无本地化 → 不可解析
  | "skill" // Divided & 值是 SkillKey → t(common:labels.skillNames.<value>)
  | "hero" // Divided & 值映射到职业 class key → classLabel
  | "unknown"; // 不可解释（StatValueUp）→ 不可解析

export interface LookupUniqueModParam {
  /** 原值：skill 存 SkillKey 数字串、hero 存 class key、percent/number/scale100 存源整数值 */
  value: string;
  /** 源列名（如 "Divided" / "Raw_Divide1000"） */
  exchange: string;
  kind: LookupUniqueModParamKind;
}

export interface LookupUniqueMod {
  key: number;
  mod: string;
  text: string;
  /** 与模板 {0}/{1}/... 位置对应的参数。仅当全部占位符可解析时才填充模板。 */
  params?: LookupUniqueModParam[];
}

export interface LookupGearStats {
  base: LookupStatRow[];
  inherent: LookupStatRow[];
  unique: LookupUniqueMod | null;
}

export interface LookupMaterialOutcome {
  stat: string;
  mod: string;
  tier: number;
  rawMin: number;
  rawMax: number;
  displayMin: number;
  displayMax: number;
  displayText: string;
}

export interface LookupMaterialGearGroup {
  gearGroup: string;
  outcomes: LookupMaterialOutcome[];
}

export interface LookupItem {
  id: number;
  name: string;
  /**
   * English source name preserved across localization. Set by
   * `LookupService.getCatalog()` when the display `name` is localized, so
   * `marketHashName()` can still derive the English Steam
   * `market_hash_name` (Steam hashes are always English; using a localized
   * name would break price lookups). Undefined for bundled items before
   * any localization has been applied.
   */
  sourceName?: string;
  grade: string;
  type: "GEAR" | "MATERIAL";
  gearType: string | null;
  gearGroup: string | null;
  materialType: string | null;
  level: number | null;
  iconPath: string;
  marketTradable: boolean;
  /**
   * Game content category from ItemInfoData.CONTENTTYPE (e.g. "PLAGUE" for
   * v1.2.2 plague items). Empty/absent for normal items.
   */
  contentType?: string;
  stats?: LookupGearStats;
  gearGroups?: LookupMaterialGearGroup[];
}

export interface LookupDropEntry {
  via: string;
  boxItemKey: number;
  boxName: string;
  grade: string | null;
  dropPct: number;
}

export interface LookupCraftingEntry {
  recipeKey: number;
  tier: number;
  craftingType: string;
  level: { min: number; max: number };
  materials: { itemKey: number; name: string; amount: number }[];
  outputPct: number;
}

export interface LookupUsedInOutput {
  itemKey: number;
  poolPct: number;
}

export interface LookupUsedInEntry {
  recipeKey: number;
  craftingType: string;
  tier: number;
  level: { min: number; max: number };
  materials: { itemKey: number; name: string; amount: number }[];
  outputs: LookupUsedInOutput[];
}

export interface LookupItemSources {
  drops: LookupDropEntry[];
  crafting: LookupCraftingEntry[];
  /** Crafting recipes that consume this material (MATERIAL items only). */
  usedIn?: LookupUsedInEntry[];
}

// --- Synthesis model (bundled synthesis_model.json + core/lookup/synthesis.ts) ---

export interface SynthesisGradeWeights {
  value: number;
  weights: [number, number, number, number, number];
  total: number;
}

export interface SynthesisRecipeRow {
  recipeTier: number;
  inputGrade: string;
  minMaterialTier: number;
  minMaterialAverageLevel: number;
  /** Precomputed in tbh-data; optional until synthesis_model.json is regenerated. */
  materialAvgLevelMin?: number;
  materialAvgLevelMax?: number;
  minResultLevel: number;
  maxResultLevel: number;
  materialAmount: number;
  levelWeights: number[];
}

export interface SynthesisBucketEntry {
  itemKey: number;
  poolPct: number;
}

export interface SynthesisModel {
  gradeWeights: Record<string, SynthesisGradeWeights>;
  recipesByType: Record<string, SynthesisRecipeRow[]>;
  buckets: Record<string, SynthesisBucketEntry[]>;
}

export interface SynthesisPathToItem {
  inputGrade: string;
  gradeStep: number;
  tier: number;
  minMaterialTier: number;
  materialAvgLevel: number;
  materialAvgLevelMin: number;
  materialAvgLevelMax: number;
  materialAmount: number;
  resultLevelMin: number;
  resultLevelMax: number;
  itemLevel: number;
  pGrade: number;
  pLevel: number;
  itemPoolPct: number;
  chance: number;
}

export interface SynthesisSimOutcome {
  outputGrade: string;
  level: number;
  itemKey: number;
  chance: number;
}

export interface LookupBoxDrop {
  itemKey: number;
  name: string;
  grade: string;
  dropPct: number;
}

export type LookupBoxDropVia = "monster_box" | "boss_box" | "act_boss";

/**
 * Canonical box category vocabulary used across the tracker / inventory /
 * box-open-log domains (P2-1 unification).
 *
 * Values:
 *   - `common`       — common chest (boxType 0)
 *   - `rare`         — stage boss chest (boxType 1; "rare" is the in-game
 *                      rarity tag; the player-facing label is "Stage boss")
 *   - `act`          — act boss chest (boxType 2)
 *   - `unclassified` — boxType couldn't be read from memory, or the boxType
 *                      isn't in the catalog. The unified sentinel; previously
 *                      `catalog.ts` used `"unknown"` and `boxOpenLog.ts` used
 *                      `"unclassified"` for the same concept.
 *
 * This is the single source of truth. `catalog.ts` and `boxOpenLog.ts` both
 * re-export this alias for backward compatibility.
 */
export type BoxCategory =
  | "common"
  | "rare"
  | "act"
  | "plagueCommon"
  | "plagueRare"
  | "plagueAct"
  | "unclassified";

/**
 * Lookup-display-side box category vocabulary. Distinct from {@link BoxCategory}
 * because the lookup module's data source (tbh-data) uses fully-descriptive
 * snake_case names (`stage_boss`/`act_boss`) rather than the in-game rarity
 * tags (`rare`/`act`). Mapped via {@link toLookupCategory}.
 */
export type LookupBoxCategory = "common" | "stage_boss" | "act_boss" | "unknown";

/**
 * Map a canonical {@link BoxCategory} to its {@link LookupBoxCategory}
 * display equivalent. Use when rendering a box's tracker-side category through
 * the lookup module's display helpers (e.g. `boxCategoryLabel`).
 *
 * `unclassified` (tracker-side "we couldn't classify this") maps to `unknown`
 * (lookup-side "we don't know what this is") — same semantic, different
 * vocabulary per module.
 */
export function toLookupCategory(category: BoxCategory): LookupBoxCategory {
  switch (category) {
    case "common":
      return "common";
    case "rare":
      return "stage_boss";
    case "act":
      return "act_boss";
    case "plagueCommon":
    case "plagueRare":
    case "plagueAct":
      return "unknown";
    case "unclassified":
      return "unknown";
  }
}

export interface LookupBoxStageRef {
  stageKey: number;
  stageName: string;
  via: LookupBoxDropVia;
  /** Spawn chance % (converted at tbh-data extract). Act boss = 100. */
  spawnPct: number;
}

export interface LookupBoxFirstDropStageRef {
  stageKey: number;
  stageName: string;
}

export interface LookupBoxSources {
  name: string;
  grade: string | null;
  category: LookupBoxCategory;
  drops: LookupBoxDrop[];
  stages: LookupBoxStageRef[];
  dropStageRangeLabel: string;
  firstDropOnly: boolean;
  firstDropStages: LookupBoxFirstDropStageRef[];
  /**
   * Chest level, merged in by main's `LookupService` from `stage_boxes.json`
   * (matched by box item-key). The bundled `lookup_sources.json` doesn't carry
   * it, and the box `name` alone is unreliable for plague variants (whose name
   * encodes a stage range rather than the level), so it's enriched at the
   * service boundary. `null`/absent when the id has no stage_boxes entry.
   */
  level?: number | null;
}

export interface LookupStageBoxRef {
  boxItemKey: number;
  name: string;
  grade: string | null;
}

export interface LookupStageSources {
  monsters: string[];
  boxes: LookupStageBoxRef[];
}

export interface LookupSources {
  items: Record<string, LookupItemSources>;
  boxes: Record<string, LookupBoxSources>;
  stages: Record<string, LookupStageSources>;
}

// --- Offerings (bundled offerings.json + core/lookup/offerings.ts) ---

export interface OfferingLootEntry {
  itemKey: number;
  poolPct: number;
}

export interface OfferingEntry {
  coinKey: number;
  goldCost: number;
  unlockCubeLevel: number;
  loot: OfferingLootEntry[];
}

export type OfferingsModel = OfferingEntry[];

/** Reverse lookup: a coin that can yield a given item, and at what chance. */
export interface OfferingSource {
  coinKey: number;
  poolPct: number;
}

// --- Live memory reader ---

// --- Live memory stat types (Phase 2+) ---

/** A single hero's live data read from StageManager.HeroList. */
export interface LiveHeroData {
  heroKey: number;
  level: number;
  exp: number;
  name?: string; // localized hero name; populated by main when catalog is available
}

/** A single inventory item from LocalInventoryManager bag dicts. */
export interface LiveInventoryItem {
  itemKey: number;
  isChaotic: boolean;
}

/**
 * Live per-category chest slot counts (unopened chests) read from
 * `PlayerSaveData.BoxData` runtime. Categories mirror {@link BoxCategory}
 * minus `unclassified` (which is tracker-side only and never counted as a slot).
 */
export interface LiveChestSlots {
  common: number;
  /** Stage boss chests (auto-classify "rare" category). */
  rare: number;
  act: number;
  /** v1.02.00 Plague (Contaminated) chests — stored separately from normal ones. */
  plagueCommon: number;
  plagueRare: number;
  plagueAct: number;
}

/** Pet unlock state read from save-layer heap (PetSaveData). */
export interface LivePetData {
  petKey: number;
  unlocked: boolean;
}

/**
 * A single StageClearLog entry observed since the previous tick. `act` and
 * `stage` identify the **cleared** stage (the log entry is appended on clear,
 * before StageManager advances). Difficulty is NOT carried by the log entry —
 * the caller combines `act`/`stage` with the difficulty digit of the current
 * live/save stageKey to form a full stageKey. When `act`/`stage` are 0
 * (corrupted / mid-write read), `valid` is false and the entry MUST be dropped
 * by the caller (see `valid` field for the rationale).
 */
export interface StageClearEntry {
  /** Cleared stage's act (1-digit, from StageClearLog+0x40). 0 = unreadable. */
  act: number;
  /** Cleared stage's stage (1-99, from StageClearLog+0x44). 0 = unreadable. */
  stage: number;
  /** Clear time in whole seconds, as recorded by the game itself. */
  clearTimeSec: number;
  /**
   * Whether act/stage were both read in plausible range (act 1-9, stage 1-99).
   * false ⇒ the entry is a "clear event observed but target stage unreadable"
   * sample (mid-write race / corrupted memory). Callers MUST drop invalid
   * entries instead of falling back to the live stageKey: by the time the
   * reader polls the next tick, the live stageKey has already advanced past
   * the cleared stage, so the fallback would attribute the clear to the
   * wrong (next) stage — re-introducing the off-by-one attribution bug.
   */
  valid: boolean;
}

/**
 * A live read from game process memory (read-only). Per-stat: a `null` field
 * means "no live value this tick" — the renderer falls back to the save value.
 * Phase 1 emits stage only; Phase 2 expands with gold, heroes, chests, inventory, pets.
 */
export interface LiveMemorySnapshot {
  /** The reader produced a live read this tick. */
  connected: boolean;
  /** Live current stage key (null ⇒ fall back to the save value). */
  stageKey: number | null;
  /** Live current wave within the stage. */
  stageWave: number | null;
  /** Total waves in the current stage (from StageInfoData). */
  stageWaveTotal: number | null;
  /** Live alive-monster count from StageManager (wave-clear signal when
   *  monster-HP offsets are unavailable, e.g. v1.01.05). Null otherwise. */
  stageAlive: number | null;
  /** Live current gold (null ⇒ fall back to save value). */
  gold: number | null;
  /** Live hero XP/level for all party members (null ⇒ fall back to save). */
  heroes: LiveHeroData[] | null;
  /** Diagnostics: why `heroes` is null this tick. Dev-only. */
  heroesStatus?: string;
  /**
   * Chest drops observed since the previous tick, classified from the GetBox
   * battle log (common / rare = stage boss / act = act boss). `[]` = reader
   * active, no new drops; `null` = chest log unavailable (offset not derived
   * / no battle).
   */
  chestDrops: ("common" | "rare" | "act")[] | null;
  /** Diagnostics: why `chestDrops` is null this tick. Dev-only. */
  chestDropsStatus?: string;
  /**
   * Tail-position diagnostics for the chest log, for investigating duplicate-
   * drop bugs. Present only when `chestDrops` is a real per-tick delta (not
   * `null`). `count` < `lastCountBefore` indicates the log shrank (new run
   * cleared it) and the tail restarted from 0 — which re-reads old entries as
   * new and can cause duplicate recordings.
   */
  chestLogDebug?: {
    count: number;
    lastCountBefore: number;
    start: number;
    entriesRead: number;
    retryFrom?: number;
    retryConsecutive?: number;
    /** Cross-tick settle correction (provisional → committed), e.g. common→rare. */
    settled?: { idx: number; from: "common" | "rare" | "act"; to: "common" | "rare" | "act" };
  };
  /**
   * Live per-category chest slot quantities (current count of unopened chests
   * of each type), read from `PlayerSaveData.BoxData` runtime. `null` = reader
   * active but offsets unavailable / pointer walk failed this tick — fall back
   * to save-derived slot counts. Used by AutoClassifyService for high-frequency
   * reconcile and by the renderer's `LootQueueSlots` for live quantity display.
   */
  chestSlots: LiveChestSlots | null;
  /** Diagnostics: why `chestSlots` is null this tick. Dev-only. */
  chestSlotsStatus?: string;
  /** Live inventory items from PlayerSaveData.itemSaveDatas snapshot (null ⇒ unavailable). */
  inventoryItems: LiveInventoryItem[] | null;
  /** Diagnostics: why `inventoryItems` is null this tick. Dev-only. */
  inventoryItemsStatus?: string;
  /**
   * Stage clears observed since the previous tick, read from the StageClear
   * battle log. `[]` = reader active, no new clears; `null` = unavailable
   * (offset not derived / no battle). Each entry carries the **cleared**
   * stage's act/stage (from StageClearLog+0x40 / +0x44) plus the clear time
   * in whole seconds. The log entry does NOT carry difficulty — `main/`
   * combines `act`/`stage` with the difficulty digit of the current
   * live/save stageKey to form a full stageKey
   * (`difficulty*1000 + act*100 + stage`). This avoids the off-by-one stage
   * attribution bug where a clear of 3-1 was recorded as 3-2 because
   * `stageKey` had already advanced by the time the reader polled the next
   * tick. If `act`/`stage` are 0 (corrupted / mid-write read), the caller
   * falls back to the current stageKey.
   */
  stageClears: StageClearEntry[] | null;
  /**
   * Box opens observed since the previous tick, read from the
   * GetItemWithBoxOpen battle log. `[]` = reader active, no new opens;
   * `null` = box-open log unavailable (offset not derived / no open yet).
   */
  boxOpens: BoxOpenEntry[] | null;
  /** Diagnostics: why `boxOpens` is null this tick. Dev-only. */
  boxOpensStatus?: string;
  /** Live pet unlock state from save-layer heap (null ⇒ unavailable). */
  petData: LivePetData[] | null;
  /** Diagnostics: why `petData` is null this tick. Dev-only. */
  petDataStatus?: string;
  /**
   * Live monster HP values observed this frame. Each entry is [addr, hpCurrent, hpMax].
   * `addr` is the monster's memory address (converted to number for IPC, safe on x64).
   * Used by DpsTracker for address-based HP matching (tbh-meter approach).
   * When the reader is active but there are no monsters, the array is empty `[]`.
   * `null` means monster reading is unavailable for this game version.
   */
  monsterHp: [number, number, number][] | null;
  /** Number of monsters killed so far this run (from dead monster list count). null = unavailable. */
  deadMonsterCount: number | null;
  /** Human-readable source, e.g. "memory v1.00.21". */
  source: string;
  /** Duration of the last snapshot read in ms (per-tick cost, diagnostics). */
  readMs: number;
  /** Epoch ms when the read was taken. */
  at: number;
}

/** Reader lifecycle/attach state for the status indicator + diagnostics. */
export interface LiveMemoryStatus {
  /** The reader process is up. */
  running: boolean;
  /** Attached to the game process. */
  attached: boolean;
  pid: number | null;
  /** Detected game version (from Version.txt). */
  gameVersion: string | null;
  /** Bundled offsets exist for the detected version. */
  supported: boolean;
  /** e.g. "live stats unavailable for game v1.00.99". */
  note?: string;
  /** True while the reader is performing an expensive memory scan (offset derivation or class-name resolution). */
  scanning?: boolean;
  /** Self-healing offset resolution health: whether every wanted field is mapped. */
  offsetHealth?: {
    complete: boolean;
    /** Dotted paths of wanted offset fields still awaiting derivation. */
    missing: string[];
    /** Where the active offset table came from (bundled table, disk cache, extractor, …). */
    source?: "bundled" | "cache" | "extracted" | "merged" | "none";
    /** Extraction attempts used for this game version under the current app build. */
    extractionAttempts?: number;
    /**
     * When the requested game version is not in the bundled table, the reader
     * falls back to the nearest same-major.minor version's RVA table as a
     * working baseline. This field records the source version of that fallback
     * (e.g. `"1.00.28"` when the user is on `1.00.29`). Absent when the bundled
     * table matched exactly or when no fallback candidate was found.
     *
     * Provenance marker — preserved across merge/cache, never cleared by the
     * extractor. Combine with `source` to know whether the extractor has
     * re-derived critical RVAs (`"merged"`/`"extracted"` ⇒ ran successfully).
     */
    fallbackFromVersion?: string;
  };
}

// API surface exposed on `window.tbh` by the preload via contextBridge.
export interface TbhApi {
  onStats(cb: (stats: Stats) => void): () => void;
  reset(): void;
  getStats(): Promise<Stats | null>;
  openOverlay(): void;
  showMain(): void;
  closeOverlay(): void;
  getInventory(): Promise<ResolvedInventory | null>;
  onInventory(cb: (inv: ResolvedInventory) => void): () => void;
  pricesStatus(): Promise<PriceStatus>;
  refreshPrices(force?: boolean): Promise<PriceRefreshResult & { status: PriceStatus }>;
  refreshItemPrices(itemKey: number): Promise<PriceRefreshResult & { status: PriceStatus }>;
  cancelPrices(): void;
  setCurrency(iso: string): Promise<PriceStatus>;
  /** Toggle auto market-scan on inventory updates without restart. */
  setMarketAutoScanEnabled(enabled: boolean): Promise<void>;
  onPricesProgress(cb: (p: PriceProgress) => void): () => void;
  onPriceStatus(cb: (status: PriceStatus) => void): () => void;
  getConfig(): Promise<AppConfig>;
  saveConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  pickSaveFile(): Promise<string | null>;
  getDataPaths(): Promise<AppDataPaths>;
  clearAppData(target: AppDataClearTarget): Promise<ClearAppDataResult>;
  clearDiagnosticLogs(): Promise<ClearDiagnosticLogResult>;
  logRendererError(payload: RendererLogPayload): Promise<void>;
  getChests(): Promise<ChestState | null>;
  onChests(cb: (state: ChestState) => void): () => void;
  getPets(): Promise<PetState | null>;
  onPets(cb: (state: PetState) => void): () => void;
  openBoxTracker(): void;
  closeBoxTracker(): void;
  minimizeBoxTracker(): void;
  getBoxTimers(): Promise<BoxTimerState>;
  onBoxTimers(cb: (state: BoxTimerState) => void): () => void;
  markBoxDropped(boxId: number): Promise<BoxTimerState>;
  clearBoxTimer(boxId: number): Promise<BoxTimerState>;
  setBoxTrackerBoxes(boxIds: number[]): Promise<BoxTimerState>;
  setBoxTrackerCooldown(boxId: number, cooldownSeconds: number): Promise<BoxTimerState>;
  clearBoxTrackerCooldown(boxId: number): Promise<BoxTimerState>;
  setBoxTrackerFarmStage(boxId: number, stageKey: number): Promise<BoxTimerState>;
  clearBoxTrackerFarmStage(boxId: number): Promise<BoxTimerState>;
  setBoxTrackerNotify(boxId: number, enabled: boolean): Promise<BoxTimerState>;
  setBoxTrackerSortOrder(sortOrder: BoxTrackerSortOrder): Promise<BoxTimerState>;
  onPlayNotificationSound(cb: (payload: NotificationSoundPayload) => void): () => void;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  quitAndInstall(): Promise<void>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  getLookupCatalog(): Promise<LookupItem[]>;
  getLookupSources(): Promise<LookupSources>;
  getLookupSynthesisModel(): Promise<SynthesisModel>;
  getOfferings(): Promise<OfferingsModel>;
  getLookupPrices(): Promise<LookupPriceSnapshot | null>;
  onLookupPrices(cb: (snapshot: LookupPriceSnapshot | null) => void): () => void;
  getLookupPricePollStatus(): Promise<LookupPricePollingStatus | null>;
  onLookupPricePollStatus(cb: (status: LookupPricePollingStatus) => void): () => void;
  pollLookupPrices(hash?: string): Promise<PollingCycleResult>;
  getMarketVolume(): Promise<MarketVolumeStats>;
  onMarketVolume(cb: (stats: MarketVolumeStats) => void): () => void;
  getMarketVolumeItems(): Promise<MarketVolumeItemStats>;
  onMarketVolumeItems(cb: (stats: MarketVolumeItemStats) => void): () => void;
  refreshMarketVolumeItems(cardOrder?: string[]): Promise<MarketVolumeRefreshResult>;
  onMarketVolumeRefreshProgress(cb: (progress: MarketVolumeRefreshProgress) => void): () => void;
  refreshMarketVolumeItem(hash: string): Promise<void>;
  exportMarketVolumeHistory(): Promise<ExportMarketVolumeResult>;
  importMarketVolumeHistory(): Promise<ImportMarketVolumeResult>;
  cancelHistoryRefresh(): void;
  getLiveMemory(): Promise<LiveMemorySnapshot | null>;
  getLiveMemoryStatus(): Promise<LiveMemoryStatus | null>;
  onLiveMemory(cb: (snapshot: LiveMemorySnapshot) => void): () => void;
  onLiveMemoryStatus(cb: (status: LiveMemoryStatus) => void): () => void;
  getStageRuns(): Promise<StageRunStats>;
  onStageRuns(cb: (stats: StageRunStats) => void): () => void;
  resetLootBox(boxKey: string): Promise<void>;
  resetLootAll(): Promise<void>;
  reclassifyLootItem(itemKey: number, fromBoxKey: string, toBoxKey: string): Promise<void>;
  // Auto-classify
  setLootAutoClassifyEnabled(enabled: boolean): Promise<void>;
  getAutoClassifyState(): Promise<AutoClassifyStatePayload>;
  onClassifyPrompt(cb: (payload: ClassifyPromptPayload) => void): () => void;
  resolveClassifyPrompt(payload: ClassifyPromptResolvePayload): void;
  // Catalog refresh
  getCatalogStatus(): Promise<CatalogStatus | null>;
  refreshCatalog(): Promise<CatalogRefreshResult>;
  getLocaleData(): Promise<GameLocaleData | null>;
  onCatalogStatus(cb: (status: CatalogStatus) => void): () => void;
}

export interface CatalogStatus {
  catalogVersion: string | null;
  gameVersion: string | null;
  stale: boolean;
  source: "bundled" | "userData";
  itemCount: number;
  lastRefreshMs: number | null;
  lastError: string | null;
}

export interface CatalogRefreshResult {
  ok: boolean;
  gameVersion: string | null;
  itemCount: number;
  resolvedNames: number;
  error?: string;
}

/**
 * Game locale data extracted from the game's localization bundles.
 *
 * `locales` is a dynamic map: keys are BCP-47 language codes (e.g. "en",
 * "zh-CN", "zh-Hant", "fr-FR", ...), values are flat key→value translation
 * maps (e.g. `{ "Grade_COMMON": "Common", ... }`).
 *
 * Only languages successfully extracted and non-empty are included; missing
 * languages are handled by the renderer via i18next fallback.
 */
export interface GameLocaleData {
  /** Game version at extraction time (same as CatalogStatus.gameVersion). */
  version: string | null;
  locales: Record<string, Record<string, string>>;
}
