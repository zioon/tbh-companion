// Web shell: UI language switcher.
//
// The desktop app switches language from Settings; the web shell needs its own
// control. Mirroring `Settings.tsx`, the switch persists first
// (`window.tbh.saveConfig({ language })`) and only then flips the renderer's
// i18next, so the shim's `resolvedLanguage` (and therefore the localized catalog
// `TbhProvider` re-fetches on `languageChanged`) is already updated.
//
// Only the four languages with dedicated translation bundles are offered; the
// remaining twelve game languages fall back to English (see `shared/locales`).

import { useTranslation } from "react-i18next";
import { LuChevronDown, LuGlobe } from "react-icons/lu";
import { LANGUAGE_DISPLAY_NAMES, type ResolvedLanguage } from "../../../shared/language";
import { changeRendererLanguage } from "../../renderer/i18n";
import { reportIpcError } from "../../renderer/lib/reportError";

const OPTIONS: readonly ResolvedLanguage[] = ["en", "zh-CN", "ja", "ko"];

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation("web");
  const resolved = i18n.resolvedLanguage ?? i18n.language;
  const current: ResolvedLanguage = OPTIONS.includes(resolved as ResolvedLanguage)
    ? (resolved as ResolvedLanguage)
    : "en";

  async function onChange(next: ResolvedLanguage): Promise<void> {
    try {
      await window.tbh.saveConfig({ language: next });
      await changeRendererLanguage(next);
    } catch (err) {
      reportIpcError(err);
    }
  }

  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{t("language")}</span>
      <LuGlobe
        aria-hidden
        className="pointer-events-none absolute left-2.5 size-[14px] text-muted"
        strokeWidth={1.8}
      />
      <select
        value={current}
        aria-label={t("language")}
        onChange={(e) => void onChange(e.target.value as ResolvedLanguage)}
        className="cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pr-7 pl-8 text-xs font-medium text-muted transition-colors hover:border-muted hover:text-fg focus:outline-none"
      >
        {OPTIONS.map((code) => (
          <option key={code} value={code}>
            {LANGUAGE_DISPLAY_NAMES[code]}
          </option>
        ))}
      </select>
      <LuChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 size-3 text-faint"
        strokeWidth={2.4}
      />
    </label>
  );
}
