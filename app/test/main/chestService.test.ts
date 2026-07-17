import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChestState } from "../../shared/types";

// Mock the boxes module so we can control buildChestState output without
// loading real catalog files from disk. vi.hoisted ensures the mock fn is
// initialized before vi.mock's hoisted factory runs.
const { mockBuildChestState } = vi.hoisted(() => ({ mockBuildChestState: vi.fn() }));
vi.mock("../../src/core/boxes", () => ({
  buildChestState: mockBuildChestState,
  loadBoxTypeCatalog: vi.fn(() => ({})),
  loadRuneBoxCapCatalog: vi.fn(() => ({})),
  loadRuneAutoOpenCatalog: vi.fn(() => ({})),
  parseRuneSaveData: vi.fn(() => []),
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

function makeChestState(common: number, stageBoss: number, actBoss: number): ChestState {
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
    capacity: {
      common: cap,
      stageBoss: cap,
      actBoss: cap,
      totalRunePurchases: 0,
    },
    autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
    totalHeld: common + stageBoss + actBoss,
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
    const calls: Array<{ common: number; rare: number; act: number }> = [];
    service.setOnReconcile((slots) => calls.push({ ...slots }));

    service.onSave("text1", 1000, []);
    service.onSave("text2", 2000, []);
    expect(calls).toEqual([
      { common: 3, rare: 2, act: 1 },
      { common: 1, rare: 2, act: 0 },
    ]);
  });

  it("maps stageBoss slot to 'rare' category", () => {
    mockBuildChestState.mockReturnValueOnce(makeChestState(0, 5, 0));

    const service = new ChestService();
    let captured: { common: number; rare: number; act: number } | null = null;
    service.setOnReconcile((slots) => {
      captured = { ...slots };
    });

    service.onSave("text1", 1000, []);
    expect(captured).toEqual({ common: 0, rare: 5, act: 0 });
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
