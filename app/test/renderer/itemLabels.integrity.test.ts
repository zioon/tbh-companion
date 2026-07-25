// Integrity test: load real lookup_items.json + _game_locale_dump.json,
// merge game locale into i18next (mirroring renderer/i18n.ts tryMergeGameLocale),
// then run formatStatRow on every stat row and report any output whose numeric
// formatting diverges from the game's own display string.
//
// This catches regressions where extractDisplayValue fails on a particular
// display shape, or where a stat template + raw value path produces a number
// that drops a decimal point the game intentionally shows.

import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { buildI18nConfig } from "../../src/core/i18n/factory";
import { LOCALE_RESOURCES } from "../../shared/locales";
import { flatGameKeysToLabels } from "../../src/renderer/lib/gameLocaleLabels";
import { formatStatRow, formatMaterialOutcome } from "../../src/renderer/lib/itemLabels";
import { readBundledJson } from "../../src/core/bundledData";
import { loadLookupItems } from "../../src/core/lookup/catalog";
import type { ResolvedLanguage } from "../../shared/language";

function buildI18nWithGameLocale(lang: ResolvedLanguage): typeof i18next {
  const instance = i18next.createInstance();
  instance.use(initReactI18next);
  instance.init(
    buildI18nConfig({
      language: lang,
      fallback: "en",
      resources: LOCALE_RESOURCES,
    }),
  );
  // Merge game locale dump (mirrors tryMergeGameLocale).
  // _game_locale_dump.json is Record<lang, Record<key, value>> (no wrapper).
  // getLocaleData() wraps it as { version, locales: dump }, so we mirror that.
  const dump = readBundledJson<Record<string, Record<string, string>>>("_game_locale_dump.json");
  const game = dump[lang];
  if (game) {
    const labels = flatGameKeysToLabels(game);
    if (labels) {
      instance.addResourceBundle(lang, "common", { labels }, true, true);
    }
  }
  return instance;
}

