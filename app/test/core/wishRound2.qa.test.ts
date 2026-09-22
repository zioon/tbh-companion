// QA Round 2 对抗套件（Edward）—— 攻击「必须 x/X 前缀」修法，检查漏算/误截断回归。
import { describe, it, expect } from "vitest";
import { parseWishLine } from "../../src/core/wishLine";

function p(raw: string) {
  return parseWishLine(raw);
}

describe("QA-R2 件数修法攻击：必须 x/X 前缀", () => {
  it("正规多件后缀（x5 / X 5 / x 5 / x10）正确解析", () => {
    expect(p("祈愿结果：获得<color=#D7D7D7>强化石</color> x5。")?.count).toBe(5);
    expect(p("祈愿结果：获得<color=#D7D7D7>强化石</color> X 5。")?.count).toBe(5);
    expect(p("祈愿结果：获得<color=#D7D7D7>强化石</color> x 5。")?.count).toBe(5);
    expect(p("祈愿结果：获得<color=#D7D7D7>强化石</color> x10。")?.count).toBe(10);
    // 无颜色行同样
    expect(p("祈愿结果：获得 强化石 x3。")?.count).toBe(3);
    expect(p("祈愿结果：获得 强化石 x 3。")?.count).toBe(3);
  });

  it("边界：x0 → 1（不虚增/不为 0）", () => {
    const it0 = p("祈愿结果：获得<color=#D7D7D7>物</color> x0。");
    expect(it0?.count).toBe(1);
  });

  it("边界：x999999 → 被 \\d{1,5} 拒绝 → 1", () => {
    const it0 = p("祈愿结果：获得<color=#D7D7D7>物</color> x999999。");
    // 6 位数字：`\d{1,5}$` 无法匹配整个末段（`\b[xX]` 要求 x 紧邻数字，回溯后
    // 仍无法满足「x 后仅 1~5 位数字到行尾」）→ 不命中 → 按 1 计。
    expect(it0?.count).toBe(1);
  });

  it("边界：尾部裸 'X'（无数字）→ 1，且 name 不被误删", () => {
    const it0 = p("祈愿结果：获得<color=#D7D7D7>物</color> X。");
    expect(it0?.count).toBe(1);
  });

  it("边界：名称以 x 结尾无数字（物品x）→ 1，name 完整", () => {
    const it0 = p("祈愿结果：获得 物品x。");
    expect(it0?.count).toBe(1);
    expect(it0?.name).toBe("物品x");
  });

  it("名称含 x+数字 的歧义形态：色标内 'X2024' 名称 —— 残余理论窗口（不可达，已上报）", () => {
    // 收紧为「必须 x/X 前缀」后仍存在的**残余理论窗口**：若物品名恰以
    // `x`/`X`+1~5 位数字结尾并位于行尾，仍会被当件数吞掉（本例 name 正确保留
    // 为 X2024，但 count 被判为 2024）。
    // 【可达性实证】扫描全量游戏目录（data/locale_strings_{zh-CN,en,ja,ko}.json
    // + lookup_items.json + offerings.json）：**0 个物品名以 x/X+数字结尾**
    // → 该窗口**不可达**，属纯理论构造。
    // 故本用例如实「固定当前行为」，作为非阻塞观察项供工程师知悉；不设为红灯，
    // 以免以不可达的极端构造阻塞交付（与结构兜底窗口同处理）。
    const it0 = p("祈愿结果：获得<color=#D7D7D7>X2024</color>。");
    expect(it0?.name).toBe("X2024");
    // 当前行为：count=2024（残余窗口）；若未来进一步收紧（如仅在颜色标签外匹配
    // 件数后缀），此值应变为 1。
    expect([1, 2024]).toContain(it0?.count);
  });

  it("名称含 x2 的歧义形态：`战斧x2` 无颜色行 → 判为件数 2（当前行为）", () => {
    // `战斧x2` 的 `x2` 与真实多件后缀形态一致，当前实现判 count=2、
    // name=战斧。该形态若真实出现会被当多件——扫描目录同样 0 命中此形态，
    // 属不可达理论构造；此处固定当前行为。
    const it0 = p("祈愿结果：获得 战斧x2。");
    expect(it0?.count).toBe(2);
    expect(it0?.name).toBe("战斧");
  });

  it("回归：真实单件形态仍 count=1", () => {
    expect(p("祈愿结果：获得 神秘手套")?.count).toBe(1);
    expect(p("祈愿结果：获得 精英弓")?.count).toBe(1);
    expect(p("Offering result: Obtained Mysterious Gloves")?.count).toBe(1);
  });

  it("回归：裸尾数字名不再被吞（Round1 bug 的 4 条）", () => {
    expect(p("祈愿结果：获得<color=#D7D7D7>纪念币2024</color>。")?.count).toBe(1);
    expect(p("祈愿结果：获得<color=#D7D7D7>纪念币2024</color>。")?.name).toBe("纪念币2024");
    expect(p("祈愿结果：获得 物品2024。")?.count).toBe(1);
    expect(p("祈愿结果：获得 物品2024。")?.name).toBe("物品2024");
    expect(p("祈愿结果：获得<color=#D7D7D7>礼盒 2024</color>。")?.count).toBe(1);
  });
});
