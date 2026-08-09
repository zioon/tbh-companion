import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MarketVolumeItem } from "../../../../shared/types";
import { formatMoney } from "../../../core/steamPrice";
import { Card } from "../../design-system/primitives/Card/Card";
import { gradeColor } from "../../lib/gradeColor";

/** 图表三色分离：价格折线=绿，成交量柱=蓝，交易额折线=红。 */
const PRICE_COLOR = "#22c55e";
const VOLUME_COLOR = "#3b82f6";
const TOTAL_COLOR = "#ef4444";

/** 分类 key 的展示名（缺失时原样显示）。 */
function categoryLabel(key: string, translate: (k: string) => string): string {
  const t = translate(`volume.category.${key}`);
  return t.startsWith("volume.category.") ? key : t;
}

/**
 * 交易页的单物品卡片：物品名 + 总交易额 + 迷你走势图。
 * 迷你图包含三部分：
 *  - 下方成交量柱状图（蓝色，高度随量）
 *  - 上方价格折线（绿色）
 *  - 上方交易额折线（红色）
 * 名称旁色块与名称颜色由 grade 决定（跨所有卡片一致）。
 *
 * 走势图时间窗口由父级（Trading 页）统一控制：传入 `windowRange` 时，仅展示
 * 该 [start, end] 时间范围内的点，与主图表同步显示相同时间段；不传时展示全量
 * 历史点。卡片自身不再提供独立拖拽，避免与主图表窗口冲突。
 */
export function ItemVolumeCard({
  item,
  currency,
  windowRange,
}: {
  item: MarketVolumeItem;
  currency: string;
  windowRange?: { start: string; end: string } | null;
}) {
  const { t } = useTranslation("market");
  const color = gradeColor(item.grade ?? "");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // 按共享时间窗口过滤点集；未传窗口时展示全量。
  const points = useMemo(() => {
    if (windowRange && windowRange.start && windowRange.end) {
      return item.points.filter((p) => p.hour >= windowRange.start && p.hour <= windowRange.end);
    }
    return item.points;
  }, [item.points, windowRange]);

  // 左上角总交易额：有窗口时随窗口求和；无窗口空窗口时回退到卡片全量 total。
  const windowTotal = useMemo(() => {
    if (windowRange && windowRange.start && windowRange.end && points.length > 0) {
      return points.reduce((s, p) => s + p.total, 0);
    }
    return item.total;
  }, [windowRange, points, item.total]);
  const chart = useMemo(() => {
    if (points.length === 0) return null;

    const maxVol = Math.max(1, ...points.map((p) => p.volume));
    const maxPrice = Math.max(1, ...points.map((p) => p.price));
    const minPrice = Math.min(maxPrice, ...points.map((p) => p.price));
    const priceRange = maxPrice - minPrice || 1;
    const maxTotal = Math.max(1, ...points.map((p) => p.total));
    const minTotal = Math.min(maxTotal, ...points.map((p) => p.total));
    const totalRange = maxTotal - minTotal || 1;
    const n = points.length;
    const barAreaH = 16; // 下半区高度（viewBox y: 24..40）
    const priceAreaH = 14; // 上半区高度（viewBox y: 4..18）
    const barBottom = 40;
    const priceBottomBase = 4;
    const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
    const barHeight = (v: number) => (v / maxVol) * barAreaH;
    const priceY = (p: number) =>
      priceBottomBase + priceAreaH - ((p - minPrice) / priceRange) * priceAreaH;
    const totalY = (p: number) =>
      priceBottomBase + priceAreaH - ((p - minTotal) / totalRange) * priceAreaH;

    const bars = points.map((p, i) => {
      const h = barHeight(p.volume);
      return { x: x(i) - 0.4, y: barBottom - h, w: 0.8, h };
    });
    const pricePath = `M ${points.map((p, i) => `${x(i)},${priceY(p.price)}`).join(" L ")}`;
    const totalPath = `M ${points.map((p, i) => `${x(i)},${totalY(p.total)}`).join(" L ")}`;

    return {
      bars,
      pricePath,
      totalPath,
      x,
      first: points[0].hour,
      last: points[points.length - 1].hour,
      points,
    };
  }, [points]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!chart || chart.points.length === 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = ((e.clientX - rect.left) / rect.width) * 100;
    const { points: pts } = chart;
    let best = 0;
    let bestDist = Infinity;
    pts.forEach((_p, i) => {
      const pointX = chart.x(i);
      const dist = Math.abs(pointX - ratio);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHoverIndex(best);
  };

  const handleMouseLeave = () => setHoverIndex(null);

  return (
    <Card padding="compact" className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ background: color }}
              aria-hidden
            />
            <p className="m-0 truncate text-[13px] font-medium" style={{ color }} title={item.name}>
              {item.name}
            </p>
          </div>
          <p className="m-0 text-[11px] text-muted">
            {categoryLabel(item.category, t)}
            {item.grade ? ` · ${item.grade}` : ""}
            {item.points.length > 0
              ? ` · ${t("volume.trendTitle")}`
              : ` · ${t("trading.snapshot")}`}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold text-fg">
          {formatMoney(windowTotal, currency)}
        </span>
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
              {hoverIndex != null && (
                <line
                  x1={chart.x(hoverIndex)}
                  y1={2}
                  x2={chart.x(hoverIndex)}
                  y2={40}
                  stroke={color}
                  strokeOpacity={0.6}
                  strokeWidth={0.3}
                  strokeDasharray="1 1"
                />
              )}
            </svg>
            {hoverIndex != null && (
              <HoverTooltip
                point={chart.points[hoverIndex]}
                currency={currency}
                hoverX={chart.x(hoverIndex)}
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
  );
}

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

  // 提示框相对容器宽度按百分比定位，超出右边缘时向左偏移避免溢出。
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
