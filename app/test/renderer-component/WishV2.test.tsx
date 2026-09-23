// Wish v2 渲染组件测试（T04）。
//
// 覆盖：
//   - `WishCoinBadge` 四档置信度视觉（observed 实/带 coinKey、manual 带「手工」
//     标记、inferred 虚线候选、unknown 灰占位）——P1-1 可视化。
//   - `WishRecentResults` 渲染最近结果 + 硬币列。
//   - `WishCoinGroups` 按硬币分组 + 未归因/候选分区 + 手工分类交互。
//   - `WishHeldCoins` 背包硬币面板。
//   - `WishHistory` 新增硬币列。
//   - `Wish` 页面：`unavailable` 横幅已移除（P0-2）、品质分布 / 单品排行已移除、
//     新分区存在。

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { initRendererI18n } from "../../src/renderer/i18n";
import type {
  WishCoinAttribution,
  WishCoinGroup,
  WishCoinOverride,
  WishHeldCoin,
  WishHistoryEntry,
  WishRecentResult,
  WishUnattributedGroup,
} from "../../shared/types";

// 页面级测试需要 `useWish`（内部读 stats/inventory/catalog 上下文）—— 用
// hoisted 夹具 + vi.mock 直接注入，聚焦布局断言（横幅移除 / 分区存在）。
const { WISH_STATS, HELD_COINS, SET_COIN_OVERRIDE } = vi.hoisted(() => {
  const EMPTY_ATTR = { confidence: "unknown" as const, coinKey: null, candidates: [] };
  const stats = {
    offeringCountTotal: 2,
    itemCountTotal: 3,
    itemsPerOffering: 1.5,
    offeringCountSession: 2,
    itemCountSession: 3,
    offeringPerHour: 1,
    itemPerHour: 1.5,
    offeringRecentPerHour: 1,
    itemRecentPerHour: 1.5,
    gradeDistribution: [],
    breakdown: [{ name: "产物X", count: 2, share: 2 / 3, grade: "RARE" }],
    history: [
      { wallTime: 1_700_000_000, name: "历史物", grade: "RARE", count: 1, coin: EMPTY_ATTR },
    ],
    lastWishWallTime: 1_700_000_000,
    readerRequired: true,
    gameOfferingItemCount: null,
    recentResults: [
      { wallTime: 1_700_000_000, name: "历史物", grade: "RARE", count: 1, coin: EMPTY_ATTR },
    ],
    coinGroups: [],
    unattributed: { items: [] },
  };
  const held = [
    { coinKey: 160001, name: "青铜币", grade: "COMMON", quantity: 5, iconPath: "item-160001" },
  ];
  return {
    WISH_STATS: stats,
    HELD_COINS: held,
    SET_COIN_OVERRIDE: vi.fn(async () => {}),
  };
});

vi.mock("../../src/renderer/lib/useWish", () => ({
  useWish: () => ({
    wish: WISH_STATS,
    gradeDistribution: WISH_STATS.gradeDistribution,
    breakdown: WISH_STATS.breakdown,
    history: WISH_STATS.history,
    recentResults: WISH_STATS.recentResults,
    coinGroups: WISH_STATS.coinGroups,
    unattributed: WISH_STATS.unattributed,
    heldCoins: HELD_COINS,
    coinOverrides: [],
    setCoinOverride: SET_COIN_OVERRIDE,
    coinResolver: () => undefined,
    hasData: true,
    resetSession: async () => {},
  }),
  attributionOf: (c: unknown) => c ?? { confidence: "unknown", coinKey: null, candidates: [] },
}));

import { WishCoinBadge } from "../../src/renderer/components/wish/WishCoinBadge";
import { WishRecentResults } from "../../src/renderer/components/wish/WishRecentResults";
import { WishCoinGroups } from "../../src/renderer/components/wish/WishCoinGroups";
import { WishHeldCoins } from "../../src/renderer/components/wish/WishHeldCoins";
import { WishHistory } from "../../src/renderer/components/wish/WishHistory";
import { Wish } from "../../src/renderer/tabs/Wish";

/** 最小硬币解析器（测试可控）。 */
const resolveCoin = (coinKey: number) =>
  coinKey === 160001
    ? { coinKey, name: "青铜币", grade: "COMMON", iconPath: "item-160001" }
    : coinKey === 160010
      ? { coinKey, name: "宇宙币", grade: "COSMIC", iconPath: "item-160010" }
      : undefined;

