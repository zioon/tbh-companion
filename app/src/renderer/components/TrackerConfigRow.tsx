import { useTranslation } from "react-i18next";
import type { BoxTrackerSettingsGroup } from "../lib/boxTrackerUi";
import {
  formatCooldownMinutes,
  levelGroupTooltip,
  parseCooldownMinutesInput,
} from "../lib/boxTrackerUi";
import { TrackerFarmStageSelect } from "./TrackerFarmStageSelect";
import { Checkbox } from "../design-system/primitives/Checkbox/Checkbox";
import { Button } from "../design-system/primitives/Button/Button";
import { NumberField } from "../design-system/primitives/NumberField/NumberField";
import { reportIpcError } from "../lib/reportError";
import { cn } from "../lib/cn";

/**
 * One per-level settings row. A group holds every ENABLED route that shares the
 * same (category, level) — normally a single route, but the game's Contaminated
 * (plague) Stage Boxes give a level 20 routes that are edited together. Edits
 * (cooldown / notify) fan out to every route in the group; the farm-stage
 * selector is only shown when the group is a single route, because the plague
 * variants sit on distinct stages (the range label is listed instead).
 */
export function TrackerConfigRow({
  group,
  defaultCooldownSeconds,
  notificationsEnabled = true,
}: {
  group: BoxTrackerSettingsGroup;
  defaultCooldownSeconds: number;
  notificationsEnabled?: boolean;
}) {
  const { t } = useTranslation("chests");
  const primary = group.entries[0];
  const minutes = Math.round(primary.cooldownSeconds / 60);
  const cooldownIsCustom = group.entries.some((entry) => entry.cooldownIsCustom);
  const allNotify = group.entries.every((entry) => entry.notifyWhenReady);
  const isPlague = group.category === "plagueRare";
  const isSingleRoute = group.entries.length === 1;

  const applyCooldown = (seconds: number): void => {
    for (const entry of group.entries) {
      // P1-12: surface IPC rejections rather than letting a batch of them die
      // as unhandled promise rejections (a plague group fans out to ~20 calls).
      if (seconds === defaultCooldownSeconds && entry.cooldownIsCustom) {
        void window.tbh.clearBoxTrackerCooldown(entry.boxId).catch(reportIpcError);
      } else if (seconds !== entry.cooldownSeconds) {
        void window.tbh.setBoxTrackerCooldown(entry.boxId, seconds).catch(reportIpcError);
      }
    }
  };

  return (
    <article
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3",
        "shadow-[inset_0_1px_0_0_color-mix(in_oklab,var(--color-fg)_6%,transparent)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
            {isPlague ? t("category.plagueRare") : t("configRow.subtitle")}
          </p>
          <p className="m-0 mt-0.5 text-2xl font-semibold tabular-nums leading-none tracking-tight">
            {t("configRow.levelLabel", { level: group.level ?? "?" })}
          </p>
        </div>
        <NumberField
          label={t("configRow.cooldownLabel")}
          labelAlign="end"
          footerAlign="end"
          density="compact"
          align="center"
          inputClassName="w-[3.25rem]"
          min={1}
          max={1440}
          step={1}
          defaultValue={minutes}
          key={`${group.category ?? "?"}-${group.level ?? "?"}-${minutes}-${cooldownIsCustom}`}
          onBlur={(event) => {
            const seconds = parseCooldownMinutesInput(event.target.value);
            if (seconds == null) {
              event.target.value = String(minutes);
              return;
            }
            applyCooldown(seconds);
          }}
          footer={
            <Button
              variant="link"
              className={cn("text-[10px]", !cooldownIsCustom && "pointer-events-none invisible")}
              onClick={() => applyCooldown(defaultCooldownSeconds)}
            >
              {t("configRow.resetTo", { value: formatCooldownMinutes(t, defaultCooldownSeconds) })}
            </Button>
          }
        />
      </div>

      {isSingleRoute ? (
        <TrackerFarmStageSelect entry={primary} />
      ) : (
        <div className="rounded-md border border-border/60 bg-card/40 px-2.5 py-2 text-xs leading-snug text-muted">
          {levelGroupTooltip(group)}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Checkbox
          label={t("configRow.notifyWhenReady")}
          checked={allNotify}
          disabled={!notificationsEnabled}
          onCheckedChange={(checked) => {
            for (const entry of group.entries) {
              void window.tbh.setBoxTrackerNotify(entry.boxId, checked).catch(reportIpcError);
            }
          }}
        />
        <span
          className={cn("min-h-[1.125rem] text-xs text-muted", notificationsEnabled && "invisible")}
        >
          {t("configRow.notifyDisabledHint")}
        </span>
      </div>
    </article>
  );
}
