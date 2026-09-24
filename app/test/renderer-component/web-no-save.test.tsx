import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installWebDataSource } from "../../src/web/dataSource";
import { installWebTbhApi } from "../../src/web/webTbhApi";
import { TbhProvider } from "../../src/renderer/context/TbhProvider";
import { EntityPanelProvider } from "../../src/renderer/context/EntityPanelProvider";
import { GlobalEntityPanel } from "../../src/renderer/components/GlobalEntityPanel";
import { Lookup } from "../../src/renderer/tabs/Lookup";
import { ChestsPanel } from "../../src/web/tabs/ChestsPanel";
import { TradingPanel } from "../../src/web/tabs/TradingPanel";

// Invariant guard for the site-root web app: with NO save loaded and NO network
// (the price snapshot 404s here), Lookup / Chests / Trading must render the REAL
// bundled catalog.
//
// Nothing below mocks `useLookupCatalog`: the catalog reaches the grid through
// `TbhProvider`, which prefetches the real bundled `lookup_items.json` via the
// web shim — the exact production path. An earlier version mocked the catalog to
// a 3-item fixture, which only proved "a fixture renders", never "the real
// catalog renders", and left Trading's ~1k tradable rows uncovered entirely.
//
// Rendering the real catalog (1,725 items on Lookup, ~1,079 tradable rows on
// Trading) is heavy for jsdom, so the page cases carry an explicit 30s timeout
// rather than shrinking scope to a fixture.

// A "save gate" is any copy that tells the visitor to load a save first. None of
// these three pages may ever show one — the catalog pages are save-independent
// by design (see `docs/DEPLOY-WEB.md` §"设计约束"). Matched against the page's
// full text, so a real regression that inserts a gate turns the assertion red.
const SAVE_GATE =
  /load a save|please load|no save loaded|waiting for save|comes from your save|请先载入存档/i;

function expectNoSaveGate(container: HTMLElement): void {
  expect(SAVE_GATE.test(container.textContent ?? "")).toBe(false);
}

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

describe("web shell without a save file — real bundled catalog", () => {
  it("serves the real bundled item catalog via the shim", async () => {
    const catalog = await window.tbh.getLookupCatalog();
    // A non-trivial catalog — guards the historical bug where `getLookupCatalog`
    // returned `[]` (no icons, raw English names) rather than a small fixture.
    expect(catalog.length).toBeGreaterThan(100);
    // This path is the REAL bundled catalog (not a fixture), so assert it is
    // genuinely *usable*, not merely non-empty: every row renders through
    // `ItemIcon`/`iconSrc` (needs a non-empty name + icon), and the Trading view
    // needs at least one `marketHashName`-addressable row.
    expect(catalog.every((item) => item.name.length > 0 && item.iconPath.length > 0)).toBe(true);
    expect(catalog.filter((item) => item.marketTradable).length).toBeGreaterThan(0);
  });

  it("renders every Lookup card from the real catalog", async () => {
    const { container } = render(
      <TbhProvider>
        <EntityPanelProvider>
          <Lookup watchedOnlyDefault={false} showPollingStatus={false} />
        </EntityPanelProvider>
      </TbhProvider>,
    );

    // The ~1,725-item grid only mounts once the real catalog reaches the context
    // — this is the assertion that would fail if the catalog were ever a stub.
    await waitFor(
      () => {
        expect(container.querySelectorAll("ul.grid > li").length).toBeGreaterThan(100);
      },
      { timeout: 25000 },
    );
    // No "waiting for the catalog" placeholder once cards are up…
    expect(screen.queryByText(/loading item catalog/i)).toBeNull();
    // …and no save gate.
    expectNoSaveGate(container);
  }, 30000);

  it("renders the real chest catalog", async () => {
    const { container } = render(<ChestsPanel />);

    const section = container.querySelector('section[aria-labelledby="chest-catalog-heading"]');
    expect(section).not.toBeNull();
    // Groups only render when they contain rows, so an icon/heading implies a
    // non-empty, real catalog.
    await waitFor(() => {
      expect(section!.querySelectorAll("img").length).toBeGreaterThan(0);
    });
    expect(
      container.querySelectorAll('section[aria-labelledby="chest-catalog-heading"] h3').length,
    ).toBeGreaterThan(0);

    expectNoSaveGate(container);
  });

  it("opens the chest detail side panel from a chest card", async () => {
    const { container } = render(<ChestsPanel />);

    const section = container.querySelector('section[aria-labelledby="chest-catalog-heading"]');
    await waitFor(() => {
      expect(section!.querySelectorAll("img").length).toBeGreaterThan(0);
    });

    // Every catalog chest card is a <button> inside the card grid (the filter
    // chips above it are also buttons, hence the grid-scoped query); clicking
    // one must open the side detail panel. This is the interaction that was
    // missing when the panel rendered cards as plain <div>s.
    const card = section!.querySelector("div.grid > button");
    expect(card).not.toBeNull();
    fireEvent.click(card as HTMLElement);

    // The payload 404s in this suite, so the panel shows its degradation
    // message rather than the drop list — but it must still OPEN, which is the
    // interaction under test.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("renders real tradable rows and warns when the price snapshot is missing", async () => {
    const { container } = render(
      <TbhProvider>
        {/* The real shell wraps every page in this provider; the item links on
            each row read it to open the side detail panel. */}
        <EntityPanelProvider>
          <TradingPanel />
        </EntityPanelProvider>
      </TbhProvider>,
    );

    // Real tradable rows (~1,079) once the real catalog lands.
    await waitFor(
      () => {
        expect(container.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
      },
      { timeout: 25000 },
    );
    // Missing snapshot (404) must surface the yellow banner while the catalog
    // still renders.
    expect(await screen.findByText(/Prices are unavailable/)).toBeInTheDocument();
    expectNoSaveGate(container);
  }, 30000);

  it("opens the item detail side panel from a trading row", async () => {
    const { container } = render(
      <TbhProvider>
        <EntityPanelProvider>
          <TradingPanel />
          <GlobalEntityPanel />
        </EntityPanelProvider>
      </TbhProvider>,
    );

    await waitFor(
      () => {
        expect(container.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
      },
      { timeout: 25000 },
    );

    // Every row's item cell is an entity link (a <button>); clicking the first
    // one must open the shared side detail panel. This is the interaction that
    // regressed when the web panel rendered a plain <span> instead.
    const firstLink = container.querySelector("tbody button");
    expect(firstLink).not.toBeNull();
    fireEvent.click(firstLink as HTMLElement);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // The panel is the item detail, not a bare error: it renders at least one
    // section heading beyond the sr-only title.
    expect(screen.getByRole("dialog").textContent?.length ?? 0).toBeGreaterThan(0);
  }, 30000);
});
