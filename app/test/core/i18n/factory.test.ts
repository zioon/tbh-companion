import { describe, expect, it } from "vitest";
import { createI18n, type ResolvedLanguage } from "../../../src/core/i18n/factory";

const resources: Partial<Record<ResolvedLanguage, Record<string, object>>> = {
  en: {
    common: { greeting: "Hello", farewell: "Goodbye" },
    tabs: { live: "Live" },
  },
  "zh-CN": {
    common: { greeting: "你好" },
    tabs: { live: "实时" },
  },
  ja: { common: {}, tabs: {} },
  ko: { common: {}, tabs: {} },
};

describe("createI18n", () => {
  it("returns a usable i18next instance", () => {
    const i = createI18n({ language: "en", fallback: "en", resources });
    expect(i.t("common:greeting")).toBe("Hello");
  });

  it("falls back to fallbackLng when key missing in current language", () => {
    const i = createI18n({ language: "zh-CN", fallback: "en", resources });
    // zh-CN has greeting but not farewell
    expect(i.t("common:greeting")).toBe("你好");
    expect(i.t("common:farewell")).toBe("Goodbye");
  });

  it("changeLanguage updates t() output", () => {
    const i = createI18n({ language: "en", fallback: "en", resources });
    expect(i.t("common:greeting")).toBe("Hello");
    void i.changeLanguage("zh-CN");
    expect(i.t("common:greeting")).toBe("你好");
  });

  it("returns key when translation entirely missing", () => {
    const i = createI18n({ language: "en", fallback: "en", resources });
    // i18next default: appendNamespaceToMissingKey=false, so missing key
    // returns the bare key without namespace prefix.
    expect(i.t("common:nonexistent")).toBe("nonexistent");
  });

  it("interpolates variables", () => {
    const enResources = resources.en!;
    const i = createI18n({
      language: "en",
      fallback: "en",
      resources: {
        ...resources,
        en: {
          ...enResources,
          common: { ...enResources.common, welcome: "Hi {{name}}" },
        },
      },
    });
    expect(i.t("common:welcome", { name: "Alice" })).toBe("Hi Alice");
  });
});
