import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  AutoClassifyStatePayload,
  ChestState,
  LiveChestSlots,
} from "../../shared/types";
import { LootQueueSlots } from "../../src/renderer/components/loot/LootQueueSlots";

// Minimal AutoClassifyStatePayload with empty queue (no countdowns).
const EMPTY_QUEUE: AutoClassifyStatePayload = {
  enabled: true,
  totalQueued: 0,
  byCategory: [
    { category: "common", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "rare", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "act", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
  ],
  items: [],
};

/** Build a ChestState with per-category slot quantity/capacity. */
function makeChests(overrides: {
  common?: Partial<{ quantity: number; capacity: number; isFull: boolean; slotsRemaining: number }>;
  stageBoss?: Partial<{ quantity: number; capacity: number; isFull: boolean; slotsRemaining: number }>;
  actBoss?: Partial<{ quantity: number; capacity: number; isFull: boolean; slotsRemaining: number }>;
} = {}): ChestState {
  const slot = (o?: Partial<{ quantity: number; capacity: number; isFull: boolean; slotsRemaining: number }>) => ({
    quantity: o?.quantity ?? 0,
    capacity: o?.capacity ?? 0,
    isFull: o?.isFull ?? false,
    slotsRemaining: o?.slotsRemaining ?? 0,
  });
  return {
    rows: [],
    common: slot(overrides.common),
    stageBoss: slot(overrides.stageBoss),
    actBoss: slot(overrides.actBoss),
    capacity: {
      common: { base: 0, runeBonus: 0, purchasedCapRuneNodes: 0, runeLabel: "" },
      stageBoss: { base: 0, runeBonus: 0, purchasedCapRuneNodes: 0, runeLabel: "" },
      actBoss: { base: 0, runeBonus: 0, purchasedCapRuneNodes: 0, runeLabel: "" },
    },
  };
}

// Category label text (rendered via react-i18next under the en locale).
const CATEGORY_LABEL: Record<"common" | "rare" | "act", string> = {
  common: "Common chest",
  rare: "Stage boss chest",
  act: "Act boss chest",
};

// Find the row whose header text matches the category label.
function rowByLabel(labelKey: "common" | "rare" | "act"): HTMLElement {
  return screen.getByText(CATEGORY_LABEL[labelKey]).closest(".border-b")!;
}

/** Read the "X / Y" capacity text from a row. */
function capacityText(labelKey: "common" | "rare" | "act"): string {
  const row = rowByLabel(labelKey);
  // The capacity span carries aria-label "X of Y slots used".
  const span = row.querySelector('[aria-label$="slots used"]')!;
  return span.textContent ?? "";
}

describe("LootQueueSlots live/save merge", () => {
  it("prefers liveChestSlots quantity over save slot.quantity when available", () => {
    const chests = makeChests({
      common: { quantity: 2, capacity: 5, isFull: false, slotsRemaining: 3 },
      stageBoss: { quantity: 1, capacity: 3, isFull: false, slotsRemaining: 2 },
      actBoss: { quantity: 0, capacity: 1, isFull: false, slotsRemaining: 1 },
    });
    const liveChestSlots: LiveChestSlots = { common: 7, rare: 2, act: 0 };

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={chests}
        liveChestSlots={liveChestSlots}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
      />,
    );

    // Common: live=7 should win over save=2; capacity stays from save (5).
    expect(capacityText("common")).toBe("7 / 5");
    // Rare (stageBoss slot): live=2 should win over save=1; capacity stays (3).
    expect(capacityText("rare")).toBe("2 / 3");
    // Act: live=0 matches save=0; capacity stays (1).
    expect(capacityText("act")).toBe("0 / 1");
  });

  it("falls back to save slot.quantity when liveChestSlots is null", () => {
    const chests = makeChests({
      common: { quantity: 3, capacity: 5, isFull: false, slotsRemaining: 2 },
    });

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={chests}
        liveChestSlots={null}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
      />,
    );

    expect(capacityText("common")).toBe("3 / 5");
  });

  it("falls back to save slot.quantity when liveChestSlots prop is omitted", () => {
    const chests = makeChests({
      stageBoss: { quantity: 4, capacity: 6, isFull: false, slotsRemaining: 2 },
    });

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={chests}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
      />,
    );

    expect(capacityText("rare")).toBe("4 / 6");
  });

  it("shows the Full badge when live quantity reaches save capacity", () => {
    const chests = makeChests({
      common: { quantity: 1, capacity: 5, isFull: false, slotsRemaining: 4 },
    });
    // Live says 5/5 — should trigger Full badge even though save says 1/5.
    const liveChestSlots: LiveChestSlots = { common: 5, rare: 0, act: 0 };

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={chests}
        liveChestSlots={liveChestSlots}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
      />,
    );

    expect(capacityText("common")).toBe("5 / 5");
    // The Full badge renders the "Full" text under the en locale.
    expect(rowByLabel("common").textContent).toContain("Full");
  });

  it("renders 0 / 0 when both live and save are unavailable", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        liveChestSlots={null}
        dropsPerHour={{ common: null, rare: null, act: null }}
      />,
    );

    expect(capacityText("common")).toBe("0 / 0");
    expect(capacityText("rare")).toBe("0 / 0");
    expect(capacityText("act")).toBe("0 / 0");
  });
});
