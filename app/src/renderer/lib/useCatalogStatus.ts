import { useEffect, useState } from "react";
import type { CatalogRefreshResult, CatalogStatus } from "../../../shared/types";
import { reportIpcError } from "./reportError";

/**
 * Subscribe to catalog status updates from main and expose a refresh trigger.
 * Initial status is fetched on mount; subsequent updates arrive via the
 * CATALOG_STATUS push channel (broadcast by CatalogRefreshService on refresh
 * completion or gameVersion change).
 */
export function useCatalogStatus(): {
  status: CatalogStatus | null;
  refresh: () => Promise<CatalogRefreshResult>;
} {
  const [status, setStatus] = useState<CatalogStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getCatalogStatus()
      .then((s) => {
        if (mounted && s) setStatus(s);
      })
      .catch(reportIpcError);

    const off = window.tbh.onCatalogStatus((s) => {
      if (mounted) setStatus(s);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return {
    status,
    refresh: () => window.tbh.refreshCatalog(),
  };
}
