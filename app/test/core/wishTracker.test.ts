// WishTracker 单测。
//
// 覆盖 PRD §5.6 五条不变量，外加任务要求：
//   - itemsPerOffering 不 NaN（0 次祈愿时返回 0）
//   - 滚动率钳制（分母下限 RECENT_MIN_WINDOW_SEC=300s）
//   - bulk 行不进滚动窗
//   - breakdown 排序稳定（count 降序 → name 升序）
//   - snapshot 往返（capture → apply 后口径一致）
//   - UNKNOWN 不猜测（无颜色 / 非法品质一律归 UNKNOWN）
//
// PRD §5.6 五条不变量（原文语义）：
//   (1) offeringCountTotal 与 itemCountTotal 相互独立：一条祈愿行 offering +1，
//       item += 行内件数；单件行两者同步 +1。
//   (2) gradeDistribution 各桶 count 之和 === itemCountTotal（分母口径一致）。
//   (3) breakdown 各 name 的 count 之和 === itemCountTotal。
//   (4) 会话重置后 *Session 归零、累计不变、sessionEpoch 递增。
//   (5) 会话速率分母 >= MIN_RATE_WINDOW_SEC，且 elapsed 极小时速率不发散。

import { describe, expect, it, vi, afterEach } from "vitest";

import { WishTracker } from "../../src/core/wishTracker";
import type { WishLineItem } from "../../src/core/wishLine";
import type { WishCoinAttribution, WishGrade } from "../../shared/types";

/** 构造一个解析结果（默认单件）。 */
function item(name: string, grade: WishGrade = "COMMON", count = 1): WishLineItem {
  return { name, grade, count };
}

/** 摄入一条并在给定 wallTime。 */
function feed(
  tracker: WishTracker,
  it0: WishLineItem,
  wallTime: number,
  opts: { gameTime?: string; raw?: string; bulk?: boolean } = {},
): boolean {
  return tracker.feed(it0, wallTime, {
    raw: opts.raw ?? `祈愿结果：获得 ${it0.name}。`,
    gameTime: opts.gameTime,
    bulk: opts.bulk,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WishTracker — 基本累计 / 双计数（§5.6 不变量 1）", () => {
  it("空 tracker：全 0，itemsPerOffering = 0（不 NaN）", () => {
    const t = new WishTracker();
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(0);
    expect(s.itemCountTotal).toBe(0);
    expect(s.itemsPerOffering).toBe(0);
    expect(Number.isNaN(s.itemsPerOffering)).toBe(false);
    expect(s.offeringCountSession).toBe(0);
    expect(s.itemCountSession).toBe(0);
    expect(s.lastWishWallTime).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.breakdown).toEqual([]);
  });

  it("单件行：offering 与 item 同步 +1", () => {
    const t = new WishTracker();
    feed(t, item("永恒之弓", "COMMON"), 1000);
    feed(t, item("暗影法典", "RARE"), 1001);
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(2);
    expect(s.itemCountTotal).toBe(2);
    expect(s.itemsPerOffering).toBe(1);
  });

  it("多件行：offering 只 +1，item += 件数（双计数核心）", () => {
    const t = new WishTracker();
    feed(t, item("祈愿碎片", "COMMON", 5), 1000);
    feed(t, item("祈愿碎片", "COMMON", 3), 1001);
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(2);
    expect(s.itemCountTotal).toBe(8);
    expect(s.itemsPerOffering).toBe(4);
  });

  it("count < 1 或缺省时按 1 计", () => {
    const t = new WishTracker();
    t.feed({ name: "神秘手套", grade: "UNKNOWN" } as WishLineItem, 1000, {
      raw: "祈愿结果：获得 神秘手套。",
    });
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(1);
    expect(s.itemCountTotal).toBe(1);
  });

  it("空名 / 全空白名被拒收（不计入）", () => {
    const t = new WishTracker();
    expect(t.feed(item("", "COMMON"), 1000, { raw: "x" })).toBe(false);
    expect(t.feed(item("   ", "COMMON"), 1001, { raw: "y" })).toBe(false);
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(0);
    expect(s.itemCountTotal).toBe(0);
  });

  it("名首尾空白被裁剪", () => {
    const t = new WishTracker();
    feed(t, item("  永恒之弓  ", "COMMON"), 1000);
    const s = t.getStats(0);
    expect(s.breakdown).toHaveLength(1);
    expect(s.breakdown[0].name).toBe("永恒之弓");
  });
});

