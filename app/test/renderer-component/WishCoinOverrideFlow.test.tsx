// 回归测试：手工指定硬币的完整链路（对应线上崩溃
// `Cannot read properties of undefined (reading 'map')`）。
//
// 覆盖两条独立路径：
//   1. `useWish().setCoinOverride` 发出的 IPC 载荷必须是**新数组**（不能是旧值 /
//      undefined）——旧实现把 `next` 写在 setState updater 内，IPC 先于 updater
//      执行，会把初始 `[]` 发出去。
//   2. 主进程回传 / 广播任何**非数组**载荷时，renderer 不得崩溃（签名函数与
//      state 归一化双重防护）。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { WishCoinOverrides } from "../../shared/types";

const overridesPayloads: unknown[] = [];
let responsePayload: unknown = undefined;

const tbh = {
  getWishCoinOverrides: vi.fn(async () => [] as unknown),
  setWishCoinOverrides: vi.fn(async (o: unknown) => {
    overridesPayloads.push(o);
    return responsePayload;
  }),
  onWishCoinOverrides: vi.fn(() => () => {}),
  getStats: vi.fn(async () => null),
  onStats: vi.fn(() => () => {}),
  getInventory: vi.fn(async () => null),
  onInventory: vi.fn(() => () => {}),
  reset: vi.fn(async () => {}),
  reportError: vi.fn(),
};

(globalThis as unknown as { window: unknown }).window = globalThis;
(window as unknown as { tbh: unknown }).tbh = tbh;

vi.mock("../../src/renderer/lib/useStats", () => ({ useStats: () => null }));
vi.mock("../../src/renderer/lib/useInventory", () => ({ useInventory: () => null }));
vi.mock("../../src/renderer/lib/useLookupCatalog", () => ({ useLookupCatalog: () => null }));

import { useWish } from "../../src/renderer/lib/useWish";

describe("useWish.setCoinOverride", () => {
  beforeEach(() => {
    overridesPayloads.length = 0;
    responsePayload = undefined;
    vi.clearAllMocks();
  });

  it("sends the NEW override array on IPC (not the stale empty one)", async () => {
    const { result } = renderHook(() => useWish());
    await act(async () => {
      await result.current.setCoinOverride("待分类物", 160010);
    });
    expect(overridesPayloads.length).toBe(1);
    expect(Array.isArray(overridesPayloads[0])).toBe(true);
    expect(overridesPayloads[0]).toEqual([
      expect.objectContaining({ itemName: "待分类物", coinKey: 160010 }),
    ]);
  });

  it("does not crash when main replies with void/undefined (the reported bug)", async () => {
    responsePayload = undefined;
    const { result } = renderHook(() => useWish());
    await act(async () => {
      await result.current.setCoinOverride("待分类物", 160010);
    });
    await waitFor(() => {
      expect(Array.isArray(result.current.coinOverrides)).toBe(true);
    });
  });

  it("does not crash when a broadcast carries a non-array payload", async () => {
    let handler: ((rows: unknown) => void) | undefined;
    tbh.onWishCoinOverrides.mockImplementation((cb: (rows: unknown) => void) => {
      handler = cb;
      return () => {};
    });
    const { result } = renderHook(() => useWish());
    act(() => {
      handler?.(null);
    });
    expect(Array.isArray(result.current.coinOverrides)).toBe(true);
    act(() => {
      handler?.({ nope: true });
    });
    expect(Array.isArray(result.current.coinOverrides)).toBe(true);
  });

  it("unbinding sends an array without that item", async () => {
    responsePayload = [] satisfies WishCoinOverrides;
    const { result } = renderHook(() => useWish());
    await act(async () => {
      await result.current.setCoinOverride("待分类物", 160010);
    });
    await act(async () => {
      await result.current.setCoinOverride("待分类物", null);
    });
    expect(overridesPayloads.at(-1)).toEqual([]);
  });
});
