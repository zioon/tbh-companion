import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { steamMarketListingUrl } from "../../../core/steamPrice";
import { Tooltip } from "../../design-system/primitives/Tooltip/Tooltip";

export function MarketListingLink({
  hash,
  children,
  title,
}: {
  hash: string;
  children: ReactNode;
  title?: string;
}) {
  const { t } = useTranslation("inventory");
  const defaultTitle = useMemo(() => t("marketPrice.openOnSteam"), [t]);
  return (
    <Tooltip
      trigger={
        <a
          href={steamMarketListingUrl(hash)}
          className="group/price text-inherit no-underline hover:text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </a>
      }
    >
      {title ?? defaultTitle}
    </Tooltip>
  );
}
