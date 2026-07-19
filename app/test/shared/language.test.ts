import { describe, expect, it } from "vitest";
import {
  APP_LANGUAGES,
  DEFAULT_LANGUAGE,
  GAME_LANG_IDX_TO_RESOLVED,
  resolveGameLanguage,
  resolveLanguage,
} from "../../shared/language";

describe("language", () => {
  it("APP_LANGUAGES contains en, zh-CN, ja, ko", () => {
    expect(APP_LANGUAGES).toEqual(["en", "zh-CN", "ja", "ko"]);
  });

  it("DEFAULT_LANGUAGE is auto", () => {
    expect(DEFAULT_LANGUAGE).toBe("auto");
  });

  it("resolveLanguage returns explicit language unchanged", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLanguage("ja", "en-US")).toBe("ja");
    expect(resolveLanguage("ko", "en-US")).toBe("ko");
  });

  it("resolveLanguage maps auto to system locale", () => {
    expect(resolveLanguage("auto", "zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("auto", "zh-TW")).toBe("zh-CN");
    expect(resolveLanguage("auto", "ja-JP")).toBe("ja");
    expect(resolveLanguage("auto", "ko-KR")).toBe("ko");
    expect(resolveLanguage("auto", "en-US")).toBe("en");
  });

  it("resolveLanguage falls back to en for unknown locale", () => {
    expect(resolveLanguage("auto", "fr-FR")).toBe("en");
    expect(resolveLanguage("auto", "de-DE")).toBe("en");
  });

  it("resolveLanguage is case-insensitive on locale", () => {
    expect(resolveLanguage("auto", "ZH-cn")).toBe("zh-CN");
    expect(resolveLanguage("auto", "JA-jp")).toBe("ja");
  });

  describe("game language sync", () => {
    it("GAME_LANG_IDX_TO_RESOLVED maps known supported languages", () => {
      // The 4 supported languages (en/zh-CN/ja/ko) must be present.
      expect(GAME_LANG_IDX_TO_RESOLVED[0]).toBe("en");
      expect(GAME_LANG_IDX_TO_RESOLVED[9]).toBe("zh-CN");
      expect(GAME_LANG_IDX_TO_RESOLVED[11]).toBe("ja");
      expect(GAME_LANG_IDX_TO_RESOLVED[12]).toBe("ko");
    });

    it("resolveGameLanguage returns the mapped language for known idx", () => {
      expect(resolveGameLanguage(0)).toBe("en");
      expect(resolveGameLanguage(9)).toBe("zh-CN");
      expect(resolveGameLanguage(11)).toBe("ja");
      expect(resolveGameLanguage(12)).toBe("ko");
    });

    it("resolveGameLanguage falls back to en for unsupported languages", () => {
      // German (1), Spanish (2), French (3), Portuguese (5), Russian (6),
      // etc. are not in APP_LANGUAGES — must fall back to "en".
      expect(resolveGameLanguage(1)).toBe("en");
      expect(resolveGameLanguage(5)).toBe("en");
      expect(resolveGameLanguage(10)).toBe("en"); // zh-Hant
      expect(resolveGameLanguage(13)).toBe("en"); // th
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
