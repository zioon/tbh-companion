import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStats } from "../lib/useStats";
import { useInventory } from "../lib/useInventory";
import { useChests } from "../lib/useChests";
import { useStageRuns } from "../lib/useStageRuns";
import { useLiveMemoryScalars } from "../lib/useLiveMemory";
import { blendStage } from "../../core/liveMemory/blend";
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
import { stageName } from "../../core/stages";
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

const RATE_TIP_SAVE =
  "XP/hour updates only when the game writes new XP to the save (often up to " +
  "3 minutes apart, sometimes longer). It holds steady between writes instead of decaying.";
const RATE_TIP_LIVE =
  "XP/hour from live memory reads (~25 updates per second). Rates hold steady between " +
  "gains instead of decaying. Switching between live and save-only resets the session.";
const GOLD_TIP_SAVE =
  "Gold earned per hour. Counts gold gained only; spending (upgrades, Cube, " +
  "runes) is ignored, so it's accurate while farming.";
const GOLD_TIP_LIVE =
  "Gold earned per hour from live memory reads. Counts gold gained only; spending is ignored.";
const CHEST_TIP_NEED_READER =
  "Chest drop rates require the live memory reader. Turn it on in Settings → Live memory (experimental) " +
  "and keep the game running.";
const CHEST_TIP_PENDING =
  "Live chest drop tracking is not available for this game version yet — XP and gold still update from " +
  "live memory.";
const CHEST_TIP_LIVE =
  "Drop rates from live memory this session. Common and stage boss chests are tracked " +
  "separately while the companion is running.";
const INVENTORY_PREDICTION_TIP =
  "Estimates when your unlocked inventory slots fill up. For each chest type you've marked " +
  "auto-open below, we model a serial auto-open queue: held chests (from your save) drain at their open " +
  "speed (faster with reduction runes). When live chest tracking is available, session drop rates can " +
  "add more chests to the queue. Each opened chest uses one inventory slot. We can't detect the " +
  "in-game auto-open toggle, so set it here — only common and stage boss chests are modeled. Held " +
  "counts come from the save file and can lag a few minutes after in-game changes.";
const XP_HISTORY_COLUMNS = [
  { label: "Time", width: TIME_COLUMN_WIDTH },
  { label: "XP", align: "right" as const, width: "80px" },
  { label: "Rate", align: "right" as const, width: "96px" },
  { label: "Stage", align: "right" as const },
];

