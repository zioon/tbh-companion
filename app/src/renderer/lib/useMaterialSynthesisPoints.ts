// useMaterialSynthesisPoints.ts
// 由 window.tbh 暴露的图鉴/来源/硬币数据，现算「特殊材料合成点覆盖表」
// （灵魂石=对应 ACT 箱期望、纪念硬币=offer 清单期望）。数据驱动、不手写数值，
// 与 main 进程 `TrackingService.getMaterialPointsOverride()` 同一套 `buildMaterialSynthesisPoints`。
// 结果在**模块级共享缓存**：任意组件实例复用同一次拉取与计算，避免列表卡/表格行重复请求。
// null=数据未就绪或计算失败，消费方应回退到按品质估值。

import { useEffect, useState } from "react";
import { buildMaterialSynthesisPoints } from "../../core/synthesisPoints";
import { reportIpcError } from "./reportError";

let cache: Record<number, number> | null = null;
let inflight: Promise<Record<number, number>> | null = null;

function load(): Promise<Record<number, number>> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = Promise.all([
      window.tbh.getLookupCatalog(),
      window.tbh.getLookupSources(),
      window.tbh.getOfferings(),
    ])
      .then(([items, sources, offerings]) => {
        const byId = new Map(items.map((i) => [i.id, i]));
        cache =
          buildMaterialSynthesisPoints({
            itemByKey: (itemKey) => byId.get(itemKey),
            boxDrops: (boxKey) => sources.boxes?.[boxKey]?.drops,
            offerings,
          }) ?? {};
        return cache;
      })
      .catch((err: unknown) => {
        cache = {};
        inflight = null;
        reportIpcError(err);
        return cache;
      });
  }
  return inflight;
}

export function useMaterialSynthesisPoints(): Record<number, number> | null {
  const [map, setMap] = useState<Record<number, number> | null>(cache);

  useEffect(() => {
    let mounted = true;
    void load().then((m) => {
      if (mounted) setMap(m);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return map;
}
