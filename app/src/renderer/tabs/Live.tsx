import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStats } from "../lib/useStats";
import { useInventory } from "../lib/useInventory";
import { useChests } from "../lib/useChests";
import { useStageRuns } from "../lib/useStageRuns";
import { useLiveMemoryScalars } from "../lib/useLiveMemory";
import {
  fmtCompact,
  fmtDuration,
  fmtShortDuration,
  fmtXpUpdated,
  fmtClock,
  fmtHoursUntilFull,
  fmtFillEta,
} from "../lib/format";
import { predictFillTime, type ChestFillSource } from "../../core/inventory/predictFillTime";
import { reportIpcError } from "../lib/reportError";
import { Button } from "../design-system/primitives/Button/Button";
import { DataListRow } from "../design-system/primitives/DataList/DataList";
import { Checkbox } from "../design-system/primitives/Checkbox/Checkbox";
import { PanelSection } from "../design-system/primitives/PanelSection/PanelSection";
import { StatCard } from "../design-system/primitives/StatCard/StatCard";
import { MetricHero } from "../design-system/primitives/MetricHero/MetricHero";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { Tooltip } from "../design-system/primitives/Tooltip/Tooltip";
import { ChestDropPanel } from "../components/live/ChestDropPanel";
import { StageRunPanel } from "../components/live/StageRunPanel";
import {
  LiveHistoryPanel,
  LiveHistoryRow,
  TIME_COLUMN_WIDTH,
} from "../components/live/LiveHistoryPanel";
import { LiveMatchedPair } from "../components/live/LiveMatchedPair";
import { LivePanelList } from "../components/live/LivePanelList";
import { LiveChestStatValue } from "../lib/liveChestStat";
import { cn } from "../lib/cn";
import type { ChestAutoOpenPrefs } from "../../../shared/types";

const IDLE_THRESHOLD = 120;

const DEFAULT_AUTO_OPEN: ChestAutoOpenPrefs = { common: false, stageBoss: false };

