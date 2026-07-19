import { cloneElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  BoxOpenStats,
  BoxOpenBreakdownRow,
  BoxTimerState,
  LookupItem,
  LootRingSeconds,
} from "../../shared/types";
import { LootBoxSection } from "../../src/renderer/components/loot/LootBoxSection";
import { EntityPanelProvider } from "../../src/renderer/context/EntityPanelProvider";
import { TbhContext } from "../../src/renderer/context/tbhContext";

function makeBreakdownRow(i: number): BoxOpenBreakdownRow {
  return {
    itemKey: i,
    name: `Item ${i}`,
    grade: null,
    count: i + 1,
    dropPct: (i + 1) / 100,
    buyOrderUnit: 10,
    buyOrderValue: 10 * (i + 1),
    hourlyValue: 0.1 * (i + 1),
  };
}

function makeStats(breakdownCount: number, category = "common"): BoxOpenStats {
  return {
    boxKey: category,
    label: category === "unclassified" ? "Unclassified" : "Common chest",
    category,
    level: null,
    totalOpens: 100,
    totalBuyOrderValue: 1234,
    hourlyValue: 56,
    breakdown: Array.from({ length: breakdownCount }, (_, i) => makeBreakdownRow(i)),
    history: [],
    lastOpenWallTime: null,
  };
}

/**
 * Minimal BoxTimerState catalog matching what `BoxTimerService.buildCatalog`
 * produces for canonical stage-boss boxes. Only the fields LootBoxSection
 * reads (`level`, `farmStageOptions`) are populated; the unused ones default
 * the same way the real type would when constructed from the catalog.
 */
function makeBoxTimersState(): BoxTimerState {
  return {
    rows: [],
    catalog: [
      {
        boxId: 920001,
        name: "Stage Boss Box 1",
        level: 1,
        idealStageKey: 1001,
        idealStageLabel: "Normal 1-1",
        defaultIdealStageKey: 1001,
        defaultIdealStageLabel: "Normal 1-1",
        idealStageIsCustom: false,
        farmStageOptions: [
          { stageKey: 1001, label: "Normal 1-1" },
          { stageKey: 1105, label: "Normal 1-5" },
        ],
        dropStageRangeLabel: "—",
        cooldownSeconds: 720,
        cooldownIsCustom: false,
        enabled: true,
        notifyWhenReady: false,
      },
      {
        boxId: 920051,
        name: "Stage Boss Box 5",
        level: 5,
        idealStageKey: 1105,
        idealStageLabel: "Normal 1-5",
        defaultIdealStageKey: 1105,
        defaultIdealStageLabel: "Normal 1-5",
        idealStageIsCustom: false,
        farmStageOptions: [
          { stageKey: 1105, label: "Normal 1-5" },
          { stageKey: 1205, label: "Normal 2-5" },
        ],
        dropStageRangeLabel: "—",
        cooldownSeconds: 720,
        cooldownIsCustom: false,
        enabled: true,
        notifyWhenReady: false,
      },
      {
        boxId: 920151,
        name: "Stage Boss Box Lv15",
        level: 15,
        idealStageKey: 3205,
        idealStageLabel: "Hell 2-5",
        defaultIdealStageKey: 3205,
        defaultIdealStageLabel: "Hell 2-5",
        idealStageIsCustom: false,
        farmStageOptions: [
          { stageKey: 3205, label: "Hell 2-5" },
          { stageKey: 3309, label: "Hell 3-9" },
        ],
        dropStageRangeLabel: "—",
        cooldownSeconds: 720,
        cooldownIsCustom: false,
        enabled: true,
        notifyWhenReady: false,
      },
      {
        boxId: 920301,
        name: "Stage Boss Box Lv30",
        level: 30,
        idealStageKey: 3309,
        idealStageLabel: "Hell 3-9",
        defaultIdealStageKey: 3309,
        defaultIdealStageLabel: "Hell 3-9",
        idealStageIsCustom: false,
        farmStageOptions: [{ stageKey: 3309, label: "Hell 3-9" }],
        dropStageRangeLabel: "—",
        cooldownSeconds: 720,
        cooldownIsCustom: false,
        enabled: true,
        notifyWhenReady: false,
      },
    ],
    enabledCount: 4,
    readyCount: 4,
    cooldownCount: 0,
    sortOrder: "cooldown-first",
    currentStageKey: 0,
    defaultCooldownSeconds: 720,
  };
}

// LootBoxSection now reads the lookup catalog, the chest tracker catalog, the
// global entity panel (for clickable, grade-colored item names shared with
// the Inventory page), and the TbhContext (for currency used in buyout/hourly
// formatting). Stub all four so the rendering tests stay focused on layout.
//
// Starting with the i18n refactor, the component also receives `itemIndex`,
// `boxTimers`, `ringSeconds`, and `onUpdateRingSeconds` as props (lifted from
// internal hooks so the parent Loot tab can share one catalog across cards).
// Tests that only care about layout don't need to pass these explicitly —
// `cloneElement` below injects sensible defaults.
const DEFAULT_LOOT_PROPS = {
  itemIndex: new Map<number, LookupItem>(),
  boxTimers: makeBoxTimersState(),
  ringSeconds: { common: 5 * 60, stage: 7 * 60 } as LootRingSeconds,
  onUpdateRingSeconds: vi.fn(),
  lastDropWallTime: null as number | null,
};

