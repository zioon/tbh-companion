// Locale catalog for stage / hero / item / difficulty names.
//
// Bundled in data/locale_strings_<lang>.json. Four languages (en, zh-CN, ja,
// ko) have dedicated catalog files; the remaining 12 game-supported languages
// fall back to the English catalog until dedicated translations are produced.
// Loaded once per process via `loadLocaleCatalog(lang)`, then injected into
// services via constructor. Language switch triggers a re-load + service
// `setLocaleCatalog(newCatalog)` call.
//
// Pure: uses `core/bundledData.readBundledJson` (synchronous readFileSync)
// cached for process lifetime. No electron / no fetch.

import type { ResolvedLanguage } from "../../shared/language";
import type { GameLocaleData } from "../../shared/types";
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

/**
 * Per-language bundled catalog filename. The 12 languages without dedicated
 * translations reuse the English file as a placeholder (UI strings and item
 * names will appear in English until native translations are contributed).
 * Game-extracted labels (grades/types/stats) are still loaded per-language
 * at runtime via `tryMergeGameLocale` — only the bundled catalog falls back.
 */
const LANG_TO_FILENAME: Record<ResolvedLanguage, string> = {
  en: "locale_strings_en.json",
  "zh-CN": "locale_strings_zh-CN.json",
  ja: "locale_strings_ja.json",
  ko: "locale_strings_ko.json",
  // English fallback for the 12 newly-added game languages:
  "zh-Hant": "locale_strings_en.json",
  "fr-FR": "locale_strings_en.json",
  "de-DE": "locale_strings_en.json",
  "id-ID": "locale_strings_en.json",
  "pl-PL": "locale_strings_en.json",
  "pt-BR": "locale_strings_en.json",
  "ru-RU": "locale_strings_en.json",
  "es-ES": "locale_strings_en.json",
  "th-TH": "locale_strings_en.json",
  "tr-TR": "locale_strings_en.json",
  "uk-UA": "locale_strings_en.json",
  "vi-VN": "locale_strings_en.json",
};

/**
 * Test/export helper: return the bundled catalog filename for a language.
 * Exposed so tests can verify fallback mapping without reading files.
 */
export function getLocaleCatalogFilename(lang: ResolvedLanguage): string {
  return LANG_TO_FILENAME[lang];
}

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

// --- Game locale overlay ---
//
// The bundled `locale_strings_<lang>.json` files only exist for 4 languages
// (en, zh-CN, ja, ko). The remaining 12 game-supported languages fall back to
// the English file, so item/stage/hero/difficulty names would appear in
// English even when the player selects e.g. French or German.
//
// The game's own locale bundles (extracted at runtime by
// `catalogRefreshService` into `GameLocaleData`) contain translations for ALL
// 16 languages, keyed by prefixes: `ItemName_*`, `StageName_*`, `HeroName_*`,
// `Difficulty_*`. `mergeGameLocaleIntoCatalog` overlays these onto a base
// catalog so the 12 fallback languages get native translations for the
// 511 items / 30 stages / 6 heroes / 4 difficulties the game ships.
//
// For the 4 languages with dedicated offline JSON, game values still win —
// they reflect the current game version, while the offline file may be stale.

const ITEM_NAME_PREFIX = "ItemName_";
const STAGE_NAME_PREFIX = "StageName_";
const HERO_NAME_PREFIX = "HeroName_";
const DIFFICULTY_PREFIX = "Difficulty_";

/**
 * Overlay game-extracted locale entries onto a base LocaleCatalog.
 *
 * - `ItemName_<key>` → `items[<key>]`
 * - `StageName_<key>` → `stages[<key>]`
 * - `HeroName_<key>` → `heroes[<key>]`
 * - `Difficulty_<key>` → `difficulties[<key>]`
 *
 * Game values override bundled values for the same key. Returns the base
 * catalog unchanged if `gameLocale` is null or has no entry for `lang`.
 */
export function mergeGameLocaleIntoCatalog(
  base: LocaleCatalog,
  gameLocale: GameLocaleData | null,
  lang: ResolvedLanguage,
): LocaleCatalog {
  if (!gameLocale) return base;
  const locale = gameLocale.locales[lang];
  if (!locale) return base;

  const items: Record<string, string> = { ...base.items };
  const stages: Record<string, string> = { ...base.stages };
  const heroes: Record<string, string> = { ...base.heroes };
  const difficulties: Record<string, string> = { ...base.difficulties };

  for (const [key, value] of Object.entries(locale)) {
    if (key.startsWith(ITEM_NAME_PREFIX)) {
      items[key.slice(ITEM_NAME_PREFIX.length)] = value;
    } else if (key.startsWith(STAGE_NAME_PREFIX)) {
      stages[key.slice(STAGE_NAME_PREFIX.length)] = value;
    } else if (key.startsWith(HERO_NAME_PREFIX)) {
      heroes[key.slice(HERO_NAME_PREFIX.length)] = value;
    } else if (key.startsWith(DIFFICULTY_PREFIX)) {
      difficulties[key.slice(DIFFICULTY_PREFIX.length)] = value;
    }
  }

  return { items, stages, heroes, difficulties };
}
