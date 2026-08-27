import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { StageRunStats, StageRunHistoryEntry } from "../../../../shared/types";
import { fmtClock, fmtCompact, fmtShortDuration } from "../../lib/format";
import { useEntityPanel } from "../../context/entityPanelContext";
import { ItemLink } from "../ItemLink";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { LiveHistoryPanel, LiveHistoryRow, TIME_COLUMN_WIDTH } from "./LiveHistoryPanel";

/**
 * Per-run stage log: clears carry duration + XP/gold gained since the previous
 * recorded clear; failed runs (inferred from live run boundaries without a
 * clear event, see `core/stageRunTracker.ts`) show the furthest wave reached
 * and no XP/gold. Raw material for a future "which stage is best to farm"
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
      { label: t("colClearTime"), align: "right" as const, width: "96px" },
      { label: t("colXp"), align: "right" as const, width: "88px" },
      { label: t("colGold"), align: "right" as const, width: "80px" },
    ],
    [t],
  );

  const stageCell = (entry: StageRunHistoryEntry) => (
    <>
      <ItemLink
        node={{ type: "stage", id: entry.stageKey }}
        name={entry.stageName ?? String(entry.stageKey)}
        onNavigate={open}
      />
      {entry.outcome === "fail" && (
        <Badge variant="full" className="ml-1.5">
          {t("stageFailLabel")}
        </Badge>
      )}
    </>
  );

  return (
    <LiveHistoryPanel
      title={t("stageClearTitle")}
      columns={columns}
      empty={
        history.length === 0 ? (
          <div className="m-0">
            <p className="m-0 mb-1">{t("stageClearEmpty")}</p>
            <p className="m-0 text-muted">
              {t("stageClearFieldsHint", {
                fields: [
                  t("colClearedAt"),
                  t("colStage"),
                  t("colClearTime"),
                  t("colXp"),
                  t("colGold"),
                ].join(" · "),
              })}
            </p>
          </div>
        ) : undefined
      }
    >
      {history.map((entry, i) =>
        entry.outcome === "fail" ? (
          <LiveHistoryRow
            key={`${entry.wallTime}-${entry.stageKey}-${i}`}
            index={i}
            cells={[
              {
                content: fmtClock(entry.wallTime),
                className: "tabular-nums text-muted whitespace-nowrap",
              },
              { content: stageCell(entry), className: "min-w-0" },
              {
                content: t("stageFailAt", { wave: entry.failedWave }),
                align: "right",
                className: "tabular-nums whitespace-nowrap text-status-danger",
              },
              {
                content: "—",
                align: "right",
                className: "tabular-nums text-muted",
              },
              {
                content: "—",
                align: "right",
                className: "tabular-nums text-muted",
              },
            ]}
          />
        ) : (
          <LiveHistoryRow
            key={`${entry.wallTime}-${entry.stageKey}-${i}`}
            index={i}
            cells={[
              {
                content: fmtClock(entry.wallTime),
                className: "tabular-nums text-muted whitespace-nowrap",
              },
              { content: stageCell(entry), className: "min-w-0" },
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
        ),
      )}
    </LiveHistoryPanel>
  );
}
