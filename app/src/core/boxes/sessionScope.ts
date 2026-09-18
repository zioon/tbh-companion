// Pure: session-scoped chest-holdings filtering (v1.2.4 act ghost entries).
// No electron / node / fs — keep unit-testable.
//
// 背景（2026-09-18 实测，游戏 v1.2.4）：v1.2.2 起未开箱子以 STAGEBOX 普通物品
// 形式存在于 itemSaveDatas，其中 act（章节 Boss 箱，930901）的 UniqueId 既不进
// BoxBucketGetBoxList 也不进 BoxBucketUseBoxList。游戏在升级到 v1.2.4 加载存档
// 时**没有恢复**会话开始前已存在的 act 条目（游戏内宝箱面板显示 0），但这些
// 条目永远残留在 itemSaveDatas 中——companion 按「不在已开桶即持有」规则会把
// 它们全部计入，导致 Chests 页 act 槽位卡数量偏高、BoxTimer 队列出现永不开启
// 的幽灵条目。
//
// 不变量（v1.2.4 实证）：**凡游戏会话开始时就已存在于存档的 act 条目，游戏内
// 必然不可见**（common/rare 走 GetBoxList 恢复，不受影响；plagueAct 暂无数据、
// 暂不过滤）。据此按「游戏会话作用域」计数 act 持有：只有本会话内首次出现的
// act 条目才计入。
//
// 权衡：该规则在「act 箱跨游戏重启保留」的世界里会在每次游戏重启后短暂少计
// （直到下一次 act 掉落）；在「重启丢失」的世界里（v1.2.4 当前行为）自动自愈
// 幽灵条目。首次启用本过滤时的存量条目一律视为遗留（保守排除，见
// LEGACY_SESSION_ID）。

import type { ChestHolding } from "../../../shared/types";

/** Persisted state shape (main layer stores this as JSON in userData). */
export interface SessionScopeState {
  version: 1;
  /** Current game-session id. Empty string = 首次运行（尚无任何观测）。 */
  sessionId: string;
  /** Last observed save mtime (seconds), for game-restart gap detection. */
  lastSaveMtime: number;
  /** Last observed game version string, e.g. "1.2.4" (upgrade ⇒ new session). */
  lastGameVersion: string;
  /**
   * Last observed game-session anchor (seconds; the mtime of a game-start-only
   * artifact — see `gameAnchorMtimeSec` in ChestService). `undefined` marks a
   * state written before this field existed (v1.24.1 and earlier): such a state
   * cannot prove the current game session is the one it tracked, so the first
   * parse after the upgrade forces a boundary (conservative). `0` = the anchor
   * files were unavailable; the gap heuristic is then the only signal.
   */
  lastGameAnchor?: number;
  /** act chest UniqueId → sessionId it was first seen in. */
  act: Record<string, string>;
}

/** Sentinel sessionId for entries first seen before filtering was enabled. */
export const LEGACY_SESSION_ID = "legacy";

/** Save mtime gap (seconds) that implies the game was closed and restarted. */
export const SESSION_GAP_SEC = 30 * 60;

/** Hard cap on the act uid map (defensive; pruned entries are all stale). */
const ACT_MAP_CAP = 256;

export function emptySessionScopeState(): SessionScopeState {
  return { version: 1, sessionId: "", lastSaveMtime: 0, lastGameVersion: "", act: {} };
}

/**
 * Extract the game version from the decrypted save text. The version lives in
 * the embedded PlayerSaveData JSON string (`"version":"1.2.4"`), which may be
 * escaped inside the outer document — allow optional backslash escapes and
 * take the first match only (the PlayerSaveData-level field appears first;
 * nested `EnchantVersion` etc. are not bare "version" keys).
 */
export function extractGameVersion(text: string): string {
  const m = /\\?"version\\?"\s*:\s*\\?"(\d+(?:\.\d+){0,3})\\?"/.exec(text);
  return m?.[1] ?? "";
}

/**
 * Decide the sessionId for this save parse.
 *
 * A new game session starts when (first match wins):
 *   1. the game version changed between parses (upgrade restart), or
 *   2. the save mtime went backwards (save restore / path switch), or
 *   3. the gap since the previous save exceeds SESSION_GAP_SEC (the game only
 *      writes the save while running, so a long gap ⇒ game was closed).
 * The very first parse (empty state) starts session "s1" WITHOUT a boundary —
 * entries seen on it are recorded under the legacy sentinel and excluded (see
 * {@link applySessionScope}), because their provenance (pre- or post-restart)
 * is unknowable.
 *
 * Returns the id plus whether a boundary was detected (for logging).
 */
export type SessionBoundary =
  | "none"
  | "version"
  | "anchor"
  | "anchor-unknown"
  | "regress"
  | "gap"
  | "first";

