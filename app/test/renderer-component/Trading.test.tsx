import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  MarketVolumeItem,
  MarketVolumeItemStats,
  MarketVolumeRefreshProgress,
  MarketVolumeStats,
} from "../../shared/types";
import { Trading } from "../../src/renderer/tabs/Trading";
import { useMarketVolumeItems } from "../../src/renderer/lib/useMarketVolumeItems";
import { EntityPanelContext } from "../../src/renderer/context/entityPanelContext";
import { TbhContext } from "../../src/renderer/context/tbhContext";

// Trading 通过 useLookupCatalog（消费 TbhContext）与 useEntityPanel 依赖全局
// provider，测试里以端到端 Provider 包裹；lookupCatalog 为空不影响筛选断言。
const TBH_VALUE = {
  inventory: null,
  catalogStatus: null,
  refreshCatalog: async () => ({ ok: false, gameVersion: null, itemCount: 0, resolvedNames: 0 }),
  lookupCatalog: [],
};

const ITEMS: MarketVolumeItem[] = [
  {
    hash: "sword",
    name: "Ancient Blade",
    category: "WEAPON",
    grade: "LEGENDARY",
    level: 60,
    gearType: "SWORD",
    materialType: null,
    total: 500,
    points: [],
  },
  {
    hash: "helm",
    name: "Igneous Helm",
    category: "ARMOR",
    grade: "RARE",
    level: 20,
    gearType: "HELMET",
    materialType: null,
    total: 300,
    points: [],
  },
  {
    hash: "rune",
    name: "Fire Rune",
    category: "MATERIAL",
    grade: "RARE",
    level: null,
    gearType: null,
    materialType: "CRAFTING",
    total: 100,
    points: [],
  },
];

const STATS: MarketVolumeItemStats = { items: ITEMS, currency: "USD" };
const PROGRESS: MarketVolumeRefreshProgress = {
  running: false,
  total: 0,
  done: 0,
  currentHash: null,
};
const VOLUME: MarketVolumeStats = {
  latest: null,
  hourly: [
    { hour: "2026-08-13T10:00:00.000Z", total: 900 },
    { hour: "2026-08-13T11:00:00.000Z", total: 900 },
  ],
  itemCount: 3,
  itemCountsByCategory: { WEAPON: 1, ARMOR: 1, MATERIAL: 1 },
  currency: "USD",
};

vi.mock("../../src/renderer/lib/useMarketVolumeItems", () => ({
  useMarketVolumeItems: vi.fn(() => ({
    stats: STATS,
    pending: [],
    refresh: async () => {},
    refreshing: false,
    progress: PROGRESS,
  })),
}));

vi.mock("../../src/renderer/lib/useMarketVolume", () => ({
  useMarketVolume: () => VOLUME,
}));

// ItemVolumeCard renders synthesis points via useMaterialSynthesisPoints, which
// would otherwise hit window.tbh.getLookupCatalog/... — stub it so the Trading
// layout/filter assertions don't depend on IPC plumbing.
vi.mock("../../src/renderer/lib/useMaterialSynthesisPoints", () => ({
  useMaterialSynthesisPoints: () => ({}),
}));

function renderTrading() {
  return render(
    <TbhContext.Provider value={TBH_VALUE}>
      <EntityPanelContext.Provider
        value={{ node: null, open: () => {}, navigate: () => {}, close: () => {}, isOpen: false }}
      >
        <Trading />
      </EntityPanelContext.Provider>
    </TbhContext.Provider>,
  );
}

