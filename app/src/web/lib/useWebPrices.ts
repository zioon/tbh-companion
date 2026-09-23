// Web build: React binding for the same-origin price snapshot.
//
// `useWebPrices()` mirrors the desktop `useLookupPrices()` store but for the
// web snapshot, and exposes the fetch *status* so a view can tell "still
// loading" (render nothing special) apart from "missing" (render the yellow
// warning banner). Lookup's cards read prices through the existing
// `useLookupPrices()` IPC shim; Trading uses this hook for its banner.

import { useEffect, useSyncExternalStore } from "react";
import type { LookupPriceSnapshot } from "../../../shared/types";
import {
  ensureWebPricesLoaded,
  getWebPriceSnapshot,
  getWebPricesStatus,
  subscribeWebPrices,
  type WebPricesStatus,
} from "../pricesSnapshot";

export interface WebPrices {
  status: WebPricesStatus;
  snapshot: LookupPriceSnapshot | null;
}

/** Subscribe to the web price snapshot and kick off its (idempotent) load. */
export function useWebPrices(): WebPrices {
  const status = useSyncExternalStore(subscribeWebPrices, getWebPricesStatus, getWebPricesStatus);
  const snapshot = useSyncExternalStore(
    subscribeWebPrices,
    getWebPriceSnapshot,
    getWebPriceSnapshot,
  );

  useEffect(() => {
    void ensureWebPricesLoaded();
  }, []);

  return { status, snapshot };
}
