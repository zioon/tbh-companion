import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import type { Stats } from "../../../shared/types";
import { reportIpcError } from "../lib/reportError";

interface StatsContextValue {
  stats: Stats | null;
}

const StatsContext = createContext<StatsContextValue | null>(null);

export function StatsProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .getStats()
      .then((s) => {
        if (mounted && s) setStats(s);
      })
      .catch(reportIpcError);

    const off = window.tbh.onStats((s) => setStats(s));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const value = useMemo(() => ({ stats }), [stats]);
  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider pair is the standard Context pattern
export function useStatsContext(): StatsContextValue {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error("StatsProvider missing");
  return ctx;
}
