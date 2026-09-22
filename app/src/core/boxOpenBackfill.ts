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
// - It CANNOT recover the source box's IDENTITY: a ring line names the item and
//   its quality colour but says nothing about which chest produced it. The
//   chest's CATEGORY comes from the nearest GetBox drop / open event in time
//   (the same evidence the record page's source fit uses), and its LEVEL is
//   derived from the stage-clear records around the line — see below.
//
// LEVEL FROM STAGE CLEARS
// The ring carries the game's own stage-clear records ("通关了关卡 3-10。(4秒)")
// interleaved with the grants, and the player's farm stage at grant time is
// therefore knowable: the nearest clear line in time. That gives a stageKey,
// and the stage-box catalog maps a stageKey to exactly one level per category
// (`tracker.dropStageKeys` are disjoint per level — verified across all 11
// levels of the COMMON/RARE line), which turns a category-only attribution
// into a levelled one. The clear line itself carries only "act-stage"; the
// difficulty comes from the surrounding clear records (see `clearStageKeys`).
//
// This is NOT guessing: a lookup that misses returns null and leaves the
// attribution exactly where it was (category-only, or `UNCLASSIFIED_BOX_KEY`).
// A guess would corrupt per-box drop rates, so we refuse to guess.
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

/** Extracts "3-10" from the clear line's "关卡 3-10" fragment. */
const STAGE_LABEL_RE = /关卡\s*(\d+)-(\d+)/;

/**
 * Collects the stageKeys the clear records around a line yield, best first.
 *
 * Only the first stageKey can be used (the caller looks one level up), so the
 * order IS the priority: the live clear history first (it carries the fully
 * resolved stageKey, difficulty included), then the clear lines in the ring —
 * which yield act-stage only, so a difficulty has to be borrowed (see
 * {@link levelForStage}). 4 entries is enough to survive the jitter of a
 * stage-clear burst interleaving with the grant lines.
 */
export interface BackfillClearContext {
  /** Resolved stageKeys from the clear history, nearest-first. */
  stageKeys: number[];
  /** "act-stage" labels from the nearby clear lines, nearest-first. */
  stageLabels: string[];
}

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

/** One stage-clear event (the main process's own clear history). */
export interface BackfillClearEvent {
  wallTime: number;
  /** Fully resolved stageKey (the clear history resolves difficulty for us). */
  stageKey?: number;
}

/**
 * One drop route from the stage-box catalog, reduced to what level inference
 * needs. `dropStageKeys` are disjoint per level within a category, so a hit is
 * unambiguous. Plague variants have no routes — see {@link BackfillBoxRoutes}.
 */
export interface BackfillBoxRoute {
  /** Level as encoded in a boxKey (`${category}:${level}`). */
  level: number;
  dropStageKeys: readonly number[];
}

/**
 * Per-category level-inference tables, injected by the caller (core cannot
 * read the bundled catalog).
 */
