import type {
  ChestDropBreakdownRow,
  ChestDropHistoryEntry,
  ChestDropStats,
  ChestDropTrackerSnapshot,
} from "../../shared/types";
import {
  loadStageBoxCatalogFile,
  type StageBoxCatalogFile,
  type StageBoxCatalogItem,
} from "./stageBoxTracker";

export type ChestDropCategory = "common" | "rare" | "act";

/** Optional subscriber hook for chest-drop events. */
export interface ChestDropTrackerCallbacks {
  onDrop?: (event: {
    category: ChestDropCategory;
    wallTime: number;
    /** Resolved itemKey for Player.log drops; undefined for live GetBox drops. */
    itemKey?: number;
    /** Current stageKey if known to the caller; undefined if not. */
    stageKey?: number;
  }) => void;
}

/**
 * Live chest drops from the GetBox battle log carry no item key, only a
 * category. They are aggregated into these synthetic per-category buckets.
 */
const LIVE_CHEST_KEY: Record<ChestDropCategory, number> = {
  common: 900910,
  rare: 900920,
  act: 900930,
};
const LIVE_CHEST_NAME: Record<ChestDropCategory, string> = {
  common: "Common chest",
  rare: "Stage boss chest",
  act: "Act boss chest",
};

export interface ResolvedStageBoxDrop {
  itemKey: number;
  name: string;
  category: ChestDropCategory;
}

const HISTORY_LIMIT = 500;
const HISTORY_VISIBLE = 50;
/**
 * How long (seconds) a live-path drop "credit" stays claimable by the save
 * reconcile. A save's slot increase can lag live detection by several reconcile
 * cycles (and `reconcileWithChestSlots` fires at ~25 Hz on v1.2.2 because
 * `setLiveSlots(null)` re-reconciles every live frame), so a per-cycle mark
 * cannot be used — the evidence would be reset by intervening no-op reconciles.
 * A time-bounded credit survives those and still expires so a stale credit
 * can't suppress a genuinely missed drop forever. 180s comfortably exceeds the
 * save cadence (seconds) and the observed duplicate gap (~4s).
 */
const LIVE_CREDIT_TTL_SEC = 180;
/** Hard cap on retained credits per category (defensive against leaks). */
const LIVE_CREDIT_MAX = 256;
/**
 * Minimum time window (seconds) used when computing perHour rates. Right
 * after a session reset, `elapsedSeconds` can be a few seconds while drops
 * have already been recorded — dividing by such a tiny window produces
 * absurd perHour spikes (e.g. 1 drop / 5s → 720/hr). We clamp the
 * denominator to this minimum so the rate stays a conservative estimate
 * until enough real elapsed time has accumulated. 60s matches the typical
 * auto-open cadence and is short enough that steady-state rates are
 * unaffected (a 1-hour session uses 3600s, not 60s).
 */
const MIN_RATE_WINDOW_SEC = 60;
/**
 * Rolling window for `*RecentPerHour` rates. Recent drops inside this window
 * are divided by the window size (clamped to {@link MIN_RATE_WINDOW_SEC} when
 * the first recent drop is younger than the window). 1 hour matches the
 * "near-term pace" intuition — short enough to reflect current farming
 * intensity, long enough to smooth out 5-second-burst noise.
 */
const ROLLING_HOUR_SEC = 3600;

function nowSeconds(): number {
  return Date.now() / 1000;
}

function categoryFromPrefix(itemKey: number): ChestDropCategory | null {
  if (itemKey >= 910_000 && itemKey < 920_000) return "common";
  if (itemKey >= 920_000 && itemKey < 930_000) return "rare";
  if (itemKey >= 930_000 && itemKey < 940_000) return "act";
  return null;
}

