import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LiveMemorySnapshot, SaveSnapshot } from "../../shared/types";
import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";
import type { LocaleCatalog } from "../../src/core/localeCatalog";
import type { GameItem } from "../../src/core/gamedata";

vi.mock("../../src/main/saveWatcher", () => ({
  SaveWatcher: class {
    constructor(opts: { onSnapshot: (snap: SaveSnapshot) => void }) {
      onSnapshot = opts.onSnapshot;
    }
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../../src/main/services/broadcast", () => ({
  broadcast: vi.fn(),
}));

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../src/main/historyLog", () => ({
  makeHistoryLogger: vi.fn(),
}));

import { TrackingService } from "../../src/main/services/TrackingService";
import { broadcast } from "../../src/main/services/broadcast";

const baseConfig = {
  savePath: "C:/game/save.es3",
  es3Password: "x",
  pollIntervalSeconds: 5,
  rollingWindowMinutes: 5,
  topmost: { main: true, overlay: true, boxTracker: true },
  logHistoryCsv: false,
  currency: "USD",
  notificationsEnabled: true,
  notifyOnUpdateAvailable: true,
  notificationVolume: 100,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
  inventoryAlmostFullThresholdPercent: 90,
  chestAutoOpenEnabled: { common: false, stageBoss: false },
  marketAutoScanEnabled: true,
  marketLowValueThresholdUsd: 0.05,
  lootAutoClassifyEnabled: false,
  lootRingSeconds: { common: 300, stage: 420 },
  liveMemory: { enabled: false, consentAccepted: false },
  language: "auto" as const,
};

let onSnapshot: ((snap: SaveSnapshot) => void) | undefined;

function snap(level: number, mtime = 100, heroExp = 100): SaveSnapshot {
  return {
    heroes: [{ key: "101", level, exp: heroExp, unlocked: true }],
    totalHeroExp: heroExp,
    playTime: 0,
    saveMtime: mtime,
    stageKey: 3205,
    stageWave: 1,
    maxStage: 0,
    gold: 0,
  };
}

describe("TrackingService hero level-up callback", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("does not fire on the first snapshot", () => {
    const onHeroLevelUp = vi.fn();
    const svc = new TrackingService(vi.fn(), undefined, undefined, undefined, onHeroLevelUp);
    svc.start(baseConfig);
    onSnapshot?.(snap(5));
    expect(onHeroLevelUp).not.toHaveBeenCalled();
    svc.stop();
  });

  it("fires when a hero level increases on a later snapshot", () => {
    const onHeroLevelUp = vi.fn();
    const svc = new TrackingService(vi.fn(), undefined, undefined, undefined, onHeroLevelUp);
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 100));
    onSnapshot?.(snap(6, 101));
    expect(onHeroLevelUp).toHaveBeenCalledTimes(1);
    expect(onHeroLevelUp).toHaveBeenCalledWith([{ key: "101", previousLevel: 5, newLevel: 6 }]);
    svc.stop();
  });

  it("batches multiple hero level-ups from one snapshot into a single callback", () => {
    const onHeroLevelUp = vi.fn();
    const svc = new TrackingService(vi.fn(), undefined, undefined, undefined, onHeroLevelUp);
    svc.start(baseConfig);
    onSnapshot?.({
      ...snap(5, 100),
      heroes: [
        { key: "101", level: 5, exp: 100, unlocked: true },
        { key: "201", level: 2, exp: 50, unlocked: true },
      ],
    });
    onSnapshot?.({
      ...snap(6, 101),
      heroes: [
        { key: "101", level: 6, exp: 10, unlocked: true },
        { key: "201", level: 3, exp: 5, unlocked: true },
      ],
    });
    expect(onHeroLevelUp).toHaveBeenCalledTimes(1);
    expect(onHeroLevelUp).toHaveBeenCalledWith([
      { key: "101", previousLevel: 5, newLevel: 6 },
      { key: "201", previousLevel: 2, newLevel: 3 },
    ]);
    svc.stop();
  });
});

