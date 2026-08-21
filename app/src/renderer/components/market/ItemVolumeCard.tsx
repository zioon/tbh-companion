import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuRefreshCw } from "react-icons/lu";
import type { MarketVolumeItem } from "../../../../shared/types";
import { formatMoney } from "../../../core/steamPrice";
import { fmtCompact } from "../../lib/format";
import { cn } from "../../design-system/lib/variants";
import { Card } from "../../design-system/primitives/Card/Card";
import { gradeColor } from "../../lib/gradeColor";
import { gradeLabel } from "../../lib/itemLabels";
import { downsample, sliceWindow, windowTotalOf, type RefreshStatus } from "../../lib/windowTotal";

/** 图表三色分离：价格折线=绿，成交量柱=蓝，交易额折线=红。 */
const PRICE_COLOR = "#22c55e";
const VOLUME_COLOR = "#3b82f6";
const TOTAL_COLOR = "#ef4444";

/** 卡片迷你走势图最多绘制的点数（高度仅 40px，超出即均匀降采样）。 */
const MAX_CARD_POINTS = 48;

/** 刷新状态亮环颜色：灰=待刷新，黄=当前批次，绿=已刷新。 */
const RING_COLOR: Record<RefreshStatus, string> = {
  pending: "#c3c9d4", // 灰（待刷新）—— 提亮，避免深色背景上不可见
  refreshing: "#f5d76a", // 黄（当前批次）
  refreshed: "#5ad17a", // 绿（已刷新）
};

/** 分类 key 的展示名（缺失时原样显示）。 */
function categoryLabel(key: string, translate: (k: string) => string): string {
  const t = translate(`volume.category.${key}`);
  return t.startsWith("volume.category.") ? key : t;
}

/**
 * 交易页的单物品卡片：物品名 + 窗口成交额 + 迷你走势图。
 * 走势图时间窗口由父级（Trading 页）统一控制。刷新批次（`refreshStatus`）驱动
 * 的卡片会包裹一层发光亮环：灰=待刷新、黄=当前批次（呼吸动画）、绿=已刷新；
 * 非刷新批次的卡片不显示亮环。
 */
