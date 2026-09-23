// Web shell: the browser-side app frame.
//
// The web bundle is a real five-page companion app: a Home page that owns the
// local save drop zone, plus Inventory / Chests / Lookup / Trading. Three of the
// five (Chests, Lookup, Trading) render real data with no save at all; the two
// save-driven pages show a readable empty state instead of blanking out.
//
// Keeping the shell separate from `App.tsx` means the desktop tab bar, overlays,
// and window controls stay untouched. All copy comes from the `web` i18n
// namespace — no hard-coded English.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lookup } from "../renderer/tabs/Lookup";
import { TbhProvider } from "../renderer/context/TbhProvider";
import { EntityPanelProvider } from "../renderer/context/EntityPanelProvider";
import { GlobalEntityPanel } from "../renderer/components/GlobalEntityPanel";
import { ErrorBoundary } from "../renderer/lib/ErrorBoundary";
import { cn } from "../renderer/lib/cn";
import { REPO_URL } from "./links";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { HomePanel } from "./tabs/HomePanel";
import { InventoryPanel } from "./tabs/InventoryPanel";
import { ChestsPanel } from "./tabs/ChestsPanel";
import { TradingPanel } from "./tabs/TradingPanel";
import { WEB_TAB_IDS, type WebTabId } from "./webTabs";

export function WebApp() {
  const { t } = useTranslation("web");
  const { t: tTabs } = useTranslation("tabs");
  const [tab, setTab] = useState<WebTabId>("home");

  return (
    <EntityPanelProvider>
      <div className="flex min-h-dvh flex-col bg-bg">
        <header className="border-b border-border bg-bg">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <span className="text-sm font-semibold text-fg">TBH Companion</span>
            <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {t("badge")}
            </span>
            <nav
              className="flex flex-wrap items-center gap-1"
              aria-label={tTabs("mainTabsAriaLabel")}
            >
              {WEB_TAB_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                    tab === id ? "bg-accent/15 text-accent" : "text-muted hover:text-fg",
                  )}
                  aria-current={tab === id ? "page" : undefined}
                >
                  {t(`nav.${id}`)}
                </button>
              ))}
            </nav>
            <div className="ml-auto">
              <LanguageSwitcher />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-4">
          <ErrorBoundary title={t("crashTitle")}>
            {tab === "home" && <HomePanel onNavigate={setTab} />}
            {tab === "inventory" && <InventoryPanel onNavigate={setTab} />}
            {tab === "chests" && <ChestsPanel />}
            {tab === "lookup" && <Lookup watchedOnlyDefault={false} showPollingStatus={false} />}
            {tab === "trading" && <TradingPanel />}
          </ErrorBoundary>
        </main>

        <footer className="border-t border-border px-5 py-3">
          <p className="mx-auto m-0 max-w-5xl text-[11px] leading-relaxed text-muted">
            {t("footer")}{" "}
            <a className="underline hover:text-fg" href={REPO_URL} rel="noopener noreferrer">
              {t("footerSource")}
            </a>
          </p>
        </footer>

        <GlobalEntityPanel />
      </div>
    </EntityPanelProvider>
  );
}

/** Root of the web bundle: installs translations, then renders the shell. */
export function WebRoot() {
  return (
    <ErrorBoundary title="TBH Companion web failed to start">
      <TbhProvider>
        <WebApp />
      </TbhProvider>
    </ErrorBoundary>
  );
}
