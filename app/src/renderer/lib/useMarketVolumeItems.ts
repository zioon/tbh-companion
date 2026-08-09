import { useCallback, useEffect, useState } from "react";
import type {
  MarketVolumeItem,
  MarketVolumeItemStats,
  MarketVolumeRefreshProgress,
} from "../../../shared/types";
import { reportIpcError } from "./reportError";

const IDLE_PROGRESS: MarketVolumeRefreshProgress = {
  running: false,
  total: 0,
  done: 0,
  currentHash: null,
};

/**
 * 读取「物品维度」的市场交易额卡片数据（交易页）。订阅 IPC.MARKET_VOLUME_ITEMS
 * 推送，组件卸载时移除监听。`refresh()` 触发一次「刷新历史价格」（星标 ∪ 快照
 * 阈值以上全部物品），刷新期间订阅进度、并提前展示待刷全新品的占位卡片。
 */
export function useMarketVolumeItems(): {
  stats: MarketVolumeItemStats | null;
  pending: MarketVolumeItem[];
  refresh: () => Promise<void>;
  refreshing: boolean;
  progress: MarketVolumeRefreshProgress;
} {
  const [stats, setStats] = useState<MarketVolumeItemStats | null>(null);
  const [pending, setPending] = useState<MarketVolumeItem[]>([]);
  const [progress, setProgress] = useState<MarketVolumeRefreshProgress>(IDLE_PROGRESS);

  useEffect(() => {
    let mounted = true;
    window.tbh
      .getMarketVolumeItems()
      .then((next) => {
        if (mounted) setStats(next);
      })
      .catch(reportIpcError);
    const off = window.tbh.onMarketVolumeItems((next) => setStats(next));
    const offProgress = window.tbh.onMarketVolumeRefreshProgress((p) => {
      setProgress(p);
      // 刷新过程中每完成一个物品，实时用其最新卡片替换占位卡片。
      if (p.updatedItem) {
        const updated = p.updatedItem;
        setPending((prev) => {
          const idx = prev.findIndex((it) => it.hash === updated.hash);
          if (idx < 0) return prev;
          const next = prev.slice();
          next[idx] = updated;
          return next;
        });
      }
    });
    return () => {
      mounted = false;
      if (typeof off === "function") off();
      if (typeof offProgress === "function") offProgress();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await window.tbh.refreshMarketVolumeItems();
      setStats(result.stats);
      setPending(result.pending);
    } catch (err) {
      reportIpcError(err, "market-volume-items:refresh");
    }
  }, []);

  return { stats, pending, refresh, refreshing: progress.running, progress };
}