export interface BackfillBoxRoutes {
  /** `tracker.dropStageKeys` for levelled boxes, keyed by category. */
  byCategory: ReadonlyMap<string, readonly BackfillBoxRoute[]>;
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
  /**
   * Recent stage-clear events (resolved stageKeys), used as the preferred
   * difficulty reference when reading a clear line's "act-stage" label.
   */
  clears?: readonly BackfillClearEvent[];
  /**
   * Per-category drop routes. When provided, a category-only attribution (or
   * a category inferred from context) is upgraded to `${category}:${level}`
   * using the stage-clear evidence around the line. Omit to keep the previous
   * behaviour (category-only / `unclassified`).
   */
  boxRoutes?: BackfillBoxRoutes;
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
 *   5. That category (or a category-only sibling boxKey) is upgraded with a
 *      level derived from the stage-clear records around the line — see the
 *      header. A sibling boxKey that already carries a level is left alone.
 *   6. With no evidence at all the line becomes `unclassified` (or is dropped
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
    clears = [],
    boxRoutes,
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
  const clearPool = [...clears]
    .filter((e) => Number.isFinite(e.wallTime))
    .sort((a, b) => a.wallTime - b.wallTime);

  // Ring lines that ARE stage-clear records. They are excluded from the grants
  // below, but they are the primary evidence for a grant's level: the player
  // was on (at least) that stage when the granted item landed.
  const clearLines = logEntries
    .filter((e) => e.kind === "acquire" && !e.bulk && isClearLine(e))
    .sort((a, b) => a.wallTime - b.wallTime || (a.ringSeq ?? 0) - (b.ringSeq ?? 0));

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

    // The sibling may have identified the box without its level (the tracker
    // records a category-only boxKey when the open reader could not resolve
    // one). That is evidence of the CATEGORY, which is what step 4 would infer
    // anyway — remember it so the level step below can still level the entry.
    let category: string | null = categoryOfBoxKey(boxKey);

    // Step 4 — fall back to the nearest chest drop's category.
    if (boxKey == null && chestPool.length > 0) {
      const drop = nearestWithin(chestPool, line.wallTime, windowSec, () => true);
      if (drop) {
        boxKey = drop.event.category;
        category = categoryOfBoxKey(boxKey);
      }
    }

    // Step 4.5 — level the attribution from the stage-clear records around the
    // line. Only applies when the evidence fixed a category but not a level;
    // a sibling that already carried `${category}:${level}` is authoritative
    // and is never second-guessed. Upgrading to an invented level is what the
    // rest of this file refuses to do — every return below is a catalog hit or
    // nothing at all.
    if (boxRoutes != null && category != null && levelOfBoxKey(boxKey) == null) {
      const level = levelForClearContext(
        line.wallTime,
        category,
        clearPool,
        clearLines,
        windowSec,
        boxRoutes,
      );
      if (level != null) boxKey = `${category}:${level}`;
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

/** Known boxKey categories. Anything else (incl. "unclassified") is not one. */
const BASE_CATEGORIES: ReadonlySet<string> = new Set([
  "common",
  "rare",
  "act",
  "plagueCommon",
  "plagueRare",
  "plagueAct",
]);

/**
 * Whether a ring line is one of the game's stage-clear records
 * ("通关了关卡 3-10。(4秒)") rather than a granted item. The prefix is
 * authoritative — the game writes the clear record into the same ring — so no
 * bucket data is needed. Mirrors `recordLogFit` pass 0, which uses the same
 * gate to label these rows.
 */
function isClearLine(e: RecordLogEntry): boolean {
  const raw = e.acquireRaw ?? "";
  return raw.startsWith(CLEAR_PREFIX) && Number.isFinite(e.wallTime);
}

/** Category part of a boxKey ("rare:40" → "rare"), or null when unrecognized. */
function categoryOfBoxKey(boxKey: string | null): string | null {
  if (boxKey == null) return null;
  const colon = boxKey.indexOf(":");
  const cat = colon > 0 ? boxKey.slice(0, colon) : boxKey;
  return BASE_CATEGORIES.has(cat) ? cat : null;
}

/**
 * Level part of a boxKey ("rare:40" → 40); null when the key is category-only.
 *
 * The category-only keys include `unclassified`, so the category is validated
 * first — otherwise "unclassified" would parse as "a key with no level" and
 * the level step would be allowed to rewrite it into `common:40`, silently
 * upgrading a no-evidence row into a levelled one.
 */
function levelOfBoxKey(boxKey: string | null): number | null {
  if (boxKey == null) return null;
  const colon = boxKey.indexOf(":");
  if (colon <= 0 || !BASE_CATEGORIES.has(boxKey.slice(0, colon))) return null;
  const level = Number(boxKey.slice(colon + 1));
  return Number.isFinite(level) && level > 0 ? Math.trunc(level) : null;
}

/**
 * The stage the player was on when the line at `t` was granted, and the level
 * that stage implies for `category`.
 *
 * Priority (first match wins):
 *   1. The resolved clear history (`clears`), which carries the full stageKey
 *      including difficulty, nearest in time first.
 *   2. The ring's own clear lines, whose "act-stage" label still needs a
 *      difficulty borrowed from a resolved clear — nearest line first.
 *
 * A candidate is only accepted when `levelForStage` resolves it, so a clear
 * line naming a stage that no route drops on falls through to the next one
 * instead of blocking the search. Returns null when nothing resolves, which
 * leaves the caller's attribution untouched (category-only) rather than wrong.
 */
function levelForClearContext(
  t: number,
  category: string,
  clearPool: readonly BackfillClearEvent[],
  clearLines: readonly RecordLogEntry[],
  windowSec: number,
  routes: BackfillBoxRoutes,
): number | null {
  // 1. Resolved clear events, nearest first. `nearestWithin` returns only the
  //    single nearest, so walk the window in distance order manually when it
  //    does not resolve — a nearer clear on a stage with no route must not
  //    veto a slightly older one that does.
  let best: { dist: number; level: number } | null = null;
  for (const event of clearEventsWithin(clearPool, t, windowSec)) {
    if (!isUsableStageKey(event.stageKey)) continue;
    const level = levelForStage(category, event.stageKey!, routes);
    if (level == null) continue;
    const dist = Math.abs(event.wallTime - t);
    if (best === null || dist < best.dist) best = { dist, level };
  }
  if (best) return best.level;

  // 2. Ring clear lines: text-only "act-stage", nearest-first.
  const labels = clearLabelsWithin(clearLines, t, windowSec);
  if (labels.length === 0) return null;

  // Difficulty reference: a resolved clear inside the window if there is one,
  // else any resolved clear we know of. Only the difficulty is taken from it;
  // the clear line supplies the act/stage, so a reference from an older clear
  // is still exact while the player has not changed difficulty.
  const inWindow = clearEventsWithin(clearPool, t, windowSec).find((e) =>
    isUsableStageKey(e.stageKey),
  );
  const reference =
    inWindow?.stageKey ?? clearPool.find((e) => isUsableStageKey(e.stageKey))?.stageKey ?? null;
  const difficulty = reference != null ? Math.trunc(reference / 1000) : 0;
  if (difficulty <= 0) return null;

  for (const { label } of labels) {
    const stageKey = stageKeyFromLabel(label, difficulty);
    if (stageKey == null) continue;
    const level = levelForStage(category, stageKey, routes);
    if (level != null) return level;
  }
  return null;
}

/** Resolved clear events within ±`windowSec` of `t`, nearest first. */
function clearEventsWithin(
  clearPool: readonly BackfillClearEvent[],
  t: number,
  windowSec: number,
): BackfillClearEvent[] {
  if (clearPool.length === 0) return [];
  const out: { event: BackfillClearEvent; dist: number }[] = [];
  let lo = 0;
  let hi = clearPool.length;
  const min = t - windowSec;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clearPool[mid]!.wallTime < min) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < clearPool.length && clearPool[i]!.wallTime <= t + windowSec; i++) {
    out.push({ event: clearPool[i]!, dist: Math.abs(clearPool[i]!.wallTime - t) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.map((o) => o.event);
}

/** "act-stage" labels from the clear lines within ±`windowSec` of `t`, nearest first. */
function clearLabelsWithin(
  clearLines: readonly RecordLogEntry[],
  t: number,
  windowSec: number,
): { label: string; dist: number }[] {
  if (clearLines.length === 0) return [];
  const out: { label: string; dist: number }[] = [];
  let lo = 0;
  let hi = clearLines.length;
  const min = t - windowSec;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clearLines[mid]!.wallTime < min) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < clearLines.length && clearLines[i]!.wallTime <= t + windowSec; i++) {
    const m = STAGE_LABEL_RE.exec(clearLines[i]!.acquireRaw ?? "");
    if (!m) continue;
    out.push({ label: `${m[1]}-${m[2]}`, dist: Math.abs(clearLines[i]!.wallTime - t) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

function isUsableStageKey(key: number | undefined | null): boolean {
  return typeof key === "number" && Number.isFinite(key) && key > 0;
}

/**
 * Compose a stageKey from a clear line's "act-stage" label.
 *
 * The label carries no difficulty, so it is borrowed from a neighbouring
 * resolved clear (`difficultyRef`) — the same contract `resolveClearedStageKey`
 * uses for the live clear path. Plague maps use the 6-digit encoding
 * (`regionBase * 100 + stage`, e.g. 2012 = Nightmare act 21 in the catalog's
 * 2012xx range); regular maps use `difficulty * 1000 + act * 100 + stage`.
 *
 * Returns null for a label outside the known ranges rather than building a
 * stageKey that cannot exist (a guessed level would then be silently wrong).
 */
function stageKeyFromLabel(label: string, difficultyRef: number): number | null {
  // `label` is the bare "3-5" form this module extracts from the clear line,
  // not the full line — so it is parsed directly rather than through
  // STAGE_LABEL_RE (which needs the "关卡" prefix).
  const m = /^(\d+)-(\d+)$/.exec(label);
  if (!m) return null;
  const act = Number(m[1]);
  const stage = Number(m[2]);
  if (!Number.isFinite(act) || !Number.isFinite(stage)) return null;
  if (stage < 1 || stage > 99) return null;

  // Plague region: acts 21-24, the only acts that reuse the 6-digit form
  // (`difficulty * 100 + act`). Matches `core/stages.ts` `plagueBaseFromAct`.
  if (act >= 21 && act <= 24) {
    const base = difficultyRef * 100 + act;
    return base * 100 + stage;
  }
  if (act < 1 || act > 9) return null;
  if (!Number.isFinite(difficultyRef) || difficultyRef <= 0) return null;
  return difficultyRef * 1000 + act * 100 + stage;
}

/**
 * Map a stageKey to a box level for `category`, from the injected routes.
 *
 * `dropStageKeys` are disjoint per level within a category (verified against
 * the bundled catalog: all 11 levels of the COMMON/RARE line, and every ACT
 * boss route, claim their own stages), so the match is exact. Two matches at
 * the same stage are only possible in malformed data, where the HIGHEST level
 * wins — mirroring `resolveTrackedDropBoxIdForStage`'s tie-break.
 *
 * Returns null when the category has no routes (plague variants), the stageKey
 * is unknown, or nothing drops there — and a null leaves the caller's
 * attribution untouched, so the row stays category-only rather than wrong.
 */
function levelForStage(
  category: string,
  stageKey: number,
  routes: BackfillBoxRoutes,
): number | null {
  const list = routes.byCategory.get(category);
  if (!list || list.length === 0) return null;
  if (!Number.isFinite(stageKey) || stageKey <= 0) return null;
  let best: number | null = null;
  for (const route of list) {
    if (!Number.isFinite(route.level) || route.level <= 0) continue;
    if (!route.dropStageKeys.includes(stageKey)) continue;
    if (best === null || route.level > best) best = route.level;
  }
  return best;
}

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
  // Structural: the game's stage-clear records share the ring, and are the
  // level evidence this file reads separately — never loot.
  if (raw.startsWith(CLEAR_PREFIX)) return false;
  const name = e.acquireName?.trim() ?? "";
  if (!name) return false;
  // A clear line's parsed name is "关卡 3-10" (no colour tag), so the chest
  // gate below would not catch it — belt and braces alongside the prefix.
  if (STAGE_LABEL_RE.test(raw) || STAGE_LABEL_RE.test(name)) return false;
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
