import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { STEAM_CURRENCIES } from "../../core/steamPrice";
import { useLastPriceRefreshMessage, usePriceStatus, usePriceActions } from "../lib/usePrices";
import { useLookupPrices } from "../lib/useLookupPrices";
import { formatPriceRefreshMessage } from "../lib/formatPriceRefreshMessage";
import { reportIpcError } from "../lib/reportError";
import { SteamPriceProgress } from "../components/market/SteamPriceProgress";
import { LookupPriceChangeLog } from "../components/market/LookupPriceChangeLog";
import { Button } from "../design-system/primitives/Button/Button";
import { Card } from "../design-system/primitives/Card/Card";
import { Field } from "../design-system/primitives/Field/Field";
import { Select } from "../design-system/primitives/Select/Select";
import { Switch } from "../design-system/primitives/Switch/Switch";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import type { PriceStatus } from "../../../shared/types";

function fmtAge(t: ReturnType<typeof useTranslation<"market">>["t"], iso: string | null): string {
  if (!iso) return t("ageNever");
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return t("ageSeconds", { count: secs });
  if (secs < 3600) return t("ageMinutes", { count: Math.floor(secs / 60) });
  if (secs < 86400) return t("ageHours", { count: Math.floor(secs / 3600) });
  return t("ageDays", { count: Math.floor(secs / 86400) });
}

function formatStatusLine(
  t: ReturnType<typeof useTranslation<"market">>["t"],
  status: NonNullable<PriceStatus>,
): string {
  const { ownedTargets, freshCount, staleCount } = status;
  if (ownedTargets === 0) {
    return t("noPriceableItems");
  }
  if (staleCount > 0) {
    return t("statusLineStale", { fresh: freshCount, total: ownedTargets, stale: staleCount });
  }
  return t("statusLine", { fresh: freshCount, total: ownedTargets });
}

export function Market() {
  const { t } = useTranslation("market");
  const status = usePriceStatus();
  const { generatedUtc: lookupPricesGeneratedUtc } = useLookupPrices();
  const lastMessage = useLastPriceRefreshMessage();
  const { setPriceStatus, clearPriceProgress, clearLastPriceRefreshMessage } = usePriceActions();
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [autoScanEnabled, setAutoScanEnabledState] = useState<boolean>(true);
  const running = status?.running ?? false;

  const message = localMessage ?? lastMessage;

  // Load initial auto-scan setting from config (default true on first run).
  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((cfg) => {
        if (mounted) setAutoScanEnabledState(cfg.marketAutoScanEnabled);
      })
      .catch((err: unknown) => reportIpcError(err, "market-auto-scan:load"));
    return () => {
      mounted = false;
    };
  }, []);

  async function onAutoScanToggle(enabled: boolean) {
    setAutoScanEnabledState(enabled);
    try {
      await window.tbh.setMarketAutoScanEnabled(enabled);
    } catch (err) {
      reportIpcError(err, "market-auto-scan:toggle");
      // Revert local state on failure so the switch reflects reality.
      setAutoScanEnabledState(!enabled);
    }
  }

  async function onCurrencyChange(iso: string) {
    const s = await window.tbh.setCurrency(iso);
    setPriceStatus(s);
    setLocalMessage(null);
    clearLastPriceRefreshMessage();
    clearPriceProgress();
  }

  async function onRefresh(force: boolean) {
    setLocalMessage(null);
    clearLastPriceRefreshMessage();
    clearPriceProgress();
    try {
      const res = await window.tbh.refreshPrices(force);
      if (res.queued || res.noop || !res.ok) {
        setPriceStatus(res.status);
        setLocalMessage(
          formatPriceRefreshMessage(t, {
            ...res,
            ownedTargets: res.status.ownedTargets,
          }),
        );
      } else {
        setPriceStatus(res.status);
      }
    } catch (err) {
      reportIpcError(err, "market-refresh");
      setLocalMessage(t("refreshFailed"));
    }
  }

  const ownedTargets = status?.ownedTargets ?? 0;
  const showEmptyHint = ownedTargets === 0 && !running;

  const statusLine = useMemo(() => (status ? formatStatusLine(t, status) : "—"), [t, status]);
  const currencyText = t("currencySuffix", { code: status?.currency ?? "-" });
  const updatedText = t("updatedAgo", { age: fmtAge(t, status?.fetchedUtc ?? null) });
  const lookupUpdatedText = t("lookupPricesUpdated", {
    age: fmtAge(t, lookupPricesGeneratedUtc),
  });

  return (
    <TabPage>
      <TabHeader title={t("tabTitle")} intro={t("intro")} />

      <div className="flex flex-col gap-3.5">
        <ul className="m-0 list-disc pl-[18px] text-muted [&>li]:mb-1">
          <li>{t("tipInventoryStale")}</li>
          <li>{t("tipCurrencySync")}</li>
          <li>{t("tipForceFull")}</li>
          <li>{t("tipAutoScan")}</li>
        </ul>

        {showEmptyHint && (
          <Card padding="compact" className="text-muted">
            {t("emptyHint")}
          </Card>
        )}

        <div className="flex flex-wrap items-end gap-2.5">
          <Field label={t("currencyLabel")}>
            <Select
              value={status?.currency ?? "USD"}
              disabled={running}
              onValueChange={(value) => void onCurrencyChange(String(value))}
              options={STEAM_CURRENCIES.map((c) => ({
                value: c.iso,
                label: `${c.iso} - ${c.label}`,
              }))}
            />
          </Field>

          {!running ? (
            <>
              <Button variant="primary" onClick={() => void onRefresh(false)}>
                {t("refreshButton")}
              </Button>
              <Button title={t("forceFullTitle")} onClick={() => void onRefresh(true)}>
                {t("forceFullButton")}
              </Button>
            </>
          ) : null}

          <label className="flex items-center gap-2 text-[13px] text-muted">
            <Switch
              checked={autoScanEnabled}
              onCheckedChange={(c) => void onAutoScanToggle(c)}
              aria-label={t("autoScanAria")}
            />
            {t("autoScanLabel")}
          </label>
        </div>

        <div className="flex items-baseline gap-4 text-[13px]">
          <span>{statusLine}</span>
          <span className="text-muted">{currencyText}</span>
          <span className="text-muted">{updatedText}</span>
        </div>

        <SteamPriceProgress variant="full" />

        {message && <p className="m-0 text-[13px]">{message}</p>}

        <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
          <h3 className="m-0 text-sm font-semibold text-fg">{t("lookupTitle")}</h3>
          <p className="m-0 text-[13px] text-muted">{t("lookupDescription")}</p>
          <span className="text-[13px] text-muted">{lookupUpdatedText}</span>
        </div>

        <LookupPriceChangeLog />
      </div>
    </TabPage>
  );
}
