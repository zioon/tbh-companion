import { describe, expect, it } from "vitest";
import { flatGameKeysToLabels } from "../../src/renderer/lib/gameLocaleLabels";

describe("flatGameKeysToLabels — UniqueMod_ branch", () => {
  it("maps UniqueMod_ keys into uniqueMods and keeps statTemplates clean", () => {
    const result = flatGameKeysToLabels({
      UniqueMod_SkillCooldownReduce: "{0}技能的冷却时间减少{1}%。",
      UniqueMod_ShieldChargeKillCooldown: "使用Shield Charge击杀时冷却重置。",
      Stat_AttackDamage_FLAT: "攻击力 +{0}",
      StatName_AttackDamage: "攻击力",
      SkillName_10401: "神盾领域",
    });
    expect(result).not.toBeNull();
    expect(result!.uniqueMods).toEqual({
      SkillCooldownReduce: "{0}技能的冷却时间减少{1}%。",
      ShieldChargeKillCooldown: "使用Shield Charge击杀时冷却重置。",
    });
    // SkillName_* maps into skillNames, keyed by SkillKey numeric string.
    expect(result!.skillNames).toEqual({ "10401": "神盾领域" });
    // UniqueMod_* and SkillName_* must never leak into statTemplates.
    expect(result!.statTemplates).toEqual({ Stat_AttackDamage_FLAT: "攻击力 +{0}" });
    expect(Object.keys(result!.statTemplates!)).not.toContain("UniqueMod_SkillCooldownReduce");
    expect(Object.keys(result!.statTemplates!)).not.toContain("SkillName_10401");
  });

  it("omits uniqueMods when no UniqueMod_ keys are present", () => {
    const result = flatGameKeysToLabels({ StatName_AttackDamage: "攻击力" });
    expect(result!.uniqueMods).toBeUndefined();
    expect(result!.skillNames).toBeUndefined();
  });

  it("returns null for an empty map", () => {
    expect(flatGameKeysToLabels({})).toBeNull();
  });
});
