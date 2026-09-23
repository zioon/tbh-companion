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
    <label className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className="sr-only">{t("language")}</span>
      <select
        value={current}
        aria-label={t("language")}
        onChange={(e) => void onChange(e.target.value as ResolvedLanguage)}
        className="rounded border border-border bg-bg px-1.5 py-0.5 text-xs text-fg"
      >
        {OPTIONS.map((code) => (
          <option key={code} value={code}>
            {LANGUAGE_DISPLAY_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
