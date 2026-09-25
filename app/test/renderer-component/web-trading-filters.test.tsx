// Web TradingPanel filter tests (fixture-driven, unlike the heavy real-catalog
// suite in web-no-save.test.tsx which already proves the real catalog renders).
//
// The component reads the catalog through `useLookupCatalog` and prices through
// `useWebPrices`; both are mocked to a 3-item fixture so the filter/sort logic
// itself is what's under test:
//   - Alpha Sword  GEAR/LEGENDARY  priced $5
//   - Gamma Ore    MATERIAL        priced $1
//   - Delta Gem    MATERIAL        tradable but unpriced (no-listing)
// Default order must be price-descending with the unpriced row pinned last.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LookupItem, LookupPriceSnapshot } from "../../shared/types";
import { marketHashName } from "../../src/core/marketName";
import { TradingPanel } from "../../src/web/tabs/TradingPanel";
import { EntityPanelContext } from "../../src/renderer/context/entityPanelContext";

const ITEMS = [
  {
    id: 1,
    name: "Alpha Sword",
    grade: "LEGENDARY",
    type: "GEAR",
    gearType: "SWORD",
    materialType: null,
    level: 10,
    iconPath: "alpha.png",
    marketTradable: true,
  },
  {
    id: 2,
    name: "Gamma Ore",
    grade: "COMMON",
    type: "MATERIAL",
    gearType: null,
    materialType: "CRAFTING",
    level: null,
    iconPath: "ore.png",
    marketTradable: true,
  },
  {
    id: 3,
    name: "Delta Gem",
    grade: "COMMON",
    type: "MATERIAL",
    gearType: null,
    materialType: "CRAFTING",
    level: null,
    iconPath: "gem.png",
    marketTradable: true,
  },
] as unknown as LookupItem[];

const SWORD_HASH = marketHashName(ITEMS[0])!;
const ORE_HASH = marketHashName(ITEMS[1])!;
// Delta Gem deliberately has no snapshot entry → "no-listing".

const SNAPSHOT = {
  generatedUtc: "2026-09-25T00:00:00.000Z",
  prices: { [SWORD_HASH]: 5, [ORE_HASH]: 1 },
  fx: { USD: 1 },
} as unknown as LookupPriceSnapshot;

vi.mock("../../src/web/lib/useWebPrices", () => ({
  useWebPrices: () => ({ status: "ready", snapshot: SNAPSHOT }),
}));
vi.mock("../../src/renderer/lib/useLookupCatalog", () => ({
  useLookupCatalog: () => ITEMS,
}));
vi.mock("../../src/web/lib/useWebRuntime", () => ({
  useWebRuntime: () => ({ currency: "USD" }),
}));

const PANEL_CONTEXT = {
  node: null,
  open: () => {},
  navigate: () => {},
  close: () => {},
  isOpen: false,
};

function renderPanel() {
  return render(
    <EntityPanelContext.Provider value={PANEL_CONTEXT}>
      <TradingPanel />
    </EntityPanelContext.Provider>,
  );
}

function rowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tbody tr")).map(
    (tr) => tr.querySelector("td")?.textContent ?? "",
  );
}

function toggleCheckbox(labelText: RegExp) {
  const box = screen.getByRole("checkbox", { name: labelText });
  fireEvent.click(box);
}

describe("Web TradingPanel 筛选", () => {
  it("默认按价格降序，无价行恒沉底", () => {
    const { container } = renderPanel();
    expect(rowNames(container)).toEqual(["Alpha Sword", "Gamma Ore", "Delta Gem"]);
    // KPI 始终描述全集，不随筛选变化：3 可交易 / 2 有价 / 66%
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
  });

  it("搜索收窄行并联动计数标签", () => {
    const { container } = renderPanel();
    fireEvent.change(screen.getByPlaceholderText("Search items..."), {
      target: { value: "Gamma" },
    });
    expect(rowNames(container)).toEqual(["Gamma Ore"]);
    expect(screen.getByText("1 items")).toBeInTheDocument();
  });

  it("搜索无命中时显示筛选空态而非整表消失", () => {
    const { container } = renderPanel();
    fireEvent.change(screen.getByPlaceholderText("Search items..."), {
      target: { value: "NoSuchItem" },
    });
    expect(container.querySelectorAll("tbody tr").length).toBe(0);
    expect(screen.getByText("No items match the current filters.")).toBeInTheDocument();
  });

  it("类型复选与仅有价开关可叠加", () => {
    const { container } = renderPanel();
    toggleCheckbox(/material/i);
    expect(rowNames(container)).toEqual(["Gamma Ore", "Delta Gem"]);

    toggleCheckbox(/priced only/i);
    expect(rowNames(container)).toEqual(["Gamma Ore"]);
    // KPI 仍为全集口径
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("价格排序方向切换后升序在前、无价行仍沉底", () => {
    const { container } = renderPanel();
    // 方向按钮的 aria-label（"Sort descending"）全页唯一，直接定位
    const dirButton = screen.getByRole("button", { name: /sort descending/i });
    fireEvent.click(dirButton);
    expect(rowNames(container)).toEqual(["Gamma Ore", "Alpha Sword", "Delta Gem"]);
  });
});