export const ItemVolumeCard = memo(function ItemVolumeCard({
  item,
  currency,
  windowRange,
  refreshStatus,
  onRefresh,
}: {
  item: MarketVolumeItem;
  currency: string;
  windowRange?: { start: string; end: string } | null;
  refreshStatus?: RefreshStatus | null;
  /** 传入时卡片右上角显示小型「手动刷新」按钮；未传入则不显示。 */
  onRefresh?: (hash: string) => Promise<void> | void;
}) {
  const { t } = useTranslation("market");
  const color = gradeColor(item.grade ?? "");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // 单卡片手动刷新期间的本卡加载态（不进入整批刷新的 running 进度流）。
  const [refreshingCard, setRefreshingCard] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshingCard) return;
    setRefreshingCard(true);
    try {
      await onRefresh(item.hash);
    } finally {
      setRefreshingCard(false);
    }
  };

  const points = useMemo(() => {
    if (windowRange && windowRange.start && windowRange.end) {
      return sliceWindow(item.points, windowRange);
    }
    return item.points;
  }, [item.points, windowRange]);

  const windowTotal = useMemo(() => windowTotalOf(item, windowRange), [item, windowRange]);

  const windowVolume = useMemo(() => {
    // live 卡片的 volume 是 24h 滚动累计值（非小时增量），展示最新一个采样点的值。
    if (item.kind === "live") {
      const last = item.points[item.points.length - 1];
      return last ? last.volume : 0;
    }
    const src = windowRange && windowRange.start && windowRange.end ? points : item.points;
    return src.reduce((s, p) => s + p.volume, 0);
  }, [windowRange, points, item.points, item.kind]);

  // 刷新状态亮环。所有状态都先给静态发光描边（保证可见），黄色「当前批次」再
  // 叠加呼吸动画覆盖静态描边。描边 3px + 发光 18px 高不透明，深色卡片上清晰可辨。
  const ringColor = refreshStatus ? RING_COLOR[refreshStatus] : null;
  const isActive = refreshStatus === "refreshing";
  const ringStyle = ringColor
    ? ({
        "--ring-color": ringColor,
        "--ring-color-soft": `${ringColor}99`,
        boxShadow: `0 0 0 3px ${ringColor}, 0 0 18px ${ringColor}dd`,
      } as React.CSSProperties)
    : undefined;

  const chart = useMemo(() => {
    if (points.length === 0) return null;

    // 卡片小图高度仅 40px，先均匀降采样，减少 path 字符串长度与节点数量。
    const sampled = downsample(points, MAX_CARD_POINTS);
    const maxVol = Math.max(1, ...sampled.map((p) => p.volume));
    const maxPrice = Math.max(1, ...sampled.map((p) => p.price));
    const minPrice = Math.min(maxPrice, ...sampled.map((p) => p.price));
    const priceRange = maxPrice - minPrice || 1;
    const maxTotal = Math.max(1, ...sampled.map((p) => p.total));
    const minTotal = Math.min(maxTotal, ...sampled.map((p) => p.total));
    const totalRange = maxTotal - minTotal || 1;
    const n = sampled.length;
    const barAreaH = 16;
    const priceAreaH = 14;
    const barBottom = 40;
    const priceBottomBase = 4;
    const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
    const barHeight = (v: number) => (v / maxVol) * barAreaH;
    const priceY = (p: number) =>
      priceBottomBase + priceAreaH - ((p - minPrice) / priceRange) * priceAreaH;
    const totalY = (p: number) =>
      priceBottomBase + priceAreaH - ((p - minTotal) / totalRange) * priceAreaH;

    const bars = sampled.map((p, i) => {
      const h = barHeight(p.volume);
      return { x: x(i) - 0.4, y: barBottom - h, w: 0.8, h };
    });
    const pricePath = `M ${sampled.map((p, i) => `${x(i)},${priceY(p.price)}`).join(" L ")}`;
    const totalPath = `M ${sampled.map((p, i) => `${x(i)},${totalY(p.total)}`).join(" L ")}`;

    return {
      bars,
      pricePath,
      totalPath,
      x,
      first: sampled[0].hour,
      last: sampled[sampled.length - 1].hour,
      points: sampled,
    };
  }, [points]);

  // hoverIndex 可能因 Fast Refresh 状态保留或 points 收缩（实时刷新/切换窗口）而
  // 超出当前 chart.points 范围：渲染时钳制到有效区间，避免把 undefined 传给
  // HoverTooltip 读 .hour 崩溃。
  const safeHoverIndex =
    hoverIndex != null && chart != null ? Math.min(hoverIndex, chart.points.length - 1) : null;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!chart || chart.points.length === 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = ((e.clientX - rect.left) / rect.width) * 100;
    // 卡片小图 x 等距，最近点索引可直接由比例算出，无需线性扫描。
    const n = chart.points.length;
    const idx = Math.max(0, Math.min(n - 1, Math.round((ratio / 100) * (n - 1))));
    setHoverIndex(idx);
  };

  const handleMouseLeave = () => setHoverIndex(null);

  return (
    <div
      className={cn("h-full", ringColor ? "rounded-lg p-0.5" : "", isActive && "animate-ring-glow")}
      style={ringStyle}
    >
      <Card padding="compact" className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ background: color }}
                aria-hidden
              />
              <p
                className="m-0 truncate text-[13px] font-medium"
                style={{ color }}
                title={item.name}
              >
                {item.name}
              </p>
            </div>
            <p className="m-0 text-[11px] text-muted">
              {categoryLabel(item.category, t)}
              {item.grade ? ` · ${gradeLabel(item.grade, t)}` : ""}
              {item.kind === "live"
                ? ` · ${t("trading.activity")}`
                : item.points.length > 0
                  ? ` · ${t("volume.trendTitle")}`
                  : ` · ${t("trading.snapshot")}`}
            </p>
          </div>
          <div className="flex shrink-0 items-start gap-1.5">
            {onRefresh && (
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshingCard}
                title={t("trading.refresh")}
                aria-label={t("trading.refresh")}
                className="rounded p-0.5 text-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LuRefreshCw
                  className={cn("size-3", refreshingCard && "animate-spin")}
                  aria-hidden
                />
              </button>
            )}
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-sm font-semibold text-fg">
                {formatMoney(windowTotal, currency)}
              </span>
              <span className="text-[11px] text-muted">成交量 {fmtCompact(windowVolume)}</span>
            </div>
          </div>
        </div>

        {chart ? (
          <div className="flex flex-col gap-0.5">
            <div className="relative">
              <svg
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
                className="h-10 w-full"
                role="img"
                aria-label={`${item.name} ${t("volume.trendTitle")}`}
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
              >
                {chart.bars.map((b, i) => (
                  <rect
                    key={i}
                    x={b.x}
                    y={b.y}
                    width={b.w}
                    height={Math.max(0.1, b.h)}
                    fill={VOLUME_COLOR}
                    fillOpacity={0.55}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path
                  d={chart.pricePath}
                  fill="none"
                  stroke={PRICE_COLOR}
                  strokeWidth={1}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={chart.totalPath}
                  fill="none"
                  stroke={TOTAL_COLOR}
                  strokeWidth={1}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                {safeHoverIndex != null && (
                  <line
                    x1={chart.x(safeHoverIndex)}
                    y1={2}
                    x2={chart.x(safeHoverIndex)}
                    y2={40}
                    stroke={color}
                    strokeOpacity={0.6}
                    strokeWidth={0.3}
                    strokeDasharray="1 1"
                  />
                )}
              </svg>
              {safeHoverIndex != null && (
                <HoverTooltip
                  point={chart.points[safeHoverIndex]}
                  currency={currency}
                  hoverX={chart.x(safeHoverIndex)}
                />
              )}
            </div>
            <div className="flex justify-between text-[10px] text-muted">
              <span>
                {new Date(chart.first).toLocaleDateString([], {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                })}
              </span>
              <span>
                {new Date(chart.last).toLocaleDateString([], {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                })}
              </span>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
});

/**
 * 悬浮提示：显示该小时的时间、价格、成交量、成交额。
 */
function HoverTooltip({
  point,
  currency,
  hoverX,
}: {
  point: { hour: string; price: number; volume: number; total: number };
  currency: string;
  hoverX: number;
}) {
  const d = new Date(point.hour);
  const timeLabel = `${d.toLocaleDateString([], {
    month: "2-digit",
    day: "2-digit",
  })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;

  const clamped = Math.min(Math.max(hoverX, 15), 85);
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[10px] text-fg shadow-md"
      style={{ left: `${clamped}%`, bottom: "100%", marginBottom: "4px" }}
    >
      <div className="mb-0.5 text-muted">{timeLabel}</div>
      <div className="flex justify-between gap-3">
        <span className="text-muted">价格</span>
        <span className="font-medium">{formatMoney(point.price, currency)}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-muted">成交量</span>
        <span className="font-medium">{point.volume}</span>
      </div>
      <div className="flex justify-between gap-3 border-t border-border pt-0.5 mt-0.5">
        <span className="text-muted">额</span>
        <span className="font-semibold">{formatMoney(point.total, currency)}</span>
      </div>
    </div>
  );
}
