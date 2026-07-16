import type {
  ChestDropBreakdownRow,
  ChestDropHistoryEntry,
  ChestDropStats,
  ChestDropTrackerSnapshot,
} from "../../shared/types";
import { canonicalTrackerBoxId, loadStageBoxCatalogFile } from "./stageBoxTracker";

export type ChestDropCategory = "common" | "rare";

/**
 * Live chest drops from the GetBox battle log carry no item key, only a
 * category. They are aggregated into these synthetic per-category buckets.
 */
const LIVE_CHEST_KEY: Record<ChestDropCategory, number> = {
  common: 900910,
  rare: 900920,
};
const LIVE_CHEST_NAME: Record<ChestDropCategory, string> = {
  common: "Common chest",
  rare: "Stage boss chest",
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
  return null;
}

/** Resolve a Player.log ItemKey to a tracked common or rare stage box. */
export function resolveStageBoxDrop(itemKey: number): ResolvedStageBoxDrop | null {
  const catalog = loadStageBoxCatalogFile();
  const canonicalId = canonicalTrackerBoxId(itemKey, catalog);
  const lookupKey = canonicalId ?? itemKey;
  const item = catalog.items.find((entry) => entry.id === lookupKey);
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
  return {
    itemKey: lookupKey,
    name: category === "common" ? `Common chest #${lookupKey}` : `Stage boss chest #${lookupKey}`,
    category,
  };
}

export class ChestDropTracker {
  private countsByKey = new Map<string, number>();
  private namesByKey = new Map<string, string>();
  private categoriesByKey = new Map<string, ChestDropCategory>();
  private history: ChestDropHistoryEntry[] = [];

  // Cached arrays — only rebuilt when drops are recorded. getStats() is called
  // at 5 Hz but the breakdown/history content changes rarely, so caching avoids
  // ~10 array allocations/sec.
  private breakdownCache: ChestDropBreakdownRow[] | null = null;
  private historyCache: ChestDropHistoryEntry[] | null = null;

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
   * battle log (`common` / `rare` = stage boss). Aggregated per
   * category since the drop's item key is not carried in the log.
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
    return true;
  }

  getStats(elapsedSeconds: number): ChestDropStats {
    let commonTotal = 0;
    let rareTotal = 0;

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
        else rareTotal += count;

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
        else rareTotal += row.count;
      }
    }

    const breakdown = this.breakdownCache;

    // Reuse cached visible-history array when no new drops were recorded.
    if (this.historyCache === null) {
      this.historyCache = this.history.slice(-HISTORY_VISIBLE).reverse();
    }
    const history = this.historyCache;

    const combinedTotal = commonTotal + rareTotal;
    const hours = elapsedSeconds > 0 ? elapsedSeconds / 3600 : 0;
    const commonPerHour = hours > 0 ? commonTotal / hours : 0;
    const rarePerHour = hours > 0 ? rareTotal / hours : 0;

    let lastRareWallTime: number | null = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].category === "rare") {
        lastRareWallTime = this.history[i].wallTime;
        break;
      }
    }

    return {
      commonTotal,
      rareTotal,
      combinedTotal,
      commonPerHour,
      rarePerHour,
      breakdown,
      history,
      lastDropWallTime: lastRareWallTime,
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
      category === "common" || category === "rare";

    const categoriesByKey = new Map(
      Object.entries(data.categoriesByKey).filter(([, category]) => isTracked(category)),
    );
    const keepKey = (key: string): boolean => categoriesByKey.has(key);

    this.categoriesByKey = categoriesByKey;
    this.countsByKey = new Map(Object.entries(data.countsByKey).filter(([key]) => keepKey(key)));
    this.namesByKey = new Map(Object.entries(data.namesByKey).filter(([key]) => keepKey(key)));
    this.history = (data.history ?? []).filter((entry) => isTracked(entry.category));
    this.breakdownCache = null;
    this.historyCache = null;
  }
}
