import { describe, expect, it } from "vitest";
import { createI18n } from "../../src/core/i18n/factory";
import { craftingTypeLabel } from "../../src/renderer/lib/itemLabels";

// 镜像 gameLocaleLabels.flatGameKeysToLabels 合并游戏 locale 后的 i18next 资源结构：
//   labels.gearGroups.{UPPER}  ← StashItemFilterType_*
//   labels.types.{UPPER}       ← GearType_*
//   labels.itemParts.{UPPER}   ← ItemParts_*
function makeT() {
  const i = createI18n({
    language: "en",
    fallback: "en",
    resources: {
      en: {
        common: {
          labels: {
            gearGroups: {
              ACCESSORY: "Accessories",
              ARMOR: "Armor",
              WEAPON: "Weapon",
            },
            types: {
              HELMET: "Helmet",
              BOOTS: "Boots",
              GLOVES: "Gloves",
              ARMOR: "Armor",
            },
            itemParts: {
              MAIN_WEAPON: "Main Weapon",
              SUB_WEAPON: "Sub Weapon",
            },
          },
        },
      },
      "zh-CN": {
        common: {
          labels: {
            gearGroups: {
              ACCESSORY: "饰品",
              ARMOR: "护甲",
              WEAPON: "武器",
            },
            types: {
              HELMET: "头盔",
              BOOTS: "靴子",
              GLOVES: "手套",
              ARMOR: "护甲",
            },
            itemParts: {
              MAIN_WEAPON: "主武器",
              SUB_WEAPON: "副武器",
            },
          },
        },
      },
    },
  });
  return i.t.bind(i) as Parameters<typeof craftingTypeLabel>[1];
}

describe("craftingTypeLabel", () => {
  it("maps Accessory → gearGroups.ACCESSORY (plural 'Accessories')", () => {
    // 回归：之前用 statLabel 查 labels.stats.Accessory 找不到 → 渲染 "Labels.stats.Accessory"
    expect(craftingTypeLabel("Accessory", makeT())).toBe("Accessories");
  });

  it("maps Armor → gearGroups.ARMOR", () => {
    expect(craftingTypeLabel("Armor", makeT())).toBe("Armor");
  });

  it("maps Helmet / Boots / Gloves → types.{HELMET,BOOTS,GLOVES}", () => {
    expect(craftingTypeLabel("Helmet", makeT())).toBe("Helmet");
    expect(craftingTypeLabel("Boots", makeT())).toBe("Boots");
    expect(craftingTypeLabel("Gloves", makeT())).toBe("Gloves");
  });

  it("maps MainWeapon / SubWeapon → itemParts.{MAIN_WEAPON,SUB_WEAPON}", () => {
    expect(craftingTypeLabel("MainWeapon", makeT())).toBe("Main Weapon");
    expect(craftingTypeLabel("SubWeapon", makeT())).toBe("Sub Weapon");
  });

  it("localizes to Chinese when lang=zh-CN", () => {
    const i = createI18n({
      language: "zh-CN",
      fallback: "en",
      resources: {
        en: {
          common: {
            labels: {
              gearGroups: { ACCESSORY: "Accessories" },
              types: { HELMET: "Helmet" },
              itemParts: { MAIN_WEAPON: "Main Weapon" },
            },
          },
        },
        "zh-CN": {
          common: {
            labels: {
              gearGroups: { ACCESSORY: "饰品" },
              types: { HELMET: "头盔" },
              itemParts: { MAIN_WEAPON: "主武器" },
            },
          },
        },
      },
    });
    const t = i.t.bind(i) as Parameters<typeof craftingTypeLabel>[1];
    expect(craftingTypeLabel("Accessory", t)).toBe("饰品");
    expect(craftingTypeLabel("Helmet", t)).toBe("头盔");
    expect(craftingTypeLabel("MainWeapon", t)).toBe("主武器");
  });

  it("falls back to humanizeStatKey when translation missing", () => {
    // Simulate a brand-new craftingType the game locale doesn't know yet.
    // humanizeStatKey("NewThing") = "New Thing"
    const i = createI18n({
      language: "en",
      fallback: "en",
      resources: { en: { common: { labels: {} } } },
    });
    const t = i.t.bind(i) as Parameters<typeof craftingTypeLabel>[1];
    expect(craftingTypeLabel("NewThing", t)).toBe("New Thing");
  });

  it("falls back to humanizeStatKey when t is undefined (no i18n context)", () => {
    expect(craftingTypeLabel("MainWeapon")).toBe("Main Weapon");
    expect(craftingTypeLabel("Accessory")).toBe("Accessory");
  });

  it("returns empty string as-is", () => {
    expect(craftingTypeLabel("", makeT())).toBe("");
  });

  it("does NOT query labels.stats (regression for 'Labels.stats.Accessory' bug)", () => {
    // Even if labels.stats.Accessory is absent (which it always is — Accessory
    // is not a stat), the function must not return the i18next key fallback.
    // Seed labels.stats with unrelated entries to ensure the function doesn't
    // touch it.
    const i = createI18n({
      language: "en",
      fallback: "en",
      resources: {
        en: {
          common: {
            labels: {
              stats: { AttackDamage: "Attack Damage" }, // no Accessory here
              gearGroups: { ACCESSORY: "Accessories" },
            },
          },
        },
      },
    });
    const t = i.t.bind(i) as Parameters<typeof craftingTypeLabel>[1];
    const result = craftingTypeLabel("Accessory", t);
    expect(result).toBe("Accessories");
    expect(result).not.toContain("Labels.stats");
    expect(result).not.toContain("labels.stats");
  });
});
