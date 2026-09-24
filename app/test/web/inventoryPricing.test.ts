import { describe, expect, it } from "vitest";
import type { LookupPriceSnapshot } from "../../shared/types";
import { formatMoney } from "../../src/core/steamPrice";
import { webPriceContext } from "../../src/web/analyzeSave";

// The web Inventory is priced from the same-origin CI snapshot, which is
// USD-denominated with an FX table and carries only the lowest active listing —
// recent-sale medians and buy orders are desktop-only polling data a browser
// cannot fetch. This pins the mapping the inventory resolve path consumes:
//
//  * a listed hash must produce an `InventoryPriceInfo` the resolve path can
//    price rows from, with its raw text formatted in the *display* currency
//    (the table renders from raw Steam text, so a number alone would still
//    render as "not loaded");
//  * the requested currency converts through `fx`, and a currency the snapshot
//    has no rate for falls back to USD rather than rendering a ¥ amount under a
//    $ prefix;
//  * anything absent must fall through to `undefined` so the row keeps its
//    "not loaded" rendering instead of showing a bogus zero.

const SNAPSHOT: LookupPriceSnapshot = {
  schemaVersion: 1,
  generatedUtc: "2026-01-01T00:00:00.000Z",
  baseCurrency: "USD",
  prices: { "Copper Coin": 1.23, "Sold Out Item": null },
  fetchedUtc: {},
  fx: { USD: 1, CNY: 6.7074 },
};

describe("webPriceContext", () => {
  it("is undefined when there is no snapshot", () => {
    expect(webPriceContext(null, "USD")).toBeUndefined();
    expect(webPriceContext(undefined, "USD")).toBeUndefined();
  });

  it("prices in USD when the requested currency is USD", () => {
    const ctx = webPriceContext(SNAPSHOT, "USD");
    expect(ctx?.currency).toBe("USD");
    expect(ctx?.lookup("Copper Coin")).toEqual({
      median: null,
      lowest: 1.23,
      rawMedian: null,
      rawLowest: "$1.23",
      buyOrder: null,
      rawBuyOrder: null,
      buyOrderQuantity: null,
      buyOrderLevels: null,
      buyOrderFetched: false,
    });
  });

  it("converts through the snapshot FX table and formats in that currency", () => {
    const ctx = webPriceContext(SNAPSHOT, "CNY");
    expect(ctx?.currency).toBe("CNY");

    const info = ctx?.lookup("Copper Coin");
    const expected = 1.23 * 6.7074;
    expect(info?.lowest).toBeCloseTo(expected, 10);
    // The raw text is what the table actually renders, so it must be the
    // converted amount formatted in the display currency.
    expect(info?.rawLowest).toBe(formatMoney(expected, "CNY"));
  });

  it("falls back to USD when the snapshot has no rate for the currency", () => {
    const ctx = webPriceContext(SNAPSHOT, "JPY");
    expect(ctx?.currency).toBe("USD");
    expect(ctx?.lookup("Copper Coin")?.lowest).toBe(1.23);
    expect(ctx?.lookup("Copper Coin")?.rawLowest).toBe("$1.23");
  });

  it("is case-insensitive on the currency code", () => {
    expect(webPriceContext(SNAPSHOT, "cny")?.currency).toBe("CNY");
  });

  it("falls through for a hash with no active listing or unknown hash", () => {
    const ctx = webPriceContext(SNAPSHOT, "USD");
    expect(ctx?.lookup("Sold Out Item")).toBeUndefined();
    expect(ctx?.lookup("Not In The Snapshot")).toBeUndefined();
  });

  it("is undefined for a snapshot without a prices record", () => {
    const broken = { ...SNAPSHOT, prices: undefined } as unknown as LookupPriceSnapshot;
    expect(webPriceContext(broken, "USD")).toBeUndefined();
  });
});
