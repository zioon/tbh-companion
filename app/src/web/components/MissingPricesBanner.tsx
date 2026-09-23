// Web shell: yellow warning shown when the price snapshot can't be loaded.
//
// Distinguishes "missing" from "loading" via `useWebPrices` so the banner never
// flashes while the snapshot is still in flight. The catalog renders regardless;
// only the price column degrades. Links to the workflow that rebuilds the
// snapshot so a stuck snapshot is one click from its run history.

import { useTranslation } from "react-i18next";
import { HintBanner } from "../../renderer/design-system/primitives/HintBanner/HintBanner";
import { useWebPrices } from "../lib/useWebPrices";
import { PRICES_WORKFLOW_URL } from "../links";

export function MissingPricesBanner() {
  const { t } = useTranslation("web");
  const { status } = useWebPrices();

  if (status !== "missing") return null;

  return (
    <HintBanner aria-live="polite">
      {t("prices.warning")}{" "}
      <a
        className="underline hover:text-fg"
        href={PRICES_WORKFLOW_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        {t("prices.workflowLink")}
      </a>
    </HintBanner>
  );
}
