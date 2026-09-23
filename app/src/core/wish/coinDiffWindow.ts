// 差分帧窗口（P0-3 采样）—— 纯逻辑，无 fs。
//
// 环形保留最近 **2 帧** `materialStacks` 快照（每帧带采样时刻 `at`）。祈愿事件
// 到达时用 `bracket(wallTime)` 取「事件时刻之前最近一帧 = before」与「事件时刻
// 之后第一帧 = after」，交给 `attributeCoinByDiff` 做唯一性 + 时间窗判定。
//
// 数据由 main 侧在 save 解析回调里 `push`（**不新开定时器**）。
// 会话重置（`wishTracker.reset()` 的 4 处接线点）需同步 `reset()`（W7）。
//
// 无 electron / node:fs / fetch / React 依赖（I9）。

/** 一帧差分快照。 */
export interface CoinDiffFrame {
  /** 采样时刻（epoch 秒，通常用 saveMtime）。 */
  at: number;
  /** coinKey → 数量。 */
  stacks: ReadonlyMap<number, number>;
}

/** `bracket` 的返回：事件时刻前后的两帧。 */
export interface CoinDiffBracket {
  before: ReadonlyMap<number, number> | null;
  beforeAt: number | null;
  after: ReadonlyMap<number, number> | null;
  afterAt: number | null;
}

/**
 * 保留最近 2 帧的差分窗口。
 *
 * 实现为「按 `at` 排序的小数组，超过 2 帧丢最旧」——2 帧即够 `bracket`
 * （before = 事件前最近一帧，after = 事件后第一帧）。
 */
export class WishCoinDiffWindow {
  /** 按 at 升序的帧（最多 2 帧）。 */
  private frames: CoinDiffFrame[] = [];

  /** 推入一帧（环形保留最近 2 帧）。 */
  push(frame: CoinDiffFrame): void {
    if (!frame || !Number.isFinite(frame.at)) return;
    // 乱序到达时按 at 插入保持有序（save 轮询理论有序，防御处理）。
    const next = [...this.frames, frame].sort((a, b) => a.at - b.at);
    // 保留最近 2 帧。
    this.frames = next.slice(-2);
  }

  /**
   * 取事件时刻前后的两帧。
   *  - `before` = `at <= wallTime` 中 at 最大的一帧；无则 null。
   *  - `after`  = `at > wallTime` 中 at 最小的一帧；无则 null。
   */
  bracket(wallTime: number): CoinDiffBracket {
    let before: CoinDiffFrame | null = null;
    let after: CoinDiffFrame | null = null;
    for (const f of this.frames) {
      if (f.at <= wallTime) {
        if (before === null || f.at > before.at) before = f;
      } else {
        if (after === null || f.at < after.at) after = f;
      }
    }
    return {
      before: before?.stacks ?? null,
      beforeAt: before?.at ?? null,
      after: after?.stacks ?? null,
      afterAt: after?.at ?? null,
    };
  }

  /** 清空窗口（会话重置 / 存档路径变更 / live 开关切换）。 */
  reset(): void {
    this.frames = [];
  }

  /** 当前保留的帧数（诊断 / 测试用）。 */
  size(): number {
    return this.frames.length;
  }
}
