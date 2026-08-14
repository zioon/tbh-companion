import { createContext, useContext } from "react";
import type {
  CatalogRefreshResult,
  CatalogStatus,
  MarketVolumeItem,
  MarketVolumeRefreshProgress,
  ResolvedInventory,
} from "../../../shared/types";

export interface TbhContextValue {
  inventory: ResolvedInventory | null;
  lastPriceRefreshMessage: string | null;
  clearLastPriceRefreshMessage: () => void;
  catalogStatus: CatalogStatus | null;
  refreshCatalog: () => Promise<CatalogRefreshResult>;
  /**
   * 市场交易量历史刷新进度（全局共享，跨 tab 存活）。
   * 进度状态提升到 TbhProvider 而非停留在 Trading 组件本地，是为了在切换
   * tab（Trading 被卸载）后回到交易页时，刷新进度与待刷新占位列表不至于丢失。
   */
  marketVolumeProgress: MarketVolumeRefreshProgress;
  marketVolumePending: MarketVolumeItem[];
  setMarketVolumePending: (items: MarketVolumeItem[]) => void;
}

export const TbhContext = createContext<TbhContextValue | null>(null);

export function useTbhContext(): TbhContextValue {
  const ctx = useContext(TbhContext);
  if (!ctx) {
    throw new Error("TbhProvider missing — wrap the renderer root in main.tsx");
  }
  return ctx;
}
