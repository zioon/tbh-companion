// Source-fit for the record page: attribute each "获得记录" ring line to the
// game activity that produced it, by fitting the line against the three
// in-memory event buckets the reader already tracks — chest drops (GetBox →
// ChestDropTracker.history), box opens (GetItemWithBoxOpen →
// BoxOpenTracker.history) and stage clears (StageClearLog tail → the main
// process's own clear history). A successful fit drives the row's game-mode
// colouring and the category/quality filters in the renderer.
//
// Pure and stateless: no Electron / fs / React. The caller owns the data; the
// occupation marks live only inside one call, so the fit is deterministic and
// trivially testable.
//
// Matching discipline (strongest signal first, each event used at most once):
//   -1. Hero life-event notices ("牧师被击败了。(木乃伊)") are excluded UP FRONT
//       by their purple tint / template wording. They are not grants of
//       anything, and a death lands <1s before the following clear line, so
//       pass 4 would otherwise claim it and mislabel it as a clear reward.
//   0. "通关了" text prefix — the ring line IS the stage-clear record. Exact,
//      no time inference at all.
//   1. Open by item-name equality — the open history carries the catalog name
//      of every granted item; a line whose parsed name equals it is that open.
//      Count-aware: one open of count 3 covers a "×3" line (or three lines).
//   2. Chest by nearest time — a chest drop logs exactly one ring line (the
//      chest item itself) at the drop moment, so the nearest unused GetBox
//      event within the window claims it. Gated on the line's name looking
//      like a chest ("宝箱"/"chest") so unrelated lines (gold, materials) can
//      never steal a chest event and get mislabelled.
//   3. Open by nearest time — content lines whose name match failed (catalog
//      localization gaps, placeholder names) still belong to the nearest open
//      with remaining count.
//   4. Clear by nearest time — leftover lines near a clear event (rewards in
//      game languages the prefix check does not cover).
//
// Bulk-replayed lines (initial attach backlog) are NEVER fit: their wallTime
// is the ingest moment, not the event moment, so any fit would be fiction.

import type { ChestDropCategory, RecordLogSourceFit } from "../../shared/types";
import { isWishLine } from "./wishLine";

/** One acquire-ring line to fit (subset of RecordLogEntry). */
export interface AcquireFitInput {
  seq: number;
  wallTime: number;
  /** Parsed item name from the rich-text line (name-match signal for opens). */
  acquireName?: string;
  /** Occurrences on the line ("×3" → 3); 1 when absent. */
  acquireCount?: number;
  /** Raw line text — the "通关了" prefix identifies stage-clear lines exactly. */
  acquireRaw?: string;
  /** Rich-text tint — the game's purple marks hero life-event notices. */
  acquireColor?: string | null;
  /** Initial-attach replay rows carry a distorted wallTime — never fit them. */
  bulk?: boolean;
}

/** One GetBox chest-drop event (subset of ChestDropHistoryEntry). */
export interface ChestFitEvent {
  wallTime: number;
  category: ChestDropCategory;
}

/** One GetItemWithBoxOpen event (subset of BoxOpenHistoryEntry). */
export interface OpenFitEvent {
  wallTime: number;
  boxKey: string;
  itemName?: string;
  grade?: string | null;
  /** Units granted by this open (a chest bursts several items). */
  count: number;
}

/** One StageClearLog clear event (main process's own history). */
export interface ClearFitEvent {
  wallTime: number;
  stageKey?: number;
}

/**
 * How far (seconds) a bucket event may sit from the ring line it explains.
 * Both sides derive from the same worker reads, but they travel different
 * channels (fast acquire poll vs the 5 Hz live-frame ingest), so the observed
 * skew is well under a second — the window only has to absorb processing
 * bursts and a frame interval or two. 8s is comfortably above that while far
 * below the typical auto-open delay between a chest drop and its contents, so
 * a chest line and its content lines do not blur into one another.
 */
export const FIT_WINDOW_SEC = 8;

