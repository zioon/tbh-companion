// Level curve data and helpers, ported from tbh-meter/reader.
// The curve maps level → cumulative XP required to reach that level
// (ExpForLevelUp per level). Levels 1–100 are defined; any level outside
// this range is considered "capped" (no defined progression).
//
// Data is embedded inline to keep core/ free of file I/O (framework-free,
// unit-testable).

/** The highest level that has a defined curve entry. Levels above this are capped. */
export const MAX_DEFINED_LEVEL = 100;

/**
 * Hardcoded level curve: level → total XP required to reach that level.
 * Extracted from game data; covers levels 1–100.
 */
const CURVE: Record<number, number> = {
  1: 30,
  2: 150,
  3: 500,
  4: 1000,
  5: 2600,
  6: 6500,
  7: 13000,
  8: 23400,
  9: 37440,
  10: 74880,
  11: 134784,
  12: 229133,
  13: 366613,
  14: 513258,
  15: 718561,
  16: 970057,
  17: 1309577,
  18: 1702450,
  19: 2042940,
  20: 3064410,
  21: 3615531,
  22: 4157861,
  23: 4739962,
  24: 5356157,
  25: 6266704,
  26: 7708046,
  27: 9866299,
  28: 12135548,
  29: 14198591,
  30: 15618450,
  31: 17180295,
  32: 18709341,
  33: 20170728,
  34: 21528801,
  35: 22748528,
  36: 23796986,
  37: 24644829,
  38: 25267650,
  39: 25647149,
  40: 25772024,
  41: 25638532,
  42: 25250674,
  43: 24619997,
  44: 28490088,
  45: 32968530,
  46: 38150952,
  47: 44148014,
  48: 51653176,
  49: 63533406,
  50: 81322760,
  51: 100026995,
  52: 117031584,
  53: 125223795,
  54: 133989461,
  55: 143368723,
  56: 153404534,
  57: 164142851,
  58: 175632851,
  59: 187927151,
  60: 201082052,
  61: 215157796,
  62: 230218842,
  63: 241729784,
  64: 253816273,
  65: 266507087,
  66: 279832441,
  67: 293824063,
  68: 308515266,
  69: 323941029,
  70: 340138080,
  71: 357144984,
  72: 375002233,
  73: 393752345,
  74: 413439962,
  75: 434111960,
  76: 455817558,
  77: 478608436,
  78: 559971870,
  79: 688765400,
  80: 881619712,
  81: 1084392246,
  82: 1268738928,
  83: 1306801096,
  84: 1346005129,
  85: 1386385283,
  86: 1427976841,
  87: 1470816146,
  88: 1514940630,
  89: 1560388849,
  90: 1607200514,
  91: 1655416529,
  92: 1705079025,
  93: 1739180606,
  94: 1773964218,
  95: 1809443502,
  96: 1845632372,
  97: 1882545019,
  98: 1920195919,
  99: 1958599837,
  100: 1997771834,
};

/**
 * True when `lv` is outside the defined curve range — no further progression
 * is defined for this level (level cap). `null` → false (no info, keep raw delta).
 */
export function isLevelCapped(lv: number | null): boolean {
  if (lv == null) return false;
  return lv < 1 || lv > MAX_DEFINED_LEVEL;
}

/**
 * XP required to fill the current level (reach the next level).
 * `null` if the level has no curve entry (capped / unknown).
 */
export function xpForNextLevel(currentLv: number): number | null {
  if (currentLv < 1 || currentLv > MAX_DEFINED_LEVEL) return null;
  return CURVE[currentLv] ?? null;
}

/**
 * Total XP earned crossing from (lv0, exp0) to (lv1, exp1), bridging through
 * one or more level-ups via the curve.
 *
 * Formula: (curve[lv0] - exp0) + full intermediate levels + exp1
 *
 * Crossing INTO the cap (lv1 with no curve entry) banks only up to the threshold —
 * post-cap exp1 is phantom and doesn't count.
 *
 * Returns null if the curve doesn't cover lv0/intermediate levels or the result
 * is negative (shouldn't happen with valid inputs).
 */
export function xpThroughLevelUp(
  lv0: number,
  exp0: number,
  lv1: number,
  exp1: number,
): number | null {
  // Must have curve entry for lv0
  if (!(lv0 in CURVE)) return null;

  try {
    let total = CURVE[lv0] - exp0;

    // Add full intermediate levels
    for (let L = lv0 + 1; L < lv1; L++) {
      if (!(L in CURVE)) return null;
      total += CURVE[L];
    }

    // Add final level's exp (capped if final level is at cap)
    total += lv1 in CURVE ? exp1 : 0;

    return total >= 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * XP gain of ONE hero between two snapshots. Handles same-level tracking
 * and level-up bridging via the curve.
 *
 * @param lv0 - Previous level
 * @param exp0 - Previous within-level exp
 * @param lv1 - Current level
 * @param exp1 - Current within-level exp
 * @returns [gain | null, leveled: boolean]
 *   - gain: XP earned (null = could not compute)
 *   - leveled: true if a level-up occurred
 *
 * A hero AT the cap (isLevelCapped) gains 0.0 same-level — within-level exp
 * keeps rising at the cap with no level-up to consume it, so the delta is phantom.
 */
export function perHeroGain(
  lv0: number,
  exp0: number,
  lv1: number,
  exp1: number,
): [number | null, boolean] {
  const leveled = lv1 > lv0;

  if (leveled) {
    return [xpThroughLevelUp(lv0, exp0, lv1, exp1), true];
  }

  if (isLevelCapped(lv1)) {
    return [0, false]; // phantom XP at cap
  }

  return [exp1 - exp0, false];
}
