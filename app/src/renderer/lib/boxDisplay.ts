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
