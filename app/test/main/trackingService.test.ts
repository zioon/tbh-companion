import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LiveMemorySnapshot, SaveSnapshot } from "../../shared/types";
import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";

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
  startTopmost: true,
  logHistoryCsv: false,
  currency: "USD",
  notificationsEnabled: true,
  notifyOnUpdateAvailable: true,
  notificationVolume: 100,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
  inventoryAlmostFullThresholdPercent: 90,
  chestAutoOpenEnabled: { common: false, stageBoss: false },
  lootAutoClassifyEnabled: false,
  liveMemory: { enabled: false, consentAccepted: false },
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

  it("reset() preserves chest drops and box opens while clearing rates", () => {
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
    // Loot preserved.
    expect(after.chestDrops.combinedTotal).toBe(2);
    expect(after.chestDrops.commonTotal).toBe(2);
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

    const stats = svc.getStats().chestDrops;
    expect(stats.rareTotal).toBe(1);
    expect(stats.commonTotal).toBe(0);
    expect(onLiveStageBossDrop).toHaveBeenCalledTimes(1);
    expect(onLiveStageBossDrop).toHaveBeenCalledWith(4103);
  });

  it("seeds the baseline on the first clear (unknown true start) without firing onLiveStageClear", () => {
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
      inventoryItems: null,
      stageClears: [42],
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

  it("fires onLiveStageClear from the second clear onward with XP/gold gained since the previous clear", () => {
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
      inventoryItems: null,
      stageClears: [42],
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
      inventoryItems: null,
      stageClears: [85, 63],
      stageWaveTotal: null,
      boxOpens: null,
      petData: null,
      monsterHp: null,
      deadMonsterCount: null,
      source: "memory test",
      readMs: 1,
      at: 3000,
    });

    // Two clears in one frame split the frame's XP/gold delta evenly (one sample per tick).
    expect(onLiveStageClear).toHaveBeenCalledTimes(2);
    expect(onLiveStageClear).toHaveBeenNthCalledWith(1, 4103, 85, 200, 200);
    expect(onLiveStageClear).toHaveBeenNthCalledWith(2, 4103, 63, 200, 200);
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
      inventoryItems: null,
      stageClears: [85],
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
