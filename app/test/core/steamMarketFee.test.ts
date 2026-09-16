import { describe, it, expect } from "vitest";
import {
  aggregateSellerProceeds,
  buyerPriceFromSellerAmount,
  feeRatesForCurrency,
  minFeeForCurrency,
  sellerFees,
  sellerProceedsFromBuyerPrice,
  TBH_MARKET_FEE_RATES,
} from "../../src/core/steamMarketFee";
import { getTbhMarketFeeRates } from "../../src/core/steamMarketFeeBundled";

describe("steamMarketFee", () => {
  it("charges 5% Steam + 10% publisher by default", () => {
    expect(TBH_MARKET_FEE_RATES.steamFeePercent).toBe(0.05);
    expect(TBH_MARKET_FEE_RATES.publisherFeePercent).toBe(0.1);
    expect(TBH_MARKET_FEE_RATES.minFeeMajor).toBe(0.01);
    expect(TBH_MARKET_FEE_RATES.minPayoutMajor).toBe(0.01);
  });

  it("computes buyer price from seller amount", () => {
    expect(buyerPriceFromSellerAmount(1, TBH_MARKET_FEE_RATES)).toBeCloseTo(1.15);
  });

  it("deducts fees from buyer price directly", () => {
    expect(sellerFees(1, TBH_MARKET_FEE_RATES)).toBeCloseTo(0.15);
    expect(sellerProceedsFromBuyerPrice(1, TBH_MARKET_FEE_RATES)).toBeCloseTo(0.85, 2);
  });

  it("enforces a minimum fee component of 0.01", () => {
    // 5% of 0.02 = 0.001 → floors to 0.01 (Steam), publisher also 0.01.
    expect(sellerFees(0.02, TBH_MARKET_FEE_RATES)).toBeCloseTo(0.02, 2);
  });

  it("floors wallet proceeds at the minimum payout (收款 ≥ 0.01)", () => {
    // 0.02 - steam(0.01) - publisher(0.01) = 0 → clamped to 0.01.
    expect(sellerProceedsFromBuyerPrice(0.02, TBH_MARKET_FEE_RATES)).toBeCloseTo(0.01, 2);
  });

  it("aggregates proceeds per stack line", () => {
    const result = aggregateSellerProceeds(
      [
        { buyerUnitPrice: 1.0, count: 2 },
        { buyerUnitPrice: 0.5, count: 1 },
      ],
      TBH_MARKET_FEE_RATES,
    );
    expect(result.grossTotal).toBeCloseTo(2.5);
    expect(result.netTotal).toBeCloseTo(2.13, 2);
    expect(result.feeTotal).toBeCloseTo(result.grossTotal - result.netTotal);
  });

  it("loads TBH rates from bundled steam_market_fee.json", () => {
    const rates = getTbhMarketFeeRates();
    expect(rates.steamFeePercent).toBe(0.05);
    expect(rates.publisherFeePercent).toBe(0.1);
    expect(rates.minFeeMajor).toBe(0.01);
    expect(rates.minPayoutMajor).toBe(0.01);
  });
});

describe("currency-aware minimum fee", () => {
  it("uses $0.01 for USD and unknown currencies", () => {
    expect(minFeeForCurrency("USD")).toBe(0.01);
    expect(minFeeForCurrency("EUR")).toBe(0.01);
    expect(minFeeForCurrency("NOPE")).toBe(0.01);
    expect(minFeeForCurrency(null)).toBe(0.01);
  });

  it("uses ¥0.07 for CNY", () => {
    expect(minFeeForCurrency("CNY")).toBe(0.07);
    expect(minFeeForCurrency("cny")).toBe(0.07);
  });

  it("returns the same rates object when currency min equals baseline", () => {
    expect(feeRatesForCurrency(TBH_MARKET_FEE_RATES, "USD")).toBe(TBH_MARKET_FEE_RATES);
  });

  it("scales CNY fees to 0.07 and floors proceeds at 0.07", () => {
    const cny = feeRatesForCurrency(TBH_MARKET_FEE_RATES, "CNY");
    expect(cny).not.toBe(TBH_MARKET_FEE_RATES);
    expect(cny.minFeeMajor).toBe(0.07);
    expect(cny.minPayoutMajor).toBe(0.07);
    // 0.20 CNY: steam(5% of 0.20=0.01 < 0.07 → 0.07) + pub(0.07) = 0.14;
    // proceeds = max(0.20 - 0.14, 0.07) = 0.07 (收款保底 ¥0.07).
    expect(sellerFees(0.2, cny)).toBeCloseTo(0.14, 2);
    expect(sellerProceedsFromBuyerPrice(0.2, cny)).toBeCloseTo(0.07, 2);
    // 1.00 CNY: steam(5% of 1.00=0.05 < 0.07 → 0.07) + pub(10% of 1.00=0.10 > 0.07 → 0.10)
    // = 0.17, proceeds = 0.83.
    expect(sellerFees(1, cny)).toBeCloseTo(0.17, 2);
    expect(sellerProceedsFromBuyerPrice(1, cny)).toBeCloseTo(0.83, 2);
  });
});
