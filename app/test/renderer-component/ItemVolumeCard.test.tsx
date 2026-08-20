import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MarketVolumeItem } from "../../shared/types";
import { ItemVolumeCard } from "../../src/renderer/components/market/ItemVolumeCard";

/** 生成 count 个小时点（升序），最后一个点用独特的 volume 标记钳制目标。 */
function makePoints(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    hour: new Date(Date.UTC(2026, 7, 10, i)).toISOString(),
    price: 10 + i,
    volume: i === count - 1 ? 999 : 5,
    total: 50 + i,
  }));
}

const POINTS = makePoints(60);
const ITEM: MarketVolumeItem = {
  hash: "test-item",
  name: "Test Item",
  category: "WEAPON",
  total: 1234,
  points: POINTS,
};

/** jsdom 的 getBoundingClientRect 恒为 0，重写以让 mousemove 定位生效。 */
function mockSvgRect(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("svg 未渲染");
  svg.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 40,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return svg;
}

describe("ItemVolumeCard", () => {
  it("points 收缩后残留的 hoverIndex 被钳制到窗口内，不再把 undefined 传给 HoverTooltip", () => {
    const { container, rerender } = render(<ItemVolumeCard item={ITEM} currency="USD" />);
    const svg = mockSvgRect(container);

    // 悬浮到最右端，hoverIndex 落在 48 点降采样序列的高位。
    fireEvent.mouseMove(svg, { clientX: 190 });
    expect(screen.getByText("价格")).toBeInTheDocument();

    // 切到只含 2 个点的窗口：修复前 chart.points[hoverIndex] 为 undefined，
    // HoverTooltip 读 point.hour 抛 TypeError；修复后钳制到窗口内最后一个点。
    const windowRange = { start: POINTS[58].hour, end: POINTS[59].hour };
    rerender(<ItemVolumeCard item={ITEM} currency="USD" windowRange={windowRange} />);

    expect(screen.getByText("价格")).toBeInTheDocument();
    // 钳制到窗口内最后一点（volume=999），提示显示该点数据而非崩溃。
    expect(screen.getByText("999")).toBeInTheDocument();
  });
});