/**
 * Cached catalog + lookup indexes for `resolveStageBoxDrop`.
 *
 * `loadStageBoxCatalogFile()` does a synchronous `readFileSync` + `JSON.parse`
 * on every call (see `core/bundledData.ts`). Player.log can surface one drop
 * per second during farming, and burst drops surface N at once — without
 * caching, that is N fs reads + N O(catalog.length) scans per second on the
 * main process. The catalog file is immutable for the process lifetime, so we
 * load it once lazily and build:
 *   - `byId`: O(1) lookup of any catalog item by id
 *   - `canonicalByLevel`: O(1) lookup of the canonical tracker box id for a
 *     given rare-box level (replaces the O(N) scan inside
 *     `canonicalTrackerBoxId`).
 */
interface StageBoxCatalogIndex {
  catalog: StageBoxCatalogFile;
  byId: Map<number, StageBoxCatalogItem>;
  canonicalByLevel: Map<number, number>;
}

let cachedCatalogIndex: StageBoxCatalogIndex | null = null;

function getStageBoxCatalogIndex(): StageBoxCatalogIndex {
  if (cachedCatalogIndex === null) {
    const catalog = loadStageBoxCatalogFile();
    const byId = new Map<number, StageBoxCatalogItem>();
    const canonicalByLevel = new Map<number, number>();
    for (const item of catalog.items) {
      byId.set(item.id, item);
      if (
        item.tracker?.canonical === true &&
        item.grade === "RARE" &&
        item.obtainable &&
        item.level != null
      ) {
        canonicalByLevel.set(item.level, item.id);
      }
    }
    cachedCatalogIndex = { catalog, byId, canonicalByLevel };
  }
  return cachedCatalogIndex;
}

/**
 * Resolve a Player.log ItemKey to its canonical tracker box id, using the
 * cached index for O(1) lookups. Mirrors `canonicalTrackerBoxId` in
 * `stageBoxTracker.ts` but skips the per-call catalog reload and linear scans.
 */
function canonicalTrackerBoxIdFromIndex(
  itemKey: number,
  index: StageBoxCatalogIndex,
): number | null {
  const item = index.byId.get(itemKey);
  if (!item || item.grade !== "RARE" || !item.obtainable) return null;
  if (item.tracker?.canonical) return item.id;
  if (item.level == null) return null;
  return index.canonicalByLevel.get(item.level) ?? null;
}

/** Resolve a Player.log ItemKey to a tracked common, rare, or act stage box. */
export function resolveStageBoxDrop(itemKey: number): ResolvedStageBoxDrop | null {
  const index = getStageBoxCatalogIndex();
  const canonicalId = canonicalTrackerBoxIdFromIndex(itemKey, index);
  const lookupKey = canonicalId ?? itemKey;
  const item = index.byId.get(lookupKey);
  if (item) {
    if (item.grade === "COMMON") {
      return { itemKey: lookupKey, name: item.name, category: "common" };
    }
    if (item.grade === "RARE") {
      return { itemKey: lookupKey, name: item.name, category: "rare" };
    }
    return null;
  }

  const category = categoryFromPrefix(lookupKey);
  if (!category) return null;
  const fallbackName =
    category === "common"
      ? `Common chest #${lookupKey}`
      : category === "rare"
        ? `Stage boss chest #${lookupKey}`
        : `Act boss chest #${lookupKey}`;
  return {
    itemKey: lookupKey,
    name: fallbackName,
    category,
  };
}

/**
 * Collapse a burst of live `GetBox` entries into the drops to record.
 *
 * The game appends multiple `GetBoxLog` entries for a single chest-drop event
 * (a burst), and the burst for one drop is a single category, so each category
 * is collapsed to one recorded drop. Every category that appears in the burst
 * is kept (even a lone singleton) — see {@link collapseLiveChestDrops}.
 *
 * This function is pure and stateless; it does not see tick boundaries. A burst
 * that straddles multiple reader ticks must first be accumulated by
 * {@link LiveChestDropAggregator}, which calls this on the full cross-tick
 * buffer once the burst goes silent. Calling it per-tick on a split burst would
 * record one drop per tick.
 */
