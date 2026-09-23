// 帧级差分硬币归因单测（Wish v2 P0-3）。
//
// 硬性断言（架构 §8.3 单测硬门）：
//   - 唯一减少 + 时间窗内 → observed；
//   - **多枚同时减少 → confidence !== "observed"**；
//   - **无帧 → unknown**；
//   - bulk 行 → unknown（basis "bulk-skip"，跳过差分，I4）；
//   - 越窗 → unknown（basis "out-of-window"）。

import { describe, expect, it } from "vitest";
import { attributeCoinByDiff } from "../../src/core/wish/coinDiff";

/** 构造 10 枚硬币的 materialStacks 快照（默认全 0）。 */
function frame(overrides: Record<number, number> = {}): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = 160001; k <= 160010; k++) m.set(k, 0);
  for (const [k, v] of Object.entries(overrides)) m.set(Number(k), v);
  return m;
}

describe("attributeCoinByDiff", () => {
  it("唯一硬币减少 + 时间窗内 → observed，coinKey 唯一", () => {
    const before = frame({ 160001: 5, 160003: 2 });
    const after = frame({ 160001: 4, 160003: 2 });
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1000,
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("observed");
    expect(out.coinKey).toBe(160001);
    expect(out.candidates).toEqual([]);
    expect(out.basis).toBe("diff:160001");
  });

  it("多枚硬币同时减少 → 绝不 observed（回归硬门）", () => {
    const before = frame({ 160001: 5, 160005: 3 });
    const after = frame({ 160001: 4, 160005: 2 });
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1000,
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).not.toBe("observed");
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.basis).toBe("multi-coin");
  });

  it("无 before 帧 → unknown（回归硬门）", () => {
    const out = attributeCoinByDiff(null, frame({ 160001: 4 }), {
      wallTime: 1000,
      beforeAt: null,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.basis).toBe("no-frame");
  });

  it("无 after 帧 → unknown", () => {
    const out = attributeCoinByDiff(frame({ 160001: 5 }), null, {
      wallTime: 1000,
      beforeAt: 995,
      afterAt: null,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.basis).toBe("no-frame");
  });

  it("事件时刻越窗 → unknown（basis out-of-window）", () => {
    const before = frame({ 160001: 5 });
    const after = frame({ 160001: 4 });
    const out = attributeCoinByDiff(before, after, {
      wallTime: 2000, // 远离 [995, 1005]
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.basis).toBe("out-of-window");
  });

  it("容差内（贴边）仍算 observed", () => {
    const before = frame({ 160002: 9 });
    const after = frame({ 160002: 8 });
    // wallTime = afterAt + tol 恰好在窗边界。
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1010,
      beforeAt: 990,
      afterAt: 1002.5,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("observed");
    expect(out.coinKey).toBe(160002);
  });

  it("bulk 行跳过差分 → unknown（basis bulk-skip，I4）", () => {
    const before = frame({ 160001: 5 });
    const after = frame({ 160001: 4 });
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1000,
      bulk: true,
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.coinKey).toBeNull();
    expect(out.basis).toBe("bulk-skip");
  });

  it("无硬币减少 → unknown", () => {
    const before = frame({ 160001: 5 });
    const after = frame({ 160001: 5 });
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1000,
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
    expect(out.basis).toBe("no-decrease");
  });

  it("硬币增加（非减少）不产 observed", () => {
    const before = frame({ 160001: 5 });
    const after = frame({ 160001: 6 });
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1000,
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("unknown");
  });

  it("自定义 coinKeys 闭集生效", () => {
    const before = new Map<number, number>([[999, 3]]);
    const after = new Map<number, number>([[999, 2]]);
    const out = attributeCoinByDiff(before, after, {
      wallTime: 1000,
      coinKeys: [999],
      beforeAt: 995,
      afterAt: 1005,
      toleranceSec: 7.5,
    });
    expect(out.confidence).toBe("observed");
    expect(out.coinKey).toBe(999);
  });
});
