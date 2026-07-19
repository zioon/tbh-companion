// Single entry point for all bundled locale resources. Importers (main and
// renderer) use this to feed i18next's `resources` option without touching
// JSON files directly.
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
};