/** Extract every numeric token from a string (for comparison). */
function allNumbers(s: string): string[] {
  return s.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

/** Build an i18next instance with NO game locale merged (simulates first render
 * before tryMergeGameLocale completes, or getLocaleData returning null). */
function buildI18nWithoutGameLocale(lang: ResolvedLanguage): typeof i18next {
  const instance = i18next.createInstance();
  instance.use(initReactI18next);
  instance.init(
    buildI18nConfig({
      language: lang,
      fallback: "en",
      resources: LOCALE_RESOURCES,
    }),
  );
  return instance;
}

describe("formatStatRow integrity (real catalog + game locale)", () => {
  const items = loadLookupItems();

  describe("English (en)", () => {
    const i = buildI18nWithGameLocale("en");
    const t = i.t.bind(i) as Parameters<typeof formatStatRow>[1];

    it("every base stat row preserves the display's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.stats?.base) continue;
        for (const row of item.stats.base) {
          const out = formatStatRow(row, t, "base");
          const inNums = allNumbers(row.display);
          const outNums = allNumbers(out);
          // The set of numeric tokens in the output must match the set in
          // the game's display (order may differ if template rearranges).
          const inSorted = [...inNums].sort();
          const outSorted = [...outNums].sort();
          if (inSorted.join(",") !== outSorted.join(",")) {
            failures.push(
              `[en base] ${item.id} ${row.stat}_${row.mod}: display="${row.display}" → out="${out}" (in:${inSorted.join(",")} out:${outSorted.join(",")})`,
            );
          }
        }
      }
      if (failures.length > 0) {
        console.log(failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });

    it("every inherent stat row preserves the display's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.stats?.inherent) continue;
        for (const row of item.stats.inherent) {
          const out = formatStatRow(row, t, "affix");
          const inNums = allNumbers(row.display);
          const outNums = allNumbers(out);
          const inSorted = [...inNums].sort();
          const outSorted = [...outNums].sort();
          if (inSorted.join(",") !== outSorted.join(",")) {
            failures.push(
              `[en affix] ${item.id} ${row.stat}_${row.mod}: display="${row.display}" → out="${out}" (in:${inSorted.join(",")} out:${outSorted.join(",")})`,
            );
          }
        }
      }
      if (failures.length > 0) {
        console.log(failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });

    it("every material outcome preserves displayText's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.gearGroups) continue;
        for (const group of item.gearGroups) {
          for (const outcome of group.outcomes) {
            const out = formatMaterialOutcome(outcome, t);
            const inNums = allNumbers(outcome.displayText);
            const outNums = allNumbers(out);
            const inSorted = [...inNums].sort();
            const outSorted = [...outNums].sort();
            if (inSorted.join(",") !== outSorted.join(",")) {
              failures.push(
                `[en mat] ${item.id} ${outcome.stat}_${outcome.mod}: displayText="${outcome.displayText}" → out="${out}" (in:${inSorted.join(",")} out:${outSorted.join(",")})`,
              );
            }
          }
        }
      }
      if (failures.length > 0) {
        console.log(failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });
  });

  describe("Chinese (zh-CN)", () => {
    const i = buildI18nWithGameLocale("zh-CN");
    const t = i.t.bind(i) as Parameters<typeof formatStatRow>[1];

    it("every base stat row preserves the display's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.stats?.base) continue;
        for (const row of item.stats.base) {
          const out = formatStatRow(row, t, "base");
          const inNums = allNumbers(row.display);
          const outNums = allNumbers(out);
          const inSorted = [...inNums].sort();
          const outSorted = [...outNums].sort();
          if (inSorted.join(",") !== outSorted.join(",")) {
            failures.push(
              `[zh base] ${item.id} ${row.stat}_${row.mod}: display="${row.display}" → out="${out}"`,
            );
          }
        }
      }
      if (failures.length > 0) {
        console.log(failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });

    it("every inherent stat row preserves the display's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.stats?.inherent) continue;
        for (const row of item.stats.inherent) {
          const out = formatStatRow(row, t, "affix");
          const inNums = allNumbers(row.display);
          const outNums = allNumbers(out);
          const inSorted = [...inNums].sort();
          const outSorted = [...outNums].sort();
          if (inSorted.join(",") !== outSorted.join(",")) {
            failures.push(
              `[zh affix] ${item.id} ${row.stat}_${row.mod}: display="${row.display}" → out="${out}"`,
            );
          }
        }
      }
      if (failures.length > 0) {
        console.log(failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });
  });

  describe("English WITHOUT game locale merged (first render / merge failed)", () => {
    const i = buildI18nWithoutGameLocale("en");
    const t = i.t.bind(i) as Parameters<typeof formatStatRow>[1];

    it("every base stat row preserves the display's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.stats?.base) continue;
        for (const row of item.stats.base) {
          const out = formatStatRow(row, t, "base");
          const inNums = allNumbers(row.display);
          const outNums = allNumbers(out);
          const inSorted = [...inNums].sort();
          const outSorted = [...outNums].sort();
          if (inSorted.join(",") !== outSorted.join(",")) {
            failures.push(
              `[en-no-locale base] ${item.id} ${row.stat}_${row.mod}: display="${row.display}" → out="${out}" (in:${inSorted.join(",")} out:${outSorted.join(",")})`,
            );
          }
        }
      }
      if (failures.length > 0) {
        console.log("FAILURES (first 30):\n" + failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });

    it("every inherent stat row preserves the display's numeric tokens", () => {
      const failures: string[] = [];
      for (const item of items) {
        if (!item.stats?.inherent) continue;
        for (const row of item.stats.inherent) {
          const out = formatStatRow(row, t, "affix");
          const inNums = allNumbers(row.display);
          const outNums = allNumbers(out);
          const inSorted = [...inNums].sort();
          const outSorted = [...outNums].sort();
          if (inSorted.join(",") !== outSorted.join(",")) {
            failures.push(
              `[en-no-locale affix] ${item.id} ${row.stat}_${row.mod}: display="${row.display}" → out="${out}" (in:${inSorted.join(",")} out:${outSorted.join(",")})`,
            );
          }
        }
      }
      if (failures.length > 0) {
        console.log("FAILURES (first 30):\n" + failures.slice(0, 30).join("\n"));
      }
      expect(failures.slice(0, 30)).toEqual([]);
    });
  });
});
