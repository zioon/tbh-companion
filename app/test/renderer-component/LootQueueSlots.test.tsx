import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AutoClassifyStatePayload, ChestAutoOpenPrefs, ChestState } from "../../shared/types";
import type { PredictFillTimeResult } from "../../src/core/inventory/predictFillTime";
import { LootQueueSlots } from "../../src/renderer/components/loot/LootQueueSlots";

// Minimal AutoClassifyStatePayload with empty queue (no countdowns) and
// liveSlots=null (falls back to save slot.quantity).
const EMPTY_QUEUE: AutoClassifyStatePayload = {
  enabled: true,
  totalQueued: 0,
  byCategory: [
    { category: "common", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "rare", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "act", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
  ],
  items: [],
  liveSlots: null,
};

/** Build a ChestState with per-category slot quantity/capacity. */
function makeChests(
  overrides: {
    common?: Partial<{
      quantity: number;
      capacity: number;
      isFull: boolean;
      slotsRemaining: number;
    }>;
    stageBoss?: Partial<{
      quantity: number;
      capacity: number;
      isFull: boolean;
      slotsRemaining: number;
    }>;
    actBoss?: Partial<{
      quantity: number;
      capacity: number;
      isFull: boolean;
      slotsRemaining: number;
    }>;
  } = {},
): ChestState {
  const slot = (
    o?: Partial<{ quantity: number; capacity: number; isFull: boolean; slotsRemaining: number }>,
  ) => ({
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

const NO_AUTO_OPEN: ChestAutoOpenPrefs = { common: false, stageBoss: false };

// Category label text (rendered via react-i18next under the en locale).
const CATEGORY_LABEL: Record<"common" | "rare" | "act", string> = {
  common: "Common Treasure Chest",
  rare: "Stage Treasure Chest",
  act: "Act Boss Treasure Chest",
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

/** Read the "X / Y" capacity text from the inventory row. */
function inventoryCapacityText(): string | null {
  const span = document.querySelector('[aria-label$="inventory slots used"]');
  return span?.textContent ?? null;
}

describe("LootQueueSlots live/save merge", () => {
  it("prefers queue.liveSlots quantity over save slot.quantity when available", () => {
    const chests = makeChests({
      common: { quantity: 2, capacity: 5, isFull: false, slotsRemaining: 3 },
      stageBoss: { quantity: 1, capacity: 3, isFull: false, slotsRemaining: 2 },
      actBoss: { quantity: 0, capacity: 1, isFull: false, slotsRemaining: 1 },
    });
    const queue: AutoClassifyStatePayload = {
      ...EMPTY_QUEUE,
      liveSlots: { common: 7, rare: 2, act: 0 },
    };

    render(
      <LootQueueSlots
        queue={queue}
        chests={chests}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
        inventory={null}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    // Common: live=7 should win over save=2; capacity stays from save (5).
    expect(capacityText("common")).toBe("7 / 5");
    // Rare (stageBoss slot): live=2 should win over save=1; capacity stays (3).
    expect(capacityText("rare")).toBe("2 / 3");
    // Act: live=0 matches save=0; capacity stays (1).
    expect(capacityText("act")).toBe("0 / 1");
  });

  it("falls back to save slot.quantity when queue.liveSlots is null", () => {
    const chests = makeChests({
      common: { quantity: 3, capacity: 5, isFull: false, slotsRemaining: 2 },
    });

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={chests}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
        inventory={null}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    expect(capacityText("common")).toBe("3 / 5");
  });

  it("shows the Full badge when live quantity reaches save capacity", () => {
    const chests = makeChests({
      common: { quantity: 1, capacity: 5, isFull: false, slotsRemaining: 4 },
    });
    // Live says 5/5 — should trigger Full badge even though save says 1/5.
    const queue: AutoClassifyStatePayload = {
      ...EMPTY_QUEUE,
      liveSlots: { common: 5, rare: 0, act: 0 },
    };

    render(
      <LootQueueSlots
        queue={queue}
        chests={chests}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
        inventory={null}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
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
        dropsPerHour={{ common: null, rare: null, act: null }}
        inventory={null}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    expect(capacityText("common")).toBe("0 / 0");
    expect(capacityText("rare")).toBe("0 / 0");
    expect(capacityText("act")).toBe("0 / 0");
  });
});

describe("LootQueueSlots inventory row", () => {
  it("hides the inventory row when inventory is null", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: null, rare: null, act: null }}
        inventory={null}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    expect(inventoryCapacityText()).toBeNull();
  });

  it("hides the inventory row when inventoryCapacity is 0", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: null, rare: null, act: null }}
        inventory={{ inventoryCapacity: 0, inventoryUsed: 0 }}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    expect(inventoryCapacityText()).toBeNull();
  });

  it("renders inventory used/capacity from inventory prop", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: null, rare: null, act: null }}
        inventory={{ inventoryCapacity: 50, inventoryUsed: 12 }}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    expect(inventoryCapacityText()).toBe("12 / 50");
  });

  it("shows the Live-tab prompt when auto-open is off for both chest types", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: null, rare: null, act: null }}
        inventory={{ inventoryCapacity: 50, inventoryUsed: 12 }}
        autoOpenEnabled={NO_AUTO_OPEN}
        fillPrediction={null}
      />,
    );

    // The inventory full-in text falls back to the "turn on Live tab" message
    // under the en locale (key `queueSlots.inventoryTurnOn`).
    expect(screen.getByText(/Enable an auto-open toggle on the Live tab/i)).toBeTruthy();
  });

  it("renders the predicted fill duration + ETA when auto-open is on and prediction is available", () => {
    const prediction: PredictFillTimeResult = {
      slotsRemaining: 38,
      heldChestItems: 0,
      steadyItemsPerHour: 10,
      hoursUntilFull: 3.5,
    };

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
        inventory={{ inventoryCapacity: 50, inventoryUsed: 12 }}
        autoOpenEnabled={{ common: true, stageBoss: false }}
        fillPrediction={prediction}
      />,
    );

    // fmtHoursUntilFull(3.5) -> "3.5 hours" appears inside the fillText span.
    expect(screen.getAllByText(/3\.5 hours/i).length).toBeGreaterThan(0);
  });

  it("shows the Full badge and — when inventory is already full", () => {
    const prediction: PredictFillTimeResult = {
      slotsRemaining: 0,
      heldChestItems: 0,
      steadyItemsPerHour: 0,
      hoursUntilFull: 0,
    };

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
        inventory={{ inventoryCapacity: 50, inventoryUsed: 50 }}
        autoOpenEnabled={{ common: true, stageBoss: false }}
        fillPrediction={prediction}
      />,
    );

    // The inventory row shows the Full badge next to the "Inventory items" label.
    const inventoryLabel = screen.getByText("Inventory items");
    const inventoryRow = inventoryLabel.closest(".border-t")!;
    expect(inventoryRow.textContent).toContain("Full");
    // The fillText span shows "—" because the Full badge already conveys the
    // state. The row contains the em dash somewhere in the fill-in area.
    expect(inventoryRow.textContent).toContain("—");
  });

  it("shows — when auto-open is on but prediction returns null (will never fill)", () => {
    const prediction: PredictFillTimeResult = {
      slotsRemaining: 38,
      heldChestItems: 0,
      steadyItemsPerHour: 0,
      hoursUntilFull: null,
    };

    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={null}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
        inventory={{ inventoryCapacity: 50, inventoryUsed: 12 }}
        autoOpenEnabled={{ common: true, stageBoss: false }}
        fillPrediction={prediction}
      />,
    );

    // The inventory row's fill-in text shows the em dash placeholder.
    const inventoryLabel = screen.getByText("Inventory items");
    const inventoryRow = inventoryLabel.closest(".border-t")!;
    expect(inventoryRow.textContent).toContain("—");
  });
});
