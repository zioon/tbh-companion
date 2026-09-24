// Web shell: Home page.
//
// Always shows the brand head, the save-path helper, and the desktop-app CTA.
// When no save is loaded it additionally shows the drop zone, the three-step
// guide, and quick links into the save-independent pages. Once a save is loaded
// the drop zone is replaced by a summary (file name / item count / chest count)
// with reselect + clear, and the onboarding guidance is hidden.
//
// Redesign notes: the hero is flush-left rather than centred — this page's job
// is to get a file dropped, and a left rail reads faster than a centred stack.
// The step numbers moved out of the copy into rounded chips so the titles scan
// as a list. `p-4` (not the Card default `p-3`) is used throughout: web cards
// carry more prose than the desktop's dense panels.

import { useTranslation } from "react-i18next";
import { LuArrowUpRight } from "react-icons/lu";
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
    <TabPage className="gap-8">
      <section className="flex flex-col gap-3">
        <p className="m-0 text-[10.5px] font-semibold tracking-[0.14em] text-accent uppercase">
          {t("home.eyebrow")}
        </p>
        <h1 className="m-0 text-[34px] leading-[1.1] font-bold tracking-[-0.02em] text-fg">
          {t("home.title")}
        </h1>
        <p className="m-0 max-w-[760px] text-sm leading-relaxed text-muted">{t("home.tagline")}</p>
      </section>

      {runtime.error ? (
        <Card padding="none" className="border-danger/40 bg-danger/[0.06] p-4">
          <p className="m-0 mb-1 text-sm font-semibold text-danger">{t("home.saveError")}</p>
          <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-muted">
            {runtime.error}
          </p>
        </Card>
      ) : null}

      {analyze ? (
        <Card
          padding="none"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-xs"
        >
          <span className="font-mono text-[12.5px] font-medium text-fg">{runtime.fileName}</span>
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
          <section className="flex flex-col gap-3.5">
            <h2 className="m-0 text-[15.5px] font-semibold text-fg">{t("home.stepsTitle")}</h2>
            <ol className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
              {STEP_KEYS.map((key, i) => (
                <Card as="li" key={key} padding="none" className="flex flex-col gap-2.5 p-4">
                  <span
                    aria-hidden
                    className="flex size-[22px] items-center justify-center rounded-md bg-accent/15 text-[11px] font-semibold text-accent"
                  >
                    {i + 1}
                  </span>
                  <p className="m-0 text-[13.5px] font-semibold text-fg">
                    {t(`home.steps.${key}.title`)}
                  </p>
                  <p className="m-0 text-xs leading-relaxed text-muted">
                    {t(`home.steps.${key}.body`)}
                  </p>
                </Card>
              ))}
            </ol>
          </section>

          <section className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-[15.5px] font-semibold text-fg">{t("home.quickTitle")}</h2>
              <p className="m-0 text-xs text-muted">{t("home.quickHint")}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {QUICK_LINKS.map(({ tab, titleKey, bodyKey }) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onNavigate(tab)}
                  className="flex w-full text-left"
                >
                  <Card
                    padding="none"
                    className="flex h-full w-full cursor-pointer flex-col gap-2 p-4 transition-colors hover:border-accent/50"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-[13.5px] font-semibold text-accent">{t(titleKey)}</span>
                      <LuArrowUpRight
                        aria-hidden
                        className="size-3.5 text-accent"
                        strokeWidth={2.4}
                      />
                    </span>
                    <span className="text-xs leading-relaxed text-muted">{t(bodyKey)}</span>
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
