import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuRefreshCw } from "react-icons/lu";
import {
  MarketVolumeSection,
  RANGE_HOURS,
  type VolumeRange,
} from "../components/market/MarketVolumeSection";
import { ItemVolumeCard } from "../components/market/ItemVolumeCard";
import { useMarketVolumeItems } from "../lib/useMarketVolumeItems";
import { useMarketVolume } from "../lib/useMarketVolume";
import { cn } from "../design-system/lib/variants";
import { Card } from "../design-system/primitives/Card/Card";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";

/**
 * 「交易」页：市场总交易额走势 + 按总交易额降序排列的单物品卡片（每张卡片带
 * 该物品的小型成交额走势图）。
 *
 * 时间窗口在此统一管理：主图表与所有卡片共享同一个 `range`（1d/1w/1m/全部）
 * 与 `offset`（拖动偏移）。主图表可拖拽平移、卡片走势图显示与主图表完全相同
 * 的时间段。数据源与 Market 页一致（pricehistory 按小时聚合，未拉取到历史时
 * 回退到轮询快照）。右上角「刷新历史价格」按钮会强制拉取星标 ∪ 快照价格达标
 * 物品的 pricehistory，并实时展示刷新进度与待刷新的物品占位卡片。
 */
export function Trading() {
  const { t: tTabs } = useTranslation("tabs");
  const { t } = useTranslation("market");
  const { stats, pending, refresh, refreshing, progress } = useMarketVolumeItems();
  const volumeStats = useMarketVolume();

  const hourly = volumeStats?.hourly ?? [];

  // 主图表时间窗口（range + 拖动偏移），与下方卡片共享。
  const [range, setRange] = useState<VolumeRange>("1d");
  const [mainOffset, setMainOffset] = useState(0);

  // 窗口宽度 = 当前范围内的小时点数（"all" 展示全量）。若历史数据不足范围，
  // 宽度回缩到实际点数，此时无偏移余地（maxOffset=0）。
  const windowWidth = range === "all" ? hourly.length : Math.min(RANGE_HOURS[range], hourly.length);
  const maxOffset = Math.max(0, hourly.length - windowWidth);
  const clampedOffset = Math.min(mainOffset, maxOffset);

  // 主图表当前显示窗口（升序切片），以及对应的时间范围（供卡片过滤）。
  const windowStartIdx = Math.max(0, hourly.length - windowWidth - clampedOffset);
  const windowEndIdx = hourly.length - clampedOffset;
  const windowPts = hourly.slice(windowStartIdx, windowEndIdx);
  const windowRange =
    windowPts.length > 0
      ? { start: windowPts[0].hour, end: windowPts[windowPts.length - 1].hour }
      : null;

  const handleRangeChange = (r: VolumeRange) => {
    setRange(r);
    setMainOffset(0);
  };

  const items = stats?.items ?? [];

  return (
    <TabPage>
      <TabHeader title={tTabs("trading")} intro={t("trading.intro")} />

      <div className="flex flex-col gap-3.5">
        <MarketVolumeSection
          windowPts={windowPts}
          latest={volumeStats?.latest ?? null}
          itemCountsByCategory={volumeStats?.itemCountsByCategory ?? {}}
          currency={volumeStats?.currency ?? "USD"}
          range={range}
          offset={clampedOffset}
          maxOffset={maxOffset}
          onRangeChange={handleRangeChange}
          onOffsetChange={setMainOffset}
        />

        <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-sm font-semibold text-fg">{t("trading.itemsTitle")}</h3>
            <div className="flex items-center gap-2">
              {stats && items.length > 0 ? (
                <span className="text-[13px] text-muted">
                  {t("trading.count", { count: items.length })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-fg",
                  refreshing && "cursor-not-allowed opacity-60",
                )}
                title={t("trading.refreshHistory")}
                aria-label={t("trading.refreshHistory")}
                aria-busy={refreshing}
              >
                <LuRefreshCw className={cn("size-3", refreshing && "animate-spin")} aria-hidden />
                {refreshing && progress.total > 0
                  ? t("trading.refreshing", { done: progress.done, total: progress.total })
                  : t("trading.refresh")}
              </button>
            </div>
          </div>

          {/* 刷新历史价格期间的实时进度提示（含待刷新的物品占位卡片）。 */}
          {refreshing && progress.total > 0 && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <div
                className="h-1 overflow-hidden rounded-full bg-border"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
              >
                <div
                  className="h-full rounded-full bg-fg transition-all"
                  style={{
                    width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              {pending.length > 0 && (
                <>
                  <h4 className="m-0 text-xs font-medium text-muted">
                    {t("trading.refreshingItems")}
                  </h4>
                  <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 xl:grid-cols-3">
                    {pending.map((item) => (
                      <ItemVolumeCard
                        key={item.hash}
                        item={item}
                        currency={stats?.currency ?? "USD"}
                        windowRange={windowRange}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {items.length === 0 ? (
            <Card padding="compact" className="text-muted">
              {t("trading.empty")}
            </Card>
          ) : (
            <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <ItemVolumeCard
                  key={item.hash}
                  item={item}
                  currency={stats?.currency ?? "USD"}
                  windowRange={windowRange}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </TabPage>
  );
}
