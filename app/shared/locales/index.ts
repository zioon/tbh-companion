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
// Per-language loot namespace (chest category + levelSuffix) for the 12
// languages that otherwise reuse the English bundle. These override the
// English loot strings so chest labels show in the player's language.
import zhHantLoot from "./zh-Hant/loot.json";
import frFRLoot from "./fr-FR/loot.json";
import deDELoot from "./de-DE/loot.json";
import idIDLoot from "./id-ID/loot.json";
import plPLLoot from "./pl-PL/loot.json";
import ptBRLoot from "./pt-BR/loot.json";
import ruRULoot from "./ru-RU/loot.json";
import esESLoot from "./es-ES/loot.json";
import thTHLoot from "./th-TH/loot.json";
import trTRLoot from "./tr-TR/loot.json";
import ukUALoot from "./uk-UA/loot.json";
import viVNLoot from "./vi-VN/loot.json";

function withLoot(base: Record<string, object>, loot: object): Record<string, object> {
  return { ...base, loot };
}

export const LOCALE_RESOURCES: Record<ResolvedLanguage, Record<string, object>> = {
  en,
  "zh-CN": zhCN,
  ja,
  ko,
  "zh-Hant": withLoot(en, zhHantLoot),
  "fr-FR": withLoot(en, frFRLoot),
  "de-DE": withLoot(en, deDELoot),
  "id-ID": withLoot(en, idIDLoot),
  "pl-PL": withLoot(en, plPLLoot),
  "pt-BR": withLoot(en, ptBRLoot),
  "ru-RU": withLoot(en, ruRULoot),
  "es-ES": withLoot(en, esESLoot),
  "th-TH": withLoot(en, thTHLoot),
  "tr-TR": withLoot(en, trTRLoot),
  "uk-UA": withLoot(en, ukUALoot),
  "vi-VN": withLoot(en, viVNLoot),
};
