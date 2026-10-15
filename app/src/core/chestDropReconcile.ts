// Reconcile chest DROPS against the game's own "获得记录" ring.
//
// WHY THIS EXISTS
// The live drop channel tails `GetBoxLog` — the bucket the game appends a chest
// entry to when a chest drops on the map. Measured 2026-10-15 over a 23.9 min
// window: the ring recorded 11 chest grants (5 rare + 6 common) while the live
// channel recorded only 6 (3 + 3) — a 45 % loss. Two causes, and this module
// addresses neither directly:
//
//   1. `readRuntimeChestLog`'s shrink branch (`runtime.ts`) realigns the tail on
//      a shrinking list and returns `drops: []`. A `GetBox` entry appended and
//      evicted inside one sampling window leaves NO trace — there is nothing
//      downstream to repair. `pollChestTailFast` (5 ms) narrows that window but
//      cannot close it.
//   2. The designed compensation for a missed live drop is the save-slot
//      reconcile (`reconcileWithChestSlots`), which needs `player.boxData`.
//      That trio is not derivable on v1.2.8 (measured: `chestSlots` status
//      fails every tick with "offset = 0 (not derived)"), so the compensation
//      never runs and `MAX_ENRICHMENT_ATTEMPTS = 1` is already spent, meaning it
//      never will without a game change.
//
// What is available is the "获得记录" ring: the SAME event written to an
// independent ~2000-slot ring, read on its own ~10 ms polling path
// (`pollAcquireTailFast`), which is not gated on the GetBox list's length or
// eviction state. It is a sound ground truth for "a chest landed" — measured
// 100 % coverage of the live channel's own hits, i.e. it is a strict superset.
//
// WHAT THIS DOES (AND DOES NOT) DO
// - Returns the grants the drop tracker never accounted for so the caller can
//   record them. Counting is a MULTISET difference, never a per-minute tally:
//   the ring and the tracker legitimately disagree on how many boxes land in a
//   given minute, and a bucketed comparison invents losses.
// - NEVER rewrites `record_log.json` — the record page stays a faithful mirror
//   of the game's own UI. Statistics-side repair only.
// - NEVER invents a level. A grant that cannot be attributed to a stage stays
//   category-only; an unattributable grant is reported, not guessed.
//
// IDEMPOTENCE
// `ringSeq` is the ring's own monotonic index and is stable within a game
// session, so the caller can dedupe by it. When the ring restarts (new game
// session) indices repeat — the caller must combine `ringSeq` with a session
// discriminator, exactly as `ingestAcquireBatch` does via `ringRestarted`.
//
// Pure and stateless: no Electron / fs / React, so it is unit-testable over
// synthetic inputs.

import type { ChestDropCategory } from "../../shared/types";

/** The game's acquire prefix for a granted item ("获得了…"). */
const ACQUIRE_PREFIX = "获得了";

/** The game's stage-clear prefix ("通关了关卡 3-10。(4秒)"). */
const CLEAR_PREFIX = "通关了";

/** Extracts "3-10" from a clear line's "关卡 3-10" fragment. */
const STAGE_LABEL_RE = /关卡\s*(\d+)-(\d+)/;

/**
 * A ring line naming a chest. The drop notices read "获得了普通宝箱。(死亡之指)"
 * — the CHEST landing in the player's slots — and are exactly the events this
 * module exists to count. Structural gate only (the game's own wording), with
 * the localized nouns listed per language.
 */
const CHEST_LINE_RE = /宝箱|寶箱|[Cc]hest/;

/**
 * Category per localized chest noun, keyed by the noun alone.
 *
 * `stageBoss` is the "关卡宝箱" (stage-boss chest) noun — the one the user-facing
 * bug report is about. `actBoss` is "章节首领宝箱". `common` is "普通宝箱".
 *
 * Order matters: the act-boss noun contains the stage-boss noun as a substring
 * in some localizations, so the longer, more specific key is probed first.
 */
const CHEST_NOUN_CATEGORY: ReadonlyArray<readonly [string, ChestDropCategory]> = [
  ["章节首领宝箱", "act"],
  ["章節首領寶箱", "act"],
  ["Act Boss Chest", "act"],
  ["ActBoss Chest", "act"],
  ["关卡宝箱", "rare"],
  ["關卡寶箱", "rare"],
  ["Stage Boss Chest", "rare"],
  ["StageBoss Chest", "rare"],
  ["普通宝箱", "common"],
  ["普通寶箱", "common"],
  ["Normal Monster Box", "common"],
  ["Normal Chest", "common"],
];

/** Default attribution window, in seconds. */
export const DROP_RECONCILE_WINDOW_SEC = 180;

/**
 * A ring line that grants a chest, as this module needs it.
 *
 * Deliberately a structural subset rather than the whole `RecordLogEntry` so
 * the tests can build inputs without the shared-type surface, and so the caller
 * can pass an already-narrowed projection.
 */
