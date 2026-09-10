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
 * One caveat to that clean-boundary assumption: dirty reads can briefly blank
 * the hero list without the party actually withdrawing — a hero-exp rollback /
 * offset bounce / scene transition makes `readParty` return an empty list (or
 * `heroes: null`) for a tick or a few. Treating each such down-edge as a
 * confirmed withdrawal would (a) reset the DpsTracker wave counter mid-run and
 * (b) record a phantom failed run. So the withdrawal judgement is debounced on
 * the down-edge: the party must stay absent for `WITHDRAW_CONFIRM_MS` before we
 * confirm the run ended. Real withdrawals are sustained (the list stays empty),
 * so the short window still catches every genuine run end.
 *
 * Rule (as designed by the product):
 *   - A run that ends WITH a stage-clear event is a normal clear (already
 *     recorded by the stage-run history); never a failure.
 *   - A run that ends WITHOUT a clear is a failure.
 * The run is bounded by the moment the deployed heroes disappear (confirmed).
 *
 * A lower bound on reached waves is kept to avoid flagging an "entered the
 * stage then instantly quit" as a failure.
 */
export interface StageRunFailResult {
  stageKey: number;
  /** Furthest (cleared) wave reached before the run ended. */
  failedWave: number;
}

/** Outcome of one `update` tick: a failure (exactly once per failed run) and/or
 *  a confirmed run end (fires for clear and defeat alike, driver-side). */
export interface StageRunFailJudgement {
  fail: StageRunFailResult | null;
  runEnded: boolean;
}

export class StageRunFailDetector {
  /** Ignore runs that never got past this many cleared waves (avoids "entered then quit" noise). */
  static readonly MIN_WAVES = 2;
  /** The deployed party must stay absent this long before we confirm the run
   *  ended. Longer than a dirty-read flicker (<~150ms / a few ticks), short
   *  enough that a real withdrawal (sustained absence) is never missed. */
  static readonly WITHDRAW_CONFIRM_MS = 400;

  private inRun = false; // we have seen a deployed hero this run
  private runStageKey = 0;
  private runHadClear = false;
  /**
   * Highest wave estimate observed during the current run. Judgement and
   * `failedWave` reporting read this peak instead of the end-of-run `waves`
   * argument: on the hero-withdrawal tick the wave counter may already have
   * been reset to 0 by a run-end reset path that fired earlier (the
   * wave-total catch in `TrackingService.ingestLiveFrame` resets the DpsTracker
   * wave counter as soon as monsters clear, which can precede the party's
   * withdrawal by several ticks). Using the instantaneous value there would
   * fail the `MIN_WAVES` gate and silently drop a real last-wave defeat.
   */
  private runMaxWaves = 0;
  /** wall-clock (ms) of the first absent tick; null while the party is (still)
   *  present or the withdrawal has not yet started. */
  private absentSinceMs: number | null = null;

  /**
   * Feed one live tick.
   *
   * @param heroesPresent true when at least one hero is deployed on the field
   *   (i.e. `snap.heroes` is a non-empty array).
   * @param hadClear true when a valid stage-clear event was seen this tick.
   * @param stageKey current stage key (live/save fallback).
   * @param waves current cleared-wave estimate this tick; the run's peak is
   *   tracked across ticks and used to judge how far the run got (see
   *   {@link runMaxWaves}).
   * @param nowMs current wall-clock in ms (used to debounce the withdrawal
   *   down-edge against dirty-read flicker).
   * @returns a {@link StageRunFailJudgement}. `fail` is set exactly once per
   *   failed run, at the moment the party disappearance is *confirmed* (absent
   *   for `WITHDRAW_CONFIRM_MS`); `runEnded` is true on that same confirmed
   *   tick for both a normal clear and a defeat, and false otherwise.
   */
  update(
    heroesPresent: boolean,
    hadClear: boolean,
    stageKey: number,
    waves: number,
    nowMs: number,
  ): StageRunFailJudgement {
    if (heroesPresent) {
      // Re-deployed (or still deployed). A return to the field cancels any
      // pending withdrawal — that absence was just read noise. (A clear observed
      // here resolves the current run as a win in the product sense; the
      // driver resets on clear too, so state stays per-run.)
      this.absentSinceMs = null;
      // New run begins the first time a hero is deployed.
      if (!this.inRun) {
        this.inRun = true;
        this.runStageKey = stageKey;
        this.runHadClear = false;
        this.runMaxWaves = waves;
      } else {
        this.runMaxWaves = Math.max(this.runMaxWaves, waves);
      }
      if (hadClear) this.runHadClear = true;
      return { fail: null, runEnded: false };
    }

    // No hero on the field.
    if (!this.inRun) return { fail: null, runEnded: false }; // were in the menu/lobby

    // First absent tick — start the confirm clock; do NOT end the run yet, a
    // single dirty read must not be mistaken for a withdrawal.
    if (this.absentSinceMs == null) {
      this.absentSinceMs = nowMs;
      if (hadClear) this.runHadClear = true;
      return { fail: null, runEnded: false };
    }

    // A clear observed while the party reads as absent still resolves the run
    // as a win (defensive against clear/hero-list ordering jitter).
    if (hadClear) this.runHadClear = true;

    // Still within the confirm window — keep the run alive.
    if (nowMs - this.absentSinceMs < StageRunFailDetector.WITHDRAW_CONFIRM_MS) {
      return { fail: null, runEnded: false };
    }

    // The party stayed absent long enough: the run genuinely ended. It's a
    // failure iff it never cleared.
    const failed =
      !this.runHadClear &&
      this.runStageKey > 0 &&
      this.runMaxWaves >= StageRunFailDetector.MIN_WAVES
        ? { stageKey: this.runStageKey, failedWave: this.runMaxWaves }
        : null;
    this.inRun = false;
    this.runStageKey = 0;
    this.runHadClear = false;
    this.runMaxWaves = 0;
    this.absentSinceMs = null;
    return { fail: failed, runEnded: true };
  }

  /** Drop any in-flight run state (e.g. on a clear, or when live memory toggles or resets). */
  reset(): void {
    this.inRun = false;
    this.runStageKey = 0;
    this.runHadClear = false;
    this.runMaxWaves = 0;
    this.absentSinceMs = null;
  }
}
