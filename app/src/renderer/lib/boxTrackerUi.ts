import type { TFunction } from "i18next";
import type { BoxTimerCatalogEntry, BoxTimerRow, BoxTrackerSortOrder } from "../../../shared/types";
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

export function toggleTrackedLevel(
  entry: BoxTimerCatalogEntry,
  catalog: BoxTimerCatalogEntry[],
): void {
  const current = enabledBoxIds(catalog);
  // P1-12: surface IPC rejections instead of letting them die as unhandled
  // promise rejections. Matches the pattern used in useChests/useBoxTimers.
  if (entry.enabled) {
    void window.tbh
      .setBoxTrackerBoxes(current.filter((id) => id !== entry.boxId))
      .catch(reportIpcError);
  } else {
    void window.tbh.setBoxTrackerBoxes([...current, entry.boxId]).catch(reportIpcError);
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

export function enabledCatalogEntries(catalog: BoxTimerCatalogEntry[]): BoxTimerCatalogEntry[] {
  return catalog
    .filter((entry) => entry.enabled)
    .toSorted((a, b) => (a.level ?? 0) - (b.level ?? 0));
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
