// Web shell: Trading page.
//
// The desktop Trading tab depends on a local, continuously-polled price-history
// store which the web build has no equivalent of. The web page instead reads the
// same catalog the Lookup tab uses, keeps only tradable items
// (`marketHashName() != null`), and shows each one's latest Steam Market listing
// price from the same-origin snapshot.
//
// The catalog always renders; only the price column degrades. When the snapshot
// is *missing* (404 / network error / bad shape) a yellow banner appears; while
// it is still *loading* it does not.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { resolveLookupPrice } from "../../core/lookupPrice";
import { marketHashName } from "../../core/marketName";
import { useLookupCatalog } from "../../renderer/lib/useLookupCatalog";
import { gradeColor } from "../../renderer/lib/gradeColor";
import { gradeLabel } from "../../renderer/lib/itemLabels";
import { iconSrc } from "../../renderer/lib/iconSrc";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { ItemIcon } from "../../renderer/design-system/primitives/ItemIcon/ItemIcon";
import { TabHeader } from "../../renderer/design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../../renderer/design-system/primitives/TabPage/TabPage";
import { useWebPrices } from "../lib/useWebPrices";
import { MissingPricesBanner } from "../components/MissingPricesBanner";

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="compact" className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-fg">{value}</span>
    </Card>
  );
}

export function TradingPanel() {
  const { t, i18n } = useTranslation("web");
  const { t: tTabs } = useTranslation("tabs");
  const { t: tLookup } = useTranslation("lookup");
  const catalog = useLookupCatalog();
  const { snapshot } = useWebPrices();

  const currency = snapshot?.baseCurrency ?? "USD";

  // Tradable catalog rows, each resolved against the snapshot. Sorted priced
  // first (cheapest of the expensive → descending) then unpriced by name so the
  // interesting rows lead.
  const rows = useMemo(() => {
    const priceable = (catalog ?? []).filter((item) => marketHashName(item) != null);
    const resolved = priceable.map((item) => ({
      item,
      price: resolveLookupPrice(item, snapshot, currency),
    }));
    resolved.sort((a, b) => {
      const aUsd = a.price.usd;
      const bUsd = b.price.usd;
      if (aUsd != null && bUsd != null) return bUsd - aUsd;
      if (aUsd != null) return -1;
      if (bUsd != null) return 1;
      return a.item.name.localeCompare(b.item.name);
    });
    return resolved;
  }, [catalog, snapshot, currency]);

  const priced = rows.filter((row) => row.price.state === "priced").length;
  const coverage = rows.length > 0 ? Math.round((priced / rows.length) * 100) : 0;

  const updatedLabel = useMemo(() => {
    if (!snapshot?.generatedUtc) return t("trading.updatedUnknown");
    const date = new Date(snapshot.generatedUtc);
    if (Number.isNaN(date.getTime())) return t("trading.updatedUnknown");
    return t("trading.updatedAt", { time: date.toLocaleString(i18n.language) });
  }, [snapshot, t, i18n.language]);

  return (
    <TabPage>
      <TabHeader title={tTabs("trading")} intro={t("trading.intro")} />

      <MissingPricesBanner />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Kpi label={t("trading.kpiTradable")} value={rows.length.toLocaleString()} />
        <Kpi label={t("trading.kpiPriced")} value={priced.toLocaleString()} />
        <Kpi label={t("trading.kpiCoverage")} value={`${coverage}%`} />
      </div>

      <p className="m-0 text-xs text-muted">{updatedLabel}</p>

      {rows.length === 0 ? (
        <Card padding="compact" className="text-muted">
          {t("trading.empty")}
        </Card>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1.5 pr-2 font-medium">{t("trading.colItem")}</th>
              <th className="py-1.5 pr-2 font-medium">{t("trading.colGrade")}</th>
              <th className="py-1.5 text-right font-medium">{t("trading.colPrice")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, price }) => (
              <tr key={item.id} className="border-t border-border/50">
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-2">
                    <ItemIcon
                      src={iconSrc(item.iconPath)}
                      color={gradeColor(item.grade)}
                      size="sm"
                    />
                    <span className="truncate text-fg">{item.name}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-2" style={{ color: gradeColor(item.grade) }}>
                  {gradeLabel(item.grade, tLookup)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {price.display ?? <span className="text-muted">{t("trading.never")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TabPage>
  );
}