export function collapseLiveChestDrops(categories: ChestDropCategory[]): ChestDropCategory[] {
  if (categories.length === 0) return [];
  const counts = new Map<ChestDropCategory, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (counts.size === 1) return [categories[0]];

  // Every category present in a burst is kept — including a lone singleton.
  // A stage-boss (rare) or act-boss (act) chest can legitimately produce a
  // single GetBoxLog entry, and suppressing it when it rides alongside another
  // category's burst (the old behavior) dropped real boss drops whenever a boss
  // chest and a common chest landed in the same read window ("sometimes fails
  // to recognize"). Category decoding (monsterType 0/1/2) is already
  // race-guarded upstream (CHEST_LOG_SAMPLES), so a stray misclassified entry
  // is rare — and the cost of a false rare/act (a spurious BoxTimer cooldown
  // that cools down and re-arms) is far lower than dropping a real boss drop.
  return [...counts.keys()];
}

/**
 * Diagnostic event from {@link LiveChestDropAggregator.feed}, for logging in
 * the main layer. Emitted every feed call so the caller can reconstruct the
 * cross-tick burst behavior and confirm whether bursts straddle ticks (the
 * duplicate-drop root cause this aggregator guards against).
 */
export interface ChestAggregatorFeedEvent {
  /** Wall-clock seconds passed to this feed. */
  at: number;
  /** Raw categories fed this tick (before collapse). */
  inputCategories: ChestDropCategory[];
  /** Collapsed categories returned this tick (the drops to record). */
  flushedCategories: ChestDropCategory[];
  /** Buffer length after this feed (pending categories not yet flushed). */
  bufferSizeAfter: number;
  /** True when this feed flushed a stale buffer before accumulating input. */
  flushedStale: boolean;
}

/**
 * Stateful aggregator that buffers live chest-drop categories across reader
 * ticks and collapses a burst exactly once when it goes silent.
 *
 * The game appends a burst of `GetBoxLog` entries per chest-drop event, but the
 * burst can straddle multiple reader ticks (the reader polls at ~25 Hz while
 * the game appends entries across frames). Per-tick collapsing alone would
 * record one drop per tick whenever a burst splits — this aggregator
 * accumulates categories across ticks and only collapses (via
 * {@link collapseLiveChestDrops}) once `burstGapSec` has passed with no new
 * entries, so a single drop is recorded exactly once even when its burst
 * straddles ticks.
 *
 * Typical usage (caller owns wall-clock seconds):
 *
 * ```ts
 * for (const tick of readerTicks) {
 *   for (const category of agg.feed(tick.chestDrops ?? [], tick.at / 1000)) {
 *     tracker.recordLiveChestDrop(category, tick.at / 1000);
 *   }
 * }
 * ```
 */
export class LiveChestDropAggregator {
  private buffer: ChestDropCategory[] = [];
  private lastFeedAt: number | null = null;

  constructor(
    private readonly burstGapSec: number = 0.5,
    private readonly onFeed?: (e: ChestAggregatorFeedEvent) => void,
  ) {}

  reset(): void {
    this.buffer = [];
    this.lastFeedAt = null;
  }

