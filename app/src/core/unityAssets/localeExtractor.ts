// app/src/core/unityAssets/localeExtractor.ts
// Extracts ALL localized string entries from the game's locale bundles,
// not just ItemName_ (which catalogExtractor handles). Produces a flat
// key-value map per language so the companion can sync grade/type/stat
// translations at runtime.
//
// Reuses the same binary-format parser chain as catalogExtractor:
//   parseBundle → parseSerializedFile → scanMarkerEntries
//
// Language list is dynamic: caller provides a `locales` map keyed by BCP-47
// code; extractor returns the same keys with their respective string maps.
// Missing/empty bundles yield an empty map (not null) for that language.

import { parseBundle } from "./bundleParser";
import { parseSerializedFile } from "./serializedFile";
import { scanMarkerEntries } from "./monobehaviourEntries";

const TYPE_MONOBEHAVIOUR = 114;

/**
 * Input: shared bundle (hash → key) + per-language locale bundles.
 *
 * `locales` keys are BCP-47 language codes (e.g. "en", "zh-CN", "zh-Hant",
 * "fr-FR", ...). Values are raw bundle Buffers; empty Buffer is allowed
 * (yields an empty map for that language, not null).
 */
export interface LocaleExtractorInput {
  sharedBundle: Buffer;
  locales: Record<string, Buffer>;
}

/**
 * Output: same keys as input `locales`, each mapping to a flat key→value
 * translation map (e.g. `{ "Grade_COMMON": "Common", ... }`).
 */
export type ExtractedLocales = Record<string, Record<string, string>>;

/**
 * Find the smallest MonoBehaviour in a parsed bundle (which is the
 * SharedTableData / StringTable), scan marker entries, and return an
 * ordered list of { hash, str } pairs.
 */
function scanLocaleEntries(bundleBuffer: Buffer): { hash: number; str: string }[] {
  if (bundleBuffer.length === 0) return [];
  try {
    const bundle = parseBundle(bundleBuffer);
    const sf = parseSerializedFile(bundle.data);
    const monos = sf.objects
      .filter((o) => o.classID === TYPE_MONOBEHAVIOUR)
      .map((o) => ({ info: o, raw: sf.getObjectRaw(o, bundle.data) }))
      .sort((a, b) => a.raw.length - b.raw.length);
    const smallest = monos[0];
    if (!smallest) return [];
    return scanMarkerEntries(smallest.raw).map((e) => ({ hash: e.hash, str: e.str }));
  } catch {
    return [];
  }
}

/**
 * Extract all localized strings from the locale bundles.
 *
 * Returns null only if the shared bundle has no entries (game bundles
 * unavailable / unreadable). Individual locale bundles that fail are
 * silently returned as empty maps (caller can detect missing translations
 * by checking `Object.keys(result[lang]).length === 0`).
 */
export function extractLocales(input: LocaleExtractorInput): ExtractedLocales | null {
  // Shared bundle: hash → key mapping (e.g. hash 12345 → "Grade_COMMON").
  const sharedEntries = scanLocaleEntries(input.sharedBundle);
  if (sharedEntries.length === 0) return null;

  const keyByHash = new Map<number, string>();
  for (const e of sharedEntries) keyByHash.set(e.hash, e.str);

  /**
   * For a locale bundle, build key→value map by joining with shared keys.
   * Returns empty map if the bundle is unreadable (empty entries).
   */
  function buildMap(bundleBuffer: Buffer): Record<string, string> {
    const localeEntries = scanLocaleEntries(bundleBuffer);
    if (localeEntries.length === 0) return {};
    const map: Record<string, string> = {};
    for (const e of localeEntries) {
      const key = keyByHash.get(e.hash);
      if (key !== undefined) map[key] = e.str;
    }
    return map;
  }

  const result: ExtractedLocales = {};
  for (const [lang, buf] of Object.entries(input.locales)) {
    result[lang] = buildMap(buf);
  }
  return result;
}
