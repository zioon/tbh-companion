// 独立回归对抗测试 · 渲染层（第二层 QA —— 严过关，Wish v2）。
//
// 与工程自测（WishV2.test.tsx）*刻意不同*：这里只攻击呈现层的不变量：
//   - R6-a WishCoinBadge 三态视觉的**互斥性**（observed/inferred/unknown 不得混淆）；
//   - R6-b inferred 候选 tooltip 必须含硬币名 + poolPct；
//   - R6-c WishCoinGroups unattributed 分区**空时不渲染**；
//   - R6-d WishHeldCoins 空态；
//   - R6-e WishRecentResults 表头不得重复（P2 疑似缺陷回归）；
//   - S1  4 语言均无 unavailable 横幅残留（页面级）；
//   - S3  记录页祈愿行落入 wish 桶（紫 #c78fe8 + fitWish chip，非"通关"金）。
//
// 组件为纯展示，直接渲染；页面级用例用 vi.mock 注入 useWish。

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { initRendererI18n } from "../../src/renderer/i18n";
import type {
  WishCoinAttribution,
  WishCoinGroup,
  WishHeldCoin,
  WishRecentResult,
  WishUnattributedGroup,
} from "../../shared/types";

// 页面级测试需要的 useWish 注入（与工程测试同思路，但夹具独立）。
const { WISH_STATS, HELD_COINS } = vi.hoisted(() => {
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
  return { WISH_STATS: stats, HELD_COINS: held };
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
import { Wish } from "../../src/renderer/tabs/Wish";

type Resolved = { coinKey: number; name: string; grade: string; iconPath: string };

/** 受控解析器：仅 160001 / 160010 命中，其余 undefined。 */
const resolveCoin = (coinKey: number): Resolved | undefined => {
  if (coinKey === 160001)
    return { coinKey, name: "青铜币", grade: "COMMON", iconPath: "item-160001" };
  if (coinKey === 160010)
    return { coinKey, name: "宇宙币", grade: "COSMIC", iconPath: "item-160010" };
  return undefined;
};

const OBSERVED_A: WishCoinAttribution = {
  confidence: "observed",
  coinKey: 160001,
  candidates: [],
  basis: "diff:160001",
};
const INFERRED_2: WishCoinAttribution = {
  confidence: "inferred",
  coinKey: null,
  candidates: [
    { coinKey: 160001, poolPct: 0.42 },
    { coinKey: 160010, poolPct: 0.08 },
  ],
  basis: "loot:2cand",
};
const UNKNOWN_ATTR: WishCoinAttribution = {
  confidence: "unknown",
  coinKey: null,
  candidates: [],
  basis: "no-frame",
};

describe("R6 渲染层对抗", () => {
  beforeEach(async () => {
    await initRendererI18n("zh-CN");
  });

  it("R6-a WishCoinBadge 三态互斥：一次渲染只出现一个 data-confidence", () => {
    for (const [attr, expected] of [
      [OBSERVED_A, "observed"],
      [INFERRED_2, "inferred"],
      [UNKNOWN_ATTR, "unknown"],
    ] as const) {
      render(<WishCoinBadge coin={attr} resolveCoin={resolveCoin} />);
      expect(
        document.querySelectorAll("[data-confidence]").length,
        `${expected} 应恰好 1 个徽章`,
      ).toBe(1);
      expect(document.querySelector(`[data-confidence="${expected}"]`)).not.toBeNull();
      // 互斥：不得同时出现其它置信度。
      for (const other of ["observed", "inferred", "unknown"]) {
        if (other !== expected) {
          expect(document.querySelector(`[data-confidence="${other}"]`)).toBeNull();
        }
      }
      cleanup();
    }
  });

  it("R6-a2 observed 才带 data-coin-key；inferred/unknown 绝无 data-coin-key（不伪造）", () => {
    render(<WishCoinBadge coin={OBSERVED_A} resolveCoin={resolveCoin} />);
    expect(document.querySelector("[data-coin-key]")?.getAttribute("data-coin-key")).toBe("160001");
    cleanup();

    for (const attr of [INFERRED_2, UNKNOWN_ATTR, undefined]) {
      render(<WishCoinBadge coin={attr} resolveCoin={resolveCoin} />);
      expect(document.querySelector("[data-coin-key]"), "非 observed 不得渲染 coinKey").toBeNull();
      cleanup();
    }
  });

  it("R6-b inferred 候选 tooltip 含硬币名 + poolPct（42.0% / 8.0%）", () => {
    render(<WishCoinBadge coin={INFERRED_2} resolveCoin={resolveCoin} />);
    const el = document.querySelector('[data-confidence="inferred"]');
    const title = el?.getAttribute("title") ?? "";
    expect(title).toContain("青铜币");
    expect(title).toContain("42.0%");
    expect(title).toContain("宇宙币");
    expect(title).toContain("8.0%");
    cleanup();
  });

  it("R6-b2 inferred 但 candidates 为空 → 降级为 unknown 占位（不出现空候选块）", () => {
    const bogus: WishCoinAttribution = { confidence: "inferred", coinKey: null, candidates: [] };
    render(<WishCoinBadge coin={bogus} resolveCoin={resolveCoin} />);
    // 组件内 `candidates.length > 0` 才渲染 inferred；否则落 unknown 分支。
    expect(document.querySelector('[data-confidence="inferred"]')).toBeNull();
    expect(document.querySelector('[data-confidence="unknown"]')).not.toBeNull();
    cleanup();
  });

  it("R6-c WishCoinGroups unattributed 为空 → 不渲染未归因分区", () => {
    const groups: WishCoinGroup[] = [
      {
        coinKey: 160001,
        coinName: "青铜币",
        grade: "COMMON",
        offeringCount: 1,
        itemCount: 1,
        items: [{ name: "产物X", count: 1, grade: "RARE" }],
      },
    ];
    render(
      <WishCoinGroups groups={groups} unattributed={{ items: [] }} resolveCoin={resolveCoin} />,
    );
    expect(screen.getByText("青铜币")).toBeTruthy();
    expect(screen.queryByText("未归因 / 候选")).toBeNull();
    cleanup();
  });

  it("R6-c2 两者皆空 → 只显示空占位，无观察分组、无未归因标题", () => {
    render(<WishCoinGroups groups={[]} unattributed={{ items: [] }} resolveCoin={resolveCoin} />);
    expect(screen.getByText("暂无可归因的祈愿结果。")).toBeTruthy();
    expect(screen.queryByText("未归因 / 候选")).toBeNull();
    cleanup();
  });

  it("R6-c3 unattributed 有 inferred 候选 → 显示候选行 + 池概率", () => {
    const unattributed: WishUnattributedGroup = {
      items: [{ name: "神秘护符", count: 1, grade: "COMMON", coin: INFERRED_2 }],
    };
    render(<WishCoinGroups groups={[]} unattributed={unattributed} resolveCoin={resolveCoin} />);
    expect(screen.getByText("未归因 / 候选")).toBeTruthy();
    expect(screen.getByText("神秘护符")).toBeTruthy();
    // 候选池概率文案应出现。
    expect(document.body.textContent).toContain("42.0%");
    cleanup();
  });

  it("R6-d WishHeldCoins 空态占位", () => {
    render(<WishHeldCoins coins={[]} />);
    expect(screen.getByText("背包中暂无献祭硬币。")).toBeTruthy();
    cleanup();
  });

  it("R6-d2 WishHeldCoins 合计单位 = 各硬币 quantity 之和", () => {
    const coins: WishHeldCoin[] = [
      { coinKey: 160001, name: "青铜币", grade: "COMMON", quantity: 12, iconPath: "item-160001" },
      { coinKey: 160010, name: "宇宙币", grade: "COSMIC", quantity: 3, iconPath: "item-160010" },
    ];
    render(<WishHeldCoins coins={coins} />);
    // 合计 15。
    expect(document.body.textContent).toContain("15");
    cleanup();
  });

  it("R6-e WishRecentResults 表头唯一性：不得出现重复列头（P2 疑似缺陷回归）", () => {
    const rows: WishRecentResult[] = [
      { wallTime: 1_700_000_000, name: "祈愿物A", grade: "RARE", count: 1, coin: OBSERVED_A },
    ];
    render(<WishRecentResults rows={rows} resolveCoin={resolveCoin} />);
    const headers = [...document.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
    expect(headers.length, "应有 4 列表头").toBe(4);
    // 列头应两两不同（时间 / 物品 / 硬币 / 数量）。
    expect(new Set(headers).size, `列头不得重复：${JSON.stringify(headers)}`).toBe(headers.length);
    cleanup();
  });

  it("R6-f 未知硬币（resolver miss）observed 也不崩，降级显示 #coinKey", () => {
    const attr: WishCoinAttribution = { confidence: "observed", coinKey: 160009, candidates: [] };
    render(<WishCoinBadge coin={attr} resolveCoin={resolveCoin} />);
    const el = document.querySelector('[data-confidence="observed"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-coin-key")).toBe("160009");
    expect(el?.textContent).toContain("#160009");
    cleanup();
  });
});

describe("S1 页面级：unavailable 横幅已移除", () => {
  beforeEach(async () => {
    await initRendererI18n("zh-CN");
  });

  it("S1-a zh-CN 页面无「实时读取器」横幅，v2 分区齐全", () => {
    render(<Wish />);
    expect(screen.queryByText(/实时读取器/)).toBeNull();
    expect(screen.getByText("背包献祭硬币")).toBeTruthy();
    expect(screen.getByText("最近祈愿结果")).toBeTruthy();
    expect(screen.getByText("按硬币分组")).toBeTruthy();
    cleanup();
  });

  it("S1-b 4 语言均无 unavailable 文案残留（页面级重渲染）", async () => {
    // 每种语言的"不可用"提示原文（来自 wish.json unavailable.*，若仍在会被渲染）。
    const banned = [
      /实时读取器/,
      /live reader is unavailable/i,
      /リアルタイムリーダー/,
      /실시간\s*리더/,
    ];
    for (const loc of ["zh-CN", "en", "ja", "ko"]) {
      await initRendererI18n(loc);
      render(<Wish />);
      for (const re of banned) {
        expect(screen.queryByText(re), `${loc} 残留横幅 ${re}`).toBeNull();
      }
      cleanup();
    }
  });
});