  /**
   * Feed one tick's raw categories at wall-clock time `at` (seconds). Returns
   * the collapsed categories to record this tick:
   *   - When the pending buffer has gone stale (gap > burstGapSec since the
   *     last entry), the previous burst is flushed (collapsed) and returned
   *     before this tick's categories seed a new buffer.
   *   - Otherwise (categories flowing within the gap, or first feed), the
   *     categories accumulate into the buffer and `[]` is returned.
   *   - An empty tick with a stale buffer flushes it; an empty tick within
   *     the gap keeps the buffer pending.
   *
   * Call every tick (even when `categories` is empty) so silence-based flushes
   * fire promptly. Use {@link flush} to force the pending buffer out (e.g.
   * before reading stats or on teardown).
   */
  feed(categories: ChestDropCategory[], at: number): ChestDropCategory[] {
    let flushedStale = false;
    let flushed: ChestDropCategory[] = [];
    if (
      this.buffer.length > 0 &&
      this.lastFeedAt != null &&
      at - this.lastFeedAt > this.burstGapSec
    ) {
      flushedStale = true;
      flushed = collapseLiveChestDrops(this.buffer);
      this.buffer = [];
    }

    if (categories.length > 0) {
      this.buffer.push(...categories);
      this.lastFeedAt = at;
    } else if (flushed.length > 0 || this.buffer.length === 0) {
      this.lastFeedAt = null;
    }

    this.onFeed?.({
      at,
      inputCategories: categories,
      flushedCategories: flushed,
      bufferSizeAfter: this.buffer.length,
      flushedStale,
    });

    return flushed;
  }

  /** Force-flush the pending buffer; returns the collapsed categories. */
  flush(): ChestDropCategory[] {
    if (this.buffer.length === 0) {
      this.lastFeedAt = null;
      return [];
    }
    const collapsed = collapseLiveChestDrops(this.buffer);
    this.buffer = [];
    this.lastFeedAt = null;
    return collapsed;
  }
}

export class ChestDropTracker {
  private countsByKey = new Map<string, number>();
  private namesByKey = new Map<string, string>();
  private categoriesByKey = new Map<string, ChestDropCategory>();
  private history: ChestDropHistoryEntry[] = [];
  private readonly callbacks?: ChestDropTrackerCallbacks;

  /**
   * Live-path drop "credits" per category: wall-clock seconds of each drop the
   * live reader recorded directly (`source: "live"`). AutoClassifyService's save
   * reconcile claims these (via {@link claimLiveDropCredits}) when it sees a
   * save slot increase, so drops live ALREADY recorded are not counted a SECOND
   * time by the backfill compensation — the duplicate "chest drop" history
   * entry the user saw (~4s apart, stamped at reconcile time).
   *
   * A plain per-cycle delta cannot work here: `reconcileWithChestSlots` fires at
   * ~25 Hz on v1.2.2 (`setLiveSlots(null)` re-reconciles every live frame), so
   * any mark would be reset by intervening no-op reconciles before the lagging
   * save slot increase appears. Time-bounded credits survive that.
   */
  private liveCreditsByCategory: Record<ChestDropCategory, number[]> = {
    common: [],
    rare: [],
    act: [],
  };

  // Incremental mirrors of getStats()'s hot-path scans, maintained on append.
  private lastRareWallTime: number | null = null;
  private rareInHistory = 0;
  private recentEntries: Array<{ wallTime: number; category: ChestDropCategory }> = [];
  private recentCounts: Record<ChestDropCategory, number> = { common: 0, rare: 0, act: 0 };

  // Cached arrays — only rebuilt when drops are recorded. getStats() is called
  // at 5 Hz but the breakdown/history content changes rarely, so caching avoids
  // ~10 array allocations/sec.
  private breakdownCache: ChestDropBreakdownRow[] | null = null;
  private historyCache: ChestDropHistoryEntry[] | null = null;

  /**
   * Snapshot of countsByKey taken at the last session reset. perHour rates are
   * computed from (currentCounts - baselineCounts) so that resetting a session
   * zeroes the rates without wiping the cumulative drop history. An empty map
   * means everything counts toward the session (fresh start).
   */
  private sessionBaselineByKey = new Map<string, number>();

  /**
   * When tracking began (constructor / {@link reset}). The perHour rate window
   * starts no later than this moment, guaranteed by `sessionDropStart ??=
   * min(trackingStartedAt, firstDropWallTime)`. That way a *fresh* session
   * counts the time spent waiting for the first drop (a box arriving 6 min
   * after launch reads 1/6min ≈ 10/hr, not a 60/hr spike), while a drop whose
   * wallTime predates tracking (restored/historical save log) still anchors to
   * its own real drop time instead of the later launch moment.
   */
  private trackingStartedAt: number;

