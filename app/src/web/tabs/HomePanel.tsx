// Web shell: Home page.
//
// Always shows the brand head, the save-path helper, and the desktop-app CTA.
// When no save is loaded it additionally shows the drop zone, the three-step
// guide, and quick links into the save-independent pages. Once a save is loaded
// the drop zone is replaced by a summary (file name / item count / chest count)
// with reselect + clear, and the onboarding guidance is hidden.

import { useTranslation } from "react-i18next";
import { Button } from "../../renderer/design-system/primitives/Button/Button";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { TabPage } from "../../renderer/design-system/primitives/TabPage/TabPage";
import { clearWebSave } from "../webTbhApi";
import { useWebRuntime } from "../lib/useWebRuntime";
import { ChooseSaveButton, SavePicker } from "../components/SavePicker";
import { SaveLocationHelp } from "../components/SaveLocationHelp";
import { DesktopOnlyPanel } from "../components/DesktopOnlyPanel";
import type { WebTabId } from "../webTabs";

const STEP_KEYS = ["one", "two", "three"] as const;

const QUICK_LINKS: ReadonlyArray<{ tab: WebTabId; titleKey: string; bodyKey: string }> = [
  { tab: "lookup", titleKey: "home.quickLookup", bodyKey: "home.quickLookupHint" },
  { tab: "chests", titleKey: "home.quickChests", bodyKey: "home.quickChestsHint" },
  { tab: "trading", titleKey: "home.quickTrading", bodyKey: "home.quickTradingHint" },
];

export function HomePanel({ onNavigate }: { onNavigate: (tab: WebTabId) => void }) {
  const { t } = useTranslation("web");
  const runtime = useWebRuntime();
  const analyze = runtime.analyze;

  return (
    <TabPage>
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="m-0 text-2xl font-semibold text-fg">{t("home.title")}</h1>
        <p className="m-0 max-w-prose text-xs leading-relaxed text-muted">{t("home.tagline")}</p>
      </div>

      {runtime.error ? (
        <Card className="border-danger/40 bg-danger/5">
          <p className="m-0 mb-1 text-sm font-semibold text-danger">{t("home.saveError")}</p>
          <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-muted">
            {runtime.error}
          </p>
        </Card>
      ) : null}

      {analyze ? (
        <Card padding="compact" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-semibold text-fg">{runtime.fileName}</span>
          <span className="text-muted">
            {t("home.loadedSummary", {
              items: analyze.stats.itemCount.toLocaleString(),
              chests: analyze.stats.chestCount.toLocaleString(),
            })}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <ChooseSaveButton label={t("home.reselect")} size="sm" />
            <Button variant="ghost" size="sm" onClick={() => clearWebSave()}>
              {t("home.clear")}
            </Button>
          </span>
        </Card>
      ) : (
        <SavePicker />
      )}

      <SaveLocationHelp />

      {!analyze ? (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="m-0 text-sm font-semibold text-fg">{t("home.stepsTitle")}</h2>
            <ol className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
              {STEP_KEYS.map((key, i) => (
                <Card as="li" key={key}>
                  <p className="m-0 mb-0.5 text-[13px] font-semibold text-accent">
                    {i + 1}. {t(`home.steps.${key}.title`)}
                  </p>
                  <p className="m-0 text-xs leading-relaxed text-muted">
                    {t(`home.steps.${key}.body`)}
                  </p>
                </Card>
              ))}
            </ol>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 text-sm font-semibold text-fg">{t("home.quickTitle")}</h2>
              <p className="m-0 text-xs text-muted">{t("home.quickHint")}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {QUICK_LINKS.map(({ tab, titleKey, bodyKey }) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onNavigate(tab)}
                  className="flex w-full text-left"
                >
                  <Card
                    padding="compact"
                    className="flex h-full w-full cursor-pointer flex-col gap-1 transition-colors hover:border-accent/60"
                  >
                    <p className="m-0 text-[13px] font-semibold text-accent">{t(titleKey)}</p>
                    <p className="m-0 text-xs leading-relaxed text-muted">{t(bodyKey)}</p>
                  </Card>
                </button>
              ))}
            </div>
          </section>
        </>
      ) : null}

      <DesktopOnlyPanel />
    </TabPage>
  );
}
