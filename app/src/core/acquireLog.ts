// Structuring the game's in-memory "获得记录" (acquired-item log) messages.
//
// The game keeps a holistic, cap-~2000 ring of "获得记录" lines (the same text
// the in-game record UI renders). Each line is a localized rich-text message
// like "获得了<color=#D7D7D7>永恒之弓</color>。". We parse these into a
// structured form (name / rarity color / count) so the record page can render,
// filter and cross-reference items instead of just echoing raw text.
//
// Parsing is intentionally tolerant: it extracts whatever structure a message
// actually has and falls back to the raw text otherwise. Pure — no memory/fs.

export interface AcquireItem {
  /** Display name extracted from the message (rich-text tags stripped). */
  name: string;
  /** `<color=#RRGGBB>` value if the wrapped name carries a rarity tint. */
  color?: string;
  /** How many of the item. Defaults to 1. */
  count?: number;
  /** The message explicitly marked it as an item-acquisition (vs. gold/xp). */
  kind: "item" | "gold" | "xp" | "other";
}

const COLOR_RE = /<color=\s*#([0-9a-fA-F]{6})>([\s\S]*?)<\/color>/;
const OTHER_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const COUNT_RE = /\b(?:x\s*)?(\d{1,5})\s*$/;

/**
 * Parse a single "获得记录" message into a structured item. Where the message
 * only loosely matches (gold/xp/plain text) we return a best-effort record
 * rather than dropping it, so the record stays complete.
 */
export function parseAcquireMessage(text: string): AcquireItem {
  const cleaned = (text ?? "").trim();
  if (!cleaned) return { kind: "other", name: "" };

  const stripped = cleaned.replace(OTHER_TAG_RE, "").trim();

  // Explicit multi-count suffix ("… x2", "… 3") → count.
  let count = 1;
  const mCount = stripped.match(COUNT_RE);
  if (mCount) count = Math.max(1, parseInt(mCount[1], 10));

  // Item wrapped in a colour tag: "获得了<color=#D7D7D7>永恒之弓</color>。"→ name+color.
  const mColor = cleaned.match(COLOR_RE);
  if (mColor) {
    const name = mColor[2].replace(OTHER_TAG_RE, "").trim();
    return { name, color: `#${mColor[1].toUpperCase()}`, count, kind: "item" };
  }

  // Plain-text guesses for gold / xp (\b is ASCII-only, so match CJK substrings).
  const lower = stripped.toLowerCase();
  if (lower.includes("金币") || /\b(gold|coin|coins)/i.test(stripped)) {
    return { name: stripped, count, kind: "gold" };
  }
  if (lower.includes("经验") || /\b(xp|exp)\b/i.test(stripped)) {
    return { name: stripped, count, kind: "xp" };
  }

  // Unknown → keep raw text (record stays complete; no item keyed).
  return { name: stripped || cleaned, count, kind: "other" };
}

/**
 * The game's rich-text tint → catalog grade.
 *
 * Measured 2026-09-16 against the bundled catalog: every log line whose item
 * name resolves to exactly ONE catalog row (materials — one row per item, so
 * its grade is unambiguous) was tabulated by tint. Every colour below was
 * confirmed by ≥3 such rows; nothing is inferred.
 *
 * Deliberately partial: BEYOND / DIVINE / COSMIC never appeared in the sample
 * (they are vanishingly rare), so no colour is asserted for them. Callers must
 * treat a `null` result as "grade unknown" and fall back to the base variant —
 * guessing a grade would pick the wrong catalog id and mis-file the item in a
 * per-box breakdown, which is worse than filing it under the base variant.
 */
const COLOR_TO_GRADE: Record<string, string> = {
  "#D7D7D7": "COMMON",
  "#7CE937": "UNCOMMON",
  "#519FFF": "RARE",
  "#EBBB00": "LEGENDARY",
  "#E8695A": "IMMORTAL",
  "#FB86FF": "ARCANA",
  "#00F6FF": "CELESTIAL",
};

/**
 * Grade for a log line's `<color=#RRGGBB>` tint, or `null` when the tint is
 * absent or is not one of the measured item tints (chest / clear / hero notices
 * use their own colours and must never be mistaken for an item grade).
 */
export function gradeFromAcquireColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const normalized = color.trim().toUpperCase();
  return COLOR_TO_GRADE[normalized] ?? null;
}

/** Strip rich-text tags for plain display of a raw message. */
export function stripRichText(text: string): string {
  return (text ?? "").replace(OTHER_TAG_RE, "").trim();
}