  /**
   * Wall time anchoring the perHour rate window. Null until the first recorded
   * drop (or an restore with no history); once set it stays pinned to
   * `min(trackingStartedAt, firstDropWallTime)` — the start of the actual
   * farming stretch. {@link applySnapshot} overrides it to the earliest
   * restored drop so restored history that spans idle time contributes to the
   * rate window. `null` only survives a track period with no recorded drop;
   * perHour returns 0 in that case.
   */
  private sessionDropStart: number | null = null;

  constructor(callbacks?: ChestDropTrackerCallbacks) {
    this.callbacks = callbacks;
    this.trackingStartedAt = nowSeconds();
  }

  reset(): void {
    this.countsByKey.clear();
    this.namesByKey.clear();
    this.categoriesByKey.clear();
    this.history = [];
    this.breakdownCache = null;
    this.historyCache = null;
    this.sessionBaselineByKey.clear();
    // Drop all outstanding live credits: a fresh session's reconcile should not
    // discount a save increase against a drop recorded before the reset.
    this.liveCreditsByCategory = { common: [], rare: [], act: [] };
    // Restart both the tracking clock and the rate anchor on reset so a fresh
    // session counts from the moment the user clears, not from the first drop.
    this.trackingStartedAt = nowSeconds();
    this.sessionDropStart = null;
    this.rebuildIncrementalCaches();
  }