export interface DropGrantLine {
  /** Ring index — stable identity within a game session, used for dedupe. */
  ringSeq: number;
  /** Ingest/arrival wall-clock seconds. */
  wallTime: number;
  /** Parsed display name (rich text stripped), e.g. "关卡宝箱". */
  acquireName: string;
  /** Raw message, used for the prefix gates. */
  acquireRaw: string;
  /** `true` for an initial-attach replay whose wallTime is not the event time. */
  bulk: boolean;
}

/** A drop the tracker already recorded, as this module needs it. */
export interface RecordedDrop {
  wallTime: number;
  category: ChestDropCategory;
  /** StageKey the drop was stamped with, when known. */
  stageKey?: number;
}

/** One stage-clear event, used to recover the stage a grant landed on. */
export interface DropClearEvent {
  wallTime: number;
  /** Fully resolved stageKey when known (includes difficulty). */
  stageKey?: number;
}

/** One chest drop the caller wants recorded. */
export interface MissedChestDrop {
  category: ChestDropCategory;
  /** Ingest wall-clock seconds. */
  wallTime: number;
  /**
   * StageKey recovered from the nearest clear, when one resolved. Undefined
   * leaves the entry category-only — never a guessed key.
   */
  stageKey?: number;
  /** The ring index this recovery came from; the caller's dedupe handle. */
  ringSeq: number;
}

export interface DropReconcileOptions {
  /**
   * How close (seconds) a recorded drop must be to a grant for the grant to
   * count as already accounted for. Must exceed the live channel's end-to-end
   * lag (burst settle + aggregator gap) or a drop recorded late looks missing
   * and gets double-counted. Default {@link DROP_RECONCILE_WINDOW_SEC}.
   */
  windowSec?: number;
  /** Recent stage-clear events, used to recover `stageKey`. */
  clears?: readonly DropClearEvent[];
  /**
   * Skip grants older than this many seconds. Bounds the scan and stops an
   * initial-attach replay from being reconciled. Default: no bound (the caller
   * filters `bulk` lines instead, which is the authoritative replay marker).
   */
  maxAgeSec?: number;
  /** `nowSec` — injectable so tests are clock-independent. */
  nowSec: number;
}

export interface DropReconcileResult {
  /** Grants the tracker never accounted for, chronological. Record these. */
  missed: MissedChestDrop[];
  /** Grant lines examined. */
  scanned: number;
  /** Grants matched to a recorded drop. */
  alreadyTracked: number;
  /** Lines skipped as non-chest-grants (clears, replay, other prefixes). */
  excluded: number;
}

/**
 * Find the chest grants the drop tracker never recorded.
 *
 * Matching discipline:
 *   1. Non-chest lines are excluded up front — bulk replays (their wallTime is
 *      the ingest moment, not the event moment, so any time match is fiction),
 *      stage clears (a distinct prefix), and anything not carrying a known
 *      chest noun.
 *   2. A grant is "already tracked" when a recorded drop of the SAME category
 *      sits within `windowSec`. Per-category, not per-total: the two channels
 *      routinely disagree on how many of each kind landed in a minute, so only
 *      a like-for-like comparison can distinguish a real loss from a
 *      redistribution.
 *   3. `stageKey` is recovered from the nearest clear that resolves, so the
 *      recorded entry can carry the level instead of staying category-only.
 *      Failure leaves it undefined — a wrong stage is worse than none.
 *
 * Idempotent: re-running after recording `missed` yields none, because step 2
 * then finds them.
 */
export function reconcileChestDropsFromRing(
  grants: readonly DropGrantLine[],
  recorded: readonly RecordedDrop[],
  options: DropReconcileOptions,
): DropReconcileResult {
  const { windowSec = DROP_RECONCILE_WINDOW_SEC, clears = [], nowSec } = options;
  const result: DropReconcileResult = {
    missed: [],
    scanned: 0,
    alreadyTracked: 0,
    excluded: 0,
  };

  // Working copies of the recorded drops, bucketed per category so each
  // category's matches can never consume another's allowance. Copies matter:
  // `consumeRecorded` blanks a slot it claims, and the caller's arrays are its
  // live tracker state.
  const byCategory = new Map<ChestDropCategory, (RecordedDrop | null)[]>();
  for (const d of recorded) {
    if (!Number.isFinite(d.wallTime)) continue;
    const list = byCategory.get(d.category);
    if (list) list.push(d);
    else byCategory.set(d.category, [d]);
  }
  // Sorted for a predictable scan order; the per-category lists are tiny, so
  // `consumeRecorded` scans linearly rather than binary-searching.
  for (const list of byCategory.values()) list.sort((a, b) => a!.wallTime - b!.wallTime);

  const clearPool = [...clears]
    .filter((c) => Number.isFinite(c.wallTime) && typeof c.stageKey === "number")
    .sort((a, b) => a.wallTime - b.wallTime);

  const minAge = options.maxAgeSec != null ? nowSec - options.maxAgeSec : null;

  const chestGrants = grants
    .filter((g) => {
      if (!isChestGrant(g)) {
        if (Number.isFinite(g.wallTime)) result.excluded += 1;
        return false;
      }
      if (minAge != null && g.wallTime < minAge) {
        result.excluded += 1;
        return false;
      }
      return true;
    })
    .sort((a, b) => a.wallTime - b.wallTime || a.ringSeq - b.ringSeq);

  for (const grant of chestGrants) {
    result.scanned += 1;
    const category =
      categoryOfChestName(grant.acquireName) ?? categoryOfChestName(grant.acquireRaw);
    // `isChestGrant` already proved one of the two yields a category; the
    // non-null assertion is safe and keeps the narrowing explicit.
    if (category == null) {
      result.excluded += 1;
      continue;
    }

    if (consumeRecorded(byCategory.get(category), grant.wallTime, windowSec)) {
      result.alreadyTracked += 1;
      continue;
    }

    const stageKey = nearestStageKey(clearPool, grant.wallTime, windowSec);
    result.missed.push({ category, wallTime: grant.wallTime, stageKey, ringSeq: grant.ringSeq });
  }

  return result;
}

