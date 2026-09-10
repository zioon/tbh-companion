import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChestState } from "../../shared/types";

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
