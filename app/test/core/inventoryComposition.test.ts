import { describe, expect, it } from "vitest";
import { computeInventoryComposition } from "../../src/core/inventory/composition";
import { TBH_MARKET_FEE_RATES } from "../../src/core/steamMarketFee";
import type { ResolvedInventoryRow } from "../../shared/types";

function row(partial: Partial<ResolvedInventoryRow>): ResolvedInventoryRow {
  return {
    itemKey: 1,
    name: "Item",
    grade: "common",
    type: "GEAR",
    level: null,
    marketTradable: false,
    marketHashName: null,
    count: 1,
    inUseCount: 0,
    chaoticCount: 0,
    known: true,
    priceRaw: null,
    rawMedian: null,
    rawLowest: null,
    unitPrice: null,
    priceSource: null,
    priceChecked: false,
    value: null,
    buyOrderRaw: null,
    buyOrderUnit: null,
    buyOrderQuantity: null,
    buyOrderLevels: null,
    buyOrderValue: null,
    buyOrderCoveredCount: null,
    buyOrderChecked: false,
    inventoryCount: 0,
    stashCount: 0,
    tradingCount: 0,
    ...partial,
  };
}

describe("computeInventoryComposition", () => {
  it("does not clear pricing fields on input rows (pure contract)", () => {
    const priced = row({
      itemKey: 1,
      unitPrice: 5,
      priceRaw: "$5.00",
      marketHashName: "x",
      value: 20,
    });
    // A row that was priced earlier but absent from this re-aggregation subset
    // (no market hash) must not have its previously resolved pricing wiped.
    const noHashButPriced = row({
      itemKey: 2,
      unitPrice: 7,
      priceRaw: "$7.00",
      marketHashName: null,
      value: 14,
    });
    const rows = [priced, noHashButPriced];
    computeInventoryComposition(rows, TBH_MARKET_FEE_RATES);
    expect(priced.unitPrice).toBe(5);
    expect(priced.priceRaw).toBe("$5.00");
    expect(noHashButPriced.unitPrice).toBe(7);
    expect(noHashButPriced.priceRaw).toBe("$7.00");
  });
});
