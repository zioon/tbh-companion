import { LuRotateCw, LuStar } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn } from "../../lib/cn";
import { useLookupPricePolling, triggerLookupPricePoll } from "../../lib/useLookupPricePolling";
import { reportIpcError } from "../../lib/reportError";
import { Button } from "../../design-system/primitives/Button/Button";

/**
 * Format "Xs/m/h/d ago" for a last-cycle timestamp. Lives at module scope so
 * the `Date.now()` call is not flagged by `react-hooks/purity` (which forbids
 * impure calls directly inside a component body). Mirrors the pattern in
 * `LookupPriceChangeLog.tsx`'s `formatAge`.
 */
function formatLastCycleAge(
  t: TFunction<"lookup">,
  lastAt: number | null | undefined,
): string | null {
  if (!lastAt) return null;
  const secs = Math.max(0, Math.floor((Date.now() - lastAt) / 1000));
  if (secs < 60) return t("polling.ageSeconds", { count: secs });
  if (secs < 3600) return t("polling.ageMinutes", { count: Math.floor(secs / 60) });
  if (secs < 86400) return t("polling.ageHours", { count: Math.floor(secs / 3600) });
  return t("polling.ageDays", { count: Math.floor(secs / 86400) });
}

/**
 * Compact polling status row for the Lookup tab. Sits next to the title and
 * exposes:
 *   - a refresh icon button (trigger one cycle now)
 *   - live progress text while a cycle is running (e.g. "3/12  priced 2")
 *   - last cycle summary when idle (e.g. "last: 10/12 priced · 2m ago")
 *   - a hint when polling is disabled (so the icon isn't a no-op mystery)
 *
 * The star icon is purely decorative here — item-level star toggle lives on
 * each ItemCard. This component just reports how many watched hashes are
 * configured so users can see their watchlist is being respected.
 */
export function LookupPollingStatusRow() {
  const { t } = useTranslation("lookup");
  const status = useLookupPricePolling();
  const running = status?.running ?? false;
  const enabled = status?.enabled ?? false;

  async function onTrigger() {
    try {
      await triggerLookupPricePoll();
    } catch (err) {
      reportIpcError(err, "lookup-polling:trigger");
    }
  }

  const progress = status?.progress;
  const last = status?.lastCycleResult;
  const lastAt = status?.lastCycleAtMs;
  const ageLabel = formatLastCycleAge(t, lastAt);

  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <Button
        variant="icon"
        onClick={() => void onTrigger()}
        disabled={!enabled || running}
        title={
          !enabled
            ? t("polling.disabledHint")
            : running
              ? t("polling.runningHint")
              : t("polling.triggerTitle")
        }
        aria-label={t("polling.triggerAria")}
      >
        <LuRotateCw className={cn("size-3.5", running && "animate-spin")} aria-hidden />
      </Button>

      {enabled ? (
        running && progress ? (
          <span>
            {t("polling.progress", {
              processed: progress.processed,
              targets: progress.targets,
              priced: progress.priced,
            })}
            {progress.rateLimited > 0
              ? t("polling.progressRateLimited", { count: progress.rateLimited })
              : null}
          </span>
        ) : last ? (
          <span>
            {t("polling.lastCycle", {
              priced: last.priced,
              targets: last.targets,
            })}
            {last.aborted ? t("polling.abortedSuffix") : null}
            {last.rateLimited > 0
              ? t("polling.lastCycleRateLimited", { count: last.rateLimited })
              : null}
            {ageLabel ? t("polling.lastCycleAt", { age: ageLabel }) : null}
          </span>
        ) : (
          <span>{t("polling.idle")}</span>
        )
      ) : (
        <span>{t("polling.disabled")}</span>
      )}

      {enabled && status?.config.watchedHashes.length ? (
        <span
          className="inline-flex items-center gap-0.5"
          title={t("polling.watchedCountTitle", { count: status.config.watchedHashes.length })}
        >
          <LuStar className="size-3 fill-current text-amber-400" aria-hidden />
          {status.config.watchedHashes.length}
        </span>
      ) : null}
    </div>
  );
}
