import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuRefreshCw, LuDownload, LuUpload } from "react-icons/lu";
import { MarketVolumeSection } from "../components/market/MarketVolumeSection";
import { ItemVolumeCard } from "../components/market/ItemVolumeCard";
import { TradingFilters } from "../components/market/TradingFilters";
import { useMarketVolumeItems } from "../lib/useMarketVolumeItems";
import { useMarketVolume } from "../lib/useMarketVolume";
import { useLookupCatalog } from "../lib/useLookupCatalog";
import { useEntityPanel } from "../context/entityPanelContext";
import { marketHashName } from "../../core/marketName";
import {
  RANGE_HOURS,
  sortItemsByWindowTotal,
  type RefreshStatus,
  type VolumeRange,
} from "../lib/windowTotal";
import {
  DEFAULT_TRADING_FILTER,
  aggregateFilteredToHourly,
  filterVolumeItems,
  gearTypeOptionsFromVolumeItems,
  gradeOptionsFromVolumeItems,
  hasActiveTradingFilter,
  itemCountsByCategoryFromItems,
  materialKindOptionsFromVolumeItems,
  topItemByHourAndCategory,
  type TradingFilterState,
} from "../lib/tradingFilters";
import { cn } from "../design-system/lib/variants";
import { Card } from "../design-system/primitives/Card/Card";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";

/**
 * 「交易」页：市场总交易额走势 + 按「当前时间窗口内成交额」降序排列的单物品卡片
 * （每张卡片带该物品的小型成交额走势图）。
 *
 * 时间窗口在此统一管理：主图表与所有卡片共享同一个 `range`（1d/1w/1m/全部）
 * 与 `offset`（拖动偏移）。主图表可拖拽平移、卡片走势图显示与主图表完全相同
 * 的时间段。数据源与 Market 页一致（pricehistory 按小时聚合，未拉取到历史时
 * 回退到轮询快照）。右上角「刷新历史价格」按钮会强制拉取星标 ∪ 快照价格达标
 * 物品的 pricehistory，并实时展示刷新进度；待刷新的物品就地在主卡片列表中展示
 * （带刷新亮环），筛选与排序对全部卡片统一生效。
 */
