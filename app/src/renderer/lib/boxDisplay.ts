import type { TFunction } from "i18next";
import type { LookupBoxCategory, LookupBoxDropVia } from "../../../shared/types";
import type { BoxEventTier, BoxPlagueRule, BoxPlagueTier } from "../../core/lookup/boxDisplay";
import { boxEventTier, boxEventTierFromName, boxPlagueTier } from "../../core/lookup/boxDisplay";

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

/** Localized label for a plague (Contaminated) chest tier. */
export function translateBoxPlagueTier(t: TFunction<"lookup">, tier: BoxPlagueTier): string {
  switch (tier) {
    case "plagueCommon":
      return t("box.categoryPlagueNormal");
    case "plagueRare":
      return t("box.categoryPlagueStageBoss");
    case "plagueAct":
      return t("box.categoryPlagueActBoss");
  }
}

/** Localized label for a v1.3.0 Halloween event chest tier. */
export function translateBoxEventTier(t: TFunction<"lookup">, tier: BoxEventTier): string {
  switch (tier) {
    case "eventNormal":
      return t("box.categoryEventNormal");
    case "eventStage":
      return t("box.categoryEventStage");
  }
}

/**
 * Trailing "(Nightmare)" / "(Hell)" / "(Torment)" difficulty suffix of a box
 * name, with the difficulty word localized. The Halloween event boxes are the
 * only ones whose name carries the difficulty in parentheses (their level
 * numbering differs per difficulty: 39 / 59 / 84), so the suffix has to
 * survive the category rebuild — otherwise the three difficulties would be
 * indistinguishable.
 */
function localizedDifficultySuffix(t: TFunction<"lookup">, boxName: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(boxName);
  if (!m) return "";
  return localizeDifficultyWords(t, m[0]);
}

/** Localized acquisition-rule line for a plague box (shared group vs unique). */
export function translateBoxPlagueRule(t: TFunction<"lookup">, rule: BoxPlagueRule): string {
  switch (rule.kind) {
    case "shared-group":
      return t("box.ruleSharedGroup", { count: rule.stageCount });
    case "unique-stage":
      return t("box.ruleUniqueStage");
    case "unique-act":
      return t("box.ruleUniqueAct");
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
  // v1.3.0 Halloween event boxes: the lookup source tags them as plain
  // common / stage_boss, so the `via` alone would render them as the wrong
  // chest. Detect them by name and use the event label (+ difficulty).
  const event = boxEventTierFromName(drop.boxName);
  if (event != null) {
    const base = translateBoxEventTier(t, event);
    const suffix = localizedDifficultySuffix(t, drop.boxName);
    return suffix ? `${base} ${suffix}` : base;
  }
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

/**
 * Localized display name for a chest on the Chests tab. The lookup source's
 * `box.name` is a pre-baked English string ("Normal Monster Box 1"), so we
 * rebuild it from the localized category/tier label plus the chest `level`
 * (enriched by main from `stage_boxes.json`). Plague boxes use their plague
 * label; non-plague use the box category. When no level is known, just the
 * category label is returned.
 */
export function localizedBoxName(
  t: TFunction<"lookup">,
  box: { name: string; category: LookupBoxCategory; level?: number | null },
  boxItemKey: number,
): string {
  // v1.3.0 Halloween event boxes come first: the lookup source tags them as
  // plain common / stage_boss, so without this they would be rendered as the
  // wrong chest AND mixed into the wrong group.
  const event = boxEventTier(boxItemKey);
  if (event != null) {
    const base = translateBoxEventTier(t, event);
    const suffix = localizedDifficultySuffix(t, box.name);
    return suffix ? `${base} ${suffix}` : base;
  }
  const tier = boxPlagueTier(boxItemKey);
  const base =
    tier != null ? translateBoxPlagueTier(t, tier) : translateBoxCategoryLabel(t, box.category);
  if (box.level != null) return t("box.levelSuffix", { base, level: box.level });
  return base;
}

const DIFFICULTY_WORDS: Array<[string, string]> = [
  ["Torment", "box.difficultyTorment"],
  ["Nightmare", "box.difficultyNightmare"],
  ["Hell", "box.difficultyHell"],
  ["Normal", "box.difficultyNormal"],
];

/**
 * Replace the English difficulty words (Normal/Nightmare/Hell/Torment) that are
 * baked into lookup text like `dropStageRangeLabel` ("Normal 2-3") or stage
 * coordinates ("Normal 2-3 - ...") with the active locale's difficulty labels.
 * Word-boundary replacement so "Normal" isn't touched inside other words.
 */
export function localizeDifficultyWords(t: TFunction<"lookup">, text: string): string {
  if (!text) return text;
  let out = text;
  for (const [word, key] of DIFFICULTY_WORDS) {
    const label = t(key);
    if (!label || label === word) continue;
    out = out.replace(new RegExp(`\\b${word}\\b`, "g"), label);
  }
  return out;
}
