import { useEffect, useState } from "react";
import type { MarketVolumeStats } from "../../../shared/types";
import { reportIpcError } from "./reportError";

/**
 * 读取市场交易额统计（Market 页）。订阅 IPC.MARKET_VOLUME 推送，
 * 组件卸载时移除监听。数据量小，直接组件内订阅即可，无需模块级单例。
 */
export function useMarketVolume(): MarketVolumeStats | null {
  const [stats, setStats] = useState<MarketVolumeStats | null>(null);

  useEffect(() => {
    let mounted = true;
    window.tbh
      .getMarketVolume()
      .then((next) => {
        if (mounted) setStats(next);
      })
      .catch(reportIpcError);
    const off = window.tbh.onMarketVolume((next) => setStats(next));
    return () => {
      mounted = false;
      if (typeof off === "function") off();
    };
  }, []);

  return stats;
}
