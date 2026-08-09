import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTrendingUp } from "react-icons/lu";
import type { MarketVolumeHourPoint, MarketVolumeSample } from "../../../../shared/types";
import { formatMoney } from "../../../core/steamPrice";
import { Card } from "../../design-system/primitives/Card/Card";

/** 主图表时间范围。 */
export type VolumeRange = "1d" | "1w" | "1m" | "all";

/** 各范围对应的窗口小时数（"all" 用全量点数）。 */
export const RANGE_HOURS: Record<Exclude<VolumeRange, "all">, number> = {
  "1d": 24,
  "1w": 168,
  "1m": 720,
};

/** 交易额展示的 5 大分类及其堆叠顺序（自底向上）。 */
const VOLUME_CATEGORY_ORDER = ["WEAPON", "ARMOR", "ACCESSORY", "MATERIAL", "COIN"] as const;
const VOLUME_CATEGORY_COLORS: Record<string, string> = {
  WEAPON: "#5ad17a",
  ARMOR: "#5b8def",
  ACCESSORY: "#b07ce3",
  MATERIAL: "#e0a15b",
  COIN: "#e6c04c",
};

/** 走势图坐标轴用本地化小时。 */
function hourLabel(hourIso: string): string {
  const d = new Date(hourIso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 走势图坐标轴标签：按范围显示，1d 显示「日期 时间」，1w/1m/全部显示「日期」。 */
function axisLabel(hourIso: string, range: VolumeRange): string {
  const d = new Date(hourIso);
  const date = d.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
  if (range === "1d") {
    return `${date} ${hourLabel(hourIso)}`;
  }
  return date;
}

/** 把类别 key（gearGroup/materialType）翻译成展示名，未知 key 原样显示。 */
function categoryLabel(key: string, translate: (k: string) => string): string {
  const label = translate(`volume.category.${key}`);
  return label.startsWith("volume.category.") ? key : label;
}

/** 对窗口内的点求和：总交易额 + 各类别交易额。 */
function sumRange(points: MarketVolumeHourPoint[]): {
  total: number;
  byCategory: Record<string, number>;
} {
  let total = 0;
  const byCategory: Record<string, number> = {};
  for (const p of points) {
    total += p.total;
    for (const [key, value] of Object.entries(p.byCategory ?? {})) {
      byCategory[key] = (byCategory[key] ?? 0) + value;
    }
  }
  return { total, byCategory };
}

/**
 * 交易页的「近期市场交易额」区块：总交易额 + 各类别交易额 + 按小时走势图。
 * 受控组件——时间窗口由父级（Trading 页）统一管理，主图表支持鼠标拖拽平移
 * 当前范围，卡片走势图与主图表共享同一时间窗口。
 *
 * 主数据来自 Steam pricehistory 的真实小时成交额（可切换 1d/1w/1m/全部）；
 * 历史数据尚未拉取时回退到轮询的 24h 滚动快照。
 */
export function MarketVolumeSection({
  windowPts,
  latest,
  itemCountsByCategory = {},
  currency,
  range,
  offset,
  maxOffset,
  onRangeChange,
  onOffsetChange,
}: {
  /** 主图表当前显示窗口的小时点（升序）。 */
  windowPts: MarketVolumeHourPoint[];
  /** 最近一次轮询采样（24h 滚动快照）；无历史时回退展示。 */
  latest: MarketVolumeSample | null;
  /** 各分类覆盖的物品种数：类别 key -> 数量。 */
  itemCountsByCategory?: Record<string, number>;
  currency: string;
  range: VolumeRange;
  offset: number;
  maxOffset: number;
  onRangeChange: (r: VolumeRange) => void;
  onOffsetChange: (o: number) => void;
}) {
  const { t } = useTranslation("market");
  const agg = useMemo(() => sumRange(windowPts), [windowPts]);
  const hasHistory = windowPts.length > 0 && agg.total > 0;

  // 无历史数据：回退到轮询 latest（24h 滚动快照）展示概览。
  if (!hasHistory) {
    if (!latest || latest.items === 0) {
      return (
        <Card padding="compact" className="text-muted">
          <CollapsibleTitleLabel label={t("volume.title")} />
          <p className="m-0 text-[13px]">{t("volume.empty")}</p>
        </Card>
      );
    }
    return (
      <div className="flex flex-col gap-3.5 border-t border-border pt-3.5">
        <CollapsibleTitleLabel label={t("volume.title")} />
        <VolumeBreakdown
          total={latest.total}
          byCategory={latest.byCategory}
          currency={currency}
          range="1d"
        />
        <p className="m-0 text-[13px] text-muted">{t("volume.noTrend")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5 border-t border-border pt-3.5">
      <div className="flex items-center justify-between">
        <CollapsibleTitleLabel label={t("volume.title")} />
        <div className="flex items-center gap-2">
          {offset > 0 && (
            <button
              type="button"
              onClick={() => onOffsetChange(0)}
              className="rounded bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted hover:bg-muted/40 hover:text-fg"
              title="重置到最新时间范围"
            >
              ↻
            </button>
          )}
          <RangeToggle value={range} onChange={onRangeChange} />
        </div>
      </div>
      <VolumeBreakdown
        total={agg.total}
        byCategory={agg.byCategory}
        currency={currency}
        range={range}
      />
      <VolumeTrendChart
        points={windowPts}
        itemCountsByCategory={itemCountsByCategory}
        currency={currency}
        range={range}
        offset={offset}
        maxOffset={maxOffset}
        onOffsetChange={onOffsetChange}
      />
    </div>
  );
}

function CollapsibleTitleLabel({ label }: { label: string }) {
  return (
    <h3 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-fg">
      <LuTrendingUp className="size-3.5 text-muted" aria-hidden />
      {label}
    </h3>
  );
}

/** 1d / 1w / 1m / 全部 切换按钮。 */
function RangeToggle({
  value,
  onChange,
}: {
  value: VolumeRange;
  onChange: (r: VolumeRange) => void;
}) {
  const { t } = useTranslation("market");
  const options: Array<{ value: VolumeRange; label: string }> = [
    { value: "1d", label: t("volume.range1d") },
    { value: "1w", label: t("volume.range1w") },
    { value: "1m", label: t("volume.range1m") },
    { value: "all", label: t("volume.rangeAll") },
  ];
  return (
    <div className="flex overflow-hidden rounded border border-border text-[11px] leading-none">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`cursor-pointer border-r border-border px-2 py-1 transition-colors last:border-r-0 ${
              active ? "bg-accent text-on-accent" : "bg-surface text-muted hover:text-fg"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 总交易额 + 各类别列表。 */
function VolumeBreakdown({
  total,
  byCategory,
  currency,
  range,
}: {
  total: number;
  byCategory: Record<string, number>;
  currency: string;
  range?: VolumeRange;
}) {
  const { t } = useTranslation("market");
  const categories = useMemo(
    () =>
      Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => ({ key, value })),
    [byCategory],
  );
  const rangeLabel = range ? t(`volume.range${range}`) : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-muted">
          {t("volume.totalLabel", { range: rangeLabel })}
        </span>
        <span className="text-lg font-semibold text-fg">{formatMoney(total, currency)}</span>
      </div>
      <ul className="m-0 list-none space-y-1 p-0 text-[13px]">
        {categories.map(({ key, value }) => (
          <li key={key} className="flex items-center justify-between gap-2">
            <span className="text-muted">{categoryLabel(key, t)}</span>
            <span className="font-medium text-fg">{formatMoney(value, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 按小时的分类别交易额「堆叠」走势图（SVG，无第三方图表依赖）。
 * 各类别自底向上堆叠：底层基线 = 下方各类别累积值，顶层 = 总交易额。
 * 图例标注各类别覆盖的物品数量，头部标注统计物品总数。
 * 支持鼠标拖拽平移当前时间窗口（offset 由父级控制）。
 */
function VolumeTrendChart({
  points,
  itemCountsByCategory = {},
  currency,
  range = "1d",
  offset,
  maxOffset,
  onOffsetChange,
}: {
  points: MarketVolumeHourPoint[];
  itemCountsByCategory?: Record<string, number>;
  currency: string;
  range?: VolumeRange;
  offset: number;
  maxOffset: number;
  onOffsetChange: (o: number) => void;
}) {
  const { t } = useTranslation("market");
  const svgRef = useRef<SVGSVGElement>(null);
  // 悬浮选中的点索引；null 表示未悬浮。
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // 拖拽平移当前范围。
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startOffset: number } | null>(null);

  // 计算每个分类的小时序列、堆叠起始基线、顶层总序列与坐标映射。
  const chart = useMemo(() => {
    const tops: Record<string, number[]> = {};
    for (const cat of VOLUME_CATEGORY_ORDER) {
      tops[cat] = points.map((p) => p.byCategory?.[cat] ?? 0);
    }
    const baselines: Record<string, number[]> = {};
    let acc = Array(points.length).fill(0);
    for (const cat of VOLUME_CATEGORY_ORDER) {
      baselines[cat] = acc;
      acc = acc.map((v, i) => v + tops[cat][i]);
    }
    const totalTop = acc;
    const max = Math.max(1, ...acc);
    // x 按真实时间戳在首尾时间区间内的比例定位（而非按点数等距），
    // 保证横轴上每个粒度对应的时间位置准确，缺失的时间段自然留出空隙。
    const tStart = Date.parse(points[0].hour);
    const tSpan = Date.parse(points[points.length - 1].hour) - tStart;
    const x = (i: number) =>
      points.length === 1 || tSpan <= 0
        ? 50
        : ((Date.parse(points[i].hour) - tStart) / tSpan) * 100;
    const y = (v: number) => 40 - (v / max) * 40;
    const areaPaths = VOLUME_CATEGORY_ORDER.map((cat) => {
      const topPts = points
        .map((_, i) => `${x(i)},${y(baselines[cat][i] + tops[cat][i])}`)
        .join(" L ");
      const bottomPts = points
        .map((_, i) => `${x(i)},${y(baselines[cat][i])}`)
        .reverse()
        .join(" L ");
      return `M ${topPts} L ${bottomPts} Z`;
    });
    const outline = `M ${points.map((_, i) => `${x(i)},${y(totalTop[i])}`).join(" L ")}`;
    return { areaPaths, outline, x, y, tStart, tSpan };
  }, [points]);

  const canDrag = maxOffset > 0;

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0 || !canDrag) return;
    dragStartRef.current = { startX: e.clientX, startOffset: offset };
    setIsDragging(true);
    setHoverIndex(null);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;

    // 拖拽中：根据鼠标水平位移平移时间窗口。向左拖（deltaX<0）→ 内容露出更早 → offset 增大。
    if (isDragging && dragStartRef.current) {
      const deltaX = e.clientX - dragStartRef.current.startX;
      const deltaPoints = Math.round((deltaX / rect.width) * maxOffset);
      const next = Math.max(0, Math.min(maxOffset, dragStartRef.current.startOffset + deltaPoints));
      onOffsetChange(next);
      setHoverIndex(null);
      return;
    }

    // 悬浮中：鼠标在 viewBox 0..100 内的 x 比例，反推时间戳后找最近数据点。
    const ratio = ((e.clientX - rect.left) / rect.width) * 100;
    const tHover = chart.tStart + (ratio / 100) * chart.tSpan;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(Date.parse(p.hour) - tHover);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHoverIndex(best);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
  };

  const handleMouseLeave = () => {
    if (!isDragging) setHoverIndex(null);
  };

  if (points.length === 0) {
    return <p className="m-0 text-[13px] text-muted">{t("volume.noTrend")}</p>;
  }

  const totalItemCount = VOLUME_CATEGORY_ORDER.reduce(
    (n, cat) => n + (itemCountsByCategory[cat] || 0),
    0,
  );

  const hoverPoint = hoverIndex != null ? points[hoverIndex] : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{t("volume.trendTitle")}</span>
        <span className="text-xs text-muted">
          {t("volume.itemCountTotal", { count: totalItemCount })}
        </span>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          className={`h-28 w-full ${isDragging ? "cursor-grabbing" : canDrag ? "cursor-grab" : ""}`}
          role="img"
          aria-label={t("volume.trendTitle")}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
          {VOLUME_CATEGORY_ORDER.map((cat, i) => (
            <path
              key={cat}
              d={chart.areaPaths[i]}
              fill={VOLUME_CATEGORY_COLORS[cat]}
              fillOpacity="0.55"
            />
          ))}
          {/* 总交易额顶部轮廓线（最顶层堆叠的外边界） */}
          <path
            d={chart.outline}
            fill="none"
            stroke="#333"
            strokeWidth={0.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* 悬浮指示竖线：定位到鼠标最近的数据点 */}
          {hoverIndex != null && (
            <line
              x1={chart.x(hoverIndex)}
              y1={0}
              x2={chart.x(hoverIndex)}
              y2={40}
              stroke="#666"
              strokeWidth={0.5}
              strokeDasharray="1.5 1.5"
            />
          )}
        </svg>
        {hoverPoint && hoverIndex != null && (
          <HoverTooltip
            point={hoverPoint}
            currency={currency}
            hoverX={chart.x(hoverIndex)}
            total={VOLUME_CATEGORY_ORDER.reduce(
              (sum, cat) => sum + (hoverPoint.byCategory?.[cat] ?? 0),
              0,
            )}
          />
        )}
      </div>
      {/* 图例：各类别颜色 + 名称 + 覆盖物品数量 */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {VOLUME_CATEGORY_ORDER.map((cat) => (
          <span key={cat} className="flex items-center gap-1 text-[11px] text-muted">
            <span
              className="inline-block size-2 shrink-0 rounded-sm"
              style={{ background: VOLUME_CATEGORY_COLORS[cat] }}
            />
            {categoryLabel(cat, t)}
            <span className="font-medium text-fg">{itemCountsByCategory[cat] || 0}</span>
          </span>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{axisLabel(points[0].hour, range)}</span>
        <span>{axisLabel(points[points.length - 1].hour, range)}</span>
      </div>
    </div>
  );
}

/**
 * 悬浮提示：显示该小时的时间与各类别交易额。
 * 定位基于 SVG 的 viewBox x 比例（0..100），通过外层 relative 容器对齐。
 */
function HoverTooltip({
  point,
  currency,
  total,
  hoverX,
}: {
  point: MarketVolumeHourPoint;
  currency: string;
  total: number;
  hoverX: number;
}) {
  const { t } = useTranslation("market");
  const categories = VOLUME_CATEGORY_ORDER.map((cat) => ({
    cat,
    value: point.byCategory?.[cat] ?? 0,
  }));
  // 时间本地化：完整显示日期 + 时间。
  const d = new Date(point.hour);
  const timeLabel = `${d.toLocaleDateString([], {
    month: "2-digit",
    day: "2-digit",
  })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  // 提示框相对容器宽度按百分比定位，超出右边缘时向左偏移避免溢出。
  const clamped = Math.min(Math.max(hoverX, 8), 92);
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-fg shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
      style={{ left: `${clamped}%` }}
    >
      <div className="mb-1 flex items-baseline justify-between gap-3 border-b border-border pb-1">
        <span className="text-muted">{timeLabel}</span>
        <span className="font-semibold">{formatMoney(total, currency)}</span>
      </div>
      <ul className="m-0 space-y-0.5 p-0" style={{ listStyle: "none" }}>
        {categories.map(({ cat, value }) => (
          <li key={cat} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted">
              <span
                className="inline-block size-2 shrink-0 rounded-sm"
                style={{ background: VOLUME_CATEGORY_COLORS[cat] }}
              />
              {categoryLabel(cat, t)}
            </span>
            <span className="font-medium text-fg">{formatMoney(value, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
