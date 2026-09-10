import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LookupItem, ResolvedInventory } from "../../../shared/types";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { ensureMarketVolumeRefreshSubscription } from "../lib/marketVolumeRefreshStore";
import { reportIpcError } from "../lib/reportError";
import { useCatalogStatus } from "../lib/useCatalogStatus";
import { initRendererI18n, i18next } from "../i18n";
import { TbhContext } from "./tbhContext";

export function TbhProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);
  const [lookupCatalog, setLookupCatalog] = useState<LookupItem[] | null>(null);
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

  // 应用启动即预取一次图鉴目录，供所有标签页共享；语言切换时重新拉取
  // 本地化名称。集中在这里预取，使 Inventory/Loot 等页挂载时目录通常已
  // 就绪 —— 它们的行可以一次渲染出「图标 + 正确品质色」，而不是先渲染
  // 灰点占位、等目录到达后再整体刷新一遍。
  useEffect(() => {
    let mounted = true;

    const fetchCatalog = (): void => {
      void window.tbh
        .getLookupCatalog()
        .then((catalog) => {
          if (mounted) setLookupCatalog(catalog);
        })
        .catch(reportIpcError);
    };

    fetchCatalog();
    // 语言切换事件由 Settings 页触发。主进程在 savePartial 之后才会应用
    // 新语言（LookupService.setLocaleCatalog），因此监听器里同一事件循环
    // 内发起的 fetch 拿到的是新语言的目录（见 Settings.tsx 的时序注释）。
    const onLanguageChanged = (): void => fetchCatalog();
    i18next.on("languageChanged", onLanguageChanged);
    return () => {
      mounted = false;
      i18next.off("languageChanged", onLanguageChanged);
    };
  }, []);

  const value = useMemo(
    () => ({
      inventory,
      catalogStatus,
      refreshCatalog,
      lookupCatalog,
    }),
    [inventory, catalogStatus, refreshCatalog, lookupCatalog],
  );

  if (!i18nReady) return null;
  return <TbhContext.Provider value={value}>{children}</TbhContext.Provider>;
}
