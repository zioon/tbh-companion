import { useCallback, useEffect, useRef, useState } from "react";
import { useStats } from "./useStats";
import type {
  AutoClassifyStatePayload,
  BoxCategory,
  BoxOpenStats,
  ClassifyPromptPayload,
} from "../../../shared/types";

const EMPTY_STATE: AutoClassifyStatePayload = {
  enabled: false,
  totalQueued: 0,
  byCategory: [
    { category: "common", count: 0, nextAutoOpenInMs: null },
    { category: "rare", count: 0, nextAutoOpenInMs: null },
    { category: "act", count: 0, nextAutoOpenInMs: null },
  ],
};

export function useLoot(): {
  boxOpens: BoxOpenStats[];
  lootStatus: string | undefined;
  /** Current stage key (difficulty*1000 + act*100 + stage), or null when live memory isn't running. */
  currentStageKey: number | null;
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
