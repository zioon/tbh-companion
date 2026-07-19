// "Time since last drop" border ring for the Loot page's chest cards. Same
// visual language as the mini overlay's boss-chest ring: a clockwise lap that
// lights up as time since the last chest DROP elapses, with each completed lap
// layered underneath the current partial one. The lap duration is configurable
// per category (see AppConfig.lootRingSeconds) — common chests default to 5 min,
// stage-boss chests to 7 min (matching the overlay).
//
// Important: the anchor is the last DROP time (sourced from
// `chestDrops.history` per category via `useLoot().lastDropWallTimeByCategory`),
// NOT the last OPEN time. The player wants to see how long it's been since a
// chest of this type dropped, regardless of whether it's been opened yet.
//
// Rendering: SVG with `pathLength="100"` so the rectangle path is treated as
// 100 units long regardless of the card's actual pixel dimensions; the
// dashoffset is then `100 - progress * 100`. `preserveAspectRatio="none"`
// stretches the viewBox to fill the card, so the ring hugs the rounded border.
// The card itself provides `relative` positioning — this SVG sits absolutely
// on top, `pointer-events-none` so it never blocks clicks on the card content.
//
// Re-render cadence: a 1-second ticker armed while `lastDropWallTime != null`
// keeps the ring advancing smoothly between stats pushes (which fire at 5 Hz
// during live memory but can pause on idle). When `lastDropWallTime` is null
// (no drops yet) no ring is rendered at all.

import { useEffect, useState } from "react";

/** Lap colors mirror the mini overlay (calm → warning → urgent). */
const LAP_COLORS = ["var(--color-ideal)", "var(--color-gold)", "var(--color-danger)"];

const RING_TICK_MS = 1000;

interface LootRingProps {
  /** Epoch seconds of the most recent chest DROP for this category; null = no drops yet. */
  lastDropWallTime: number | null;
  /** Lap duration in seconds (one full traversal of the card border). */
  lapSeconds: number;
}

interface Ring {
  color: string;
  progress: number;
}

function buildRings(
  lastDropWallTime: number | null,
  nowSeconds: number,
  lapSeconds: number,
): Ring[] {
  if (lastDropWallTime == null) return [];
  // Clamp to >= 0: clock skew between game wall time and Date.now() can yield
  // a negative elapsed, which would produce negative lap counts and broken
  // color indices.
  const elapsed = Math.max(0, nowSeconds - lastDropWallTime);
  const totalLaps = Math.floor(elapsed / lapSeconds);
  const currentProgress = (elapsed % lapSeconds) / lapSeconds;
  const colorIndex = Math.min(totalLaps, LAP_COLORS.length - 1);
  const rings: Ring[] = [];
  for (let i = 0; i < totalLaps; i++) {
    rings.push({ color: LAP_COLORS[Math.min(i, LAP_COLORS.length - 1)], progress: 1 });
  }
  rings.push({ color: LAP_COLORS[colorIndex], progress: currentProgress });
  return rings;
}

export function LootRing({ lastDropWallTime, lapSeconds }: LootRingProps) {
  // 1 Hz ticker so the ring repaints even when stats haven't been pushed.
  // Only armed while a lastDropWallTime is present, so idle cards pay nothing.
  // `nowSeconds` is the only time source used during render — calling
  // Date.now() during render is forbidden by react-hooks/impure-function.
  const [nowSeconds, setNowSeconds] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (lastDropWallTime === null) return;
    const id = setInterval(() => setNowSeconds(Date.now() / 1000), RING_TICK_MS);
    return () => clearInterval(id);
  }, [lastDropWallTime]);

  const rings = buildRings(lastDropWallTime, nowSeconds, lapSeconds);
  if (rings.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {rings.map((ring, i) => (
        <g key={i}>
          {/* Soft glow layer */}
          <path
            d="M 50,0.5 L 99.5,0.5 L 99.5,99.5 L 0.5,99.5 L 0.5,0.5 L 50,0.5"
            fill="none"
            stroke={ring.color}
            strokeWidth="4"
            strokeOpacity="0.18"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - ring.progress * 100}
            strokeLinecap="butt"
          />
          {/* Main ring */}
          <path
            d="M 50,0.5 L 99.5,0.5 L 99.5,99.5 L 0.5,99.5 L 0.5,0.5 L 50,0.5"
            fill="none"
            stroke={ring.color}
            strokeWidth="2"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - ring.progress * 100}
            strokeLinecap="butt"
          />
        </g>
      ))}
    </svg>
  );
}
