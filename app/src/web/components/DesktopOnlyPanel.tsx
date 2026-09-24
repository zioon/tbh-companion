// Web shell: the "these features need the desktop app" section.
//
// Rendered inside the Home page. Lists the capabilities a browser cannot offer
// and links to the downloadable desktop build — the web shell's one conversion
// goal. All copy comes from the `web` i18n namespace.

import { useTranslation } from "react-i18next";
import { ButtonLink } from "../../renderer/design-system/primitives/Button/Button";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { RELEASES_URL, REPO_URL } from "../links";

/** i18n keys under `desktop.*` for the capability cards. */
const ITEMS = ["liveXp", "liveMemory", "overlay", "pricing", "extras"] as const;

export function DesktopOnlyPanel() {
  const { t } = useTranslation("web");

  return (
    <>
      <Card padding="none" className="flex flex-col gap-2 border-accent/25 bg-accent/[0.05] p-4">
        <p className="m-0 text-sm font-semibold text-fg">{t("desktop.title")}</p>
        <p className="m-0 text-xs leading-relaxed text-muted">{t("desktop.body")}</p>
      </Card>

      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map((key) => (
          <Card as="li" key={key} padding="none" className="flex flex-col gap-1.5 p-4">
            <p className="m-0 text-[12.5px] font-semibold text-accent">
              {t(`desktop.${key}.title`)}
            </p>
            <p className="m-0 text-[11.5px] leading-relaxed text-muted">
              {t(`desktop.${key}.body`)}
            </p>
          </Card>
        ))}
      </ul>

      <div className="flex flex-wrap justify-center gap-2.5">
        <ButtonLink variant="primary" href={RELEASES_URL}>
          {t("desktop.download")}
        </ButtonLink>
        <ButtonLink variant="default" href={REPO_URL}>
          {t("desktop.viewSource")}
        </ButtonLink>
      </div>
    </>
  );
}
