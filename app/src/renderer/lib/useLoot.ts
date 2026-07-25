import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStats } from "./useStats";
import { reportIpcError } from "./reportError";
import type {
  AutoClassifyStatePayload,
  BoxCategory,
  BoxOpenHistoryEntry,
  BoxOpenStats,
  ClassifyPromptPayload,
} from "../../../shared/types";

/**
 * Per-category "time of most recent chest drop", keyed by tracker category.
 * Used by the Loot page chest-card border ring — the ring advances from the
 * last *drop* (not the last *open*) so the player can see how long it's been
 * since a chest of this type was dropped, regardless of whether it's been
 * opened yet. `null` when no drops of that category have been recorded.
 *
 * Values come from `Stats.chestDrops.history` (per-drop entries with
 * `category` and `wallTime`); the global `chestDrops.lastRareDropWallTime`
 * is stage-boss-only and can't be used directly for other categories.
 */
export type LastDropWallTimeByCategory = Record<BoxCategory, number | null>;

/** Max number of recent-drop entries to surface in the Loot UI. */
const RECENT_DROPS_LIMIT = 100;

const EMPTY_STATE: AutoClassifyStatePayload = {
  enabled: false,
  totalQueued: 0,
  byCategory: [
    { category: "common", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "rare", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "act", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
  ],
  items: [],
  liveSlots: null,
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
  const boxOpens = stats?.boxOpens ?? [];
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

  const [autoClassifyEnabled, setAutoClassifyEnabledState] = useState<boolean>(false);
  const [classifyPrompt, setClassifyPrompt] = useState<ClassifyPromptPayload | null>(null);
  const [autoClassifyState, setAutoClassifyState] = useState<AutoClassifyStatePayload>(EMPTY_STATE);
  const stateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load initial auto-classify setting from config.
  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((cfg) => {
        if (mounted) setAutoClassifyEnabledState(cfg.lootAutoClassifyEnabled);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Subscribe to classify prompts from the main process. Capture the unsub
  // function explicitly rather than returning it directly — that way the
  // effect's return type is always `() => void` (matching React's expected
  // cleanup shape) and we don't crash if the IPC contract ever changes to
  // return undefined.
  useEffect(() => {
    let mounted = true;
    const off = window.tbh.onClassifyPrompt((payload) => {
      if (mounted) setClassifyPrompt(payload);
    });
    return () => {
      mounted = false;
      if (typeof off === "function") off();
    };
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
      void window.tbh
        .getAutoClassifyState()
        .then((s) => {
          if (!cancelled) setAutoClassifyState(s);
        })
        .catch(reportIpcError);
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
  const setAutoClassifyEnabled = useCallback(
    async (enabled: boolean) => {
      const previous = autoClassifyEnabled;
      setAutoClassifyEnabledState(enabled);
      try {
        await window.tbh.setLootAutoClassifyEnabled(enabled);
      } catch (err) {
        reportIpcError(err);
        // Roll back on failure — main process didn't accept the change.
        setAutoClassifyEnabledState(previous);
      }
    },
    [autoClassifyEnabled],
  );
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
