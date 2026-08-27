/**
 * Heuristic detector for stage-run failures that the game never logs.
 *
 * The game has no failure log, so a failure is inferred from live-memory run
 * boundaries. The key signal is the deployed party (`StageManager.HeroList`):
 * heroes are on the field for the whole battle and only leave when a run ends
 * (cleared a stage, or lost and withdrew). That makes hero-presence a clean
 * run-END boundary — and, unlike an alive-monster count, it does NOT flicker
 * between waves, so it needs no "how long was the field empty" threshold.
 *
 * Rule (as designed by the product):
 *   - A run that ends WITH a stage-clear event is a normal clear (already
 *     recorded by the stage-run history); never a failure.
 *   - A run that ends WITHOUT a clear is a failure.
 * The run is bounded by the moment the deployed heroes disappear.
 *
 * A lower bound on reached waves is kept to avoid flagging an "entered the
 * stage then instantly quit" as a failure.
 */
export interface StageRunFailResult {
  stageKey: number;
  /** Furthest (cleared) wave reached before the run ended. */
  failedWave: number;
}

export class StageRunFailDetector {
  /** Ignore runs that never got past this many cleared waves (avoids "entered then quit" noise). */
  static readonly MIN_WAVES = 2;

  private inRun = false; // we have seen a deployed hero this run
  private runStageKey = 0;
  private runHadClear = false;

  /**
   * Feed one live tick.
   *
   * @param heroesPresent true when at least one hero is deployed on the field
   *   (i.e. `snap.heroes` is a non-empty array).
   * @param hadClear true when a valid stage-clear event was seen this tick.
   * @param stageKey current stage key (live/save fallback).
   * @param waves current cleared-wave estimate this tick (used to judge how far
   *   the run got, and captured at the run's end).
   * @returns a {@link StageRunFailResult} exactly once, at the moment the party
   *   disappears (run ends) and the run is judged a failure; otherwise null.
   */
  update(
    heroesPresent: boolean,
    hadClear: boolean,
    stageKey: number,
    waves: number,
  ): StageRunFailResult | null {
    if (heroesPresent) {
      // New run begins the first time a hero is deployed.
      if (!this.inRun) {
        this.inRun = true;
        this.runStageKey = stageKey;
        this.runHadClear = false;
      }
      if (hadClear) this.runHadClear = true;
      return null;
    }

    // No hero on the field.
    if (!this.inRun) return null; // nothing deployed (menu/lobby) — not a run end

    // The party withdrew: the run ended. It's a failure iff it never cleared.
    const failed =
      !this.runHadClear && this.runStageKey > 0 && waves >= StageRunFailDetector.MIN_WAVES
        ? { stageKey: this.runStageKey, failedWave: waves }
        : null;
    this.inRun = false;
    this.runStageKey = 0;
    this.runHadClear = false;
    return failed;
  }

  /** Drop any in-flight run state (e.g. when live memory toggles or resets). */
  reset(): void {
    this.inRun = false;
    this.runStageKey = 0;
    this.runHadClear = false;
  }
}
