// 本地化标签辅助函数。所有 Lookup / Inventory / Loot 公用的「品质 / 物品类型 /
// 装备种类 / 材料种类 / 词条 / 职业限制」展示文案都走这里。调用方通过
// `useTranslation()` 拿到 `t` 后传入。
//
// 设计要点：
// - key 不在 common.json 的 labels 节命中时，回退到原 core/labels.ts 的 Title Case
//   行为（如 "LEGENDARY" → "Legendary"）。这样老数据 / 新增枚举值不会因为缺译而
//   渲染成 key 本身。
// - Steam market_hash_name 不能本地化（marketName.ts 仍用 core/grades.ts 的
//   gradeTitle）。本文件只负责 UI 展示。
// - 没传 `t` 时也回退到 Title Case，方便测试与无 i18n 上下文的场景。

import type { TFunction } from "i18next";
import type { LookupItem, LookupMaterialOutcome, LookupStatRow } from "../../../shared/types";
import { classForGearType } from "../../core/lookup/classRestriction";
import { humanizeStatKey } from "./lookupDisplay";

function titleCase(s: string): string {
  if (!s) return s;
  return s[0] + s.slice(1).toLowerCase();
}

/** "LEGENDARY" -> "Legendary" (en) / "传奇" (zh-CN) / ... */
export function gradeLabel(grade: string, t?: TFunction): string {
  if (!grade) return grade;
  if (t) {
    const key = `common:labels.grades.${grade}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return titleCase(grade);
}

/**
 * "GEAR" -> "Gear" / "装备"; "SWORD" -> "Sword" / "剑"; "OFFERING" ->
 * "Offering" / "祭品". 物品类型、装备种类、材料种类共用一个 namespace
 * （types），因为这些枚举值本身不会冲突，且 UI 上都是「类型」语义。
 */
export function typeLabel(type: string, t?: TFunction): string {
  if (!type || type === "UNKNOWN") {
    if (t) {
      const key = "common:labels.types.UNKNOWN";
      const translated = t(key);
      if (translated && translated !== key) return translated;
    }
    return "Unknown";
  }
  if (t) {
    const key = `common:labels.types.${type}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return titleCase(type);
}

/** "WEAPON" -> "Weapon" / "武器" (gearGroup label). */
export function gearGroupLabel(group: string, t?: TFunction): string {
  if (t) {
    const key = `common:labels.gearGroups.${group}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return titleCase(group);
}

/** "Offense" / "Defense" / "Util" / "Skill" / "Other" (modifier group label). */
export function modifierGroupLabel(group: string, t?: TFunction): string {
  if (t) {
    const key = `common:labels.modifierGroups.${group}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return group;
}

/** "AttackDamage" -> "Attack Damage" / "攻击伤害". */
export function statLabel(statKey: string, t?: TFunction): string {
  if (t) {
    const key = `common:labels.stats.${statKey}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return humanizeStatKey(statKey);
}

/**
 * craftingType → localized label for a recipe's crafting category.
 *
 * `craftingType` in `lookup_sources.json` is TitleCase and spans three game
 * locale namespaces:
 *   - "Accessory" / "Armor"  → `labels.gearGroups.ACCESSORY` / `ARMOR`
 *   - "Helmet" / "Boots" / "Gloves" → `labels.types.HELMET` / `BOOTS` / `GLOVES`
 *   - "MainWeapon" / "SubWeapon" → `labels.itemParts.MAIN_WEAPON` / `SUB_WEAPON`
 *
 * Calling `statLabel` here was a bug — it queried `labels.stats.Accessory`
 * (which doesn't exist; "Accessory" is a gear group, not a stat) and
 * i18next's fallback rendered the raw key ("Labels.stats.Accessory").
 *
 * Falls back to `humanizeStatKey` ("MainWeapon" → "Main Weapon") when no
 * translation is found, so unmapped values still render reasonably.
 */
const CRAFTING_TYPE_TO_GEAR_GROUP: Record<string, string> = {
  Accessory: "ACCESSORY",
  Armor: "ARMOR",
};
const CRAFTING_TYPE_TO_GEAR_TYPE: Record<string, string> = {
  Helmet: "HELMET",
  Boots: "BOOTS",
  Gloves: "GLOVES",
};
const CRAFTING_TYPE_TO_ITEM_PART: Record<string, string> = {
  MainWeapon: "MAIN_WEAPON",
  SubWeapon: "SUB_WEAPON",
};

export function craftingTypeLabel(craftingType: string, t?: TFunction): string {
  if (!craftingType) return craftingType;
  if (t) {
    const tryKey = (key: string): string | null => {
      const translated = t(key);
      if (translated && translated !== key) return translated;
      return null;
    };
    const gg = CRAFTING_TYPE_TO_GEAR_GROUP[craftingType];
    if (gg) {
      const v = tryKey(`common:labels.gearGroups.${gg}`);
      if (v) return v;
    }
    const gt = CRAFTING_TYPE_TO_GEAR_TYPE[craftingType];
    if (gt) {
      const v = tryKey(`common:labels.types.${gt}`);
      if (v) return v;
    }
    const ip = CRAFTING_TYPE_TO_ITEM_PART[craftingType];
    if (ip) {
      const v = tryKey(`common:labels.itemParts.${ip}`);
      if (v) return v;
    }
  }
  return humanizeStatKey(craftingType);
}

/** "Knight" -> "Knight" / "骑士" (hero class name). */
export function classLabel(className: string, t?: TFunction): string {
  if (t) {
    const key = `common:labels.classes.${className}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return className;
}

/** Gear -> its slot ("Bow" / "弓"); material -> its kind ("Decoration" / "装饰"). */
export function itemDescriptor(item: LookupItem, t?: TFunction): string {
  return item.type === "GEAR"
    ? typeLabel(item.gearType ?? "", t)
    : typeLabel(item.materialType ?? "", t);
}

/** "Lv 80 · Knight only" / "等级 80 · 仅骑士". null when neither applies. */
export function itemMetaLine(item: LookupItem, t?: TFunction): string | null {
  const parts: string[] = [];
  if (item.level != null) {
    parts.push(t ? t("common:labels.levelShort", { level: item.level }) : `Lv ${item.level}`);
  }
  const className = classForGearType(item.gearType);
  if (className) {
    const localizedClass = classLabel(className, t);
    parts.push(
      t ? t("common:labels.classOnly", { class: localizedClass }) : `${localizedClass} only`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Format a value for attribute-line interpolation. Matches the game's own
 * rendering: integers render without a decimal point; non-integers render
 * with up to two decimals, trimmed of trailing zeros.
 *
 * When `value` is already a string (e.g. extracted from
 * `LookupStatRow.display` like "1.00" from "Attack Per Second 1.00"), it is
 * returned verbatim so the game's original formatting — including trailing
 * zeros the game intentionally shows for Attack Speed — is preserved.
 *
 * Defensive against non-number inputs (string, null, undefined) — the
 * catalog's declared types are `number` but some legacy extractor output
 * has been observed emitting strings. Coerce first so we never throw.
 */
function formatStatValue(value: number | string | unknown): string {
  if (typeof value === "string") return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Extract the first formatted numeric token (e.g. "1.00", "20.9", "2") from
 * a game-rendered display string like "Attack Per Second 1.00" or
 * "20.9% Increased Attack Damage". Used to recover the game's display value
 * from {@link LookupStatRow.display}, since `LookupStatRow.value` stores the
 * raw internal integer (e.g. AttackSpeed FLAT value=10 meaning 1.00 attacks
 * per second) and the per-stat scaling rules vary — the display string is
 * the only source of truth for the game's intended formatting.
 *
 * Returns null when no numeric token is found.
 */
function extractDisplayValue(display: string): string | null {
  const m = /-?\d+(?:\.\d+)?/.exec(display);
  return m ? m[0] : null;
}

/**
 * Look up a game-supplied stat template by its full game key (e.g.
 * "Stat_AttackDamage_FLAT") in the i18next `common:labels.statTemplates.*`
 * namespace, where {@link gameLocaleLabels.flatGameKeysToLabels} merges the
 * game locale bundles. Returns the raw template string (with `{0}` / `{1}`
 * placeholders intact) when found, or `null` when no template exists for
 * this key in the active language.
 *
 * `t` is optional — when absent (e.g. in unit tests without an i18n
 * provider), the function always returns `null` and callers fall back to
 * the catalog's English `display` / `displayText`.
 */
function lookupStatTemplate(t: TFunction | undefined, gameKey: string): string | null {
  if (!t) return null;
  const i18nKey = `common:labels.statTemplates.${gameKey}`;
  // i18next's default interpolation would consume the game's positional
  // `{0}` / `{1}` placeholders and replace them with empty strings before
  // we get a chance to fill them ourselves. Pass `interpolation: { skipInterpolation: true }`
  // (via the second-arg options) so we receive the raw template verbatim.
  // `returnEmptyString: false` is set globally, so a missing key yields `""`,
  // which our truthiness check below treats as "no template".
  const template = t(i18nKey, { interpolation: { skipInterpolation: true } });
  if (!template) return null;
  // Defensive: also reject when i18next returns the key itself (older config).
  const strippedKey = i18nKey.replace(/^common:/, "");
  if (template === i18nKey || template === strippedKey) return null;
  return template;
}

/**
 * Fill `{0}` / `{1}` placeholders in a game stat template. The game uses
 * positional `{N}` placeholders (not i18next's `{{N}}`), so we do a manual
 * string replace after fetching the raw template.
 *
 * Values may be numbers (e.g. `LookupMaterialOutcome.displayMin`) or strings
 * (e.g. a token extracted from `LookupStatRow.display`). Strings are passed
 * through `formatStatValue` verbatim so the game's original decimal
 * formatting is preserved.
 */
function fillStatTemplate(template: string, values: Array<number | string>): string {
  let out = template;
  for (let i = 0; i < values.length; i++) {
    out = out.split(`{${i}}`).join(formatStatValue(values[i]));
  }
  return out;
}

/**
 * Context for {@link formatStatRow}: base stats use the game's
 * `BaseStatName_<stat>` / `StatName_<stat>` display-name templates (e.g.
 * "Attack Per Second 1.00", "Attack Damage 1"), while inherent affixes use
 * the `Stat_<stat>_<mod>` modifier templates (e.g. "Attack Damage +1",
 * "20.9% Increased Attack Damage"). The two paths produce different
 * formatting — base stats show a naked value after the stat name, affixes
 * fill a positional `{0}` template that usually includes +/- or %.
 */
export type StatRowKind = "base" | "affix";

/**
 * Look up a game-supplied base-stat display name by stat key, preferring
 * `BaseStatName_<stat>` (the game's per-stat override for base stats whose
 * unit differs from the raw integer, e.g. AttackSpeed → "Attack Per Second"
 * / "每秒攻击") and falling back to `StatName_<stat>` (the generic stat
 * display name, e.g. "Attack Damage" / "攻击力"). Returns null when neither
 * is available for this stat in the active language.
 */
function lookupBaseStatName(t: TFunction | undefined, stat: string): string | null {
  if (!t) return null;
  const baseKey = `common:labels.baseStatNames.${stat}`;
  const baseVal = t(baseKey, { interpolation: { skipInterpolation: true } });
  if (baseVal && baseVal !== baseKey && baseVal !== baseKey.replace(/^common:/, "")) {
    return baseVal;
  }
  const statNameKey = `common:labels.stats.${stat}`;
  const statNameVal = t(statNameKey, { interpolation: { skipInterpolation: true } });
  if (statNameVal && statNameVal !== statNameKey && statNameVal !== statNameKey.replace(/^common:/, "")) {
    return statNameVal;
  }
  return null;
}

/**
 * Render a stat row using the game's own attribute-line template for the
 * active language. Falls back to the catalog's English `display` string
 * when no template is available, so we never lose data.
 *
 * The companion does not translate stat names itself — the game bundle is
 * the single source of truth.
 *
 * **Value source:** `LookupStatRow.value` is the raw internal integer (e.g.
 * AttackSpeed FLAT `value=10` means 1.00 attacks/sec, AttackDamage ADDITIVE
 * `value=209` means +20.9%). Per-stat scaling rules vary, so we extract the
 * already-formatted numeric token from `row.display` (e.g. "1.00" from
 * "Attack Per Second 1.00") and feed THAT into the template — falling back
 * to `row.value` only when display is missing or contains no digit.
 *
 * @param kind `"base"` for gear base stats (uses BaseStatName/StatName +
 *   naked value), `"affix"` for inherent/unique affixes (uses
 *   `Stat_<stat>_<mod>` modifier template). Defaults to `"affix"` for
 *   backward compatibility.
 */
export function formatStatRow(row: LookupStatRow, t?: TFunction, kind: StatRowKind = "affix"): string {
  const displayValue = row.display ? extractDisplayValue(row.display) : null;
  const value = displayValue ?? row.value;

  if (kind === "base") {
    // Base stats render as "<stat name> <value>" (e.g. "每秒攻击 1.00",
    // "攻击力 1"). Use BaseStatName_<stat> when available (AttackSpeed),
    // otherwise StatName_<stat> (AttackDamage etc.). Fall back to the
    // catalog's display string when neither template exists.
    const name = lookupBaseStatName(t, row.stat);
    if (name !== null) return `${name} ${formatStatValue(value)}`;
    return row.display;
  }

  const gameKey = `Stat_${row.stat}_${row.mod}`;
  const template = lookupStatTemplate(t, gameKey);
  if (template !== null) return fillStatTemplate(template, [value]);
  return row.display;
}

/**
 * Render a material outcome's attribute line using the game's own template.
 * When `displayMin` and `displayMax` differ, the `_MinMax` template variant
 * is used (e.g. "Stat_FireDamagePercent_FLAT_MinMax" → "火焰伤害 +20~30%"
 * in Chinese). When they're equal, the single-value template is used.
 * Falls back to the catalog's English `displayText` when no template exists.
 */
export function formatMaterialOutcome(outcome: LookupMaterialOutcome, t?: TFunction): string {
  const isRange = outcome.displayMin !== outcome.displayMax;
  const gameKey = isRange
    ? `Stat_${outcome.stat}_${outcome.mod}_MinMax`
    : `Stat_${outcome.stat}_${outcome.mod}`;
  const template = lookupStatTemplate(t, gameKey);
  if (template !== null) {
    return isRange
      ? fillStatTemplate(template, [outcome.displayMin, outcome.displayMax])
      : fillStatTemplate(template, [outcome.displayMin]);
  }
  return outcome.displayText;
}
