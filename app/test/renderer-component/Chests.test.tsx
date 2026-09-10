import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock factories are hoisted above the imports, so the fixture must be
// created via vi.hoisted (otherwise the factory would read CHESTS in its TDZ).
const { CHESTS } = vi.hoisted(() => {
  const slot = (quantity: number, capacity: number) => ({
    quantity,
    capacity,
    isFull: capacity > 0 && quantity >= capacity,
    slotsRemaining: Math.max(0, capacity - quantity),
  });
  const breakdown = { base: 10, runeBonus: 0, purchasedCapRuneNodes: 0, runeLabel: "" };
  return {
    CHESTS: {
      rows: [],
      common: slot(1, 10),
      stageBoss: slot(2, 10),
      actBoss: slot(0, 10),
      plagueCommon: slot(0, 10),
      plagueRare: slot(0, 10),
      plagueAct: slot(0, 10),
      capacity: {
        common: breakdown,
        stageBoss: breakdown,
        actBoss: breakdown,
        plagueCommon: breakdown,
        plagueRare: breakdown,
        plagueAct: breakdown,
        totalRunePurchases: 0,
      },
      // Effective auto-open seconds (base − rune reduction) as the real save yields.
      autoOpen: {
        common: 261,
        stageBoss: 525,
        actBoss: 54,
        plagueCommon: 540,
        plagueRare: 1080,
        plagueAct: 105,
      },
      totalHeld: 3,
      saveMtime: 0,
      runeBonusSlots: 0,
    },
  };
});

vi.mock("../../src/renderer/lib/useChests", () => ({ useChests: () => CHESTS }));
vi.mock("../../src/renderer/lib/useBoxTimers", () => ({ useBoxTimers: () => null }));

import { Chests } from "../../src/renderer/tabs/Chests";

describe("Chests tab auto-open time", () => {
  it("renders the effective auto-open duration on each chest card", () => {
    render(<Chests />);
    // Card titles
    expect(screen.getByText("Common")).toBeInTheDocument();
    // Auto-open durations, formatted by fmtShortDuration
    expect(screen.getByText("Auto-open 4m21s")).toBeInTheDocument();
    expect(screen.getByText("Auto-open 8m45s")).toBeInTheDocument();
    expect(screen.getByText("Auto-open 54s")).toBeInTheDocument();
  });
});
