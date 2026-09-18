import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChestState } from "../../shared/types";

// ChestService reads the userData dir via electron's app.getPath for the
// session-scope state file. Point it at a throwaway temp dir so tests neither
// pollute the repo cwd nor read a developer's real state file.
const tmpUserData = mkdtempSync(join(tmpdir(), "tbh-chest-service-test-"));
vi.mock("electron", () => ({
  app: { getPath: (_name: string) => tmpUserData },
}));

// Mock the boxes module so we can control buildChestState output without
// loading real catalog files from disk. vi.hoisted ensures the mock fn is
// initialized before vi.mock's hoisted factory runs.
const { mockBuildChestState, mockParseRuneSaveData } = vi.hoisted(() => ({
  mockBuildChestState: vi.fn(),
  mockParseRuneSaveData: vi.fn(() => [] as Array<{ runeKey: number; level: number }>),
}));
vi.mock("../../src/core/boxes", () => ({
  buildChestState: mockBuildChestState,
  loadBoxTypeCatalog: vi.fn(() => ({})),
  loadRuneBoxCapCatalog: vi.fn(() => ({})),
  loadRuneAutoOpenCatalog: vi.fn(() => ({})),
  parseRuneSaveData: mockParseRuneSaveData,
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

import { ChestService } from "../../src/main/services/ChestService";

function makeChestState(
  common: number,
  stageBoss: number,
  actBoss: number,
  plagueCommon = 0,
  plagueRare = 0,
  plagueAct = 0,
): ChestState {
  const cap = { base: 10, runeBonus: 0, purchasedCapRuneNodes: 0, runeLabel: "" };
  return {
    rows: [],
    common: {
      quantity: common,
      capacity: 10,
      isFull: common >= 10,
      slotsRemaining: 10 - common,
    },
    stageBoss: {
      quantity: stageBoss,
      capacity: 5,
      isFull: stageBoss >= 5,
      slotsRemaining: 5 - stageBoss,
    },
    actBoss: {
      quantity: actBoss,
      capacity: 3,
      isFull: actBoss >= 3,
      slotsRemaining: 3 - actBoss,
    },
    plagueCommon: {
      quantity: plagueCommon,
      capacity: 5,
      isFull: plagueCommon >= 5,
      slotsRemaining: 5 - plagueCommon,
    },
    plagueRare: {
      quantity: plagueRare,
      capacity: 5,
      isFull: plagueRare >= 5,
      slotsRemaining: 5 - plagueRare,
    },
    plagueAct: {
      quantity: plagueAct,
      capacity: 5,
      isFull: plagueAct >= 5,
      slotsRemaining: 5 - plagueAct,
    },
    capacity: {
      common: cap,
      stageBoss: cap,
      actBoss: cap,
      plagueCommon: cap,
      plagueRare: cap,
      plagueAct: cap,
      totalRunePurchases: 0,
    },
    autoOpen: {
      common: 300,
      stageBoss: 600,
      actBoss: 60,
      plagueCommon: 600,
      plagueRare: 1200,
      plagueAct: 120,
    },
    totalHeld: common + stageBoss + actBoss + plagueCommon + plagueRare + plagueAct,
    saveMtime: 1000,
    runeBonusSlots: 0,
  };
}

describe("ChestService.setOnReconcile", () => {
  beforeEach(() => {
    mockBuildChestState.mockReset();
  });

  it("fires reconcile with current per-category slot counts on every save", () => {
    mockBuildChestState
      .mockReturnValueOnce(makeChestState(3, 2, 1))
      .mockReturnValueOnce(makeChestState(1, 2, 0));

    const service = new ChestService();
    const calls: Array<{
      common: number;
      rare: number;
      act: number;
      plagueCommon: number;
      plagueRare: number;
      plagueAct: number;
    }> = [];
    service.setOnReconcile((slots) => calls.push({ ...slots }));

    service.onSave("text1", 1000, []);
    service.onSave("text2", 2000, []);
    expect(calls).toEqual([
      { common: 3, rare: 2, act: 1, plagueCommon: 0, plagueRare: 0, plagueAct: 0 },
      { common: 1, rare: 2, act: 0, plagueCommon: 0, plagueRare: 0, plagueAct: 0 },
    ]);
  });

  it("maps stageBoss slot to 'rare' category", () => {
    mockBuildChestState.mockReturnValueOnce(makeChestState(0, 5, 0));

    const service = new ChestService();
    let captured: {
      common: number;
      rare: number;
      act: number;
      plagueCommon: number;
      plagueRare: number;
      plagueAct: number;
    } | null = null;
    service.setOnReconcile((slots) => {
      captured = { ...slots };
    });

    service.onSave("text1", 1000, []);
    expect(captured).toEqual({
      common: 0,
      rare: 5,
      act: 0,
      plagueCommon: 0,
      plagueRare: 0,
      plagueAct: 0,
    });
  });

  it("does not fire when no callback is registered", () => {
    mockBuildChestState.mockReturnValueOnce(makeChestState(3, 0, 0));

    const service = new ChestService();
    // No setOnReconcile call — should not throw.
    expect(() => {
      service.onSave("text1", 1000, []);
    }).not.toThrow();
  });

  it("does not fire when buildChestState throws", () => {
    mockBuildChestState.mockImplementationOnce(() => {
      throw new Error("parse failed");
    });

    const service = new ChestService();
    const calls: number[] = [];
    service.setOnReconcile(() => calls.push(1));

    // Should not throw; reconcile is skipped.
    expect(() => service.onSave("text1", 1000, [])).not.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("ChestService.setLiveSlots", () => {
  beforeEach(() => {
    mockBuildChestState.mockReset();
  });

  it("does not reconcile on repeated null live slots (v1.2.2 save fallback)", () => {
    // Regression: `null` live slots must be a no-op once the override is already
    // null. Previously the `unchanged` check required `slots != null`, so every
    // null live frame (~25Hz) re-reconciled against the LAST SAVE (stale) and
    // excess-pruned freshly live-enqueued drops, re-anchoring their countdown to
    // the save-catch-up time ("opens in" drifts slow).
    mockBuildChestState.mockReturnValueOnce(makeChestState(1, 0, 0));

    const service = new ChestService();
    const calls: number[] = [];
    service.setOnReconcile(() => calls.push(1));

    service.onSave("text1", 1000, []);
    service.setLiveSlots(null);
    service.setLiveSlots(null);
    service.setLiveSlots(null);

    expect(calls).toHaveLength(1);
  });

  it("reconciles only when live slot counts actually change", () => {
    const service = new ChestService();
    const calls: Array<{ common: number; rare: number }> = [];
    service.setOnReconcile((slots) => calls.push({ common: slots.common, rare: slots.rare }));

    service.setLiveSlots({
      common: 1,
      rare: 0,
      act: 0,
      plagueCommon: 0,
      plagueRare: 0,
      plagueAct: 0,
    });
    service.setLiveSlots({
      common: 1,
      rare: 0,
      act: 0,
      plagueCommon: 0,
      plagueRare: 0,
      plagueAct: 0,
    });
    service.setLiveSlots({
      common: 2,
      rare: 0,
      act: 0,
      plagueCommon: 0,
      plagueRare: 0,
      plagueAct: 0,
    });

    expect(calls).toEqual([
      { common: 1, rare: 0 },
      { common: 2, rare: 0 },
    ]);
  });

  it("falls back to the save once when live slots become null, then stays quiet", () => {
    mockBuildChestState.mockReturnValue(makeChestState(2, 0, 0));

    const service = new ChestService();
    const calls: Array<{ common: number; rare: number }> = [];
    service.setOnReconcile((slots) => calls.push({ common: slots.common, rare: slots.rare }));

    service.onSave("text1", 1000, []);
    service.setLiveSlots({
      common: 1,
      rare: 0,
      act: 0,
      plagueCommon: 0,
      plagueRare: 0,
      plagueAct: 0,
    });
    service.setLiveSlots(null);
    service.setLiveSlots(null);

    expect(calls).toEqual([
      { common: 2, rare: 0 },
      { common: 1, rare: 0 },
      { common: 2, rare: 0 },
    ]);
  });
});

describe("ChestService.getRunePurchases", () => {
  beforeEach(() => {
    mockBuildChestState.mockReset();
  });

  it("returns the purchases parsed from the latest save", () => {
    mockParseRuneSaveData.mockReturnValue([{ runeKey: 1171, level: 1 }]);
    const service = new ChestService();

    service.onSave("text", 1000, []);
    expect(service.getRunePurchases()).toEqual([{ runeKey: 1171, level: 1 }]);
  });
});

describe("ChestService session-scope act ghost filter", () => {
  beforeEach(() => {
    // Start each test from a clean persisted state (the earlier describes in
    // this file already created one in the shared temp dir).
    for (const f of readdirSync(tmpUserData)) unlinkSync(join(tmpUserData, f));
    mockBuildChestState.mockReset();
    // Map filtered holdings to a ChestState whose actBoss.quantity is the
    // number of surviving act entries.
    mockBuildChestState.mockImplementation((chests: Array<{ category?: string }>) => {
      const act = chests.filter((c) => c.category === "act").length;
      return makeChestState(0, 0, act);
    });
  });

  function actHolding(uid: string) {
    return {
      type: 930901,
      quantity: 1,
      category: "act" as const,
      label: "Act Boss Box",
      uniqueId: uid,
    };
  }

  it("first run excludes pre-existing act entries (legacy provenance)", () => {
    const service = new ChestService();
    const slots: Array<{ act: number }> = [];
    service.setOnReconcile((s) => slots.push({ act: s.act }));
    // text carries the game version the filter parses.
    service.onSave('{"version":"1.2.4"}', 1000, [actHolding("ghost1")]);
    expect(slots).toEqual([{ act: 0 }]);
    expect(service.getChests()?.orphanExclusions).toEqual({ act: 1 });
  });

  it("same-session act drops are counted; after a version boundary the stale ones drop out", () => {
    const service = new ChestService();
    const slots: Array<{ act: number }> = [];
    service.setOnReconcile((s) => slots.push({ act: s.act }));

    // First parse: legacy entry excluded.
    service.onSave('{"version":"1.2.4"}', 1000, [actHolding("ghost1")]);
    // Second parse same session: a fresh act drop joins and is counted.
    service.onSave('{"version":"1.2.4"}', 1100, [actHolding("ghost1"), actHolding("fresh1")]);
    expect(slots).toEqual([{ act: 0 }, { act: 1 }]);
    expect(service.getChests()?.orphanExclusions).toEqual({ act: 1 });

    // Game upgrade (version change) => new session: the previously fresh
    // entry is now pre-session and excluded (the game did not restore it).
    service.onSave('{"version":"1.2.5"}', 1200, [actHolding("ghost1"), actHolding("fresh1")]);
    expect(slots).toEqual([{ act: 0 }, { act: 1 }, { act: 0 }]);
  });

  it("persists session state across service restarts (no re-exclusion within a session)", () => {
    const first = new ChestService();
    // First-ever parse: the pre-existing entry is legacy → excluded.
    first.onSave('{"version":"1.2.4"}', 1000, [actHolding("fresh1")]);
    expect(first.getChests()?.actBoss.quantity).toBe(0);
    // A fresh drop in the same parse sequence is counted.
    first.onSave('{"version":"1.2.4"}', 1100, [actHolding("fresh1"), actHolding("fresh2")]);
    expect(first.getChests()?.actBoss.quantity).toBe(1);

    // Simulate an app restart: a new instance reads the persisted state,
    // stays in the same session, so the mid-session entry is still counted
    // and the legacy entry stays excluded.
    const second = new ChestService();
    second.onSave('{"version":"1.2.4"}', 1200, [actHolding("fresh1"), actHolding("fresh2")]);
    expect(second.getChests()?.actBoss.quantity).toBe(1);
    expect(second.getChests()?.orphanExclusions).toEqual({ act: 1 });
  });
});

describe("ChestService game-anchor session boundary", () => {
  beforeEach(() => {
    for (const f of readdirSync(tmpUserData)) unlinkSync(join(tmpUserData, f));
    mockBuildChestState.mockReset();
    mockBuildChestState.mockImplementation((chests: Array<{ category?: string }>) => {
      const act = chests.filter((c) => c.category === "act").length;
      return makeChestState(0, 0, act);
    });
  });

  function actHolding(uid: string) {
    return {
      type: 930901,
      quantity: 1,
      category: "act" as const,
      label: "Act Boss Box",
      uniqueId: uid,
    };
  }

  it("a relaunch anchor change excludes pre-restart act entries even with a short save gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "tbh-anchor-"));
    const anchor = join(dir, "Player-prev.log");
    writeFileSync(anchor, "log");
    utimesSync(anchor, 1_700_000_000, 1_700_000_000);

    const service = new ChestService();
    service.setSavePath(join(dir, "SaveFile_Live.es3"));
    const text = '{"version":"1.2.4"}';
    const slots: Array<{ act: number }> = [];
    service.setOnReconcile((s) => slots.push({ act: s.act }));

    // Parse 1 (first run): the pre-existing entry is legacy → excluded.
    service.onSave(text, 1_000, [actHolding("a1")]);
    // Parse 2 (same game session): a fresh drop counts.
    service.onSave(text, 1_060, [actHolding("a1"), actHolding("a2")]);

    // The game relaunches 25 min later — below SESSION_GAP_SEC, so only the
    // anchor can see it. The pre-restart entries are now ghost-like.
    utimesSync(anchor, 1_700_002_000, 1_700_002_000);
    service.onSave(text, 1_060 + 25 * 60, [actHolding("a1"), actHolding("a2")]);
    // Post-relaunch drop counts again.
    service.onSave(text, 1_060 + 25 * 60 + 60, [
      actHolding("a1"),
      actHolding("a2"),
      actHolding("a3"),
    ]);

    expect(slots.map((s) => s.act)).toEqual([0, 1, 0, 1]);
    expect(service.getChests()?.orphanExclusions).toEqual({ act: 2 });
  });
});