export function deriveSession(
  state: SessionScopeState,
  mtime: number,
  gameVersion: string,
  gameAnchor: number | null = null,
): { sessionId: string; boundary: SessionBoundary } {
  if (!state.sessionId) {
    return { sessionId: "s1", boundary: "first" };
  }
  if (gameVersion && state.lastGameVersion && gameVersion !== state.lastGameVersion) {
    return { sessionId: nextId(state.sessionId), boundary: "version" };
  }
  // Game-session anchor — the mtime of an artifact the game only rewrites at
  // startup (Unity rotates Player.log at every launch). This is the ONLY signal
  // that catches a quick relaunch: the game writes a save within seconds of
  // loading, so the observable save gap is just the downtime (2026-09-19 live:
  // a 25 min relaunch slipped under the 30 min gap threshold and 10 pre-restart
  // act entries stayed counted). A state written before this field existed
  // (v1.24.1) cannot prove it tracks the current session ⇒ one forced boundary.
  if (gameAnchor != null) {
    if (typeof state.lastGameAnchor !== "number") {
      return { sessionId: nextId(state.sessionId), boundary: "anchor-unknown" };
    }
    if (state.lastGameAnchor > 0 && Math.abs(gameAnchor - state.lastGameAnchor) > 1) {
      return { sessionId: nextId(state.sessionId), boundary: "anchor" };
    }
  }
  if (state.lastSaveMtime > 0 && mtime + 1 < state.lastSaveMtime) {
    return { sessionId: nextId(state.sessionId), boundary: "regress" };
  }
  if (state.lastSaveMtime > 0 && mtime - state.lastSaveMtime > SESSION_GAP_SEC) {
    return { sessionId: nextId(state.sessionId), boundary: "gap" };
  }
  return { sessionId: state.sessionId, boundary: "none" };
}

/** "s12" → "s13"; tolerate non-canonical ids by appending a counter suffix. */
function nextId(id: string): string {
  const m = /^s(\d+)$/.exec(id);
  return m ? `s${Number(m[1]!) + 1}` : `${id}+`;
}

export interface SessionScopeDecision {
  /** Holdings after filtering — feed these into buildChestState. */
  chests: ChestHolding[];
  /** Next state to persist (mutated copy; input is never modified). */
  state: SessionScopeState;
  /** Uids excluded this pass (act ghost entries), for logging/UI. */
  excludedActUids: string[];
  /** True when the act uid map gained or lost entries this pass. */
  actMapChanged: boolean;
}

/**
 * Apply the session-scope rule to chest holdings.
 *
 * - Holdings of categories other than "act" always pass through.
 * - "act" holdings WITHOUT a uniqueId (legacy BoxData path) pass through —
 *   the filter is only defined for the v1.2.2+ per-instance path.
 * - "act" holdings with a uniqueId are kept only when they were first seen
 *   in the CURRENT session. On the very first parse after enabling the filter
 *   (empty state), pre-existing entries are recorded under the legacy sentinel
 *   and excluded — their provenance is unknowable and the v1.2.4 reality is
 *   that they are ghosts.
 */
export function applySessionScope(
  chests: ChestHolding[],
  prevState: SessionScopeState,
  sessionId: string,
): SessionScopeDecision {
  const state: SessionScopeState = {
    ...prevState,
    act: { ...prevState.act },
  };
  const isFirstRun = !prevState.sessionId;
  const chestsOut: ChestHolding[] = [];
  const excludedActUids: string[] = [];
  let actMapChanged = false;

  for (const c of chests) {
    if (c.category !== "act" || c.uniqueId == null || c.uniqueId === "") {
      chestsOut.push(c);
      continue;
    }
    const uid = c.uniqueId;
    const seenIn = state.act[uid];
    if (seenIn === undefined) {
      // First observation of this uid. On the very first run of the filter,
      // pre-existing entries have unknowable provenance — record them under
      // the legacy sentinel so they are excluded (conservative).
      state.act[uid] = isFirstRun ? LEGACY_SESSION_ID : sessionId;
      actMapChanged = true;
      if (isFirstRun) {
        excludedActUids.push(uid);
        continue;
      }
      chestsOut.push(c);
      continue;
    }
    if (seenIn !== sessionId) {
      // Present in the save before the current game session started — the
      // game did not restore it (ghost). Exclude.
      excludedActUids.push(uid);
      continue;
    }
    chestsOut.push(c);
  }

  // Prune the uid map when over cap: stale sessions first (they are excluded
  // anyway and can never return — uids are unique), then oldest-inserted.
  const keys = Object.keys(state.act);
  const excess = keys.length - ACT_MAP_CAP;
  if (excess > 0) {
    let removed = 0;
    for (const k of keys) {
      if (removed >= excess) break;
      if (state.act[k] !== sessionId) {
        delete state.act[k];
        removed++;
        actMapChanged = true;
      }
    }
    for (const k of keys) {
      if (removed >= excess) break;
      if (state.act[k] === sessionId) {
        delete state.act[k];
        removed++;
        actMapChanged = true;
      }
    }
  }

  return { chests: chestsOut, state, excludedActUids, actMapChanged };
}

/**
 * Post-parse state update (mtime/version bookkeeping). Split from
 * {@link applySessionScope} so callers can persist once per save with the
 * final values.
 */
export function noteSessionSave(
  state: SessionScopeState,
  mtime: number,
  gameVersion: string,
  gameAnchor: number | null = null,
): SessionScopeState {
  return {
    ...state,
    lastSaveMtime: mtime,
    lastGameVersion: gameVersion || state.lastGameVersion,
    // Adopt a newly visible anchor; keep the stored one when the anchor files
    // are unavailable this pass (a transient stat failure must not later look
    // like a restart).
    lastGameAnchor: gameAnchor ?? state.lastGameAnchor ?? 0,
  };
}
