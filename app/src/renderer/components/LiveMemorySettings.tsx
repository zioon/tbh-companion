import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { LiveMemoryPrefs } from "../../../shared/types";
import { Button } from "../design-system/primitives/Button/Button";
import { Checkbox } from "../design-system/primitives/Checkbox/Checkbox";
import { Section } from "../design-system/primitives/Section/Section";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogTitle } from "../design-system/primitives/Dialog/DialogParts";

/**
 * Opt-in live-memory reader toggle. The first time it's enabled, a one-time
 * consent dialog explains the read-only trust model; reading only starts after
 * explicit accept. Afterwards it's a plain off-by-default toggle.
 */
export function LiveMemorySettings({
  prefs,
  disabled,
  onChange,
}: {
  prefs: LiveMemoryPrefs;
  disabled?: boolean;
  onChange: (next: LiveMemoryPrefs) => void;
}) {
  const { t } = useTranslation("liveMemory");
  const [consentOpen, setConsentOpen] = useState(false);
  const [toggleConfirmOpen, setToggleConfirmOpen] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);

  function applyEnabled(checked: boolean): void {
    onChange({ ...prefs, enabled: checked });
  }

  function handleToggle(checked: boolean): void {
    // First enable requires the one-time consent dialog before reading starts.
    if (checked && !prefs.consentAccepted) {
      setConsentOpen(true);
      return;
    }
    setPendingEnabled(checked);
    setToggleConfirmOpen(true);
  }

  function acceptConsent(): void {
    setConsentOpen(false);
    onChange({ enabled: true, consentAccepted: true });
  }

  function confirmToggle(): void {
    if (pendingEnabled !== null) {
      applyEnabled(pendingEnabled);
    }
    setToggleConfirmOpen(false);
    setPendingEnabled(null);
  }

  return (
    <Section title={t("settings.sectionTitle")}>
      <p className="m-0 text-xs text-muted">{t("settings.sectionDescription")}</p>
      <Checkbox
        label={t("settings.enableCheckbox")}
        checked={prefs.enabled}
        disabled={disabled}
        onCheckedChange={handleToggle}
      />

      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogTitle className="m-0 text-base font-semibold">
          {t("settings.consentTitle")}
        </DialogTitle>
        <p className="mt-2 mb-0 text-[13px] text-muted">
          <Trans i18nKey="liveMemory:settings.consentBody" components={{ strong: <strong /> }} />
        </p>
        <p className="mt-2 mb-0 text-[13px] text-muted">{t("settings.sessionResetNote")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConsentOpen(false)}>
            {t("settings.cancel")}
          </Button>
          <Button variant="primary" onClick={acceptConsent}>
            {t("settings.acceptAndEnable")}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={toggleConfirmOpen}
        onOpenChange={(open) => {
          setToggleConfirmOpen(open);
          if (!open) setPendingEnabled(null);
        }}
      >
        <DialogTitle className="m-0 text-base font-semibold">
          {pendingEnabled ? t("settings.enableTitle") : t("settings.disableTitle")}
        </DialogTitle>
        <p className="mt-2 mb-0 text-[13px] text-muted">{t("settings.sessionResetNote")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setToggleConfirmOpen(false)}>
            {t("settings.cancel")}
          </Button>
          <Button variant="primary" onClick={confirmToggle}>
            {pendingEnabled ? t("settings.enableAndReset") : t("settings.disableAndReset")}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
