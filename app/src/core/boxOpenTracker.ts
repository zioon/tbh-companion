// Box-open outcome tracker: records per-box item drops and aggregates stats.
// Pure: no Electron, no React, no fs. Mirrors ChestDropTracker structure.

import type {
  BoxOpenBreakdownRow,
  BoxOpenHistoryEntry,
  BoxOpenStats,
  BoxOpenTrackerSnapshot,
} from "../../shared/types";
import { boxLabel, categoryFromBoxKey, levelFromBoxKey, UNCLASSIFIED_BOX_KEY } from "./boxOpenLog";

/** Optional subscriber hook for unclassified box-open bursts. */
export interface BoxOpenTrackerCallbacks {
  /**
   * Fired (via microtask flush) whenever `recordOpen` lands items in
   * `UNCLASSIFIED_BOX_KEY`. Multiple `recordOpen` calls in the same tick
   * are batched into one callback to avoid N callbacks for one chest's burst.
   */
  onUnclassified?: (entries: readonly BoxOpenHistoryEntry[]) => void;
}

const HISTORY_LIMIT = 500;
const HISTORY_VISIBLE = 50;

/**
 * Build the composite map key for per-(itemKey, grade) counting. v1.00.28 can
 * drop the same itemKey at different grades (COMMON/RARE/EPIC variants via
 * GradeSO.eGRADE), so grade must be part of the grouping key — otherwise
 * different-grade drops of the same item merge into one row and the grade
 * gets overwritten by whichever was recorded last.
 *
 * Format: `"${itemKey}|${grade ?? ""}"`. Parse with {@link parseCompositeKey}.
 */
function compositeKey(itemKey: number, grade: string | null): string {
  return `${itemKey}|${grade ?? ""}`;
}

