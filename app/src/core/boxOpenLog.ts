// Helpers for resolving BoxOpenLog entries to tracker keys and labels.
// Pure: no Electron, no React, no fs.

export type BoxCategory = "common" | "rare" | "act";

/** Map a numeric boxType (from BoxOpenLog) to a category. Returns null for unknown. */
export function boxCategoryFromType(boxType: number | undefined | null): BoxCategory | null {
  if (boxType == null) return null;
  if (boxType === 0) return "common";
  if (boxType === 1) return "rare";
  if (boxType === 2) return "act";
  return null;
}

/**
 * Derive the tracker boxKey from a boxType and optional level.
 * Returns "common" | "rare" | "act" (category-only) or "rare:3" (levelled).
 * Returns null when boxType is unknown.
 */
export function resolveBoxKey(boxType: number | undefined | null, level?: number): string | null {
  const category = boxCategoryFromType(boxType);
  if (category == null) return null;
  if (level != null && level > 0) return `${category}:${level}`;
  return category;
}

/** Human-readable label for a boxKey. */
export function boxLabel(boxKey: string): string {
  if (boxKey === "common") return "Common chest";
  if (boxKey === "rare") return "Stage boss chest";
  if (boxKey === "act") return "Act boss chest";
  const colonIdx = boxKey.indexOf(":");
  if (colonIdx > 0) {
    const category = boxKey.slice(0, colonIdx);
    const levelStr = boxKey.slice(colonIdx + 1);
    const level = Number(levelStr);
    if (Number.isFinite(level) && level > 0) {
      const base = boxLabel(category);
      if (base !== category) return `${base} Lv${level}`;
    }
  }
  return boxKey;
}

/** Extract category from a boxKey string. */
export function categoryFromBoxKey(boxKey: string): BoxCategory | null {
  const colonIdx = boxKey.indexOf(":");
  const cat = colonIdx > 0 ? boxKey.slice(0, colonIdx) : boxKey;
  if (cat === "common" || cat === "rare" || cat === "act") return cat;
  return null;
}

/** Extract level from a boxKey string; null when category-only. */
export function levelFromBoxKey(boxKey: string): number | null {
  const colonIdx = boxKey.indexOf(":");
  if (colonIdx <= 0) return null;
  const level = Number(boxKey.slice(colonIdx + 1));
  return Number.isFinite(level) && level > 0 ? level : null;
}
