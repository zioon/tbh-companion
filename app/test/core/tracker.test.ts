import { describe, it, expect, vi } from "vitest";
import {
  XpTracker,
  liveHeroFrameTrustworthy,
  evaluateGoldDivergence,
} from "../../src/core/tracker";
import type { SaveSnapshot } from "../../shared/types";

function snap(mtime: number, heroExp: number, gold = 0): SaveSnapshot {
  return {
    heroes: [{ key: "101", level: 1, exp: heroExp, unlocked: true }],
    totalHeroExp: heroExp,
    playTime: 0,
    saveMtime: mtime,
    stageKey: 3205,
    stageWave: 1,
    maxStage: 0,
    gold,
  };
}

describe("XpTracker", () => {
  it("returns 0 and sets no rate on the first (init) update", () => {
    const t = new XpTracker(300);
    expect(t.update(snap(1000, 500))).toBe(0);
    expect(t.rollingRate).toBe(0);
    expect(t.cumulativeGained).toBe(0);
  });

  it("computes XP/hour from the mtime span, not poll time", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    const gain = t.update(snap(1060, 600)); // +600 over 60s -> 36000/hr
    expect(gain).toBe(600);
    expect(t.cumulativeGained).toBe(600);
    expect(t.rollingRate).toBeCloseTo(36000, 5);
    expect(t.heroRate("101")).toBeCloseTo(36000, 5);
  });

  it("holds the rate constant when XP does not change", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.update(snap(1060, 600));
    const before = t.rollingRate;
    const gain = t.update(snap(1120, 600)); // no XP change
    expect(gain).toBe(0);
    expect(t.rollingRate).toBe(before);
  });

  it("treats an XP drop (level-up reset) as a gain of the new value", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.update(snap(1060, 600));
    const gain = t.update(snap(1120, 50)); // dropped 600 -> 50: counts 50
    expect(gain).toBe(50);
    expect(t.cumulativeGained).toBe(650);
  });

  it("records history entries only on XP change", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.update(snap(1060, 600));
    t.update(snap(1120, 600)); // no change -> no history
    t.update(snap(1180, 900)); // +300
    expect(t.history).toHaveLength(2);
    expect(t.history[0].delta).toBe(600);
    expect(t.history[1].delta).toBe(300);
    expect(t.history[1].stageKey).toBe(3205);
  });

  it("counts gold earned only, ignoring spending", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 1000));
    t.update(snap(1060, 0, 1500)); // +500 earned
    t.update(snap(1120, 0, 1200)); // spent 300 -> ignored
    t.update(snap(1180, 0, 1700)); // +500 earned
    expect(t.goldGained).toBe(1000);
    expect(t.goldRollingRate).toBeGreaterThan(0);
  });

  it("reset clears session state", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.update(snap(1060, 600));
    t.reset();
    expect(t.cumulativeGained).toBe(0);
    expect(t.rollingRate).toBe(0);
    expect(t.history).toHaveLength(0);
    expect(t.update(snap(2000, 999))).toBe(0); // re-inits
  });

  it("round-trips captureSnapshot and applySnapshot", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.update(snap(1060, 600));
    const copy = new XpTracker(300);
    copy.applySnapshot(t.captureSnapshot());
    expect(copy.cumulativeGained).toBe(600);
    expect(copy.rollingRate).toBeCloseTo(t.rollingRate, 5);
    expect(copy.history).toHaveLength(1);
    const gain = copy.update(snap(1120, 900));
    expect(gain).toBe(300);
    expect(copy.cumulativeGained).toBe(900);
  });

  it("secondsSinceGain uses save mtime and ignores reads without XP change", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    expect(t.secondsSinceGain).toBeNull();

    const baseNow = Date.now() / 1000;
    t.update(snap(baseNow - 30, 600)); // XP gain at mtime 30s ago
    expect(t.secondsSinceGain).toBeCloseTo(30, 0);

    t.update(snap(baseNow - 5, 600)); // save wrote 5s ago, XP unchanged
    expect(t.secondsSinceGain).toBeCloseTo(30, 0); // still anchored to last gain mtime
  });

  it("sessionRate decays toward zero as the session runs idle (no new XP gain)", () => {
    // 用 fake timers 把 nowSeconds() 固定到 t0；snap.saveMtime 也用同一时间基。
    vi.useFakeTimers();
    const t0 = 1_000_000; // seconds since epoch
    vi.setSystemTime(t0 * 1000);

    const t = new XpTracker(300);
    t.update(snap(t0, 0)); // init at session start

    // 在 t0+60s 获得 600 XP（即 60s 内 600 XP -> 36000/hr）
    vi.setSystemTime((t0 + 60) * 1000);
    t.update(snap(t0 + 60, 600));
    expect(t.cumulativeGained).toBe(600);
    // 此时整个会话已经 60s，sessionRate ≈ 36000
    expect(t.sessionRate).toBeCloseTo(36000, -3);

    // 玩家挂机 1 小时：save 文件继续写但 XP 不变
    vi.setSystemTime((t0 + 60 + 3600) * 1000);
    t.update(snap(t0 + 60 + 3600, 600));
    // 期望 sessionRate 衰减到接近 600/3660*3600 ≈ 590 XP/hour
    expect(t.sessionRate).toBeLessThan(800);
    expect(t.sessionRate).toBeGreaterThan(500);

    vi.useRealTimers();
  });

  it("goldSessionRate decays toward zero as the session runs idle (no new gold gain)", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0 * 1000);

    const t = new XpTracker(300);
    t.update(snap(t0, 0, 0)); // init

    vi.setSystemTime((t0 + 60) * 1000);
    t.update(snap(t0 + 60, 0, 600)); // +600 gold in 60s
    expect(t.goldGained).toBe(600);
    expect(t.goldSessionRate).toBeCloseTo(36000, -3);

    // 挂机 1 小时
    vi.setSystemTime((t0 + 60 + 3600) * 1000);
    t.update(snap(t0 + 60 + 3600, 0, 600));
    expect(t.goldSessionRate).toBeLessThan(800);
    expect(t.goldSessionRate).toBeGreaterThan(500);

    vi.useRealTimers();
  });
});

