import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { LiveMemorySnapshot } from "../../shared/types";
import { EntityPanelProvider } from "../../src/renderer/context/EntityPanelProvider";

// Live memory snapshot is mutated per test via this hoisted ref.
const state = vi.hoisted(() => ({ live: null as LiveMemorySnapshot | null }));

const baseStats = {
  rollingRate: 0,
  goldRate: 0,
  sessionRate: 0,
  cumulativeGained: 0,
  goldGained: 0,
  elapsed: 0,
  stageKey: 1010,
  stageName: "MAP:1010",
  stageWave: 1,
  secondsSinceGain: 10,
  status: "Tracking",
  chestDrops: {
    commonTotal: 0,
    rareTotal: 0,
    combinedTotal: 0,
    commonPerHour: 0,
    rarePerHour: 0,
    commonSession: 0,
    rareSession: 0,
    actSession: 0,
    combinedSession: 0,
    readerRequired: true,
    breakdown: [],
    history: [],
  },
  heroes: [],
  history: [],
};

vi.mock("../../src/renderer/lib/useStats", () => ({ useStats: () => baseStats }));
vi.mock("../../src/renderer/lib/useInventory", () => ({ useInventory: () => null }));
vi.mock("../../src/renderer/lib/useChests", () => ({ useChests: () => null }));
vi.mock("../../src/renderer/lib/useStageRuns", () => ({ useStageRuns: () => null }));
vi.mock("../../src/renderer/lib/useLiveMemory", () => ({
  useLiveMemory: () => ({ snapshot: state.live, status: null }),
  useLiveMemoryScalars: () => {
    const live = state.live;
    return {
      connected: live?.connected === true,
      hasChestDrops: live?.chestDrops != null,
      stageKey: live?.stageKey ?? null,
      stageWave: live?.stageWave ?? null,
    };
  },
}));
// Echo stageName so we can assert exactly which stage key was rendered.
vi.mock("../../src/core/stages", () => ({
  stageName: (key: number) => `MAP:${key}`,
}));

function liveSnapshot(stageKey: number, stageWave: number): LiveMemorySnapshot {
  return {
    connected: true,
    stageKey,
    stageWave,
    gold: null,
    heroes: null,
    chestDrops: null,
    chestSlots: null,
    inventoryItems: null,
    petData: null,
    stageClears: null,
    monsterHp: null,
    deadMonsterCount: null,
    source: "memory v1.00.21",
    readMs: 1,
    at: Date.now(),
  };
}

beforeEach(() => {
  state.live = null;
  window.tbh = {} as typeof window.tbh;
});

function renderLive(ui: ReactElement) {
  return render(<EntityPanelProvider>{ui}</EntityPanelProvider>);
}

describe("Live.tsx stage blend", () => {
  it("shows the save stage when no live snapshot is present (reader off)", async () => {
    const { Live } = await import("../../src/renderer/tabs/Live");
    renderLive(<Live />);
    expect(screen.getByText("MAP:1010")).toBeInTheDocument();
  });

  it("shows stats.stageName even when a live snapshot is present (no live blending)", async () => {
    state.live = liveSnapshot(3020, 5);
    const { Live } = await import("../../src/renderer/tabs/Live");
    renderLive(<Live />);
    expect(screen.getByText("MAP:1010")).toBeInTheDocument();
    expect(screen.queryByText("MAP:3020")).not.toBeInTheDocument();
  });

  it("hides XP updated text when live memory is connected", async () => {
    state.live = liveSnapshot(3020, 5);
    const { Live } = await import("../../src/renderer/tabs/Live");
    renderLive(<Live />);
    expect(screen.queryByText(/XP updated/i)).not.toBeInTheDocument();
  });
});