describe("WishTracker — gradeDistribution / breakdown 口径（§5.6 不变量 2、3）", () => {
  it("gradeDistribution 恒为 11 桶且顺序固定（UNKNOWN 置末尾）", () => {
    const t = new WishTracker();
    const s = t.getStats(0);
    expect(s.gradeDistribution.map((r) => r.grade)).toEqual([
      "COMMON",
      "UNCOMMON",
      "RARE",
      "LEGENDARY",
      "IMMORTAL",
      "ARCANA",
      "CELESTIAL",
      "BEYOND",
      "DIVINE",
      "COSMIC",
      "UNKNOWN",
    ]);
    expect(s.gradeDistribution).toHaveLength(11);
  });

  it("新增桶 BEYOND / DIVINE / COSMIC 可被计入", () => {
    const t = new WishTracker();
    feed(t, item("A", "BEYOND", 2), 1000);
    feed(t, item("B", "DIVINE", 1), 1001);
    feed(t, item("C", "COSMIC", 3), 1002);
    const s = t.getStats(0);
    expect(s.gradeDistribution.find((r) => r.grade === "BEYOND")!.count).toBe(2);
    expect(s.gradeDistribution.find((r) => r.grade === "DIVINE")!.count).toBe(1);
    expect(s.gradeDistribution.find((r) => r.grade === "COSMIC")!.count).toBe(3);
  });

  it("不变量 2：gradeDistribution 各桶件数之和 === itemCountTotal", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 2), 1000);
    feed(t, item("B", "RARE", 3), 1001);
    feed(t, item("C", "UNKNOWN", 1), 1002);
    feed(t, item("D", "COMMON", 4), 1003);
    const s = t.getStats(0);
    const sum = s.gradeDistribution.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.itemCountTotal);
    expect(s.itemCountTotal).toBe(10);
  });

  it("不变量 3：breakdown 各 name 件数之和 === itemCountTotal", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 2), 1000);
    feed(t, item("B", "RARE", 3), 1001);
    feed(t, item("A", "COMMON", 4), 1002);
    const s = t.getStats(0);
    const sum = s.breakdown.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.itemCountTotal);
    expect(s.itemCountTotal).toBe(9);
  });

  it("breakdown share 分母为 itemCountTotal（不是 offeringCount）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 3), 1000);
    feed(t, item("B", "RARE", 1), 1001);
    const s = t.getStats(0);
    // itemCountTotal=4, offering=2
    expect(s.offeringCountTotal).toBe(2);
    expect(s.itemCountTotal).toBe(4);
    const a = s.breakdown.find((r) => r.name === "A")!;
    expect(a.share).toBeCloseTo(3 / 4, 10);
    const b = s.breakdown.find((r) => r.name === "B")!;
    expect(b.share).toBeCloseTo(1 / 4, 10);
  });

  it("gradeDistribution share 分母同为 itemCountTotal", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 3), 1000);
    feed(t, item("B", "RARE", 1), 1001);
    const s = t.getStats(0);
    const common = s.gradeDistribution.find((r) => r.grade === "COMMON")!;
    expect(common.count).toBe(3);
    expect(common.share).toBeCloseTo(3 / 4, 10);
  });

  it("空 tracker 时各 share = 0（不 NaN）", () => {
    const t = new WishTracker();
    const s = t.getStats(0);
    for (const r of s.gradeDistribution) {
      expect(r.count).toBe(0);
      expect(r.share).toBe(0);
      expect(Number.isNaN(r.share)).toBe(false);
    }
  });
});

