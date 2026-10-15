import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChestDropCategory, ChestDropStats } from "../../../../shared/types";
import { HintBanner } from "../../design-system/primitives/HintBanner/HintBanner";
import { fmtClock } from "../../lib/format";
import { cn } from "../../lib/cn";
import { LiveHistoryPanel, LiveHistoryRow, TIME_COLUMN_WIDTH } from "./LiveHistoryPanel";

const CHEST_NAME_KEY: Record<ChestDropCategory, string> = {
  common: "commonChests",
  rare: "stageBossChests",
  act: "actBossChests",
  plagueCommon: "plagueCommonChests",
  plagueRare: "plagueRareChests",
  plagueAct: "plagueActChests",
};

/** Category rows that should render the highlight color in the drop log. */
const HIGHLIGHTED: ReadonlySet<ChestDropCategory> = new Set(["rare", "plagueRare"]);

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
                // Prefer the entry's own catalog name, which carries the LEVEL
                // ("Stage Boss Box Lv90"). The drop path books the real item id
                // whenever the drop's map resolves it (`recordStagedChestDrop`),
                // so the level is on the entry. Fall back to the localized
                // category label only for entries still booked into the
                // synthetic bucket — legacy/restored rows, or a map whose route
                // did not resolve. Showing the generic label there is honest;
                // showing a guessed level would not be.
                content: isSyntheticLiveBucket(entry.itemKey)
                  ? t(CHEST_NAME_KEY[entry.category] ?? "colChest")
                  : entry.name,
                className: cn(
                  "min-w-0 truncate",
                  HIGHLIGHTED.has(entry.category) ? "text-status-info" : "text-fg",
                ),
              },
            ]}
          />
        ))}
      </LiveHistoryPanel>
    </>
  );
}

/**
 * The synthetic per-category bucket ids `recordLiveChestDrop` books when the
 * drop's map resolved no level.
 *
 * They sit far above any real catalog id (910011–935203) and are exactly the
 * `LIVE_CHEST_KEY` set in `core/chestDropTracker.ts`, so membership is what
 * distinguishes "level known" from "category only" without a second lookup.
 */
const SYNTHETIC_LIVE_BUCKET_IDS: ReadonlySet<number> = new Set([
  900910, 900920, 900930, 900915, 900925, 900935,
]);

function isSyntheticLiveBucket(itemKey: number): boolean {
  return SYNTHETIC_LIVE_BUCKET_IDS.has(itemKey);
}
