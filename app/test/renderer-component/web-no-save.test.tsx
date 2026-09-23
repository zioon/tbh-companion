import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LookupItem } from "../../shared/types";
import { installWebDataSource } from "../../src/web/dataSource";
import { installWebTbhApi } from "../../src/web/webTbhApi";
import { EntityPanelProvider } from "../../src/renderer/context/EntityPanelProvider";
import { Lookup } from "../../src/renderer/tabs/Lookup";
import { ChestsPanel } from "../../src/web/tabs/ChestsPanel";
import { TradingPanel } from "../../src/web/tabs/TradingPanel";

// Invariant guard for the site-root web app: Lookup / Chests / Trading must
// render real content with NO save loaded. A regression here is exactly the
// failure mode where a page grows a "please load a save first" gate and the
// no-save experience silently dies.
//
// Lookup and Trading read the item catalog through `useLookupCatalog()`. That
// catalog is ~2k items; rendering it whole in jsdom would blow the default test
// timeout, so the hook is mocked to a tiny fixture here. The *real* bundled
// catalog is separately asserted to be non-empty via the shim (first test), and
// fully rendered end-to-end by `smoke-web.cjs`. Chests reads the bundled
// `stage_boxes.json` directly and is exercised with real data here.

const { CATALOG } = vi.hoisted(() => {
  const item = (
    over: Partial<LookupItem> & Pick<LookupItem, "id" | "name" | "type" | "grade">,
  ): LookupItem => ({
    gearType: null,
    gearGroup: null,
    materialType: null,
    level: null,
    marketTradable: false,
    iconPath: `item-${over.id}`,
    ...over,
  });
  return {
    CATALOG: [
      item({
        id: 910001,
        name: "Copper Coin",
        type: "MATERIAL",
        grade: "COMMON",
        marketTradable: true,
      }),
      item({
        id: 910002,
        name: "Long Sword",
        type: "GEAR",
        grade: "LEGENDARY",
        gearType: "sword",
        level: 10,
        marketTradable: true,
      }),
      item({ id: 910003, name: "Plain Rock", type: "MATERIAL", grade: "COMMON" }),
    ] satisfies LookupItem[],
  };
});

vi.mock("../../src/renderer/lib/useLookupCatalog", () => ({
  useLookupCatalog: () => CATALOG as LookupItem[],
}));

beforeEach(() => {
  // The web entry does not auto-install the shims (that is `main.tsx`'s job),
  // so a component test must wire them up itself.
  installWebDataSource();
  installWebTbhApi();
  // No price snapshot at this origin → the "missing" degradation path. Stubbed
  // so no test ever touches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web shell without a save file", () => {
  it("serves the real bundled item catalog via the shim", async () => {
    const catalog = await window.tbh.getLookupCatalog();
    // A non-trivial catalog — guards the historical bug where `getLookupCatalog`
    // returned `[]` (no icons, raw English names) rather than a small fixture.
    expect(catalog.length).toBeGreaterThan(100);
  });

  it("renders Lookup item cards", async () => {
    render(
      <EntityPanelProvider>
        <Lookup watchedOnlyDefault={false} showPollingStatus={false} />
      </EntityPanelProvider>,
    );

    expect(await screen.findByText(/Copper Coin/)).toBeInTheDocument();
    expect(await screen.findByText(/Long Sword/)).toBeInTheDocument();
    // No "waiting for the catalog" placeholder once cards are up.
    expect(screen.queryByText(/loading item catalog/i)).toBeNull();
    // And, crucially, no save gate.
    expect(screen.queryByText(/waiting for save/i)).toBeNull();
    expect(screen.queryByText(/comes from your save/i)).toBeNull();
  });

  it("renders the chest catalog", async () => {
    render(<ChestsPanel />);

    // Groups only render when they contain rows, so a group heading implies a
    // non-empty catalog. Icons confirm the cards actually built.
    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.length).toBeGreaterThan(0);
    const section = document.querySelector('section[aria-labelledby="chest-catalog-heading"]');
    expect(section).not.toBeNull();
    expect(section!.querySelectorAll("img").length).toBeGreaterThan(0);

    expect(screen.queryByText(/waiting for save/i)).toBeNull();
    expect(screen.queryByText(/comes from your save/i)).toBeNull();
  });

  it("renders tradable rows and warns when the price snapshot is missing", async () => {
    render(<TradingPanel />);

    // Missing snapshot (404) must surface the yellow banner…
    expect(await screen.findByText(/Prices are unavailable/)).toBeInTheDocument();
    // …while the catalog still renders: two tradable rows.
    expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(0);

    expect(screen.queryByText(/waiting for save/i)).toBeNull();
    expect(screen.queryByText(/comes from your save/i)).toBeNull();
  });
});
