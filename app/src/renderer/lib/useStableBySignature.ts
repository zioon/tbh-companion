import { useState } from "react";

/**
 * Return the previous `value` reference when `buildSig(value)` equals the
 * signature of the latest committed render; otherwise adopt and remember the
 * new `value`.
 *
 * Purpose: derive data that changes *reference* on every parent render but is
 * *display-equivalent* between renders (e.g. the `boxOpens` array rebuilt by
 * the 5 Hz stats broadcast, whose wall-clock `hourlyValue` drifts fractions of
 * a unit per tick). Keeping the reference identical while the rendered content
 * is unchanged lets downstream `React.memo` components skip re-rendering.
 *
 * `buildSig` should map the value to a string over exactly the fields the UI
 * renders (rounded to display precision, e.g. integer hourly value, 1-decimal
 * drop pct), so a sub-threshold drift is treated as "no change".
 *
 * Implemented with `useState` + the documented "adjusting state when props
 * change" pattern: we compare the new signature against the stored one during
 * render and only call `setState` when it actually changed. This keeps the
 * previous reference while the signature is stable and avoids the (lint-banned)
 * ref read/write-during-render pattern.
 */
export function useStableBySignature<T>(value: T, buildSig: (value: T) => string): T {
  const [cache, setCache] = useState<{ sig: string; value: T } | null>(null);
  const sig = buildSig(value);
  if (cache && cache.sig === sig) return cache.value;
  setCache({ sig, value });
  return value;
}

/** Format a nullable money amount to display-precision integer (-1 → null). */
export function moneySig(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return -1;
  return Math.round(value);
}

/** Format a fraction to one-decimal precision (match `fmtPct`). */
export function pctSig(value: number): number {
  return Math.round(value * 10);
}