/** The game's stage-clear line template ("通关了关卡 3-10。(4秒)"). zh client. */
const CLEAR_PREFIX = "通关了";
/** Extracts "3-10" from the clear line's "关卡 3-10" fragment. */
const STAGE_LABEL_RE = /关卡\s*(\d+-\d+)/;
/** A line whose name looks like a chest item (zh / en) — gate for pass 2. */
const CHEST_NAME_RE = /宝箱|[Cc]hest/;

/**
 * Hero life-event lines ("牧师被击败了。(木乃伊)"). The game tints these
 * purple and every template ends with the same 了。(<unit>) tail; they are
 * NOT rewards of anything and must never be fitted.
 *
 * Why this gate is load-bearing: a hero death lands within a second of the
 * stage-clear line that follows it (measured 2026-09-21 on a live v1.2.4
 * Boss run: "牧师被击败了。(木乃伊)" at wallTime 1789990881.34 vs
 * "通关了关卡 3-9。(73秒)" at 1789990881.967 — 0.627 s apart, well inside
 * FIT_WINDOW_SEC). Pass 4's clear-by-nearest-time fallback would therefore
 * claim the death line as a clear reward and mislabel it "通关" in the UI.
 * Pass 0 cannot catch this: the death line does not start with CLEAR_PREFIX.
 *
 * Because the renderer keys its unfitted-line buckets on the ABSENCE of a
 * fit (see RecordLog.tsx `deriveRow`), letting a hero line through here
 * would also suppress its correct "hero" classification.
 */
const HERO_LINE_RE = /被击败|阵亡|复活|升级|觉醒/;
/** The game's purple tint for hero life-event notices (see boxOpenBackfill). */
const HERO_TINT = "#7030A5";

interface OpenCandidate extends OpenFitEvent {
  remaining: number;
}
interface ChestCandidate {
  wallTime: number;
  category: ChestDropCategory;
  used: boolean;
}

/**
 * Whether a line is one of the game's own hero life-event notices rather than
 * a grant. Two independent signals — either is sufficient:
 *  - the purple tint the game uses for hero notices (`#7030A5`);
 *  - the template wording (`被击败` / `阵亡` / `复活` / `升级` / `觉醒`).
 *
 * The colour check alone would be enough on the zh client, but the text check
 * keeps this working if the tint is ever absent (older archive rows, a locale
 * that re-tints) and costs nothing.
 */
function isHeroNotice(a: AcquireFitInput): boolean {
  const tint = a.acquireColor?.trim().toUpperCase();
  if (tint === HERO_TINT) return true;
  return HERO_LINE_RE.test(a.acquireRaw ?? "");
}

/**
 * Fit every non-bulk acquire line against the three buckets. Returns a map
 * keyed by `String(seq)` — JSON-friendly for the stats push. Lines with no
 * plausible source simply stay absent (the renderer shows them unlabelled).
 */
