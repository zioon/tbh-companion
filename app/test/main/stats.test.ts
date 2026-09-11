import { describe, it, expect } from "vitest";
import { XpTracker } from "../../src/core/tracker";
import { ChestDropTracker } from "../../src/core/chestDropTracker";
import { BoxOpenTracker } from "../../src/core/boxOpenTracker";
import { DpsTracker } from "../../src/core/liveMemory/dpsTracker";
import { buildStats } from "../../src/main/stats";
import type { LocaleCatalog } from "../../src/core/localeCatalog";
import type { LiveMemorySnapshot, SaveSnapshot } from "../../shared/types";

function snap(mtime: number): SaveSnapshot {
  return {
    heroes: [{ key: "101", level: 1, exp: 100, unlocked: true }],
    totalHeroExp: 100,
    playTime: 0,
    saveMtime: mtime,
    stageKey: 3205,
    stageWave: 1,
    maxStage: 0,
    gold: 0,
  };
}

describe("buildStats", () => {
  it("includes chest drop session stats", () => {
    const tracker = new XpTracker(300);
    const chestDropTracker = new ChestDropTracker();
    tracker.update(snap(1000));
    chestDropTracker.recordLogDrop(910151);

    const stats = buildStats(
      tracker,
      chestDropTracker,
      new BoxOpenTracker(),
      new DpsTracker(),
      snap(1000),
      null,
      null,
    );
    expect(stats.chestDrops.commonTotal).toBe(1);
    expect(stats.chestDrops.combinedTotal).toBe(1);
    expect(stats.chestDrops.readerRequired).toBe(true);
    expect(stats.chestDrops.breakdown[0]?.name).toBe("Normal Monster Box Lv15");
  });

  it("prefers live hero levels and rates when live XP is active", () => {
    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    const now = Date.now() / 1000;
    tracker.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 1, exp: 100 }] }, now);
    tracker.updateLive({ gold: null, heroes: [{ heroKey: 101, level: 12, exp: 200 }] }, now + 1);

    const liveFrame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 9999,
      stageWave: 3,
      stageWaveTotal: null,
      stageAlive: null,
      gold: null,
      heroes: [{ heroKey: 101, level: 12, exp: 200 }],
      chestDrops: null,
      chestSlots: null,
      boxOpens: null,
      inventoryItems: null,
      stageClears: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "test",
      readMs: 1,
      at: now * 1000,
    };

    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      new DpsTracker(),
      snap(1000),
      null,
      null,
      liveFrame,
    );
    expect(stats.heroes).toHaveLength(1);
    expect(stats.heroes[0]?.level).toBe(12);
    expect(stats.heroes[0]?.rate).toBeGreaterThan(0);
    expect(stats.stageKey).toBe(9999);
    expect(stats.stageWave).toBe(3);
  });

  it("falls back to the save wave when the live stageWave is 0 (drifted runtimeWave offset)", () => {
    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    const now = Date.now() / 1000;

    // v1.01.05 reads a constant 0 from the (drifted) StageManager runtimeWave
    // offset. A live stageWave of 0 must NOT be trusted as authoritative —
    // the DpsTracker estimate and the save-derived wave are both more useful.
    const liveFrame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 9999,
      stageWave: 0,
      stageWaveTotal: 31,
      stageAlive: null,
      gold: null,
      heroes: [{ heroKey: 101, level: 12, exp: 200 }],
      chestDrops: null,
      chestSlots: null,
      boxOpens: null,
      inventoryItems: null,
      stageClears: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "test",
      readMs: 1,
      at: now * 1000,
    };

    // DpsTracker has no data (v1.01.05 monster-HP tracking unavailable) →
    // currentWave is 0, so the save snapshot's stageWave (2) is the fallback.
    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      new DpsTracker(),
      { ...snap(1000), stageWave: 2 },
      null,
      null,
      liveFrame,
    );
    expect(stats.stageWaveTotal).toBe(31);
    expect(stats.stageWave).toBe(2);
  });

  it("prefers the DpsTracker wave estimate over the save wave when live is 0", () => {
    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    const now = Date.now() / 1000;

    // Simulate a battle where DpsTracker inferred 1 wave cleared + 1 alive =
    // currentWave 2, while the save file still holds an older wave (1).
    const dps = new DpsTracker();
    const hp: Array<[number, number, number]> = [
      [100, 50, 100],
      [101, 40, 100],
    ];
    dps.update(hp, 0, now - 4);
    dps.update([], 2, now - 3); // wave clear: had monsters -> 0
    dps.update(hp, 4, now - 2); // new wave alive
    expect(dps.currentWave).toBe(2);

    const liveFrame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 9999,
      stageWave: 0,
      stageWaveTotal: 31,
      stageAlive: null,
      gold: null,
      heroes: [],
      chestDrops: null,
      chestSlots: null,
      boxOpens: null,
      inventoryItems: null,
      stageClears: null,
      petData: null,
      monsterHp: hp,
      deadMonsterCount: 4,
      source: "test",
      readMs: 1,
      at: now * 1000,
    };

    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      dps,
      { ...snap(1000), stageWave: 1 },
      null,
      null,
      liveFrame,
    );
    expect(stats.stageWave).toBe(2);
  });

  it("uses the monster-count wave estimate even without a live frame (disconnected)", () => {
    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    const now = Date.now() / 1000;

    // No live frame at all (live memory disconnected): the DpsTracker estimate
    // (driven by monster counts) must still win over the save's static wave.
    const dps = new DpsTracker();
    const hp: Array<[number, number, number]> = [
      [100, 50, 100],
      [101, 40, 100],
    ];
    dps.update(hp, 0, now - 4);
    dps.update([], 2, now - 3); // wave clear
    dps.update(hp, 4, now - 2); // new wave alive
    expect(dps.currentWave).toBe(2);

    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      dps,
      { ...snap(1000), stageWave: 1 },
      null,
      null,
      null, // no live frame
    );
    expect(stats.stageWave).toBe(2);
  });

  it("caps the wave at the stage total when the estimate drifts past it (missed clear reset)", () => {
    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    const now = Date.now() / 1000;

    // Simulate a missed stage-clear reset: DpsTracker has accumulated ~30
    // waves across runs while the current stage only has 16.
    const dps = new DpsTracker();
    const hp: Array<[number, number, number]> = [
      [100, 50, 100],
      [101, 40, 100],
    ];
    for (let i = 0; i < 20; i++) {
      dps.update(hp, 0, now - 40 + i);
      dps.update([], 0, now - 39.8 + i);
    }
    dps.update(hp, 0, now - 38);
    expect(dps.currentWave).toBeGreaterThan(16);

    const liveFrame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 1209,
      stageWave: 0, // v1.01.05 drifted runtimeWave
      stageWaveTotal: 16,
      stageAlive: 3,
      gold: null,
      heroes: [],
      chestDrops: null,
      chestSlots: null,
      boxOpens: null,
      inventoryItems: null,
      stageClears: null,
      petData: null,
      monsterHp: hp,
      deadMonsterCount: 0,
      source: "test",
      readMs: 1,
      at: now * 1000,
    };

    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      dps,
      { ...snap(1000), stageWave: 1 },
      null,
      null,
      liveFrame,
    );
    expect(stats.stageWaveTotal).toBe(16);
    expect(stats.stageWave).toBe(16); // clamped to the total, not 30
  });

  it("populates stageName in history entries via catalog", () => {
    // stageKey 3205 -> Hell 2-5; catalog key "1205" (1 + act + stage w/ leading zero).
    // Provide a zh catalog so stageName(3205, catalog) returns "地狱 2-5".
    const zhCatalog: LocaleCatalog = {
      items: {},
      stages: { "1205": "地狱 2-5" },
      heroes: {},
      difficulties: {},
    };

    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    // Force a gain so a history entry is pushed with stageKey 3205.
    const baseSnap = snap(1000);
    tracker.update({
      ...baseSnap,
      saveMtime: 1001,
      totalHeroExp: 200,
      heroes: [{ key: "101", level: 1, exp: 200, unlocked: true }],
    });

    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      new DpsTracker(),
      snap(1000),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      zhCatalog,
    );
    expect(stats.history.length).toBeGreaterThan(0);
    for (const entry of stats.history) {
      // snap uses stageKey 3205, which maps to catalog key "1205" -> "地狱 2-5"
      expect(entry.stageName).toBe("地狱 2-5");
    }
  });

  it("falls back to English difficulty name in history.stageName when no catalog is provided", () => {
    const tracker = new XpTracker(300);
    tracker.update(snap(1000));
    tracker.update({
      ...snap(1000),
      saveMtime: 1001,
      totalHeroExp: 200,
      heroes: [{ key: "101", level: 1, exp: 200, unlocked: true }],
    });

    const stats = buildStats(
      tracker,
      new ChestDropTracker(),
      new BoxOpenTracker(),
      new DpsTracker(),
      snap(1000),
      null,
    );
    expect(stats.history.length).toBeGreaterThan(0);
    // Without a catalog, stageName falls back to "Hell 2-5" via DIFFICULTIES
    // table — stageName() always returns a non-empty string. Verify the field is set.
    for (const entry of stats.history) {
      expect(typeof entry.stageName).toBe("string");
      expect(entry.stageName).toBe("Hell 2-5");
    }
  });
});
