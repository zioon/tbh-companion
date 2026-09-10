import { describe, it, expect } from "vitest";
import type { LiveHeroData } from "../../shared/types";
import { makeHeroStableState, stabilizeHeroes } from "../../src/core/liveMemory/heroStable";

const hero = (heroKey: number, level: number, exp: number): LiveHeroData => ({
  heroKey,
  level,
  exp,
});

describe("heroStable (live hero monotonic debounce)", () => {
  it("passes through a clean forward reading", () => {
    const s = makeHeroStableState();
    expect(stabilizeHeroes(s, [hero(101, 3, 50), hero(201, 5, 100)])).toEqual([
      hero(101, 3, 50),
      hero(201, 5, 100),
    ]);
  });

  it("holds the previous exp on a same-level exp rollback (dirty read)", () => {
    const s = makeHeroStableState();
    stabilizeHeroes(s, [hero(101, 3, 50)]);
    // exp bounces backwards at the same level — must not regress.
    expect(stabilizeHeroes(s, [hero(101, 3, 5)])).toEqual([hero(101, 3, 50)]);
    // ...and the held baseline is NOT advanced, so the real higher value still
    // reconciles cleanly afterwards.
    expect(stabilizeHeroes(s, [hero(101, 3, 200)])).toEqual([hero(101, 3, 200)]);
  });

  it("holds the previous level and exp on a level rollback (dirty read)", () => {
    const s = makeHeroStableState();
    stabilizeHeroes(s, [hero(101, 4, 800)]);
    // level bounces down — impossible in-game; must not regress.
    expect(stabilizeHeroes(s, [hero(101, 3, 10)])).toEqual([hero(101, 4, 800)]);
  });

  it("accepts a level-up and re-anchors exp at the fresh (reset) value", () => {
    const s = makeHeroStableState();
    stabilizeHeroes(s, [hero(101, 4, 950)]);
    // Level-up: higher level, within-level exp reset to a small value.
    expect(stabilizeHeroes(s, [hero(101, 5, 20)])).toEqual([hero(101, 5, 20)]);
    // Post-level-up progress is then tracked normally.
    expect(stabilizeHeroes(s, [hero(101, 5, 30)])).toEqual([hero(101, 5, 30)]);
  });

  it("treats equal readings as unchanged", () => {
    const s = makeHeroStableState();
    stabilizeHeroes(s, [hero(101, 3, 50)]);
    expect(stabilizeHeroes(s, [hero(101, 3, 50)])).toEqual([hero(101, 3, 50)]);
  });

  it("passes null and empty arrays through untouched", () => {
    const s = makeHeroStableState();
    stabilizeHeroes(s, [hero(101, 3, 50)]);
    expect(stabilizeHeroes(s, null)).toBeNull();
    expect(stabilizeHeroes(s, [])).toEqual([]);
  });

  it("is per-heroKey (one hero's rollback does not affect another)", () => {
    const s = makeHeroStableState();
    stabilizeHeroes(s, [hero(101, 3, 50), hero(201, 5, 100)]);
    // 101 regresses, 201 advances — only 101 is held.
    expect(stabilizeHeroes(s, [hero(101, 3, 10), hero(201, 5, 120)])).toEqual([
      hero(101, 3, 50),
      hero(201, 5, 120),
    ]);
  });
});
