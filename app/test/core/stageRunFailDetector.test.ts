import { describe, it, expect } from "vitest";
import {
  StageRunFailDetector,
  type StageRunFailJudgement,
} from "../../src/core/stageRunFailDetector";

const idle: StageRunFailJudgement = { fail: null, runEnded: false };

describe("StageRunFailDetector", () => {
  it("flags a failure when the party withdraws without a clear, at wave >= MIN_WAVES", () => {
    const d = new StageRunFailDetector();
    // Heroes deployed, two waves cleared, then the party withdraws (run ended).
    expect(d.update(true, false, 3205, 1, 0)).toEqual(idle);
    expect(d.update(true, false, 3205, 2, 10)).toEqual(idle);
    // First absent tick only starts the confirm window — not a confirmed end.
    expect(d.update(false, false, 3205, 2, 100)).toEqual(idle);
    // Sustained absence past the window confirms the run ended → failure.
    expect(d.update(false, false, 3205, 2, 600)).toEqual({
      fail: { stageKey: 3205, failedWave: 2 },
      runEnded: true,
    });
  });

  it("does not flag when the run cleared (clear seen while heroes deployed)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 1, 0)).toEqual(idle);
    expect(d.update(true, true, 3205, 2, 10)).toEqual(idle); // clear lands mid-run
    expect(d.update(false, false, 3205, 2, 100)).toEqual(idle);
    // Withdraw after a clear: run ended but it was a win → no failure.
    expect(d.update(false, false, 3205, 2, 600)).toEqual({ fail: null, runEnded: true });
  });

  it("does not flag when no hero was ever deployed (menu/lobby)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(false, false, 3205, 0, 0)).toEqual(idle);
    expect(d.update(false, false, 3205, 0, 600)).toEqual(idle);
  });

  it("does not flag a run that never reached MIN_WAVES (entered then quit)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 1, 0)).toEqual(idle);
    expect(d.update(false, false, 3205, 1, 100)).toEqual(idle);
    // Withdraw at wave 1 — ended but below MIN_WAVES → no failure.
    expect(d.update(false, false, 3205, 1, 600)).toEqual({ fail: null, runEnded: true });
  });

  it("judges by the run's peak wave, not the (already reset) wave at withdrawal", () => {
    const d = new StageRunFailDetector();
    // Last-wave defeat: while heroes are still deployed the wave counter peaks
    // at the stage total (e.g. 16), then a run-end reset (wave-total catch)
    // zeroes it BEFORE the party withdraws a few ticks later. The judgement
    // must still fire from the peak — the instantaneous 0 would fail MIN_WAVES
    // and silently drop the defeat.
    expect(d.update(true, false, 3205, 3, 0)).toEqual(idle);
    expect(d.update(true, false, 3205, 16, 10)).toEqual(idle); // peaked at the last wave
    expect(d.update(true, false, 3205, 0, 20)).toEqual(idle); // wave counter already reset
    expect(d.update(false, false, 3205, 0, 100)).toEqual(idle);
    expect(d.update(false, false, 3205, 0, 600)).toEqual({
      fail: { stageKey: 3205, failedWave: 16 },
      runEnded: true,
    });
  });

  it("does not inflate a run that quit early with a stale pre-run peak", () => {
    const d = new StageRunFailDetector();
    // Previous run peaked at 9; the new run only reaches wave 1 before quitting.
    expect(d.update(true, false, 3205, 9, 0)).toEqual(idle);
    expect(d.update(false, false, 3205, 9, 100)).toEqual(idle);
    expect(d.update(false, false, 3205, 9, 600)).toEqual({
      fail: { stageKey: 3205, failedWave: 9 },
      runEnded: true,
    });
    expect(d.update(true, false, 3205, 1, 700)).toEqual(idle); // new run, peak restarted
    expect(d.update(false, false, 3205, 1, 800)).toEqual(idle);
    expect(d.update(false, false, 3205, 1, 1300)).toEqual({ fail: null, runEnded: true });
  });

  it("flags exactly once per failed run, and the next run is judged independently", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 1, 0)).toEqual(idle);
    expect(d.update(true, false, 3205, 3, 10)).toEqual(idle);
    expect(d.update(false, false, 3205, 3, 100)).toEqual(idle);
    expect(d.update(false, false, 3205, 3, 600)).toEqual({
      fail: { stageKey: 3205, failedWave: 3 },
      runEnded: true,
    });

    // Second failed run.
    expect(d.update(true, false, 3205, 1, 700)).toEqual(idle);
    expect(d.update(true, false, 3205, 4, 710)).toEqual(idle);
    expect(d.update(false, false, 3205, 4, 800)).toEqual(idle);
    expect(d.update(false, false, 3205, 4, 1300)).toEqual({
      fail: { stageKey: 3205, failedWave: 4 },
      runEnded: true,
    });
  });

  it("does not end the run on a single dirty-read tick (recovers inside the window)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 2, 0)).toEqual(idle);
    // A one-off blank read (hero-exp rollback / offset bounce): window starts...
    expect(d.update(false, false, 3205, 2, 100)).toEqual(idle);
    // ...but the party is back the next tick — the withdrawal is cancelled.
    expect(d.update(true, false, 3205, 2, 200)).toEqual(idle);
    expect(d.update(true, false, 3205, 3, 210)).toEqual(idle);
    // A real sustained withdrawal still gets caught afterwards.
    expect(d.update(false, false, 3205, 3, 300)).toEqual(idle);
    expect(d.update(false, false, 3205, 3, 800)).toEqual({
      fail: { stageKey: 3205, failedWave: 3 },
      runEnded: true,
    });
  });

  it("reset() clears in-flight run state", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 2, 0)).toEqual(idle);
    d.reset();
    expect(d.update(false, false, 3205, 2, 100)).toEqual(idle); // run forgotten
  });
});
