// 纯 i18next 工厂：不依赖 electron / react，可被 main 与 renderer 复用。
// 调用方必须先用 resolveLanguage() 把 "auto" 解析为具体语言。

import i18next, { type i18n as I18nInstance } from "i18next";
import type { ResolvedLanguage } from "../../../shared/language";

export type { ResolvedLanguage };

export interface CreateI18nOptions {
  language: ResolvedLanguage;
  fallback: ResolvedLanguage;
  resources: Record<ResolvedLanguage, Record<string, object>>;
  /**
   * Optional hook to register plugins (e.g. initReactI18next) before init
   * runs. The renderer uses this so react-i18next can bind to the instance.
   */
  beforeInit?: (instance: I18nInstance) => void;
}

export const I18N_NAMESPACES = [
  "common",
  "tabs",
  "settings",
  "live",
  "inventory",
  "market",
  "loot",
  "chests",
  "lookup",
  "pets",
  "about",
  "liveMemory",
  "tray",
  "notifications",
  "dialogs",
  "whatsNew",
] as const;

/** 创建并初始化一个独立的 i18next 实例（同步初始化，资源内联）。 */
export function createI18n(opts: CreateI18nOptions): I18nInstance {
  const instance = i18next.createInstance();
  opts.beforeInit?.(instance);
  instance.init({
    lng: opts.language,
    fallbackLng: opts.fallback,
    resources: opts.resources,
    defaultNS: "common",
    ns: [...I18N_NAMESPACES],
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });
  return instance;
}

/**
 * Build a raw i18next init-options object from the same shared config the
 * factory uses. The renderer calls this with the `initReactI18next` plugin
 * on the global i18next singleton — see `src/renderer/i18n.ts`.
 */
export function buildI18nConfig(opts: CreateI18nOptions) {
  return {
    lng: opts.language,
    fallbackLng: opts.fallback,
    resources: opts.resources,
    defaultNS: "common",
    ns: [...I18N_NAMESPACES],
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  };
}
