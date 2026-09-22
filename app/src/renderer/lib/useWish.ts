import { useCallback, useMemo } from "react";
import { useStats } from "./useStats";
import { reportIpcError } from "./reportError";
import { useStableBySignature, pctSig } from "./useStableBySignature";
import type {
  WishBreakdownRow,
  WishGrade,
  WishGradeRow,
  WishHistoryEntry,
  WishStats,
} from "../../../shared/types";

/**
 * 品质桶的稳定输出顺序（由低到高，未知置末尾）。与 core/wishTracker.ts 的
 * GRADE_ORDER 保持一致 —— 这里重新声明是为了让 renderer 不依赖 core 的
 * 内部常量，同时保证渲染顺序恒定（核心已按此序输出，此处仅作防御性重排）。
 */
const GRADE_ORDER: WishGrade[] = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "LEGENDARY",
  "IMMORTAL",
  "ARCANA",
  "CELESTIAL",
  "UNKNOWN",
];

/** 品质分布默认骨架：8 个桶全 0，避免首次渲染时表格跳高。 */
const EMPTY_GRADE_DISTRIBUTION: WishGradeRow[] = GRADE_ORDER.map((grade) => ({
  grade,
  count: 0,
  share: 0,
}));

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
};

/** 品质分布表的显示签名：只在可见数值变化时改引用，避免 5 Hz 抖动。 */
function gradeDistributionSig(rows: WishGradeRow[]): string {
  return rows.map((r) => `${r.grade}:${r.count}:${pctSig(r.share)}`).join(";");
}

/** 单品排行的显示签名（名称 / 件数 / 占比 / 品质）。 */
function breakdownSig(rows: WishBreakdownRow[]): string {
  return rows.map((r) => `${r.name}:${r.count}:${pctSig(r.share)}:${r.grade}`).join(";");
}

/** 历史列表的显示签名（时间 / 名称 / 品质 / 件数 / bulk 标记）。 */
function historySig(entries: WishHistoryEntry[]): string {
  return entries
    .map((e) => `${e.wallTime}:${e.name}:${e.grade}:${e.count}:${e.bulk ? 1 : 0}`)
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
 * 会话重置复用既有 `IPC.RESET` 通道 —— 主进程会同时重置掉落 / 祈愿会话，
 * 这是 P0 约定的共享重置入口（见架构 §3.3）。
 */
export function useWish(): UseWishResult {
  const stats = useStats();
  const wish = stats?.wish ?? EMPTY_WISH_STATS;

  const gradeDistribution = useStableBySignature(wish.gradeDistribution, gradeDistributionSig);
  const breakdown = useStableBySignature(wish.breakdown, breakdownSig);
  const history = useStableBySignature(wish.history, historySig);

  const hasData = useMemo(
    () => wish.offeringCountTotal > 0 || wish.itemCountTotal > 0,
    [wish.offeringCountTotal, wish.itemCountTotal],
  );

  const resetSession = useCallback(async (): Promise<void> => {
    try {
      await window.tbh.reset();
    } catch (err) {
      reportIpcError(err);
    }
  }, []);

  return { wish, gradeDistribution, breakdown, history, hasData, resetSession };
}
