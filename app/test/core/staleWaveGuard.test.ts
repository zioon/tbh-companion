import { describe, it, expect } from "vitest";
import { StaleWaveGuard, STALE_WAVE_WINDOW_MS } from "../../src/core/liveMemory/staleWaveGuard";

const W = STALE_WAVE_WINDOW_MS;

describe("StaleWaveGuard", () => {
  it("passes through a wave that changes per transition (healthy runtimeWave)", () => {
    const g = new StaleWaveGuard();
    // Wave 1 in progress: 20 monsters, then 0 (clear), then wave 2 spawns.
    expect(g.update(1, 20, 0).report).toBe(1);
    expect(g.update(1, 0, 1000).report).toBe(1); // clear while still wave 1
    expect(g.update(2, 20, 2000).report).toBe(2); // value changed → trust
    expect(g.update(2, 20, 30000).report).toBe(2); // long same-value stretch WITHOUT transitions is fine
  });

  it("flags a constant non-zero wave that survives wave transitions (v1.01.05 symptom)", () => {
    const g = new StaleWaveGuard();
    expect(g.update(2, 21, 0).report).toBe(2);
    // Wave transitions keep firing (21 ↔ 0) while rawWave stays pinned at 2.
    let last = g.update(2, 0, 1000);
    expect(last.report).toBe(2);
    expect(last.flagged).toBe(false);
    last = g.update(2, 21, 2000);
    expect(last.flagged).toBe(false); // sawTransition armed, window not yet elapsed
    // After the window with transitions observed → stale.
    const stale = g.update(2, 0, 1000 + W + 1);
    expect(stale.report).toBeNull();
    expect(stale.flagged).toBe(true);
    // Flagged exactly once while stale persists.
    const again = g.update(2, 21, 2000 + W + 1);
    expect(again.report).toBeNull();
    expect(again.flagged).toBe(false);
  });

  it("re-arms immediately when the value changes after being stale", () => {
    const g = new StaleWaveGuard();
    g.update(2, 21, 0);
    g.update(2, 0, 1000); // transition
    expect(g.update(2, 21, 1000 + W + 1).report).toBeNull(); // now stale
    // Game writes a fresh wave → trust again right away.
    expect(g.update(3, 21, 2000 + W + 1).report).toBe(3);
  });

  it("keeps reporting 0/null waves untouched and re-arms on return", () => {
    const g = new StaleWaveGuard();
    expect(g.update(0, null, 0).report).toBe(0);
    expect(g.update(null, null, 1000).report).toBeNull();
    // After a gap, a value is trusted again (guard state was reset).
    expect(g.update(4, 5, 2000).report).toBe(4);
  });

  it("does not flag a constant wave when the monster source is absent (no transitions)", () => {
    const g = new StaleWaveGuard();
    // monsterHp unavailable → monsterCount null every tick: transition
    // detection is disabled, so even a long constant is not judged stale.
    let out = g.update(5, null, 0);
    expect(out.report).toBe(5);
    out = g.update(5, null, W + 9999);
    expect(out.report).toBe(5);
    expect(out.flagged).toBe(false);
  });
});