export function Trading() {
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const { t: tTabs } = useTranslation("tabs");
  const { t } = useTranslation("market");
  const { stats, pending, refresh, refreshing, progress, refreshItem, cancelRefresh } =
    useMarketVolumeItems();
  const volumeStats = useMarketVolume();
  const catalog = useLookupCatalog();
  const { open } = useEntityPanel();

  // market_hash_name -> 图鉴 item id：交易卡片点击时据此打开与图鉴同款的物品详情。
  // 复用 LookupPriceChangeLog 的映射方式（marketName.marketHashName）。
  const itemIdByHash = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of catalog ?? []) {
      const hash = marketHashName(item);
      if (hash) map.set(hash, item.id);
    }
    return map;
  }, [catalog]);

  // 卡片点击打开详情：hash 能反查到图鉴 item（可交易）才打开，否则无操作。
  const openItemDetail = useCallback(
    (hash: string) => {
      const id = itemIdByHash.get(hash);
      if (id != null) open({ type: "item", id });
    },
    [itemIdByHash, open],
  );

  const hourly = useMemo(() => volumeStats?.hourly ?? [], [volumeStats]);

  // 主图表时间窗口（range + 拖动偏移），与下方卡片共享。
  const [range, setRange] = useState<VolumeRange>("1d");
  const [mainOffset, setMainOffset] = useState(0);
  // 松手时提交的 offset：驱动排序与所有卡片的时间区间（拖动期间保持上一区间）。
  const [committedOffset, setCommittedOffset] = useState(0);
  // 导出/导入操作的结果提示与导入进行中状态。
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // 窗口宽度 = 当前范围内的小时点数（"all" 展示全量）。若历史数据不足范围，
  // 宽度回缩到实际点数，此时无偏移余地（maxOffset=0）。
  const windowWidth = range === "all" ? hourly.length : Math.min(RANGE_HOURS[range], hourly.length);
  const maxOffset = Math.max(0, hourly.length - windowWidth);
  const clampedOffset = Math.min(mainOffset, maxOffset);

  // 主图表当前显示窗口的起止索引（基于全量 hourly 长度决定窗口位置；升序切片）。
  // 主图表跟随 mainOffset 急迫更新，保证拖动跟手。展示内容见下方 `chartWindowPts`
  // （筛选激活时基于筛选子集重聚合），此处只负责定位窗口位置。
  const windowStartIdx = Math.max(0, hourly.length - windowWidth - clampedOffset);
  const windowEndIdx = hourly.length - clampedOffset;

  // 拖动是高频交互：真正卡顿的不是主图表重画，而是「窗口成交额求和 → 全量排序 →
  // 每张卡片迷你 SVG 重建」这条链。因此把 offset 拆成两级：
  // - `mainOffset`：急迫值，拖动期间每帧驱动主图表跟手平移；
  // - `committedOffset`：松手时才提交，驱动排序与所有卡片的时间区间。
  // 拖动过程中卡片保持上一提交区间不重渲染，松手时一次性同步到最终区间。
  const committedClampedOffset = Math.min(committedOffset, maxOffset);
  const committedStartIdx = Math.max(0, hourly.length - windowWidth - committedClampedOffset);
  const committedEndIdx = hourly.length - committedClampedOffset;
  const committedWindowPts = useMemo(
    () => hourly.slice(committedStartIdx, committedEndIdx),
    [hourly, committedStartIdx, committedEndIdx],
  );
  const windowRange = useMemo(
    () =>
      committedWindowPts.length > 0
        ? {
            start: committedWindowPts[0].hour,
            end: committedWindowPts[committedWindowPts.length - 1].hour,
          }
        : null,
    [committedWindowPts],
  );

  const handleRangeChange = (r: VolumeRange) => {
    setRange(r);
    setMainOffset(0);
    setCommittedOffset(0);
  };

  const items = useMemo(() => stats?.items ?? [], [stats]);

  // 物品卡排序：主列表当前展示的全部卡片（含 kind=live）按「当前时间窗口成交额」
  // 降序的 hash 顺序。点「刷新历史价格」时传给 main 作为严格刷新顺序，使逐个更新
  // 的顺序与卡片排序完全一致（忽略筛选，保证刷新覆盖全部有数据的卡片）。
  const cardOrder = useMemo(
    () => sortItemsByWindowTotal(items, windowRange).map((i) => i.hash),
    [items, windowRange],
  );

  // 卡片筛选状态：名称 / 品质 / 部位 / 种类 / 等级。选项从 items 全量推导，
  // 保证选项在筛选过程中不随已选条件收缩（与 Lookup 页一致）。
  const [filter, setFilter] = useState<TradingFilterState>(DEFAULT_TRADING_FILTER);
  const gradeOptions = useMemo(() => gradeOptionsFromVolumeItems(items), [items]);
  const gearTypeOptions = useMemo(() => gearTypeOptionsFromVolumeItems(items), [items]);
  const materialKindOptions = useMemo(() => materialKindOptionsFromVolumeItems(items), [items]);

  // 刷新期间待刷新的目标物品（pending）就地合并进主卡片列表，不再单独开占位网格
  // 展示——按 hash 去重：目标若已有交易额数据（`stats.items` 已含），复用其最新
  // 版本；尚无任何数据的目标（首次刷新）保留 `total=0` 的占位卡片。这样同一物品
  // 只出现一次，避免两处展示造成视觉重复；筛选与排序也因此对全部卡片（含待刷新
  // 目标）统一生效。刷新结束 pending 清空后收敛回全量单列表。
  const pendingByHash = useMemo(() => new Map(pending.map((p) => [p.hash, p])), [pending]);
  const displayItems = useMemo(() => {
    if (pendingByHash.size === 0) return items;
    // 已存在的目标卡片优先采用 `pending` 中的最新版本：批量刷新过程中 main 会通过
    // 进度通道逐物品推送 `updatedItem`（含拉取到的最新小时走势）替换占位卡片。若这里
    // 沿用 `items` 里的旧版本，卡片时间轴在整次（可能很长）刷新期间都不会跟随商品
    // 实时更新，导致「今天」部分显示为空/为零——单卡片手动刷新因即时广播 ITEMS 而正常。
    const seen = new Set(items.map((i) => i.hash));
    const out = items.map((i) => pendingByHash.get(i.hash) ?? i);
    for (const p of pending) {
      if (!seen.has(p.hash)) out.push(p);
    }
    return out;
  }, [items, pending, pendingByHash]);

  // 按筛选状态过滤全部卡片（含待刷新目标），再按「当前时间窗口内的成交额」降序
  // 排列。排序器预计算窗口成交额避免反复全量扫描 points。数值筛选（成交额/成交量
  // 取当前时段、价格取最新价）随 `windowRange` 联动。
  const filteredItems = useMemo(
    () => filterVolumeItems(displayItems, filter, windowRange),
    [displayItems, filter, windowRange],
  );
  const sortedItems = useMemo(
    () => sortItemsByWindowTotal(filteredItems, windowRange),
    [filteredItems, windowRange],
  );

  // 上方大图表跟随筛选联动：筛选激活时，基于筛选后的物品子集重聚合小时走势与
  // 分类物品种数（只聚合 history 卡片，与主进程 hourly 口径一致）；未筛选时保持
  // 主进程聚合的原始 hourly，行为不变。窗口位置仍由上方 range/offset 控制。
  const hasActiveFilter = useMemo(() => hasActiveTradingFilter(filter), [filter]);
  const filteredHourly = useMemo(
    () => (hasActiveFilter ? aggregateFilteredToHourly(filteredItems) : hourly),
    [hasActiveFilter, filteredItems, hourly],
  );
  const chartWindowPts = useMemo(
    () => filteredHourly.slice(windowStartIdx, windowEndIdx),
    [filteredHourly, windowStartIdx, windowEndIdx],
  );
  const chartCountsByCategory = useMemo(
    () =>
      hasActiveFilter
        ? itemCountsByCategoryFromItems(filteredItems)
        : (volumeStats?.itemCountsByCategory ?? {}),
    [hasActiveFilter, filteredItems, volumeStats],
  );

  // 大图表 tooltip 里「每分类第一交易额物品」的查询表（hour -> 分类 -> 物品名）。
  // 跟随筛选联动：筛选激活时基于筛选子集（与上方重聚合口径一致），否则用全量物品集。
  const chartTopItems = useMemo(
    () => topItemByHourAndCategory(hasActiveFilter ? filteredItems : items),
    [hasActiveFilter, filteredItems, items],
  );

  // 刷新批次状态：hash -> 灰（待刷新）/ 黄（当前批次）/ 绿（已刷新）。
  // 只要 `pending` 有值就构建状态映射（不依赖 `refreshing` 时序），保证刷新期间
  // 占位卡片与主列表卡片都能拿到亮环状态；刷新结束 hook 会清空 pending。
  const refreshStatusByHash = useMemo(() => {
    const map: Record<string, RefreshStatus> = {};
    pending.forEach((it, i) => {
      map[it.hash] =
        i < progress.done ? "refreshed" : i === progress.done ? "refreshing" : "pending";
    });
    return map;
  }, [pending, progress.done]);

  // 导出：调主进程保存对话框写入历史快照 JSON，结果以提示条展示。
  const handleExportHistory = async () => {
    const res = await window.tbh.exportMarketVolumeHistory();
    if (res.canceled) return;
    if (res.ok && res.path) setHistoryNotice(t("trading.exportSuccess", { path: res.path }));
    else setHistoryNotice(t("trading.exportFailed", { reason: res.reason ?? "unknown" }));
  };

  // 导入：确认后整体替换交易页历史数据，结果以提示条展示。
  const handleImportHistory = async () => {
    if (!window.confirm(t("trading.importConfirm"))) return;
    setImporting(true);
    try {
      const res = await window.tbh.importMarketVolumeHistory();
      if (res.canceled) return;
      if (res.ok && res.itemCount !== undefined)
        setHistoryNotice(t("trading.importSuccess", { count: res.itemCount }));
      else setHistoryNotice(t("trading.importFailed", { reason: res.reason ?? "unknown" }));
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  return (
    <TabPage>
      <TabHeader title={tTabs("trading")} intro={t("trading.intro")} />

      <div className="flex flex-col gap-3.5">
        <MarketVolumeSection
          windowPts={chartWindowPts}
          topItemsByCategory={chartTopItems}
          latest={hasActiveFilter ? null : (volumeStats?.latest ?? null)}
          itemCountsByCategory={chartCountsByCategory}
          currency={volumeStats?.currency ?? "USD"}
          range={range}
          offset={clampedOffset}
          maxOffset={maxOffset}
          onRangeChange={handleRangeChange}
          onOffsetChange={setMainOffset}
          onOffsetCommit={setCommittedOffset}
        />

        <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-sm font-semibold text-fg">{t("trading.itemsTitle")}</h3>
            <div className="flex items-center gap-2">
              {stats && items.length > 0 ? (
                <span className="text-[13px] text-muted">
                  {t("trading.count", { count: filteredItems.length })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => refresh(cardOrder)}
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
              <button
                type="button"
                onClick={handleExportHistory}
                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-fg"
                title={t("trading.exportHistory")}
                aria-label={t("trading.exportHistory")}
              >
                <LuDownload className="size-3" aria-hidden />
                {t("trading.exportHistory")}
              </button>
              <button
                type="button"
                onClick={handleImportHistory}
                disabled={importing}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-fg",
                  importing && "cursor-not-allowed opacity-60",
                )}
                title={t("trading.importHistory")}
                aria-label={t("trading.importHistory")}
              >
                <LuUpload className="size-3" aria-hidden />
                {t("trading.importHistory")}
              </button>
              {refreshing && (
                <button
                  type="button"
                  onClick={cancelRefresh}
                  className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-fg"
                  title={t("trading.stopRefresh")}
                  aria-label={t("trading.stopRefresh")}
                >
                  {t("trading.stopRefresh")}
                </button>
              )}
            </div>
          </div>

          {/* 卡片筛选：名称 / 品质 / 部位 / 种类 / 等级。 */}
          {items.length > 0 && (
            <TradingFilters
              query={filter.query}
              gradeFilter={filter.gradeFilter}
              gearTypeFilter={filter.gearTypeFilter}
              materialKindFilter={filter.materialKindFilter}
              levelRange={filter.levelRange}
              minTotal={filter.minTotal}
              minVolume={filter.minVolume}
              minPrice={filter.minPrice}
              currency={stats?.currency ?? "USD"}
              gradeOptions={gradeOptions}
              gearTypeOptions={gearTypeOptions}
              materialKindOptions={materialKindOptions}
              shownCount={filteredItems.length}
              onQueryChange={(q) => setFilter((f) => ({ ...f, query: q }))}
              onGradeFilterChange={(g) => setFilter((f) => ({ ...f, gradeFilter: g }))}
              onGearTypeFilterChange={(g) => setFilter((f) => ({ ...f, gearTypeFilter: g }))}
              onMaterialKindFilterChange={(m) =>
                setFilter((f) => ({ ...f, materialKindFilter: m }))
              }
              onLevelRangeChange={(range) => setFilter((f) => ({ ...f, levelRange: range }))}
              onMinTotalChange={(v) => setFilter((f) => ({ ...f, minTotal: v }))}
              onMinVolumeChange={(v) => setFilter((f) => ({ ...f, minVolume: v }))}
              onMinPriceChange={(v) => setFilter((f) => ({ ...f, minPrice: v }))}
            />
          )}

          {/* 刷新历史价格期间 Steam Cookie 失效（pricehistory 返回 400）：刷新已终止，提示去设置更新。 */}
          {progress.cookieExpired && (
            <HintBanner className="mt-1.5 border-l-danger" aria-live="polite">
              {t("trading.cookieExpired")}
            </HintBanner>
          )}

          {/* 刷新历史价格期间的实时进度条；待刷新目标卡片已合并进下方主列表（带亮环），不再单独展示。 */}
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
            </div>
          )}

          {historyNotice && (
            <p className="m-0 mt-1.5 text-[12px] text-muted" aria-live="polite">
              {historyNotice}
            </p>
          )}

          {displayItems.length === 0 ? (
            <Card padding="compact" className="text-muted">
              {t("trading.empty")}
            </Card>
          ) : sortedItems.length === 0 ? (
            <Card padding="compact" className="text-muted">
              {t("trading.emptyFiltered")}
            </Card>
          ) : (
            <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {sortedItems.map((item) => (
                <ItemVolumeCard
                  key={item.hash}
                  item={item}
                  currency={stats?.currency ?? "USD"}
                  windowRange={windowRange}
                  refreshStatus={refreshStatusByHash[item.hash]}
                  onRefresh={refreshStatusByHash[item.hash] ? undefined : refreshItem}
                  onOpenDetail={openItemDetail}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </TabPage>
  );
}
