import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { LuHistory } from "react-icons/lu";
import { useLookupPriceHistory } from "../../lib/useLookupPriceHistory";

function formatUsd(usd: number | null): string {
  if (usd == null) return "—";
  if (usd < 0.1) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatAge(t: TFunction<"market">, ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return t("changeLog.ageSeconds", { count: secs });
  if (secs < 3600) return t("changeLog.ageMinutes", { count: Math.floor(secs / 60) });
  if (secs < 86400) return t("changeLog.ageHours", { count: Math.floor(secs / 3600) });
  return t("changeLog.ageDays", { count: Math.floor(secs / 86400) });
}

function changeDirection(
  oldUsd: number | null,
  newUsd: number | null,
): "up" | "down" | "flat" | "new" | "delisted" {
  if (oldUsd == null && newUsd != null) return "new";
  if (oldUsd != null && newUsd == null) return "delisted";
  if (oldUsd == null && newUsd == null) return "flat";
  if (newUsd! > oldUsd!) return "up";
  if (newUsd! < oldUsd!) return "down";
  return "flat";
}

/**
 * Compact "recent price changes" log for the Market tab. Renders the most
 * recent 50 changes observed on the LOOKUP_PRICES push channel (CI refresh +
 * local polling merges). Pure client-side; resets on reload.
 *
 * Shows: hash, old → new price (with arrow + color for up/down), and age.
 * Hashes are the Steam `market_hash_name` — long, but truncating keeps the
 * layout stable. Users can cross-reference by hovering to see the full hash.
 */
export function LookupPriceChangeLog() {
  const { t } = useTranslation("market");
  const changes = useLookupPriceHistory();

  if (changes.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
      <div className="flex items-center gap-1.5">
        <LuHistory className="size-3.5 text-muted" aria-hidden />
        <h3 className="m-0 text-sm font-semibold text-fg">{t("changeLog.title")}</h3>
        <span className="text-xs text-muted">
          {t("changeLog.subtitle", { count: changes.length })}
        </span>
      </div>
      <ul className="m-0 max-h-[260px] list-none space-y-0.5 overflow-y-auto p-0 text-[12px]">
        {changes.map((c, idx) => {
          const dir = changeDirection(c.oldUsd, c.newUsd);
          const dirColor =
            dir === "up"
              ? "text-status-success"
              : dir === "down"
                ? "text-danger"
                : dir === "new"
                  ? "text-status-success"
                  : dir === "delisted"
                    ? "text-danger"
                    : "text-muted";
          const dirLabel = t(`changeLog.dir.${dir}`);
          return (
            <li key={`${c.hash}-${c.atMs}-${idx}`} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[11px] text-muted" title={c.hash}>
                {c.hash.length > 40 ? `${c.hash.slice(0, 38)}…` : c.hash}
              </span>
              <span className={`shrink-0 font-medium ${dirColor}`}>
                {formatUsd(c.oldUsd)} → {formatUsd(c.newUsd)}
              </span>
              <span className={`shrink-0 text-[11px] ${dirColor}`}>{dirLabel}</span>
              <span className="ml-auto shrink-0 text-muted">{formatAge(t, c.atMs)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
