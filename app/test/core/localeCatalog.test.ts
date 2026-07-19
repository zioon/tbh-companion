import { describe, expect, it } from "vitest";
import { APP_LANGUAGES } from "../../shared/language";
import { emptyLocaleCatalog, getLocaleCatalogFilename, type LocaleCatalog } from "../../src/core/localeCatalog";

describe("localeCatalog", () => {
  describe("emptyLocaleCatalog", () => {
    it("returns an object with all empty records", () => {
      const c = emptyLocaleCatalog();
      expect(c.items).toEqual({});
      expect(c.stages).toEqual({});
      expect(c.heroes).toEqual({});
      expect(c.difficulties).toEqual({});
    });

    it("returns a fresh object each call (no shared reference)", () => {
      const a = emptyLocaleCatalog();
      const b = emptyLocaleCatalog();
      expect(a).not.toBe(b);
      expect(a.items).not.toBe(b.items);
    });
  });

  describe("LocaleCatalog type", () => {
    it("accepts a populated catalog", () => {
      const c: LocaleCatalog = {
        items: { "110001": "Goblin Hide" },
        stages: { "1101": "Pasture" },
        heroes: { "101": "Knight" },
        difficulties: { NORMAL: "Normal" },
      };
      expect(c.items["110001"]).toBe("Goblin Hide");
      expect(c.stages["1101"]).toBe("Pasture");
      expect(c.heroes["101"]).toBe("Knight");
      expect(c.difficulties.NORMAL).toBe("Normal");
    });
  });

  describe("getLocaleCatalogFilename", () => {
    it("maps every APP_LANGUAGES entry to a filename", () => {
      // Type-safety: getLocaleCatalogFilename requires ResolvedLanguage, so
      // APP_LANGUAGES (which excludes "auto") is the right input set.
      for (const lang of APP_LANGUAGES) {
        const filename = getLocaleCatalogFilename(lang);
        expect(filename, `filename for ${lang}`).toMatch(/^locale_strings_.+\.json$/);
      }
    });

    it("uses dedicated files for the 4 originally-supported languages", () => {
      expect(getLocaleCatalogFilename("en")).toBe("locale_strings_en.json");
      expect(getLocaleCatalogFilename("zh-CN")).toBe("locale_strings_zh-CN.json");
      expect(getLocaleCatalogFilename("ja")).toBe("locale_strings_ja.json");
      expect(getLocaleCatalogFilename("ko")).toBe("locale_strings_ko.json");
    });

    it("falls back to the English file for the 12 newly-added languages", () => {
      const newLanguages = [
        "zh-Hant",
        "fr-FR",
        "de-DE",
        "id-ID",
        "pl-PL",
        "pt-BR",
        "ru-RU",
        "es-ES",
        "th-TH",
        "tr-TR",
        "uk-UA",
        "vi-VN",
      ] as const;
      for (const lang of newLanguages) {
        expect(getLocaleCatalogFilename(lang), `filename for ${lang}`).toBe(
          "locale_strings_en.json",
        );
      }
    });
  });
});
