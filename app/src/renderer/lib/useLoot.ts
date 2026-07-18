import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStats } from "./useStats";
import type {
  AutoClassifyStatePayload,
  BoxCategory,
  BoxOpenHistoryEntry,
  BoxOpenStats,
  BoxQueueItem,
  BoxQueueSnapshot,
  ClassifyPromptPayload,
} from "../../../shared/types";
import { useBoxTimers } from "./useBoxTimers";

/**
 * Per-category "time of most recent chest drop", keyed by tracker category.
 * Used by the Loot page chest-card border ring — the ring advances from the
 * last *drop* (not the last *open*) so the player can see how long it's been
 * since a chest of this type was dropped, regardless of whether it's been
 * opened yet. `null` when no drops of that category have been recorded.
 *
 * Values come from `Stats.chestDrops.history` (per-drop entries with
 * `category` and `wallTime`); the global `chestDrops.lastDropWallTime` is
 * category-agnostic and can't be used directly.
 */
export type LastDropWallTimeByCategory = Record<BoxCategory, number | null>;

/** Max number of recent-drop entries to surface in the Loot UI. */
const RECENT_DROPS_LIMIT = 3;

/** Stable empty array so `boxOpens` keeps referential identity when stats are null. */
const EMPTY_BOX_OPENS: BoxOpenStats[] = [];

const EMPTY_STATE: AutoClassifyStatePayload = {
  enabled: false,
  totalQueued: 0,
  byCategory: [
    { category: "common", count: 0, nextAutoOpenInMs: null },
    { category: "rare", count: 0, nextAutoOpenInMs: null },
    { category: "act", count: 0, nextAutoOpenInMs: null },
  ],
  items: [],
};

