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
 * is collapsed to one recorded drop. When entries of both categories arrive in
 * the same burst, a lone singleton riding another category's burst is treated
 * as stray noise (e.g. a single "rare" entry surfacing amid a common-chest
 * burst, which would otherwise misidentify a common drop as a stage-boss drop)
 * and is suppressed — only categories that are themselves a burst (>= 2 entries)
 * or that appear as a pure 1:1 mix are kept.
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

  const hasBurst = [...counts.values()].some((n) => n >= 2);
  const kept: ChestDropCategory[] = [];
  for (const [cat, n] of counts) {
    // Keep a category when it is itself a burst, or when no category is a burst
    // (a pure 1:1 mix = two distinct single drops). Suppress lone singletons
    // that ride alongside another category's burst.
    if (n >= 2 || !hasBurst) kept.push(cat);
  }
  return kept;
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

  // Cached arrays — only rebuilt when drops are recorded. getStats() is called
  // at 5 Hz but the breakdown/history content changes rarely, so caching avoids
  // ~10 array allocations/sec.
  private breakdownCache: ChestDropBreakdownRow[] | null = null;
  private historyCache: ChestDropHistoryEntry[] | null = null;

  constructor(callbacks?: ChestDropTrackerCallbacks) {
    this.callbacks = callbacks;
  }

  reset(): void {
    this.countsByKey.clear();
    this.namesByKey.clear();
    this.categoriesByKey.clear();
    this.history = [];
    this.breakdownCache = null;
    this.historyCache = null;
  }

  /**
   * Record a live chest drop with an explicit category read from the GetBox
   * battle log (`common` / `rare` = stage boss / `act` = act boss). Aggregated
   * per category since the drop's item key is not carried in the log.
   */
  recordLiveChestDrop(category: ChestDropCategory, wallTime = nowSeconds()): boolean {
    const itemKey = LIVE_CHEST_KEY[category];
    const key = String(itemKey);
    const name = LIVE_CHEST_NAME[category];

    this.countsByKey.set(key, (this.countsByKey.get(key) ?? 0) + 1);
    this.namesByKey.set(key, name);
    this.categoriesByKey.set(key, category);

    this.history.push({ wallTime, itemKey, name, category });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.breakdownCache = null;
    this.historyCache = null;
    this.callbacks?.onDrop?.({ category, wallTime });
    return true;
  }

  recordLogDrop(itemKey: number, wallTime = nowSeconds()): boolean {
    const resolved = resolveStageBoxDrop(itemKey);
    if (!resolved) return false;

    const key = String(resolved.itemKey);
    this.countsByKey.set(key, (this.countsByKey.get(key) ?? 0) + 1);
    this.namesByKey.set(key, resolved.name);
    this.categoriesByKey.set(key, resolved.category);

    this.history.push({
      wallTime,
      itemKey: resolved.itemKey,
      name: resolved.name,
      category: resolved.category,
    });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }

    this.breakdownCache = null;
    this.historyCache = null;
    this.callbacks?.onDrop?.({
      category: resolved.category,
      wallTime,
      itemKey: resolved.itemKey,
    });
    return true;
  }

  getStats(elapsedSeconds: number): ChestDropStats {
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
    const hours = elapsedSeconds > 0 ? elapsedSeconds / 3600 : 0;
    const commonPerHour = hours > 0 ? commonTotal / hours : 0;
    const rarePerHour = hours > 0 ? rareTotal / hours : 0;
    const actPerHour = hours > 0 ? actTotal / hours : 0;

    let lastDropWallTime: number | null = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      lastDropWallTime = this.history[i].wallTime;
      break;
    }

    return {
      commonTotal,
      rareTotal,
      actTotal,
      combinedTotal,
      commonPerHour,
      rarePerHour,
      actPerHour,
      breakdown,
      history,
      lastDropWallTime,
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
    // snapshot can't pin memory and make the `lastRareWallTime` reverse scan
    // unbounded. `recordLogDrop`/`recordLiveChestDrop` already truncate on
    // insert; this mirrors that bound on the restore path.
    const restored = (data.history ?? []).filter((entry) => isTracked(entry.category));
    this.history = restored.length > HISTORY_LIMIT ? restored.slice(-HISTORY_LIMIT) : restored;
    this.breakdownCache = null;
    this.historyCache = null;
  }
}