  /** Single choke point for history growth — updates the incremental caches. */
  private appendHistory(entry: ChestDropHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) {
      // Only ever one entry past the limit, so `shift()` is equivalent to the
      // former `splice(0, length - HISTORY_LIMIT)`. Track a evicted rare so
      // lastRareWallTime stays accurate when the last rare leaves the window.
      const removed = this.history.shift()!;
      if (removed.category === "rare") this.rareInHistory--;
    }
    if (entry.category === "rare") {
      this.rareInHistory++;
      this.lastRareWallTime = entry.wallTime;
    }
    this.recentEntries.push({ wallTime: entry.wallTime, category: entry.category });
    this.recentCounts[entry.category]++;
    this.drainRecentEntries(nowSeconds() - ROLLING_HOUR_SEC);
    this.historyCache = null;
  }

  private drainRecentEntries(cutoff: number): void {
    // History can receive out-of-order wallTimes (Player.log / restore), so do
    // not assume recentEntries is sorted — filter instead of shifting a head.
    const kept: Array<{ wallTime: number; category: ChestDropCategory }> = [];
    for (const entry of this.recentEntries) {
      if (entry.wallTime < cutoff) {
        this.recentCounts[entry.category]--;
      } else {
        kept.push(entry);
      }
    }
    this.recentEntries = kept;
  }

  /** Rebuild all incremental caches by replaying the current history. */
  private rebuildIncrementalCaches(): void {
    this.lastRareWallTime = null;
    this.rareInHistory = 0;
    this.recentEntries = [];
    this.recentCounts = { common: 0, rare: 0, act: 0 };
    for (const entry of this.history) {
      if (entry.category === "rare") {
        this.rareInHistory++;
        this.lastRareWallTime = entry.wallTime;
      }
      this.recentEntries.push({ wallTime: entry.wallTime, category: entry.category });
      this.recentCounts[entry.category]++;
    }
  }

  /**
   * Record a live chest drop with an explicit category read from the GetBox
   * battle log (`common` / `rare` = stage boss / `act` = act boss). Aggregated
   * per category since the drop's item key is not carried in the log.
   *
   * `source` distinguishes the two writers:
   *   - `"live"` (default): the live-memory reader detected the drop directly.
   *   - `"reconcile"`: AutoClassifyService's save-backfill compensation
   *     recovered a drop the live reader missed.
   * Only `"live"` records push a credit (see {@link claimLiveDropCredits}), so
   * the reconcile compensation can discount drops it already recorded via live
   * and avoid double-bookkeeping a single chest.
   */
  recordLiveChestDrop(
    category: ChestDropCategory,
    wallTime = nowSeconds(),
    source: "live" | "reconcile" = "live",
  ): boolean {
    const itemKey = LIVE_CHEST_KEY[category];
    const key = String(itemKey);
    const name = LIVE_CHEST_NAME[category];

    this.countsByKey.set(key, (this.countsByKey.get(key) ?? 0) + 1);
    this.namesByKey.set(key, name);
    this.categoriesByKey.set(key, category);
    if (source === "live") {
      const credits = this.liveCreditsByCategory[category];
      credits.push(wallTime);
      const overflow = credits.length - LIVE_CREDIT_MAX;
      if (overflow > 0) credits.splice(0, overflow);
    }

    this.appendHistory({ wallTime, itemKey, name, category });
    this.breakdownCache = null;
    this.sessionDropStart ??= Math.min(this.trackingStartedAt, wallTime);
    this.callbacks?.onDrop?.({ category, wallTime });
    return true;
  }

  /**
   * Claim up to `requested` live-path drop credits for `category`, returning how
   * many were covered (i.e., how many of the save's slot increase are drops the
   * live reader ALREADY recorded and the reconcile must NOT compensate again).
   * Claimed credits are removed; expired ones (older than
   * {@link LIVE_CREDIT_TTL_SEC}) are dropped first so a stale credit can't
   * suppress a genuine later miss.
   *
   * Called by AutoClassifyService once per reconcile, right before deciding the
   * compensation count. `nowSec` is injectable for tests.
   */
  claimLiveDropCredits(
    category: ChestDropCategory,
    requested: number,
    nowSec = nowSeconds(),
  ): number {
    if (requested <= 0) return 0;
    const credits = this.liveCreditsByCategory[category];
    const cutoff = nowSec - LIVE_CREDIT_TTL_SEC;
    while (credits.length > 0 && credits[0]! < cutoff) credits.shift();
    const covered = Math.min(requested, credits.length);
    if (covered > 0) credits.splice(0, covered);
    return covered;
  }

  recordLogDrop(itemKey: number, wallTime = nowSeconds()): boolean {
    const resolved = resolveStageBoxDrop(itemKey);
    if (!resolved) return false;

    const key = String(resolved.itemKey);
    this.countsByKey.set(key, (this.countsByKey.get(key) ?? 0) + 1);
    this.namesByKey.set(key, resolved.name);
    this.categoriesByKey.set(key, resolved.category);

    this.appendHistory({
      wallTime,
      itemKey: resolved.itemKey,
      name: resolved.name,
      category: resolved.category,
    });

    this.breakdownCache = null;
    this.sessionDropStart ??= Math.min(this.trackingStartedAt, wallTime);
    this.callbacks?.onDrop?.({
      category: resolved.category,
      wallTime,
      itemKey: resolved.itemKey,
    });
    return true;
  }

  getStats(_elapsedSeconds: number): ChestDropStats {
    let commonTotal = 0;
    let rareTotal = 0;
    let actTotal = 0;

    // Reuse cached breakdown array when no new drops were recorded since the
    // last call — avoids rebuilding the array at 5 Hz when content is unchanged.
    if (this.breakdownCache === null) {
      const breakdown: ChestDropBreakdownRow[] = [];
      for (const [key, count] of this.countsByKey) {
        if (count <= 0) continue;
        const category = this.categoriesByKey.get(key);
        const name = this.namesByKey.get(key);
        if (!category || !name) continue;

        if (category === "common") commonTotal += count;
        else if (category === "rare") rareTotal += count;
        else actTotal += count;

        breakdown.push({
          itemKey: Number.parseInt(key, 10),
          name,
          category,
          count,
        });
      }
      breakdown.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      this.breakdownCache = breakdown;
    } else {
      // Recompute totals from the cached breakdown (cheap, no allocation).
      for (const row of this.breakdownCache) {
        if (row.category === "common") commonTotal += row.count;
        else if (row.category === "rare") rareTotal += row.count;
        else actTotal += row.count;
      }
    }

    const breakdown = this.breakdownCache;

    // Reuse cached visible-history array when no new drops were recorded.
    if (this.historyCache === null) {
      this.historyCache = this.history.slice(-HISTORY_VISIBLE).reverse();
    }
    const history = this.historyCache;

    const combinedTotal = commonTotal + rareTotal + actTotal;
    // Use sessionDropStart as the perHour time anchor instead of
    // tracker.elapsed. After an app restart, tracker.elapsed may span hours
    // of idle time (from the restored sessionStart), making perHour =
    // sessionDelta / largeHours ≈ 0 even when fresh drops are being recorded.
    // For a fresh session, sessionDropStart is min(trackingStartedAt,
    // firstDropWallTime), so the time spent waiting for the first drop counts
    // — a box arriving 6 min after launch reads ~10/hr, not a 60/hr spike —
    // while a historical drop (save log predating launch) still anchors to its
    // real drop time. On restore it is the earliest restored drop so the window
    // spans the full session. When null (no drops yet), it stays clamped to
    // MIN_RATE_WINDOW_SEC.
    const dropElapsed =
      this.sessionDropStart !== null
        ? Math.max(MIN_RATE_WINDOW_SEC, nowSeconds() - this.sessionDropStart)
        : MIN_RATE_WINDOW_SEC;
    const hours = dropElapsed / 3600;

    // perHour rates use the session delta (current - baseline) so that a
    // session reset zeroes rates without wiping cumulative totals. Totals
    // (commonTotal/rareTotal/actTotal) remain cumulative for the breakdown.
    let sessionCommon = 0;
    let sessionRare = 0;
    let sessionAct = 0;
    for (const [key, baselineCount] of this.sessionBaselineByKey) {
      const currentCount = this.countsByKey.get(key) ?? 0;
      const delta = currentCount - baselineCount;
      if (delta <= 0) continue;
      const category = this.categoriesByKey.get(key);
      if (category === "common") sessionCommon += delta;
      else if (category === "rare") sessionRare += delta;
      else if (category === "act") sessionAct += delta;
    }
    // Keys absent from the baseline (new drops since reset) also count.
    for (const [key, count] of this.countsByKey) {
      if (this.sessionBaselineByKey.has(key)) continue;
      if (count <= 0) continue;
      const category = this.categoriesByKey.get(key);
      if (category === "common") sessionCommon += count;
      else if (category === "rare") sessionRare += count;
      else if (category === "act") sessionAct += count;
    }
    const commonPerHour = sessionCommon / hours;
    const rarePerHour = sessionRare / hours;
    const actPerHour = sessionAct / hours;
    const combinedSession = sessionCommon + sessionRare + sessionAct;

    // Mini overlay's boss-chest ring + "Box" countdown only track stage boss
    // (rare) drops — common chests drop too frequently to make a 7-min lap
    // meaningful. Maintained incrementally on append: `lastRareWallTime` holds
    // the most recent rare wallTime, and `rareInHistory` keeps it null-safe
    // when eviction removes the last rare entry from the bounded window.
    const lastRareDropWallTime = this.rareInHistory > 0 ? this.lastRareWallTime : null;

    // Rolling 1-hour rate: maintained incrementally in recentEntries +
    // recentCounts instead of scanning the full history at 5 Hz. `drain` prunes
    // entries older than the window so the cached tail stays small and bounded.
    // We track the earliest in-window wallTime to size the denominator: when the
    // first recent drop is younger than the window (e.g. session just started),
    // use (now - earliest) so the rate doesn't get divided by a full hour and
    // look artificially low.
    const nowSec = nowSeconds();
    this.drainRecentEntries(nowSec - ROLLING_HOUR_SEC);
    const commonRecent = this.recentCounts.common;
    const rareRecent = this.recentCounts.rare;
    const actRecent = this.recentCounts.act;
    let earliestRecentWallTime: number | null = null;
    for (const entry of this.recentEntries) {
      if (earliestRecentWallTime === null || entry.wallTime < earliestRecentWallTime) {
        earliestRecentWallTime = entry.wallTime;
      }
    }
    const recentWindowSec =
      earliestRecentWallTime !== null
        ? Math.max(MIN_RATE_WINDOW_SEC, Math.min(ROLLING_HOUR_SEC, nowSec - earliestRecentWallTime))
        : ROLLING_HOUR_SEC;
    const recentHours = recentWindowSec / 3600;
    const commonRecentPerHour = commonRecent / recentHours;
    const rareRecentPerHour = rareRecent / recentHours;
    const actRecentPerHour = actRecent / recentHours;

    return {
      commonTotal,
      rareTotal,
      actTotal,
      combinedTotal,
      commonPerHour,
      rarePerHour,
      actPerHour,
      commonRecentPerHour,
      rareRecentPerHour,
      actRecentPerHour,
      commonSession: sessionCommon,
      rareSession: sessionRare,
      actSession: sessionAct,
      combinedSession,
      breakdown,
      history,
      lastRareDropWallTime,
      readerRequired: true,
    };
  }

  captureSnapshot(): ChestDropTrackerSnapshot {
    return {
      countsByKey: Object.fromEntries(this.countsByKey),
      namesByKey: Object.fromEntries(this.namesByKey),
      categoriesByKey: Object.fromEntries(this.categoriesByKey),
      history: [...this.history],
    };
  }

  applySnapshot(data: ChestDropTrackerSnapshot): void {
    const isTracked = (category: string): category is ChestDropCategory =>
      category === "common" || category === "rare" || category === "act";

    const categoriesByKey = new Map(
      Object.entries(data.categoriesByKey).filter(([, category]) => isTracked(category)),
    );
    const keepKey = (key: string): boolean => categoriesByKey.has(key);

    this.categoriesByKey = categoriesByKey;
    this.countsByKey = new Map(Object.entries(data.countsByKey).filter(([key]) => keepKey(key)));
    this.namesByKey = new Map(Object.entries(data.namesByKey).filter(([key]) => keepKey(key)));
    // P1-8: cap restored history at HISTORY_LIMIT so a bloated or hand-edited
    // snapshot can't pin memory and make the `lastRareDropWallTime` reverse
    // scan unbounded. `recordLogDrop`/`recordLiveChestDrop` already truncate
    // on insert; this mirrors that bound on the restore path.
    const restored = (data.history ?? []).filter((entry) => isTracked(entry.category));
    this.history = restored.length > HISTORY_LIMIT ? restored.slice(-HISTORY_LIMIT) : restored;
    this.breakdownCache = null;
    this.historyCache = null;
    // Restored counts are part of the ongoing session — keep baseline empty
    // so all restored + future drops count toward session totals and rates.
    // This keeps commonSession/commonPerHour consistent with the displayed
    // totals: a 22h restored session with N drops shows N chests at N/22 hr,
    // not "1 chest at 6/hr" (the old baseline behavior that hid restored
    // counts and anchored perHour to only the post-restore drops).
    this.sessionBaselineByKey = new Map();
    // Anchor perHour to the earliest restored drop so the rate window spans
    // the full session history, not just post-restore drops.
    this.sessionDropStart = this.history.length > 0 ? this.history[0].wallTime : null;
    this.rebuildIncrementalCaches();
    // Restored sessions carry no live credits; clear any so the first
    // post-restore reconcile doesn't discount against pre-restore drops.
    this.liveCreditsByCategory = { common: [], rare: [], act: [] };
  }
}
