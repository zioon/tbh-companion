import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ResolvedInventory } from "../../../shared/types";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { ensureMarketVolumeRefreshSubscription } from "../lib/marketVolumeRefreshStore";
import { reportIpcError } from "../lib/reportError";
import { useCatalogStatus } from "../lib/useCatalogStatus";
import { initRendererI18n } from "../i18n";
import { TbhContext } from "./tbhContext";

export function TbhProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);
  const [i18nReady, setI18nReady] = useState(false);
  const { status: catalogStatus, refresh: refreshCatalog } = useCatalogStatus();

  // Initialize i18next as soon as the provider mounts. We gate the render on
  // this — react-i18next's useTranslation() crashes if it runs before the
  // global i18next instance has been initialized (the singleton's options and
  // translator are not set up until init() runs, and calling t() in that
  // state throws "Cannot read properties of null (reading '1')").
  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((cfg) => initRendererI18n(cfg.language, cfg.resolvedLanguage))
      .then(() => {
        if (mounted) setI18nReady(true);
      })
      .catch((err) => {
        reportIpcError(err);
        // Even on failure, mark ready so the UI can render with fallback
        // keys rather than staying blank forever.
        if (mounted) setI18nReady(true);
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
    // 交易量历史刷新进度：由模块单例 store 自行订阅（见 marketVolumeRefreshStore.ts），
    // 只重渲染订阅它的 Trading 页，避免进度逐项推送驱动所有 context 消费者重渲染。
    ensureMarketVolumeRefreshSubscription();

    return () => {
      mounted = false;
      offInventory();
      offNotificationSound();
    };
  }, []);

  const value = useMemo(
    () => ({
      inventory,
      catalogStatus,
      refreshCatalog,
    }),
    [inventory, catalogStatus, refreshCatalog],
  );

  if (!i18nReady) return null;
  return <TbhContext.Provider value={value}>{children}</TbhContext.Provider>;
}
