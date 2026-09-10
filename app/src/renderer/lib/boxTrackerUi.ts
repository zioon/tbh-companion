import type { TFunction } from "i18next";
import type {
  BoxCategory,
  BoxTimerCatalogEntry,
  BoxTimerRow,
  BoxTrackerSortOrder,
} from "../../../shared/types";
import { normalizeBoxTrackerSortOrder } from "../../core/boxTrackerSort";
import { reportIpcError } from "./reportError";

export { normalizeBoxTrackerSortOrder };

export const TRACKER_LEVEL_CHIP_WIDTH_CLASS = "w-[4.5rem]";
export const TRACKER_LEVEL_CHIP_GRID_CLASS = "grid-cols-[repeat(auto-fill,4.5rem)]";

// Preset labels/titles are translated in the component layer via t(labelKey)/t(titleKey).
export const TRACKER_PRESETS: { labelKey: string; titleKey: string; levels: number[] }[] = [
  {
    labelKey: "tracker.presetStarterLabel",
    titleKey: "tracker.presetStarterTitle",
    levels: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    labelKey: "tracker.presetMidLabel",
    titleKey: "tracker.presetMidTitle",
    levels: [15, 20, 30],
  },
  {
    labelKey: "tracker.presetLateLabel",
    titleKey: "tracker.presetLateTitle",
    levels: [40, 50, 65, 80],
  },
];

export function enabledBoxIds(catalog: BoxTimerCatalogEntry[]): number[] {
  return catalog.filter((entry) => entry.enabled).map((entry) => entry.boxId);
}

/** Map level → every canonical tracker route that drops at that level. */
export interface BoxTrackerLevelGroup {
  /** Box level, or null for the (currently impossible) route without one. */
  level: number | null;
  entries: BoxTimerCatalogEntry[];
  /** True when at least one route of this level is enabled. */
  enabled: boolean;
}

/**
 * Collapse the tracker catalog into one group per LEVEL.
 *
 * The catalog holds one entry per canonical RARE route, but the game's
 * "Contaminated Stage Box" lines (Nightmare / Hell / Torment) re-use the plain
 * stage-boss levels, so e.g. Lv90 owns 21 routes (the 920901 standard box plus
 * 925201–925220). Rendering one chip per route produced 21 identical
 * "Lv90" pills; the panel now renders one chip per level and toggles every
 * route of that level together. Groups sort ascending by level (null last).
 */
export function groupCatalogByLevel(catalog: BoxTimerCatalogEntry[]): BoxTrackerLevelGroup[] {
  const byLevel = new Map<number | null, BoxTimerCatalogEntry[]>();
  for (const entry of catalog) {
    const bucket = byLevel.get(entry.level);
    if (bucket) bucket.push(entry);
    else byLevel.set(entry.level, [entry]);
  }
  return [...byLevel.entries()]
    .sort(([a], [b]) => {
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      return a - b;
    })
    .map(([level, entries]) => ({
      level,
      entries,
      enabled: entries.some((entry) => entry.enabled),
    }));
}

/**
 * Tooltip text for a merged level chip: the farm-stage range(s) of every route
 * at that level. Single-route levels keep the original
 * "<recommended stage> · <range>" text; multi-route levels list the distinct
 * ranges (capped so a 21-variant level doesn't render a wall of text).
 */
export function levelGroupTooltip(group: { entries: BoxTimerCatalogEntry[] }): string {
  if (group.entries.length === 1) {
    const entry = group.entries[0];
    return `${entry.idealStageLabel} · ${entry.dropStageRangeLabel}`;
  }
  const ranges = [...new Set(group.entries.map((entry) => entry.dropStageRangeLabel))];
  const MAX_RANGES = 4;
  const shown = ranges.slice(0, MAX_RANGES).join(" · ");
  return ranges.length > MAX_RANGES ? `${shown} · …` : shown;
}

