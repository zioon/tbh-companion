import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChestDropStats } from "../../../../shared/types";
import { HintBanner } from "../../design-system/primitives/HintBanner/HintBanner";
import { fmtClock } from "../../lib/format";
import { cn } from "../../lib/cn";
import { LiveHistoryPanel, LiveHistoryRow, TIME_COLUMN_WIDTH } from "./LiveHistoryPanel";

/**
 * Chest drop history log. Per-category totals/rates already show as stat
 * cards above (Common chests, Stage boss chests) — this panel is just the
 * chronological drop log, not a duplicate breakdown.
 */
export function ChestDropPanel({
  chestDrops,
  inactiveMessage,
}: {
  chestDrops: ChestDropStats;
  /** When set, chest session tracking is inactive — explain why zeros are not live drops. */
  inactiveMessage?: string | null;
}) {
  const { t } = useTranslation("live");
  const { history } = chestDrops;

  const columns = useMemo(
    () => [{ label: t("colDroppedAt"), width: TIME_COLUMN_WIDTH }, { label: t("colChest") }],
    [t],
  );

  return (
    <>
      {inactiveMessage ? <HintBanner>{inactiveMessage}</HintBanner> : null}
      <LiveHistoryPanel
        title={t("chestHistoryTitle")}
        columns={columns}
        empty={
          history.length === 0 ? (
            <p className="m-0">
              {inactiveMessage ? t("chestHistoryEmptyInactive") : t("chestHistoryEmpty")}
            </p>
          ) : undefined
        }
      >
        {history.map((entry, i) => (
          <LiveHistoryRow
            key={`${entry.wallTime}-${entry.itemKey}-${i}`}
            index={i}
            cells={[
              {
                content: fmtClock(entry.wallTime),
                className: "tabular-nums text-muted whitespace-nowrap",
              },
              {
                content: entry.name,
                className: cn(
                  "min-w-0 truncate",
                  entry.category === "rare" ? "text-status-info" : "text-fg",
                ),
              },
            ]}
          />
        ))}
      </LiveHistoryPanel>
    </>
  );
}
