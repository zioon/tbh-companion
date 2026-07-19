import { useTranslation } from "react-i18next";
import type { ResolvedInventoryRow } from "../../../../shared/types";
import {
  displayRawMoney,
  marketPriceShowsDual,
  marketPriceTooltip,
} from "../../lib/marketPriceDisplay";
import { MarketListingLink } from "./MarketListingLink";

function emptyPriceDisplay(
  t: ReturnType<typeof useTranslation<"inventory">>["t"],
  row: ResolvedInventoryRow,
): { label: string; title: string } {
  if (row.priceChecked) {
    return {
      label: t("marketPrice.noListingsLabel"),
      title: t("marketPrice.noListingsTitle"),
    };
  }
  return {
    label: t("marketPrice.notLoadedLabel"),
    title: t("marketPrice.notLoadedTitle"),
  };
}

export function MarketPriceCell({
  row,
  hash,
  currency,
}: {
  row: ResolvedInventoryRow;
  hash: string;
  currency: string;
}) {
  const { t } = useTranslation("inventory");
  const { rawMedian, rawLowest } = row;
  const hasSellPrice = Boolean(rawMedian || rawLowest || row.priceRaw);

  if (!hasSellPrice) {
    const empty = emptyPriceDisplay(t, row);
    return (
      <MarketListingLink hash={hash} title={empty.title}>
        <span className="text-muted">{empty.label}</span>
      </MarketListingLink>
    );
  }

  if (marketPriceShowsDual(rawMedian, rawLowest)) {
    const med = displayRawMoney(rawMedian, currency) ?? rawMedian;
    const low = displayRawMoney(rawLowest, currency) ?? rawLowest;
    return (
      <MarketListingLink hash={hash} title={marketPriceTooltip(rawMedian, rawLowest, currency)}>
        <span className="whitespace-nowrap">
          {med}
          <span className="ml-1 text-xs text-muted">({low})</span>
        </span>
      </MarketListingLink>
    );
  }

  const singleRaw = rawMedian ?? rawLowest ?? row.priceRaw;
  const single = displayRawMoney(singleRaw, currency) ?? singleRaw;
  return (
    <MarketListingLink hash={hash} title={marketPriceTooltip(rawMedian, rawLowest, currency)}>
      {single}
    </MarketListingLink>
  );
}
