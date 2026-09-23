// 帧级差分硬币归因（P0-3）—— 纯函数。
//
// 语义（诚实设计，见 docs/prd/2026-09-23-wish-v2-design.md §Q1）：
// `observed` = 「在该祈愿事件的采样区间内，10 枚硬币中**恰有 1 枚** materialStacks
// 净减少」，而非「这枚硬币就是本次祈愿消耗的」。因此判据是**三重降级**：
//   1. 唯一性：减少的硬币集合大小恰为 1；
//   2. 时间窗：事件 wallTime 落在 [beforeAt - tol, afterAt + tol]；
//   3. bulk 护栏：bulk 行的 wallTime 非事件时刻 → **直接跳过差分**。
// 任一不满足 → `unknown`（**绝不「就近猜」**，I7）。
//
// 无 electron / node:fs / fetch / React 依赖（I9）。

import type { WishCoinAttribution } from "../../../shared/types";
import { WISH_COIN_KEYS } from "./constants";

/** `attributeCoinByDiff` 的入参与选项。 */
export interface CoinDiffOptions {
  /** 该祈愿行的墙钟时刻（epoch 秒）。 */
  wallTime: number;
  /** 参与判定的硬币闭集；缺省 {@link WISH_COIN_KEYS}。 */
  coinKeys?: readonly number[];
  /** bulk 行（initial 回灌）—— wallTime 非事件时刻 → 跳过差分。 */
  bulk?: boolean;
  /** before 帧的采样时刻（epoch 秒）。 */
  beforeAt?: number | null;
  /** after 帧的采样时刻（epoch 秒）。 */
  afterAt?: number | null;
  /** 时间窗容差（秒）—— 调用方由 pollIntervalSeconds 动态算出。 */
  toleranceSec?: number;
}

/**
 * 帧级差分归因（纯函数）。
 *
 * @param before 事件时刻**之前**最近一帧的 coinKey → 数量 快照；无帧传 null。
 * @param after  事件时刻**之后**第一帧的 coinKey → 数量 快照；无帧传 null。
 * @param opts   见 {@link CoinDiffOptions}。
 * @returns 差分唯一 + 时间窗双满足 → `{ confidence:"observed", coinKey }`；
 *          否则一律 `{ confidence:"unknown", coinKey:null, candidates:[], basis }`。
 */
export function attributeCoinByDiff(
  before: ReadonlyMap<number, number> | null,
  after: ReadonlyMap<number, number> | null,
  opts: CoinDiffOptions,
): WishCoinAttribution {
  // bulk 行跳过差分（I4）：其 wallTime 是回灌时刻，差分毫无意义。
  if (opts.bulk === true) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "bulk-skip" };
  }

  // 缺任一帧 → 无法差分。
  if (before == null || after == null) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "no-frame" };
  }

  // 收集净减少（delta > 0）的硬币。
  const coinKeys = opts.coinKeys ?? WISH_COIN_KEYS;
  const decreased: number[] = [];
  for (const coinKey of coinKeys) {
    const b = before.get(coinKey) ?? 0;
    const a = after.get(coinKey) ?? 0;
    if (b - a > 0) decreased.push(coinKey);
  }

  // 唯一性：必须恰有 1 枚减少。
  if (decreased.length === 0) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "no-decrease" };
  }
  if (decreased.length > 1) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "multi-coin" };
  }

  // 时间窗：事件时刻必须落在 [beforeAt - tol, afterAt + tol]。
  const tol = Number.isFinite(opts.toleranceSec) ? Math.max(0, opts.toleranceSec as number) : 0;
  if (opts.beforeAt == null || opts.afterAt == null) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "no-frame-time" };
  }
  const lo = opts.beforeAt - tol;
  const hi = opts.afterAt + tol;
  if (opts.wallTime < lo || opts.wallTime > hi) {
    return { confidence: "unknown", coinKey: null, candidates: [], basis: "out-of-window" };
  }

  const coinKey = decreased[0]!;
  return { confidence: "observed", coinKey, candidates: [], basis: `diff:${coinKey}` };
}
