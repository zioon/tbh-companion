import { useStats } from "./lib/useStats";
import { useInventory } from "./lib/useInventory";
import { usePriceProgress, usePriceStatus } from "./lib/usePrices";
import { fmtCompact, fmtShortDuration } from "./lib/format";
import { formatMoney } from "../core/steamPrice";
import { stageName } from "../core/stages";
import { Button } from "./design-system/primitives/Button/Button";
import { OverlayFrame } from "./components/ui/OverlayFrame";

const RATE_TIP =
  "XP/hour updates only when the game writes new XP to the save (often up to " +
  "3 minutes apart, sometimes longer). It holds steady between writes instead of decaying.";
const GOLD_TIP =
  "Gold earned per hour. Counts gold gained only; spending (upgrades, Cube, " +
  "runes) is ignored, so it's accurate while farming.";

export function Overlay() {
  const stats = useStats();
  const inv = useInventory();
  const priceStatus = usePriceStatus();
  const priceProgress = usePriceProgress();

  const currency = inv?.currency ?? priceStatus?.currency ?? "USD";
  const invValue = inv?.composition.buyOrderNetTotal ?? null;
  const pricing = priceStatus?.running ?? false;
  const pricingLabel = priceProgress
    ? `pricing ${priceProgress.done}/${priceProgress.total}…`
    : "pricing…";

  // Boss-chest border ring: 7 min per lap, clockwise from top
  // Each new lap layers on top of previous ones without erasing them.
  const LAP_SECONDS = 7 * 60;
  const LAP_COLORS = ["#3b82f6", "#eab308", "#ef4444"]; // blue, yellow, red
  let rings: { color: string; progress: number }[] = [];
  if (stats?.chestDrops.lastDropWallTime != null) {
    const elapsed = Date.now() / 1000 - stats.chestDrops.lastDropWallTime;
    const totalLaps = Math.floor(elapsed / LAP_SECONDS);
    const currentProgress = (elapsed % LAP_SECONDS) / LAP_SECONDS;
    const colorIndex = Math.min(totalLaps, LAP_COLORS.length - 1);
    for (let i = 0; i < totalLaps; i++) {
      rings.push({ color: LAP_COLORS[Math.min(i, LAP_COLORS.length - 1)], progress: 1 });
    }
    rings.push({ color: LAP_COLORS[colorIndex], progress: currentProgress });
  }

  return (
    <OverlayFrame className="relative overflow-visible">
      <div className="flex items-center justify-between">
        <span className="whitespace-nowrap text-[10px] font-bold tracking-wide text-muted">
          TBH Companion
        </span>
        <div className="no-drag flex gap-1">
          {/* nativeTitle: this frameless 280x132 window never hosts a Base UI
              portal (DESIGN-SYSTEM.md) - a Tooltip popup escaping its bounds
              would be visually broken, so these keep the plain title attribute. */}
          <Button
            variant="icon"
            type="button"
            className="text-xs"
            title="Reset session stats"
            nativeTitle
            onClick={() => window.tbh.reset()}
          >
            {"\u21bb"}
          </Button>
          <Button
            variant="icon"
            type="button"
            className="text-xs"
            title="Open full window"
            nativeTitle
            onClick={() => window.tbh.showMain()}
          >
            {"\u2922"}
          </Button>
          <Button
            variant="icon"
            type="button"
            edge="end"
            className="text-xs"
            title="Close mini overlay (app keeps running in the tray)"
            nativeTitle
            onClick={() => window.tbh.closeOverlay()}
          >
            {"\u2715"}
          </Button>
        </div>
      </div>

      {!stats ? (
        <p className="m-0 text-muted">Connecting...</p>
      ) : (
        <div className="flex flex-col gap-1">
          {/* Native title (not Tooltip): this frameless window never hosts a
              Base UI portal - see DESIGN-SYSTEM.md "Base UI portals are safe
              per-window". */}
          <div className="flex items-baseline justify-between gap-2.5">
            <p className="m-0 flex min-w-0 cursor-help items-baseline gap-1" title={RATE_TIP}>
              <span className="text-2xl font-bold leading-none tabular-nums text-accent">
                {fmtCompact(stats.rollingRate)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                XP/hr
              </span>
            </p>
            <p
              className="m-0 flex min-w-0 cursor-help items-baseline gap-1 text-right"
              title={GOLD_TIP}
            >
              <span className="text-base font-semibold leading-none tabular-nums text-gold">
                {fmtCompact(stats.goldRate)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                gold/hr
              </span>
            </p>
          </div>

          <div className="flex items-baseline justify-between gap-1">
            <p className="m-0 flex min-w-0 items-baseline gap-0.5">
              <span className="text-sm font-semibold leading-none tabular-nums text-accent">
                {fmtCompact(stats.dps)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                DPS
              </span>
            </p>
            <p className="m-0 flex min-w-0 items-baseline gap-0.5">
              <span className="text-sm font-semibold leading-none tabular-nums text-white">
                {stats.aliveMonsters ?? 0}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                alive
              </span>
            </p>
            <p className="m-0 flex min-w-0 items-baseline gap-0.5 text-right">
              <span className="text-sm font-semibold leading-none tabular-nums text-accent">
                {fmtCompact(stats.mapDamage)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                dmg
              </span>
            </p>
          </div>

          <p className="m-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] tabular-nums text-muted">
            {stats.chestDrops.lastDropWallTime != null && (
              <span>
                Box{" "}
                {fmtShortDuration(
                  Math.round(Date.now() / 1000 - stats.chestDrops.lastDropWallTime),
                )}
              </span>
            )}
            {stats.chestDrops.lastDropWallTime != null && (
              <span className="opacity-55" aria-hidden>
                ·
              </span>
            )}
            <span>
              {stageName(stats.stageKey)}
              {stats.stageWaveTotal > 0 && (
                <span className="ml-0.5 opacity-70">
                  ({stats.stageWave}/{stats.stageWaveTotal})
                </span>
              )}
            </span>
            {inv && (
              <>
                <span className="opacity-55" aria-hidden>
                  ·
                </span>
                <span>
                  Inv {invValue !== null ? formatMoney(invValue, currency) : "—"}
                  {pricing && <span className="text-muted"> ({pricingLabel})</span>}
                </span>
              </>
            )}
          </p>
        </div>
      )}

      {/* Clockwise border ring: lights up as time since last boss chest passes.
          Completed laps are rendered underneath; the current lap builds on top. */}
      {rings.length > 0 && (
        <svg
          className="pointer-events-none absolute inset-0"
          viewBox="0 0 280 116"
          preserveAspectRatio="none"
        >
          {rings.map((ring, i) => (
            <g key={i}>
              {/* Soft glow layer */}
              <path
                d="M 140,0.5 L 279.5,0.5 L 279.5,111 L 0.5,111 L 0.5,0.5 L 140,0.5"
                fill="none"
                stroke={ring.color}
                strokeWidth="12"
                strokeOpacity="0.18"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - ring.progress * 100}
                strokeLinecap="butt"
              />
              {/* Main ring */}
              <path
                d="M 140,0.5 L 279.5,0.5 L 279.5,111 L 0.5,111 L 0.5,0.5 L 140,0.5"
                fill="none"
                stroke={ring.color}
                strokeWidth="6"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - ring.progress * 100}
                strokeLinecap="butt"
              />
            </g>
          ))}
        </svg>
      )}
    </OverlayFrame>
  );
}
