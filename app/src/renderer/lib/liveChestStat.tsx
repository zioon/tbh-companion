import { useTranslation } from "react-i18next";
import { fmtCompact } from "./format";
import { cn } from "./cn";

export function LiveChestStatValue({
  total,
  perHour,
  recentPerHour,
  countClassName,
  inactive = false,
}: {
  total: number;
  perHour: number;
  /**
   * Rolling 1-hour drop rate shown alongside the session rate. Omitted when
   * null/undefined (e.g. tracker hasn't accumulated enough history yet).
   */
  recentPerHour?: number | null;
  countClassName?: string;
  /** Muted when live chest tracking is inactive (reader off or detection unavailable). */
  inactive?: boolean;
}) {
  const { t } = useTranslation("live");
  // P2-12: wrap in a polite live region so screen readers announce drop-count
  // updates as they happen. `aria-atomic` makes the whole "total (perHour/hr)"
  // string announced as a unit rather than just the changed digit. The
  // surrounding `StatCard` label ("Common chests" / "Stage boss chests") gives
  // the value its semantic context — we don't add `aria-label` here to avoid
  // duplicating that label.
  return (
    <span role="status" aria-live="polite" aria-atomic="true">
      <span className={cn(countClassName, inactive && "text-muted")}>{total.toLocaleString()}</span>
      <span className="text-base font-normal text-muted"> ({fmtCompact(perHour)}/hr)</span>
      {recentPerHour != null ? (
        <span className="ml-1 text-xs font-normal text-muted">
          {fmtCompact(recentPerHour)}/{t("chestRecentSuffix")}
        </span>
      ) : null}
    </span>
  );
}
