import { describe, it, expect } from "vitest";
import { isWishLine, parseWishLine } from "../../src/core/wishLine";

describe("isWishLine — 正例（4 语言祈愿行识别）", () => {
  it("zh-CN：祈愿结果：获得 <物品>", () => {
    expect(isWishLine("祈愿结果：获得 神秘手套")).toBe(true);
    expect(isWishLine("祈愿结果：获得<color=#D7D7D7>永恒之弓</color>。")).toBe(true);
  });

  it("zh-Hant：祈願結果：獲得 <物品>", () => {
    expect(isWishLine("祈願結果：獲得 神秘手套")).toBe(true);
    expect(isWishLine("祈願結果：獲得<color=#E8695A>永恆之弓</color>。")).toBe(true);
  });

  it("en：Offering result: Obtained <item>", () => {
    expect(isWishLine("Offering result: Obtained Mysterious Gloves")).toBe(true);
    expect(isWishLine("Offering result: Obtained <color=#519FFF>Eternal Bow</color>.")).toBe(true);
  });

  it("ja：祈願結果：<item>を獲得", () => {
    expect(isWishLine("祈願結果：神秘の手袋を獲得")).toBe(true);
    expect(isWishLine("祈願結果：<color=#7CE937>永恆の弓</color>を獲得")).toBe(true);
  });

  it("ko：기원 결과：<item> 획득", () => {
    expect(isWishLine("기원 결과：신비한 장갑 획득")).toBe(true);
    expect(isWishLine("기원 결과：<color=#00F6FF>영원의 활</color> 획득")).toBe(true);
  });

  it("前缀与模板间含多余空格也能命中（归一化）", () => {
    expect(isWishLine("Offering   result :   Obtained Mystery Box")).toBe(true);
  });

  it("结构兜底：未知语言前缀 + 冒号分隔 + 富文本物品 + 获得动词 → 判真", () => {
    expect(isWishLine("Оффер result: Obtained <color=#D7D7D7>Bow</color>")).toBe(true);
  });

  it("结构兜底不误伤：无冒号分隔的普通获得行仍判假", () => {
    // `获得了<color>X</color>` 有富文本 + 获得动词，但没有「前缀：」结构 →
    // 不得被结构兜底误判（零误判护栏，见架构设计 §5.3 注）。
    expect(isWishLine("获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
  });
});

describe("isWishLine — 反例（零误判护栏）", () => {
  it("空串 / 空白", () => {
    expect(isWishLine("")).toBe(false);
    expect(isWishLine("   ")).toBe(false);
  });

  it("制作结果行", () => {
    expect(isWishLine("制作结果：获得 铁剑")).toBe(false);
    expect(isWishLine("制作结果：获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
  });

  it("合成结果行", () => {
    expect(isWishLine("合成结果：获得 强化石")).toBe(false);
    expect(isWishLine("合成结果：获得了<color=#519FFF>技能书</color>。")).toBe(false);
  });

  it("炼金 / 装饰 / 雕刻 / 铭文 / 提取结果行", () => {
    expect(isWishLine("炼金结果：获得 药剂")).toBe(false);
    expect(isWishLine("装饰结果：获得 挂饰")).toBe(false);
    expect(isWishLine("雕刻结果：获得 符石")).toBe(false);
    expect(isWishLine("铭文结果：获得 铭文石")).toBe(false);
    expect(isWishLine("提取结果：获得 精华")).toBe(false);
  });

  it("英文其他结果行", () => {
    expect(isWishLine("Crafting result: Obtained Iron Sword")).toBe(false);
    expect(isWishLine("Synthesis result: Obtained <color=#519FFF>Skill Book</color>.")).toBe(false);
    expect(isWishLine("Alchemy result: Obtained Potion")).toBe(false);
    expect(isWishLine("Extraction result: Obtained Essence")).toBe(false);
  });

  it("通关行", () => {
    expect(isWishLine("通关了关卡 3-9。(73秒)")).toBe(false);
    expect(isWishLine("Cleared stage 3-9. (73s)")).toBe(false);
  });

  it("英雄被击败行", () => {
    expect(isWishLine("牧师被击败了。(木乃伊)")).toBe(false);
    expect(isWishLine("Priest defeated. (Mummy)")).toBe(false);
  });

  it("普通获得了<color>X</color> 行（非祈愿）", () => {
    expect(isWishLine("获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
    expect(isWishLine("获得了<color=#E8695A>骰子</color>。")).toBe(false);
  });

  it("宝箱 / 提示行", () => {
    expect(isWishLine("获得了一个普通宝箱。")).toBe(false);
    expect(isWishLine("获得金币 x2")).toBe(false);
    expect(isWishLine("获得经验 x10")).toBe(false);
  });
});

describe("parseWishLine — 结构化解析", () => {
  it("抽取出 name / color / count / grade（zh）", () => {
    const item = parseWishLine("祈愿结果：获得<color=#E8695A>永恒之弓</color>。");
    expect(item).not.toBeNull();
    expect(item).toMatchObject({
      name: "永恒之弓",
      color: "#E8695A",
      count: 1,
      grade: "IMMORTAL",
    });
  });

  it("多件：count 从行内后缀解析", () => {
    const item = parseWishLine("祈愿结果：获得<color=#7CE937>强化石</color> x3");
    expect(item?.count).toBe(3);
    expect(item?.grade).toBe("UNCOMMON");
  });

  // —— Round 2 回归：件数后缀**必须**带 x/X 前缀，裸行尾数字不得被吞 ——
  // 根因：旧 extractCount 先剥掉所有富文本标签，再匹配行尾裸数字，导致物品名
  // 尾部数字（`纪念币2024`）暴露到行尾被当作件数（违反 PRD §5.1「缺省 1」）。
  it("回归：颜色标签内名称以数字结尾 → count=1 且名称完整不被截断", () => {
    const item = parseWishLine("祈愿结果：获得<color=#D7D7D7>纪念币2024</color>。");
    expect(item?.count).toBe(1);
    expect(item?.name).toBe("纪念币2024");
    expect(item?.grade).toBe("COMMON");
  });

  it("回归：无颜色行名称以数字结尾 → count=1 且名称完整不被截断", () => {
    const item = parseWishLine("祈愿结果：获得 物品2024。");
    expect(item?.count).toBe(1);
    expect(item?.name).toBe("物品2024");
  });

  it("回归：颜色标签内「名称 空格 数字」→ count=1 且名称完整", () => {
    const item = parseWishLine("祈愿结果：获得<color=#D7D7D7>礼盒 2024</color>。");
    expect(item?.count).toBe(1);
    expect(item?.name).toBe("礼盒 2024");
  });

  it("回归仍保留正例：带 x 前缀的多件后缀正常解析（不被误伤）", () => {
    expect(parseWishLine("祈愿结果：获得<color=#D7D7D7>强化石</color> x5。")?.count).toBe(5);
    expect(parseWishLine("祈愿结果：获得<color=#7CE937>强化石</color> X 5。")?.count).toBe(5);
    // 无颜色行 + x 前缀多件：件数剥离后名称不含残留后缀。
    const noColor = parseWishLine("祈愿结果：获得 强化石 x3。");
    expect(noColor?.count).toBe(3);
    expect(noColor?.name).toBe("强化石");
  });

  it("en 祈愿行", () => {
    const item = parseWishLine("Offering result: Obtained <color=#519FFF>Eternal Bow</color>");
    expect(item).toMatchObject({ name: "Eternal Bow", color: "#519FFF", grade: "RARE" });
  });

  it("ja 祈愿行", () => {
    const item = parseWishLine("祈願結果：<color=#00F6FF>永恆の弓</color>を獲得");
    expect(item).toMatchObject({ name: "永恆の弓", grade: "CELESTIAL" });
  });

  it("ko 祈愿行", () => {
    const item = parseWishLine("기원 결과：<color=#FB86FF>영원의 활</color> 획득");
    expect(item).toMatchObject({ name: "영원의 활", grade: "ARCANA" });
  });

  it("无颜色 → UNKNOWN（不猜测品质），仍计入件数", () => {
    const item = parseWishLine("祈愿结果：获得 神秘手套");
    expect(item).not.toBeNull();
    expect(item?.grade).toBe("UNKNOWN");
    expect(item?.color).toBeUndefined();
    expect(item?.count).toBe(1);
  });

  it("非物品色（宝箱/通关色）→ UNKNOWN（不猜测）", () => {
    // #FF00FF 不在 COLOR_TO_GRADE 中（既非物品色）。
    const item = parseWishLine("祈愿结果：获得<color=#FF00FF>神秘之物</color>");
    expect(item?.grade).toBe("UNKNOWN");
  });

  it("非祈愿行 → null", () => {
    expect(parseWishLine("制作结果：获得 铁剑")).toBeNull();
    expect(parseWishLine("获得了<color=#D7D7D7>永恒之弓</color>。")).toBeNull();
    expect(parseWishLine("")).toBeNull();
  });

  it("祈愿行但无名称 → null", () => {
    expect(parseWishLine("祈愿结果：获得")).toBeNull();
  });
});
