// Backfill for box-open statistics from the game's own "获得记录" ring log.
//
// WHY THIS EXISTS
// The box-open reader (`readRuntimeBoxOpenLog`) tails `GetItemWithBoxOpen` —
// the bucket the game writes when a chest's contents are granted. That reader
// is inherently racy: the game bumps the list length first and then commits
// each slot's `itemKey` (a string reference, committed LAST), so slots scanned
// mid-write get parked and eventually force-skipped. `BOX_OPEN_OVERSCAN` (64)
// plus `MAX_BOX_OPEN_LOG_RETRIES` (6) absorb the common cases, but a large
// one-shot "open all" burst, an offset-drift window, or a worker restart can
// still drop entries. The result is a Loot tab that under-counts: items that
// were genuinely opened never appear.
//
// The "获得记录" ring is an INDEPENDENT channel for exactly the same events: the
// game appends one line per granted item ("获得了<color=#D7D7D7>永恒之剑</color>。")
// to a separate 2000-slot ring that the companion reads on its own ~10 ms
// polling path (`pollAcquireTailFast`), which is NOT gated on the box-open
// bucket's mid-write state. Measured on 2026-09-16, the two channels agree to
// within 64 ms and every one of the 30 most recent open-result lines in the
// log was present in the tracker — so the log is a sound, higher-availability
// second source for the same ground truth.
//
// WHAT THIS DOES (AND DOES NOT) DO
// - It reconciles the two sources and reports the log lines that no tracker
//   entry accounts for, so the caller can record them and stop under-counting.
// - It NEVER rewrites `record_log.json`: the record page stays a faithful
//   mirror of the game's own UI. This is a statistics-side repair only.
// - It CANNOT recover the source box: a ring line names the item and its
//   quality colour but says nothing about which chest produced it. Lines are
//   therefore attributed by the same evidence the record page's source fit
//   uses — the nearest GetBox drop / open event in time — and fall back to
//   `UNCLASSIFIED_BOX_KEY` when nothing supports a specific box. Guessing a
//   level would corrupt per-box drop rates, so we refuse to guess.
//
// Pure and stateless: no Electron / fs / React, so it is unit-testable over
// synthetic inputs.

import type { BoxOpenHistoryEntry, RecordLogEntry } from "../../shared/types";

/** Default attribution window — matches the record page's source fit. */
export const BACKFILL_WINDOW_SEC = 8;

/** The game's acquire line template for a granted item. */
const ACQUIRE_PREFIX = "获得了";

/**
 * A ring line naming a chest itself (the drop notice) rather than its
 * contents. `获得了普通宝箱。(死亡之指)` is a GetBox notice — the chest item
 * landing in the player's box slots — and must never be mistaken for an
 * opened item. Matches the gate used by `recordLogFit.ts` pass 2.
 */
const CHEST_LINE_RE = /宝箱|[Cc]hest/;

/** The game's stage-clear line template ("通关了关卡 3-10。(4秒)"). */
const CLEAR_PREFIX = "通关了";

/** Existing tracker entry, reduced to what attribution needs. */
export interface BackfillTrackerEntry {
  wallTime: number;
  boxKey: string;
  itemName: string;
  grade: string | null;
  count: number;
}

/** A GetBox chest-drop event (the chest landing, not its contents). */
export interface BackfillChestEvent {
  wallTime: number;
  category: string;
}

/** One log line the tracker never accounted for, ready to be recorded. */
export interface BackfillCandidate {
  /** Ring index of the source line — stable identity, used for dedupe downstream. */
  ringSeq?: number;
  /** Event time: the tracker's own clock, so it lines up with recorded entries. */
  wallTime: number;
  /** Attributed box, or `UNCLASSIFIED_BOX_KEY` when no evidence supported one. */
  boxKey: string;
  /** Display name from the log line. */
  itemName: string;
  /** Qualified colour from the log line (e.g. "#D7D7D7"), for grade fallback. */
  color: string | null;
  /** Occurrences on the line ("×3" → 3); 1 when absent. */
  count: number;
}

export interface BackfillResult {
  /** Log lines with no tracker counterpart — record these to close the gap. */
  candidates: BackfillCandidate[];
  /** Diagnostics for the log line; how many lines were examined/excluded. */
  scanned: number;
  /** Lines skipped because the tracker already has them (matched by name+time). */
  alreadyTracked: number;
  /** Lines skipped as non-grants (chest notices, clears, gold/xp, bulk replays). */
  excluded: number;
  /**
   * Lines that looked like grants but whose time sat outside the window of
   * every tracker entry — recorded as unclassified unless `allowUnclassified`
   * is false. Reported separately so an unexpectedly large number (a clock
   * skew or a stalled channel) is visible rather than swallowed.
   */
  unattributed: number;
}

