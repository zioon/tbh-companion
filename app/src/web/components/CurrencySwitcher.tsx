// Web shell: Steam Market display-currency switcher.
//
// The CI price snapshot is USD-denominated with an FX table, so the web can
// only offer currencies it actually has a rate for — offering one it doesn't
// would silently resolve to USD (the resolve path's rule) and render a $ amount
// under a ¥ label. The option list is therefore Steam's wallet currencies
// intersected with the snapshot's `fx` table, which is only known once the
// snapshot has loaded; until then (and if the snapshot is missing) only USD is
// offered.
//
// The current selection lives in the web runtime (mirrored from
// `config.currency`), so changing it re-prices the loaded inventory, re-renders
// the Trading KPIs and pushes a new `PriceStatus` for Lookup — all three read
// the same value.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuCoins } from "react-icons/lu";
import { STEAM_CURRENCIES } from "../../core/steamPrice";
import { reportIpcError } from "../../renderer/lib/reportError";
import { useWebPrices } from "../lib/useWebPrices";
import { useWebRuntime } from "../lib/useWebRuntime";

export function CurrencySwitcher() {
  const { t } = useTranslation("web");
  const runtime = useWebRuntime();
  const { snapshot } = useWebPrices();

  const options = useMemo(() => {
    const rates = snapshot?.fx;
    const pool = rates
      ? STEAM_CURRENCIES.filter((c) => rates[c.iso] != null)
      : STEAM_CURRENCIES.filter((c) => c.iso === "USD");
    // Keep the live selection visible even while the snapshot is still loading
    // (or when a persisted currency has no rate in this snapshot) — otherwise
    // the <select> would silently display the first option instead.
    if (!pool.some((c) => c.iso === runtime.currency)) {
      const current = STEAM_CURRENCIES.find((c) => c.iso === runtime.currency);
      if (current) return [current, ...pool];
    }
    return pool;
  }, [snapshot, runtime.currency]);

  async function onChange(next: string): Promise<void> {
    try {
      await window.tbh.setCurrency(next);
    } catch (err) {
      reportIpcError(err);
    }
  }

  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{t("currency")}</span>
      <LuCoins
        aria-hidden
        className="pointer-events-none absolute left-2.5 size-[14px] text-muted"
        strokeWidth={1.8}
      />
      <select
        value={runtime.currency}
        aria-label={t("currency")}
        onChange={(e) => void onChange(e.target.value)}
        className="cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pr-7 pl-8 text-xs font-medium text-muted transition-colors hover:border-muted hover:text-fg focus:outline-none"
      >
        {options.map((c) => (
          <option key={c.iso} value={c.iso}>
            {c.iso}
          </option>
        ))}
      </select>
      <LuChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 size-3 text-faint"
        strokeWidth={2.4}
      />
    </label>
  );
}
