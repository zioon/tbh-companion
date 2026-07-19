import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStats } from "./lib/useStats";
import { useInventory } from "./lib/useInventory";
import { usePriceProgress, usePriceStatus } from "./lib/usePrices";
import { fmtCompact, fmtShortDuration } from "./lib/format";
import { formatMoney } from "../core/steamPrice";
import { stageName } from "../core/stages";
import { Button } from "./design-system/primitives/Button/Button";
import { OverlayFrame } from "./components/ui/OverlayFrame";

// Stage-boss-chest border ring: 7 min per lap, clockwise from top.
// Each new lap layers on top of previous ones without erasing them.
// Only tracks stage boss (rare) drops — common chests drop too frequently
// to make a 7-min lap meaningful.
const LAP_SECONDS = 7 * 60;
// P2-4: ring colors resolve through the design-system CSS variable tokens
// declared in styles.css @theme (single source of truth). SVG `stroke`
// accepts `var(--color-*)`, so changing a token value in styles.css updates
// the rings without touching renderer code. Semantic mapping:
//   lap 0 (calm)    → --color-ideal   (blue)
//   lap 1 (warning) → --color-gold    (yellow)
//   lap 2+ (urgent) → --color-danger  (red)
const LAP_COLORS = ["var(--color-ideal)", "var(--color-gold)", "var(--color-danger)"];
// Force a re-render once per second so the boss-chest ring progress advances
// smoothly. Without this, the ring only repaints when `stats` is pushed, so
// between pushes it freezes at the last computed progress.
const RING_TICK_MS = 1000;

interface BossChestRing {
  color: string;
  progress: number;
}

function buildBossChestRings(
  lastRareDropWallTime: number | null,
  nowSeconds: number,
): BossChestRing[] {
  if (lastRareDropWallTime == null) return [];
  // Clamp to >= 0: clock skew between game wall time and the renderer's
  // Date.now() can produce a negative elapsed, which would yield negative
  // lap counts, negative color indices (LAP_COLORS[-1] === undefined), and
  // broken SVG stroke rendering.
  const elapsed = Math.max(0, nowSeconds - lastRareDropWallTime);
  const totalLaps = Math.floor(elapsed / LAP_SECONDS);
  const currentProgress = (elapsed % LAP_SECONDS) / LAP_SECONDS;
  const colorIndex = Math.min(totalLaps, LAP_COLORS.length - 1);
  const rings: BossChestRing[] = [];
  for (let i = 0; i < totalLaps; i++) {
    rings.push({ color: LAP_COLORS[Math.min(i, LAP_COLORS.length - 1)], progress: 1 });
  }
  rings.push({ color: LAP_COLORS[colorIndex], progress: currentProgress });
  return rings;
}

export function Overlay() {
  const stats = useStats();
  const inv = useInventory();
  const priceStatus = usePriceStatus();
  const priceProgress = usePriceProgress();
  const { t } = useTranslation("live");

  // 1Hz ticker so the boss-chest ring repaints even when stats haven't been
  // pushed. Only armed while a lastRareDropWallTime is present, so idle
  // overlays pay nothing. `nowSeconds` is the only time source used during
  // render — calling Date.now() during render is forbidden by
  // react-hooks/impure-function.
  const [nowSeconds, setNowSeconds] = useState(() => Date.now() / 1000);
  const lastRareDropWallTime = stats?.chestDrops.lastRareDropWallTime ?? null;
  useEffect(() => {
    if (lastRareDropWallTime === null) return;
    const id = setInterval(() => setNowSeconds(Date.now() / 1000), RING_TICK_MS);
    return () => clearInterval(id);
  }, [lastRareDropWallTime]);

  const currency = inv?.currency ?? priceStatus?.currency ?? "USD";
  const invValue = inv?.composition.buyOrderNetTotal ?? null;
  const pricing = priceStatus?.running ?? false;
  const pricingLabel = priceProgress
    ? t("pricingProgress", { done: priceProgress.done, total: priceProgress.total })
    : t("pricingLabel");

  const rings = buildBossChestRings(lastRareDropWallTime, nowSeconds);

  return (
    <OverlayFrame className="relative overflow-visible">
      <div className="flex items-center justify-between">
        <span className="whitespace-nowrap text-[10px] font-bold tracking-wide text-muted">
          {t("appLabel")}
        </span>
        <div className="no-drag flex gap-1">
          {/* nativeTitle: this frameless 280x132 window never hosts a Base UI
              portal (DESIGN-SYSTEM.md) - a Tooltip popup escaping its bounds
              would be visually broken, so these keep the plain title attribute. */}
          <Button
            variant="icon"
            type="button"
            className="text-xs"
            title={t("resetTitleShort")}
            nativeTitle
            onClick={() => window.tbh.reset()}
          >
            {"\u21bb"}
          </Button>
          <Button
            variant="icon"
            type="button"
            className="text-xs"
            title={t("openFullTitle")}
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
            title={t("closeOverlayTitle")}
            nativeTitle
            onClick={() => window.tbh.closeOverlay()}
          >
            {"\u2715"}
          </Button>
        </div>
      </div>

      {!stats ? (
        <p className="m-0 text-muted">{t("connectingShort")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {/* Native title (not Tooltip): this frameless window never hosts a
              Base UI portal - see DESIGN-SYSTEM.md "Base UI portals are safe
              per-window". */}
          <div className="flex items-baseline justify-between gap-2.5">
            <p
              className="m-0 flex min-w-0 cursor-help items-baseline gap-1"
              title={t("rateTipSave")}
            >
              <span className="text-2xl font-bold leading-none tabular-nums text-accent">
                {fmtCompact(stats.rollingRate)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t("xpPerHourShort")}
              </span>
            </p>
            <p
              className="m-0 flex min-w-0 cursor-help items-baseline gap-1 text-right"
              title={t("goldTipSave")}
            >
              <span className="text-base font-semibold leading-none tabular-nums text-gold">
                {fmtCompact(stats.goldRate)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t("goldPerHourShort")}
              </span>
            </p>
          </div>

          <div className="flex items-baseline justify-between gap-1">
            <p className="m-0 flex min-w-0 items-baseline gap-0.5">
              <span className="text-sm font-semibold leading-none tabular-nums text-accent">
                {fmtCompact(stats.dps)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t("dps")}
              </span>
            </p>
            <p className="m-0 flex min-w-0 items-baseline gap-0.5">
              <span className="text-sm font-semibold leading-none tabular-nums text-white">
                {stats.aliveMonsters ?? 0}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t("alive")}
              </span>
            </p>
            <p className="m-0 flex min-w-0 items-baseline gap-0.5 text-right">
              <span className="text-sm font-semibold leading-none tabular-nums text-accent">
                {fmtCompact(stats.mapDamage)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t("damage")}
              </span>
            </p>
          </div>

          <p className="m-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] tabular-nums text-muted">
            {stats.chestDrops.lastRareDropWallTime != null && (
              <span>
                {t("bossLabel")}{" "}
                {fmtShortDuration(
                  Math.max(0, Math.round(nowSeconds - stats.chestDrops.lastRareDropWallTime)),
                )}
              </span>
            )}
            {stats.chestDrops.lastRareDropWallTime != null && (
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
                  {t("invLabel", {
                    value: invValue !== null ? formatMoney(invValue, currency) : "—",
                  })}
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
