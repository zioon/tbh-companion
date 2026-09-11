import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LiveMemorySnapshot, LookupPriceSnapshot, SaveSnapshot } from "../../shared/types";
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
  lootRingSeconds: { common: 300, stage: 420, plagueCommon: 300, plagueRare: 420, plagueAct: 3600 },
  liveMemory: { enabled: false, consentAccepted: false },
  lookupPricePolling: { enabled: false, intervalMinutes: 10, thresholdUsd: 1.0, watchedHashes: [] },
  marketHistoryBatchSize: 10,
  marketHistoryBatchDelaySec: 120,
  marketHistoryCoverageThreshold: 0.95,
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
    expect(before.boxOpens.reduce((s, b) => s + b.totalItems, 0)).toBe(1);

    svc.reset();

    const after = svc.getStats();
    // Chest drops wiped (Live page drop log resets to zero).
    expect(after.chestDrops.combinedTotal).toBe(0);
    expect(after.chestDrops.commonTotal).toBe(0);
    expect(after.chestDrops.commonPerHour).toBe(0);
    // Box opens preserved (Loot tab history spans session resets).
    expect(after.boxOpens.reduce((s, b) => s + b.totalItems, 0)).toBe(1);
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
      stageAlive: null,
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
    const trackerStats = svc.getBoxOpenTracker().getStats(() => null);
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
      stageAlive: null,
      boxOpens: [{ itemKey: 530017, boxType: 0, level: 5 }],
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 2000,
    };
    svc.ingestLiveFrame(frame);

    const trackerStats = svc.getBoxOpenTracker().getStats(() => null);
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
      stageAlive: null,
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
      stageAlive: null,
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
      stageAlive: null,
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
      stageAlive: null,
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

  it("keeps a lone rare entry riding a common-chest burst (prevents missed boss drops)", () => {
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
      stageAlive: null,
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

    // A lone rare entry is a real stage-boss chest (a boss chest can produce a
    // single GetBoxLog entry); keeping it fires onLiveStageBossDrop once. The
    // old "suppress singleton" behavior dropped real boss drops.
    const stats = svc.getStats().chestDrops;
    expect(stats.commonTotal).toBe(1);
    expect(stats.rareTotal).toBe(1);
    expect(onLiveStageBossDrop).toHaveBeenCalledTimes(1);
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
      stageAlive: null,
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
      stageClears: [{ act: 1, stage: 3, clearTimeSec: 42, valid: true }],
      stageWaveTotal: null,
      stageAlive: null,
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
      stageClears: [{ act: 1, stage: 3, clearTimeSec: 42, valid: true }],
      stageWaveTotal: null,
      stageAlive: null,
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
        { act: 1, stage: 3, clearTimeSec: 85, valid: true },
        { act: 1, stage: 3, clearTimeSec: 63, valid: true },
      ],
      stageWaveTotal: null,
      stageAlive: null,
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
      stageClears: [{ act: 0, stage: 0, clearTimeSec: 85, valid: false }],
      stageWaveTotal: null,
      stageAlive: null,
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
      stageAlive: null,
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
      stageClears: [{ act: 3, stage: 1, clearTimeSec: 85, valid: true }],
      stageWaveTotal: null,
      stageAlive: null,
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

  it("drops a clear whose log entry's act/stage are 0 (corrupted read) instead of falling back to the live stageKey", () => {
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
      stageAlive: null,
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
      stageClears: [{ act: 0, stage: 0, clearTimeSec: 85, valid: false }],
      stageWaveTotal: null,
      stageAlive: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 3000,
    });

    // Invalid entries (act/stage unreadable — mid-write race / corrupted
    // memory) are dropped by the filter in TrackingService. Attributing them
    // to the live stageKey would re-introduce the off-by-one attribution bug:
    // by the time we poll the next tick, stageKey has already advanced past
    // the cleared stage, so the fallback would attribute the clear to the
    // wrong (next) stage. Better to lose one event than misattribute it.
    expect(onLiveStageClear).not.toHaveBeenCalled();
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
      stageAlive: null,
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
      stageAlive: null,
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

describe("TrackingService wave from StageManager alive when monsterHp is unavailable", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("advances currentWave via updateAlive when monsterHp is null (v1.01.05)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    function frame(at: number, stageAlive: number): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        // Drifted StageManager runtimeWave offset reads 0 on v1.01.05 — the
        // live stageWave must NOT be trusted, so stats falls back to the
        // DpsTracker estimate driven by stageAlive below.
        stageWave: 0,
        stageWaveTotal: 31,
        stageAlive,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: null,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // First live frame: alive=3 → wave estimate 1.
    svc.ingestLiveFrame(frame(1000, 3));
    expect(svc.getStats().stageWave).toBe(1);

    // Wave cleared: alive 3 → 0 → 3 → estimate 2.
    svc.ingestLiveFrame(frame(1040, 0));
    svc.ingestLiveFrame(frame(1080, 3));
    expect(svc.getStats().stageWave).toBe(2);

    svc.stop();
  });

  it("seeds the wave counter from the save wave when live tracking starts mid-run", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    // The save snapshot says the current run is on wave 20 (mid-run attach).
    onSnapshot?.({
      heroes: [{ key: "101", level: 5, exp: 100, unlocked: true }],
      totalHeroExp: 100,
      playTime: 0,
      saveMtime: 100,
      stageKey: 3205,
      stageWave: 20,
      maxStage: 0,
      gold: 0,
    });

    function frame(
      at: number,
      monsterHps: Array<[number, number, number]> | null,
      stageKey = 3205,
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey,
        stageWave: 0, // drifted runtimeWave on v1.01.05 — estimate drives the UI
        stageWaveTotal: 31,
        stageAlive: monsterHps == null ? 0 : monsterHps.length,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: monsterHps,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // First live frame lands mid-run with monsters on the field: the estimate
    // must continue from the save wave (20), not restart from 1.
    svc.ingestLiveFrame(frame(1000, [[100, 50, 100]]));
    expect(svc.getStats().stageWave).toBe(20);

    // Wave clear → next wave: 21 (not 2).
    svc.ingestLiveFrame(frame(1040, []));
    svc.ingestLiveFrame(frame(1080, [[100, 50, 100]]));
    expect(svc.getStats().stageWave).toBe(21);

    // A later stage change starts a fresh run: count from 1, do NOT re-seed
    // the old save wave (20) onto the new stage.
    svc.ingestLiveFrame(frame(2000, [[100, 50, 100]], 3320));
    expect(svc.getStats().stageWave).toBe(1);

    svc.stop();
  });

  it("defers the wave seed until the first save read when the save lags live attach", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    // Real startup order: the first live frame (~40 ms after attach) lands
    // BEFORE the save watcher's first poll (5s) delivers a snapshot.

    function frame(
      at: number,
      monsterHps: Array<[number, number, number]> | null,
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0, // drifted runtimeWave — estimate drives the UI
        stageWaveTotal: 31,
        stageAlive: monsterHps == null ? 0 : monsterHps.length,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: monsterHps,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // First live frame without any save snapshot: counts from wave 1 for now.
    svc.ingestLiveFrame(frame(1000, [[100, 50, 100]]));
    expect(svc.getStats().stageWave).toBe(1);

    // The first save poll lands 5s later with the run on wave 20 — the
    // deferred seed fires now and the estimate jumps to the real wave.
    onSnapshot?.({
      heroes: [{ key: "101", level: 5, exp: 100, unlocked: true }],
      totalHeroExp: 100,
      playTime: 0,
      saveMtime: 100,
      stageKey: 3205,
      stageWave: 20,
      maxStage: 0,
      gold: 0,
    });
    expect(svc.getStats().stageWave).toBe(20);

    // A later save poll must NOT re-seed over the live counter.
    onSnapshot?.({
      heroes: [{ key: "101", level: 5, exp: 100, unlocked: true }],
      totalHeroExp: 100,
      playTime: 0,
      saveMtime: 100,
      stageKey: 3205,
      stageWave: 25,
      maxStage: 0,
      gold: 0,
    });
    expect(svc.getStats().stageWave).toBe(20);

    svc.stop();
  });

  it("starts from wave 1 when the save has no static wave to seed", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.({
      heroes: [{ key: "101", level: 5, exp: 100, unlocked: true }],
      totalHeroExp: 100,
      playTime: 0,
      saveMtime: 100,
      stageKey: 3205,
      stageWave: 0, // save doesn't carry a wave (e.g. never entered a stage)
      maxStage: 0,
      gold: 0,
    });

    function frame(
      at: number,
      monsterHps: Array<[number, number, number]> | null,
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0,
        stageWaveTotal: 31,
        stageAlive: monsterHps == null ? 0 : monsterHps.length,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: monsterHps,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    svc.ingestLiveFrame(frame(1000, [[100, 50, 100]]));
    expect(svc.getStats().stageWave).toBe(1);

    svc.stop();
  });

  it("resets the wave counter when alive hits 0 at the stage total (wave-total run-end catch)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    function frame(at: number, stageAlive: number): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0, // drifted runtimeWave
        stageWaveTotal: 31,
        stageAlive,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: null,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // Wave 1.
    svc.ingestLiveFrame(frame(1000, 3));
    expect(svc.getStats().stageWave).toBe(1);

    // Advance 30 wave-clear cycles (alive 3 → 0 → 3). Each 0 frame increments
    // wavesCleared; after 30 clears with monsters alive the estimate = 31.
    for (let w = 0; w < 30; w++) {
      svc.ingestLiveFrame(frame(1100 + w, 0)); // wave cleared
      svc.ingestLiveFrame(frame(1100 + w + 1, 3)); // next wave alive
    }
    expect(svc.getStats().stageWave).toBe(31);

    // Last wave clears: alive 3 → 0 with currentWave 31 >= stageWaveTotal 31.
    // The wave-total run-end catch fires and resets the counter — without it
    // the estimate would stay 31 and the next run would start at 32 instead
    // of 1 (the "stuck at 31/31" symptom on fast auto-retry builds).
    svc.ingestLiveFrame(frame(3000, 0));
    expect(svc.getStats().stageWave).toBe(1); // fallback to save (reset to 0)

    // Next run's first wave: back at wave 1, not 32.
    svc.ingestLiveFrame(frame(3001, 3));
    expect(svc.getStats().stageWave).toBe(1);

    svc.stop();
  });

  it("resets the wave counter at a run boundary detected via sustained alive=0 (missed stage-clear fallback)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    function frame(at: number, stageAlive: number): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 1209,
        stageWave: 0, // drifted runtimeWave on v1.01.05
        stageWaveTotal: 16,
        stageAlive,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: null,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // Wave 1.
    svc.ingestLiveFrame(frame(1000, 3));
    expect(svc.getStats().stageWave).toBe(1);

    // One wave cleared.
    svc.ingestLiveFrame(frame(1001, 0));
    expect(svc.getStats().stageWave).toBe(1); // 1 cleared + 0 alive

    // alive stays 0 for > 2s (settlement screen) — marks the run finished
    // even though no stage-clear event arrived (log tailer missed it).
    svc.ingestLiveFrame(frame(4000, 0));
    expect(svc.getStats().stageWave).toBe(1); // cleared + 0 alive

    // New run spawns monsters → wave counter resets and starts at 1 again,
    // instead of accumulating to 2.
    svc.ingestLiveFrame(frame(4001, 3));
    expect(svc.getStats().stageWave).toBe(1);

    svc.stop();
  });

  it("records a stage-run failure when the party leaves without a clear (wave >= 2)", () => {
    const onLiveStageFail = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageFail,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const party: LiveMemorySnapshot["heroes"] = [{ heroKey: 101, level: 5, exp: 500 }];
    function frame(
      at: number,
      stageAlive: number,
      heroes: LiveMemorySnapshot["heroes"],
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0, // drifted runtimeWave
        stageWaveTotal: 31,
        stageAlive,
        gold: null,
        heroes,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: null,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // Wave 1 → wave 2, then the party withdraws (run ends) with no stage-clear
    // in between — a failed run. The withdrawal is debounced: the party must
    // stay absent for WITHDRAW_CONFIRM_MS (400ms) before the run is confirmed
    // ended (see StageRunFailDetector).
    svc.ingestLiveFrame(frame(1000, 3, party));
    svc.ingestLiveFrame(frame(1001, 0, party)); // wave cleared
    svc.ingestLiveFrame(frame(1200, 3, party)); // wave 2 begins
    svc.ingestLiveFrame(frame(1201, 0, party)); // wave 2 cleared → waves=2
    svc.ingestLiveFrame(frame(2000, 0, null)); // heroes gone — debounce starts
    svc.ingestLiveFrame(frame(2500, 0, null)); // still absent 500ms later → confirmed

    expect(onLiveStageFail).toHaveBeenCalledTimes(1);
    expect(onLiveStageFail).toHaveBeenCalledWith(3205, 2);

    // A fresh run heals the detector — a menu gap without a deployed hero must
    // not re-fire (no prior run in flight).
    svc.ingestLiveFrame(frame(2600, 0, null));
    svc.ingestLiveFrame(frame(2900, 0, null));
    expect(onLiveStageFail).toHaveBeenCalledTimes(1);

    svc.stop();
  });

  it("does not record a failure when the run ended by clearing the stage", () => {
    const onLiveStageFail = vi.fn();
    const onLiveStageClear = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageClear,
      onLiveStageFail,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    function frame(
      at: number,
      stageAlive: number,
      stageClears: LiveMemorySnapshot["stageClears"] = null,
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0,
        stageWaveTotal: 31,
        stageAlive,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears,
        boxOpens: null,
        petData: null,
        monsterHp: null,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // Clear the stage (records a win) then the settlement alive=0 lasts past
    // the run-end threshold.
    svc.ingestLiveFrame(frame(1000, 3, [{ act: 2, stage: 5, clearTimeSec: 42, valid: true }]));
    svc.ingestLiveFrame(frame(1001, 0));
    svc.ingestLiveFrame(frame(4000, 0));

    expect(onLiveStageClear).toHaveBeenCalledTimes(1);
    // A successful clear must never be misread as a failure.
    expect(onLiveStageFail).not.toHaveBeenCalled();

    svc.stop();
  });

  it("resets the wave counter to 1 when the party withdraws (fast retry)", () => {
    const onLiveStageFail = vi.fn();
    const svc = new TrackingService(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onLiveStageFail,
    );
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const party: LiveMemorySnapshot["heroes"] = [{ heroKey: 101, level: 5, exp: 500 }];
    function frame(
      at: number,
      stageAlive: number,
      heroes: LiveMemorySnapshot["heroes"],
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0,
        stageWaveTotal: 31,
        stageAlive,
        gold: null,
        heroes,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp: null,
        deadMonsterCount: null,
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // Two waves cleared, then the party leaves (run ends) without a clear.
    // The withdrawal is confirmed only after the party stays absent for
    // WITHDRAW_CONFIRM_MS (400ms) — a single blank tick is treated as read noise.
    svc.ingestLiveFrame(frame(1000, 3, party));
    svc.ingestLiveFrame(frame(1001, 0, party));
    svc.ingestLiveFrame(frame(1200, 3, party));
    svc.ingestLiveFrame(frame(1201, 0, party));
    svc.ingestLiveFrame(frame(2000, 0, null)); // heroes gone — debounce starts
    svc.ingestLiveFrame(frame(2500, 0, null)); // still absent 500ms later → confirmed

    expect(onLiveStageFail).toHaveBeenCalledTimes(1); // judged a failure at wave 2
    expect(onLiveStageFail).toHaveBeenCalledWith(3205, 2);

    // A fast retry re-deploys the party: the wave counter must be back at 1,
    // not continuing to accumulate from the failed run.
    svc.ingestLiveFrame(frame(2600, 3, party));
    expect(svc.getStats().stageWave).toBe(1);

    svc.stop();
  });

  it("drives alive to 0 and infers kills from vanished monsters when deadMonsterCount is stuck at 0 (v1.01.05)", () => {
    // v1.01.05: monsterList@0x28 is readable (real HP data) but the dead-monster
    // list offset isn't derived → deadMonsterCount stays 0. The DpsTracker must
    // (a) still show alive → 0 when the monster array empties between waves, and
    // (b) infer monster kills from the number of monsters that vanished.
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    function frame(
      at: number,
      monsterHp: Array<[number, number, number]> | null,
    ): LiveMemorySnapshot {
      return {
        connected: true,
        stageKey: 3205,
        stageWave: 0,
        stageWaveTotal: 31,
        stageAlive: 0,
        gold: null,
        heroes: null,
        chestDrops: null,
        chestSlots: null,
        inventoryItems: null,
        stageClears: null,
        boxOpens: null,
        petData: null,
        monsterHp,
        deadMonsterCount: 0, // stuck at 0 — dead list offset not derived
        source: "memory test",
        readMs: 1,
        at,
      };
    }

    // Wave 1: three monsters appear (full HP).
    svc.ingestLiveFrame(
      frame(1000, [
        [0xd00000, 50, 100],
        [0xd10000, 60, 100],
        [0xd20000, 70, 100],
      ]),
    );
    expect(svc.getStats().aliveMonsters).toBe(3);

    // Monsters take damage.
    svc.ingestLiveFrame(
      frame(1020, [
        [0xd00000, 10, 100],
        [0xd10000, 20, 100],
        [0xd20000, 30, 100],
      ]),
    );
    expect(svc.getStats().aliveMonsters).toBe(3);

    // All three killed → array empties → alive must drop to 0 (not stay 3).
    svc.ingestLiveFrame(frame(1040, []));
    expect(svc.getStats().aliveMonsters).toBe(0);
    // The three vanished monsters are inferred as kills.
    expect(svc.getStats().sessionMobsKilled).toBe(3);
    expect(svc.getStats().mapMobsKilled).toBe(3);

    // Wave 2: new monsters spawn (new addresses) — alive rises again.
    svc.ingestLiveFrame(
      frame(1060, [
        [0xe00000, 80, 100],
        [0xe10000, 90, 100],
      ]),
    );
    expect(svc.getStats().aliveMonsters).toBe(2);

    // Kill one more → inferred kill count increments.
    svc.ingestLiveFrame(frame(1080, [[0xe10000, 90, 100]]));
    expect(svc.getStats().aliveMonsters).toBe(1);
    expect(svc.getStats().sessionMobsKilled).toBe(4);

    svc.stop();
  });
});

describe("TrackingService.setRuneWaveReduction", () => {
  it("coerces non-positive or non-finite input to 0", () => {
    const svc = new TrackingService(vi.fn());
    svc.setRuneWaveReduction(-3);
    svc.setRuneWaveReduction(NaN);
    // No stats surface to assert on; just ensure it does not throw and stays 0.
    svc.setRuneWaveReduction(0);
    svc.stop();
  });

  it("does not reset the value on live-memory toggle", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setRuneWaveReduction(3);
    svc.onLiveMemoryToggled();
    // Subsequent ingest must still apply the reduction — verified in T3's ingest tests.
    svc.stop();
  });
});

