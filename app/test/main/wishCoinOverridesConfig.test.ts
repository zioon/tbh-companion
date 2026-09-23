// 主进程侧手工硬币绑定的**形态契约**回归测试。
//
// 背景（线上崩溃 `Cannot read properties of undefined (reading 'map')`）：
// `appState.setWishCoinOverrides` 过去返回 `void`，而 renderer 的
// `setCoinOverride` 会把返回值写回本地状态；`undefined` 一旦进入状态，
// 渲染期的 `overridesSig` 就抛错，整个祈愿页被 ErrorBoundary 接住。
//
// 这里锁定三条不变量：
//   1. `sanitizeWishCoinOverrides` 对任意非法输入都返回**数组**（绝不 undefined）；
//   2. 它只是逐条丢弃非法条目，不抛错（手工编辑过的 config.json 不能让应用崩）；
//   3. `normalizeConfigFromRaw` 产出的 `wishCoinOverrides` 恒为数组。
import { describe, it, expect } from "vitest";
import { sanitizeWishCoinOverrides, normalizeConfigFromRaw } from "../../src/main/config";

describe("sanitizeWishCoinOverrides", () => {
  it("returns [] for undefined / null / non-array inputs", () => {
    for (const bad of [undefined, null, 0, "", "nope", {}, { a: 1 }]) {
      const out = sanitizeWishCoinOverrides(bad);
      expect(Array.isArray(out)).toBe(true);
      expect(out).toEqual([]);
    }
  });

  it("keeps valid entries and drops invalid ones without throwing", () => {
    const out = sanitizeWishCoinOverrides([
      { itemName: "有效物", coinKey: 160010, createdAt: 1 },
      { itemName: "", coinKey: 160010, createdAt: 1 }, // 空名 → 丢
      { itemName: "  ", coinKey: 160010, createdAt: 1 }, // 全空白 → 丢
      { itemName: "越界物", coinKey: 999999, createdAt: 1 }, // 非硬币闭集 → 丢
      { itemName: "无键物", coinKey: "160010", createdAt: 1 }, // 字符串 key → 丢
      { itemName: "无形物", coinKey: 160001 }, // createdAt 缺失 → 补 0
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ itemName: "有效物", coinKey: 160010, createdAt: 1 });
    expect(out[1]).toEqual({ itemName: "无形物", coinKey: 160001, createdAt: 0 });
  });

  it("trims itemName and lets the later entry win on duplicates", () => {
    const out = sanitizeWishCoinOverrides([
      { itemName: "同名物", coinKey: 160001, createdAt: 1 },
      { itemName: " 同名物 ", coinKey: 160002, createdAt: 2 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ itemName: "同名物", coinKey: 160002, createdAt: 2 });
  });
});

describe("normalizeConfigFromRaw wishCoinOverrides", () => {
  it("always yields an array, even when the persisted value is missing or malformed", () => {
    // 注意：`normalizeConfigFromRaw` 的入参契约是**已解析的对象**（不是 undefined）；
    // 缺失字段只可能是「对象上没有这个 key」。
    for (const raw of [{}, { wishCoinOverrides: null }, { wishCoinOverrides: 42 }]) {
      const cfg = normalizeConfigFromRaw(raw as never);
      expect(Array.isArray(cfg.wishCoinOverrides)).toBe(true);
    }
  });

  it("preserves a valid persisted binding across a load/save round trip", () => {
    const cfg = normalizeConfigFromRaw({
      wishCoinOverrides: [{ itemName: "待分类物", coinKey: 160010, createdAt: 123 }],
    } as never);
    expect(cfg.wishCoinOverrides).toEqual([
      { itemName: "待分类物", coinKey: 160010, createdAt: 123 },
    ]);
  });
});
