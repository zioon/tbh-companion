import { useCallback, useEffect, useMemo, useState } from "react";
import { useStats } from "./useStats";
import { useInventory } from "./useInventory";
import { useLookupCatalog } from "./useLookupCatalog";
import { reportIpcError } from "./reportError";
import { useStableBySignature, pctSig } from "./useStableBySignature";
import { heldCoinsFromInventory, makeCoinResolver } from "./wishCoin";
import {
  applyCoinOverrides,
  applyOverridesToHistory,
  applyOverridesToRecent,
} from "../../core/wish/coinOverrides";
import type {
  WishBreakdownRow,
  WishCoinGroup,
  WishCoinAttribution,
  WishCoinOverrides,
  WishGrade,
  WishGradeRow,
  WishHeldCoin,
  WishHistoryEntry,
  WishRecentResult,
  WishStats,
  WishUnattributedGroup,
} from "../../../shared/types";

/**
 * 品质桶的稳定输出顺序（由低到高，未知置末尾）。与 core/wishTracker.ts 的
 * GRADE_ORDER 保持一致 —— 这里重新声明是为了让 renderer 不依赖 core 的
 * 内部常量，同时保证渲染顺序恒定（核心已按此序输出，此处仅作防御性重排）。
 *
 * 11 桶：`COMMON…CELESTIAL` 之后插入 `BEYOND / DIVINE / COSMIC`，`UNKNOWN` 置尾
 * （Wish v2 P0-9）。与 core 的同名常量**两处同步**。
 */
const GRADE_ORDER: WishGrade[] = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "LEGENDARY",
  "IMMORTAL",
  "ARCANA",
  "CELESTIAL",
  "BEYOND",
  "DIVINE",
  "COSMIC",
  "UNKNOWN",
];

/** 品质分布默认骨架：11 个桶全 0，避免首次渲染时表格跳高。 */
const EMPTY_GRADE_DISTRIBUTION: WishGradeRow[] = GRADE_ORDER.map((grade) => ({
  grade,
  count: 0,
  share: 0,
}));

/** 空候选归因（renderer 缺省展示用）。 */
const EMPTY_ATTRIBUTION: WishCoinAttribution = {
  confidence: "unknown",
  coinKey: null,
  candidates: [],
};

/** `WishStats` 的初始空形态（stats 尚未到达时使用）。 */
export const EMPTY_WISH_STATS: WishStats = {
  offeringCountTotal: 0,
  itemCountTotal: 0,
  itemsPerOffering: 0,
  offeringCountSession: 0,
  itemCountSession: 0,
  offeringPerHour: 0,
  itemPerHour: 0,
  offeringRecentPerHour: 0,
  itemRecentPerHour: 0,
  gradeDistribution: EMPTY_GRADE_DISTRIBUTION,
  breakdown: [],
  history: [],
  lastWishWallTime: null,
  readerRequired: true,
  gameOfferingItemCount: null,
  recentResults: [],
  coinGroups: [],
  unattributed: { items: [] },
};

/** 品质分布表的显示签名：只在可见数值变化时改引用，避免 5 Hz 抖动。 */
function gradeDistributionSig(rows: WishGradeRow[]): string {
  return rows.map((r) => `${r.grade}:${r.count}:${pctSig(r.share)}`).join(";");
}

/** 单品排行的显示签名（名称 / 件数 / 占比 / 品质）。 */
function breakdownSig(rows: WishBreakdownRow[]): string {
  return rows.map((r) => `${r.name}:${r.count}:${pctSig(r.share)}:${r.grade}`).join(";");
}

