import { describe, it, expect } from "vitest";
import { instantSellNetValue, instantSellValue } from "../../src/core/inventory/buyOrder";
import { TBH_MARKET_FEE_RATES } from "../../src/core/steamMarketFee";

describe("instantSellValue", () => {
  it("walks multiple levels when the top level doesn't cover the stack", () => {
    const result = instantSellValue(12, [
      { price: 0.03, quantity: 2 },
      { price: 0.02, quantity: 10 },
      { price: 0.01, quantity: 100 },
    ]);
    expect(result.value).toBeCloseTo(0.03 * 2 + 0.02 * 10);
    expect(result.coveredCount).toBe(12);
  });

  it("uses full stack when the top level alone covers it", () => {
    const result = instantSellValue(1, [{ price: 0.03, quantity: 5 }]);
    expect(result.value).toBeCloseTo(0.03);
    expect(result.coveredCount).toBe(1);
  });

  it("sorts levels regardless of input order", () => {
    const result = instantSellValue(3, [
      { price: 0.01, quantity: 100 },
      { price: 0.03, quantity: 2 },
    ]);
    expect(result.value).toBeCloseTo(0.03 * 2 + 0.01 * 1);
    expect(result.coveredCount).toBe(3);
  });

  it("caps coveredCount when the whole book still falls short", () => {
    const result = instantSellValue(10, [{ price: 0.03, quantity: 2 }]);
    expect(result.value).toBeCloseTo(0.06);
    expect(result.coveredCount).toBe(2);
  });

  it("returns null value when levels are unknown or empty", () => {
    expect(instantSellValue(5, null)).toEqual({ value: null, coveredCount: 0 });
    expect(instantSellValue(5, []).value).toBeNull();
    expect(instantSellValue(5, undefined).value).toBeNull();
  });

  it("returns null for invalid inputs", () => {
    expect(instantSellValue(0, [{ price: 0.03, quantity: 2 }]).value).toBeNull();
  });
});

describe("instantSellNetValue", () => {
  it("deducts trading costs per level price, not a flat ratio", () => {
    // 0.03: fee = 0.01(Steam) + 0.01(pub) = 0.02 → 0.01 net (payout floor).
    // 0.02: fee = 0.01 + 0.01 = 0.02 → 0.01 net (payout floor).
    const result = instantSellNetValue(
      12,
      [
        { price: 0.03, quantity: 2 },
        { price: 0.02, quantity: 10 },
        { price: 0.01, quantity: 100 },
      ],
      TBH_MARKET_FEE_RATES,
    );
    expect(result.coveredCount).toBe(12);
    expect(result.value).toBeCloseTo(0.01 * 12);
  });

  it("keeps gross when a level price is large enough to exceed minimum fees", () => {
    // 1.00: fee = 0.05 + 0.10 = 0.15 → 0.85 net.
    const result = instantSellNetValue(1, [{ price: 1.0, quantity: 5 }], TBH_MARKET_FEE_RATES);
    expect(result.value).toBeCloseTo(0.85, 2);
    expect(result.coveredCount).toBe(1);
  });
});
