import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  MarketVolumeItem,
  MarketVolumeRefreshProgress,
  ResolvedInventory,
} from "../../../shared/types";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { reportIpcError } from "../lib/reportError";
import { useCatalogStatus } from "../lib/useCatalogStatus";
import { initRendererI18n } from "../i18n";
import { TbhContext } from "./tbhContext";

/** 市场交易量历史刷新进度（全局共享；切换 tab 不丢失）。 */
const IDLE_MARKET_VOLUME_PROGRESS: MarketVolumeRefreshProgress = {
  running: false,
  total: 0,
  done: 0,
  currentHash: null,
};

export function TbhProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);
  const [lastPriceRefreshMessage, setLastPriceRefreshMessage] = useState<string | null>(null);
  const [i18nReady, setI18nReady] = useState(false);
  const { status: catalogStatus, refresh: refreshCatalog } = useCatalogStatus();
  // 交易量历史刷新进度与待刷新占位列表：存放在全局（而非 Trading 组件本地），
  // 使切换 tab（Trading 卸载/重挂）后进度仍能保留并继续更新。
  const [marketVolumeProgress, setMarketVolumeProgress] = useState<MarketVolumeRefreshProgress>(
    IDLE_MARKET_VOLUME_PROGRESS,
  );
  const [marketVolumePending, setMarketVolumePending] = useState<MarketVolumeItem[]>([]);

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
    // 交易量历史刷新进度：全局订阅，进度/待刷新占位列表跨 tab 保留。
    const offMarketVolumeProgress = window.tbh.onMarketVolumeRefreshProgress((p) => {
      if (!mounted) return;
      setMarketVolumeProgress(p);
      // 刷新结束（running 变 false）时清空待刷新占位列表，避免 `refreshStatusByHash`
      // 残留旧状态导致主列表卡片在刷新结束后仍挂着亮环。
      if (p.running === false) {
        setMarketVolumePending([]);
      } else if (p.pending) {
        // 刷新开始时设置本次待刷新的占位卡片（自动/手动刷新共用），驱动亮环提示。
        setMarketVolumePending(p.pending);
      }
      // 刷新过程中每完成一个物品，实时用其最新卡片替换占位卡片。
      if (p.updatedItem) {
        const updated = p.updatedItem;
        setMarketVolumePending((prev) => {
          const idx = prev.findIndex((it) => it.hash === updated.hash);
          if (idx < 0) return prev;
          const next = prev.slice();
          next[idx] = updated;
          return next;
        });
      }
    });
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
      offMarketVolumeProgress();
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
      marketVolumeProgress,
      marketVolumePending,
      setMarketVolumePending,
    }),
    [
      inventory,
      lastPriceRefreshMessage,
      catalogStatus,
      refreshCatalog,
      marketVolumeProgress,
      marketVolumePending,
    ],
  );

  if (!i18nReady) return null;
  return <TbhContext.Provider value={value}>{children}</TbhContext.Provider>;
}
