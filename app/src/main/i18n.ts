// 主进程 i18n 实例。懒初始化：在 app.whenReady() 内由 initMainI18n() 首次调用时创建。
// 在此之前 t() 会回退到 key 本身（即英文源字符串），用于启动早期日志。

import { app } from "electron";
import { execSync } from "node:child_process";
import { createI18n, type ResolvedLanguage } from "../core/i18n/factory";
import { resolveGameLanguage, resolveLanguage, type AppLanguage } from "../../shared/language";
import { LOCALE_RESOURCES } from "../../shared/locales";
import type { AppConfig } from "../../shared/types";
import { createLogger } from "./log";

const i18nLog = createLogger("i18n");

let instance: ReturnType<typeof createI18n> | null = null;

/**
 * 读取游戏注册表中的 `tbh_lang_idx`（REG_DWORD），返回解析后的 ResolvedLanguage。
 * 任何错误（注册表缺失/类型错误/游戏未安装/reg.exe 失败）都返回 null，由
 * resolveLanguage 回退到 system locale 推断。读取结果按调用缓存约 5 秒，
 * 避免每次 getConfig 都 spawn reg.exe。
 *
 * 用 `reg query` 命令而非第三方注册表库，保持零新增 native 依赖。
 */
export function readGameLanguage(): ResolvedLanguage | null {
  const cached = readGameLanguageCache;
  if (cached.expiresAt > Date.now()) return cached.value;
  let value: ResolvedLanguage | null = null;
  try {
    // reg query 输出形如：
    //   tbh_lang_idx_h1851722218    REG_DWORD    0x9
    const out = execSync(
      `reg query "HKCU\\Software\\TesseractStudio\\TaskBarHero" /v "tbh_lang_idx_h1851722218"`,
      { windowsHide: true, timeout: 2000 },
    ).toString("utf-8");
    const m = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out);
    if (m) {
      const idx = parseInt(m[1], 16);
      value = resolveGameLanguage(idx);
      i18nLog.debug?.(`tbh_lang_idx=${idx} → ${value ?? "null"}`);
    }
  } catch (err) {
    // Game not installed or registry missing — silent fallback.
    i18nLog.debug?.(`readGameLanguage failed: ${(err as Error).message}`);
  }
  readGameLanguageCache = { value, expiresAt: Date.now() + 5000 };
  return value;
}

let readGameLanguageCache: { value: ResolvedLanguage | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

/** 测试用：清空缓存。 */
export function _resetGameLanguageCacheForTests(): void {
  readGameLanguageCache = { value: null, expiresAt: 0 };
}

/**
 * 初始化或更新主进程 i18n 实例。第一次调用时创建实例；后续调用（如语言变更）
 * 仅切换语言。必须在 app.whenReady() 之后调用，因为依赖 app.getLocale()。
 *
 * 当 config.language === "game" 时，会先读取注册表得到游戏语言。
 */
export function initMainI18n(config: Pick<AppConfig, "language">): void {
  const gameLang = config.language === "game" ? readGameLanguage() : null;
  const resolved = resolveLanguage(config.language, safeGetLocale(), gameLang);
  if (!instance) {
    instance = createI18n({
      language: resolved,
      fallback: "en",
      resources: LOCALE_RESOURCES,
    });
  } else {
    void instance.changeLanguage(resolved);
  }
}

/**
 * 翻译。在 init 之前返回 key 本身（启动早期日志兜底）。
 */
export function t(key: string, opts?: Record<string, unknown>): string {
  if (!instance) return key;
  return instance.t(key, opts);
}

/**
 * 切换主进程语言（运行时）。需要调用方重建依赖 t() 的资源（如托盘菜单）。
 *
 * 当 lang === "game" 时，会先读取注册表得到游戏语言。
 */
export function changeLanguage(lang: AppLanguage): void {
  if (!instance) return;
  const gameLang = lang === "game" ? readGameLanguage() : null;
  const resolved: ResolvedLanguage = resolveLanguage(lang, safeGetLocale(), gameLang);
  void instance.changeLanguage(resolved);
}

/**
 * 取得主进程 i18n 实例；未初始化时抛错。用于需要直接访问实例的场景（如 onLanguageChanged）。
 */
export function getMainI18n(): ReturnType<typeof createI18n> {
  if (!instance) {
    throw new Error("mainI18n not initialized — call initMainI18n first");
  }
  return instance;
}

/** app.getLocale() 在 app.whenReady() 之前会抛错；此处兜底返回 "en-US"。 */
function safeGetLocale(): string {
  try {
    return app.getLocale();
  } catch {
    return "en-US";
  }
}