describe("TrackingService.ingestLiveFrame rune wave reduction", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  function frame(stageWaveTotal: number, at = 1000): LiveMemorySnapshot {
    return {
      connected: true,
      stageKey: 3205,
      stageWave: 0,
      stageWaveTotal,
      stageAlive: 0,
      gold: null,
      heroes: null,
      chestDrops: null,
      chestSlots: null,
      inventoryItems: null,
      stageClears: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at,
    };
  }

  it("leaves the total unchanged when reduction is 0", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.ingestLiveFrame(frame(31));
    expect(svc.getStats().stageWaveTotal).toBe(31);
    svc.stop();
  });

  it("subtracts the rune reduction from the live stage total", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setRuneWaveReduction(3);
    svc.ingestLiveFrame(frame(31));
    expect(svc.getStats().stageWaveTotal).toBe(28);
    svc.stop();
  });

  it("subtracts the rune reduction from the live stage total, applied once per value", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setRuneWaveReduction(2);
    svc.setRuneWaveReduction(2); // same value — must not double-apply
    svc.ingestLiveFrame(frame(31));
    expect(svc.getStats().stageWaveTotal).toBe(29);
    svc.stop();
  });

  it("clamps the total to 1 when reduction exceeds the live total", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setRuneWaveReduction(3);
    svc.ingestLiveFrame(frame(2));
    expect(svc.getStats().stageWaveTotal).toBe(1);
    svc.stop();
  });

  it("does not modify the caller's frame object in place", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setRuneWaveReduction(3);
    const input = frame(31);
    svc.ingestLiveFrame(input);
    expect(input.stageWaveTotal).toBe(31); // original preserved
    svc.stop();
  });

  it("skips reduction when the live total is null or 0", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setRuneWaveReduction(3);
    svc.ingestLiveFrame({ ...frame(0), stageWaveTotal: null });
    expect(svc.getStats().stageWaveTotal).toBe(0);
    svc.stop();
  });

  it("applies reduction to the run-end reset judgement (currentWave >= effective total)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));
    svc.setRuneWaveReduction(3);

    // Live total 31 → effective total 28. Establish wave 1, then advance the
    // DpsTracker estimate to 28 (27 wave-clears + a live alive-0 frame while
    // wave 28 is cleared). alive=0 with currentWave == 28 >= effective 28 must
    // fire the run-end reset.
    svc.ingestLiveFrame({ ...frame(31, 1000), stageAlive: 3 }); // wave 1
    for (let w = 0; w < 27; w++) {
      const at = 1100 + w;
      svc.ingestLiveFrame({ ...frame(31, at), stageAlive: 0 });
      svc.ingestLiveFrame({ ...frame(31, at + 1), stageAlive: 3 });
    }
    expect(svc.getStats().stageWave).toBe(28);

    // Last wave clears: alive 3 → 0 with currentWave 28 >= effective total 28.
    svc.ingestLiveFrame({ ...frame(31, 3000), stageAlive: 0 });
    // Run-end reset fired → wave counter back to 0 (fallback to save wave 1).
    expect(svc.getStats().stageWave).toBe(1);

    // Next run's first wave spawns monsters → back at wave 1, not 29.
    svc.ingestLiveFrame({ ...frame(31, 3001), stageAlive: 3 });
    expect(svc.getStats().stageWave).toBe(1);
    svc.stop();
  });
});

