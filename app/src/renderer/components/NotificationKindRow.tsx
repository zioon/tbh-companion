import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  NotificationKindId,
  NotificationKindPreference,
  NotificationPrefs,
  NotificationSoundId,
} from "../../../shared/notificationCatalog";
import {
  NOTIFICATION_KIND_ENTRIES,
  NOTIFICATION_SOUND_ENTRIES,
} from "../../../shared/notificationCatalog";
import { Button } from "../design-system/primitives/Button/Button";
import { Checkbox } from "../design-system/primitives/Checkbox/Checkbox";
import { Field } from "../design-system/primitives/Field/Field";
import { Select } from "../design-system/primitives/Select/Select";
import { playNotificationSound } from "../lib/notificationSounds";

export function NotificationKindRow({
  kindId,
  pref,
  disabled,
  saveBusy,
  notificationVolume = 100,
  onChange,
}: {
  kindId: NotificationKindId;
  pref: NotificationKindPreference;
  disabled: boolean;
  saveBusy: boolean;
  notificationVolume?: number;
  onChange: (next: NotificationKindPreference) => void;
}) {
  const { t } = useTranslation("notifications");
  const kind = NOTIFICATION_KIND_ENTRIES.find((k) => k.id === kindId)!;
  const [previewBusy, setPreviewBusy] = useState(false);

  const soundOptions: { value: NotificationSoundId; label: string }[] = [
    ...NOTIFICATION_SOUND_ENTRIES.map((s) => ({ value: s.id, label: t(s.labelKey) })),
    { value: "none", label: t("soundNone") },
  ];

  function onPreview() {
    setPreviewBusy(true);
    try {
      playNotificationSound(pref.sound, notificationVolume);
    } finally {
      setPreviewBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[13px] font-semibold text-fg">{t(kind.labelKey)}</p>
        <Checkbox
          label={t(kind.descriptionKey)}
          checked={pref.enabled}
          disabled={disabled || saveBusy}
          onCheckedChange={(checked) => onChange({ ...pref, enabled: checked })}
        />
      </div>
      <Field label={t("soundFieldLabel")}>
        <Select
          value={pref.sound}
          disabled={disabled || !pref.enabled || saveBusy}
          onValueChange={(value) => onChange({ ...pref, sound: value as NotificationSoundId })}
          options={soundOptions}
        />
      </Field>
      <Button
        disabled={
          disabled ||
          !pref.enabled ||
          pref.sound === "none" ||
          notificationVolume <= 0 ||
          previewBusy ||
          saveBusy
        }
        onClick={() => void onPreview()}
      >
        {previewBusy ? t("previewPlaying") : t("previewSound")}
      </Button>
    </div>
  );
}

export function NotificationSoundAccordion({
  prefs,
  disabled,
  saveBusy,
  notificationVolume = 100,
  onKindChange,
}: {
  prefs: NotificationPrefs;
  disabled: boolean;
  saveBusy: boolean;
  notificationVolume?: number;
  onKindChange: (kindId: NotificationKindId, next: NotificationKindPreference) => void;
}) {
  return (
    <>
      {NOTIFICATION_KIND_ENTRIES.map((kind) => (
        <NotificationKindRow
          key={kind.id}
          kindId={kind.id}
          pref={prefs[kind.id]}
          disabled={disabled}
          saveBusy={saveBusy}
          notificationVolume={notificationVolume}
          onChange={(next) => onKindChange(kind.id, next)}
        />
      ))}
    </>
  );
}
