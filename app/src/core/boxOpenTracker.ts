// Box-open outcome tracker: records per-box item drops and aggregates stats.
// Pure: no Electron, no React, no fs. Mirrors ChestDropTracker structure.

import type {
  BoxOpenBreakdownRow,
  BoxOpenHistoryEntry,
  BoxOpenStats,
  BoxOpenTrackerSnapshot,
} from "../../shared/types";
import { boxLabel, categoryFromBoxKey, levelFromBoxKey } from "./boxOpenLog";

const HISTORY_LIMIT = 500;
const HISTORY_VISIBLE = 50;

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Price resolver callback: returns buy-order unit price for an itemKey, or null. */
export type BoxOpenPriceResolver =
  | ((itemKey: number) => { buyOrderUnit: number | null } | null)
  | null;

export class BoxOpenTracker {
  /** boxKey -> (itemKey -> count). */
  private countsByKey = new Map<string, Map<string, number>>();
  /** itemKey -> name (shared across all boxKeys). */
  private namesByKey = new Map<string, string>();
  /** itemKey -> grade (shared across all boxKeys). */
  private gradesByKey = new Map<string, string | null>();
  private history: BoxOpenHistoryEntry[] = [];

  /**
   * Record a box open. Aggregates the count under (boxKey, itemKey) and appends
   * a history entry. `wallTime` defaults to now; pass an explicit value for
   * snapshot restore or test determinism.
   */
  recordOpen(
    boxKey: string,
    itemKey: number,
    name: string,
    grade: string | null,
    count: number,
    wallTime: number = nowSeconds(),
  ): void {
    let itemMap = this.countsByKey.get(boxKey);
    if (!itemMap) {
      itemMap = new Map();
      this.countsByKey.set(boxKey, itemMap);
    }
    const key = String(itemKey);
    itemMap.set(key, (itemMap.get(key) ?? 0) + count);
    this.namesByKey.set(key, name);
    this.gradesByKey.set(key, grade);

    this.history.push({ wallTime, boxKey, itemKey, itemName: name, grade, count });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
  }

  /** Compute aggregated stats for all boxKeys, resolving prices via `priceResolver`. */
  getStats(sessionSeconds: number, priceResolver: BoxOpenPriceResolver): BoxOpenStats[] {
    const hours = sessionSeconds > 0 ? sessionSeconds / 3600 : 0;
    const stats: BoxOpenStats[] = [];

    for (const [boxKey, itemMap] of this.countsByKey) {
      const category = categoryFromBoxKey(boxKey);
      if (category == null) continue;

      const level = levelFromBoxKey(boxKey);
      let totalOpens = 0;
      let totalBuyOrderValue: number | null = null;
      const breakdown: BoxOpenBreakdownRow[] = [];

      for (const [itemKeyStr, count] of itemMap) {
        if (count <= 0) continue;
        const itemKey = Number.parseInt(itemKeyStr, 10);
        const name = this.namesByKey.get(itemKeyStr) ?? `#${itemKey}`;
        const grade = this.gradesByKey.get(itemKeyStr) ?? null;
        totalOpens += count;

        const priceInfo = priceResolver ? priceResolver(itemKey) : null;
        const buyOrderUnit = priceInfo?.buyOrderUnit ?? null;
        const buyOrderValue = buyOrderUnit != null ? buyOrderUnit * count : null;
        const hourlyValue = buyOrderValue != null && hours > 0 ? buyOrderValue / hours : null;

        if (buyOrderValue != null) {
          totalBuyOrderValue = (totalBuyOrderValue ?? 0) + buyOrderValue;
        }

        breakdown.push({
          itemKey,
          name,
          grade,
          count,
          dropPct: 0, // filled after totalOpens is known
          buyOrderUnit,
          buyOrderValue,
          hourlyValue,
        });
      }

      if (totalOpens === 0) continue;

      // Fill dropPct now that totalOpens is final.
      for (const row of breakdown) {
        row.dropPct = totalOpens > 0 ? row.count / totalOpens : 0;
      }

      breakdown.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      const boxHistory = this.history
        .filter((h) => h.boxKey === boxKey)
        .slice(-HISTORY_VISIBLE)
        .reverse();

      const lastOpenWallTime = boxHistory.length > 0 ? boxHistory[0].wallTime : null;

      const hourlyValue =
        totalBuyOrderValue != null && hours > 0 ? totalBuyOrderValue / hours : null;

      stats.push({
        boxKey,
        label: boxLabel(boxKey),
        category,
        level,
        totalOpens,
        totalBuyOrderValue,
        hourlyValue,
        breakdown,
        history: boxHistory,
        lastOpenWallTime,
      });
    }

    stats.sort((a, b) => {
      if (a.category !== b.category) {
        const order: Record<string, number> = { common: 0, rare: 1, act: 2 };
        return (order[a.category] ?? 9) - (order[b.category] ?? 9);
      }
      const al = a.level ?? -1;
      const bl = b.level ?? -1;
      return al - bl;
    });

    return stats;
  }

  /** Reset a single boxKey: clears its counts and history entries. */
  resetBox(boxKey: string): void {
    this.countsByKey.delete(boxKey);
    this.history = this.history.filter((h) => h.boxKey !== boxKey);
  }

  /** Reset all boxKeys. */
  resetAll(): void {
    this.countsByKey.clear();
    this.namesByKey.clear();
    this.gradesByKey.clear();
    this.history = [];
  }

  /** Serialize for session_state.json. */
  captureSnapshot(): BoxOpenTrackerSnapshot {
    const countsByKey: Record<string, Record<string, number>> = {};
    for (const [boxKey, itemMap] of this.countsByKey) {
      countsByKey[boxKey] = Object.fromEntries(itemMap);
    }
    return {
      countsByKey,
      namesByKey: Object.fromEntries(this.namesByKey),
      gradesByKey: Object.fromEntries(this.gradesByKey),
      history: [...this.history],
    };
  }

  /** Restore from a session_state.json snapshot. */
  applySnapshot(data: BoxOpenTrackerSnapshot): void {
    this.countsByKey.clear();
    this.namesByKey.clear();
    this.gradesByKey.clear();
    this.history = [];

    for (const [boxKey, itemMap] of Object.entries(data.countsByKey ?? {})) {
      const m = new Map<string, number>();
      for (const [itemKey, count] of Object.entries(itemMap)) {
        m.set(itemKey, count);
      }
      this.countsByKey.set(boxKey, m);
    }
    for (const [itemKey, name] of Object.entries(data.namesByKey ?? {})) {
      this.namesByKey.set(itemKey, name);
    }
    for (const [itemKey, grade] of Object.entries(data.gradesByKey ?? {})) {
      this.gradesByKey.set(itemKey, grade);
    }
    this.history = [...(data.history ?? [])];
  }
}