export function useLoot(): {
  boxOpens: BoxOpenStats[];
  lootStatus: string | undefined;
  /** Current stage key (difficulty*1000 + act*100 + stage), or null when live memory isn't running. */
  currentStageKey: number | null;
  /** Most recent drops across all boxKeys, newest first (capped at RECENT_DROPS_LIMIT). */
  recentDrops: BoxOpenHistoryEntry[];
  /** Per-category wall-clock seconds of the most recent chest drop. See {@link LastDropWallTimeByCategory}. */
  lastDropWallTimeByCategory: LastDropWallTimeByCategory;
  /**
   * Box-queue ("stargaze") prediction, mapped to the 3 boxKeys the player is
   * actually farming right now. Keyed by boxKey (`"common:5"`, `"rare:3"`,
   * `"act:20"`, or category-only when level can't be inferred). Each value
   * is the predicted drop items for that chest, head-first. Empty map when
   * `stats.boxQueue` is null (scanner hasn't located the queue yet).
   *
   * The level for each category is inferred from `currentStageKey` via the
   * box-timer catalog — same logic `useChestLevelDefaults` uses for the
   * reclassify Select. Only common/rare/act are surfaced; "unclassified"
   * never gets a prediction.
   */
  boxQueueByBoxKey: Map<string, BoxQueueItem[]>;
  resetBox: (boxKey: string) => Promise<void>;
  resetAll: () => Promise<void>;
  reclassifyItem: (itemKey: number, fromBoxKey: string, toBoxKey: string) => Promise<void>;
  autoClassifyEnabled: boolean;
  setAutoClassifyEnabled: (enabled: boolean) => Promise<void>;
  autoClassifyState: AutoClassifyStatePayload;
  classifyPrompt: ClassifyPromptPayload | null;
  resolveClassifyPrompt: (category: BoxCategory) => void;
  dismissClassifyPrompt: () => void;
} {
  const stats = useStats();
  const boxOpens = stats?.boxOpens ?? EMPTY_BOX_OPENS;
  const lootStatus = stats?.lootStatus;
  // stageKey is 0 in the default Stats shape before live memory connects; treat
  // that as "no stage" so LootBoxSection doesn't pre-fill an invalid level.
  const currentStageKey = stats?.stageKey ? stats.stageKey : null;
  // Merge every boxKey's visible history slice (already newest-first per
  // BoxOpenTracker) and take the top N by wallTime. Each boxKey contributes
  // up to HISTORY_VISIBLE (50) entries, so the merge is bounded.
  const recentDrops = useMemo<BoxOpenHistoryEntry[]>(() => {
    const all: BoxOpenHistoryEntry[] = [];
    for (const b of boxOpens) {
      for (const h of b.history) all.push(h);
    }
    all.sort((a, b) => b.wallTime - a.wallTime);
    return all.slice(0, RECENT_DROPS_LIMIT);
  }, [boxOpens]);

  // Per-category latest chest *drop* wall time, sourced from
  // `chestDrops.history`. Used by the Loot page chest-card border ring so
  // the ring advances from the last *drop* of that category, not the last
  // *open* — matches the mini overlay's boss-chest ring semantics.
  const lastDropWallTimeByCategory = useMemo<LastDropWallTimeByCategory>(() => {
    const out: LastDropWallTimeByCategory = {
      common: null,
      rare: null,
      act: null,
      unclassified: null,
    };
    const history = stats?.chestDrops?.history ?? [];
    // History is newest-first by convention; one pass per category is fine
    // since the array is capped at HISTORY_LIMIT (200).
    for (const entry of history) {
      if (entry.category in out && out[entry.category] == null) {
        out[entry.category] = entry.wallTime;
      }
    }
    return out;
  }, [stats?.chestDrops?.history]);

  // Box-queue ("stargaze") prediction, mapped to the 3 boxKeys the player is
  // farming right now. The level for each category is inferred from the
  // current stage via the box-timer catalog (same logic as
  // `useChestLevelDefaults`). When `stats.boxQueue` is null or the catalog
  // hasn't loaded, the map is empty — LootBoxSection renders nothing.
  const boxTimers = useBoxTimers();
  const boxQueueByBoxKey = useMemo<Map<string, BoxQueueItem[]>>(() => {
    const queue: BoxQueueSnapshot | null = stats?.boxQueue ?? null;
    if (queue == null) return new Map();
    const catalog = boxTimers?.catalog ?? [];
    const out = new Map<string, BoxQueueItem[]>();
    const cats: Array<{ cat: "common" | "rare" | "act"; items: BoxQueueItem[] }> = [
      { cat: "common", items: queue.common },
      { cat: "rare", items: queue.rare },
      { cat: "act", items: queue.act },
    ];
    for (const { cat, items } of cats) {
      if (items.length === 0) continue;
      // Infer level: prefer the highest level whose farmStageOptions includes
      // currentStageKey; fall back to lowest catalog level when no match.
      //
      // NOTE: This mirrors `useChestLevelDefaults` in LootBoxSection.tsx, which
      // is the reclassify Select's default-level source. Both must agree with
      // the main process's boxKey generation (`AutoClassifyService.resolveDropBoxKey`)
      // or the prediction won't map to the rendered card's boxKey.
      // Known limitation: act-boss levels should be derived from LEGENDARY
      // catalog entries (per `loadActBossTrackerRoutes`), but this renderer
      // path uses the unified box-timer catalog. When the act-boss boxKey
      // from the main process uses a LEGENDARY-derived level that isn't in
      // this catalog's farmStageOptions for the current stage, the prediction
      // for `act` won't be shown. This is a pre-existing renderer limitation
      // (not introduced by the stargaze port) — fixing it requires sharing
      // the LEGENDARY route table with the renderer.
      let level: number | null = null;
      if (catalog.length > 0) {
        const fallback = catalog.reduce(
          (min, entry) =>
            entry.level != null && (min == null || entry.level < min) ? entry.level : min,
          null as number | null,
        );
        if (currentStageKey != null && currentStageKey > 0) {
          const matches = catalog.filter(
            (entry) =>
              entry.level != null &&
              entry.farmStageOptions.some((opt) => opt.stageKey === currentStageKey),
          );
          if (matches.length > 0) {
            level = matches.reduce(
              (max, entry) => (entry.level! > max! ? entry.level : max),
              matches[0]!.level as number | null,
            );
          } else {
            level = fallback;
          }
        } else {
          level = fallback;
        }
      }
      const boxKey = level != null && level > 0 ? `${cat}:${level}` : cat;
      out.set(boxKey, items);
    }
    return out;
  }, [stats?.boxQueue, boxTimers?.catalog, currentStageKey]);

  const [autoClassifyEnabled, setAutoClassifyEnabledState] = useState<boolean>(false);
  const [classifyPrompt, setClassifyPrompt] = useState<ClassifyPromptPayload | null>(null);
  const [autoClassifyState, setAutoClassifyState] = useState<AutoClassifyStatePayload>(EMPTY_STATE);
  const stateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load initial auto-classify setting from config.
  useEffect(() => {
    void window.tbh
      .getConfig()
      .then((cfg) => setAutoClassifyEnabledState(cfg.lootAutoClassifyEnabled));
  }, []);

  // Subscribe to classify prompts from the main process.
  useEffect(() => {
    return window.tbh.onClassifyPrompt((payload) => setClassifyPrompt(payload));
  }, []);

  // Poll the auto-classify queue state at 1 Hz while enabled; stop when disabled.
  useEffect(() => {
    if (!autoClassifyEnabled) {
      setAutoClassifyState(EMPTY_STATE);
      if (stateTimerRef.current) {
        clearInterval(stateTimerRef.current);
        stateTimerRef.current = null;
      }
      return;
    }
    // Fetch immediately on enable, then every second.
    let cancelled = false;
    const tick = (): void => {
      void window.tbh.getAutoClassifyState().then((s) => {
        if (!cancelled) setAutoClassifyState(s);
      });
    };
    tick();
    stateTimerRef.current = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      if (stateTimerRef.current) {
        clearInterval(stateTimerRef.current);
        stateTimerRef.current = null;
      }
    };
  }, [autoClassifyEnabled]);

  const resetBox = useCallback((boxKey: string) => window.tbh.resetLootBox(boxKey), []);
  const resetAll = useCallback(() => window.tbh.resetLootAll(), []);
  const reclassifyItem = useCallback(
    (itemKey: number, fromBoxKey: string, toBoxKey: string) =>
      window.tbh.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey),
    [],
  );
  const setAutoClassifyEnabled = useCallback(async (enabled: boolean) => {
    setAutoClassifyEnabledState(enabled);
    await window.tbh.setLootAutoClassifyEnabled(enabled);
  }, []);
  const resolveClassifyPrompt = useCallback(
    (category: BoxCategory) => {
      const prompt = classifyPrompt;
      if (!prompt) return;
      window.tbh.resolveClassifyPrompt({
        promptId: prompt.promptId,
        category,
        itemKeys: prompt.itemKeys,
      });
      setClassifyPrompt(null);
    },
    [classifyPrompt],
  );
  const dismissClassifyPrompt = useCallback(() => setClassifyPrompt(null), []);

  return {
    boxOpens,
    lootStatus,
    currentStageKey,
    recentDrops,
    lastDropWallTimeByCategory,
    boxQueueByBoxKey,
    resetBox,
    resetAll,
    reclassifyItem,
    autoClassifyEnabled,
    setAutoClassifyEnabled,
    autoClassifyState,
    classifyPrompt,
    resolveClassifyPrompt,
    dismissClassifyPrompt,
  };
}