describe("WishTracker — UNKNOWN 不猜测", () => {
  it("非法 grade 值一律归 UNKNOWN", () => {
    const t = new WishTracker();
    t.feed({ name: "怪东西", grade: "NOT_A_GRADE" as WishGrade, count: 1 }, 1000, {
      raw: "祈愿结果：获得 怪东西。",
    });
    const s = t.getStats(0);
    const unknown = s.gradeDistribution.find((r) => r.grade === "UNKNOWN")!;
    expect(unknown.count).toBe(1);
    expect(s.breakdown[0].grade).toBe("UNKNOWN");
  });

  it("无 grade 字段归 UNKNOWN", () => {
    const t = new WishTracker();
    t.feed({ name: "无品质物", count: 2 } as WishLineItem, 1000, {
      raw: "祈愿结果：获得 无品质物 x2。",
    });
    const s = t.getStats(0);
    const unknown = s.gradeDistribution.find((r) => r.grade === "UNKNOWN")!;
    expect(unknown.count).toBe(2);
  });

  it("同名多品质：dominantGrade 取最高频，并列取 GRADE_ORDER 靠前者", () => {
    const t = new WishTracker();
    // A 出现 COMMON×3、RARE×1 → 主品质 COMMON
    feed(t, item("A", "COMMON", 3), 1000);
    feed(t, item("A", "RARE", 1), 1001);
    const s = t.getStats(0);
    const a = s.breakdown.find((r) => r.name === "A")!;
    expect(a.grade).toBe("COMMON");
    expect(a.count).toBe(4);
  });
});

describe("WishTracker — breakdown 排序稳定", () => {
  it("count 降序；同 count 时 name 升序", () => {
    const t = new WishTracker();
    feed(t, item("C", "COMMON", 3), 1000);
    feed(t, item("A", "COMMON", 3), 1001);
    feed(t, item("B", "COMMON", 5), 1002);
    feed(t, item("D", "COMMON", 1), 1003);
    const s = t.getStats(0);
    expect(s.breakdown.map((r) => r.name)).toEqual(["B", "A", "C", "D"]);
    expect(s.breakdown.map((r) => r.count)).toEqual([5, 3, 3, 1]);
  });

  it("多次 getStats 排序结果稳定（缓存不破坏顺序）", () => {
    const t = new WishTracker();
    feed(t, item("C", "COMMON", 2), 1000);
    feed(t, item("A", "COMMON", 2), 1001);
    const first = t.getStats(0).breakdown.map((r) => r.name);
    const second = t.getStats(0).breakdown.map((r) => r.name);
    expect(second).toEqual(first);
    expect(first).toEqual(["A", "C"]);
  });
});

describe("WishTracker — 历史窗口", () => {
  it("history 倒序（最新在前）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON"), 1000);
    feed(t, item("B", "RARE"), 1001);
    feed(t, item("C", "LEGENDARY"), 1002);
    const s = t.getStats(0);
    expect(s.history.map((e) => e.name)).toEqual(["C", "B", "A"]);
  });

  it("history 上限 HISTORY_VISIBLE=50", () => {
    const t = new WishTracker();
    for (let i = 0; i < 80; i++) {
      feed(t, item(`N${i}`, "COMMON"), 1000 + i);
    }
    const s = t.getStats(0);
    expect(s.history).toHaveLength(50);
    // 最新在前的应是 N79
    expect(s.history[0].name).toBe("N79");
  });

  it("lastWishWallTime 取最大 wallTime", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON"), 1005);
    feed(t, item("B", "COMMON"), 1001);
    feed(t, item("C", "COMMON"), 1010);
    expect(t.getStats(0).lastWishWallTime).toBe(1010);
  });

  it("bulk 行进入累计与历史，但标记 bulk=true", () => {
    const t = new WishTracker();
    feed(t, item("存量物", "COMMON", 2), 1000, { bulk: true });
    const s = t.getStats(0);
    expect(s.itemCountTotal).toBe(2);
    expect(s.history[0].bulk).toBe(true);
  });

  it("fitHistory 返回全量（不受 VISIBLE 限制）", () => {
    const t = new WishTracker();
    for (let i = 0; i < 80; i++) {
      feed(t, item(`N${i}`, "COMMON"), 1000 + i);
    }
    expect(t.fitHistory()).toHaveLength(80);
  });
});

