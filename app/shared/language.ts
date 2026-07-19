// UI 语言类型与解析工具。shared 层 — 为主进程、渲染进程、core 共享。

/** 已支持的具体语言（不含 "auto" / "game"）。 */
export const APP_LANGUAGES = ["en", "zh-CN", "ja", "ko"] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number] | "auto" | "game";

export const DEFAULT_LANGUAGE: AppLanguage = "auto";

/** resolveLanguage 的返回类型：去掉 "auto" / "game" 的具体语言。 */
export type ResolvedLanguage = (typeof APP_LANGUAGES)[number];

/**
 * 游戏 `tbh_lang_idx` 注册表值 → BCP-47 区码。从 `localization-locales` bundle
 * 中解析出的 16 个 Locale MonoBehaviour 的 idx 字段（int32，位于每个 Locale
 * 末尾的 `02 00 00 00 00 00 00 00` 之前 4 字节）。
 *
 * 仅列出 companion app 已支持的语言；其它（de/es/fr/pl/pt/ru/tr/uk/th/vi/id/zh-Hant）
 * 一律回退到 "en"。如未来扩展 APP_LANGUAGES，按需在此添加映射。
 */
export const GAME_LANG_IDX_TO_RESOLVED: Readonly<Record<number, ResolvedLanguage>> = {
  0: "en", // English (United States)
  9: "zh-CN", // Chinese (Simplified)
  11: "ja", // Japanese (Japan)
  12: "ko", // Korean (South Korea)
};

/**
 * 将游戏 `tbh_lang_idx` 注册表值解析为 companion app 支持的 ResolvedLanguage。
 * 未映射的索引（如 1=de, 5=pt 等）回退到 "en"。
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
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  return "en";
}
