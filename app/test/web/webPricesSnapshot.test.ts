import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupPriceSnapshot } from "../../shared/types";

// The site-root app loads its Lookup price snapshot from the same origin
// (`data/prices.json`). This covers the store's degradation matrix: a valid
// payload → ready; a 404 / malformed payload → missing (never throwing), so the
// catalog keeps rendering and only the price column degrades.

const SNAPSHOT: LookupPriceSnapshot = {
  schemaVersion: 1,
  generatedUtc: "2026-01-01T00:00:00.000Z",
  baseCurrency: "USD",
  prices: { "Copper Coin": 1.23, "Long Sword (Legendary) A": null },
  fetchedUtc: {},
  fx: { USD: 1 },
};

describe("web prices snapshot store", () => {
  beforeEach(() => {
    // Fresh module registry per test so the store's singleton state resets.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads a same-origin snapshot and reports ready (idempotent)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => SNAPSHOT });
    vi.stubGlobal("fetch", fetchMock);

    const store = await import("../../src/web/pricesSnapshot");
    expect(store.getWebPricesStatus()).toBe("idle");

    await store.ensureWebPricesLoaded();
    expect(store.getWebPricesStatus()).toBe("ready");
    expect(store.getWebPriceSnapshot()?.prices["Copper Coin"]).toBe(1.23);

    // A second call must not refetch.
    await store.ensureWebPricesLoaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to missing on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );

    const store = await import("../../src/web/pricesSnapshot");
    await store.ensureWebPricesLoaded();
    expect(store.getWebPricesStatus()).toBe("missing");
    expect(store.getWebPriceSnapshot()).toBeNull();
  });

  it("degrades to missing on a malformed payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const store = await import("../../src/web/pricesSnapshot");
    await store.ensureWebPricesLoaded();
    expect(store.getWebPricesStatus()).toBe("missing");
    expect(store.getWebPriceSnapshot()).toBeNull();
  });

  it("notifies subscribers when the status changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => SNAPSHOT }));

    const store = await import("../../src/web/pricesSnapshot");
    const seen: string[] = [];
    const off = store.subscribeWebPrices(() => seen.push(store.getWebPricesStatus()));

    await store.ensureWebPricesLoaded();
    off();

    expect(seen).toContain("ready");
  });
});
