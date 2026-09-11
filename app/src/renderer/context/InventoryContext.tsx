import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import type { ResolvedInventory } from "../../../shared/types";
import { reportIpcError } from "../lib/reportError";

interface InventoryContextValue {
  inventory: ResolvedInventory | null;
}

const InventoryContext = createContext<InventoryContextValue | null>(null);

export function InventoryProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);

  useEffect(() => {
    let mounted = true;

    // Both windows (main + frameless overlay) reuse the existing full inventory
    // channel — no new IPC channel required. Components can read whichever
    // fields they need (e.g. the overlay only reads `currency` /
    // `composition.buyOrderNetTotal`).
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