describe("TrackingService.reset vs clearSession", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("reset() clears chest drops and rates, preserves box opens", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    // Seed loot directly via the trackers (bypasses aggregator timing).
    svc.getChestDropTracker().recordLogDrop(910151, 3000);
    svc.getChestDropTracker().recordLogDrop(910151, 3100);
    svc.getBoxOpenTracker().recordOpen("common:5", 100, "Sword", "COMMON", 1, 3500);

    const before = svc.getStats();
    expect(before.chestDrops.combinedTotal).toBe(2);
    expect(before.boxOpens.reduce((s, b) => s + b.totalOpens, 0)).toBe(1);

    svc.reset();

    const after = svc.getStats();
    // Chest drops wiped (Live page drop log resets to zero).
    expect(after.chestDrops.combinedTotal).toBe(0);
    expect(after.chestDrops.commonTotal).toBe(0);
    expect(after.chestDrops.commonPerHour).toBe(0);
    // Box opens preserved (Loot tab history spans session resets).
    expect(after.boxOpens.reduce((s, b) => s + b.totalOpens, 0)).toBe(1);
    // Rates cleared (no heroes/gold means 0 rates).
    expect(after.sessionRate).toBe(0);
    expect(after.goldRate).toBe(0);
    svc.stop();
  });

  it("clearSession() wipes chest drops and box opens along with rates", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    svc.getChestDropTracker().recordLogDrop(910151, 3000);
    svc.getBoxOpenTracker().recordOpen("common:5", 100, "Sword", "COMMON", 1, 3500);

    svc.clearSession();

    const after = svc.getStats();
    expect(after.chestDrops.combinedTotal).toBe(0);
    expect(after.boxOpens).toHaveLength(0);
    expect(after.sessionRate).toBe(0);
    svc.stop();
  });
});

describe("TrackingService.resolveBoxOpenEntry grade", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("uses runtime gradeType over catalog grade when available", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    // Same itemKey but different runtime gradeType (0=COMMON, 2=RARE).
    // Without gameDataLookup, name falls back to #itemKey but grade must
    // come from runtime gradeType, not null.
    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 3205,
      stageWave: 1,
      gold: null,
      heroes: null,
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: [
        { itemKey: 530017, boxType: 0, level: 5, gradeType: 0 },
        { itemKey: 530017, boxType: 0, level: 5, gradeType: 2 },
      ],
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);

    // Verify the tracker recorded both opens with distinct grades.
    const trackerStats = svc.getBoxOpenTracker().getStats(3600, () => null);
    expect(trackerStats).toHaveLength(1);
    const breakdown = trackerStats[0].breakdown;
    expect(breakdown).toHaveLength(2);
    const grades = breakdown.map((r) => r.grade).sort();
    expect(grades).toEqual(["COMMON", "RARE"]);
    svc.stop();
  });

  it("falls back to catalog grade when gradeType is undefined", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 3205,
      stageWave: 1,
      gold: null,
      heroes: null,
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: [{ itemKey: 530017, boxType: 0, level: 5 }],
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);

    const trackerStats = svc.getBoxOpenTracker().getStats(3600, () => null);
    expect(trackerStats).toHaveLength(1);
    expect(trackerStats[0].breakdown).toHaveLength(1);
    expect(trackerStats[0].breakdown[0].grade).toBeNull();
    svc.stop();
  });
});