const OBSERVED: WishCoinAttribution = {
  confidence: "observed",
  coinKey: 160001,
  candidates: [],
  basis: "diff:160001",
};
const INFERRED: WishCoinAttribution = {
  confidence: "inferred",
  coinKey: null,
  candidates: [
    { coinKey: 160001, poolPct: 0.42 },
    { coinKey: 160010, poolPct: 0.08 },
  ],
  basis: "loot:2cand",
};
const UNKNOWN: WishCoinAttribution = {
  confidence: "unknown",
  coinKey: null,
  candidates: [],
  basis: "no-frame",
};
const MANUAL: WishCoinAttribution = {
  confidence: "manual",
  coinKey: 160010,
  candidates: [],
  basis: "manual",
};

/** `WishCoinGroups` 的必填 props 工厂（测试内多处复用）。 */
function coinGroupsProps(
  groups: WishCoinGroup[],
  unattributed: WishUnattributedGroup,
  onAssignCoin = vi.fn(),
  coinOverrides: WishCoinOverride[] = [],
) {
  return {
    groups,
    unattributed,
    resolveCoin,
    coinOverrides,
    coinOptions: [
      { coinKey: 160001, name: "青铜币", grade: "COMMON" },
      { coinKey: 160010, name: "宇宙币", grade: "COSMIC" },
    ],
    onAssignCoin,
  };
}

