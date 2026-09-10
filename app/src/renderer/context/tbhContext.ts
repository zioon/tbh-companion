import { createContext, useContext } from "react";
import type {
  CatalogRefreshResult,
  CatalogStatus,
  LookupItem,
  ResolvedInventory,
} from "../../../shared/types";

export interface TbhContextValue {
  inventory: ResolvedInventory | null;
  catalogStatus: CatalogStatus | null;
  refreshCatalog: () => Promise<CatalogRefreshResult>;
  /** 全局唯一的图鉴目录（名称已本地化）。null 表示尚未就绪（应用启动预取中）。 */
  lookupCatalog: LookupItem[] | null;
}

export const TbhContext = createContext<TbhContextValue | null>(null);

export function useTbhContext(): TbhContextValue {
  const ctx = useContext(TbhContext);
  if (!ctx) {
    throw new Error("TbhProvider missing — wrap the renderer root in main.tsx");
  }
  return ctx;
}
