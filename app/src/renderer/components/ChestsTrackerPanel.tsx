import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "../../../shared/types";
import { useBoxTimers } from "../lib/useBoxTimers";
import { reportIpcError } from "../lib/reportError";
import {
  applyTrackerPreset,
  groupCatalogByLevel,
  groupEnabledByLevelAndCategory,
  levelGroupTooltip,
  normalizeBoxTrackerSortOrder,
  toggleTrackedLevel,
  TRACKER_LEVEL_CHIP_GRID_CLASS,
  TRACKER_LEVEL_CHIP_WIDTH_CLASS,
  TRACKER_PRESETS,
} from "../lib/boxTrackerUi";
import { TrackerConfigRow } from "./TrackerConfigRow";
import { Button } from "../design-system/primitives/Button/Button";
import { Field } from "../design-system/primitives/Field/Field";
import { PanelSection } from "../design-system/primitives/PanelSection/PanelSection";
import { Select } from "../design-system/primitives/Select/Select";
import { Tooltip } from "../design-system/primitives/Tooltip/Tooltip";
import { cn } from "../lib/cn";

export function ChestsTrackerPanel() {
  const { t } = useTranslation("chests");
  const state = useBoxTimers();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    if (typeof window.tbh?.getConfig !== "function") return;
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((config: AppConfig) => {
        if (mounted) setNotificationsEnabled(config.notificationsEnabled);
      })
      .catch((err: unknown) => reportIpcError(err));
    return () => {
      mounted = false;
    };
  }, []);

  // One chip per LEVEL (not per route): the catalog's Contaminated Stage Box
  // variants re-use the plain stage-boss levels, so a per-route grid showed
  // ~21 identical "Lv40/65/90" pills each. Grouped here so the hook order
  // stays unconditional above the loading early-return.
  const levelGroups = useMemo(() => (state ? groupCatalogByLevel(state.catalog) : []), [state]);

  if (!state) {
    return (
      <section
        aria-labelledby="stage-chest-tracker-heading"
        className="flex flex-col gap-2 rounded-lg border border-border bg-panel/50 p-3.5"
      >
        <h2 id="stage-chest-tracker-heading" className="m-0 text-base font-semibold">
          {t("tracker.heading")}
        </h2>
        <p className="m-0 text-xs text-muted">{t("tracker.loading")}</p>
      </section>
    );
  }

  // One settings row per (category, level) — plague boxes get their own row so
  // their (different) auto-open cooldown is configurable separately.
  const settingsGroups = groupEnabledByLevelAndCategory(state.catalog);

  return (
    <section
      aria-labelledby="stage-chest-tracker-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel/50 p-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="stage-chest-tracker-heading" className="m-0 text-base font-semibold">
            {t("tracker.heading")}
          </h2>
          <p className="m-0 mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {t("tracker.description")}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          onClick={() => window.tbh.openBoxTracker()}
        >
          {t("tracker.openOverlay")}
        </Button>
      </div>

      {!notificationsEnabled ? (
        <p className="m-0 text-xs text-muted">{t("tracker.notificationsDisabled")}</p>
      ) : null}

      <PanelSection title={t("tracker.displaySection")}>
        <Field label={t("tracker.sortFieldLabel")} hint={t("tracker.sortFieldHint")}>
          <Select
            className="max-w-xs"
            value={state.sortOrder}
            onValueChange={(value) =>
              void window.tbh.setBoxTrackerSortOrder(normalizeBoxTrackerSortOrder(String(value)))
            }
            options={[
              { value: "cooldown-first", label: t("tracker.sortCooldownFirst") },
              { value: "ready-first", label: t("tracker.sortReadyFirst") },
            ]}
          />
        </Field>
      </PanelSection>

      <PanelSection title={t("tracker.levelsSection")}>
        <div className="flex flex-wrap gap-1">
          {TRACKER_PRESETS.map((preset) => (
            <Button
              key={preset.labelKey}
              size="sm"
              variant="ghost"
              title={t(preset.titleKey)}
              onClick={() => applyTrackerPreset(preset.levels, state.catalog)}
            >
              {t(preset.labelKey)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void window.tbh.setBoxTrackerBoxes([])}>
            {t("tracker.clear")}
          </Button>
        </div>
        {/* Raw toggle chips — no ToggleChip primitive yet; pill shape + grid density are one-off. */}
        <div className={cn("mt-1.5 grid gap-1", TRACKER_LEVEL_CHIP_GRID_CLASS)}>
          {levelGroups.map((group) => (
            <Tooltip
              key={group.level ?? "unknown"}
              trigger={
                <button
                  type="button"
                  className={cn(
                    "box-border cursor-pointer rounded-full border px-1 py-0.5 text-center text-[10px] font-semibold leading-tight break-words whitespace-normal",
                    TRACKER_LEVEL_CHIP_WIDTH_CLASS,
                    group.enabled
                      ? "border-accent bg-ideal/15 text-accent"
                      : "border-border bg-card text-muted hover:border-muted hover:text-fg",
                  )}
                  onClick={() => toggleTrackedLevel(group, state.catalog)}
                >
                  {t("tracker.chipLevel", { level: group.level ?? "?" })}
                </button>
              }
            >
              {`${levelGroupTooltip(group)}${
                group.enabled ? t("tracker.chipTrackingSuffix") : t("tracker.chipTapToTrackSuffix")
              }`}
            </Tooltip>
          ))}
        </div>
      </PanelSection>

      {settingsGroups.length === 0 ? (
        <p className="m-0 text-xs text-muted">{t("tracker.pickPrompt")}</p>
      ) : (
        <PanelSection title={t("tracker.perLevelSection")}>
          <div className="grid grid-cols-1 gap-2 min-[640px]:grid-cols-2">
            {settingsGroups.map((group) => (
              <TrackerConfigRow
                key={`${group.category ?? "?"}-${group.level ?? "?"}`}
                group={group}
                defaultCooldownSeconds={state.defaultCooldownSeconds}
                notificationsEnabled={notificationsEnabled}
              />
            ))}
          </div>
        </PanelSection>
      )}
    </section>
  );
}
