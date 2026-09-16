// Steam Community Market seller fee math (buyer listing price → wallet proceeds).
// Pure — no node:fs/bundled-data imports, so it's safe to import from the renderer too.
// For the bundled TBH fee override, see steamMarketFeeBundled.ts (main/core only).

export interface SteamMarketFeeRates {
  steamFeePercent: number;
  publisherFeePercent: number;
  /** Minimum per fee component in major currency units (e.g. 0.01 USD). */
  minFeeMajor: number;
  /** Minimum wallet proceeds (收款/净到手) per unit sold, in major currency units. */
  minPayoutMajor: number;
}

/** Fallback when bundled data/steam_market_fee.json is missing. */
export const TBH_MARKET_FEE_RATES: SteamMarketFeeRates = {
  steamFeePercent: 0.05,
  publisherFeePercent: 0.1,
  minFeeMajor: 0.01,
  minPayoutMajor: 0.01,
};

/**
 * Steam 各币种的单笔最低手续费（2025-12 起为 $0.01 等值）。Steam 只对部分
 * 币种给出固定的近似值（未公开完整表），社区实测国区为 ¥0.07（见
 * `docs/` 及 keylol 2026-08 验证：到手 0.60 → 买方 0.74，两费各按最低
 * ¥0.07）。其余币种回退调用方传入的基准（默认 $0.01，符合 Steam 官方
 * "最低费 $0.01 等值"的说法，宁缺毋错）。
 */
const MIN_FEE_BY_ISO: Record<string, number> = {
  CNY: 0.07,
};

/** 给定货币 ISO 码的 Steam 最低手续费；未收录币种回退 `fallback`（默认 $0.01 等值）。 */
export function minFeeForCurrency(iso: string | null | undefined, fallback = 0.01): number {
  if (!iso) return fallback;
  return MIN_FEE_BY_ISO[iso.toUpperCase()] ?? fallback;
}

/**
 * 返回按货币调整最低手续费后的费率副本。未收录币种（或已等于基准）返回
 * 原对象，避免无谓分配。
 */
export function feeRatesForCurrency(
  rates: SteamMarketFeeRates,
  iso: string | null | undefined,
): SteamMarketFeeRates {
  const min = minFeeForCurrency(iso, rates.minFeeMajor);
  if (min === rates.minFeeMajor && min === rates.minPayoutMajor) return rates;
  return { ...rates, minFeeMajor: min, minPayoutMajor: min };
}

function roundFee(price: number, rate: number, minFee: number): number {
  const raw = Math.floor(price * rate * 100) / 100;
  return Math.max(raw, minFee);
}

/** Total fees (Steam + publisher) for one sale listed at buyer price `price`. */
export function sellerFees(price: number, rates: SteamMarketFeeRates): number {
  if (price <= 0 || !Number.isFinite(price)) return 0;
  const steam = roundFee(price, rates.steamFeePercent, rates.minFeeMajor);
  const pub =
    rates.publisherFeePercent > 0
      ? roundFee(price, rates.publisherFeePercent, rates.minFeeMajor)
      : 0;
  return steam + pub;
}

/** Buyer price when seller wants to receive `amount` (listing helper). */
export function buyerPriceFromSellerAmount(
  sellerAmount: number,
  rates: SteamMarketFeeRates,
): number {
  if (sellerAmount <= 0 || !Number.isFinite(sellerAmount)) return 0;
  return sellerAmount + sellerFees(sellerAmount, rates);
}

/**
 * Wallet proceeds (收款) when a buyer pays `buyerPrice` on a listing.
 * Fees are charged on the buyer price directly (Steam 5% + publisher 10%), with a
 * per-fee-component minimum of `minFeeMajor`; the wallet proceeds floor at
 * `minPayoutMajor` (收款最少 0.01 美金).
 */
export function sellerProceedsFromBuyerPrice(
  buyerPrice: number,
  rates: SteamMarketFeeRates,
): number {
  if (buyerPrice <= 0 || !Number.isFinite(buyerPrice)) return 0;
  return Math.max(buyerPrice - sellerFees(buyerPrice, rates), rates.minPayoutMajor);
}

export interface SellerProceedsLine {
  buyerUnitPrice: number;
  count: number;
}

export interface SellerProceedsAggregate {
  grossTotal: number;
  netTotal: number;
  feeTotal: number;
}

/** Sum net proceeds per stack line (each unit sold at buyer price). */
export function aggregateSellerProceeds(
  lines: SellerProceedsLine[],
  rates: SteamMarketFeeRates,
): SellerProceedsAggregate {
  let grossTotal = 0;
  let netTotal = 0;

  for (const line of lines) {
    if (line.count <= 0 || line.buyerUnitPrice == null || !Number.isFinite(line.buyerUnitPrice)) {
      continue;
    }
    const unitNet = sellerProceedsFromBuyerPrice(line.buyerUnitPrice, rates);
    grossTotal += line.buyerUnitPrice * line.count;
    netTotal += unitNet * line.count;
  }

  const feeTotal = Math.max(0, grossTotal - netTotal);
  return { grossTotal, netTotal, feeTotal };
}