export interface BackfillOptions {
  /**
   * Attribute an unmatched grant to the nearest `open` tracker entry in time,
   * borrowing its boxKey. When the tracker dropped an entry the log kept, its
   * siblings from the same chest are usually still present — their boxKey is
   * the best evidence available. Default true.
   */
  attributeFromOpenEntries?: boolean;
  /**
   * Emit unmatched grants as `unclassified` when no box evidence exists.
   * Default true — the point of the feature is to stop losing items; they land
   * in the queue the user already reviews. Setting false makes the pass
   * report-only.
   */
  allowUnclassified?: boolean;
  /** Attribution window in seconds. Default {@link BACKFILL_WINDOW_SEC}. */
  windowSec?: number;
}

/**
 * Reconcile the acquire ring log against the box-open tracker and return the
 * opened-item lines the tracker never recorded.
 *
 * Matching discipline (mirrors `recordLogFit.ts`, so the backfill agrees with
 * what the record page displays):
 *   1. Non-grant lines are excluded up front — chest notices (the drop, not its
 *      contents), stage clears, bulk initial-attach replays (their `wallTime`
 *      is the ingest moment, not the event moment, so any time match is
 *      fiction), and materials/currency that do not come from chests.
 *   2. A line is "already tracked" when a tracker entry within `windowSec`
 *      carries the same item name and still has unclaimed count. Consumption is
 *      count-aware, so one entry of count 3 covers a "×3" line, and three
 *      separate lines consume three units — exactly the semantics the record
 *      page uses.
 *   3. Surviving lines are attributed to the nearest `open` entry in time and
 *      borrow its boxKey. This is how a partially-lost burst is repaired: the
 *      sibling entries that DID arrive carry the box identity.
 *   4. Attribution falls back to the nearest GetBox drop's category.
 *   5. With no evidence at all the line becomes `unclassified` (or is dropped
 *      when `allowUnclassified` is false). A level is never invented.
 *
 * Idempotent: running it again after recording the candidates yields none,
 * because step 2 then finds them.
 */
export function backfillOpensFromLog(
  logEntries: readonly RecordLogEntry[],
  trackerEntries: readonly BackfillTrackerEntry[],
  chestEvents: readonly BackfillChestEvent[] = [],
  options: BackfillOptions = {},
): BackfillResult {
  const {
    attributeFromOpenEntries = true,
    allowUnclassified = true,
    windowSec = BACKFILL_WINDOW_SEC,
  } = options;

  const result: BackfillResult = {
    candidates: [],
    scanned: 0,
    alreadyTracked: 0,
    excluded: 0,
    unattributed: 0,
  };
  if (logEntries.length === 0) return result;

  // Working copies of the tracker's evidence, sorted for binary search and
  // carrying claim state so each entry explains at most its own units.
  const openPool = trackerEntries
    .filter((e) => Number.isFinite(e.wallTime))
    .map((e) => ({ ...e, remaining: Math.max(1, Math.floor(e.count || 1)) }))
    .sort((a, b) => a.wallTime - b.wallTime);
  const chestPool = [...chestEvents]
    .filter((e) => Number.isFinite(e.wallTime))
    .sort((a, b) => a.wallTime - b.wallTime);

  // Chronological, and by ring index to break ties deterministically.
  const grants = logEntries
    .filter((e) => {
      if (isOpenGrant(e)) return true;
      // Only count real ring lines as "excluded" — a non-acquire entry (a
      // legacy drop/open/clear row in an old archive) is not a line this pass
      // ever considers, and inflating the counter with those would make the
      // diagnostic meaningless.
      if (e.kind === "acquire") result.excluded += 1;
      return false;
    })
    .sort((a, b) => a.wallTime - b.wallTime || (a.ringSeq ?? 0) - (b.ringSeq ?? 0));

  for (const line of grants) {
    result.scanned += 1;
    const name = line.acquireName?.trim() ?? "";
    const count = Math.max(1, Math.floor(line.acquireCount ?? 1));

    // Step 2 — already accounted for by the tracker.
    const known = nearestWithin(
      openPool,
      line.wallTime,
      windowSec,
      (e) => e.remaining > 0 && e.itemName === name,
    );
    if (known) {
      known.event.remaining = Math.max(0, known.event.remaining - count);
      result.alreadyTracked += 1;
      continue;
    }

    // Step 3 — attribute via a nearby tracker entry from the same burst.
    //
    // This deliberately does NOT require unclaimed units. A chest that granted
    // three items typically left two entries in the tracker and lost one; those
    // two are fully consumed by step 2's name matches, yet they remain the best
    // (and only) evidence of which box produced the third. Requiring
    // `remaining > 0` here was the original bug: the survivors had already been
    // claimed by their own lines, so the lost sibling could never be attributed
    // and fell to `unclassified` — discarding exactly the information the
    // backfill exists to recover.
    let boxKey: string | null = null;
    if (attributeFromOpenEntries) {
      const sibling = nearestWithin(openPool, line.wallTime, windowSec, () => true);
      if (sibling) boxKey = sibling.event.boxKey;
    }

    // Step 4 — fall back to the nearest chest drop's category.
    if (boxKey == null && chestPool.length > 0) {
      const drop = nearestWithin(chestPool, line.wallTime, windowSec, () => true);
      if (drop) boxKey = drop.event.category;
    }

    // Step 5 — no evidence: keep the item, refuse to invent a box.
    if (boxKey == null) {
      result.unattributed += 1;
      if (!allowUnclassified) continue;
      boxKey = UNCLASSIFIED;
    }

    result.candidates.push({
      ringSeq: line.ringSeq,
      // Prefer the tracker's event clock. The ring's own stamp is a session
      // clock the game rewrites on reuse (measured 2026-09-15) and, on a
      // replayed line, `wallTime` is the ingest moment — neither is trustworthy
      // as an event time, so the newest sibling evidence wins.
      wallTime: line.wallTime,
      boxKey,
      itemName: name,
      color: line.acquireColor ?? null,
      count,
    });
  }

  return result;
}

