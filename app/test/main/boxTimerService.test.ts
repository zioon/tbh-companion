import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../src/main/services/broadcast", () => ({
  broadcast: vi.fn(),
}));

let userDataDir = "";

describe("BoxTimerService", () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "tbh-box-timers-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  async function loadService() {
    const { BoxTimerService } = await import("../../src/main/services/BoxTimerService");
    return new BoxTimerService();
  }

  it("defaults to four mid-game route boxes on first run", async () => {
    const svc = await loadService();
    const state = svc.getState();
    expect(state.enabledCount).toBe(4);
    expect(state.rows).toHaveLength(4);
    // Catalog covers all canonical RARE tracker routes. Box 1/2/3/6 phantom
    // tracker entries were removed, leaving 10 routes (Lv4/5/7/15/20/30/40/50/65/80).
    expect(state.catalog).toHaveLength(10);
    expect(state.defaultCooldownSeconds).toBe(720);
  });

  it("toggles enabled boxes and persists selection", async () => {
    const svc = await loadService();
    const enabled = svc.getState().rows.map((r) => r.boxId);
    svc.setEnabledBoxIds(enabled.filter((id) => id !== 920151));
    expect(svc.getState().enabledCount).toBe(3);

    const svc2 = await loadService();
    expect(svc2.getState().enabledCount).toBe(3);

    const raw = JSON.parse(readFileSync(join(userDataDir, "box_timers.json"), "utf-8")) as {
      enabledBoxIds: number[];
    };
    expect(raw.enabledBoxIds).not.toContain(920151);
  });

  it("replaces selection with setEnabledBoxIds", async () => {
    const svc = await loadService();
    // 920011 (Box 4) and 920051 (Box 5) are canonical tracker routes.
    // Box 1/2/3 (920001/920002/920003) had phantom trackers removed and are
    // no longer valid tracker box ids.
    svc.setEnabledBoxIds([920011, 920051]);
    expect(svc.getState().enabledCount).toBe(2);
    expect(svc.getState().rows.map((r) => r.boxId)).toEqual([920011, 920051]);
  });

  it("marks dropped boxes as cooldown then ready after clear", async () => {
    const svc = await loadService();
    svc.markDropped(920151);
    expect(svc.getState().rows.find((r) => r.boxId === 920151)?.status).toBe("cooldown");

    svc.clearTimer(920151);
    expect(svc.getState().rows.find((r) => r.boxId === 920151)?.status).toBe("ready");
  });

  it("stores per-box cooldown overrides", async () => {
    const svc = await loadService();
    svc.setCooldownSeconds(920151, 600);
    expect(svc.getState().rows.find((r) => r.boxId === 920151)?.cooldownSeconds).toBe(600);
    expect(svc.getState().rows.find((r) => r.boxId === 920151)?.cooldownIsCustom).toBe(true);

    svc.clearCooldownOverride(920151);
    expect(svc.getState().rows.find((r) => r.boxId === 920151)?.cooldownSeconds).toBe(720);
    expect(svc.getState().rows.find((r) => r.boxId === 920151)?.cooldownIsCustom).toBe(false);

    const raw = JSON.parse(readFileSync(join(userDataDir, "box_timers.json"), "utf-8")) as {
      cooldownSecondsByBoxId?: Record<string, number>;
    };
    expect(raw.cooldownSecondsByBoxId?.["920151"]).toBeUndefined();
  });

  it("includes drop stage range on catalog", async () => {
    const svc = await loadService();
    svc.setEnabledBoxIds([920501]);
    const entry = svc.getState().catalog.find((e) => e.boxId === 920501);
    expect(entry?.dropStageRangeLabel).toContain("Nightmare 3-5");
    expect(entry?.farmStageOptions.length).toBeGreaterThan(0);
  });

  it("stores per-box farm stage overrides", async () => {
    const svc = await loadService();
    svc.setEnabledBoxIds([920501]);
    const route = svc.getState().catalog.find((e) => e.boxId === 920501);
    const altStage = route?.farmStageOptions.find(
      (opt) => opt.stageKey !== route.defaultIdealStageKey,
    )?.stageKey;
    expect(altStage).toBeDefined();

    svc.setFarmStageKey(920501, altStage!);
    const row = svc.getState().rows.find((r) => r.boxId === 920501);
    expect(row?.idealStageKey).toBe(altStage);
    expect(svc.getState().catalog.find((e) => e.boxId === 920501)?.idealStageIsCustom).toBe(true);

    svc.clearFarmStageOverride(920501);
    expect(svc.getState().rows.find((r) => r.boxId === 920501)?.idealStageKey).toBe(
      route?.defaultIdealStageKey,
    );
  });

  it("marks dropped from live memory stage key for enabled tracked routes", async () => {
    const svc = await loadService();
    svc.setEnabledBoxIds([920801]);
    expect(svc.tryMarkDroppedFromLiveStage(4103)).toBe(true);
    expect(svc.getState().rows.find((r) => r.boxId === 920801)?.status).toBe("cooldown");
  });

  it("ignores live memory stage key when that box level is not tracked", async () => {
    const svc = await loadService();
    svc.setEnabledBoxIds([920151]);
    expect(svc.tryMarkDroppedFromLiveStage(4103)).toBe(false);
  });

  it("does not reset cooldown or re-fire callback on duplicate live stage drop", async () => {
    const onDropped = vi.fn();
    const svc = await loadService();
    svc.setEnabledBoxIds([920801]);
    svc.setCooldownSeconds(920801, 600);
    svc.setOnChestDropped(onDropped);

    vi.useFakeTimers();
    const t0 = Date.now();
    expect(svc.tryMarkDroppedFromLiveStage(4103)).toBe(true);
    expect(onDropped).toHaveBeenCalledTimes(1);
    const remainingAfterFirst = svc
      .getState()
      .rows.find((r) => r.boxId === 920801)!.remainingSeconds;

    // 30s later — a duplicate drop signal arrives (e.g. GetBox log burst).
    vi.setSystemTime(t0 + 30_000);
    expect(svc.tryMarkDroppedFromLiveStage(4103)).toBe(true);
    expect(onDropped).toHaveBeenCalledTimes(1); // not re-fired
    const remainingAfterSecond = svc
      .getState()
      .rows.find((r) => r.boxId === 920801)!.remainingSeconds;

    // Cooldown was NOT reset: remaining should be ~30s less, not back to 600.
    expect(remainingAfterSecond).toBeLessThan(remainingAfterFirst);
    expect(remainingAfterSecond).toBe(remainingAfterFirst - 30);
    vi.useRealTimers();
  });

  it("re-marks dropped after cooldown expires on a new live stage drop", async () => {
    const onDropped = vi.fn();
    const svc = await loadService();
    svc.setEnabledBoxIds([920801]);
    svc.setCooldownSeconds(920801, 60);
    svc.setOnChestDropped(onDropped);

    vi.useFakeTimers();
    const t0 = Date.now();
    svc.tryMarkDroppedFromLiveStage(4103);
    expect(onDropped).toHaveBeenCalledTimes(1);

    // After cooldown expires, a new drop should re-mark and re-fire.
    vi.setSystemTime(t0 + 61_000);
    svc.getState(); // expire + delete the timer
    expect(svc.tryMarkDroppedFromLiveStage(4103)).toBe(true);
    expect(onDropped).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("defaults notifyWhenReady to true and persists opt-out", async () => {
    const svc = await loadService();
    svc.setEnabledBoxIds([920151]);
    expect(svc.getState().catalog.find((e) => e.boxId === 920151)?.notifyWhenReady).toBe(true);

    svc.setBoxTrackerNotify(920151, false);
    expect(svc.getState().catalog.find((e) => e.boxId === 920151)?.notifyWhenReady).toBe(false);

    const svc2 = await loadService();
    expect(svc2.getState().catalog.find((e) => e.boxId === 920151)?.notifyWhenReady).toBe(false);
  });

  it("fires chest-ready callback once on cooldown transition", async () => {
    const onReady = vi.fn();
    const svc = await loadService();
    svc.setEnabledBoxIds([920151]);
    svc.setOnChestReady(onReady);
    svc.setCooldownSeconds(920151, 60);
    svc.markDropped(920151);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    svc.getState();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: 920151, level: expect.any(Number) }),
    );

    svc.getState();
    expect(onReady).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("fires chest-dropped callback when markDropped succeeds", async () => {
    const onDropped = vi.fn();
    const svc = await loadService();
    svc.setEnabledBoxIds([920151]);
    svc.setOnChestDropped(onDropped);
    svc.markDropped(920151);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: 920151, name: expect.any(String) }),
    );
  });

  it("does not fire chest-dropped for disabled routes", async () => {
    const onDropped = vi.fn();
    const svc = await loadService();
    svc.setEnabledBoxIds([]);
    svc.setOnChestDropped(onDropped);
    svc.markDropped(920151);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("does not fire chest-ready on cold load of expired timer", async () => {
    const svc = await loadService();
    svc.setEnabledBoxIds([920151]);
    svc.setCooldownSeconds(920151, 60);
    svc.markDropped(920151);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    svc.getState();

    const onReady = vi.fn();
    const svc2 = await loadService();
    svc2.setEnabledBoxIds([920151]);
    svc2.setOnChestReady(onReady);
    svc2.getState();
    expect(onReady).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("defaults sortOrder to cooldown-first and persists ready-first", async () => {
    const svc = await loadService();
    expect(svc.getState().sortOrder).toBe("cooldown-first");

    svc.setEnabledBoxIds([920151, 920201]);
    svc.markDropped(920151);
    const before = svc.getState().rows.map((r) => r.status);
    expect(before[0]).toBe("cooldown");

    svc.setSortOrder("ready-first");
    expect(svc.getState().sortOrder).toBe("ready-first");
    const after = svc.getState().rows.map((r) => r.status);
    expect(after[0]).toBe("ready");

    const raw = JSON.parse(readFileSync(join(userDataDir, "box_timers.json"), "utf-8")) as {
      sortOrder: string;
    };
    expect(raw.sortOrder).toBe("ready-first");

    const svc2 = await loadService();
    expect(svc2.getState().sortOrder).toBe("ready-first");
    expect(svc2.getState().rows[0]?.status).toBe("ready");
  });
});
