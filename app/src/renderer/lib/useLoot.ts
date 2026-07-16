import { useCallback } from "react";
import { useStats } from "./useStats";
import type { BoxOpenStats } from "../../../shared/types";

export function useLoot(): {
  boxOpens: BoxOpenStats[];
  resetBox: (boxKey: string) => Promise<void>;
  resetAll: () => Promise<void>;
  reclassifyItem: (itemKey: number, fromBoxKey: string, toBoxKey: string) => Promise<void>;
} {
  const stats = useStats();
  const boxOpens = stats?.boxOpens ?? [];

  const resetBox = useCallback((boxKey: string) => window.tbh.resetLootBox(boxKey), []);
  const resetAll = useCallback(() => window.tbh.resetLootAll(), []);
  const reclassifyItem = useCallback(
    (itemKey: number, fromBoxKey: string, toBoxKey: string) =>
      window.tbh.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey),
    [],
  );

  return { boxOpens, resetBox, resetAll, reclassifyItem };
}
