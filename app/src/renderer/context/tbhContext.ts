import { createContext, useContext } from "react";
import type { ResolvedInventory } from "../../../shared/types";

export interface TbhContextValue {
  inventory: ResolvedInventory | null;
  lastPriceRefreshMessage: string | null;
  clearLastPriceRefreshMessage: () => void;
}

export const TbhContext = createContext<TbhContextValue | null>(null);

export function useTbhContext(): TbhContextValue {
  const ctx = useContext(TbhContext);
  if (!ctx) {
    throw new Error("TbhProvider missing — wrap the renderer root in main.tsx");
  }
  return ctx;
}