describe("WishTracker — bulk 护栏（不进滚动窗）", () => {
  it("bulk 行不计入 *RecentPerHour 滚动窗", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;

    const t = new WishTracker();
    // 1000 条 bulk（会话存量回灌），外加 1 条实时。
    for (let i = 0; i < 1000; i++) {
      feed(t, item("存量", "COMMON"), now, { bulk: true });
    }
    feed(t, item("实时", "RARE"), now, { bulk: false });

    const s = t.getStats(0);
    // 累计含 bulk
    expect(s.offeringCountTotal).toBe(1001);
    // 滚动窗只含那 1 条实时；分母下限 300s → 1/(300/3600)=12/h
    expect(s.offeringRecentPerHour).toBeCloseTo(12, 6);
    expect(s.itemRecentPerHour).toBeCloseTo(12, 6);
  });

  it("纯 bulk 时滚动率为 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    for (let i = 0; i < 50; i++) {
      feed(t, item("存量", "COMMON"), now, { bulk: true });
    }
    const s = t.getStats(0);
    expect(s.offeringRecentPerHour).toBe(0);
    expect(s.itemRecentPerHour).toBe(0);
  });

  it("超出 1 小时的旧实时行被剔除出滚动窗", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    // 2 小时前的实时行 + 当前实时行
    feed(t, item("旧", "COMMON"), now - 7200, { bulk: false });
    feed(t, item("新", "COMMON"), now, { bulk: false });
    const s = t.getStats(0);
    // 滚动窗只应剩 1 条（旧行超窗）
    expect(s.offeringRecentPerHour).toBeCloseTo(12, 6);
  });
});

describe("WishTracker — 速率钳制（§5.6 不变量 5）", () => {
  it("会话速率分母下限 MIN_RATE_WINDOW_SEC=60s（刚摄入不发散）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 60), now);
    const s = t.getStats(0);
    // 分母 = 60s = 1/60 h → 60 件 / (1/60) = 3600/h（而非无穷）
    expect(Number.isFinite(s.itemPerHour)).toBe(true);
    expect(s.itemPerHour).toBeCloseTo(3600, 4);
    // 会话耗时几乎为 0，用 60s 下限
    expect(s.itemPerHour).toBeLessThanOrEqual(3600 + 1e-6);
  });

  it("滚动率分母下限 RECENT_MIN_WINDOW_SEC=300s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 25), now, { bulk: false });
    const s = t.getStats(0);
    // 25 件 ÷ (300/3600 h) = 300/h
    expect(s.itemRecentPerHour).toBeCloseTo(300, 6);
  });

  it("速率恒 >= 0 且有限", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON"), 1000);
    const s = t.getStats(0);
    for (const v of [
      s.offeringPerHour,
      s.itemPerHour,
      s.offeringRecentPerHour,
      s.itemRecentPerHour,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("elapsedSeconds 参数不影响内部锚点（忽略外部 elapsed）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON"), Date.now() / 1000);
    const a = t.getStats(0);
    const b = t.getStats(999999);
    expect(b.itemPerHour).toBeCloseTo(a.itemPerHour, 10);
  });
});

describe("WishTracker — 会话重置（§5.6 不变量 4）", () => {
  it("reset 后 *Session 归零、累计不变、epoch 递增", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 3), 1000);
    feed(t, item("B", "RARE", 2), 1001);
    const before = t.getStats(0);
    expect(before.offeringCountSession).toBe(2);
    expect(before.itemCountSession).toBe(5);

    const epoch0 = t.getSessionEpoch();
    t.reset();
    expect(t.getSessionEpoch()).toBe(epoch0 + 1);

    const after = t.getStats(0);
    expect(after.offeringCountTotal).toBe(before.offeringCountTotal);
    expect(after.itemCountTotal).toBe(before.itemCountTotal);
    expect(after.offeringCountSession).toBe(0);
    expect(after.itemCountSession).toBe(0);
  });

  it("reset 后新摄入只计入 session（累计叠加）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 3), 1000);
    t.reset();
    feed(t, item("B", "RARE", 4), 2000);
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(2);
    expect(s.itemCountTotal).toBe(7);
    expect(s.offeringCountSession).toBe(1);
    expect(s.itemCountSession).toBe(4);
  });

  it("reset 清空滚动窗（旧实时行不再计入 RecentPerHour）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000 * 1000));
    const now = Date.now() / 1000;
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 10), now, { bulk: false });
    expect(t.getStats(0).itemRecentPerHour).toBeGreaterThan(0);
    t.reset();
    expect(t.getStats(0).itemRecentPerHour).toBe(0);
  });

  it("reset 保留历史与 breakdown（累计口径不清）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 2), 1000);
    t.reset();
    const s = t.getStats(0);
    expect(s.breakdown).toHaveLength(1);
    expect(s.history).toHaveLength(1);
    expect(s.itemCountTotal).toBe(2);
  });
});

