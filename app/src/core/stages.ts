// Decode TBH stage keys into human-readable map names.
//
//   3205 -> Hell 2-5      (difficulty 3, act 2, stage 5)
//   2309 -> Nightmare 3-9 (difficulty 2, act 3, stage 9)
//
// When a LocaleCatalog is provided, looks up catalog.stages["1<act><stage>"]
// (e.g. 3205 → "1205") and returns the localized stage name directly.
// The leading "1" is fixed (difficulty normalized to NORMAL) — the same
// catalog entry is reused across all 4 difficulties for the same act/stage.
// Otherwise falls back to "<difficulty> <act>-<stage>" using
// catalog.difficulties (or English default if catalog is null).
//
// Ported from tbh_xp/stages.py.

import type { LocaleCatalog } from "./localeCatalog";

const DIFFICULTIES: Record<number, string> = {
  1: "Normal",
  2: "Nightmare",
  3: "Hell",
  4: "Torment",
};

// Difficulty enum name keyed by digit (1..4). Used when catalog.difficulties
// contains localized names.
const DIFFICULTY_DIGIT_TO_ENUM: Record<number, string> = {
  1: "NORMAL",
  2: "NIGHTMARE",
  3: "HELL",
  4: "TORMENT",
};

/**
 * Plague (Contaminated) stages use **6-digit** stage keys, distinct from the
 * 4-digit normal ones — e.g. 201201 = Nightmare 21-1, 201301 = Hell 22-1,
 * 201401 = Torment 23-1. Each region has a fixed base (the region id prefix
 * with the within-region stage appended). Plague boxes only drop on these
 * (Nightmare 21 / Hell 22 / Torment 23). Keys are disjoint from normal keys
 * (max normal is 4-digit ≤ ~4999; plague starts at 201201).
 */
const PLAGUE_REGIONS: Record<number, { act: number; diffEnum: string; en: string }> = {
  2012: { act: 21, diffEnum: "NIGHTMARE", en: "Nightmare" },
  2013: { act: 22, diffEnum: "HELL", en: "Hell" },
  2014: { act: 23, diffEnum: "TORMENT", en: "Torment" },
};

/** Plague region base (2012/2013/2014 or undefined) for a plague (Contaminated) stage key. */
function plagueRegionBase(key: number): number | undefined {
  return PLAGUE_REGIONS[Math.floor(key / 100)] != null ? Math.floor(key / 100) : undefined;
}

/** Plague region base for a cleared-stage `act` (21/22/23), else null. */
function plagueBaseFromAct(act: number): number | null {
  switch (Math.trunc(act)) {
    case 21:
      return 2012;
    case 22:
      return 2013;
    case 23:
      return 2014;
    default:
      return null;
  }
}

export function stageName(key: number, catalog: LocaleCatalog | null = null): string {
  const k = Math.trunc(Number(key));
  if (!Number.isFinite(k) || k <= 0) return "?";

  // Plague (Contaminated) stages use 6-digit keys (201201 = Nightmare 21-1).
  // Their catalog entries are keyed by the FULL 6-digit key (unlike normal
  // stages, which are keyed by the "1<act><stage>" prefix), so look the full
  // key up directly and fall back to "Nightmare 21-1".
  const plagueBase = plagueRegionBase(k);
  if (plagueBase !== undefined) {
    const region = PLAGUE_REGIONS[plagueBase]!;
    const localized = catalog?.stages[String(k)];
    if (localized) return localized;
    const diff = (catalog && catalog.difficulties[region.diffEnum]) || region.en;
    return `${diff} ${region.act}-${k % 100}`;
  }

  const difficulty = Math.floor(k / 1000);
  const act = Math.floor(k / 100) % 10;
  const stage = k % 100;

  // Try catalog lookup first. Catalog key is 4-digit "1<act><stage>" —
  // leading "1" is fixed (NORMAL difficulty), so the same catalog entry
  // covers all 4 difficulties for the same act/stage.
  if (catalog) {
    const stageKey4 = `1${act}${String(stage).padStart(2, "0")}`;
    const localized = catalog.stages[stageKey4];
    if (localized) return localized;
  }

  // Fallback: <difficulty> <act>-<stage>
  const diffEnum = DIFFICULTY_DIGIT_TO_ENUM[difficulty];
  const diff =
    (catalog && diffEnum && catalog.difficulties[diffEnum]) ||
    DIFFICULTIES[difficulty] ||
    `D${difficulty}`;
  return `${diff} ${act}-${stage}`;
}

/**
 * Reconstruct the full stageKey for a stage-clear event from the log entry's
 * `act`/`stage` (which identify the **cleared** stage) combined with the
 * difficulty digit of a reference stageKey (the current live/save stageKey).
 *
 * StageClearLog carries act+stage+clearTimeSec but NOT difficulty, so the
 * caller must supply a reference stageKey to recover difficulty. This is the
 * fix for the off-by-one stage attribution bug where a clear of 3-1 was
 * recorded as 3-2: when the reader polls the tick after a clear, the live
 * `stageKey` has already advanced to the next stage, but the log entry still
 * holds the cleared stage's act/stage — using those instead of the live
 * stageKey gives the correct attribution.
 *
 * Plague (Contaminated) stages use 6-digit keys (201201 = Nightmare 21-1). When
 * the reference stageKey is a plague stage, rebuild from the cleared stage's
 * region act (21/22/23, from the log) — else the current live region base —
 * plus the cleared within-region `stage`.
 *
 * Returns `fallbackStageKey` when `act`/`stage` are 0 (corrupted / mid-write
 * read) or when `fallbackStageKey` is non-positive (no difficulty source).
 */
export function resolveClearedStageKey(
  act: number,
  stage: number,
  fallbackStageKey: number,
): number {
  const k = Math.trunc(fallbackStageKey);
  if (k <= 0) return k;
  const stagePart = Math.trunc(stage);
  if (stagePart < 1 || stagePart > 99) return k;

  // Plague (Contaminated) stages: reconstruct the full 6-digit key. Prefer the
  // cleared log's region act (21/22/23) so a clear that ADVANCES to a new
  // plague region is still attributed to the region it was actually cleared in;
  // fall back to the current live region base.
  if (plagueRegionBase(k) !== undefined) {
    const base = plagueBaseFromAct(act) ?? plagueRegionBase(k)!;
    return base * 100 + stagePart;
  }

  const difficulty = Math.floor(k / 1000);
  if (difficulty <= 0) return k;
  const a = Math.trunc(act);
  if (a < 1 || a > 9) return k;
  return difficulty * 1000 + a * 100 + stagePart;
}
