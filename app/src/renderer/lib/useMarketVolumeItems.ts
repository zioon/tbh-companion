import { useCallback, useEffect, useState } from "react";
import type {
  MarketVolumeItem,
  MarketVolumeItemStats,
  MarketVolumeRefreshProgress,
} from "../../../shared/types";
import { useTbhContext } from "../context/tbhContext";
import { reportIpcError } from "./reportError";

/**
 * 读取「物品维度」的市场交易额卡片数据（交易页）。订阅 IPC.MARKET_VOLUME_ITEMS
 * 推送，组件卸载时移除监听。`refresh()` 触发一次「刷新历史价格」（星标 ∪ 快照
 * 阈值以上全部物品）。
 *
 * 刷新进度（`progress`）与待刷新占位列表（`pending`）提升到全局 `TbhProvider`
 * 管理，而非本 hook 的本地 state——这样切换到其他 tab（本组件卸载）再回到交易
 * 页时，进行中的刷新进度仍能保留并继续更新，不会重置回初始状态。
 */
export function useMarketVolumeItems(): {
  stats: MarketVolumeItemStats | null;
  pending: MarketVolumeItem[];
  refresh: () => Promise<void>;
  refreshing: boolean;
  progress: MarketVolumeRefreshProgress;
} {
  const [stats, setStats] = useState<MarketVolumeItemStats | null>(null);
  const { marketVolumeProgress, marketVolumePending, setMarketVolumePending } = useTbhContext();

  useEffect(() => {
    let mounted = true;
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

  const refresh = useCallback(async () => {
    try {
      const result = await window.tbh.refreshMarketVolumeItems();
      setStats(result.stats);
      setMarketVolumePending(result.pending);
    } catch (err) {
      reportIpcError(err, "market-volume-items:refresh");
    }
  }, [setMarketVolumePending]);

  return {
    stats,
    pending: marketVolumePending,
    refresh,
    refreshing: marketVolumeProgress.running,
    progress: marketVolumeProgress,
  };
}
