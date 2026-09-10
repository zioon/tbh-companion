// Guards the live-memory stage wave (StageManager runtimeWave) against stale
// constant readings.
//
// Symptom: on some game builds the runtimeWave offset drifts and reads a
// CONSTANT value (e.g. v1.01.05 pinned at 2) while the battle keeps advancing.
// `stats.ts` prefers any live wave > 0 over the DpsTracker estimate, so a
// constant non-zero reading freezes the UI wave display ("2/31" forever even
// though waves keep clearing — measured 2026-09-02).
//
// Detection: a valid runtimeWave advances once per wave. If the same non-zero
// value persists for WINDOW_MS WHILE monster wave transitions (alive 0↔N)
// keep firing, the value cannot be the current wave — it is stale. Report null
// so the consumer falls back to the monster-count estimate. Any value change
// re-arms trust immediately (the game just wrote a fresh wave).

/** Millis a constant non-zero wave may persist across wave transitions
 *  before it is treated as stale. A transition implies a full wave boundary
 *  passed, after which a valid runtimeWave must have changed; the window
 *  only absorbs slow builds whose wave write lags the monster swap by a few
 *  frames. */
export const STALE_WAVE_WINDOW_MS = 8_000;

export interface StaleWaveUpdate {
  /** Wave to report for this tick: the raw value, or null when judged stale. */
  report: number | null;
  /** True exactly once, on the tick the value is first judged stale (log hook). */
  flagged: boolean;
}

export class StaleWaveGuard {
  private value: number | null = null;
  private sinceMs: number | null = null;
  private sawTransition = false;
  private lastMonsterCount: number | null = null;
  private staleLogged = false;

  /**
   * Feed one read tick.
   * @param wave raw runtimeWave (null when the offset wasn't read).
   * @param monsterCount alive-monster count for the tick (null when the
   *   monster source is absent — transition detection is disabled then).
   */
  update(wave: number | null, monsterCount: number | null, nowMs: number): StaleWaveUpdate {
    const transition =
      this.lastMonsterCount != null &&
      monsterCount != null &&
      (this.lastMonsterCount === 0) !== (monsterCount === 0);
    this.lastMonsterCount = monsterCount;

    if (wave == null || wave <= 0) {
      this.arm(null, nowMs);
      return { report: wave, flagged: false };
    }
    if (this.value !== wave) {
      // Value changed — the game wrote a fresh wave; trust it again.
      this.arm(wave, nowMs);
      return { report: wave, flagged: false };
    }
    if (transition) this.sawTransition = true;
    if (
      this.sawTransition &&
      this.sinceMs != null &&
      nowMs - this.sinceMs >= STALE_WAVE_WINDOW_MS
    ) {
      if (!this.staleLogged) {
        this.staleLogged = true;
        return { report: null, flagged: true };
      }
      return { report: null, flagged: false };
    }
    return { report: wave, flagged: false };
  }

  private arm(value: number | null, nowMs: number): void {
    this.value = value;
    this.sinceMs = value == null ? null : nowMs;
    this.sawTransition = false;
    this.staleLogged = false;
  }
}
