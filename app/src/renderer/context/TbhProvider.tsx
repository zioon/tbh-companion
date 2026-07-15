import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ResolvedInventory } from "../../../shared/types";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { reportIpcError } from "../lib/reportError";
import { TbhContext } from "./tbhContext";

export function TbhProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);
  const [lastPriceRefreshMessage, setLastPriceRefreshMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .getInventory()
      ?.then((inv) => {
        if (mounted && inv) setInventory(inv);
      })
      .catch(reportIpcError);

    const offInventory = window.tbh.onInventory((inv) => setInventory(inv));
    const offNotificationSound = window.tbh.onPlayNotificationSound(handleNotificationSoundPayload);
    const offProgress = window.tbh.onPricesProgress((p) => {
      if (!mounted) return;
      if (p.finished) {
        void window.tbh
          .pricesStatus()
          .then((ps) => {
            if (!mounted) return;
            if (p.result) {
              setLastPriceRefreshMessage(
                `${p.result.refreshed} prices refreshed (${ps.freshCount} fresh, ${ps.staleCount} stale)`,
              );
            }
          })
          .catch(reportIpcError);
        return;
      }
    });

    return () => {
      mounted = false;
      offInventory();
      offNotificationSound();
      offProgress();
    };
  }, []);

  const value = useMemo(
    () => ({
      inventory,
      lastPriceRefreshMessage,
      clearLastPriceRefreshMessage: () => setLastPriceRefreshMessage(null),
    }),
    [inventory, lastPriceRefreshMessage],
  );

  return <TbhContext.Provider value={value}>{children}</TbhContext.Provider>;
}
