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

/**
 * Same as `useTbhContext` but returns `null` instead of throwing when no
 * provider is mounted. For read-only consumers that already treat the value as
 * optional (the shared catalog is `LookupItem[] | null` until the startup
 * prefetch resolves), so isolated renders — a single tab or panel in a DOM
 * test, or a surface mounted outside the app root — degrade to "not ready yet"
 * rather than crashing the whole tree.
 */
export function useTbhContextOptional(): TbhContextValue | null {
  return useContext(TbhContext);
}
