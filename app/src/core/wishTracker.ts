// 祈愿领域聚合器（对标 `ChestDropTracker`）。
//
// 与掉落的最大结构差异是**双计数维度**：
//   - `offeringCount`（祈愿次数）：识别到一条祈愿结果行 = 1 次（按事件，不按物品数）。
//   - `itemCount`（产出物品数）：该行解析出的件数之和（缺省 1）。
// 两者各自维护累计与会话基线，per-hour 速率共用同一时间分母。
//
// breakdown 以**物品名**为聚合键（P0 无结构化 itemKey，见 PRD §5.5）。
// 品质由 `wishLine.parseWishLine` 经 COLOR_TO_GRADE 映射；无法映射一律
// UNKNOWN，绝不猜测。
//
// bulk 护栏：`initial=true` 的会话存量回灌行标 `bulk: true`，计入累计 /
// 会话 / 历史，但**不进 `*RecentPerHour` 滚动窗**（防止一次回灌顶爆滚动速率）。
//
// 纯逻辑：无 electron / node:fs / fetch / React 依赖，可单测。

import type {
  WishBreakdownRow,
  WishGrade,
  WishGradeRow,
  WishHistoryEntry,
  WishStats,
  WishTrackerSnapshot,
} from "../../shared/types";
import type { WishLineItem } from "./wishLine";

/** 会话 per-hour 分母下限（秒），与掉落同值（PRD §5.3.2）。 */
const MIN_RATE_WINDOW_SEC = 60;
/** 滚动 1h 速率分母下限（秒），与掉落同值（PRD §5.3 末段）。 */
const RECENT_MIN_WINDOW_SEC = 300;
/** 滚动窗口（秒）。 */
const ROLLING_HOUR_SEC = 3600;
/** 历史内存裁剪上限。 */
const HISTORY_LIMIT = 500;
/** 历史可见窗口。 */
const HISTORY_VISIBLE = 50;

/** 品质桶的固定顺序（用于确定性输出）。 */
const GRADE_ORDER: readonly WishGrade[] = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "LEGENDARY",
  "IMMORTAL",
  "ARCANA",
  "CELESTIAL",
  "UNKNOWN",
];

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** 空的 8 桶品质计数。 */
function emptyGradeCounts(): Record<WishGrade, number> {
  return {
    COMMON: 0,
    UNCOMMON: 0,
    RARE: 0,
    LEGENDARY: 0,
    IMMORTAL: 0,
    ARCANA: 0,
    CELESTIAL: 0,
    UNKNOWN: 0,
  };
}

/** 判断字符串是否为合法品质。 */
function isWishGrade(value: unknown): value is WishGrade {
  return typeof value === "string" && (GRADE_ORDER as readonly string[]).includes(value);
}

/**
 * 祈愿产出聚合器。5 Hz 调用 `getStats`，内部有缓存。
 */
export class WishTracker {
  // —— 累计计数 ——
  private offeringCount = 0;
  private itemCount = 0;
  // —— 名称维度聚合 ——
  private countsByName = new Map<string, number>();
  /** 名称 → 品质（首见；同名异色时保留首个，供 breakdown 着色）。 */
  private gradeByName = new Map<string, WishGrade>();
  /** 名称 → 品质计数（用于取最高频品质）。 */
  private gradeCountsByName = new Map<string, Record<WishGrade, number>>();
  /** 全局品质桶计数（8 桶含 UNKNOWN）。 */
  private gradeCounts: Record<WishGrade, number> = emptyGradeCounts();
  // —— 历史 ——
  private history: WishHistoryEntry[] = [];

  /**
   * 会话基线（累计口径 - 会话口径 = 基线）。重置会话时把当前累计写入基线，
   * 使 `*Session` 归零而累计不变。
   */
  private sessionOfferingBaseline = 0;
  private sessionItemBaseline = 0;

  /**
   * perHour 速率窗口锚点 = min(trackingStartedAt, firstWishWallTime)。
   * 见 PRD §5.3.1：包含等待第一次祈愿的时间（避免刚重置后尖峰），
   * 同时容忍历史行（wallTime 早于本次启动）锚定到自己的真实时刻。
   */
  private sessionWishStart: number | null = null;

  /** 记录开始时刻（构造 / reset）。 */
  private trackingStartedAt: number;

  /**
   * 会话纪元，bumped on every reset / applySnapshot（会话边界）。与
   * `ChestDropTracker` 同语义，供跨重置的延迟补记判断。
   */
  private sessionEpoch = 0;

