import { useTranslation } from "react-i18next";
import { formatMoney } from "../../../core/steamPrice";
import { GradeBars } from "./GradeBars";
import type { InventoryComposition } from "../../../../shared/types";
import { HintBanner } from "../../design-system/primitives/HintBanner/HintBanner";
import { StatCard } from "../../design-system/primitives/StatCard/StatCard";
import { Tooltip } from "../../design-system/primitives/Tooltip/Tooltip";
import { ExternalLink } from "../ui/ExternalLink";
import { DISCORD_URL } from "../../lib/externalLinks";

export function InventorySummary({
  composition,
  currency,
}: {
  composition: InventoryComposition;
  currency: string;
}) {
  const { t } = useTranslation("inventory");
  const c = composition;

  const hasListValue = c.valuedTotal != null && Number.isFinite(c.valuedTotal) && c.valuedTotal > 0;
  const hasFees = hasListValue && c.feeTotal > 0;

  const netAfterFees =
    hasListValue && c.netAfterFeesTotal != null && Number.isFinite(c.netAfterFeesTotal)
      ? formatMoney(c.netAfterFeesTotal, currency)
      : "-";

  const hasInstantValue =
    c.buyOrderValuedTotal != null &&
    Number.isFinite(c.buyOrderValuedTotal) &&
    c.buyOrderValuedTotal > 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
        <StatCard
          variant="highlight"
          label={t("summary.marketValue")}
          title={t("summary.listValueTip")}
          value={hasListValue ? formatMoney(c.valuedTotal, currency) : "-"}
          detail={
            <span>
              <span className="font-semibold text-gold">{netAfterFees}</span>{" "}
              {t("summary.afterFees")}
              {hasFees ? (
                <span className="block">
                  −{formatMoney(c.feeTotal, currency)} {t("summary.feesLabel")} (
                  <Tooltip underline trigger={<span tabIndex={0}>{t("summary.estimate")}</span>}>
                    {t("summary.estimateTip")}
                  </Tooltip>
                  )
                </span>
              ) : null}
            </span>
          }
        />

        <StatCard
          variant="highlight"
          label={t("summary.instantTotal")}
          title={t("summary.instantSellTip")}
          value={hasInstantValue ? formatMoney(c.buyOrderValuedTotal, currency) : "-"}
        />
      </div>

      <GradeBars composition={c} />
      {(c.unknownCount ?? 0) > 0 && (
        <HintBanner>
          {t("summary.unknownCount", { count: c.unknownCount ?? 0 })}{" "}
          <ExternalLink href={DISCORD_URL}>{t("summary.discord")}</ExternalLink>
        </HintBanner>
      )}
    </>
  );
}
