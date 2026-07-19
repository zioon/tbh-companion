import type { TFunction } from "i18next";

/**
 * Translate a boxKey into a localized label. Mirrors the logic in
 * `core/boxOpenLog.boxLabel` but uses i18next so the chest category names
 * and the "Lv" prefix honor the active locale.
 *
 * The core helper stays English-only (no i18next import in core/); this
 * renderer-side wrapper is the one UI code should call.
 */
export function translateBoxLabel(t: TFunction<"loot">, boxKey: string): string {
  const colonIdx = boxKey.indexOf(":");
  if (colonIdx > 0) {
    const category = boxKey.slice(0, colonIdx);
    const levelStr = boxKey.slice(colonIdx + 1);
    const level = Number(levelStr);
    if (Number.isFinite(level) && level > 0) {
      const base = baseCategoryLabel(t, category);
      if (base != null) {
        const result = t("levelSuffix", { base, level: Math.trunc(level) });
        // deno-fmt-ignore
        console.warn("[translateBoxLabel]", boxKey, "→ base:", base, "→ result:", result, "| t.language:", (t as any).language);
        return result;
      }
    }
  }
  const direct = baseCategoryLabel(t, boxKey);
  // deno-fmt-ignore
  console.warn("[translateBoxLabel]", boxKey, "→ direct:", direct, "| t.language:", (t as any).language);
  return direct ?? boxKey;
}

function baseCategoryLabel(t: TFunction<"loot">, category: string): string | null {
  if (category === "common") return t("category.common");
  if (category === "rare") return t("category.rare");
  if (category === "act") return t("category.act");
  if (category === "unclassified") return t("category.unclassified");
  return null;
}
