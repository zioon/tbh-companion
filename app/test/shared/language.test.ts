import { describe, expect, it } from "vitest";
import {
  APP_LANGUAGES,
  DEFAULT_LANGUAGE,
  GAME_LANG_IDX_TO_RESOLVED,
  resolveGameLanguage,
  resolveLanguage,
} from "../../shared/language";

describe("language", () => {
  it("APP_LANGUAGES contains all 16 game-supported languages", () => {
    expect(APP_LANGUAGES).toEqual([
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
    ]);
    expect(APP_LANGUAGES).toHaveLength(16);
  });

  it("DEFAULT_LANGUAGE is auto", () => {
    expect(DEFAULT_LANGUAGE).toBe("auto");
  });

  it("resolveLanguage returns explicit language unchanged", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLanguage("zh-Hant", "en-US")).toBe("zh-Hant");
    expect(resolveLanguage("ja", "en-US")).toBe("ja");
    expect(resolveLanguage("ko", "en-US")).toBe("ko");
    expect(resolveLanguage("fr-FR", "en-US")).toBe("fr-FR");
    expect(resolveLanguage("vi-VN", "en-US")).toBe("vi-VN");
  });

  it("resolveLanguage maps auto to system locale", () => {
    expect(resolveLanguage("auto", "zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("auto", "zh-TW")).toBe("zh-Hant");
    expect(resolveLanguage("auto", "zh-HK")).toBe("zh-Hant");
    expect(resolveLanguage("auto", "zh-Hans")).toBe("zh-CN");
    expect(resolveLanguage("auto", "ja-JP")).toBe("ja");
    expect(resolveLanguage("auto", "ko-KR")).toBe("ko");
    expect(resolveLanguage("auto", "en-US")).toBe("en");
    expect(resolveLanguage("auto", "fr-FR")).toBe("fr-FR");
    expect(resolveLanguage("auto", "de-DE")).toBe("de-DE");
    expect(resolveLanguage("auto", "id-ID")).toBe("id-ID");
    expect(resolveLanguage("auto", "pl-PL")).toBe("pl-PL");
    expect(resolveLanguage("auto", "pt-BR")).toBe("pt-BR");
    expect(resolveLanguage("auto", "ru-RU")).toBe("ru-RU");
    expect(resolveLanguage("auto", "es-ES")).toBe("es-ES");
    expect(resolveLanguage("auto", "th-TH")).toBe("th-TH");
    expect(resolveLanguage("auto", "tr-TR")).toBe("tr-TR");
    expect(resolveLanguage("auto", "uk-UA")).toBe("uk-UA");
    expect(resolveLanguage("auto", "vi-VN")).toBe("vi-VN");
  });

  it("resolveLanguage falls back to en for unknown locale", () => {
    expect(resolveLanguage("auto", "xx-XX")).toBe("en");
    expect(resolveLanguage("auto", "ar-SA")).toBe("en");
    expect(resolveLanguage("auto", "hi-IN")).toBe("en");
  });

  it("resolveLanguage falls back to zh-CN for unspecified zh variants", () => {
    expect(resolveLanguage("auto", "zh")).toBe("zh-CN");
    expect(resolveLanguage("auto", "zh-XX")).toBe("zh-CN");
  });

  it("resolveLanguage falls back to pt-BR for unspecified pt variants", () => {
    expect(resolveLanguage("auto", "pt")).toBe("pt-BR");
    expect(resolveLanguage("auto", "pt-PT")).toBe("pt-BR");
  });

  it("resolveLanguage is case-insensitive on locale", () => {
    expect(resolveLanguage("auto", "ZH-cn")).toBe("zh-CN");
    expect(resolveLanguage("auto", "JA-jp")).toBe("ja");
    expect(resolveLanguage("auto", "FR-fr")).toBe("fr-FR");
    expect(resolveLanguage("auto", "VI-vn")).toBe("vi-VN");
  });

  describe("game language sync", () => {
    it("GAME_LANG_IDX_TO_RESOLVED maps all 16 idx values", () => {
      // Full mapping derived from localization-locales bundle m_SortOrder field.
      expect(Object.keys(GAME_LANG_IDX_TO_RESOLVED)).toHaveLength(16);
      expect(GAME_LANG_IDX_TO_RESOLVED[0]).toBe("en");
      expect(GAME_LANG_IDX_TO_RESOLVED[1]).toBe("de-DE");
      expect(GAME_LANG_IDX_TO_RESOLVED[2]).toBe("es-ES");
      expect(GAME_LANG_IDX_TO_RESOLVED[3]).toBe("fr-FR");
      expect(GAME_LANG_IDX_TO_RESOLVED[4]).toBe("pl-PL");
      expect(GAME_LANG_IDX_TO_RESOLVED[5]).toBe("pt-BR");
      expect(GAME_LANG_IDX_TO_RESOLVED[6]).toBe("ru-RU");
      expect(GAME_LANG_IDX_TO_RESOLVED[7]).toBe("tr-TR");
      expect(GAME_LANG_IDX_TO_RESOLVED[8]).toBe("uk-UA");
      expect(GAME_LANG_IDX_TO_RESOLVED[9]).toBe("zh-CN");
      expect(GAME_LANG_IDX_TO_RESOLVED[10]).toBe("zh-Hant");
      expect(GAME_LANG_IDX_TO_RESOLVED[11]).toBe("ja");
      expect(GAME_LANG_IDX_TO_RESOLVED[12]).toBe("ko");
      expect(GAME_LANG_IDX_TO_RESOLVED[13]).toBe("th-TH");
      expect(GAME_LANG_IDX_TO_RESOLVED[14]).toBe("vi-VN");
      expect(GAME_LANG_IDX_TO_RESOLVED[15]).toBe("id-ID");
    });

    it("resolveGameLanguage returns the mapped language for known idx", () => {
      expect(resolveGameLanguage(0)).toBe("en");
      expect(resolveGameLanguage(9)).toBe("zh-CN");
      expect(resolveGameLanguage(11)).toBe("ja");
      expect(resolveGameLanguage(12)).toBe("ko");
      expect(resolveGameLanguage(10)).toBe("zh-Hant");
      expect(resolveGameLanguage(1)).toBe("de-DE");
      expect(resolveGameLanguage(15)).toBe("id-ID");
    });

    it("resolveGameLanguage falls back to en for unmapped idx", () => {
      expect(resolveGameLanguage(999)).toBe("en");
      expect(resolveGameLanguage(-1)).toBe("en");
    });

    it("resolveGameLanguage returns null for invalid input", () => {
      expect(resolveGameLanguage(null)).toBeNull();
      expect(resolveGameLanguage(undefined)).toBeNull();
      expect(resolveGameLanguage(Number.NaN)).toBeNull();
    });

    it("resolveLanguage with 'game' uses gameLanguage when provided", () => {
      expect(resolveLanguage("game", "en-US", "zh-CN")).toBe("zh-CN");
      expect(resolveLanguage("game", "zh-CN", "ja")).toBe("ja");
      expect(resolveLanguage("game", "zh-CN", "ko")).toBe("ko");
      expect(resolveLanguage("game", "zh-CN", "en")).toBe("en");
      expect(resolveLanguage("game", "zh-CN", "zh-Hant")).toBe("zh-Hant");
      expect(resolveLanguage("game", "zh-CN", "fr-FR")).toBe("fr-FR");
    });

    it("resolveLanguage with 'game' falls back to system locale when gameLanguage is null", () => {
      // Registry read failure or game not installed — fall back to auto behavior.
      expect(resolveLanguage("game", "zh-CN", null)).toBe("zh-CN");
      expect(resolveLanguage("game", "ja-JP", null)).toBe("ja");
      expect(resolveLanguage("game", "en-US", null)).toBe("en");
      expect(resolveLanguage("game", "en-US", undefined)).toBe("en");
    });
  });
});
