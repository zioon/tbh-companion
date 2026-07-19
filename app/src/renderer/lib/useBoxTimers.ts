import { useEffect, useState } from "react";
import type { BoxTimerState } from "../../../shared/types";
import { reportIpcError } from "./reportError";
// P2-9: fmtTimer moved to format.ts alongside the other duration formatters.
// Re-exported here so existing `import { fmtTimer } from "./lib/useBoxTimers"`
// callsites (BoxTracker.tsx) keep working without churn.
export { fmtTimer } from "./format";

export function useBoxTimers(): BoxTimerState | null {
  const [state, setState] = useState<BoxTimerState | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .getBoxTimers()
      .then((s) => {
        if (mounted) setState(s);
      })
      .catch(reportIpcError);

    const off = window.tbh.onBoxTimers((s) => {
      if (mounted) setState(s);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return state;
}
