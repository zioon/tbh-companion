// Resolve a catalog item against the price snapshot for display in the renderer.
// Pure: hash derivation (shared with the Action), FX conversion, and money
// formatting. No network, no React.

import type { LookupPriceSnapshot, ResolvedLookupPrice } from "../../../shared/types";
import { marketHashName, type MarketHashItem } from "../marketName";
import { formatMoney, steamMarketListingUrl } from "../steamPrice";

const NOT_TRADABLE: ResolvedLookupPrice = {
  hash: null,
  state: "not-tradable",
  usd: null,
  amount: null,
  display: null,
  listingUrl: null,
  source: null,
  median: null,
  buyOrder: null,
};

/**
 * Resolve `item` to a displayable price in `currency`:
 * - not-tradable / no derivable hash → no price affordance
 * - tradable but no USD listing in the snapshot → "no-listing" (still links out)
 * - priced → prefer `pricesLocal[hash]` when `localCurrency` matches the display
 *   currency (本地 polling 直接抓的目标货币，无 FX 圆整误差)；否则
 *   USD × FX rate, formatted; falls back to USD when the rate is missing
 *
 * `source` 标注价格来源：
 *   - "local" = 用 pricesLocal[hash]（本地 polling 直接抓目标货币）
 *   - "ci"    = 用 prices[hash] × fx（CI 快照 USD 换算）
 *   - null    = 无价格
 *
 * `median` / `buyOrder` 仅在本地 polling 抓取后写入对应字段时才有值：
 *   - median 来自 priceoverview 的 median_price（与 pricesLocal 同源）
 *   - buyOrder 来自 itemordershistogram 的 highest_buy_order（依赖 nameid 解析）
 * CI 快照不含这两个字段，CI 路径下它们保持 undefined。
 */
export function resolveLookupPrice(
  item: MarketHashItem,
  snapshot: LookupPriceSnapshot | null,
  currency: string,
): ResolvedLookupPrice {
  const hash = marketHashName(item);
  if (!hash) return NOT_TRADABLE;

  const listingUrl = steamMarketListingUrl(hash);
  const code = currency.toUpperCase();

  // 优先用本地 polling 抓的目标货币价格（无 FX 圆整误差）
  const localCurrency = snapshot?.localCurrency?.toUpperCase();
  const pricesLocal = snapshot?.pricesLocal;
  if (localCurrency && localCurrency === code && pricesLocal && hash in pricesLocal) {
    const localAmount = pricesLocal[hash] ?? null;
    const localMedian = snapshot?.medianLocal?.[hash] ?? null;
    const localBuyOrder = snapshot?.buyOrderLocal?.[hash] ?? null;

    // 即使 lowest（挂单价）为 null，只要 median 或 buyOrder 有值，仍走 local
    // 路径并返回 source="local"。这样 UI 能显示副行（成交价/收购价），
    // 主行显示「无挂单价」占位。Steam 上物品暂无挂单但有历史成交/收购单
    // 时就会落到这个分支。
    if (localAmount == null && localMedian == null && localBuyOrder == null) {
      // 三档价格全为 null：视为 no-listing（polling 抓了但 Steam 没数据）
      return {
        hash,
        state: "no-listing",
        usd: null,
        amount: null,
        display: null,
        listingUrl,
        source: null,
        median: null,
        buyOrder: null,
      };
    }
    return {
      hash,
      state: localAmount != null ? "priced" : "no-listing",
      usd: snapshot?.prices[hash] ?? null,
      amount: localAmount,
      display: localAmount != null ? formatMoney(localAmount, code) : null,
      listingUrl,
      source: "local",
      // median/buyOrder 始终从本地字段读取（可能为 null）
      median: localMedian,
      buyOrder: localBuyOrder,
    };
  }

  // 回退到 CI 快照 USD × FX
  const usd = snapshot?.prices[hash] ?? null;
  if (usd == null) {
    return {
      hash,
      state: "no-listing",
      usd: null,
      amount: null,
      display: null,
      listingUrl,
      source: null,
      median: null,
      buyOrder: null,
    };
  }

  const rate = snapshot?.fx[code] ?? (code === "USD" ? 1 : null);
  const displayCurrency = rate == null ? "USD" : code;
  const amount = usd * (rate ?? 1);

  return {
    hash,
    state: "priced",
    usd,
    amount,
    display: formatMoney(amount, displayCurrency),
    listingUrl,
    source: "ci",
    // CI 路径下 median/buyOrder 留空（CI 快照不含这两类数据）
    median: null,
    buyOrder: null,
  };
}