describe("XpTracker.updateLive", () => {
  it("is ignored before the first save update (not yet initialized)", () => {
    const t = new XpTracker(300);
    t.updateLive({ gold: 5000, heroes: [{ heroKey: 101, level: 1, exp: 200 }] }, 1000);
    expect(t.currentGold).toBe(0);
    expect(t.currentTotalXp).toBe(0);
    expect(t.goldRollingRate).toBe(0);
  });

  it("updates gold rate from live wall-time samples", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 0)); // init
    t.updateLive({ gold: 3600, heroes: null }, 1000); // +3600 gold at t=1000
    t.updateLive({ gold: 7200, heroes: null }, 1001); // +3600 gold at t=1001 (+1s)
    // 3600 gold/s = 3_600 * 3600 hr = 12_960_000/hr  (only positive deltas count from first change)
    expect(t.goldRollingRate).toBeGreaterThan(0);
    expect(t.currentGold).toBe(7200);
  });

  it("accumulates XP gain and updates rates from live samples", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0)); // init: hero 101 @ exp 0
    // First live tick establishes the live baseline (no gain counted); the
    // second tick's +600 is the real live delta.
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 600 }] }, 1000);
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 1200 }] }, 1060);
    expect(t.cumulativeGained).toBe(600);
    expect(t.currentTotalXp).toBe(1200);
  });

  it("does NOT count the save→live baseline jump as XP gain", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 1000)); // save baseline: hero 101 @ exp 1000
    // Live reports a very different value for the same hero (different quantity /
    // fresher scale). The takeover must re-baseline, not count ~999k as gained.
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 999_999 }] }, 1000);
    expect(t.cumulativeGained).toBe(0);
    expect(t.currentTotalXp).toBe(999_999);
  });

  it("ignores save-layer XP while the live path is driving", () => {
    const t = new XpTracker(300);
    const now = Date.now() / 1000;
    t.update(snap(now - 100, 1000)); // init from save
    // Live takes over and accrues a real +100.
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 5000 }] }, now);
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 5100 }] }, now + 1);
    const gained = t.cumulativeGained;
    expect(gained).toBe(100);
    // A save write arrives with its stale, differently-scaled exp — must NOT
    // inject a spurious gain while live is still driving.
    const g = t.update(snap(now + 2, 1000));
    expect(g).toBe(0);
    expect(t.cumulativeGained).toBe(gained);
  });

  it("re-baselines cleanly when the save path reclaims XP after live goes stale", () => {
    const t = new XpTracker(300);
    const now = Date.now() / 1000;
    t.update(snap(now - 100, 1000)); // init
    // A stale live frame from long ago (>LIVE_TAKEOVER_SEC before the save write).
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 5000 }] }, now - 100);
    // Save reclaims XP: handover re-baselines to the save value, counts nothing.
    expect(t.update(snap(now, 1000))).toBe(0);
    expect(t.cumulativeGained).toBe(0);
    // Subsequent save deltas count normally again.
    expect(t.update(snap(now + 60, 1600))).toBe(600);
    expect(t.cumulativeGained).toBe(600);
  });

  it("seeded XP gain via live ticks drives the rolling rate", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0)); // init
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 3600 }] }, 1000);
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 7200 }] }, 1001);
    // +7200 exp total, +3600 in 1s window → rate should be > 0
    expect(t.rollingRate).toBeGreaterThan(0);
  });

  it("updates currentGold with live value", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 100));
    t.updateLive({ gold: 9999, heroes: null }, 1005);
    expect(t.currentGold).toBe(9999);
  });

  it("does not count a joining hero's existing exp as session gain", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 100 }] }, 1000);
    t.updateLive(
      {
        gold: null,
        heroes: [
          { heroKey: 101, level: 1, exp: 200 },
          { heroKey: 201, level: 1, exp: 300 },
        ],
      },
      1001,
    );
    expect(t.cumulativeGained).toBe(100);
  });

  it("does not spike session XP when a hero drops out of a bad read", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.updateLive(
      {
        gold: null,
        heroes: [
          { heroKey: 101, level: 1, exp: 50_000_000 },
          { heroKey: 201, level: 1, exp: 50_000_000 },
          { heroKey: 301, level: 1, exp: 50_000_000 },
        ],
      },
      1000,
    );
    t.updateLive(
      {
        gold: null,
        heroes: [
          { heroKey: 101, level: 1, exp: 50_000_100 },
          { heroKey: 201, level: 1, exp: 50_000_100 },
        ],
      },
      1001,
    );
    expect(t.cumulativeGained).toBe(200);
  });

  it("does not spike session XP on a single hero level-up", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.updateLive(
      {
        gold: null,
        heroes: [
          { heroKey: 101, level: 100, exp: 50_000_000 },
          { heroKey: 201, level: 100, exp: 50_000_000 },
        ],
      },
      1000,
    );
    t.updateLive(
      {
        gold: null,
        heroes: [
          { heroKey: 101, level: 101, exp: 120 },
          { heroKey: 201, level: 100, exp: 50_000_200 },
        ],
      },
      1001,
    );
    expect(t.cumulativeGained).toBe(320);
  });

  it("ignores implausible decoded hero exp without counting a gain", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 1000 }] }, 1000);
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 1e20 }] }, 1001);
    expect(t.cumulativeGained).toBe(0);
  });

  it("refreshes rolling rate on every live tick even without new XP gain", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 100 }] }, 1000);
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 1100 }] }, 1001);
    const rateAfterGain = t.rollingRate;
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 1100 }] }, 1002);
    expect(rateAfterGain).toBeGreaterThan(0);
    expect(t.rollingRate).toBeLessThan(rateAfterGain);
  });

  it("records history entries on live XP gain", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0));
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 600 }] }, 1000, {
      stageKey: 3205,
      stageWave: 2,
    });
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 1200 }] }, 1060, {
      stageKey: 3205,
      stageWave: 2,
    });
    expect(t.history).toHaveLength(1);
    expect(t.history[0].delta).toBe(600);
    expect(t.history[0].stageKey).toBe(3205);
    expect(t.history[0].stageWave).toBe(2);
  });

  it("heals inflated session totals when live memory takes over", () => {
    const t = new XpTracker(300);
    const now = Date.now() / 1000;
    t.update(snap(now - 100, 0));
    const base = t.captureSnapshot();
    t.applySnapshot({
      ...base,
      sessionStart: now - 1544,
      cumulativeGained: 97.93e9,
      sessionRateValue: 4.7649e13,
      rollingRateValue: 83.7e6,
      heroMeters: {
        "101": {
          window: 300,
          gained: 1e12,
          rolling: 1.177e12,
          samples: [
            [now - 1500, 0],
            [now - 60, 1e12],
          ],
        },
      },
    });
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 101, exp: 100 }] }, now);
    expect(t.cumulativeGained).toBeLessThan(1e10);
    expect(t.sessionRate).toBeLessThan(5e10);
    expect(t.heroRate("101")).toBeLessThan(5e10);
  });

  it("applySnapshot clears live ownership flags", () => {
    const t = new XpTracker(300);
    const now = Date.now() / 1000;
    t.update(snap(now - 100, 1000));
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 5000 }] }, now);
    t.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 5100 }] }, now + 1);
    expect(t.cumulativeGained).toBe(100);
    expect(t.update(snap(now + 2, 1000))).toBe(0);

    const copy = new XpTracker(300);
    copy.applySnapshot(t.captureSnapshot());
    expect(copy.update(snap(now + 10, 5600))).toBe(500);
  });

  it("ignores implausible live hero exp in totalXp and takeover seeding", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0)); // initialize so updateLive is accepted
    // First live frame = takeover. key2 carries a dirty read far above the
    // 1e12 runtime-exp cap; it must not pollute totalXp or the per-hero baseline.
    t.updateLive(
      {
        gold: null,
        heroes: [
          { heroKey: 1, level: 10, exp: 500 },
          { heroKey: 2, level: 10, exp: 3e12 },
        ],
      },
      1000,
    );
    expect(t.currentTotalXp).toBe(500);
    // Clean follow-up frame: only key1 advances.
    t.updateLive({ gold: null, heroes: [{ heroKey: 1, level: 10, exp: 600 }] }, 1001);
    expect(t.currentTotalXp).toBe(600);
    const snap2 = t.captureSnapshot();
    expect(snap2.currentTotalXp).toBe(600);
    expect(snap2.prevHero["2"]).toBeUndefined(); // dirty hero never seeded
  });

  it("caps a corrupt live gold spike and still advances the baseline", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 1000)); // initialize so updateLive is accepted
    t.updateLive({ gold: 1000, heroes: null }, 5000); // live takeover: baseline only
    // Corrupt spike: +~5e7 in one 40 ms tick (far above the 1e7 per-tick cap).
    t.updateLive({ gold: 51_000_000, heroes: null }, 5001);
    expect(t.goldGained).toBe(0);
    // Baseline advanced with the spike, so the next legit gain is counted.
    t.updateLive({ gold: 51_001_000, heroes: null }, 5002);
    expect(t.goldGained).toBe(1000);
    expect(t.currentGold).toBe(51_001_000);
  });

  it("rejects an implausible save-path gold jump but keeps tracking afterwards", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 1000));
    // +1e12 over 60 s → ~6e13/hour, far above MAX_PLAUSIBLE_GOLD_RATE —
    // e.g. a game update migrating the balance. Not counted; baseline advances.
    t.update(snap(1060, 0, 1e12));
    expect(t.goldGained).toBe(0);
    // Normal gains after the jump are unaffected.
    t.update(snap(1120, 0, 1e12 + 500));
    expect(t.goldGained).toBe(500);
  });

  it("reconcileGoldBaseline rebases an implausible post-update jump without counting", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 1000));
    const result = t.reconcileGoldBaseline(1e12, 1060, 1000); // 60 s gap, huge diff
    expect(result).toBe("rebased");
    expect(t.goldGained).toBe(0);
    expect(t.currentGold).toBe(1e12);
    // The bridged diff is never counted by the next update either.
    t.update(snap(1120, 0, 1e12));
    expect(t.goldGained).toBe(0);
  });

  it("reconcileGoldBaseline counts a plausible offline gain exactly once", () => {
    const t = new XpTracker(300);
    t.update(snap(1000, 0, 1000));
    // ~1.06M gold over a 3600 s gap → ~1.06M/hour, plausible bridging.
    const result = t.reconcileGoldBaseline(1_060_000, 1000 + 3600, 1000);
    expect(result).toBe("counted");
    expect(t.goldGained).toBe(1_059_000);
    // Same-gold update right after must not double count.
    t.update(snap(1000 + 3660, 0, 1_060_000));
    expect(t.goldGained).toBe(1_059_000);
  });

  it("reconcileGoldBaseline is a noop for decreases and fresh trackers", () => {
    const t = new XpTracker(300);
    // Not initialized yet.
    expect(t.reconcileGoldBaseline(500, 100, null)).toBe("noop");
    t.update(snap(1000, 0, 1000));
    // Gold decreased across restart (spending): update() handles rebaseline.
    expect(t.reconcileGoldBaseline(500, 1060, 1000)).toBe("noop");
    expect(t.goldGained).toBe(0);
  });

  it("clamps a save-parsed hero exp above the sanity cap (v1.2.4 plausibility gate)", () => {
    const t = new XpTracker(300);
    // 2e15 exceeds MAX_HERO_SAVE_EXP (1e15) — would pollute the persisted snapshot.
    t.update({
      heroes: [{ key: "101", level: 101, exp: 2e15, unlocked: true }],
      totalHeroExp: 2e15,
      playTime: 0,
      saveMtime: 1000,
      stageKey: 3205,
      stageWave: 1,
      maxStage: 0,
      gold: 0,
    });
    expect(t.heroes[0]?.exp).toBe(1e15);
    // 1.4e12 (observed on v1.2.4) is within the cap and must be accepted as-is.
    const t2 = new XpTracker(300);
    t2.update({
      heroes: [{ key: "201", level: 101, exp: 1.4e12, unlocked: true }],
      totalHeroExp: 1.4e12,
      playTime: 0,
      saveMtime: 1000,
      stageKey: 3205,
      stageWave: 1,
      maxStage: 0,
      gold: 0,
    });
    expect(t2.heroes[0]?.exp).toBe(1.4e12);
  });
});