describe("WishTracker — snapshot 往返", () => {
  it("capture → apply 后累计 / breakdown / 品质分布一致", () => {
    const src = new WishTracker();
    feed(src, item("A", "COMMON", 2), 1000);
    feed(src, item("B", "RARE", 3), 1001);
    feed(src, item("A", "COMMON", 1), 1002);
    const snap = src.captureSnapshot();

    const dst = new WishTracker();
    dst.applySnapshot(snap);
    const s = dst.getStats(0);
    expect(s.offeringCountTotal).toBe(3);
    expect(s.itemCountTotal).toBe(6);
    expect(s.breakdown.map((r) => [r.name, r.count, r.grade])).toEqual(
      src.getStats(0).breakdown.map((r) => [r.name, r.count, r.grade]),
    );
    for (const grade of s.gradeDistribution) {
      const other = src.getStats(0).gradeDistribution.find((r) => r.grade === grade.grade)!;
      expect(grade.count).toBe(other.count);
    }
  });

  it("往返后 gradeDistribution 之和仍 === itemCountTotal（不变量 2）", () => {
    const src = new WishTracker();
    feed(src, item("A", "COMMON", 2), 1000);
    feed(src, item("B", "CELESTIAL", 5), 1001);
    const dst = new WishTracker();
    dst.applySnapshot(src.captureSnapshot());
    const s = dst.getStats(0);
    const sum = s.gradeDistribution.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.itemCountTotal);
  });

  it("apply 后计数全部计入会话（基线置 0）", () => {
    const src = new WishTracker();
    feed(src, item("A", "COMMON", 4), 1000);
    const dst = new WishTracker();
    dst.applySnapshot(src.captureSnapshot());
    const s = dst.getStats(0);
    expect(s.offeringCountSession).toBe(s.offeringCountTotal);
    expect(s.itemCountSession).toBe(s.itemCountTotal);
  });

  it("apply(null / undefined) 为无操作", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON"), 1000);
    t.applySnapshot(null);
    t.applySnapshot(undefined);
    const s = t.getStats(0);
    expect(s.offeringCountTotal).toBe(1);
    expect(s.itemCountTotal).toBe(1);
    expect(s.breakdown).toHaveLength(1);
  });

  it("captureSnapshot 的 history 为副本（改动快照不影响 tracker）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON"), 1000);
    const snap = t.captureSnapshot();
    snap.history[0].name = "MUTATED";
    // tracker 内部历史不受快照改动影响
    expect(t.fitHistory()[0].name).toBe("A");
  });

  it("applySnapshot 复制入参 history（改动入参不影响 tracker）", () => {
    const src = new WishTracker();
    feed(src, item("A", "COMMON"), 1000);
    const snap = src.captureSnapshot();
    const dst = new WishTracker();
    dst.applySnapshot(snap);
    snap.history[0].name = "MUTATED";
    expect(dst.fitHistory()[0].name).toBe("A");
  });
  it("apply 非法字段容错（负数 / NaN 计数归 0）", () => {
    const t = new WishTracker();
    t.applySnapshot({
      offeringCount: -5,
      itemCount: Number.NaN,
      countsByName: {
        Bad: -3,
        Good: 2,
        AlsoBad: Number.NaN,
      } as Record<string, number>,
      gradeByName: { Good: "RARE", BadGrade: "NOPE" as WishGrade },
      history: [],
    });
    const s = t.getStats(0);
    // 累计 itemCount 以持久化字段为准（NaN → 0）；负数 offering 归 0。
    expect(s.offeringCountTotal).toBe(0);
    expect(s.itemCountTotal).toBe(0);
    // 名称聚合：仅保留正数项；负数 / NaN 项被剔除。
    expect(s.breakdown.map((r) => r.name)).toEqual(["Good"]);
    expect(s.breakdown[0].count).toBe(2);
    expect(s.breakdown[0].grade).toBe("RARE");
    // 非法 grade 值不进入品质桶（Good 由 gradeByName 决定为 RARE）。
    const rare = s.gradeDistribution.find((r) => r.grade === "RARE")!;
    expect(rare.count).toBe(2);
    const unknown = s.gradeDistribution.find((r) => r.grade === "UNKNOWN")!;
    expect(unknown.count).toBe(0);
  });

  it("apply 无 gradeByName 时名称归 UNKNOWN（不猜测）", () => {
    const t = new WishTracker();
    t.applySnapshot({
      offeringCount: 1,
      itemCount: 2,
      countsByName: { Ghost: 2 },
      gradeByName: {},
      history: [],
    });
    const s = t.getStats(0);
    expect(s.breakdown[0].grade).toBe("UNKNOWN");
    const unknown = s.gradeDistribution.find((r) => r.grade === "UNKNOWN")!;
    expect(unknown.count).toBe(2);
  });

  it("apply 恢复后滚动窗重建（只含非 bulk 行）", () => {
    const src = new WishTracker();
    const now = Date.now() / 1000;
    feed(src, item("实时", "COMMON", 5), now, { bulk: false });
    feed(src, item("存量", "COMMON", 100), now, { bulk: true });
    const dst = new WishTracker();
    dst.applySnapshot(src.captureSnapshot());
    const s = dst.getStats(0);
    // 累计含 bulk=105
    expect(s.itemCountTotal).toBe(105);
    // 滚动窗只含实时 5 件 → 5/(300/3600)=60/h
    expect(s.itemRecentPerHour).toBeCloseTo(60, 6);
  });

  it("apply 历史超 HISTORY_LIMIT 被裁剪", () => {
    const history = [];
    for (let i = 0; i < 600; i++) {
      history.push({
        wallTime: 1000 + i,
        name: `N${i}`,
        grade: "COMMON" as WishGrade,
        count: 1,
        raw: "x",
      });
    }
    const t = new WishTracker();
    t.applySnapshot({
      offeringCount: 600,
      itemCount: 600,
      countsByName: {},
      gradeByName: {},
      history,
    });
    expect(t.fitHistory()).toHaveLength(500);
  });

  it("capture 快照含计数/基线字段（可再次 apply）", () => {
    const t = new WishTracker();
    feed(t, item("A", "COMMON", 2), Date.now() / 1000);
    const snap = t.captureSnapshot();
    expect(snap.offeringCount).toBe(1);
    expect(snap.itemCount).toBe(2);
    expect(snap.countsByName).toMatchObject({ A: 2 });
    expect(snap.gradeByName.A).toBe("COMMON");
    expect(snap.history).toHaveLength(1);
    expect(typeof snap.sessionWishStart === "number" || snap.sessionWishStart === null).toBe(true);
  });

  it("apply 后 sessionEpoch 递增（会话边界）", () => {
    const t = new WishTracker();
    const e0 = t.getSessionEpoch();
    t.applySnapshot(new WishTracker().captureSnapshot());
    expect(t.getSessionEpoch()).toBe(e0 + 1);
  });
});