/** 历史列表的显示签名（时间 / 名称 / 品质 / 件数 / bulk 标记 / 硬币归因）。 */
function historySig(entries: WishHistoryEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.wallTime}:${e.name}:${e.grade}:${e.count}:${e.bulk ? 1 : 0}:` +
        `${e.coin?.confidence ?? "-"}:${e.coin?.coinKey ?? "-"}`,
    )
    .join(";");
}

/** 最近结果的显示签名（时间 / 名称 / 品质 / 件数 / 硬币归因）。 */
function recentSig(rows: WishRecentResult[]): string {
  return rows
    .map(
      (r) =>
        `${r.wallTime}:${r.name}:${r.grade}:${r.count}:` +
        `${r.coin.confidence}:${r.coin.coinKey ?? "-"}`,
    )
    .join(";");
}

/** 硬币分组的显示签名（硬币 / 次数 / 件数 / 条目数）。 */
function coinGroupsSig(groups: WishCoinGroup[]): string {
  return groups
    .map((g) => `${g.coinKey}:${g.offeringCount}:${g.itemCount}:${g.items.length}`)
    .join(";");
}

/** 未归因分组的显示签名。 */
function unattributedSig(group: WishUnattributedGroup): string {
  return group.items.map((i) => `${i.name}:${i.count}:${i.grade}`).join(";");
}

/**
 * 手工绑定的显示签名（物品名 / 硬币 / 创建时间），用于引用稳定化。
 *
 * 必须容忍 undefined / 非数组：签名函数是在**渲染期**被调用的，一旦抛错整个
 * 祈愿页会被 ErrorBoundary 接住并崩掉。IPC 广播 / 回传的载荷来自主进程，历史
 * 上曾因 `setWishCoinOverrides` 返回 void 而使状态被设成 `undefined`
 * （`Cannot read properties of undefined (reading 'map')`）。
 */
function overridesSig(overrides: WishCoinOverrides | null | undefined): string {
  if (!Array.isArray(overrides)) return "";
  return overrides.map((o) => `${o.itemName}:${o.coinKey}:${o.createdAt}`).join(";");
}

/** 未归因条目的候选签名（含硬币归因档位）—— 供手工绑定行展示。 */
function unattributedDetailSig(group: WishUnattributedGroup): string {
  return group.items
    .map((i) => `${i.name}:${i.count}:${i.grade}:${i.coin?.confidence ?? "-"}`)
    .join(";");
}

export interface UseWishResult {
  /** `Stats.wish`；stats 未到达时为 {@link EMPTY_WISH_STATS}（永不为 null）。 */
  wish: WishStats;
  /** 稳态引用稳定的品质分布行。 */
  gradeDistribution: WishGradeRow[];
  /** 稳态引用稳定的单品排行行。 */
  breakdown: WishBreakdownRow[];
  /** 稳态引用稳定的历史条目（倒序，最新在前）。 */
  history: WishHistoryEntry[];
  /** 稳态引用稳定的「最近祈愿结果」。 */
  recentResults: WishRecentResult[];
  /** 稳态引用稳定的「按硬币分组」。 */
  coinGroups: WishCoinGroup[];
  /** 稳态引用稳定的「未归因 / 候选」分组。 */
  unattributed: WishUnattributedGroup;
  /** 背包持有的献祭硬币（renderer 侧 join，W1 定稿；不新增 stats 字段）。 */
  heldCoins: WishHeldCoin[];
  /** coinKey → 硬币元数据（图鉴优先），供硬币徽章 / tooltip 复用。 */
  coinResolver: (
    coinKey: number,
  ) => { coinKey: number; name: string; grade: string; iconPath: string } | undefined;
  /** 当前生效的手工硬币绑定（`config.wishCoinOverrides`）。 */
  coinOverrides: WishCoinOverrides;
  /**
   * 手工把某物品绑定到硬币（`coinKey == null` 表示解除绑定，回到自动归因）。
   * 乐观更新本地状态后经 `SET_WISH_COIN_OVERRIDES` 落盘并广播。
   */
  setCoinOverride: (itemName: string, coinKey: number | null) => Promise<void>;
  /** 是否已有任何祈愿产出（累计次数 > 0）。 */
  hasData: boolean;
  /**
   * 重置「会话」统计。语义为会话基线重置：`*Session` 归零、累计不变。
   * 复用既有 `IPC.RESET` 通道（`window.tbh.reset()`），P0 不新增 IPC。
   */
  resetSession: () => Promise<void>;
}

/**
 * 祈愿页数据源。读取既有 `Stats.wish`（随 5 Hz stats 广播下发，无新 IPC /
 * 无新内存读取），并把热列表做引用稳定化，避免每 tick 触发重渲染。
 *
 * 硬币面板（W1 定稿）：`WishStats` **不**含 `heldCoins` —— 这里用
 * `useInventory().rows` + `useLookupCatalog()` 现场 join 派生背包持有硬币，
 * 既满足"renderer 侧派生"的裁决，又天然随背包/目录刷新而更新。
 *
 * 会话重置复用既有 `IPC.RESET` 通道 —— 主进程会同时重置掉落 / 祈愿会话，
 * 这是 P0 约定的共享重置入口（见架构 §3.3）。
 */
export function useWish(): UseWishResult {
  const stats = useStats();
  const wish = stats?.wish ?? EMPTY_WISH_STATS;
  const inventory = useInventory();
  const catalog = useLookupCatalog();

  // 手工硬币绑定：来自 config（主进程广播），初始拉取 + 订阅变更。
  // 所有入口都归一化为数组 —— 状态一旦是非数组，渲染期的签名函数就会抛错。
  const [coinOverrides, setCoinOverrides] = useState<WishCoinOverrides>([]);
  const applyOverrides = useCallback((rows: unknown): void => {
    setCoinOverrides(Array.isArray(rows) ? (rows as WishCoinOverrides) : []);
  }, []);
  useEffect(() => {
    let alive = true;
    window.tbh
      .getWishCoinOverrides()
      .then((rows) => {
        if (alive) applyOverrides(rows);
      })
      .catch(reportIpcError);
    const off = window.tbh.onWishCoinOverrides((rows) => applyOverrides(rows));
    return () => {
      alive = false;
      off();
    };
  }, [applyOverrides]);

  const gradeDistribution = useStableBySignature(wish.gradeDistribution, gradeDistributionSig);
  const breakdown = useStableBySignature(wish.breakdown, breakdownSig);
  const historyRaw = useStableBySignature(wish.history, historySig);
  const recentResultsRaw = useStableBySignature(wish.recentResults ?? [], recentSig);
  const coinGroupsRaw = useStableBySignature(wish.coinGroups ?? [], coinGroupsSig);
  const unattributedRaw = useStableBySignature(wish.unattributed ?? { items: [] }, unattributedSig);

  // 硬币元数据解析器（图鉴优先）—— 目录变更时重建，避免每次渲染重建 Map。
  const coinResolver = useMemo(() => makeCoinResolver(catalog), [catalog]);

  // 手工绑定是**事后**建立且须对已记录历史生效 → renderer 侧幂等再派生
  // （不改 main 的 feed 归因、不重算历史）。overrides 为空时零开销。
  const stableOverrides = useStableBySignature(coinOverrides, overridesSig);
  const overridesActive = stableOverrides.length > 0;

  const { coinGroups, unattributed } = useMemo(() => {
    if (!overridesActive) return { coinGroups: coinGroupsRaw, unattributed: unattributedRaw };
    return applyCoinOverrides(coinGroupsRaw, unattributedRaw, stableOverrides, (coinKey) => {
      const meta = coinResolver(coinKey);
      return meta ? { name: meta.name, grade: meta.grade as WishGrade } : undefined;
    });
  }, [overridesActive, coinGroupsRaw, unattributedRaw, stableOverrides, coinResolver]);

  // 未归因区的手工绑定须与「按硬币分组」口径一致 —— 已绑定物品在最近结果 /
  // 历史里的硬币列改写为 `manual`。
  const history = useMemo(
    () => (overridesActive ? applyOverridesToHistory(historyRaw, stableOverrides) : historyRaw),
    [overridesActive, historyRaw, stableOverrides],
  );
  const recentResults = useMemo(
    () =>
      overridesActive
        ? applyOverridesToRecent(recentResultsRaw, stableOverrides)
        : recentResultsRaw,
    [overridesActive, recentResultsRaw, stableOverrides],
  );

  const coinGroupsStable = useStableBySignature(coinGroups, coinGroupsSig);
  const unattributedStable = useStableBySignature(unattributed, unattributedDetailSig);
  const historyStable = useStableBySignature(history, historySig);
  const recentStable = useStableBySignature(recentResults, recentSig);

  // 背包持有硬币：renderer 侧 join（W1）。签名只在数值变化时改引用，避免抖动。
  const heldCoins = useStableBySignature(
    useMemo(() => heldCoinsFromInventory(inventory, catalog), [inventory, catalog]),
    (rows) => rows.map((r) => `${r.coinKey}:${r.quantity}:${r.grade}`).join(";"),
  );

  const hasData = useMemo(
    () => wish.offeringCountTotal > 0 || wish.itemCountTotal > 0,
    [wish.offeringCountTotal, wish.itemCountTotal],
  );

  const setCoinOverride = useCallback(
    async (itemName: string, coinKey: number | null): Promise<void> => {
      const name = itemName.trim();
      if (!name) return;
      // 先按当前状态算出目标数组（在 updater 之外计算，避免依赖 React 何时执行
      // updater —— 若把 `next` 写在 updater 里，IPC 会先于 updater 执行，
      // 从而把**旧值**发出去）。乐观更新本地状态后落盘。
      const current = Array.isArray(coinOverrides) ? coinOverrides : [];
      const rest = current.filter((o) => o.itemName !== name);
      const next: WishCoinOverrides =
        coinKey == null ? rest : [...rest, { itemName: name, coinKey, createdAt: Date.now() }];
      setCoinOverrides(next);
      try {
        const saved = await window.tbh.setWishCoinOverrides(next);
        applyOverrides(saved);
      } catch (err) {
        reportIpcError(err);
      }
    },
    [coinOverrides, applyOverrides],
  );

  const resetSession = useCallback(async (): Promise<void> => {
    try {
      await window.tbh.reset();
    } catch (err) {
      reportIpcError(err);
    }
  }, []);

  return {
    wish,
    gradeDistribution,
    breakdown,
    history: historyStable,
    recentResults: recentStable,
    coinGroups: coinGroupsStable,
    unattributed: unattributedStable,
    heldCoins,
    coinOverrides: stableOverrides,
    setCoinOverride,
    coinResolver,
    hasData,
    resetSession,
  };
}

/** 归因对象的安全兜底（历史条目可能无 coin 字段 —— 旧快照兼容）。 */
export function attributionOf(coin: WishCoinAttribution | undefined): WishCoinAttribution {
  return coin ?? EMPTY_ATTRIBUTION;
}
