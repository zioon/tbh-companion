import { useCallback, useEffect, useState } from "react";
import { useStats } from "./useStats";
import type { BoxCategory, BoxOpenStats, ClassifyPromptPayload } from "../../../shared/types";

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

  // Load initial auto-classify setting from config.
  useEffect(() => {
    void window.tbh.getConfig().then((cfg) => setAutoClassifyEnabledState(cfg.lootAutoClassifyEnabled));
  }, []);

  // Subscribe to classify prompts from the main process.
  useEffect(() => {
    return window.tbh.onClassifyPrompt((payload) => setClassifyPrompt(payload));
  }, []);

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
    classifyPrompt,
    resolveClassifyPrompt,
    dismissClassifyPrompt,
  };
}