export function Live() {
  const stats = useStats();
  const inventory = useInventory();
  const chests = useChests();
  const stageRuns = useStageRuns();
  const liveScalars = useLiveMemoryScalars();
  const [autoOpenEnabled, setAutoOpenEnabled] = useState<ChestAutoOpenPrefs>(DEFAULT_AUTO_OPEN);

  useEffect(() => {
    if (typeof window.tbh?.getConfig !== "function") return;

    const syncAutoOpenPrefs = (): void => {
      void window.tbh
        .getConfig()
        .then((config) => setAutoOpenEnabled(config.chestAutoOpenEnabled))
        .catch(reportIpcError);
    };

    syncAutoOpenPrefs();

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") syncAutoOpenPrefs();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const toggleAutoOpen = useCallback((key: keyof ChestAutoOpenPrefs, checked: boolean): void => {
    setAutoOpenEnabled((previous) => {
      const next = { ...previous, [key]: checked };
      void window.tbh.saveConfig({ chestAutoOpenEnabled: next }).catch((err: unknown) => {
        reportIpcError(err);
        setAutoOpenEnabled(previous);
      });
      return next;
    });
  }, []);

  if (!stats) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">Live stats</h1>
        <p className="m-0 text-muted">Connecting to the save file...</p>
      </div>
    );
  }

  const idle = stats.secondsSinceGain !== null && stats.secondsSinceGain > IDLE_THRESHOLD;
  const showStatus = stats.status !== "Tracking";
  const liveActive = liveScalars.connected;
  const rateTip = liveActive ? RATE_TIP_LIVE : RATE_TIP_SAVE;
  const goldTip = liveActive ? GOLD_TIP_LIVE : GOLD_TIP_SAVE;
  const intro = liveActive
    ? liveScalars.hasChestDrops
      ? "Live memory is on — XP, gold, and chest stats update in real time from the running game."
      : "Live memory is on — XP and gold update in real time. Chest drop rates are not available for this game version yet."
    : "Reads your save on a timer. XP and gold rates update when the game writes new progress—often up to three minutes apart, sometimes longer.";

  const stage = useMemo(
    () => blendStage(liveScalars, { stageKey: stats.stageKey, stageWave: stats.stageWave }),
    [liveScalars.stageKey, liveScalars.stageWave, stats.stageKey, stats.stageWave],
  );

  const { commonTotal, rareTotal, commonPerHour, rarePerHour, readerRequired } = stats.chestDrops;
  const chestReaderOff = readerRequired && !liveScalars.connected;
  const chestDetectionPending = readerRequired && liveScalars.connected && !liveScalars.hasChestDrops;
  const chestStatsInactive = chestReaderOff || chestDetectionPending;
  const chestRateTip = chestReaderOff
    ? CHEST_TIP_NEED_READER
    : chestDetectionPending
      ? CHEST_TIP_PENDING
      : CHEST_TIP_LIVE;
  const chestInactiveMessage = chestReaderOff
    ? CHEST_TIP_NEED_READER
    : chestDetectionPending
      ? CHEST_TIP_PENDING
      : null;

  const fillPrediction = useMemo(() => {
    if (!inventory || !chests) return null;
    const fillSources: ChestFillSource[] = [];
    if (autoOpenEnabled.common) {
      fillSources.push({
        heldChests: chests.common.quantity,
        autoOpenSecondsPerChest: chests.autoOpen.common,
        dropsPerHour: commonPerHour,
      });
    }
    if (autoOpenEnabled.stageBoss) {
      fillSources.push({
        heldChests: chests.stageBoss.quantity,
        autoOpenSecondsPerChest: chests.autoOpen.stageBoss,
        dropsPerHour: rarePerHour,
      });
    }
    return predictFillTime({
      inventoryCapacity: inventory.inventoryCapacity,
      inventoryUsed: inventory.inventoryUsed,
      sources: fillSources,
    });
  }, [inventory, chests, autoOpenEnabled.common, autoOpenEnabled.stageBoss, commonPerHour, rarePerHour]);

  const fillEstimateText = useMemo((): ReactNode => {
    if (fillPrediction?.hoursUntilFull === null) {
      return "Turn on an auto-open toggle below and play a session to estimate when it'll be full.";
    }
    if (fillPrediction && fillPrediction.hoursUntilFull !== null) {
      return (
        <>
          Full in about{" "}
          <span className="font-semibold text-fg">
            {fmtHoursUntilFull(fillPrediction.hoursUntilFull)}
          </span>{" "}
          — around{" "}
          <span className="font-semibold text-fg">{fmtFillEta(fillPrediction.hoursUntilFull)}</span>
          .
        </>
      );
    }
    return null;
  }, [fillPrediction]);

  const inventoryFillPrediction = useMemo((): ReactNode => (
    <PanelSection
      title={
        <span className="inline-flex items-center gap-1.5">
          Inventory fill prediction
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
            {INVENTORY_PREDICTION_TIP}
          </Tooltip>
        </span>
      }
      boxed
      contentClassName="flex flex-col gap-3 p-3"
    >
      <div className="flex flex-col gap-1.5 text-[13px] text-muted">
        {inventory && inventory.inventoryCapacity > 0 ? (
          <p className="m-0">
            Inventory:{" "}
            <span className="font-semibold text-fg">
              {inventory.inventoryUsed}/{inventory.inventoryCapacity}
            </span>{" "}
            slots used.
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
          Includes{" "}
          <span className="font-semibold text-fg">{fillPrediction?.heldChestItems ?? 0}</span> held
          chest{fillPrediction?.heldChestItems === 1 ? "" : "s"} waiting to auto-open.
        </p>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-3">
        <Checkbox
          label="Common chests auto-open"
          checked={autoOpenEnabled.common}
          onCheckedChange={(checked) => toggleAutoOpen("common", checked)}
        />
        <Checkbox
          label="Stage boss chests auto-open"
          checked={autoOpenEnabled.stageBoss}
          onCheckedChange={(checked) => toggleAutoOpen("stageBoss", checked)}
        />
      </div>
    </PanelSection>
  ), [inventory, autoOpenEnabled, fillPrediction, toggleAutoOpen, fillEstimateText]);

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

  const heroesPanel = useMemo((): ReactNode => (
    <PanelSection title="Heroes" boxed>
      <LivePanelList empty={stats.heroes.length === 0 ? "No active heroes yet." : undefined}>
        {stats.heroes.length > 0 && (
          <div className="grid grid-cols-[1fr_72px_72px_64px_56px] items-center gap-3 px-3 pt-2 pb-1 text-[11px] text-muted/60 uppercase tracking-wide border-b border-border/40">
            <span>Name</span>
            <span className="text-right">Lv</span>
            <span className="text-right">Rate</span>
            <Tooltip
              trigger={<span className="cursor-help underline decoration-dotted underline-offset-2 text-right">Remaining</span>}
            >
              Remaining XP needed to reach next level (level curve minus current exp).
            </Tooltip>
            <Tooltip
              trigger={<span className="cursor-help underline decoration-dotted underline-offset-2 text-right">ETA</span>}
            >
              Estimated time to next level-up at the current rolling XP rate.
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
            <span className="tabular-nums text-right text-muted">Lv {h.level}</span>
            <span className="tabular-nums text-right text-accent">{fmtCompact(h.rate)}/hr</span>
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
                ? `At ${fmtCompact(h.rate)} XP/hr, ${fmtShortDuration(h.timeToLevelSec)} until level ${h.level + 1}`
                : h.xpToNextLevel === null
                  ? "Max level — no further progression defined."
                  : "Rate is zero or not yet established."}
            </Tooltip>
          </DataListRow>
        ))}
      </LivePanelList>
    </PanelSection>
  ), [stats.heroes]);

  return (
    <TabPage>
      <TabHeader title="Live stats" intro={intro} />

      <MetricHero
        primary={
          <Tooltip
            trigger={
              <div className="flex cursor-help items-baseline gap-2" tabIndex={0}>
                <span className="text-[40px] font-bold leading-none text-accent">
                  {fmtCompact(stats.rollingRate)}
                </span>
                <span className="text-[13px] tracking-wide text-muted underline decoration-dotted decoration-muted underline-offset-2">
                  XP / hr
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
                    gold / hr
                  </span>
                </div>
              }
            >
              {goldTip}
            </Tooltip>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-muted">
              <span>
                Map <b className="font-semibold text-fg">{stageName(stage.stageKey)}</b>
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
                  {stats.secondsSinceGain === null
                    ? "Connected and reading your save. Rates update when the game writes progress."
                    : "When XP last changed in your save"}
                </Tooltip>
              ) : null}
            </div>
          </>
        }
        action={
          <Button size="sm" title="Reset session stats" onClick={() => window.tbh.reset()}>
            {"\u21bb"} Reset
          </Button>
        }
      />

      <section className="grid grid-cols-3 gap-2.5">
        <StatCard label="Session XP" value={fmtCompact(stats.cumulativeGained)} />
        <StatCard label="Session gold" value={fmtCompact(stats.goldGained)} />
        <StatCard label="Elapsed" value={fmtDuration(stats.elapsed)} />
        <StatCard label="Session XP/hr" value={fmtCompact(stats.sessionRate)} />
        <StatCard
          label="Common chests"
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
          label="Stage boss chests"
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
          <StatCard label="DPS" value={fmtCompact(stats.dps ?? 0)} title="Damage per second (5-second rolling window from live memory)" />
          <StatCard label="Alive" value={String(stats.aliveMonsters ?? 0)} title="Monsters currently alive on this map" />
          <StatCard label="HP max" value={fmtCompact(stats.hpMaxSum ?? 0)} title="Sum of max HP of all alive monsters (wave health pool)" />
          <StatCard label="Mobs killed" value={String(stats.mapMobsKilled)} title="Monsters killed on this map — resets when stage changes" />
          <StatCard label="Damage" value={fmtCompact(stats.mapDamage)} title="Damage dealt on this map — resets when stage changes" />
        </section>
      ) : null}

      <LiveMatchedPair
        left={inventoryFillPrediction()}
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
                  History{" "}
                  <span className="normal-case tracking-normal text-muted">- XP changes</span>
                </>
              }
              columns={XP_HISTORY_COLUMNS}
              empty={
                stats.history.length === 0 ? (
                  <p className="m-0">No XP changes recorded yet.</p>
                ) : undefined
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
                      content: `${fmtCompact(e.rate)}/hr`,
                      align: "right",
                      className: "tabular-nums",
                    },
                    {
                      content: stageName(e.stageKey),
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