describe("Trading 卡片筛选 → 数量联动", () => {
  it("名称搜索后下方卡片随之减少（卡片根元素是 div，按文本断言）", () => {
    renderTrading();
    expect(screen.getByText("Ancient Blade")).toBeInTheDocument();
    expect(screen.getByText("Igneous Helm")).toBeInTheDocument();
    expect(screen.getByText("Fire Rune")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search items…");
    fireEvent.change(search, { target: { value: "Blade" } });

    expect(screen.getByText("Ancient Blade")).toBeInTheDocument();
    expect(screen.queryByText("Igneous Helm")).not.toBeInTheDocument();
    expect(screen.queryByText("Fire Rune")).not.toBeInTheDocument();
  });

  it("筛选无命中时显示 emptyFiltered 空态而非卡片", () => {
    renderTrading();
    const search = screen.getByPlaceholderText("Search items…");
    fireEvent.change(search, { target: { value: "NoSuchItem" } });

    expect(screen.queryByText("Ancient Blade")).not.toBeInTheDocument();
    expect(screen.getByText("No items match these filters.")).toBeInTheDocument();
  });
});

describe("Trading 筛选栏多语言", () => {
  afterEach(async () => {
    // 切回英文，避免污染依赖英文文案的后续测试。
    const { changeLanguage } = await import("i18next");
    await changeLanguage("en");
  });

  it("英文 locale：三个数值筛选显示英文 label，等级滑杆用 Lv 前缀", async () => {
    const { changeLanguage } = await import("i18next");
    await changeLanguage("en");
    renderTrading();

    // 三个数值筛选 + 等级的 label（Title Case 原始文本，CSS uppercase 不影响 textContent）
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Volume")).toBeInTheDocument();
    expect(screen.getByText("Price")).toBeInTheDocument();
    // 单位：USD 出现（成交额/价格共用），units 出现（成交量）
    expect(screen.getAllByText("USD").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("units")).toBeInTheDocument();
    // 等级滑杆数值标签用 "Lv"
    expect(screen.getByText(/Lv 1 – Lv 100/)).toBeInTheDocument();
  });

  it("中文 locale：三个数值筛选显示中文 label，等级滑杆用「等级」前缀", async () => {
    const { changeLanguage } = await import("i18next");
    await changeLanguage("zh-CN");
    renderTrading();

    expect(screen.getByText("成交额")).toBeInTheDocument();
    expect(screen.getByText("成交量")).toBeInTheDocument();
    expect(screen.getByText("价格")).toBeInTheDocument();
    // 单位「件」与货币（zh-CN 下货币仍为 USD 代码）
    expect(screen.getByText("件")).toBeInTheDocument();
    // 等级滑杆数值标签用「等级」
    expect(screen.getByText(/等级 1 – 等级 100/)).toBeInTheDocument();
  });
});

describe("Trading 刷新期间待刷新目标合并进主卡片列表", () => {
  it("占位目标（pending）作为卡片出现在主列表，且不重复（仅一份）", () => {
    vi.mocked(useMarketVolumeItems).mockReturnValue({
      stats: STATS,
      pending: [
        {
          hash: "rune",
          name: "Fire Rune",
          category: "MATERIAL",
          grade: "RARE",
          level: null,
          gearType: null,
          materialType: "CRAFTING",
          total: 0,
          points: [],
        },
      ],
      refresh: async () => {},
      refreshing: true,
      progress: { running: true, total: 1, done: 0, currentHash: "rune" },
    });
    renderTrading();

    expect(screen.getByText("Ancient Blade")).toBeInTheDocument();
    expect(screen.getAllByText("Fire Rune")).toHaveLength(1);
  });

  it("筛选对待刷新目标卡片同样生效（合并后统一过滤）", () => {
    vi.mocked(useMarketVolumeItems).mockReturnValue({
      stats: STATS,
      pending: [
        {
          hash: "rune",
          name: "Fire Rune",
          category: "MATERIAL",
          grade: "RARE",
          level: null,
          gearType: null,
          materialType: "CRAFTING",
          total: 0,
          points: [],
        },
      ],
      refresh: async () => {},
      refreshing: true,
      progress: { running: true, total: 1, done: 0, currentHash: "rune" },
    });
    renderTrading();
    expect(screen.getByText("Fire Rune")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search items…"), {
      target: { value: "Blade" },
    });
    expect(screen.queryByText("Fire Rune")).not.toBeInTheDocument();
  });
});
