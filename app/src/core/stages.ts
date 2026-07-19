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

export function stageName(key: number, catalog: LocaleCatalog | null = null): string {
  const k = Math.trunc(Number(key));
  if (!Number.isFinite(k) || k <= 0) return "?";
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
