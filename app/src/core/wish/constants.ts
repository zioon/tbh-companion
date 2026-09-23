// 祈愿（Wish v2）核心常量。
//
// 纯常量模块：无 electron / node:fs / fetch / React 依赖（I9）。
//
// 硬币闭集（WISH_COIN_KEYS）的**权威来源**是 `data/lookup_items.json`
// （`materialType:"OFFERING"` 的 10 枚 MATERIAL）；此处复述为判别键闭集，
// 供 core 归因与 renderer 面板共用，避免两处各写一份。

import { WISH_COIN_KEYS } from "../../../shared/types";

export { WISH_COIN_KEYS };

/**
 * 「最近祈愿结果」可见条数上限（Q3 定稿）。
 * 独立于 `HISTORY_VISIBLE=50`，在 I8 之内取前 20 条。
 */
export const WISH_RECENT_VISIBLE = 20;

/**
 * 帧差分时间窗容差系数（W4 定稿）：`toleranceSec = FACTOR × pollIntervalSeconds`。
 *
 * 差分窗口的 `before` / `after` 两帧来自 save 轮询（默认 5s 间隔），而祈愿事件
 * 的 wallTime 来自 acquire 高频轮询 —— 两者异步。容差随轮询间隔**动态**放大，
 * **不要硬编码 7.5**；调用方（main）从 `config.pollIntervalSeconds` 计算。
 */
export const WISH_DIFF_TOLERANCE_FACTOR = 1.5;

/**
 * 硬币品质阶梯（**fallback**）。
 *
 * 权威来源是 `lookup_items.json` 的 `LookupItem.grade`（W6 定稿）；此表仅在
 * lookup miss（例如目录尚未就绪）时兜底，保证 UI 不因缺 catalog 而丢品质。
 * 真实数据核验：160001 COMMON → 160010 COSMIC 一一对应。
 */
export const WISH_COIN_GRADE_FALLBACK: Readonly<Record<number, string>> = {
  160001: "COMMON",
  160002: "UNCOMMON",
  160003: "RARE",
  160004: "LEGENDARY",
  160005: "IMMORTAL",
  160006: "ARCANA",
  160007: "BEYOND",
  160008: "CELESTIAL",
  160009: "DIVINE",
  160010: "COSMIC",
};
