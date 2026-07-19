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
import type { LookupItem, LookupStatRow } from "../../../shared/types";
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
 * FLAT-mod stat rows where the upstream `tbh-data` extractor uses a display
 * name that differs from `humanizeStatKey(stat)`. Used by {@link formatStatRow}
 * to locate the English stat-name segment inside the pre-baked `display`
 * string so it can be swapped for the localized name.
 */
const STAT_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  AttackSpeed: "Attack Per Second",
  MaxHp: "Max HP",
  HpLeech: "Life Leech",
  HpRegenPerSec: "HP Regen Per Sec",
  AddHpPerHit: "HP Per Hit",
  AddAllSkillLevel: "All Skill Level",
  BaseAttackCountReduction: "Basic Attack Requirement Reduction",
  SkillHealIncrease: "Skill Heal",
};

/**
 * Localize a stat row's `display` text by replacing the English stat-name
 * segment with the localized {@link statLabel}. Preserves upstream formatting
 * (+, %, value, "Increased", "More", etc.) — only the stat name portion is
 * swapped. When no localization is available (statLabel falls back to
 * `humanizeStatKey`), the original `display` is returned unchanged.
 */
export function formatStatRow(row: LookupStatRow, t?: TFunction): string {
  if (!t) return row.display;
  const localizedName = statLabel(row.stat, t);
  const humanized = humanizeStatKey(row.stat);
  if (localizedName === humanized) return row.display;
  if (row.display.includes(humanized)) {
    return row.display.replace(humanized, localizedName);
  }
  const override = STAT_DISPLAY_NAME_OVERRIDES[row.stat];
  if (override && row.display.includes(override)) {
    return row.display.replace(override, localizedName);
  }
  return row.display;
}