export function fitAcquireSources(
  acquires: readonly AcquireFitInput[],
  chests: readonly ChestFitEvent[],
  opens: readonly OpenFitEvent[],
  clears: readonly ClearFitEvent[],
  windowSec: number = FIT_WINDOW_SEC,
): Record<string, RecordLogSourceFit> {
  const out: Record<string, RecordLogSourceFit> = {};
  if (acquires.length === 0) return out;

  // Working copies with occupation state, sorted by time. The histories are
  // near-ordered, but Player.log backfill and snapshot restores interleave —
  // sorting makes the binary search + nearest scan correct regardless.
  const chestEvents: ChestCandidate[] = [...chests]
    .sort((a, b) => a.wallTime - b.wallTime)
    .map((e) => ({ wallTime: e.wallTime, category: e.category, used: false }));
  const openEvents: OpenCandidate[] = [...opens]
    .sort((a, b) => a.wallTime - b.wallTime)
    .map((e) => ({ ...e, remaining: Math.max(1, Math.floor(e.count || 1)) }));
  const clearEvents = [...clears].sort((a, b) => a.wallTime - b.wallTime);

  // Chronological order matters: the line closest to an event (in time) must
  // claim it before later lines can steal it (see pass 2's comment).
  const fitables = [...acquires]
    .filter((a) => !a.bulk)
    .sort((a, b) => a.wallTime - b.wallTime || a.seq - b.seq);

  // Hero notices and offering-result lines are never fitted by ANY pass (not
  // just pass 4). Neither is an open, a chest, or a clear reward:
  //   - a hero death is not a grant at all (see isHeroNotice);
  //   - an offering ("祈愿结果：获得 <item>") is its own event stream, and
  //     because a wish lands close in time to a nearby stage clear, pass 4's
  //     clear-by-nearest-time fallback would otherwise claim it and badge it
  //     "通关" in the UI (the P0-5 defect).
  // Excluding them here — before any pass runs — also guarantees the
  // renderer's text-keyed buckets ("hero" / "wish") still see them as unfitted
  // (see RecordLog.tsx `deriveRow`, whose `!fit` branch classifies by text).
  // `isWishLine` covers all four client languages + the strict structural
  // fallback, unlike a zh-only `/^祈愿结果/` prefix (S3 needs cross-language).
  const fittable = fitables.filter((a) => !isHeroNotice(a) && !isWishLine(a.acquireRaw ?? ""));

  // Pass 0 — stage-clear lines by their own text. The game writes the clear
  // record into the same ring, so the prefix is authoritative; no bucket data
  // needed, no occupation consumed (the line is the record, not a side effect).
  for (const a of fittable) {
    const raw = a.acquireRaw ?? "";
    if (!raw.startsWith(CLEAR_PREFIX)) continue;
    const m = STAGE_LABEL_RE.exec(raw);
    out[String(a.seq)] = { source: "clear", stageLabel: m?.[1] };
  }

  // Pass 1 — opens by exact item-name equality. The strongest bucket signal:
  // the open history carries the granted item's catalog name and the line
  // carries the game's display name — equal means this line is that grant.
  for (const a of fittable) {
    if (out[String(a.seq)]) continue;
    const name = a.acquireName?.trim();
    if (!name) continue;
    const hit = nearestWithin(
      openEvents,
      a.wallTime,
      windowSec,
      (e) => e.remaining > 0 && e.itemName === name,
    );
    if (!hit) continue;
    out[String(a.seq)] = {
      source: "open",
      boxKey: hit.event.boxKey,
      grade: hit.event.grade ?? null,
    };
    hit.event.remaining = Math.max(0, hit.event.remaining - Math.max(1, a.acquireCount ?? 1));
  }

  // Pass 2 — chest drops by nearest unused GetBox event. A drop logs exactly
  // one ring line naming the chest, so the gate keeps gold/material/content
  // lines from stealing chest events (their colouring would be wrong).
  for (const a of fittable) {
    if (out[String(a.seq)]) continue;
    const name = a.acquireName?.trim() ?? "";
    if (!CHEST_NAME_RE.test(name)) continue;
    const hit = nearestWithin(chestEvents, a.wallTime, windowSec, (e) => !e.used);
    if (!hit) continue;
    out[String(a.seq)] = { source: "chest", chestCategory: hit.event.category };
    hit.event.used = true;
  }

  // Pass 3 — opens by nearest time for content lines the name match missed.
  for (const a of fittable) {
    if (out[String(a.seq)]) continue;
    const hit = nearestWithin(openEvents, a.wallTime, windowSec, (e) => e.remaining > 0);
    if (!hit) continue;
    out[String(a.seq)] = {
      source: "open",
      boxKey: hit.event.boxKey,
      grade: hit.event.grade ?? null,
    };
    hit.event.remaining = Math.max(0, hit.event.remaining - Math.max(1, a.acquireCount ?? 1));
  }

  // Pass 4 — clears by nearest time: reward lines of a clear (gold, materials)
  // in languages the prefix check does not cover. No occupation: one clear
  // legitimately produces several lines.
  for (const a of fittable) {
    if (out[String(a.seq)]) continue;
    const hit = nearestWithin(clearEvents, a.wallTime, windowSec, () => true);
    if (!hit) continue;
    out[String(a.seq)] = { source: "clear", stageKey: hit.event.stageKey };
  }

  return out;
}

/**
 * Nearest usable event within ±windowSec of `t` over a time-sorted array.
 * Binary-searches the window start, then scans forward while inside the
 * window — O(log n + k) per call, k = events in the window (tiny).
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
