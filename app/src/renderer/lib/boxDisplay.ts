import type { TFunction } from "i18next";
import type { LookupBoxCategory, LookupBoxDropVia } from "../../../shared/types";

/**
 * Renderer-side i18n wrappers for `core/lookup/boxDisplay` English helpers.
 * Mirrors the `translateBoxLabel` pattern in `lib/boxLabel.ts`: keep core pure
 * (no i18next import) and translate at the call site instead.
 */

export function translateBoxCategoryLabel(
  t: TFunction<"lookup">,
  category: LookupBoxCategory,
): string {
  switch (category) {
    case "common":
      return t("box.categoryCommon");
    case "stage_boss":
      return t("box.categoryStageBoss");
    case "act_boss":
      return t("box.categoryActBoss");
    default:
      return t("box.categoryDefault");
  }
}

export function translateBoxDropViaLabel(t: TFunction<"lookup">, via: LookupBoxDropVia): string {
  switch (via) {
    case "monster_box":
      return t("box.viaMonsterKill");
    case "boss_box":
      return t("box.viaStageBossKill");
    case "act_boss":
      return t("box.viaActBossKill");
  }
}

/**
 * Localize a drop's box name for the ItemDetailCard "Where to find" section.
 * The upstream `boxName` is a pre-baked English string like
 * "Normal Monster Box 2" or "Stage Boss Box Lv20". We rebuild it from the
 * `via` category (→ localized category label) plus the trailing level
 * number parsed out of the English `boxName`, so the level info is preserved
 * while the category text is localized.
 */
export function translateBoxDropName(
  t: TFunction<"lookup">,
  drop: { via: string; boxName: string },
): string {
  const category = viaToCategory(drop.via);
  const base = translateBoxCategoryLabel(t, category);
  const levelMatch = drop.boxName.match(/Lv?\s*(\d+)\s*$/i);
  const level = levelMatch ? levelMatch[1] : null;
  return level != null ? t("box.levelSuffix", { base, level }) : base;
}

function viaToCategory(via: string): LookupBoxCategory {
  switch (via) {
    case "monster_box":
      return "common";
    case "boss_box":
      return "stage_boss";
    case "act_boss":
      return "act_boss";
    default:
      return "unknown";
  }
}