  // —— 输出缓存（仅在 mutation 时失效）——
  private breakdownCache: WishBreakdownRow[] | null = null;
  private historyCache: WishHistoryEntry[] | null = null;

  /**
   * 滚动 1h 窗内的非 bulk 行（wallTime + count）。bulk 行不入此窗。
   * 用于 `*RecentPerHour`；在每次 feed 时增量维护并在 getStats 时按窗口裁剪。
   */
  private recentEntries: Array<{ wallTime: number; count: number }> = [];

  /** 最近一次祈愿墙钟时刻。 */
  private lastWishWallTime: number | null = null;

  constructor() {
    this.trackingStartedAt = nowSeconds();
  }

  /** 当前会话纪元（见 {@link sessionEpoch}）。 */
  getSessionEpoch(): number {
    return this.sessionEpoch;
  }

  /**
   * 摄入一条祈愿产出。
   * @param item   parseWishLine 的结果（名称 / 颜色 / 件数 / 品质）。
   * @param wallTime companion 收到该行的墙钟秒（非游戏内时间）。
   * @param opts   { gameTime?: string; raw: string; bulk?: boolean }
   * @returns true = 已计入。
   */
  feed(
    item: WishLineItem,
    wallTime: number,
    opts: { gameTime?: string; raw: string; bulk?: boolean },
  ): boolean {
    const name = (item.name ?? "").trim();
    if (!name) return false;
    const count = item.count != null && item.count >= 1 ? item.count : 1;
    const grade: WishGrade = isWishGrade(item.grade) ? item.grade : "UNKNOWN";
    const bulk = opts.bulk === true;

    // 双计数：一条祈愿结果行 = +1 次；件数按行内 count 累加。
    this.offeringCount += 1;
    this.itemCount += count;

    // 名称维度。
    this.countsByName.set(name, (this.countsByName.get(name) ?? 0) + count);
    if (!this.gradeByName.has(name)) this.gradeByName.set(name, grade);
    let perName = this.gradeCountsByName.get(name);
    if (!perName) {
      perName = emptyGradeCounts();
      this.gradeCountsByName.set(name, perName);
    }
    perName[grade] += count;

    // 全局品质桶。
    this.gradeCounts[grade] += count;

    // 历史（一次祈愿事件 = 一行）。
    const entry: WishHistoryEntry = {
      wallTime,
      gameTime: opts.gameTime,
      name,
      grade,
      count,
      raw: opts.raw,
    };
    if (bulk) entry.bulk = true;
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }

    // bulk 行不入滚动窗（否则一次会话回灌会把滚动速率顶爆）。
    if (!bulk) {
      this.recentEntries.push({ wallTime, count });
      this.drainRecentEntries(nowSeconds() - ROLLING_HOUR_SEC);
    }

    // 速率窗口锚点：首次祈愿时把窗口起点钉在 min(trackingStartedAt, wallTime)。
    this.sessionWishStart ??= Math.min(this.trackingStartedAt, wallTime);

    if (this.lastWishWallTime === null || wallTime > this.lastWishWallTime) {
      this.lastWishWallTime = wallTime;
    }

