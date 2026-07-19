// Locale catalog for stage / hero / item / difficulty names.
//
// Bundled in data/locale_strings_<lang>.json (4 files: en, zh-CN, ja, ko).
// Loaded once per process via `loadLocaleCatalog(lang)`, then injected into
// services via constructor. Language switch triggers a re-load + service
// `setLocaleCatalog(newCatalog)` call.
//
// Pure: uses `core/bundledData.readBundledJson` (synchronous readFileSync)
// cached for process lifetime. No electron / no fetch.

import type { ResolvedLanguage } from "../../shared/language";
import { readBundledJson } from "./bundledData";

export interface LocaleCatalog {
  /** itemKey string (e.g. "110001") → localized name. */
  items: Record<string, string>;
  /** 4-digit "<act><stage>" (e.g. "2105") → localized name. Difficulty is not in the key. */
  stages: Record<string, string>;
  /** heroKey string (e.g. "101") → localized name. */
  heroes: Record<string, string>;
  /** Difficulty enum name (NORMAL / NIGHTMARE / HELL / TORMENT) → localized name. */
  difficulties: Record<string, string>;
}

interface LocaleStringsFile {
  source: string;
  fetchedUtc: string;
  items: Record<string, string>;
  stages: Record<string, string>;
  heroes: Record<string, string>;
  difficulties: Record<string, string>;
}

const LANG_TO_FILENAME: Record<ResolvedLanguage, string> = {
  en: "locale_strings_en.json",
  "zh-CN": "locale_strings_zh-CN.json",
  ja: "locale_strings_ja.json",
  ko: "locale_strings_ko.json",
};

const cache = new Map<ResolvedLanguage, LocaleCatalog>();

/**
 * Load the locale catalog for the given language. Cached for process lifetime
 * (catalog content never changes at runtime — language switch instantiates a
 * new entry in the cache rather than mutating an existing one).
 */
export function loadLocaleCatalog(lang: ResolvedLanguage): LocaleCatalog {
  const cached = cache.get(lang);
  if (cached) return cached;
  const filename = LANG_TO_FILENAME[lang];
  const raw = readBundledJson<LocaleStringsFile>(filename);
  const catalog: LocaleCatalog = {
    items: raw.items ?? {},
    stages: raw.stages ?? {},
    heroes: raw.heroes ?? {},
    difficulties: raw.difficulties ?? {},
  };
  cache.set(lang, catalog);
  return catalog;
}

/** Empty stub for tests / fallback. */
export function emptyLocaleCatalog(): LocaleCatalog {
  return {
    items: {},
    stages: {},
    heroes: {},
    difficulties: {},
  };
}

/** Test-only: clear the cache so subsequent `loadLocaleCatalog` calls re-read. */
export function _resetLocaleCatalogCacheForTests(): void {
  cache.clear();
}
