import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { githubReleaseUrl } from "../lib/externalLinks";
import { reportIpcError } from "../lib/reportError";
import {
  markWhatsNewSeen,
  readLastSeenWhatsNewVersion,
  whatsNewForVersion,
  type WhatsNewEntry,
} from "../lib/whatsNew";
import { Button, ButtonLink } from "../design-system/primitives/Button/Button";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../design-system/primitives/Dialog/DialogParts";
import { ExternalLink } from "./ui/ExternalLink";

interface VisibleWhatsNew {
  version: string;
  entry: WhatsNewEntry;
}

export function WhatsNewModal() {
  const { t } = useTranslation("whatsNew");
  const [visible, setVisible] = useState<VisibleWhatsNew | null>(null);

  const dismiss = useCallback((): void => {
    if (!visible) return;
    markWhatsNewSeen(visible.version);
    setVisible(null);
  }, [visible]);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .getUpdateStatus()
      .then((status) => {
        if (!mounted) return;

        const entry = whatsNewForVersion(status.currentVersion);
        if (!entry) return;

        const seenVersion = readLastSeenWhatsNewVersion();
        if (seenVersion === entry.version) return;

        setVisible({ version: entry.version, entry });
      })
      .catch(reportIpcError);

    return () => {
      mounted = false;
    };
  }, []);

  if (!visible) return null;

  const bullets = t(visible.entry.bulletsKey, { returnObjects: true }) as string[];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase text-accent">{t("updatedTag")}</p>
          <DialogTitle className="m-0 mt-1 text-lg font-semibold text-fg">
            {t(visible.entry.titleKey)}
          </DialogTitle>
        </div>

        <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-sm text-muted">
          {bullets.map((bullet, idx) => (
            <li key={idx}>{bullet}</li>
          ))}
        </ul>

        <ExternalLink href={githubReleaseUrl(visible.version)} variant="accent">
          {t("releaseNotesLink")}
        </ExternalLink>

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          {visible.entry.action && (
            <ButtonLink href={visible.entry.action.href} onClick={dismiss} variant="primary">
              {t(visible.entry.action.labelKey)}
            </ButtonLink>
          )}
          <DialogClose render={<Button>{t("gotIt")}</Button>} />
        </div>
      </div>
    </Dialog>
  );
}
