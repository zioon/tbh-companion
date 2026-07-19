import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import type { InventorySummary, ResolvedInventory } from "../../../shared/types";
import { reportIpcError } from "../lib/reportError";

interface InventoryContextValue {
  inventory: ResolvedInventory | null;
}

const InventoryContext = createContext<InventoryContextValue | null>(null);

/** True when this renderer is the frameless mini overlay window. */
const isOverlay = window.location.hash === "#overlay";

/**
 * Build a minimal ResolvedInventory from the slim summary pushed to the
 * overlay. The overlay only reads `currency` and `composition.buyOrderNetTotal`
 * (see Overlay.tsx), so every other field is a zero/empty default.
 */
function summaryToInventory(summary: InventorySummary): ResolvedInventory {
  return {
    rows: [],
    chests: [],
    saveMtime: 0,
    gameDataLoaded: false,
    currency: summary.currency,
    inventoryCapacity: 0,
    inventoryUsed: 0,
    composition: {
      total: 0,
      byGrade: {},
      byType: {},
      tradableCount: 0,
      unknownCount: 0,
      chaoticCount: 0,
      inUseCount: 0,
      priceableCount: 0,
      valuedTotal: 0,
      feeTotal: 0,
      netAfterFeesTotal: 0,
      buyOrderValuedTotal: 0,
      buyOrderNetTotal: summary.buyOrderNetTotal ?? 0,
      buyOrderPricedRows: 0,
      currency: summary.currency,
    },
  };
}

export function InventoryProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);

  useEffect(() => {
    let mounted = true;

    // Overlay window: listen to the slim summary channel only. It never needs
    // the full ResolvedInventory (rows/chests/etc.), so we skip the initial
    // getInventory() fetch too.
    if (isOverlay) {
      const off = window.tbh.onInventorySummary((summary) => {
        if (mounted) setInventory(summaryToInventory(summary));
      });
      return () => {
        mounted = false;
        off();
      };
    }

    void window.tbh
      .getInventory()
      .then((inv) => {
        if (mounted && inv) setInventory(inv);
      })
      .catch(reportIpcError);

    const off = window.tbh.onInventory((inv) => setInventory(inv));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const value = useMemo(() => ({ inventory }), [inventory]);
  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider pair is the standard Context pattern
export function useInventoryContext(): InventoryContextValue {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error("InventoryProvider missing");
  return ctx;
}