export function toggleTrackedLevel(
  group: BoxTrackerLevelGroup,
  catalog: BoxTimerCatalogEntry[],
): void {
  const current = enabledBoxIds(catalog);
  const groupIds = new Set(group.entries.map((entry) => entry.boxId));
  // P1-12: surface IPC rejections instead of letting them die as unhandled
  // promise rejections. Matches the pattern used in useChests/useBoxTimers.
  if (group.enabled) {
    void window.tbh
      .setBoxTrackerBoxes(current.filter((id) => !groupIds.has(id)))
      .catch(reportIpcError);
  } else {
    void window.tbh.setBoxTrackerBoxes([...current, ...groupIds]).catch(reportIpcError);
  }
}

export function applyTrackerPreset(levels: number[], catalog: BoxTimerCatalogEntry[]): void {
  const ids = catalog
    .filter((entry) => entry.level != null && levels.includes(entry.level))
    .map((entry) => entry.boxId);
  void window.tbh.setBoxTrackerBoxes(ids).catch(reportIpcError);
}

export function trackedLevelsSummary(
  t: TFunction<"chests">,
  catalog: BoxTimerCatalogEntry[],
): string {
  const levels = catalog.filter((entry) => entry.enabled).map((entry) => entry.level);
  if (levels.length === 0) return t("tracker.none");
  if (levels.length <= 5)
    return levels.map((level) => t("configRow.levelLabel", { level })).join(", ");
  return t("tracker.levelsCount", { count: levels.length });
}

export function formatCooldownMinutes(t: TFunction<"chests">, seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return t("configRow.cooldownMinutes", { count: minutes });
}

export function parseCooldownMinutesInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // P2-8: reject scientific ("1e3" = 1000) and hex ("0x10" = 16) forms that
  // `Number()` would silently accept. Only plain decimal integers in [1, 1440]
  // are valid cooldown minutes. `^\d+$` also rejects negatives, decimals, and
  // leading +.
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return null;
  return Math.round(minutes * 60);
}

/** One per-level settings row: enabled routes sharing a (category, level). */
export interface BoxTrackerSettingsGroup {
  category: BoxCategory | null;
  level: number | null;
  entries: BoxTimerCatalogEntry[];
}

/** Settings-row order within one level: standard stage boss, then plague. */
function categoryRank(category: BoxCategory | null): number {
  if (category === "rare") return 0;
  if (category === "plagueRare") return 1;
  if (category == null) return 3;
  return 2;
}

/**
 * Group the ENABLED catalog entries into one settings row per (category, level).
 *
 * A level can appear more than once when both the standard stage-boss box and
 * the game's Contaminated (plague) Stage Boxes share it — e.g. Lv90 has one
 * "rare" route and 20 "plagueRare" routes. They stay apart on purpose so the
 * plague row can carry its own cooldown (its auto-open time differs). Rows sort
 * by level, then category (standard before plague).
 */
export function groupEnabledByLevelAndCategory(
  catalog: BoxTimerCatalogEntry[],
): BoxTrackerSettingsGroup[] {
  const byKey = new Map<string, BoxTrackerSettingsGroup>();
  for (const entry of catalog) {
    if (!entry.enabled) continue;
    const key = `${entry.category ?? ""}|${entry.level ?? ""}`;
    const existing = byKey.get(key);
    if (existing) existing.entries.push(entry);
    else byKey.set(key, { category: entry.category, level: entry.level, entries: [entry] });
  }
  return [...byKey.values()].sort((a, b) => {
    const aLevel = a.level ?? Number.POSITIVE_INFINITY;
    const bLevel = b.level ?? Number.POSITIVE_INFINITY;
    if (aLevel !== bLevel) return aLevel < bLevel ? -1 : 1;
    return categoryRank(a.category) - categoryRank(b.category);
  });
}

export function boxTrackerSectionOrder(
  sortOrder: BoxTrackerSortOrder,
): Array<"cooldown" | "ready"> {
  return sortOrder === "ready-first" ? ["ready", "cooldown"] : ["cooldown", "ready"];
}

export function boxTrackerRowsBySection(
  rows: BoxTimerRow[],
  section: "cooldown" | "ready",
): BoxTimerRow[] {
  return rows.filter((row) => row.status === section);
}
