import type { BuyOrderLevel } from "../../../shared/types";
import { sellerProceedsFromBuyerPrice, type SteamMarketFeeRates } from "../steamMarketFee";

export interface InstantSellResult {
  value: number | null;
  /** Units actually sellable across all known levels, capped at ownedCount. */
  coveredCount: number;
}

/** Which price (per unit) covers how many units, best listed price first. */
function scanLevels(
  ownedCount: number,
  levels: BuyOrderLevel[] | null | undefined,
): Array<{ price: number; take: number }> {
  if (ownedCount <= 0 || !levels?.length) return [];
  const sorted = [...levels].sort((a, b) => b.price - a.price);
  const takes: Array<{ price: number; take: number }> = [];
  let remaining = ownedCount;
  for (const level of sorted) {
    if (remaining <= 0) break;
    if (!Number.isFinite(level.price) || level.price <= 0) continue;
    const take = Math.min(remaining, Math.max(0, Math.trunc(level.quantity)));
    if (take > 0) takes.push({ price: level.price, take });
    remaining -= take;
  }
  return takes;
}

/** Gross wallet proceeds from selling into the order book level-by-level, best price first. */
export function instantSellValue(
  ownedCount: number,
  levels: BuyOrderLevel[] | null | undefined,
): InstantSellResult {
  const takes = scanLevels(ownedCount, levels);
  const coveredCount = takes.reduce((sum, t) => sum + t.take, 0);
  const value = coveredCount > 0 ? takes.reduce((sum, t) => sum + t.price * t.take, 0) : null;
  return { value, coveredCount };
}

/** Net wallet proceeds after Steam/publisher fees, applied per level price. */
export function instantSellNetValue(
  ownedCount: number,
  levels: BuyOrderLevel[] | null | undefined,
  rates: SteamMarketFeeRates,
): InstantSellResult {
  const takes = scanLevels(ownedCount, levels);
  const coveredCount = takes.reduce((sum, t) => sum + t.take, 0);
  const value =
    coveredCount > 0
      ? takes.reduce((sum, t) => sum + sellerProceedsFromBuyerPrice(t.price, rates) * t.take, 0)
      : null;
  return { value, coveredCount };
}