function renderLootSection(ui: React.ReactElement) {
  window.tbh = {
    ...(window.tbh ?? {}),
    getLookupCatalog: vi.fn().mockResolvedValue([]),
    getBoxTimers: vi.fn().mockResolvedValue(makeBoxTimersState()),
    onBoxTimers: vi.fn().mockReturnValue(() => {}),
    // LootBoxSection now loads loot-ring lap durations from config on mount.
    // Return undefined so the effect's `.then((cfg) => cfg.lootRingSeconds)`
    // is a no-op — the component falls back to its built-in defaults.
    getConfig: vi.fn().mockResolvedValue(undefined),
    saveConfig: vi.fn().mockResolvedValue({}),
  } as unknown as typeof window.tbh;
  // Currency comes from the latest resolved inventory snapshot. Stub with USD
  // so formatMoney() produces "$0.10"-style strings the assertions can match.
  const tbhValue = {
    inventory: { currency: "USD" },
    lastPriceRefreshMessage: null,
    clearLastPriceRefreshMessage: () => {},
    catalogStatus: null,
    refreshCatalog: vi.fn().mockResolvedValue({ ok: false }),
  };
  const uiWithDefaults = cloneElement(ui, DEFAULT_LOOT_PROPS);
  return render(
    <TbhContext.Provider value={tbhValue as never}>
      <EntityPanelProvider>{uiWithDefaults}</EntityPanelProvider>
    </TbhContext.Provider>,
  );
}

describe("LootBoxSection", () => {
  // P1-10: large loot breakdowns (the audit's threshold is > 50 rows) must
  // opt into the DataTable's CSS-based virtualization so the 5 Hz stats
  // broadcast doesn't pay a paint cost for rows the user can't see.
  it("enables row content-visibility virtualization when breakdown exceeds 50 rows", () => {
    const stats = makeStats(60);
    renderLootSection(<LootBoxSection stats={stats} currentStageKey={null} onReset={vi.fn()} />);
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of Array.from(rows)) {
      expect(row).toHaveStyle({ contentVisibility: "auto" });
    }
  });

  it("does not enable row content-visibility when breakdown is 50 rows or fewer", () => {
    const stats = makeStats(50);
    renderLootSection(<LootBoxSection stats={stats} currentStageKey={null} onReset={vi.fn()} />);
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of Array.from(rows)) {
      expect(row).not.toHaveStyle({ contentVisibility: "auto" });
    }
  });

  it("offers chest-tracker levels (1, 5, 15, 30) instead of a continuous 1-50 range", async () => {
    const stats = makeStats(2, "unclassified");
    renderLootSection(
      <LootBoxSection
        stats={stats}
        currentStageKey={null}
        onReset={vi.fn()}
        onReclassify={vi.fn()}
      />,
    );
    // Wait for the async getBoxTimers() promise to populate the catalog,
    // otherwise the level Select renders with empty options.
    const levelSelect = await screen.findAllByLabelText(/Level for Item /i);
    await waitFor(() => expect(levelSelect[0]).toHaveTextContent("Lv 1"));
    // Lv 8 is not a valid stage-box level and must NOT appear.
    expect(levelSelect[0]).not.toHaveTextContent("Lv 8");
  });

  it("defaults to the highest level dropping on the current stage (3309 -> Lv 30)", async () => {
    const stats = makeStats(3, "unclassified");
    renderLootSection(
      <LootBoxSection
        stats={stats}
        currentStageKey={3309}
        onReset={vi.fn()}
        onReclassify={vi.fn()}
      />,
    );
    const levelSelects = await screen.findAllByLabelText(/Level for Item /i);
    await waitFor(() => expect(levelSelects[0]).toHaveTextContent("Lv 30"));
  });

  it("picks the highest level among boxes dropping on the current stage (1105 -> Lv 5)", async () => {
    // stage 1105 drops both Lv1 and Lv5; default picks the highest = Lv5
    const stats = makeStats(2, "unclassified");
    renderLootSection(
      <LootBoxSection
        stats={stats}
        currentStageKey={1105}
        onReset={vi.fn()}
        onReclassify={vi.fn()}
      />,
    );
    const levelSelects = await screen.findAllByLabelText(/Level for Item /i);
    await waitFor(() => expect(levelSelects[0]).toHaveTextContent("Lv 5"));
  });

  it("falls back to the lowest catalog level when no box drops on the current stage", async () => {
    const stats = makeStats(2, "unclassified");
    renderLootSection(
      <LootBoxSection
        stats={stats}
        currentStageKey={9999}
        onReset={vi.fn()}
        onReclassify={vi.fn()}
      />,
    );
    const levelSelects = await screen.findAllByLabelText(/Level for Item /i);
    await waitFor(() => expect(levelSelects[0]).toHaveTextContent("Lv 1"));
  });

  it("shows an Assign all button for unclassified boxes with rows", () => {
    const stats = makeStats(2, "unclassified");
    renderLootSection(
      <LootBoxSection
        stats={stats}
        currentStageKey={1105}
        onReset={vi.fn()}
        onReclassify={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Assign all" })).toBeInTheDocument();
  });

  it("does not show Assign all on classified boxes", () => {
    const stats = makeStats(2, "common");
    renderLootSection(<LootBoxSection stats={stats} currentStageKey={null} onReset={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Assign all" })).toBeNull();
  });

  it("reclassifies every visible row at the stage-derived default level when Assign all is clicked", async () => {
    const user = userEvent.setup();
    const stats = makeStats(3, "unclassified");
    const onReclassify = vi.fn();
    renderLootSection(
      <LootBoxSection
        stats={stats}
        currentStageKey={3309}
        onReset={vi.fn()}
        onReclassify={onReclassify}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByLabelText(/Level for Item /i)[0]).toHaveTextContent("Lv 30"),
    );
    await user.click(screen.getByRole("button", { name: "Assign all" }));
    // stage 3309 -> highest dropping level = 30; category defaults to "common".
    expect(onReclassify).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(onReclassify).toHaveBeenCalledWith(i, "unclassified", "common:30");
    }
  });
});