describe("Wish v2 components", () => {
  beforeEach(async () => {
    await initRendererI18n("zh-CN");
  });

  it("WishCoinBadge: observed renders coin name + coinKey attr (solid)", () => {
    render(<WishCoinBadge coin={OBSERVED} resolveCoin={resolveCoin} />);
    const el = document.querySelector('[data-confidence="observed"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-coin-key")).toBe("160001");
    expect(el?.textContent).toContain("青铜币");
    cleanup();
  });

  it("WishCoinBadge: inferred renders candidate count (dashed) and never a single coin", () => {
    render(<WishCoinBadge coin={INFERRED} resolveCoin={resolveCoin} />);
    const el = document.querySelector('[data-confidence="inferred"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-candidate-count")).toBe("2");
    // 不得把候选当作实证显示单枚 coinKey。
    expect(document.querySelector("[data-coin-key]")).toBeNull();
    cleanup();
  });

  it("WishCoinBadge: unknown renders neutral placeholder, no fabricated coin", () => {
    render(<WishCoinBadge coin={UNKNOWN} resolveCoin={resolveCoin} />);
    expect(document.querySelector('[data-confidence="unknown"]')).not.toBeNull();
    expect(document.querySelector("[data-coin-key]")).toBeNull();
    cleanup();
  });

  it("WishCoinBadge: undefined coin degrades to unknown (old-snapshot compat)", () => {
    render(<WishCoinBadge coin={undefined} resolveCoin={resolveCoin} />);
    expect(document.querySelector('[data-confidence="unknown"]')).not.toBeNull();
    cleanup();
  });

  it("WishRecentResults renders rows with a per-row coin badge", () => {
    const rows: WishRecentResult[] = [
      { wallTime: 1_700_000_000, name: "祈愿物A", grade: "RARE", count: 1, coin: OBSERVED },
      { wallTime: 1_700_000_060, name: "祈愿物B", grade: "COSMIC", count: 3, coin: INFERRED },
    ];
    render(<WishRecentResults rows={rows} resolveCoin={resolveCoin} />);
    expect(screen.getByText("祈愿物A")).toBeTruthy();
    expect(screen.getByText("祈愿物B")).toBeTruthy();
    expect(document.querySelectorAll('[data-confidence="observed"]').length).toBe(1);
    expect(document.querySelectorAll('[data-confidence="inferred"]').length).toBe(1);
    cleanup();
  });

  it("WishRecentResults shows the empty placeholder when no rows", () => {
    render(<WishRecentResults rows={[]} resolveCoin={resolveCoin} />);
    expect(screen.getByText("暂无祈愿结果。")).toBeTruthy();
    cleanup();
  });

  it("WishCoinGroups renders observed group + unattributed candidates section", () => {
    const groups: WishCoinGroup[] = [
      {
        coinKey: 160001,
        coinName: "青铜币",
        grade: "COMMON",
        offeringCount: 2,
        itemCount: 3,
        items: [{ name: "产物X", count: 2, grade: "RARE" }],
      },
    ];
    const unattributed: WishUnattributedGroup = {
      items: [{ name: "产物Y", count: 1, grade: "UNKNOWN", coin: INFERRED }],
    };
    render(<WishCoinGroups {...coinGroupsProps(groups, unattributed)} />);
    // 「青铜币」在下拉候选里也有一份文本，故用 *AllBy*。
    expect(screen.getAllByText("青铜币").length).toBeGreaterThan(0);
    expect(screen.getByText("产物X")).toBeTruthy();
    expect(screen.getByText("未归因 / 候选")).toBeTruthy();
    expect(screen.getByText("产物Y")).toBeTruthy();
    cleanup();
  });

  it("WishCoinGroups shows the empty placeholder when nothing to group", () => {
    render(<WishCoinGroups {...coinGroupsProps([], { items: [] })} />);
    expect(screen.getByText("暂无可归因的祈愿结果。")).toBeTruthy();
    cleanup();
  });

  it("WishCoinGroups offers a manual coin selector on each unattributed row", () => {
    const unattributed: WishUnattributedGroup = {
      items: [{ name: "待分类物", count: 1, grade: "RARE" }],
    };
    render(<WishCoinGroups {...coinGroupsProps([], unattributed)} />);
    // 每行一个「指定硬币」下拉（aria-label 带物品名）+ 一个「指定」按钮。
    expect(screen.getByLabelText("为 待分类物 指定硬币")).toBeTruthy();
    expect(screen.getByLabelText("确认 待分类物 的硬币指定")).toBeTruthy();
    cleanup();
  });

  it("WishCoinGroups lets a bound row be reset back to auto", () => {
    const onAssignCoin = vi.fn();
    const unattributed: WishUnattributedGroup = {
      items: [{ name: "已绑定物", count: 2, grade: "RARE", coin: MANUAL }],
    };
    render(
      <WishCoinGroups
        {...coinGroupsProps([], unattributed, onAssignCoin, [
          { itemName: "已绑定物", coinKey: 160010, createdAt: 1 },
        ])}
      />,
    );
    // 已绑定 → 出现「改回自动」按钮与「已手工指定为 …」说明。
    expect(screen.getByLabelText("把 已绑定物 改回自动归因")).toBeTruthy();
    expect(screen.getByText("已手工指定为 宇宙币")).toBeTruthy();
    cleanup();
  });
  it("WishCoinGroups badge shows the manual tier distinctly from observed", () => {
    render(<WishCoinBadge coin={MANUAL} resolveCoin={resolveCoin} />);
    const el = document.querySelector('[data-confidence="manual"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-coin-key")).toBe("160010");
    expect(el?.textContent).toContain("宇宙币");
    expect(el?.textContent).toContain("手工");
    cleanup();
  });

  it("WishHeldCoins lists held coins with quantities; empty otherwise", () => {
    const coins: WishHeldCoin[] = [
      { coinKey: 160001, name: "青铜币", grade: "COMMON", quantity: 12, iconPath: "item-160001" },
      { coinKey: 160010, name: "宇宙币", grade: "COSMIC", quantity: 1, iconPath: "item-160010" },
    ];
    const { rerender } = render(<WishHeldCoins coins={coins} />);
    expect(screen.getByText("青铜币")).toBeTruthy();
    expect(screen.getByText("宇宙币")).toBeTruthy();
    expect(screen.getAllByText(/×\d+/).length).toBe(2);
    rerender(<WishHeldCoins coins={[]} />);
    expect(screen.getByText("背包中暂无献祭硬币。")).toBeTruthy();
    cleanup();
  });

  it("WishHistory renders a per-row coin column entry", () => {
    const entries: WishHistoryEntry[] = [
      { wallTime: 1_700_000_000, name: "历史物", grade: "RARE", count: 1, coin: OBSERVED },
      { wallTime: 1_700_000_010, name: "无归因", grade: "UNKNOWN", count: 1 },
    ];
    render(<WishHistory entries={entries} resolveCoin={resolveCoin} />);
    // 硬币列头。
    expect(screen.getByText("硬币")).toBeTruthy();
    expect(document.querySelectorAll('[data-confidence="observed"]').length).toBe(1);
    // 无 coin 字段 → unknown 占位。
    expect(document.querySelectorAll('[data-confidence="unknown"]').length).toBe(1);
    cleanup();
  });

  it("Wish page: drops the unavailable banner and renders the v2 sections", () => {
    render(<Wish />);
    // P0-2：`unavailable` 横幅文案不得再出现（zh-CN 原文：实时读取器不可用…）。
    expect(screen.queryByText(/实时读取器/)).toBeNull();
    // 新分区全部存在。
    expect(screen.getByText("背包献祭硬币")).toBeTruthy();
    expect(screen.getByText("最近祈愿结果")).toBeTruthy();
    expect(screen.getByText("按硬币分组")).toBeTruthy();
    expect(screen.getByText("祈愿历史")).toBeTruthy();
    cleanup();
  });

  it("Wish page: grade breakdown and item ranking panels are gone", () => {
    render(<Wish />);
    // 用户要求移除的两块面板：品质分布 / 单品产出排行。
    expect(screen.queryByText("品质分布")).toBeNull();
    expect(screen.queryByText("单品产出排行")).toBeNull();
    cleanup();
  });
});