describe("TrackingService.onLiveMemoryToggled", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("clears inflated session stats and re-seeds from the last save snapshot", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));
    onSnapshot?.(snap(5, 1060, 600)); // +600 XP

    // Simulate corrupted session totals from a prior live/save mix.
    const tracker = svc.getTracker();
    tracker.applySnapshot({
      ...tracker.captureSnapshot(),
      cumulativeGained: 8e28,
      sessionRateValue: 8e28,
    });

    svc.onLiveMemoryToggled();

    expect(svc.getTracker().cumulativeGained).toBe(0);
    expect(svc.getTracker().rollingRate).toBe(0);
    expect(svc.getStats().cumulativeGained).toBe(0);
  });

  it("feeds live heroes into the tracker for XP rate sampling", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 3205,
      stageWave: 1,
      gold: 1000,
      heroes: [{ heroKey: 101, level: 5, exp: 500 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);
    svc.ingestLiveFrame({
      ...frame,
      at: 3000,
      heroes: [{ heroKey: 101, level: 5, exp: 1100 }],
    });

    expect(svc.getTracker().cumulativeGained).toBe(600);
    expect(svc.getTracker().rollingRate).toBeGreaterThan(0);
  });

  it("records chest drops from the live GetBox log by category", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 3205,
      stageWave: 1,
      gold: null,
      heroes: null,
      chestDrops: ["common", "rare"],
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);
    svc.ingestLiveFrame({ ...frame, chestDrops: ["common"], at: 3000 });
    // Flush the second tick's pending buffer (aggregator collapses bursts
    // after a 0.5s silence — without this empty tick the second ["common"]
    // would still be buffered and not yet recorded).
    svc.ingestLiveFrame({ ...frame, chestDrops: [], at: 3700 });

    const stats = svc.getStats().chestDrops;
    expect(stats.commonTotal).toBe(2);
    expect(stats.rareTotal).toBe(1);
    expect(stats.combinedTotal).toBe(3);
  });

  it("fires onLiveStageBossDrop only for rare live chest drops with a stage key", () => {
    const onLiveStageBossDrop = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageBossDrop,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: null,
      heroes: null,
      chestDrops: ["common", "rare"],
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);
    svc.ingestLiveFrame({ ...frame, chestDrops: ["common"], at: 3000 });

    expect(onLiveStageBossDrop).toHaveBeenCalledTimes(1);
    expect(onLiveStageBossDrop).toHaveBeenCalledWith(4103);
    svc.stop();
  });

  it("collapses a per-tick GetBox burst to one drop per category", () => {
    const onLiveStageBossDrop = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageBossDrop,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: null,
      heroes: null,
      // A single common drop emits a burst of common entries.
      chestDrops: ["common", "common", "common"],
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);
    // Empty tick >0.5s later flushes the burst (aggregator collapses bursts
    // only after a silence gap — without this the buffer stays pending).
    svc.ingestLiveFrame({ ...frame, chestDrops: [], at: 2700 });

    const stats = svc.getStats().chestDrops;
    expect(stats.commonTotal).toBe(1);
    expect(stats.rareTotal).toBe(0);
    expect(onLiveStageBossDrop).not.toHaveBeenCalled();
  });

  it("suppresses a stray rare singleton riding a common-chest burst", () => {
    const onLiveStageBossDrop = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageBossDrop,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: null,
      heroes: null,
      // One common drop, but the burst carries a stray "rare" entry.
      chestDrops: ["common", "rare", "common", "common"],
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);
    // Empty tick >0.5s later flushes the burst so collapse runs.
    svc.ingestLiveFrame({ ...frame, chestDrops: [], at: 2700 });

    const stats = svc.getStats().chestDrops;
    expect(stats.commonTotal).toBe(1);
    expect(stats.rareTotal).toBe(0);
    expect(onLiveStageBossDrop).not.toHaveBeenCalled();
  });

  it("records a rare burst as one stage-boss drop and fires onLiveStageBossDrop once", () => {
    const onLiveStageBossDrop = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageBossDrop,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: null,
      heroes: null,
      chestDrops: ["rare", "rare", "rare"],
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);
    // Empty tick >0.5s later flushes the burst so collapse runs.
    svc.ingestLiveFrame({ ...frame, chestDrops: [], at: 2700 });

    const stats = svc.getStats().chestDrops;
    expect(stats.rareTotal).toBe(1);
    expect(stats.commonTotal).toBe(0);
    expect(onLiveStageBossDrop).toHaveBeenCalledTimes(1);
    expect(onLiveStageBossDrop).toHaveBeenCalledWith(4103);
  });

  it("fires onLiveStageClear on the first clear with 0 XP/gold when the baseline is primed in the same frame", () => {
    // Edge case: the very first live frame already carries a clear (e.g. the
    // StageClearLog had a backlog entry that survived pin-priming). The baseline
    // is primed from the current xp/gold BEFORE the clear is diffed, so the
    // diff is 0. The clear is still recorded (stageKey + clearTimeSec) — this
    // is the fix for "启动 app 后打了一关，记录一直不出现" (first clear was
    // silently dropped before the baseline-priming fix).
    const onLiveStageClear = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageClear,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: 1000,
      heroes: [{ heroKey: 101, level: 5, exp: 500 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: [{ act: 1, stage: 3, clearTimeSec: 42 }],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);

    // Baseline primed in the same frame → diff = 0, but the clear is recorded.
    expect(onLiveStageClear).toHaveBeenCalledTimes(1);
    expect(onLiveStageClear).toHaveBeenCalledWith(4103, 42, 0, 0);
    svc.stop();
  });

  it("fires onLiveStageClear on every clear with XP/gold gained since the previous clear", () => {
    const onLiveStageClear = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageClear,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    svc.ingestLiveFrame({
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: 1000,
      heroes: [{ heroKey: 101, level: 5, exp: 500 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: [{ act: 1, stage: 3, clearTimeSec: 42 }],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    });

    svc.ingestLiveFrame({
      connected: true,
      stageKey: 4103,
      stageWave: 1,
      gold: 1400,
      heroes: [{ heroKey: 101, level: 5, exp: 900 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: [
        { act: 1, stage: 3, clearTimeSec: 85 },
        { act: 1, stage: 3, clearTimeSec: 63 },
      ],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 3000,
    });

    // First clear: baseline primed in the same frame → diff = 0.
    // Two more clears in the next frame: diff = (900-500, 1400-1000) = (400, 400),
    // split evenly (one sample per tick).
    expect(onLiveStageClear).toHaveBeenCalledTimes(3);
    expect(onLiveStageClear).toHaveBeenNthCalledWith(1, 4103, 42, 0, 0);
    expect(onLiveStageClear).toHaveBeenNthCalledWith(2, 4103, 85, 200, 200);
    expect(onLiveStageClear).toHaveBeenNthCalledWith(3, 4103, 63, 200, 200);
    svc.stop();
  });

  it("does not fire onLiveStageClear when no stageKey is resolved", () => {
    const onLiveStageClear = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageClear,
    );
    svc.start(baseConfig);

    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: null,
      stageWave: null,
      gold: null,
      heroes: null,
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: [{ act: 0, stage: 0, clearTimeSec: 85 }],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);

    expect(onLiveStageClear).not.toHaveBeenCalled();
    svc.stop();
  });

  it("attributes a clear to the log entry's act/stage, not the already-advanced live stageKey", () => {
    // Regression test for the off-by-one stage attribution bug: when a clear
    // of Hell 3-1 (stageKey=3301) arrived, the reader's next tick already saw
    // stageKey=3302 (the next stage) and recorded the clear against Hell 3-2.
    // The fix reads act/stage from the StageClearLog entry itself and
    // combines them with the difficulty digit of the live stageKey.
    const onLiveStageClear = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageClear,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    // First frame: prime the baseline (no clear, no callback fires).
    svc.ingestLiveFrame({
      connected: true,
      stageKey: 3301, // Hell 3-1 — the stage being cleared
      stageWave: 1,
      gold: 1000,
      heroes: [{ heroKey: 101, level: 5, exp: 500 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    });

    // Second frame: the reader now sees stageKey=3302 (Hell 3-2, already
    // advanced), but the new StageClearLog entry still carries act=3/stage=1
    // (the stage that was actually cleared). The recorded stageKey must be
    // 3301, NOT 3302.
    svc.ingestLiveFrame({
      connected: true,
      stageKey: 3302, // Hell 3-2 — stage has already advanced
      stageWave: 1,
      gold: 1400,
      heroes: [{ heroKey: 101, level: 5, exp: 900 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: [{ act: 3, stage: 1, clearTimeSec: 85 }],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 3000,
    });

    expect(onLiveStageClear).toHaveBeenCalledTimes(1);
    expect(onLiveStageClear).toHaveBeenCalledWith(3301, 85, 400, 400);
    svc.stop();
  });

  it("falls back to the live stageKey when the log entry's act/stage are 0 (corrupted read)", () => {
    const onLiveStageClear = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageClear,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));

    // First frame: prime the baseline (no clear).
    svc.ingestLiveFrame({
      connected: true,
      stageKey: 3301,
      stageWave: 1,
      gold: 1000,
      heroes: [{ heroKey: 101, level: 5, exp: 500 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    });

    svc.ingestLiveFrame({
      connected: true,
      stageKey: 3301,
      stageWave: 1,
      gold: 1400,
      heroes: [{ heroKey: 101, level: 5, exp: 900 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: [{ act: 0, stage: 0, clearTimeSec: 85 }],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 3000,
    });

    // act/stage=0 ⇒ fall back to the live stageKey (3301).
    expect(onLiveStageClear).toHaveBeenCalledTimes(1);
    expect(onLiveStageClear).toHaveBeenCalledWith(3301, 85, 400, 400);
    svc.stop();
  });
});

describe("TrackingService live-frame broadcast throttling", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function liveFrame(at: number): LiveMemorySnapshot {
    return {
      connected: true,
      stageKey: 3205,
      stageWave: 1,
      gold: 1000,
      heroes: [{ heroKey: 101, level: 5, exp: 500 }],
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at,
    };
  }

  it("drops broadcasts that arrive faster than the throttle interval", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    vi.clearAllMocks(); // svc.start()/onSnapshot side effects already broadcast once

    svc.ingestLiveFrame(liveFrame(1000));
    expect(broadcast).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(40); // ~25 Hz tick, well under the 200ms throttle
    svc.ingestLiveFrame(liveFrame(1040));
    vi.advanceTimersByTime(40);
    svc.ingestLiveFrame(liveFrame(1080));

    expect(broadcast).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it("broadcasts again once the throttle interval elapses", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    vi.clearAllMocks();

    svc.ingestLiveFrame(liveFrame(1000));
    expect(broadcast).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    svc.ingestLiveFrame(liveFrame(1200));

    expect(broadcast).toHaveBeenCalledTimes(2);
    svc.stop();
  });
});

describe("TrackingService with LocaleCatalog", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  // stageKey 3205 -> Hell 2-5; catalog key "1205" (1 + act + stage w/ leading zero)
  // heroKey "101" -> Knight (default English fallback)
  const zhCatalog: LocaleCatalog = {
    items: {},
    stages: { "1205": "牧场" },
    heroes: { "101": "骑士" },
    difficulties: {},
  };

  it("defaults to emptyLocaleCatalog when no catalog is provided", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 100, 100));

    // English fallbacks: stage "Hell 2-5", hero "Knight"
    const stats = svc.getStats();
    expect(stats.stageName).toBe("Hell 2-5");
    expect(stats.heroes.find((h) => h.key === "101")?.name).toBe("Knight");
    svc.stop();
  });

  it("uses initialCatalog passed to the constructor to localize names", () => {
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      zhCatalog,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 100, 100));

    const stats = svc.getStats();
    expect(stats.stageName).toBe("牧场");
    expect(stats.heroes.find((h) => h.key === "101")?.name).toBe("骑士");
    svc.stop();
  });

  it("setLocaleCatalog swaps the catalog used by getStats", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 100, 100));

    // Before swap: English fallbacks
    expect(svc.getStats().stageName).toBe("Hell 2-5");

    svc.setLocaleCatalog(zhCatalog);

    // After swap: localized names without needing a new snapshot
    const stats = svc.getStats();
    expect(stats.stageName).toBe("牧场");
    expect(stats.heroes.find((h) => h.key === "101")?.name).toBe("骑士");
    svc.stop();
  });

  it("has setLocaleCatalog method", () => {
    const svc = new TrackingService(vi.fn());
    expect(typeof svc.setLocaleCatalog).toBe("function");
  });

  it("localizes box-open history/breakdown names when setLocaleCatalog is called", () => {
    // gamedata has the English name; catalog provides the zh-CN translation
    // keyed by String(item.id). The Loot tab reads boxOpenStats.history[i].itemName
    // and breakdown[i].name — both must reflect the current LocaleCatalog.
    const gameDataLookup = new Map<number, GameItem>([
      [
        530017,
        {
          id: 530017,
          name: "Goblin Hide",
          grade: "COMMON",
          type: "MATERIAL",
          level: null,
          marketTradable: true,
        },
      ],
    ]);
    const zhItemsCatalog: LocaleCatalog = {
      items: { "530017": "哥布林兽皮" },
      stages: {},
      heroes: {},
      difficulties: {},
    };

    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 100, 100));
    svc.setGameDataLookup(gameDataLookup);

    // Emit a box-open drop. Without a catalog, name should be English.
    const frame: LiveMemorySnapshot = {
      connected: true,
      stageKey: 3205,
      stageWave: 1,
      gold: null,
      heroes: null,
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      stageWaveTotal: null,
      boxOpens: [{ itemKey: 530017, boxType: 0, level: 5, gradeType: 0 }],
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);

    // Before catalog swap: English name.
    let stats = svc.getStats().boxOpens;
    expect(stats[0].breakdown[0].name).toBe("Goblin Hide");
    expect(stats[0].history[0].itemName).toBe("Goblin Hide");

    // Swap to zh-CN catalog — runReResolveNames should re-localize the
    // existing history/breakdown without needing a new drop.
    svc.setLocaleCatalog(zhItemsCatalog);
    stats = svc.getStats().boxOpens;
    expect(stats[0].breakdown[0].name).toBe("哥布林兽皮");
    expect(stats[0].history[0].itemName).toBe("哥布林兽皮");
    svc.stop();
  });
});