describe("WishTracker — readerRequired / 边界字段", () => {
  it("readerRequired 恒为 true（数据源是 acquire 管道）", () => {
    expect(new WishTracker().getStats(0).readerRequired).toBe(true);
  });

  it("gameOfferingItemCount 恒为 null（P1-3 未接入）", () => {
    expect(new WishTracker().getStats(0).gameOfferingItemCount).toBeNull();
  });
});

describe("WishTracker — 硬币归因（Wish v2）", () => {
  const observed = (coinKey: number): WishCoinAttribution => ({
    confidence: "observed",
    coinKey,
    candidates: [],
    basis: `diff:${coinKey}`,
  });

  it("空 tracker：recentResults / coinGroups 为空，unattributed 空组", () => {
    const s = new WishTracker().getStats(0);
    expect(s.recentResults).toEqual([]);
    expect(s.coinGroups).toEqual([]);
    expect(s.unattributed).toEqual({ items: [] });
  });

  it("feed 第 4 参写入 entry.coin；getStats 派生 recentResults（含 coin）", () => {
    const t = new WishTracker();
    t.feed(item("木盾", "COMMON"), 1000, { raw: "祈愿结果：获得 木盾。" }, observed(160001));
    const s = t.getStats(0);
    expect(s.recentResults).toHaveLength(1);
    expect(s.recentResults[0]!.coin.confidence).toBe("observed");
    expect(s.recentResults[0]!.coin.coinKey).toBe(160001);
    expect(s.history[0]!.coin?.coinKey).toBe(160001);
  });

  it("缺省归因（3 参调用）→ entry.coin undefined，recentResults 归 unknown", () => {
    const t = new WishTracker();
    feed(t, item("铁剑", "RARE"), 1000);
    const s = t.getStats(0);
    expect(s.history[0]!.coin).toBeUndefined();
    expect(s.recentResults[0]!.coin.confidence).toBe("unknown");
    expect(s.recentResults[0]!.coin.coinKey).toBeNull();
  });

  it("recentResults 倒序（最新在前）且上限 WISH_RECENT_VISIBLE=20", () => {
    const t = new WishTracker();
    for (let i = 0; i < 45; i++) {
      feed(t, item(`N${i}`, "COMMON"), 1000 + i);
    }
    const s = t.getStats(0);
    expect(s.recentResults).toHaveLength(20);
    expect(s.recentResults[0]!.name).toBe("N44");
    expect(s.recentResults[19]!.name).toBe("N25");
  });

  it("coinGroups 按 observed 归因分组；unattributed 收未知条目", () => {
    const t = new WishTracker();
    t.feed(item("木盾", "COMMON", 2), 1000, { raw: "a" }, observed(160001));
    t.feed(item("铁剑", "RARE"), 1001, { raw: "b" }, observed(160003));
    t.feed(item("幽灵", "UNKNOWN"), 1002, { raw: "c" });
    const s = t.getStats(0);
    expect(s.coinGroups.map((g) => g.coinKey)).toEqual([160001, 160003]);
    expect(s.coinGroups.find((g) => g.coinKey === 160001)!.itemCount).toBe(2);
    expect(s.unattributed.items.map((i) => i.name)).toEqual(["幽灵"]);
  });

  it("setLookupDeps 注入 coinMeta 后 coinGroups 带硬币名与品质", () => {
    const t = new WishTracker();
    t.setLookupDeps({
      coinMeta: (coinKey) =>
        coinKey === 160001 ? { name: "Kingdom 1st", grade: "COMMON" } : undefined,
    });
    t.feed(item("木盾", "COMMON"), 1000, { raw: "a" }, observed(160001));
    const s = t.getStats(0);
    expect(s.coinGroups[0]!.coinName).toBe("Kingdom 1st");
    expect(s.coinGroups[0]!.grade).toBe("COMMON");
  });

  it("setLookupDeps / getLookupDeps 往返一致", () => {
    const t = new WishTracker();
    const fn = (n: string) => (n === "x" ? 1 : undefined);
    t.setLookupDeps({ nameToItemKey: fn, offerings: [] });
    const deps = t.getLookupDeps();
    expect(deps.nameToItemKey).toBe(fn);
    expect(deps.offerings).toEqual([]);
  });

  it("归因随快照往返保留（entry.coin 持久化）", () => {
    const src = new WishTracker();
    src.feed(item("木盾", "COMMON"), 1000, { raw: "a" }, observed(160001));
    const dst = new WishTracker();
    dst.applySnapshot(src.captureSnapshot());
    const s = dst.getStats(0);
    expect(s.history[0]!.coin?.coinKey).toBe(160001);
    expect(s.coinGroups[0]!.coinKey).toBe(160001);
  });

  it("旧快照（无 coin 字段、无新桶）恢复不崩：新桶置 0、归因按 unknown", () => {
    const t = new WishTracker();
    t.applySnapshot({
      offeringCount: 1,
      itemCount: 1,
      countsByName: { Legacy: 1 },
      gradeByName: { Legacy: "COMMON" },
      history: [{ wallTime: 1000, name: "Legacy", grade: "COMMON", count: 1, raw: "x" }],
    });
    const s = t.getStats(0);
    // 新桶置 0。
    expect(s.gradeDistribution.find((r) => r.grade === "BEYOND")!.count).toBe(0);
    expect(s.gradeDistribution.find((r) => r.grade === "DIVINE")!.count).toBe(0);
    expect(s.gradeDistribution.find((r) => r.grade === "COSMIC")!.count).toBe(0);
    // 旧 history 无 coin → recentResults 归 unknown，unattributed 收该条目。
    expect(s.recentResults[0]!.coin.confidence).toBe("unknown");
    expect(s.unattributed.items.map((i) => i.name)).toEqual(["Legacy"]);
  });
});
