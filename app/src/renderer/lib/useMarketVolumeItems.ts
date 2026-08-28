import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  MarketVolumeItem,
  MarketVolumeItemStats,
  MarketVolumeRefreshProgress,
} from "../../../shared/types";
import { reportIpcError } from "./reportError";
import {
  ensureMarketVolumeRefreshSubscription,
  getMarketVolumePending,
  getMarketVolumeRefreshProgress,
  setMarketVolumePending,
  subscribeMarketVolumeRefresh,
} from "./marketVolumeRefreshStore";

/**
 * 读取「物品维度」的市场交易额卡片数据（交易页）。订阅 IPC.MARKET_VOLUME_ITEMS
 * 推送，组件卸载时移除监听。`refresh()` 触发一次「刷新历史价格」（星标 ∪ 快照
 * 阈值以上全部物品）。
 *
 * 刷新进度（`progress`）与待刷新占位列表（`pending`）由模块单例
 * `marketVolumeRefreshStore` 管理（经 useSyncExternalStore 读取），而非本 hook
 * 的本地 state、也非全局 TbhProvider——这样切换到其他 tab（本组件卸载）再回到
 * 交易页时，进行中的刷新进度仍能保留并继续更新，且进度逐项推送不会重渲染其他
 * context 消费者。
 */
export function useMarketVolumeItems(): {
  stats: MarketVolumeItemStats | null;
  pending: MarketVolumeItem[];
  refresh: (cardOrder?: string[]) => Promise<void>;
  refreshing: boolean;
  progress: MarketVolumeRefreshProgress;
  refreshItem: (hash: string) => Promise<void>;
  cancelRefresh: () => void;
} {
  const [stats, setStats] = useState<MarketVolumeItemStats | null>(null);
  const marketVolumeProgress = useSyncExternalStore(
    subscribeMarketVolumeRefresh,
    getMarketVolumeRefreshProgress,
  );
  const marketVolumePending = useSyncExternalStore(
    subscribeMarketVolumeRefresh,
    getMarketVolumePending,
  );

  useEffect(() => {
    let mounted = true;
    ensureMarketVolumeRefreshSubscription();
    window.tbh
      .getMarketVolumeItems()
      .then((next) => {
        if (mounted) setStats(next);
      })
      .catch(reportIpcError);
    const off = window.tbh.onMarketVolumeItems((next) => setStats(next));
    return () => {
      mounted = false;
      if (typeof off === "function") off();
    };
  }, []);

  const refresh = useCallback(async (cardOrder?: string[]) => {
    try {
      const result = await window.tbh.refreshMarketVolumeItems(cardOrder);
      setStats(result.stats);
      setMarketVolumePending(result.pending);
    } catch (err) {
      reportIpcError(err, "market-volume-items:refresh");
    }
  }, []);

  // 单物品卡片手动更新：结果经 MARKET_VOLUME/MARKET_VOLUME_ITEMS 广播回传，此处只触发。
  const refreshItem = useCallback(async (hash: string) => {
    try {
      await window.tbh.refreshMarketVolumeItem(hash);
    } catch (err) {
      reportIpcError(err, "market-volume-items:refresh-item");
    }
  }, []);

  // 手动终止整次历史刷新（send，无响应）。
  const cancelRefresh = useCallback(() => window.tbh.cancelHistoryRefresh(), []);

  return {
    stats,
    pending: marketVolumePending,
    refresh,
    refreshing: marketVolumeProgress.running,
    progress: marketVolumeProgress,
    refreshItem,
    cancelRefresh,
  };
}
