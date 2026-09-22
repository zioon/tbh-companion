// QA 对抗性独立验证（Edward）—— 不依赖工程师自测，专门攻击实现边界。
//
// 目标：
//   A. 零误判护栏：构造「含冒号 + 获得动词 + 富文本」的非祈愿行，挑战结构兜底窗口。
//   B. 件数抽取（extractCount）与名称抽取（extractNameFromBody）边界。
//   C. PRD §5.6 五条数据完整性不变量（独立构造，非复用工程师用例）。
//   D. bulk / recent 护栏、reset 会话语义。

import { describe, it, expect, vi, afterEach } from "vitest";
import { isWishLine, parseWishLine } from "../../src/core/wishLine";
import { WishTracker } from "../../src/core/wishTracker";
import type { WishLineItem } from "../../src/core/wishLine";
import type { WishGrade } from "../../shared/types";

afterEach(() => {
  vi.useRealTimers();
});

describe("QA-A 零误判护栏：结构兜底误判窗口攻击", () => {
  // 观察（非硬断言）：结构兜底对「未知前缀 + 冒号 + 获得 + 富文本」判 true，
  // 这是架构 §5.3 步骤 3 的**有意设计**（容忍未知语言）。但它构成一个理论误判
  // 窗口：任何形如「<前缀>：获得了<color=…>Y</color>。」的非祈愿行都会被判真。
  // 本用例记录该窗口的存在，供架构取舍；已实测「制作/合成/炼金结果」被排除表拦下。
  it("已知非祈愿结果前缀（制作/合成/炼金）判 false（排除表生效）", () => {
    const excluded = [
      "制作结果：获得了<color=#D7D7D7>永恒之弓</color>。",
      "合成结果：获得了<color=#519FFF>技能书</color>。",
      "炼金结果：获得了<color=#EBBB00>药剂</color>。",
      "装饰结果：获得了<color=#7CE937>挂饰</color>。",
      "雕刻结果：获得了<color=#FB86FF>符石</color>。",
      "铭文结果：获得了<color=#00F6FF>铭文石</color>。",
      "提取结果：获得了<color=#E8695A>精华</color>。",
    ];
    for (const line of excluded) {
      expect(isWishLine(line), `排除表漏判: ${line}`).toBe(false);
    }
  });

  it("已实测且归档有据的非祈愿行判 false（真实文案样本）", () => {
    // 来自 docs/findings/record-log-audit-2026-09-15.md:588 的真实归档样本。
    expect(isWishLine("牧师被击败了。(木乃伊)")).toBe(false);
    expect(isWishLine("通关了关卡 3-9。(73秒)")).toBe(false);
    // 合成行是「消耗X品级,获得Y品级」——用逗号，不带冒号，落入结构兜底也 false。
    expect(isWishLine("消耗稀有品级,获得传说品级")).toBe(false);
    // 普通获得行（无冒号前缀）。
    expect(isWishLine("获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
  });

  it("文档记录：结构兜底对未知前缀「X：获得了<color>Y</color>」判 true（理论误判窗口，已上报）", () => {
    // 该断言**故意固定当前行为**，以便架构组评审时一眼看到窗口确实存在；
    // 若未来收紧为「仅白名单」，此断言应随之翻转为 false。
    const probe = "任务完成：获得了<color=#D7D7D7>永恒之弓</color>。";
    expect(isWishLine(probe)).toBe(true);
  });

  it("确认：zh 普通获得了<color>X</color>（无冒号）判 false", () => {
    expect(isWishLine("获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
  });

  it("制作/合成/炼金结果 即使与祈愿结构完全相同也判 false", () => {
    expect(isWishLine("制作结果：获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
    expect(isWishLine("合成结果：获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
    expect(isWishLine("炼金结果：获得了<color=#D7D7D7>永恒之弓</color>。")).toBe(false);
  });

  it("英雄行 / 通关行 / 空串 / 纯文本 / 空白判 false", () => {
    expect(isWishLine("牧师被击败了。(木乃伊)")).toBe(false);
    expect(isWishLine("通关了关卡 3-9。(73秒)")).toBe(false);
    expect(isWishLine("")).toBe(false);
    expect(isWishLine("   ")).toBe(false);
    expect(isWishLine("这是一段普通文本")).toBe(false);
  });

  it("正例四语言 + 带富文本判 true", () => {
    expect(isWishLine("祈愿结果：获得 神秘手套")).toBe(true);
    expect(isWishLine("Offering result: Obtained X")).toBe(true);
    expect(isWishLine("祈願結果：<color=#7CE937>永恆の弓</color>を獲得")).toBe(true);
    expect(isWishLine("기원 결과：<color=#00F6FF>영원의 활</color> 획득")).toBe(true);
  });
});

describe("QA-B parseWishLine 件数 / 名称抽取边界", () => {
  it("多件 x5。（句号在后）应抽到 5", () => {
    const it0 = parseWishLine("祈愿结果：获得<color=#7CE937>强化石</color> x5。");
    expect(it0?.count).toBe(5);
  });

  it("多件 X 5（大写 X + 空格）应抽到 5", () => {
    const it0 = parseWishLine("祈愿结果：获得<color=#7CE937>强化石</color> X 5。");
    expect(it0?.count).toBe(5);
  });

  it("无颜色行 + 多件：祈愿结果：获得 强化石 x3。", () => {
    const it0 = parseWishLine("祈愿结果：获得 强化石 x3。");
    expect(it0).not.toBeNull();
    expect(it0?.count).toBe(3);
    // 名称抽取：件数后缀应被剥离，不残留在名字里
    expect(it0?.name).toBe("强化石");
    expect(it0?.grade).toBe("UNKNOWN");
  });

  it("名称本身以数字结尾（无 x 前缀）——风险点：可能被误当件数吞掉", () => {
    // 「祈愿结果：获得 纪念币礼盒」——名字尾部无数字，正常。
    const clean = parseWishLine("祈愿结果：获得 纪念币礼盒");
    expect(clean?.name).toBe("纪念币礼盒");
    // 「祈愿结果：获得 物品2024。」——名字尾部 2024 是名称一部分，无 x 后缀，
    // 按 PRD §5.1「无数量则按 1 计」，count 应为 1。
    const numericName = parseWishLine("祈愿结果：获得 物品2024。");
    expect(numericName?.count).toBe(1);
    expect(numericName?.name).toBe("物品2024");
  });

  it("名称含数字但被颜色标签包裹 → 名称保留数字、count 应为 1（无 x 后缀）", () => {
    // 这是本轮独立验证发现的源码 bug（详见报告 Bug#1）：
    // extractCount 先剥掉所有标签再匹配行尾数字，会把**颜色标签内**名称尾部
    // 的数字当成件数。按 PRD §5.1，无 `x`/`X` 后缀即无数量，count 应为 1。
    const it0 = parseWishLine("祈愿结果：获得<color=#D7D7D7>纪念币2024</color>。");
    expect(it0?.name).toBe("纪念币2024");
    expect(it0?.count).toBe(1);
  });

  it("带 x 前缀的多件后缀仍正常解析（不误伤正常路径）", () => {
    const it0 = parseWishLine("祈愿结果：获得<color=#7CE937>强化石</color> x5。");
    expect(it0?.name).toBe("强化石");
    expect(it0?.count).toBe(5);
  });

  it("祈愿行但无名称 → null", () => {
    expect(parseWishLine("祈愿结果：获得")).toBeNull();
    expect(parseWishLine("祈愿结果：")).toBeNull();
  });

  it("件数为 0 或超大数 → 回退 1（不虚增）", () => {
    const zero = parseWishLine("祈愿结果：获得<color=#D7D7D7>物</color> x0。");
    expect(zero?.count).toBe(1);
  });
});

/** 造一条解析结果。 */
function mkItem(name: string, grade: WishGrade = "COMMON", count = 1): WishLineItem {
  return { name, grade, count };
}

describe("QA-C PRD §5.6 五条数据完整性不变量（独立构造）", () => {
  it("不变量1+2：itemCountTotal === Σbreakdown.count === ΣgradeDistribution.count", () => {
    const t = new WishTracker();
    t.feed(mkItem("A", "COMMON", 2), 1000, { raw: "r1" });
    t.feed(mkItem("B", "RARE", 3), 1001, { raw: "r2" });
    t.feed(mkItem("A", "RARE", 1), 1002, { raw: "r3" });
    t.feed(mkItem("C", "UNKNOWN", 4), 1003, { raw: "r4" });
    const s = t.getStats(0);
    const sumBreakdown = s.breakdown.reduce((a, r) => a + r.count, 0);
    const sumGrade = s.gradeDistribution.reduce((a, r) => a + r.count, 0);
    expect(sumBreakdown).toBe(s.itemCountTotal);
    expect(sumGrade).toBe(s.itemCountTotal);
    expect(s.itemCountTotal).toBe(10);
    // offering 独立维度：4 次事件
    expect(s.offeringCountTotal).toBe(4);
  });

  it("不变量3：itemCountSession ≤ itemCountTotal 且 offeringCountSession ≤ offeringCountTotal", () => {
    const t = new WishTracker();
    t.feed(mkItem("A", "COMMON", 5), 1000, { raw: "r1" });
    const s = t.getStats(0);
    expect(s.itemCountSession).toBeLessThanOrEqual(s.itemCountTotal);
    expect(s.offeringCountSession).toBeLessThanOrEqual(s.offeringCountTotal);
  });

  it("不变量4：连续 K 次祈愿 → offering 增量 === K，item 增量 === Σcount", () => {
    const t = new WishTracker();
    const before = t.getStats(0);
    const counts = [1, 3, 2, 5, 1];
    for (let i = 0; i < counts.length; i++) {
      t.feed(mkItem(`N${i}`, "COMMON", counts[i]), 1000 + i, { raw: "r" });
    }
    const after = t.getStats(0);
    expect(after.offeringCountTotal - before.offeringCountTotal).toBe(counts.length);
    expect(after.itemCountTotal - before.itemCountTotal).toBe(counts.reduce((a, b) => a + b, 0));
  });

  it("不变量5：reset() 后所有 *Session 归零、所有累计不变", () => {
    const t = new WishTracker();
    t.feed(mkItem("A", "COMMON", 3), 1000, { raw: "r1" });
    t.feed(mkItem("B", "RARE", 2), 1001, { raw: "r2" });
    const before = t.getStats(0);
    t.reset();
    const after = t.getStats(0);
    expect(after.offeringCountSession).toBe(0);
    expect(after.itemCountSession).toBe(0);
    expect(after.offeringCountTotal).toBe(before.offeringCountTotal);
    expect(after.itemCountTotal).toBe(before.itemCountTotal);
    expect(after.breakdown).toEqual(before.breakdown);
  });

  it("itemsPerOffering 在 0 次时返回 0（不 NaN）", () => {
    const t = new WishTracker();
    const s = t.getStats(0);
    expect(s.itemsPerOffering).toBe(0);
    expect(Number.isNaN(s.itemsPerOffering)).toBe(false);
  });
});

describe("QA-D bulk / recent 护栏与去重语义", () => {
  it("bulk + 非 bulk 混合：recent 只数非 bulk", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    for (let i = 0; i < 200; i++) t.feed(mkItem("存量", "COMMON"), now, { raw: "b", bulk: true });
    t.feed(mkItem("实时", "RARE", 3), now, { raw: "r", bulk: false });
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(201);
    // recent 只有 1 条非 bulk，item 3 件 → 分母下限 300s
    // offering recent = 1/(300/3600) = 12/h
    expect(s.offeringRecentPerHour).toBeCloseTo(12, 6);
    expect(s.itemRecentPerHour).toBeCloseTo(3 * 12, 6);
  });

  it("bulk 行计入累计/会话/历史，但不进滚动窗", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    t.feed(mkItem("存量", "COMMON", 4), now, { raw: "b", bulk: true });
    const s = t.getStats(0);
    expect(s.itemCountTotal).toBe(4);
    expect(s.itemCountSession).toBe(4);
    expect(s.history[0].bulk).toBe(true);
    expect(s.offeringRecentPerHour).toBe(0);
  });

  it("share 分母恒为 itemCount（不是 offeringCount）", () => {
    const t = new WishTracker();
    t.feed(mkItem("A", "COMMON", 3), 1000, { raw: "r1" });
    t.feed(mkItem("B", "RARE", 1), 1001, { raw: "r2" });
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(2);
    expect(s.itemCountTotal).toBe(4);
    expect(s.breakdown.find((r) => r.name === "A")!.share).toBeCloseTo(3 / 4, 10);
    const gradeComm = s.gradeDistribution.find((r) => r.grade === "COMMON")!;
    expect(gradeComm.share).toBeCloseTo(3 / 4, 10);
  });

  it("排序稳定：count 降序、同值 name 升序（多语言/Unicode 名）", () => {
    const t = new WishTracker();
    t.feed(mkItem("zeta", "COMMON", 2), 1000, { raw: "r1" });
    t.feed(mkItem("alpha", "COMMON", 2), 1001, { raw: "r2" });
    t.feed(mkItem("中文名", "COMMON", 2), 1002, { raw: "r3" });
    const names = t.getStats(0).breakdown.map((r) => r.name);
    // count 全 2 → 按 name 升序（localeCompare）
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

describe("QA-E 会话语义与其他边界", () => {
  it("reset() 后 sessionEpoch 递增（会话边界）", () => {
    const t = new WishTracker();
    const e0 = t.getSessionEpoch();
    t.reset();
    expect(t.getSessionEpoch()).toBe(e0 + 1);
  });

  it("captureSnapshot → applySnapshot 后累计与品质守恒", () => {
    const src = new WishTracker();
    src.feed(mkItem("A", "COMMON", 2), 1000, { raw: "r1" });
    src.feed(mkItem("B", "CELESTIAL", 3), 1001, { raw: "r2" });
    const dst = new WishTracker();
    dst.applySnapshot(src.captureSnapshot());
    const s = dst.getStats(0);
    const sumGrade = s.gradeDistribution.reduce((a, r) => a + r.count, 0);
    const sumBd = s.breakdown.reduce((a, r) => a + r.count, 0);
    expect(sumGrade).toBe(s.itemCountTotal);
    expect(sumBd).toBe(s.itemCountTotal);
    expect(s.itemCountTotal).toBe(5);
  });

  it("空 tracker getStats 所有速率有限且非 NaN", () => {
    const s = new WishTracker().getStats(0);
    for (const v of [
      s.itemsPerOffering,
      s.offeringPerHour,
      s.itemPerHour,
      s.offeringRecentPerHour,
      s.itemRecentPerHour,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
