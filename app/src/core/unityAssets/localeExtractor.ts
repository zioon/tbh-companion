// app/src/core/unityAssets/localeExtractor.ts
// Extracts ALL localized string entries from the game's locale bundles,
// not just ItemName_ (which catalogExtractor handles). Produces a flat
// key-value map per language so the companion can sync grade/type/stat
// translations at runtime.
//
// Reuses the same binary-format parser chain as catalogExtractor:
//   parseBundle → parseSerializedFile → scanMarkerEntries

import { parseBundle } from "./bundleParser";
import { parseSerializedFile } from "./serializedFile";
import { scanMarkerEntries } from "./monobehaviourEntries";

const TYPE_MONOBEHAVIOUR = 114;

export interface LocaleExtractorInput {
  sharedBundle: Buffer;
  enBundle: Buffer;
  zhCNBundle: Buffer;
  jaBundle: Buffer;
  koBundle: Buffer;
}

export interface ExtractedLocales {
  en: Record<string, string>;
  "zh-CN": Record<string, string>;
  ja: Record<string, string>;
  ko: Record<string, string>;
}

/**
 * Find the smallest MonoBehaviour in a parsed bundle (which is the
 * SharedTableData / StringTable), scan marker entries, and return an
 * ordered list of { hash, str } pairs.
 */
function scanLocaleEntries(bundleBuffer: Buffer): { hash: number; str: string }[] {
  const bundle = parseBundle(bundleBuffer);
  const sf = parseSerializedFile(bundle.data);
  const monos = sf.objects
    .filter((o) => o.classID === TYPE_MONOBEHAVIOUR)
    .map((o) => ({ info: o, raw: sf.getObjectRaw(o, bundle.data) }))
    .sort((a, b) => a.raw.length - b.raw.length);
  const smallest = monos[0];
  if (!smallest) return [];
  return scanMarkerEntries(smallest.raw).map((e) => ({ hash: e.hash, str: e.str }));
}

/**
 * Extract all localized strings from the 4 locale bundles.
 *
 * Returns null if the shared bundle has no entries (game bundles unavailable).
 * Individual locale bundles that fail are silently skipped (log in caller).
 */
export function extractLocales(input: LocaleExtractorInput): ExtractedLocales | null {
  // Shared bundle: hash → key mapping (e.g. hash 12345 → "Grade_COMMON").
  const sharedEntries = scanLocaleEntries(input.sharedBundle);
  if (sharedEntries.length === 0) return null;

  const keyByHash = new Map<number, string>();
  for (const e of sharedEntries) keyByHash.set(e.hash, e.str);

  /**
   * For a locale bundle, build key→value map by joining with shared keys.
   * Returns null if the bundle is unreadable (empty entries).
   */
  function buildMap(bundleBuffer: Buffer): Record<string, string> | null {
    const localeEntries = scanLocaleEntries(bundleBuffer);
    if (localeEntries.length === 0) return null;
    const map: Record<string, string> = {};
    for (const e of localeEntries) {
      const key = keyByHash.get(e.hash);
      if (key !== undefined) map[key] = e.str;
    }
    return map;
  }

  const en = buildMap(input.enBundle);
  const zhCN = buildMap(input.zhCNBundle);
  const ja = buildMap(input.jaBundle);
  const ko = buildMap(input.koBundle);

  return {
    en: en ?? {},
    "zh-CN": zhCN ?? {},
    ja: ja ?? {},
    ko: ko ?? {},
  };
}