/** Split a composite key back into itemKey + grade. */
function parseCompositeKey(key: string): { itemKey: number; grade: string | null } {
  const sep = key.indexOf("|");
  if (sep === -1) {
    // Legacy snapshot format (pre grade-split): key is bare itemKey, grade
    // unknown — callers should fall back to gradesByKey.
    return { itemKey: Number.parseInt(key, 10), grade: null };
  }
  const itemKey = Number.parseInt(key.slice(0, sep), 10);
  const gradeStr = key.slice(sep + 1);
  return { itemKey, grade: gradeStr === "" ? null : gradeStr };
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Price resolver callback: returns buy-order unit price for an itemKey, or null. */
export type BoxOpenPriceResolver =
  | ((itemKey: number) => { buyOrderUnit: number | null } | null)
  | null;

/**
 * Per-boxKey base aggregate cached for `getStats`. Contains everything that
 * depends only on tracker state (not on the external price resolver or the
 * session-seconds argument), so it can be reused across the 5 Hz `getStats`
 * calls that fire on every stats broadcast.
 */
interface BoxOpenBaseAggregate {
  totalOpens: number;
  /** Items sorted by count desc, name asc — price fields filled by `getStats`. */
  breakdownBase: Array<{
    itemKey: number;
    name: string;
    grade: string | null;
    count: number;
  }>;
  /** Visible history slice (last N entries, reversed). */
  history: BoxOpenHistoryEntry[];
  lastOpenWallTime: number | null;
}

export class BoxOpenTracker {
  /** boxKey -> (itemKey -> count). */
  private countsByKey = new Map<string, Map<string, number>>();
  /** itemKey -> name (shared across all boxKeys). */
  private namesByKey = new Map<string, string>();
  /** itemKey -> grade (shared across all boxKeys). */
  private gradesByKey = new Map<string, string | null>();
  private history: BoxOpenHistoryEntry[] = [];
  private readonly callbacks?: BoxOpenTrackerCallbacks;
  private pendingUnclassified: BoxOpenHistoryEntry[] = [];
  private flushScheduled = false;

  constructor(callbacks?: BoxOpenTrackerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Cached per-boxKey base aggregates (everything that does NOT depend on the
   * external price resolver or `sessionSeconds`). `getStats` is called at 5 Hz
   * by the stats broadcast; without this cache each call walked `history`
   * (up to 500 entries) per boxKey to filter+slice+reverse, plus rebuilt the
   * breakdown base array. With 20 tracked boxKeys that was ~50k operations
   * per second of redundant work. Invalidated on every state-mutating call
   * (recordOpen / reclassifyItem / resetBox / resetAll / applySnapshot).
   */
  private baseAggregateCache: Map<string, BoxOpenBaseAggregate> | null = null;

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
    const key = compositeKey(itemKey, grade);
    itemMap.set(key, (itemMap.get(key) ?? 0) + count);
    this.namesByKey.set(key, name);
    this.gradesByKey.set(key, grade);

    this.history.push({ wallTime, boxKey, itemKey, itemName: name, grade, count });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.baseAggregateCache = null;

    if (boxKey === UNCLASSIFIED_BOX_KEY && this.callbacks?.onUnclassified) {
      this.pendingUnclassified.push({
        wallTime,
        boxKey,
        itemKey,
        itemName: name,
        grade,
        count,
      });
      this.scheduleUnclassifiedFlush();
    }
  }

  private scheduleUnclassifiedFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Microtask: batch all recordOpen calls in the current sync tick into one
    // callback. The live reader processes a burst of BoxOpenLog entries per
    // tick (one chest's items), so this fires once per chest rather than once
    // per item.
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushUnclassified();
    });
  }

  /** Flush pending unclassified entries to the callback. Public for tests. */
  flushUnclassified(): void {
    if (this.pendingUnclassified.length === 0) return;
    const batch = this.pendingUnclassified;
    this.pendingUnclassified = [];
    this.flushScheduled = false;
    this.callbacks?.onUnclassified?.(batch);
  }

  /** Compute aggregated stats for all boxKeys, resolving prices via `priceResolver`. */
  getStats(sessionSeconds: number, priceResolver: BoxOpenPriceResolver): BoxOpenStats[] {
    const hours = sessionSeconds > 0 ? sessionSeconds / 3600 : 0;
    const base = this.getBaseAggregates();
    const stats: BoxOpenStats[] = [];

    for (const [boxKey, agg] of base) {
      const category = categoryFromBoxKey(boxKey);
      if (category == null) continue;

      const level = levelFromBoxKey(boxKey);
      let totalBuyOrderValue: number | null = null;
      const breakdown: BoxOpenBreakdownRow[] = [];

      for (const baseRow of agg.breakdownBase) {
        const priceInfo = priceResolver ? priceResolver(baseRow.itemKey) : null;
        const buyOrderUnit = priceInfo?.buyOrderUnit ?? null;
        const buyOrderValue = buyOrderUnit != null ? buyOrderUnit * baseRow.count : null;
        const hourlyValue = buyOrderValue != null && hours > 0 ? buyOrderValue / hours : null;

        if (buyOrderValue != null) {
          totalBuyOrderValue = (totalBuyOrderValue ?? 0) + buyOrderValue;
        }

        breakdown.push({
          itemKey: baseRow.itemKey,
          name: baseRow.name,
          grade: baseRow.grade,
          count: baseRow.count,
          dropPct: agg.totalOpens > 0 ? baseRow.count / agg.totalOpens : 0,
          buyOrderUnit,
          buyOrderValue,
          hourlyValue,
        });
      }

      const hourlyValue =
        totalBuyOrderValue != null && hours > 0 ? totalBuyOrderValue / hours : null;

      stats.push({
        boxKey,
        label: boxLabel(boxKey),
        category,
        level,
        totalOpens: agg.totalOpens,
        totalBuyOrderValue,
        hourlyValue,
        breakdown,
        history: agg.history,
        lastOpenWallTime: agg.lastOpenWallTime,
      });
    }

    stats.sort((a, b) => {
      if (a.category !== b.category) {
        // unclassified sorts first so the user sees items needing manual
        // reclassification without scrolling past already-categorized boxes.
        const order: Record<string, number> = { unclassified: 0, common: 1, rare: 2, act: 3 };
        return (order[a.category] ?? 9) - (order[b.category] ?? 9);
      }
      const al = a.level ?? -1;
      const bl = b.level ?? -1;
      return al - bl;
    });

    return stats;
  }

  /**
   * Build (and cache) the per-boxKey base aggregates: `breakdownBase` (items
   * sorted by count), the visible history slice (last N, reversed), and
   * `totalOpens`. The cache is invalidated by every state mutation; `getStats`
   * only reads it.
   */
  private getBaseAggregates(): Map<string, BoxOpenBaseAggregate> {
    if (this.baseAggregateCache !== null) return this.baseAggregateCache;

    // Group history by boxKey once, so each boxKey's visible slice is a single
    // slice+reverse rather than a full filter pass.
    const historyByBox = new Map<string, BoxOpenHistoryEntry[]>();
    for (const entry of this.history) {
      let arr = historyByBox.get(entry.boxKey);
      if (!arr) {
        arr = [];
        historyByBox.set(entry.boxKey, arr);
      }
      arr.push(entry);
    }

    const result = new Map<string, BoxOpenBaseAggregate>();
    for (const [boxKey, itemMap] of this.countsByKey) {
      let totalOpens = 0;
      const breakdownBase: BoxOpenBaseAggregate["breakdownBase"] = [];
      for (const [compositeKeyStr, count] of itemMap) {
        if (count <= 0) continue;
        const { itemKey, grade: parsedGrade } = parseCompositeKey(compositeKeyStr);
        const name = this.namesByKey.get(compositeKeyStr) ?? `#${itemKey}`;
        // Prefer the grade parsed from the composite key; fall back to
        // gradesByKey (set during recordOpen) for forward compatibility.
        const grade = parsedGrade ?? this.gradesByKey.get(compositeKeyStr) ?? null;
        totalOpens += count;
        breakdownBase.push({ itemKey, name, grade, count });
      }
      if (totalOpens === 0) continue;
      breakdownBase.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      const allBoxHistory = historyByBox.get(boxKey) ?? [];
      const visible = allBoxHistory.slice(-HISTORY_VISIBLE).reverse();
      const lastOpenWallTime = visible.length > 0 ? visible[0].wallTime : null;

      result.set(boxKey, {
        totalOpens,
        breakdownBase,
        history: visible,
        lastOpenWallTime,
      });
    }

    this.baseAggregateCache = result;
    return result;
  }

  /** Reset a single boxKey: clears its counts and history entries. */
  resetBox(boxKey: string): void {
    this.countsByKey.delete(boxKey);
    this.history = this.history.filter((h) => h.boxKey !== boxKey);
    this.baseAggregateCache = null;
  }

  /** Reset all boxKeys. */
  resetAll(): void {
    this.countsByKey.clear();
    this.namesByKey.clear();
    this.gradesByKey.clear();
    this.history = [];
    this.baseAggregateCache = null;
  }

  /**
   * Move a single item's count and history entries from one boxKey to another.
   * Used to manually reclassify unclassified items after the user selects a
   * box category/level. No-op when the source boxKey or item doesn't exist.
   */
  reclassifyItem(fromBoxKey: string, itemKey: number, toBoxKey: string): void {
    // P2-6: no-op when source and target are the same boxKey. Without this
    // guard, the item would be deleted from `fromBoxKey` and then re-added to
    // the same map entry — but the intermediate `srcMap.delete(key)` followed
    // by `dstMap.set(key, ...)` would lose the original count when the maps
    // are the same reference (srcMap === dstMap), since `delete` runs before
    // `set` reads the old value.
    if (fromBoxKey === toBoxKey) return;
    const srcMap = this.countsByKey.get(fromBoxKey);
    if (!srcMap) return;

    // Move ALL grade variants of this itemKey (e.g. COMMON + RARE drops of the
    // same item) — reclassify is a box-assignment action, not a grade split.
    const keysToMove: string[] = [];
    for (const compositeKeyStr of srcMap.keys()) {
      const parsed = parseCompositeKey(compositeKeyStr);
      if (parsed.itemKey === itemKey) keysToMove.push(compositeKeyStr);
    }
    if (keysToMove.length === 0) return;

    let dstMap = this.countsByKey.get(toBoxKey);
    if (!dstMap) {
      dstMap = new Map();
      this.countsByKey.set(toBoxKey, dstMap);
    }
    for (const key of keysToMove) {
      const count = srcMap.get(key);
      if (count == null || count <= 0) continue;
      srcMap.delete(key);
      dstMap.set(key, (dstMap.get(key) ?? 0) + count);
      // namesByKey/gradesByKey are keyed by composite key and shared across
      // boxKeys, so they don't need updating.
    }
    if (srcMap.size === 0) this.countsByKey.delete(fromBoxKey);

    // Update history entries.
    for (const h of this.history) {
      if (h.boxKey === fromBoxKey && h.itemKey === itemKey) {
        h.boxKey = toBoxKey;
      }
    }
    this.baseAggregateCache = null;
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
      for (const [key, count] of Object.entries(itemMap)) {
        if (key.includes("|")) {
          // New composite-key format: "itemKey|grade".
          m.set(key, count);
        } else {
          // Legacy format (pre grade-split): key is bare itemKey. Migrate to
          // composite key using the grade from gradesByKey (may be null).
          const grade = data.gradesByKey?.[key] ?? null;
          m.set(compositeKey(Number.parseInt(key, 10), grade), count);
        }
      }
      this.countsByKey.set(boxKey, m);
    }
    for (const [key, name] of Object.entries(data.namesByKey ?? {})) {
      if (key.includes("|")) {
        this.namesByKey.set(key, name);
      } else {
        // Legacy: migrate key, grade from gradesByKey.
        const grade = data.gradesByKey?.[key] ?? null;
        this.namesByKey.set(compositeKey(Number.parseInt(key, 10), grade), name);
      }
    }
    for (const [key, grade] of Object.entries(data.gradesByKey ?? {})) {
      if (key.includes("|")) {
        this.gradesByKey.set(key, grade);
      } else {
        // Legacy: migrate key.
        this.gradesByKey.set(compositeKey(Number.parseInt(key, 10), grade), grade);
      }
    }
    // P1-8: cap restored history at HISTORY_LIMIT so a bloated or hand-edited
    // snapshot can't pin the tracker's memory and `lastOpenWallTime` scan cost
    // forever. Matches ChestDropTracker's behavior.
    const restored = data.history ?? [];
    this.history =
      restored.length > HISTORY_LIMIT ? restored.slice(-HISTORY_LIMIT) : [...restored];
    this.baseAggregateCache = null;
  }

  /**
   * Re-resolve every recorded item's name/itemKey using a normalizer. Used
   * after {@link applySnapshot} to repair entries recorded under an obsolete
   * field layout — e.g. v1.00.28's `BoxOpenLog.itemStringKey` was a
   * `System.String` pointer; the pointer's low 32 bits were misread as a
   * catalog id, producing garbage like `#1703973696` that has no catalog
   * match. Once the field-identification fix lands, *new* opens resolve
   * correctly, but the already-persisted snapshot entries keep showing as
   * unknown without this re-resolve pass.
   *
   * The normalizer returns the canonical `{ itemKey, name }` for a raw
   * itemKey, or `null` to drop the entry entirely (no catalog match). ItemKeys
   * may be remapped (e.g. save-encoded id → catalog id); counts from dropped
   * entries are lost, counts from re-mapped entries are merged under the new
   * composite key. The **grade is preserved** from the existing record — the
   * normalizer does NOT return a grade, because the runtime grade (GradeSO)
   * must not be overwritten by the catalog grade (which records only the base
   * grade of an itemKey, not the actual dropped grade). Surviving history
   * entries are updated in place.
   *
   * Invalidates `baseAggregateCache`. Runs at most once per session (after
   * restore), so the O(items) extra pass over `namesByKey` is not hot-path.
   */
  reResolveNames(
    normalizer: (itemKey: number) => {
      itemKey: number;
      name: string;
    } | null,
  ): void {
    // Rebuild countsByKey with normalized composite keys, dropping entries the
    // normalizer rejects. Counts from re-mapped keys merge under the new
    // composite key. Grade is preserved from the OLD composite key.
    const newCountsByKey = new Map<string, Map<string, number>>();
    for (const [boxKey, itemMap] of this.countsByKey) {
      const m = new Map<string, number>();
      for (const [oldCompositeKey, count] of itemMap) {
        const { grade } = parseCompositeKey(oldCompositeKey);
        const { itemKey: rawItemKey } = parseCompositeKey(oldCompositeKey);
        const resolved = normalizer(rawItemKey);
        if (!resolved) continue;
        const newCompositeKey = compositeKey(resolved.itemKey, grade);
        m.set(newCompositeKey, (m.get(newCompositeKey) ?? 0) + count);
      }
      if (m.size > 0) newCountsByKey.set(boxKey, m);
    }
    this.countsByKey = newCountsByKey;

    // Rebuild namesByKey / gradesByKey from the surviving composite keys.
    // Re-runs the normalizer for each surviving key (cheap; restore runs once).
    this.namesByKey.clear();
    this.gradesByKey.clear();
    for (const itemMap of this.countsByKey.values()) {
      for (const compositeKeyStr of itemMap.keys()) {
        const { itemKey, grade } = parseCompositeKey(compositeKeyStr);
        const resolved = normalizer(itemKey);
        if (!resolved) continue;
        this.namesByKey.set(compositeKeyStr, resolved.name);
        this.gradesByKey.set(compositeKeyStr, grade);
      }
    }

    // Rebuild history: drop entries the normalizer rejects, update the
    // surviving entries' itemKey/itemName. Grade is PRESERVED (runtime value).
    const newHistory: BoxOpenHistoryEntry[] = [];
    for (const h of this.history) {
      const resolved = normalizer(h.itemKey);
      if (!resolved) continue;
      newHistory.push({
        ...h,
        itemKey: resolved.itemKey,
        itemName: resolved.name,
        // grade intentionally preserved — see method doc.
      });
    }
    this.history = newHistory;
    this.baseAggregateCache = null;
  }
}