export function Live() {
  const stats = useStats();
  const inventory = useInventory();
  const chests = useChests();
  const stageRuns = useStageRuns();
  const liveScalars = useLiveMemoryScalars();
  const { t } = useTranslation("live");
  const [autoOpenEnabled, setAutoOpenEnabled] = useState<ChestAutoOpenPrefs>(DEFAULT_AUTO_OPEN);
  // Mirror autoOpenEnabled in a ref so toggleAutoOpen can read the latest
  // value without depending on it (keeps the callback stable). This lets us
  // move the saveConfig IPC call *out* of the setState updater — React
  // requires updaters to be pure (StrictMode double-invokes them).
  const autoOpenRef = useRef(autoOpenEnabled);
  useEffect(() => {
    autoOpenRef.current = autoOpenEnabled;
  }, [autoOpenEnabled]);

  useEffect(() => {
    if (typeof window.tbh?.getConfig !== "function") return;

    let mounted = true;
    const syncAutoOpenPrefs = (): void => {
      void window.tbh
        .getConfig()
        .then((config) => {
          if (mounted) setAutoOpenEnabled(config.chestAutoOpenEnabled);
        })
        .catch(reportIpcError);
    };

    syncAutoOpenPrefs();

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") syncAutoOpenPrefs();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const toggleAutoOpen = useCallback((key: keyof ChestAutoOpenPrefs, checked: boolean): void => {
    const previous = autoOpenRef.current;
    const next = { ...previous, [key]: checked };
    setAutoOpenEnabled(next);
    void window.tbh.saveConfig({ chestAutoOpenEnabled: next }).catch((err: unknown) => {
      reportIpcError(err);
      // Roll back only the toggled key using the ref's latest value —
      // a concurrent toggle might have changed the other key while the
      // IPC was in flight.
      setAutoOpenEnabled((current) => ({ ...current, [key]: previous[key] }));
    });
  }, []);

  // --- Hooks must run before any early return (React Hooks rule) ---
  // All useMemos below null-check `stats` internally so they stay safe when
  // the save hasn't been read yet. The early return after them only affects
  // what gets rendered, not which hooks run.

  const commonPerHourDep = stats?.chestDrops?.commonPerHour;
  const rarePerHourDep = stats?.chestDrops?.rarePerHour;

  const fillPrediction = useMemo(() => {
    if (!inventory || !chests || !stats) return null;
    const fillSources: ChestFillSource[] = [];
    if (autoOpenEnabled.common) {
      fillSources.push({
        heldChests: chests.common.quantity,
        autoOpenSecondsPerChest: chests.autoOpen.common,
        dropsPerHour: commonPerHourDep ?? 0,
      });
    }
    if (autoOpenEnabled.stageBoss) {
      fillSources.push({
        heldChests: chests.stageBoss.quantity,
        autoOpenSecondsPerChest: chests.autoOpen.stageBoss,
        dropsPerHour: rarePerHourDep ?? 0,
      });
    }
    return predictFillTime({
      inventoryCapacity: inventory.inventoryCapacity,
      inventoryUsed: inventory.inventoryUsed,
      sources: fillSources,
    });
  }, [
    inventory,
    chests,
    stats,
    autoOpenEnabled.common,
    autoOpenEnabled.stageBoss,
    commonPerHourDep,
    rarePerHourDep,
  ]);

  const fillEstimateText = useMemo((): ReactNode => {
    if (fillPrediction?.hoursUntilFull === null) {
      return t("fillTurnOn");
    }
    if (fillPrediction && fillPrediction.hoursUntilFull !== null) {
      return (
        <>
          {t("fillFullInPrefix")}{" "}
          <span className="font-semibold text-fg">
            {fmtHoursUntilFull(fillPrediction.hoursUntilFull)}
          </span>{" "}
          {t("fillFullInMid")}{" "}
          <span className="font-semibold text-fg">{fmtFillEta(fillPrediction.hoursUntilFull)}</span>
          .
        </>
      );
    }
    return null;
  }, [fillPrediction, t]);

  const inventoryFillPrediction = useMemo(
    (): ReactNode => (
      <PanelSection
        title={
          <span className="inline-flex items-center gap-1.5">
            {t("inventoryPredictionTitle")}
            <Tooltip
              trigger={
                <span
                  className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-border text-[10px] normal-case leading-none tracking-normal text-muted"
                  tabIndex={0}
                >
                  ?
                </span>
              }
            >
              {t("inventoryPredictionTip")}
            </Tooltip>
          </span>
        }
        boxed
        contentClassName="flex flex-col gap-3 p-3"
      >
        <div className="flex flex-col gap-1.5 text-[13px] text-muted">
          {inventory && inventory.inventoryCapacity > 0 ? (
            <p className="m-0">
              {t("inventorySlotsPrefix")}{" "}
              <span className="font-semibold text-fg">
                {inventory.inventoryUsed}/{inventory.inventoryCapacity}
              </span>{" "}
              {t("inventorySlotsSuffix")}
            </p>
          ) : null}
          {/* min-h reserves room for the longer "turn on a toggle" message so swapping
            between states doesn't resize the card. */}
          <p className="m-0 min-h-[2.6em]">{fillEstimateText}</p>
          {/* Always mounted (invisible when empty) so toggling held chests in/out
            doesn't change the card's height. */}
          <p
            className={cn(
              "m-0",
              (!fillPrediction || fillPrediction.heldChestItems <= 0) && "invisible",
            )}
          >
            {fillPrediction?.heldChestItems === 1
              ? t("heldChestsOne", { count: fillPrediction?.heldChestItems ?? 0 })
              : t("heldChestsOther", { count: fillPrediction?.heldChestItems ?? 0 })}
          </p>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-3">
          <Checkbox
            label={t("commonAutoOpen")}
            checked={autoOpenEnabled.common}
            onCheckedChange={(checked) => toggleAutoOpen("common", checked)}
          />
          <Checkbox
            label={t("stageBossAutoOpen")}
            checked={autoOpenEnabled.stageBoss}
            onCheckedChange={(checked) => toggleAutoOpen("stageBoss", checked)}
          />
        </div>
      </PanelSection>
    ),
    [inventory, autoOpenEnabled, fillPrediction, toggleAutoOpen, fillEstimateText, t],
  );

  function fmtTimeToLevel(sec: number | null): string {
    if (sec === null || !Number.isFinite(sec)) return "\u2014";
    if (sec < 60) return `< 1m`;
    if (sec < 3600) return `~${Math.round(sec / 60)}m`;
    const h = sec / 3600;
    if (h < 24) return `~${h.toFixed(1)}h`;
    return `~${Math.round(h / 24)}d`;
  }

  function fmtSafeCompact(n: number | null): string {
    if (n === null || !Number.isFinite(n)) return "\u2014";
    return fmtCompact(n);
  }

  const xpHistoryColumns = useMemo(
    () => [
      { label: t("colTime"), width: TIME_COLUMN_WIDTH },
      { label: t("colXp"), align: "right" as const, width: "80px" },
      { label: t("colRate"), align: "right" as const, width: "96px" },
      { label: t("colStage"), align: "right" as const },
    ],
    [t],
  );

  const heroesPanel = useMemo(
    (): ReactNode =>
      stats ? (
        <PanelSection title={t("heroes")} boxed>
          <LivePanelList empty={stats.heroes.length === 0 ? t("heroesEmpty") : undefined}>
            {stats.heroes.length > 0 && (
              <div className="grid grid-cols-[1fr_72px_72px_64px_56px] items-center gap-3 px-3 pt-2 pb-1 text-[11px] text-muted/60 uppercase tracking-wide border-b border-border/40">
                <span>{t("colName")}</span>
                <span className="text-right">{t("colLv")}</span>
                <span className="text-right">{t("colRate")}</span>
                <Tooltip
                  trigger={
                    <span className="cursor-help underline decoration-dotted underline-offset-2 text-right">
                      {t("colRemaining")}
                    </span>
                  }
                >
                  {t("colRemainingTip")}
                </Tooltip>
                <Tooltip
                  trigger={
                    <span className="cursor-help underline decoration-dotted underline-offset-2 text-right">
                      {t("colEta")}
                    </span>
                  }
                >
                  {t("colEtaTip")}
                </Tooltip>
              </div>
            )}
            {stats.heroes.map((h, i) => (
              <DataListRow
                key={h.key}
                index={i}
                className="grid grid-cols-[1fr_72px_72px_64px_56px] items-center gap-3"
              >
                <span className="font-semibold">{h.name}</span>
                <span className="tabular-nums text-right text-muted">
                  {t("lv", { level: h.level })}
                </span>
                <span className="tabular-nums text-right text-accent">
                  {t("ratePerHour", { value: fmtCompact(h.rate) })}
                </span>
                <span className="tabular-nums text-right text-muted text-xs">
                  {fmtSafeCompact(h.xpToNextLevel)}
                </span>
                <Tooltip
                  trigger={
                    <span className="tabular-nums text-right text-xs text-muted cursor-help">
                      {fmtTimeToLevel(h.timeToLevelSec)}
                    </span>
                  }
                >
                  {h.timeToLevelSec !== null
                    ? t("tooltipAtRate", {
                        rate: fmtCompact(h.rate),
                        time: fmtShortDuration(h.timeToLevelSec),
                        level: h.level + 1,
                      })
                    : h.xpToNextLevel === null
                      ? t("remainingMaxLevel")
                      : t("remainingZero")}
                </Tooltip>
              </DataListRow>
            ))}
          </LivePanelList>
        </PanelSection>
      ) : null,
    [stats, t],
  );

  if (!stats) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">{t("tabTitle")}</h1>
        <p className="m-0 text-muted">{t("connecting")}</p>
      </div>
    );
  }

  const idle = stats.secondsSinceGain !== null && stats.secondsSinceGain > IDLE_THRESHOLD;
  const showStatus = stats.status !== "Tracking";
  const liveActive = liveScalars.connected;
  const rateTip = liveActive ? t("rateTipLive") : t("rateTipSave");
  const goldTip = liveActive ? t("goldTipLive") : t("goldTipSave");
  const intro = liveActive
    ? liveScalars.hasChestDrops
      ? t("introLive")
      : t("introLiveNoChest")
    : t("introSave");

  const { commonTotal, rareTotal, commonPerHour, rarePerHour, readerRequired } = stats.chestDrops;
  const chestReaderOff = readerRequired && !liveScalars.connected;
  const chestDetectionPending =
    readerRequired && liveScalars.connected && !liveScalars.hasChestDrops;
  const chestStatsInactive = chestReaderOff || chestDetectionPending;
  const chestRateTip = chestReaderOff
    ? t("chestTipNeedReader")
    : chestDetectionPending
      ? t("chestTipPending")
      : t("chestTipLive");
  const chestInactiveMessage = chestReaderOff
    ? t("chestTipNeedReader")
    : chestDetectionPending
      ? t("chestTipPending")
      : null;

  return (
    <TabPage>
      <TabHeader title={t("tabTitle")} intro={intro} />

      <MetricHero
        primary={
          <Tooltip
            trigger={
              <div className="flex cursor-help items-baseline gap-2" tabIndex={0}>
                <span className="text-[40px] font-bold leading-none text-accent">
                  {fmtCompact(stats.rollingRate)}
                </span>
                <span className="text-[13px] tracking-wide text-muted underline decoration-dotted decoration-muted underline-offset-2">
                  {t("xpPerHour")}
                </span>
              </div>
            }
          >
            {rateTip}
          </Tooltip>
        }
        center={
          <>
            <Tooltip
              trigger={
                <div
                  className="cursor-help text-[15px] font-semibold leading-tight text-gold"
                  tabIndex={0}
                >
                  {fmtCompact(stats.goldRate)}{" "}
                  <span className="underline decoration-dotted decoration-muted underline-offset-2">
                    {t("goldPerHour")}
                  </span>
                </div>
              }
            >
              {goldTip}
            </Tooltip>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-muted">
              <span>
                {t("map")} <b className="font-semibold text-fg">{stats.stageName}</b>
              </span>
              {!liveActive ? (
                <Tooltip
                  underline
                  trigger={
                    <span tabIndex={0}>
                      <b className="font-semibold text-fg">
                        {fmtXpUpdated(stats.secondsSinceGain)}
                      </b>
                    </span>
                  }
                >
                  {stats.secondsSinceGain === null ? t("saveStatusConnected") : t("saveStatusWhen")}
                </Tooltip>
              ) : null}
            </div>
          </>
        }
        action={
          <Button size="sm" title={t("resetTitle")} onClick={() => window.tbh.reset()}>
            {"\u21bb"} {t("reset")}
          </Button>
        }
      />

      <section className="grid grid-cols-3 gap-2.5">
        <StatCard label={t("sessionXp")} value={fmtCompact(stats.cumulativeGained)} />
        <StatCard label={t("sessionGold")} value={fmtCompact(stats.goldGained)} />
        <StatCard label={t("elapsed")} value={fmtDuration(stats.elapsed)} />
        <StatCard label={t("sessionXpPerHour")} value={fmtCompact(stats.sessionRate)} />
        <StatCard
          label={t("commonChests")}
          value={
            <LiveChestStatValue
              total={commonTotal}
              perHour={commonPerHour}
              inactive={chestStatsInactive}
            />
          }
          title={chestRateTip}
        />
        <StatCard
          label={t("stageBossChests")}
          value={
            <LiveChestStatValue
              total={rareTotal}
              perHour={rarePerHour}
              countClassName="text-status-info"
              inactive={chestStatsInactive}
            />
          }
          title={chestRateTip}
        />
      </section>

      {liveActive ? (
        <section className="grid grid-cols-6 gap-2.5">
          <StatCard label={t("dps")} value={fmtCompact(stats.dps ?? 0)} title={t("dpsTitle")} />
          <StatCard
            label={t("alive")}
            value={String(stats.aliveMonsters ?? 0)}
            title={t("aliveTitle")}
          />
          <StatCard
            label={t("hpMax")}
            value={fmtCompact(stats.hpMaxSum ?? 0)}
            title={t("hpMaxTitle")}
          />
          <StatCard
            label={t("mobsKilled")}
            value={String(stats.mapMobsKilled)}
            title={t("mobsKilledTitle")}
          />
          <StatCard
            label={t("damage")}
            value={fmtCompact(stats.mapDamage)}
            title={t("damageTitle")}
          />
        </section>
      ) : null}

      <LiveMatchedPair
        left={inventoryFillPrediction}
        right={
          <ChestDropPanel chestDrops={stats.chestDrops} inactiveMessage={chestInactiveMessage} />
        }
      />

      <LiveMatchedPair
        left={heroesPanel}
        right={
          liveActive ? (
            <StageRunPanel stageRuns={stageRuns ?? { history: [], readerRequired: true }} />
          ) : (
            <LiveHistoryPanel
              title={
                <>
                  {t("historyTitle")}{" "}
                  <span className="normal-case tracking-normal text-muted">
                    {t("historySubtitle")}
                  </span>
                </>
              }
              columns={xpHistoryColumns}
              empty={
                stats.history.length === 0 ? <p className="m-0">{t("historyEmpty")}</p> : undefined
              }
            >
              {stats.history.map((e, i) => (
                <LiveHistoryRow
                  key={`${e.wallTime}-${i}`}
                  index={i}
                  cells={[
                    {
                      content: fmtClock(e.wallTime),
                      className: "tabular-nums text-muted whitespace-nowrap",
                    },
                    {
                      content: `+${fmtCompact(e.delta)}`,
                      align: "right",
                      className: "tabular-nums text-accent",
                    },
                    {
                      content: t("ratePerHour", { value: fmtCompact(e.rate) }),
                      align: "right",
                      className: "tabular-nums",
                    },
                    {
                      content: e.stageName ?? String(e.stageKey),
                      align: "right",
                      className: "min-w-0 truncate text-muted",
                    },
                  ]}
                />
              ))}
            </LiveHistoryPanel>
          )
        }
      />

      {showStatus && (
        <footer
          className={cn("border-t border-border pt-1 text-xs text-muted", idle && "text-gold")}
        >
          {stats.status}
        </footer>
      )}
    </TabPage>
  );
}
