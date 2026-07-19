import { useEffect, useState } from "react";
import type { ChestState } from "../../../shared/types";
import { reportIpcError } from "./reportError";

export function useChests(): ChestState | null {
  const [chests, setChests] = useState<ChestState | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .getChests()
      .then((c) => {
        if (mounted && c) setChests(c);
      })
      .catch(reportIpcError);

    // P1-11: filter null on the subscription too, mirroring the initial fetch.
    // main can broadcast null when the save is momentarily unavailable (e.g.
    // during a save-path reset); accepting it would flash "Waiting for save
    // data…" even though the last valid state is still on screen. We keep the
    // last non-null state until a real update arrives.
    const off = window.tbh.onChests((c) => {
      if (mounted && c) setChests(c);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return chests;
}
