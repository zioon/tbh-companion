import { describe, expect, it } from "vitest";
import type { LookupPriceSnapshot } from "../../shared/types";
import { webPriceLookup } from "../../src/web/analyzeSave";

// The web Inventory is priced from the same-origin CI snapshot, which carries
// only the lowest active listing — recent-sale medians and buy orders are
// desktop-only polling data a browser cannot fetch. This pins the mapping the
// inventory resolve path consumes: a listed hash must produce an
// `InventoryPriceInfo` the resolve path can price rows from (with its raw text
// formatted in the snapshot's base currency, since the table renders from raw
// Steam text), and anything absent must fall through to `undefined` so the row
// keeps its "not loaded" rendering instead of showing a bogus zero.

const SNAPSHOT: LookupPriceSnapshot = {
  schemaVersion: 1,
  generatedUtc: "2026-01-01T00:00:00.000Z",
  baseCurrency: "USD",
  prices: { "Copper Coin": 1.23, "Sold Out Item": null },
  fetchedUtc: {},
  fx: { USD: 1 },
};

describe("webPriceLookup", () => {
  it("is undefined when there is no snapshot", () => {
    expect(webPriceLookup(null)).toBeUndefined();
    expect(webPriceLookup(undefined)).toBeUndefined();
  });

  it("maps a listed hash to a lowest-only price info", () => {
    const lookup = webPriceLookup(SNAPSHOT);
    expect(lookup).toBeDefined();
    expect(lookup?.("Copper Coin")).toEqual({
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

  it("falls through for a hash with no active listing", () => {
    const lookup = webPriceLookup(SNAPSHOT);
    expect(lookup?.("Sold Out Item")).toBeUndefined();
  });

  it("falls through for a hash the snapshot does not know", () => {
    const lookup = webPriceLookup(SNAPSHOT);
    expect(lookup?.("Not In The Snapshot")).toBeUndefined();
  });

  it("is undefined for a snapshot without a prices record", () => {
    const broken = { ...SNAPSHOT, prices: undefined } as unknown as LookupPriceSnapshot;
    expect(webPriceLookup(broken)).toBeUndefined();
  });
});