describe("TrackingService box-open fallback price (lookup snapshot currency)", () => {
  // A priceable MATERIAL: market hash = display name, no grade suffix.
  const MATERIAL: GameItem = {
    id: 1001,
    name: "Test Material",
    grade: "COMMON",
    type: "MATERIAL",
    gearType: null,
    level: null,
    marketTradable: true,
  };
  const HASH = "Test Material";
  const SNAPSHOT = (over: Partial<LookupPriceSnapshot> = {}): LookupPriceSnapshot => ({
    schemaVersion: 1,
    generatedUtc: "2026-01-01T00:00:00.000Z",
    baseCurrency: "USD",
    prices: { [HASH]: 0.03 },
    fx: { USD: 1, CNY: 7.1 },
    ...over,
  });

  function recordDropAndGetUnit(svc: TrackingService): number | null {
    svc
      .getBoxOpenTracker()
      .recordOpen("rare:1", MATERIAL.id, MATERIAL.name, MATERIAL.grade, 1, 1.0);
    const box = svc.getStats().boxOpens.find((b) => b.boxKey === "rare:1");
    return box?.breakdown[0]?.buyOrderUnit ?? null;
  }

  it("uses the USD snapshot price as-is when the display currency is USD", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setGameDataLookup(new Map([[MATERIAL.id, MATERIAL]]));
    svc.setLookupPriceSnapshot(SNAPSHOT());
    expect(recordDropAndGetUnit(svc)).toBeCloseTo(0.03, 5);
    svc.stop();
  });

  it("converts the USD snapshot price to the user currency via fx (CNY)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setCurrency("CNY");
    svc.setGameDataLookup(new Map([[MATERIAL.id, MATERIAL]]));
    svc.setLookupPriceSnapshot(SNAPSHOT());
    // $0.03 × 7.1 ≈ ¥0.213 — not the raw 0.03 mislabeled as CNY.
    expect(recordDropAndGetUnit(svc)).toBeCloseTo(0.213, 5);
    svc.stop();
  });

  it("prefers the local-currency polling buy-order price over the USD fx conversion", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    svc.setCurrency("CNY");
    svc.setGameDataLookup(new Map([[MATERIAL.id, MATERIAL]]));
    svc.setLookupPriceSnapshot(SNAPSHOT({ buyOrderLocal: { [HASH]: 0.5 }, localCurrency: "CNY" }));
    expect(recordDropAndGetUnit(svc)).toBeCloseTo(0.5, 5);
    svc.stop();
  });
});
