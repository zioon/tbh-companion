import { describe, it, expect } from "vitest";
import { StageRunFailDetector } from "../../src/core/stageRunFailDetector";

describe("StageRunFailDetector", () => {
  it("flags a failure when the party withdraws without a clear, at wave >= MIN_WAVES", () => {
    const d = new StageRunFailDetector();
    // Heroes deployed, two waves cleared, then the party withdraws (run ended).
    expect(d.update(true, false, 3205, 1)).toBeNull();
    expect(d.update(true, false, 3205, 2)).toBeNull();
    const res = d.update(false, false, 3205, 2); // heroes gone, no clear
    expect(res).toEqual({ stageKey: 3205, failedWave: 2 });
  });

  it("does not flag when the run cleared (clear seen while heroes deployed)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 1)).toBeNull();
    expect(d.update(true, true, 3205, 2)).toBeNull(); // clear lands mid-run
    expect(d.update(false, false, 3205, 2)).toBeNull(); // withdraw after a clear
  });

  it("does not flag when no hero was ever deployed (menu/lobby)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(false, false, 3205, 0)).toBeNull();
    expect(d.update(false, false, 3205, 0)).toBeNull();
  });

  it("does not flag a run that never reached MIN_WAVES (entered then quit)", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 1)).toBeNull();
    expect(d.update(false, false, 3205, 1)).toBeNull(); // withdraw at wave 1
  });

  it("flags exactly once per failed run, and the next run is judged independently", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 1)).toBeNull();
    expect(d.update(true, false, 3205, 3)).toBeNull();
    expect(d.update(false, false, 3205, 3)).toEqual({ stageKey: 3205, failedWave: 3 });

    // Second failed run.
    expect(d.update(true, false, 3205, 1)).toBeNull();
    expect(d.update(true, false, 3205, 4)).toBeNull();
    expect(d.update(false, false, 3205, 4)).toEqual({ stageKey: 3205, failedWave: 4 });
  });

  it("reset() clears in-flight run state", () => {
    const d = new StageRunFailDetector();
    expect(d.update(true, false, 3205, 2)).toBeNull();
    d.reset();
    expect(d.update(false, false, 3205, 2)).toBeNull(); // run forgotten
  });
});
