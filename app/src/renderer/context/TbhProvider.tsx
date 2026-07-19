import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ResolvedInventory } from "../../../shared/types";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { reportIpcError } from "../lib/reportError";
import { useCatalogStatus } from "../lib/useCatalogStatus";
import { initRendererI18n } from "../i18n";
import { TbhContext } from "./tbhContext";

export function TbhProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);
  const [lastPriceRefreshMessage, setLastPriceRefreshMessage] = useState<string | null>(null);
  const { status: catalogStatus, refresh: refreshCatalog } = useCatalogStatus();

  // Initialize i18next as soon as the provider mounts. We don't gate the
  // render on this — react-i18next's useTranslation() will subscribe to the
  // i18next instance and re-render automatically once init resolves. Before
  // that, t() returns the bare key (acceptable fallback for the first frame).
  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((cfg) => initRendererI18n(cfg.language, cfg.resolvedLanguage))
      .catch((err) => {
        reportIpcError(err);
      })
      .finally(() => {
        if (mounted) {
          // No state update needed — i18next drives re-renders via languageChanged.
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .getInventory()
      ?.then((inv) => {
        if (mounted && inv) setInventory(inv);
      })
      .catch(reportIpcError);

    const offInventory = window.tbh.onInventory((inv) => {
      if (mounted) setInventory(inv);
    });
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
                `${p.result.priced} prices refreshed (${ps.freshCount} fresh, ${ps.staleCount} stale)`,
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
      catalogStatus,
      refreshCatalog,
    }),
    [inventory, lastPriceRefreshMessage, catalogStatus, refreshCatalog],
  );

  return <TbhContext.Provider value={value}>{children}</TbhContext.Provider>;
}