/**
 * Whether a ring line grants a chest, i.e. it is the drop notice itself.
 *
 * Excluded structurally, never by item-name guessing:
 *   - bulk replays: `wallTime` is the ingest moment, so any time match against
 *     a recorded drop would be fiction;
 *   - the game's own stage clears: a distinct prefix, and they are the stage
 *     evidence this module reads separately.
 *
 * The chest noun list IS a name list, which this codebase otherwise avoids for
 * content rows — but here it is the *subject* of the line rather than a content
 * item, and the fallback is deliberately conservative: an unrecognized noun
 * yields `excluded`, so an unknown localisation under-counts rather than
 * inventing drops. That is the safe direction for a statistics repair.
 */
function isChestGrant(g: DropGrantLine): boolean {
  if (g.bulk) return false;
  if (!Number.isFinite(g.wallTime)) return false;
  const raw = g.acquireRaw ?? "";
  if (!raw.startsWith(ACQUIRE_PREFIX)) return false;
  if (raw.startsWith(CLEAR_PREFIX)) return false;
  const name = (g.acquireName ?? "").trim();
  if (!name) return false;
  if (STAGE_LABEL_RE.test(raw) || STAGE_LABEL_RE.test(name)) return false;
  if (!CHEST_LINE_RE.test(name) && !CHEST_LINE_RE.test(raw)) return false;
  return categoryOfChestName(name) != null || categoryOfChestName(raw) != null;
}

/** Map a chest noun to its drop category, or null when unrecognized. */
function categoryOfChestName(text: string): ChestDropCategory | null {
  if (!text) return null;
  for (const [noun, category] of CHEST_NOUN_CATEGORY) {
    if (text.includes(noun)) return category;
  }
  return null;
}

/**
 * Consume one recorded drop of this category within `windowSec`, if any.
 *
 * Consumption is what makes this a multiset difference: two grants of the same
 * category need two recorded drops, and a recorded drop covers exactly one
 * grant. Returns whether a match was found.
 */
function consumeRecorded(
  list: (RecordedDrop | null)[] | undefined,
  t: number,
  windowSec: number,
): boolean {
  if (!list || list.length === 0) return false;
  const min = t - windowSec;
  // Linear scan, not a binary search: a claimed slot is nulled in place, so the
  // array is no longer sorted by `wallTime` and a binary search can land on a
  // hole (`list[mid]!.wallTime` on null). The per-category lists are tiny (one
  // entry per drop inside the window), so the scan is the cheaper correct
  // choice — nearest-first match also keeps the ordering deterministic.
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e == null) continue;
    if (e.wallTime < min || e.wallTime > t + windowSec) continue;
    const dist = Math.abs(e.wallTime - t);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  if (best < 0) return false;
  // Claim it so a later grant cannot match the same drop.
  list[best] = null;
  return true;
}

/** Nearest clear with a usable stageKey within ±`windowSec` of `t`. */
function nearestStageKey(
  clearPool: readonly DropClearEvent[],
  t: number,
  windowSec: number,
): number | undefined {
  if (clearPool.length === 0) return undefined;
  const min = t - windowSec;
  let lo = 0;
  let hi = clearPool.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clearPool[mid]!.wallTime < min) lo = mid + 1;
    else hi = mid;
  }
  let best: { dist: number; stageKey: number } | null = null;
  for (let i = lo; i < clearPool.length && clearPool[i]!.wallTime <= t + windowSec; i++) {
    const e = clearPool[i]!;
    if (typeof e.stageKey !== "number" || !Number.isFinite(e.stageKey) || e.stageKey <= 0) {
      continue;
    }
    const dist = Math.abs(e.wallTime - t);
    if (best === null || dist < best.dist) best = { dist, stageKey: e.stageKey };
  }
  return best?.stageKey;
}
