import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { StageRunStats } from "../../../../shared/types";
import { fmtClock, fmtCompact, fmtShortDuration } from "../../lib/format";
import { useEntityPanel } from "../../context/entityPanelContext";
import { ItemLink } from "../ItemLink";
import { LiveHistoryPanel, LiveHistoryRow, TIME_COLUMN_WIDTH } from "./LiveHistoryPanel";

/**
 * Per-run stage-clear log: duration + XP/gold gained since the previous
 * recorded clear. Raw material for a future "which stage is best to farm"
 * feature — this panel only lists runs, it doesn't rank or aggregate them.
 */
export function StageRunPanel({ stageRuns }: { stageRuns: StageRunStats }) {
  const { t } = useTranslation("live");
  const { history } = stageRuns;
  const { open } = useEntityPanel();

  const columns = useMemo(
    () => [
      { label: t("colClearedAt"), width: TIME_COLUMN_WIDTH },
      { label: t("colStage") },
      { label: t("colClearTime"), align: "right" as const, width: "80px" },
      { label: t("colXp"), align: "right" as const, width: "88px" },
      { label: t("colGold"), align: "right" as const, width: "80px" },
    ],
    [t],
  );

  return (
    <LiveHistoryPanel
      title={t("stageClearTitle")}
      columns={columns}
      empty={history.length === 0 ? <p className="m-0">{t("stageClearEmpty")}</p> : undefined}
    >
      {history.map((entry, i) => (
        <LiveHistoryRow
          key={`${entry.wallTime}-${entry.stageKey}-${i}`}
          index={i}
          cells={[
            {
              content: fmtClock(entry.wallTime),
              className: "tabular-nums text-muted whitespace-nowrap",
            },
            {
              content: (
                <ItemLink
                  node={{ type: "stage", id: entry.stageKey }}
                  name={entry.stageName ?? String(entry.stageKey)}
                  onNavigate={open}
                />
              ),
              className: "min-w-0",
            },
            {
              content: fmtShortDuration(entry.clearTimeSec),
              align: "right",
              className: "tabular-nums text-muted",
            },
            {
              content: `+${fmtCompact(entry.xpGained)}`,
              align: "right",
              className: "tabular-nums text-accent",
            },
            {
              content: `+${fmtCompact(entry.goldGained)}`,
              align: "right",
              className: "tabular-nums text-gold",
            },
          ]}
        />
      ))}
    </LiveHistoryPanel>
  );
}
