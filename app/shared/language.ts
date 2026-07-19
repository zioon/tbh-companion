// UI 语言类型与解析工具。shared 层 — 为主进程、渲染进程、core 共享。

/** 已支持的具体语言（不含 "auto" / "game"）。覆盖游戏支持的全部 16 种语言。 */
export const APP_LANGUAGES = [
  "en",
  "zh-CN",
  "zh-Hant",
  "fr-FR",
  "de-DE",
  "id-ID",
  "ja",
  "ko",
  "pl-PL",
  "pt-BR",
  "ru-RU",
  "es-ES",
  "th-TH",
  "tr-TR",
  "uk-UA",
  "vi-VN",
] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number] | "auto" | "game";

export const DEFAULT_LANGUAGE: AppLanguage = "auto";

/** resolveLanguage 的返回类型：去掉 "auto" / "game" 的具体语言。 */
export type ResolvedLanguage = (typeof APP_LANGUAGES)[number];

/**
 * 游戏 `tbh_lang_idx` 注册表值 → BCP-47 区码。从 `localization-locales`
 * bundle 中解析出的 16 个 Locale MonoBehaviour 的 `m_SortOrder` 字段
 * （int32）。
 *
 * 完整映射通过 scripts/dump_locale_index.py 调查得出；如游戏更新后映射变化，
 * 重新运行该脚本并更新此表。
 */
export const GAME_LANG_IDX_TO_RESOLVED: Readonly<Record<number, ResolvedLanguage>> = {
  0: "en", // English (United States)
  1: "de-DE", // German (Germany)
  2: "es-ES", // Spanish (Spain)
  3: "fr-FR", // French (France)
  4: "pl-PL", // Polish (Poland)
  5: "pt-BR", // Portuguese (Brazil)
  6: "ru-RU", // Russian (Russia)
  7: "tr-TR", // Turkish (Turkey)
  8: "uk-UA", // Ukrainian (Ukraine)
  9: "zh-CN", // Chinese (Simplified) — companion 用 zh-CN 与 navigator.language 对齐
  10: "zh-Hant", // Chinese (Traditional)
  11: "ja", // Japanese (Japan)
  12: "ko", // Korean (South Korea)
  13: "th-TH", // Thai (Thailand)
  14: "vi-VN", // Vietnamese (Vietnam)
  15: "id-ID", // Indonesian (Indonesia)
};

/**
 * 将游戏 `tbh_lang_idx` 注册表值解析为 companion app 支持的 ResolvedLanguage。
 * 未映射的索引回退到 "en"。
 */
export function resolveGameLanguage(
  gameLangIdx: number | null | undefined,
): ResolvedLanguage | null {
  if (gameLangIdx == null || !Number.isFinite(gameLangIdx)) return null;
  return GAME_LANG_IDX_TO_RESOLVED[gameLangIdx] ?? "en";
}

/**
 * 将配置中的 language（可能是 "auto" / "game"）解析为具体 BCP-47 标签。
 * - "auto" 时按 systemLocale 前缀匹配；未知 locale 回退 "en"。
 * - "game" 时按 gameLanguage（已通过 readGameLanguage 解析）返回；未提供则
 *   回退到 "auto" 的 systemLocale 行为，保证启动期/读注册表失败时不报错。
 */
export function resolveLanguage(
  language: AppLanguage,
  systemLocale: string,
  gameLanguage?: ResolvedLanguage | null,
): ResolvedLanguage {
  if (language === "game") {
    if (gameLanguage) return gameLanguage;
    // 注册表读取失败时回退到 system locale 推断。
    return resolveAuto(systemLocale);
  }
  if (language !== "auto") return language;
  return resolveAuto(systemLocale);
}

function resolveAuto(systemLocale: string): ResolvedLanguage {
  const lower = systemLocale.toLowerCase();
  // 简体中文：zh-CN, zh-Hans, zh-SG, zh-hans-*
  if (lower.startsWith("zh-cn") || lower.startsWith("zh-hans") || lower.startsWith("zh-sg")) {
    return "zh-CN";
  }
  // 繁体中文：zh-TW, zh-Hant, zh-HK, zh-MO
  if (
    lower.startsWith("zh-tw") ||
    lower.startsWith("zh-hant") ||
    lower.startsWith("zh-hk") ||
    lower.startsWith("zh-mo")
  ) {
    return "zh-Hant";
  }
  // 其它 zh* 一律回退到简中
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("fr")) return "fr-FR";
  if (lower.startsWith("de")) return "de-DE";
  if (lower.startsWith("id")) return "id-ID";
  if (lower.startsWith("pl")) return "pl-PL";
  // pt-BR 优先；其它 pt* 回退到 pt-BR
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("ru")) return "ru-RU";
  if (lower.startsWith("es")) return "es-ES";
  if (lower.startsWith("th")) return "th-TH";
  if (lower.startsWith("tr")) return "tr-TR";
  if (lower.startsWith("uk")) return "uk-UA";
  if (lower.startsWith("vi")) return "vi-VN";
  return "en";
}
