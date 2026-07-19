// 渲染进程 i18next + react-i18next 初始化。
// 在 TbhProvider 挂载时由 getConfig() 拿到 language（可能含 resolvedLanguage
// 运行时派生字段）后调用 initRendererI18n()。
// 复用 core/i18n/factory 的 buildI18nConfig 保证配置与主进程一致。
//
// 初始化后尝试从主进程拉取游戏 locale 数据（userData/locale.json），
// 覆盖 bundled 翻译中 labels 节的品质/类型/属性等字段，使翻译与游戏保持同步。

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { buildI18nConfig } from "../core/i18n/factory";
import { resolveLanguage, type AppLanguage, type ResolvedLanguage } from "../../shared/language";
import { LOCALE_RESOURCES } from "../../shared/locales";
import { flatGameKeysToLabels } from "./lib/gameLocaleLabels";

let initialized = false;

/**
 * 从主进程拉取游戏提取的 locale 数据，若存在则将 labels 节合并到 i18next
 * 资源中（游戏值优先于 bundled 值）。仅在已初始化且 window.tbh 可用时调用。
 */
async function tryMergeGameLocale(): Promise<void> {
  try {
    const localeData = await window.tbh.getLocaleData();
    if (!localeData) return;

    // Iterate every language present in the game-extracted locale data
    // (4 or 16, depending on game version). For languages not yet loaded
    // into i18next, addResourceBundle still stores them for later use.
    for (const lang of Object.keys(localeData.locales)) {
      const game = localeData.locales[lang];
      if (!game || Object.keys(game).length === 0) continue;
      const labels = flatGameKeysToLabels(game);
      if (labels) {
        i18next.addResourceBundle(lang, "common", { labels }, true, true);
      }
    }
  } catch {
    // Non-fatal: game bundles not available, no refresh done yet, etc.
  }
}

/**
 * 初始化或更新渲染进程 i18next。第一次调用时绑定 react-i18next；后续调用
 *（如语言变更）仅切换语言。`useTranslation()` 默认订阅全局 i18next 实例，
 * 语言切换会自动触发重渲染。
 *
 * @param language 用户配置的语言偏好（"auto" / "game" / 具体语言）
 * @param resolvedLanguage 主进程通过 getConfig() 返回的运行时派生语言；
 *   仅当 language === "game" 时由主进程填充（从游戏注册表读取）。渲染进程
 *   无 reg.exe 访问权限，必须依赖主进程注入此字段。
 */
export async function initRendererI18n(
  language: AppLanguage,
  resolvedLanguage?: ResolvedLanguage,
): Promise<typeof i18next> {
  const resolved: ResolvedLanguage = resolveLanguage(
    language,
    navigator.language,
    resolvedLanguage ?? null,
  );
  if (initialized) {
    await i18next.changeLanguage(resolved);
    return i18next;
  }
  await i18next.use(initReactI18next).init(
    buildI18nConfig({
      language: resolved,
      fallback: "en",
      resources: LOCALE_RESOURCES,
    }),
  );
  initialized = true;

  // 异步合并游戏 locale 数据（不阻塞渲染）
  tryMergeGameLocale();

  return i18next;
}

/**
 * 切换渲染进程语言。useTranslation() 的订阅者会自动重渲染。
 *
 * 当 language === "game" 时，调用方需先通过 getConfig() 拿到主进程注入的
 * resolvedLanguage 并传入；否则会回退到 navigator.language 推断。
 */
export async function changeRendererLanguage(
  language: AppLanguage,
  resolvedLanguage?: ResolvedLanguage,
): Promise<void> {
  const resolved: ResolvedLanguage = resolveLanguage(
    language,
    navigator.language,
    resolvedLanguage ?? null,
  );
  await i18next.changeLanguage(resolved);
}

export { i18next };
