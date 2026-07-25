import { useState, type MouseEvent, type ReactElement } from "react";
import { SiSteam } from "react-icons/si";
import { LuExternalLink, LuRefreshCw } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import type { LookupItem } from "../../../../shared/types";
import { formatMoney } from "../../../core/steamPrice";
import { cn } from "../../lib/cn";
import { useLookupPrices } from "../../lib/useLookupPrices";
import { triggerLookupPricePoll } from "../../lib/useLookupPricePolling";
import { reportIpcError } from "../../lib/reportError";
import { MarketListingLink } from "../inventory/MarketListingLink";

/**
 * Compact Steam Market price pinned to the top-right of an item's header
 * (grid card, detail panel, and peek). `interactive` wraps it in a link to the
 * Steam listing — true for grid cards and the detail panel, false for peeks.
 * Renders nothing for non-tradable items, or for no-listing items in a
 * non-interactive peek (kept clean).
 *
 * 三行价格（仅当本地 polling 抓到对应字段时显示，否则只显示主行）：
 *   1. 最低出售价（主行，含 Steam 图标 + source 标签）
 *   2. 最近成交价（median_price，灰色小字「成交」）
 *   3. 最高收购价（highest_buy_order，灰色小字「收购」）
 * CI 快照路径下 median/buyOrder 为 null，仅显示主行。
 *
 * 「立即刷新此物品」按钮：仅在 `interactive && price.hash` 时显示。
 * 点击调用 `triggerLookupPricePoll(hash)` 走单 hash 抓取路径（不依赖
 * polling 是否启用、不走 owned/watched 筛选），抓到三档价格后通过
 * `LOOKUP_PRICES` 流式 push 回 UI，组件自身状态刷新。
 */
export function LookupPrice({
  item,
  interactive = false,
}: {
  item: LookupItem;
  interactive?: boolean;
}) {
  const { t } = useTranslation("lookup");
  const { resolve, currency } = useLookupPrices();
  const price = resolve(item);
  const [refreshing, setRefreshing] = useState(false);

  if (price.state === "not-tradable") return null;
  if (price.state === "no-listing" && !interactive) return null;

  const isNoListing = price.state === "no-listing";
  const mainLabel = isNoListing ? t("price.noListedPrice") : price.display;
  const title = isNoListing
    ? t("price.noListingTitle")
    : price.source === "local"
      ? t("price.localSourceTitle")
      : t("price.approximateTitle");

  // 副行只在本地 polling 路径下显示（CI 路径 median/buyOrder 均为 null）。
  // 注意：no-listing 状态下（lowest=null 但有 median/buyOrder）也显示副行，
  // 让用户看到「有成交价/收购价但暂无挂单」的情况。
  const isLocal = price.source === "local";
  const showMedian = isLocal && price.median != null;
  const showBuyOrder = isLocal && price.buyOrder != null;
  const showNoMedian = isLocal && price.median == null;
  const showNoBuyOrder = isLocal && price.buyOrder == null;
  const hasSubRow = showMedian || showBuyOrder || showNoMedian || showNoBuyOrder;

  const onRefresh = async (e: MouseEvent): Promise<void> => {
    // 阻止冒泡到外层卡片（grid card 点击会打开 detail panel）和默认行为
    e.preventDefault();
    e.stopPropagation();
    if (!price.hash || refreshing) return;
    setRefreshing(true);
    try {
      await triggerLookupPricePoll(price.hash);
    } catch (err) {
      reportIpcError(err, "LookupPrice:refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const body = (
    <div className="flex flex-col items-end gap-0.5 text-[12px] leading-tight">
      {/* 主行：最低出售价 */}
      <span className="inline-flex items-center gap-1">
        <SiSteam className="size-3 text-muted" aria-hidden />
        <span
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap",
            isNoListing ? "italic text-muted" : "font-medium text-accent",
          )}
        >
          {/* Plain inline span so the link underline reaches the text — an
              inline-flex ancestor would otherwise block text-decoration. */}
          <span className="group-hover/price:underline">{mainLabel}</span>
          {interactive ? <LuExternalLink className="size-3 text-muted" aria-hidden /> : null}
        </span>
        {/* 价格来源标记：local = 本地 polling 直接抓的目标货币价；ci = CI 快照 USD×FX。
            只在 priced 状态显示，让用户一眼看出价格准确度。 */}
        {!isNoListing && price.source === "local" ? (
          <span
            className="rounded-sm bg-accent/15 px-1 text-[10px] font-medium leading-tight text-accent"
            title={t("price.localSourceTitle")}
          >
            {t("price.localBadge")}
          </span>
        ) : null}
      </span>
      {/* 副行：成交价 + 收购价（仅本地 polling 路径下显示） */}
      {hasSubRow ? (
        <div className="flex flex-col items-end gap-px text-[10px] text-muted">
          {showMedian ? (
            <PriceRow
              label={t("price.rowLabelMedian")}
              value={price.median ?? null}
              currency={currency}
            />
          ) : showNoMedian ? (
            <span className="italic text-muted/70">{t("price.noMedian")}</span>
          ) : null}
          {showBuyOrder ? (
            <PriceRow
              label={t("price.rowLabelBuyOrder")}
              value={price.buyOrder ?? null}
              currency={currency}
            />
          ) : showNoBuyOrder ? (
            <span className="italic text-muted/70">{t("price.noBuyOrder")}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (interactive && price.hash) {
    return (
      <div className="inline-flex items-start gap-1">
        <MarketListingLink hash={price.hash} title={title}>
          {body}
        </MarketListingLink>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className={cn(
            "mt-px inline-flex size-4 items-center justify-center rounded text-muted hover:bg-fg/5 hover:text-accent",
            refreshing && "cursor-not-allowed opacity-60",
          )}
          title={refreshing ? t("price.refreshingThisItem") : t("price.refreshThisItem")}
          aria-label={t("price.refreshThisItem")}
          aria-busy={refreshing}
        >
          <LuRefreshCw className={cn("size-3", refreshing && "animate-spin")} aria-hidden />
        </button>
      </div>
    );
  }
  return body;
}

/**
 * 副行渲染：label + formatMoney 格式化的值。
 * formatMoney 在 core/steamPrice 里，根据 ISO 货币代码生成带符号的本地化字符串
 * （与主行 price.display 同一格式化函数）。
 */
function PriceRow({
  label,
  value,
  currency,
}: {
  label: string;
  value: number | null;
  currency: string;
}): ReactElement {
  if (value == null) return <span className="italic text-muted/70">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted/70">{label}</span>{" "}
      <span className="font-medium text-fg/80">{formatMoney(value, currency)}</span>
    </span>
  );
}
