import { useCallback } from "react";
import { useStats } from "./useStats";
import type { BoxOpenStats } from "../../../shared/types";

export function useLoot(): {
  boxOpens: BoxOpenStats[];
  resetBox: (boxKey: string) => Promise<void>;
  resetAll: () => Promise<void>;
} {
  const stats = useStats();
  const boxOpens = stats?.boxOpens ?? [];

  const resetBox = useCallback((boxKey: string) => window.tbh.resetLootBox(boxKey), []);
  const resetAll = useCallback(() => window.tbh.resetLootAll(), []);

  return { boxOpens, resetBox, resetAll };
}