describe("liveHeroFrameTrustworthy", () => {
  it("trusts a live frame whose levels are at or above the save levels", () => {
    const save = new Map<string, number>([
      ["101", 101],
      ["201", 101],
    ]);
    expect(
      liveHeroFrameTrustworthy(
        [
          { heroKey: 101, level: 101 },
          { heroKey: 201, level: 102 },
        ],
        save,
      ),
    ).toBe(true);
  });

  it("rejects a live frame that regresses a hero below its save level (v1.2.4 garbage read)", () => {
    const save = new Map<string, number>([["101", 101]]);
    // Stale v1.2.2 offsets floor the obscured decode to level 1.
    expect(liveHeroFrameTrustworthy([{ heroKey: 101, level: 1 }], save)).toBe(false);
  });

  it("trusts a hero with no save record (newly deployed, not a regression)", () => {
    const save = new Map<string, number>([["101", 101]]);
    expect(liveHeroFrameTrustworthy([{ heroKey: 999, level: 1 }], save)).toBe(true);
  });

  it("does not flag a hero that is genuinely level 1 in the save", () => {
    const save = new Map<string, number>([["501", 1]]);
    expect(liveHeroFrameTrustworthy([{ heroKey: 501, level: 1 }], save)).toBe(true);
  });
});

describe("evaluateGoldDivergence", () => {
  it("substitutes the save gold when the live read is below it", () => {
    expect(evaluateGoldDivergence(100, 500, null, 1000, 8)).toEqual({
      substitute: true,
      suspect: false,
    });
  });

  it("flags suspect only after the divergence has sustained past the window", () => {
    expect(evaluateGoldDivergence(100, 500, 990, 997, 8)).toEqual({
      substitute: true,
      suspect: false,
    });
    expect(evaluateGoldDivergence(100, 500, 990, 999, 8)).toEqual({
      substitute: true,
      suspect: true,
    });
  });

  it("does not substitute when the live read meets or exceeds the save floor", () => {
    expect(evaluateGoldDivergence(500, 500, null, 1000, 8)).toEqual({
      substitute: false,
      suspect: false,
    });
    expect(evaluateGoldDivergence(900, 500, null, 1000, 8)).toEqual({
      substitute: false,
      suspect: false,
    });
  });

  it("does not substitute when either value is missing", () => {
    expect(evaluateGoldDivergence(null, 500, null, 1000, 8)).toEqual({
      substitute: false,
      suspect: false,
    });
    expect(evaluateGoldDivergence(100, null, null, 1000, 8)).toEqual({
      substitute: false,
      suspect: false,
    });
  });
});
