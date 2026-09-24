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
//
// Visual contract (redesign):
//   * `atmosphere-glow` is a decorative radial accent bleeding down from the top
//     edge. It is `aria-hidden` and sits *behind* the opaque header bar, so the
//     glow only reads below it — no accent tint ever lands on a data surface.
//   * The header is sticky and the single place the brand mark appears at size;
//     the footer repeats it small, then closes on an oversized ghost wordmark.
//   * Content is capped at 1240px with 20px gutters (= 1200px of content), so
//     the five pages share one measure on wide displays.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTrendingUp } from "react-icons/lu";
import { Lookup } from "../renderer/tabs/Lookup";
import { TbhProvider } from "../renderer/context/TbhProvider";
import { EntityPanelProvider } from "../renderer/context/EntityPanelProvider";
import { GlobalEntityPanel } from "../renderer/components/GlobalEntityPanel";
import { ErrorBoundary } from "../renderer/lib/ErrorBoundary";
import { cn } from "../renderer/lib/cn";
import { REPO_URL } from "./links";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { CurrencySwitcher } from "./components/CurrencySwitcher";
import { HomePanel } from "./tabs/HomePanel";
import { InventoryPanel } from "./tabs/InventoryPanel";
import { ChestsPanel } from "./tabs/ChestsPanel";
import { TradingPanel } from "./tabs/TradingPanel";
import { WEB_TAB_IDS, type WebTabId } from "./webTabs";

/** The brand chip: gradient tile + trend glyph, shared by header and footer. */
function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      className="flex shrink-0 items-center justify-center bg-gradient-to-br from-[#74e394] to-[#3bae63] shadow-[0_2px_14px_-4px_color-mix(in_oklab,var(--color-accent)_60%,transparent)]"
    >
      <LuTrendingUp
        style={{ width: Math.round(size * 0.57), height: Math.round(size * 0.57) }}
        className="text-accent-fg"
        strokeWidth={2.6}
      />
    </span>
  );
}

export function WebApp() {
  const { t } = useTranslation("web");
  const { t: tTabs } = useTranslation("tabs");
  const [tab, setTab] = useState<WebTabId>("home");

  return (
    <EntityPanelProvider>
      <div className="relative flex min-h-dvh flex-col bg-bg">
        <div
          aria-hidden
          className="atmosphere-glow pointer-events-none absolute inset-x-0 top-0 h-[360px]"
        />

        <header className="sticky top-0 z-30 border-b border-border-soft bg-bg">
          <div className="mx-auto flex h-[62px] w-full max-w-[1240px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5">
            <div className="flex items-center gap-2.5">
              <BrandMark />
              <span className="text-[14.5px] font-semibold text-fg">TBH Companion</span>
              <span className="rounded-[5px] bg-accent/15 px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-accent uppercase">
                {t("badge")}
              </span>
            </div>

            <nav
              className="flex flex-wrap items-center gap-0.5"
              aria-label={tTabs("mainTabsAriaLabel")}
            >
              {WEB_TAB_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[12.5px] transition-colors",
                    tab === id
                      ? "bg-accent/15 font-semibold text-accent"
                      : "font-medium text-muted hover:text-fg",
                  )}
                  aria-current={tab === id ? "page" : undefined}
                >
                  {t(`nav.${id}`)}
                </button>
              ))}
            </nav>

            <div className="flex items-center gap-2">
              <CurrencySwitcher />
              <LanguageSwitcher />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1240px] flex-1 px-5 py-9">
          <ErrorBoundary title={t("crashTitle")}>
            {tab === "home" && <HomePanel onNavigate={setTab} />}
            {tab === "inventory" && <InventoryPanel onNavigate={setTab} />}
            {tab === "chests" && <ChestsPanel />}
            {tab === "lookup" && <Lookup watchedOnlyDefault={false} showPollingStatus={false} />}
            {tab === "trading" && <TradingPanel />}
          </ErrorBoundary>
        </main>

        <footer className="relative overflow-hidden border-t border-border-soft bg-[#08090d]">
          <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-4 px-5 pt-7 pb-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span className="flex items-center gap-2">
                <BrandMark size={20} />
                <span className="text-[12.5px] font-semibold text-fg/75">TBH Companion</span>
              </span>
              <a
                className="text-xs font-medium text-accent hover:underline"
                href={REPO_URL}
                rel="noopener noreferrer"
              >
                {t("footerSource")}
              </a>
            </div>

            <p className="m-0 max-w-[860px] text-[11.5px] leading-relaxed text-faint">
              {t("footer")}
            </p>

            <span
              aria-hidden
              className="select-none text-[76px] leading-none font-bold tracking-[-0.02em] text-fg/[0.04]"
            >
              TBH COMPANION
            </span>
          </div>
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
