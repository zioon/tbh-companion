// Single entry point for all bundled locale resources. Importers (main and
// renderer) use this to feed i18next's `resources` option without touching
// JSON files directly.
//
// Four languages (en, zh-CN, ja, ko) have dedicated translation files. The
// remaining 12 game-supported languages reuse the English bundle as a
// placeholder — UI strings appear in English until native translations are
// contributed. Game-extracted labels (grades/types/stats/classes) are merged
// per-language at runtime via `tryMergeGameLocale` in renderer/i18n.ts, so
// in-game content still appears in the player's selected language.
import type { ResolvedLanguage } from "../language";
import en from "./en";
import ja from "./ja";
import ko from "./ko";
import zhCN from "./zh-CN";

export const LOCALE_RESOURCES: Record<ResolvedLanguage, Record<string, object>> = {
  en,
  "zh-CN": zhCN,
  ja,
  ko,
  // English fallback for the 12 newly-added game languages:
  "zh-Hant": en,
  "fr-FR": en,
  "de-DE": en,
  "id-ID": en,
  "pl-PL": en,
  "pt-BR": en,
  "ru-RU": en,
  "es-ES": en,
  "th-TH": en,
  "tr-TR": en,
  "uk-UA": en,
  "vi-VN": en,
};
