import { describe, expect, it } from "vitest";
import { APP_LANGUAGES } from "../../shared/language";
import type { GameLocaleData } from "../../shared/types";
import {
  emptyLocaleCatalog,
  getLocaleCatalogFilename,
  mergeGameLocaleIntoCatalog,
  type LocaleCatalog,
} from "../../src/core/localeCatalog";

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

  describe("mergeGameLocaleIntoCatalog", () => {
    const base: LocaleCatalog = {
      items: { "110001": "Minor Ruby", "999999": "Offline-only Item" },
      stages: { "1101": "Pasture" },
      heroes: { "101": "Knight" },
      difficulties: { NORMAL: "Normal" },
    };

    function makeGameLocale(lang: string, entries: Record<string, string>): GameLocaleData {
      return { version: "1.0.0", locales: { [lang]: entries } };
    }

    it("returns base unchanged when gameLocale is null", () => {
      const result = mergeGameLocaleIntoCatalog(base, null, "fr-FR");
      expect(result).toBe(base);
    });

    it("returns base unchanged when gameLocale has no entry for the lang", () => {
      const gameLocale = makeGameLocale("en", { ItemName_110001: "Minor Ruby" });
      const result = mergeGameLocaleIntoCatalog(base, gameLocale, "fr-FR");
      expect(result).toBe(base);
    });

    it("overlays ItemName_ entries onto items, overriding base values", () => {
      const gameLocale = makeGameLocale("fr-FR", {
        ItemName_110001: "Petit rubis",
        ItemName_110002: "Petit saphir",
      });
      const result = mergeGameLocaleIntoCatalog(base, gameLocale, "fr-FR");
      expect(result.items["110001"]).toBe("Petit rubis");
      expect(result.items["110002"]).toBe("Petit saphir");
      // Offline-only items are preserved (not dropped).
      expect(result.items["999999"]).toBe("Offline-only Item");
    });

    it("overlays StageName_ / HeroName_ / Difficulty_ entries", () => {
      const gameLocale = makeGameLocale("de-DE", {
        StageName_1101: "Weide",
        HeroName_101: "Ritter",
        Difficulty_NORMAL: "Normal",
      });
      const result = mergeGameLocaleIntoCatalog(base, gameLocale, "de-DE");
      expect(result.stages["1101"]).toBe("Weide");
      expect(result.heroes["101"]).toBe("Ritter");
      expect(result.difficulties.NORMAL).toBe("Normal");
    });

    it("ignores keys without a recognized prefix", () => {
      const gameLocale = makeGameLocale("ja", {
        ItemName_110001: "スモールルビー",
        Grade_COMMON: "コモン",
        StatName_HP: "HP",
        UI_SOME_KEY: "some value",
      });
      const result = mergeGameLocaleIntoCatalog(base, gameLocale, "ja");
      expect(result.items["110001"]).toBe("スモールルビー");
      // Non-catalog keys are not stored anywhere.
      expect(Object.keys(result.items)).not.toContain("Grade_COMMON");
    });

    it("does not mutate the base catalog", () => {
      const gameLocale = makeGameLocale("ko", { ItemName_110001: "하급 루비" });
      const result = mergeGameLocaleIntoCatalog(base, gameLocale, "ko");
      expect(base.items["110001"]).toBe("Minor Ruby");
      expect(result.items["110001"]).toBe("하급 루비");
      expect(result).not.toBe(base);
      expect(result.items).not.toBe(base.items);
    });

    it("handles empty game locale entries gracefully", () => {
      const gameLocale = makeGameLocale("en", {});
      const result = mergeGameLocaleIntoCatalog(base, gameLocale, "en");
      // Same content as base (shallow copy, but no changes).
      expect(result.items).toEqual(base.items);
      expect(result.stages).toEqual(base.stages);
    });
  });
});
