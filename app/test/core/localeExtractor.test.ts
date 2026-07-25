import { describe, expect, it } from "vitest";
import { extractLocales } from "../../src/core/unityAssets/localeExtractor";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 复用 catalogExtractor 测试已有的 fixture bundle
const FIXTURES = join(__dirname, "unityAssets", "fixtures");
const sharedBundle = readFileSync(join(FIXTURES, "shared_assets.bundle"));
const enBundle = readFileSync(join(FIXTURES, "en_stringtable.bundle"));

describe("extractLocales", () => {
  it("returns null when shared bundle has no entries", () => {
    const result = extractLocales({
      sharedBundle: Buffer.alloc(0),
      locales: { en: enBundle },
    });
    expect(result).toBeNull();
  });

  it("returns locales map for all provided languages", () => {
    const result = extractLocales({
      sharedBundle,
      locales: { en: enBundle, "zh-CN": Buffer.alloc(0) },
    });
    expect(result).not.toBeNull();
    expect(result!.en).toEqual(expect.any(Object));
    expect(Object.keys(result!.en).length).toBeGreaterThan(0);
    // zh-CN bundle 为空，应该返回空 map（不报错）
    expect(result!["zh-CN"]).toEqual({});
  });

  it("accepts arbitrary language codes (dynamic, not hardcoded)", () => {
    const result = extractLocales({
      sharedBundle,
      locales: {
        en: enBundle,
        "zh-Hant": enBundle, // 复用 en bundle 测试任意 lang key
        "fr-FR": enBundle,
        "vi-VN": enBundle,
      },
    });
    expect(result).not.toBeNull();
    expect(result!["zh-Hant"]).toEqual(expect.any(Object));
    expect(result!["fr-FR"]).toEqual(expect.any(Object));
    expect(result!["vi-VN"]).toEqual(expect.any(Object));
    // 所有语言都用了同一个 bundle，内容应该一致
    expect(result!["zh-Hant"]).toEqual(result!.en);
  });

  it("returns empty object for languages with empty buffer", () => {
    const result = extractLocales({
      sharedBundle,
      locales: {
        en: enBundle,
        "fr-FR": Buffer.alloc(0),
        "de-DE": Buffer.alloc(0),
      },
    });
    expect(result).not.toBeNull();
    expect(Object.keys(result!.en).length).toBeGreaterThan(0);
    expect(result!["fr-FR"]).toEqual({});
    expect(result!["de-DE"]).toEqual({});
  });

  it("returns same language keys as input", () => {
    const inputLangs = [
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
    ];
    const locales: Record<string, Buffer> = {};
    for (const lang of inputLangs) locales[lang] = enBundle;
    const result = extractLocales({ sharedBundle, locales });
    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual([...inputLangs].sort());
  });
});
