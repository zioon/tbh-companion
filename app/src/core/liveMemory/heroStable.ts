import type { LiveHeroData } from "../../../shared/types";

/**
 * Per-hero monotonic debounce for live hero reads.
 *
 * `readParty` decodes each hero's `level`/`exp` straight from raw process
 * memory every ~25 Hz tick. When the underlying offsets drift (a layout-
 * migrating version like v1.2.2, or a read landing on recycled memory) the
 * decoded value can bounce *backwards* — the same heroKey reports a lower
 * level, or a lower exp at the same level — without the party actually having
 * leveled down. If such a regression is emitted as-is it:
 *   - makes the hero panel's exp/level visibly roll back, and
 *   - pollutes rate/tracker maths and the run-end (wave/failure) heuristics
 *     downstream, which trust the reading to be monotonic.
 *
 * This guard clamps each heroKey to its last-known-good reading and only ever
 * advances it. A level-up (higher level) is real and is taken as a new baseline
 * for its (reset) within-level exp; everything else that would regress is held
 * at the previous value, and the held baseline is NOT advanced so the later,
 * correct, higher reading is still recognized.
 */
export interface HeroStableState {
  /** heroKey → last-accepted {level, exp} reading. */
  byKey: Map<number, { level: number; exp: number }>;
}

export function makeHeroStableState(): HeroStableState {
  return { byKey: new Map() };
}

/**
 * Stabilize a raw live hero array against dirty back-reads, in place of the
 * caller's `heroes`. `null`/empty inputs are passed through untouched (an
 * absent/deployed page is handled by the wave/failure logic, not here), and
 * `byKey` is intentionally kept so a later frame can still validate against it.
 */
export function stabilizeHeroes(
  state: HeroStableState,
  heroes: LiveHeroData[] | null | undefined,
): LiveHeroData[] | null {
  if (heroes == null || heroes.length === 0) return heroes ?? null;

  const stabilized: LiveHeroData[] = [];
  for (const h of heroes) {
    const prev = state.byKey.get(h.heroKey);

    // First sighting of this heroKey (engaged this run / fresh attach): trust it.
    if (prev === undefined) {
      state.byKey.set(h.heroKey, { level: h.level, exp: h.exp });
      stabilized.push(h);
      continue;
    }

    // A hero's level never drops mid-run — a lower level than the last frame
    // is a dirty read (hero-exp rollback / offset bounce). Hold the previous
    // level AND exp so the reader never emits a regression.
    if (h.level < prev.level) {
      stabilized.push({ heroKey: h.heroKey, level: prev.level, exp: prev.exp });
      continue;
    }

    // Level-up: the game banks the old within-level exp into the level curve
    // and resets the counter to a small value. The new (higher) level with its
    // fresh exp becomes the next baseline.
    if (h.level > prev.level) {
      state.byKey.set(h.heroKey, { level: h.level, exp: h.exp });
      stabilized.push(h);
      continue;
    }

    // Same level: within-level exp is monotonic outside a level-up. A drop is
    // a dirty read — keep the previous exp (never regress) and DON'T advance
    // the baseline, so the later, correct higher reading reconciles cleanly
    // instead of being seen as a second (phantom) gain.
    if (h.exp < prev.exp) {
      stabilized.push({ heroKey: h.heroKey, level: h.level, exp: prev.exp });
      continue;
    }

    // A forward (or equal) reading: accept and promote.
    state.byKey.set(h.heroKey, { level: h.level, exp: h.exp });
    stabilized.push(h);
  }
  return stabilized;
}