/** `UNCLASSIFIED_BOX_KEY` inlined — importing it would drag in `boxOpenLog`. */
const UNCLASSIFIED = "unclassified";

/**
 * Whether a log line describes an opened chest's contents.
 *
 * The three things that share the ring but are NOT opens are excluded
 * structurally — by their own text shape, not by guessing at item names:
 *  - bulk replays: their `wallTime` is the ingest moment, so any time match
 *    against the tracker would be fiction;
 *  - the game's own notices (stage clears, hero defeats): distinct prefixes;
 *  - chest DROP notices ("获得了普通宝箱。(死亡之指)"): the chest item itself,
 *    whose contents arrive as separate lines later. Counting the chest as its
 *    own loot would inflate every chest by one item.
 *
 * Deliberately NOT excluded: materials and currency by name. A blanket name
 * list cannot be right — the same suffix appears on real chest loot (and the
 * list would silently drop genuine grants, i.e. exactly the bug being fixed).
 * A stray material line can only be misattributed if it lands within the
 * window of a real chest event, and even then it is recorded under that box's
 * category — a bounded imprecision, whereas a name list causes data loss.
 */
function isOpenGrant(e: RecordLogEntry): boolean {
  if (e.kind !== "acquire") return false;
  if (e.bulk) return false;
  const raw = e.acquireRaw ?? "";
  if (!raw.startsWith(ACQUIRE_PREFIX)) return false;
  if (raw.startsWith(CLEAR_PREFIX)) return false;
  const name = e.acquireName?.trim() ?? "";
  if (!name) return false;
  if (CHEST_LINE_RE.test(name)) return false;
  if (!Number.isFinite(e.wallTime)) return false;
  return true;
}

/**
 * Nearest usable event within ±`windowSec` of `t` over a time-sorted array.
 * Binary-searches the window start, then scans forward while inside the
 * window — O(log n + k) per call. Mirrors `recordLogFit.nearestWithin` so the
 * two passes select the same events for the same line.
 */
function nearestWithin<T extends { wallTime: number }>(
  events: readonly T[],
  t: number,
  windowSec: number,
  usable: (e: T) => boolean,
): { event: T; dist: number } | null {
  let lo = 0;
  let hi = events.length;
  const min = t - windowSec;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.wallTime < min) lo = mid + 1;
    else hi = mid;
  }
  let best: { event: T; dist: number } | null = null;
  for (let i = lo; i < events.length && events[i]!.wallTime <= t + windowSec; i++) {
    const e = events[i]!;
    if (!usable(e)) continue;
    const dist = Math.abs(e.wallTime - t);
    if (best === null || dist < best.dist) best = { event: e, dist };
  }
  return best;
}

/** Narrow a tracker history entry to the attribution input shape. */
export function toBackfillTrackerEntry(e: BoxOpenHistoryEntry): BackfillTrackerEntry {
  return {
    wallTime: e.wallTime,
    boxKey: e.boxKey,
    itemName: e.itemName,
    grade: e.grade,
    count: e.count,
  };
}