    this.breakdownCache = null;
    this.historyCache = null;
    return true;
  }

  /** 裁剪滚动窗内过期的非 bulk 行。 */
  private drainRecentEntries(cutoff: number): void {
    // history / restore 可能乱序，故 filter 而非 shift 头部。
    const kept: Array<{ wallTime: number; count: number }> = [];
    for (const e of this.recentEntries) {
      if (e.wallTime >= cutoff) kept.push(e);
    }
    this.recentEntries = kept;
  }

  /**
   * 输出统计（口径见 PRD §5）。5Hz 调用，内部有缓存。
   */
  getStats(_elapsedSeconds: number): WishStats {
    const itemTotal = this.itemCount;
    const offeringTotal = this.offeringCount;

    // —— 累计速率（会话口径）——
    const offeringSession = offeringTotal - this.sessionOfferingBaseline;
    const itemSession = itemTotal - this.sessionItemBaseline;

    // perHour 分母：max(MIN_RATE_WINDOW_SEC, now - sessionWishStart) / 3600。
    const now = nowSeconds();
    const sessionElapsedSec =
      this.sessionWishStart !== null
        ? Math.max(MIN_RATE_WINDOW_SEC, now - this.sessionWishStart)
        : MIN_RATE_WINDOW_SEC;
    const sessionHours = sessionElapsedSec / 3600;
    const offeringPerHour = Math.max(0, offeringSession) / sessionHours;
    const itemPerHour = Math.max(0, itemSession) / sessionHours;

    // —— 滚动 1h 速率（跳过 bulk 行）——
    this.drainRecentEntries(now - ROLLING_HOUR_SEC);
    let recentOfferings = 0;
    let recentItems = 0;
    let earliestRecentWallTime: number | null = null;
    for (const e of this.recentEntries) {
      recentOfferings += 1;
      recentItems += e.count;
      if (earliestRecentWallTime === null || e.wallTime < earliestRecentWallTime) {
        earliestRecentWallTime = e.wallTime;
      }
    }
    const recentWindowSec =
      earliestRecentWallTime !== null
        ? Math.max(RECENT_MIN_WINDOW_SEC, Math.min(ROLLING_HOUR_SEC, now - earliestRecentWallTime))
        : ROLLING_HOUR_SEC;
    const recentHours = recentWindowSec / 3600;
    const offeringRecentPerHour = recentOfferings / recentHours;
    const itemRecentPerHour = recentItems / recentHours;

    // —— itemsPerOffering ——
    const itemsPerOffering = offeringTotal > 0 ? itemTotal / offeringTotal : 0;

    // —— breakdown（名称维度，缓存）——
    if (this.breakdownCache === null) {
      const rows: WishBreakdownRow[] = [];
      for (const [name, count] of this.countsByName) {
        if (count <= 0) continue;
        const grade = this.dominantGrade(name);
        rows.push({
          name,
          count,
          share: itemTotal > 0 ? count / itemTotal : 0,
          grade,
        });
      }
      // count 降序；同值 name 升序（保证稳定）。
      rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      this.breakdownCache = rows;
    }
    const breakdown = this.breakdownCache;

    // —— 品质分布（8 桶，缓存间接：只有 mutation 时 gradeCounts 变）——
    const gradeDistribution: WishGradeRow[] = [];
    for (const grade of GRADE_ORDER) {
      const count = this.gradeCounts[grade];
      gradeDistribution.push({
        grade,
        count,
        share: itemTotal > 0 ? count / itemTotal : 0,
      });
    }

    // —— 历史（倒序，最新在前，上限 HISTORY_VISIBLE）——
    if (this.historyCache === null) {
      this.historyCache = this.history.slice(-HISTORY_VISIBLE).reverse();
    }
    const history = this.historyCache;

    return {
      offeringCountTotal: offeringTotal,
      itemCountTotal: itemTotal,
      itemsPerOffering,
      offeringCountSession: Math.max(0, offeringSession),
      itemCountSession: Math.max(0, itemSession),
      offeringPerHour,
      itemPerHour,
      offeringRecentPerHour,
      itemRecentPerHour,
      gradeDistribution,
      breakdown,
      history,
      lastWishWallTime: this.lastWishWallTime,
      readerRequired: true,
      // P1-3：游戏侧 Satistics_TotalOfferingCount 未接入 → null。
      gameOfferingItemCount: null,
    };
  }

  /** 取某名称下最高频品质（并列取 GRADE_ORDER 中靠前者）。 */
  private dominantGrade(name: string): WishGrade {
    const counts = this.gradeCountsByName.get(name);
    if (!counts) return this.gradeByName.get(name) ?? "UNKNOWN";
    let best: WishGrade = "UNKNOWN";
    let bestCount = -1;
    for (const grade of GRADE_ORDER) {
      if (counts[grade] > bestCount) {
        bestCount = counts[grade];
        best = grade;
      }
    }
    return best;
  }

  /** 全量历史（供 P1-3 对账 / P2-2 导出）。 */
  fitHistory(): WishHistoryEntry[] {
    return [...this.history];
  }

  /**
   * 会话重置：`*Session` 归零（基线 = 当前累计）、累计不变、
   * `sessionWishStart` 重置为现在、`sessionEpoch++`。
   * 注意：`wish_record.json`（P1 长期归档）不随会话重置清空。
   */
  reset(): void {
    this.sessionOfferingBaseline = this.offeringCount;
    this.sessionItemBaseline = this.itemCount;
    this.trackingStartedAt = nowSeconds();
    this.sessionWishStart = null;
    this.recentEntries = [];
    this.sessionEpoch++;
    // 累计 / 历史 / 名称聚合保持不变，故 breakdown 缓存仍有效；
    // 但滚动窗清空会影响 recent 速率（每帧实时计算，无需清缓存）。
    this.breakdownCache = null;
    this.historyCache = null;
  }

  /** 序列化快照。 */
  captureSnapshot(): WishTrackerSnapshot {
    const gradeByName: Record<string, WishGrade> = {};
    for (const [name, grade] of this.gradeByName) gradeByName[name] = grade;
    return {
      offeringCount: this.offeringCount,
      itemCount: this.itemCount,
      countsByName: Object.fromEntries(this.countsByName),
      gradeByName,
      history: this.history.map((e) => ({ ...e })),
      sessionWishStart: this.sessionWishStart,
      sessionOfferingBaseline: this.sessionOfferingBaseline,
      sessionItemBaseline: this.sessionItemBaseline,
    };
  }

  /**
   * 恢复快照。
   *
   * 语义（与 `ChestDropTracker.applySnapshot` 对齐）：恢复的累计 + 历史全部
   * **计入会话**（基线置 0）。锚点优先取快照的 `sessionWishStart`（若缺失则取
   * 最老 history 的 wallTime），使会话窗口覆盖完整历史。
   *
   * 兼容旧档：快照缺失字段时取保守默认值。
   */
  applySnapshot(data: WishTrackerSnapshot | null | undefined): void {
    if (!data) return;

    const offering = Number.isFinite(data.offeringCount) ? Math.max(0, data.offeringCount) : 0;
    const items = Number.isFinite(data.itemCount) ? Math.max(0, data.itemCount) : 0;
    this.offeringCount = offering;
    this.itemCount = items;

    const counts = new Map<string, number>();
    for (const [name, count] of Object.entries(data.countsByName ?? {})) {
      if (typeof count === "number" && count > 0) counts.set(name, count);
    }
    this.countsByName = counts;

    const gradeByName = new Map<string, WishGrade>();
    for (const [name, grade] of Object.entries(data.gradeByName ?? {})) {
      if (isWishGrade(grade)) gradeByName.set(name, grade);
    }
    this.gradeByName = gradeByName;

    // 由 countsByName + gradeByName 重建 gradeCounts / gradeCountsByName
    // （gradeByName 每名一个品质，故各名的全部件数计入该品质）。
    this.gradeCounts = emptyGradeCounts();
    this.gradeCountsByName = new Map();
    for (const [name, count] of this.countsByName) {
      const grade = this.gradeByName.get(name) ?? "UNKNOWN";
      this.gradeCounts[grade] += count;
      const per = emptyGradeCounts();
      per[grade] = count;
      this.gradeCountsByName.set(name, per);
    }

    // 历史裁剪到 HISTORY_LIMIT（防止膨胀 / 手改档）。深拷贝每条，避免与入参
    // 共享引用（外部改动快照不应影响 tracker 内部状态）。
    const restored = Array.isArray(data.history) ? data.history : [];
    this.history =
      restored.length > HISTORY_LIMIT
        ? restored.slice(-HISTORY_LIMIT).map((e) => ({ ...e }))
        : restored.map((e) => ({ ...e }));

    // 恢复的计数全部计入会话（基线置 0）。
    this.sessionOfferingBaseline = 0;
    this.sessionItemBaseline = 0;

    // 锚点：优先快照的 sessionWishStart，缺失则取最老 history 的 wallTime。
    const savedAnchor = data.sessionWishStart ?? null;
    const oldestHistory = this.history.length > 0 ? this.history[0].wallTime : null;
    this.sessionWishStart =
      savedAnchor != null
        ? oldestHistory != null
          ? Math.min(savedAnchor, oldestHistory)
          : savedAnchor
        : oldestHistory;
    this.trackingStartedAt = this.sessionWishStart ?? nowSeconds();

    // 最近祈愿时刻 = 历史中最大 wallTime（可能被截断，但仍是可用的下界）。
    let last: number | null = null;
    for (const e of this.history) {
      if (last === null || e.wallTime > last) last = e.wallTime;
    }
    this.lastWishWallTime = last;

    // 滚动窗按恢复历史中的非 bulk 行重建（bulk 行仍不进窗）。
    this.recentEntries = [];
    for (const e of this.history) {
      if (!e.bulk) this.recentEntries.push({ wallTime: e.wallTime, count: e.count });
    }
    this.drainRecentEntries(nowSeconds() - ROLLING_HOUR_SEC);

    this.breakdownCache = null;
    this.historyCache = null;
    this.sessionEpoch++;
  }
}
