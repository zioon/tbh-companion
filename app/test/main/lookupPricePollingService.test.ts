import { describe, it, expect, vi } from "vitest";
import {
  LookupPricePollingService,
  sanitizePollingConfig,
  POLLING_DEFAULT_INTERVAL_MIN,
  POLLING_DEFAULT_THRESHOLD_USD,
  POLLING_MIN_INTERVAL_MIN,
  POLLING_MAX_INTERVAL_MIN,
  type LookupPricePollingConfig,
} from "../../src/main/services/LookupPricePollingService";
import { LookupPriceService } from "../../src/main/services/LookupPriceService";
import { IPC } from "../../shared/ipc";
import type { LookupPriceSnapshot } from "../../shared/types";

function snapshot(prices: Record<string, number | null>): LookupPriceSnapshot {
  return {
    schemaVersion: 1,
    generatedUtc: "2026-07-26T00:00:00.000Z",
    baseCurrency: "USD",
    prices,
    fetchedUtc: {},
    fx: { USD: 1 },
  };
}

/**
 * Build a polling service with stubbed deps. The default `lookupPrices`
 * service holds the given initial snapshot; `getOwnedHashes` returns the
 * given owned list; `fetchUsd` is stubbed to drive deterministic test
 * scenarios.
 *
 * 测试中需要 enabled 的场景统一通过 `initialConfig` 注入：构造函数只设置
 * `this.config` 但不调用 `start()`，从而避免 `setConfig({ enabled: true })`
 * 触发的 fire-and-forget `pollOnce()` 占住 `cycleRunning` 导致测试中显式
 * `await pollOnce()` 被跳过。
 */
function makeService(opts: {
  snapshot?: LookupPriceSnapshot | null;
  fetchUsd?: (hash: string) => Promise<{ ok: boolean; usd: number | null; rateLimited: boolean }>;
  fetchLocal?: (
    hash: string,
    currency: string,
  ) => Promise<{
    ok: boolean;
    amount: number | null;
    median?: number | null;
    rateLimited: boolean;
  }>;
  fetchBuyOrder?: (
    hash: string,
    currency: string,
  ) => Promise<{ ok: boolean; buyOrder: number | null; rateLimited: boolean }>;
  getCurrency?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  loadLastSuccessfulCycleAtMs?: () => number | null;
  saveLastSuccessfulCycleAtMs?: (ms: number) => void;
  initialConfig?: Partial<LookupPricePollingConfig>;
  /** 便捷字段：合并进 initialConfig.watchedHashes（图鉴仅轮询星标物品）。 */
  watchedHashes?: string[];
}): {
  service: LookupPricePollingService;
  broadcasts: Array<{ channel: string; payload: unknown }>;
} {
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const lookupPrices = new LookupPriceService({
    fetchFn: () => Promise.resolve(new Response("{}", { status: 200 })),
    cacheFilePath: () => "/tmp/test-lookup-prices.json",
    broadcastFn: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  // Inject the snapshot directly. LookupPriceService doesn't have a public
  // setter, so we use replaceSnapshot which sets + broadcasts (broadcast
  // is harmless here; tests check broadcasts array state explicitly).
  if (opts.snapshot) {
    lookupPrices.replaceSnapshot(opts.snapshot);
    broadcasts.length = 0; // 清掉初始 broadcast
  }
  const service = new LookupPricePollingService(
    {
      lookupPrices,
      getCurrency: opts.getCurrency ?? (() => "USD"),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      fetchUsd: opts.fetchUsd,
      fetchLocal: opts.fetchLocal,
      fetchBuyOrder: opts.fetchBuyOrder,
      sleep: opts.sleep ?? (() => Promise.resolve()),
      now: opts.now,
      loadLastSuccessfulCycleAtMs: opts.loadLastSuccessfulCycleAtMs,
      saveLastSuccessfulCycleAtMs: opts.saveLastSuccessfulCycleAtMs,
    },
    opts.initialConfig,
  );
  // 便捷字段：非空时把 opts.watchedHashes 合并进 config（图鉴仅轮询星标物品）。
  if (opts.watchedHashes && opts.watchedHashes.length > 0) {
    service.setConfig({ watchedHashes: opts.watchedHashes });
  }
  return { service, broadcasts };
}

describe("sanitizePollingConfig", () => {
  it("returns defaults for empty input", () => {
    const cfg = sanitizePollingConfig(undefined);
    expect(cfg).toEqual({
      enabled: false,
      intervalMinutes: POLLING_DEFAULT_INTERVAL_MIN,
      thresholdUsd: POLLING_DEFAULT_THRESHOLD_USD,
      watchedHashes: [],
    });
  });

  it("clamps intervalMinutes to [5, 60]", () => {
    expect(sanitizePollingConfig({ intervalMinutes: 1 }).intervalMinutes).toBe(
      POLLING_MIN_INTERVAL_MIN,
    );
    expect(sanitizePollingConfig({ intervalMinutes: 120 }).intervalMinutes).toBe(
      POLLING_MAX_INTERVAL_MIN,
    );
    expect(sanitizePollingConfig({ intervalMinutes: 15 }).intervalMinutes).toBe(15);
  });

  it("rejects negative or NaN thresholdUsd, falling back to default", () => {
    expect(sanitizePollingConfig({ thresholdUsd: -1 }).thresholdUsd).toBe(
      POLLING_DEFAULT_THRESHOLD_USD,
    );
    expect(sanitizePollingConfig({ thresholdUsd: NaN }).thresholdUsd).toBe(
      POLLING_DEFAULT_THRESHOLD_USD,
    );
    expect(sanitizePollingConfig({ thresholdUsd: 5 }).thresholdUsd).toBe(5);
  });

  it("dedupes and trims watchedHashes", () => {
    const cfg = sanitizePollingConfig({
      watchedHashes: ["A", " A ", "", "B", "A", "  "],
    });
    expect(cfg.watchedHashes).toEqual(["A", "B"]);
  });
});

describe("LookupPricePollingService.pollOnce", () => {
  it("returns aborted result when disabled", async () => {
    const { service } = makeService({});
    const result = await service.pollOnce();
    expect(result).toEqual({
      targets: 0,
      priced: 0,
      rateLimited: 0,
      failed: 0,
      aborted: true,
    });
  });

  it("returns 0 targets when nothing owned/watched and no snapshot", async () => {
    const { service } = makeService({
      snapshot: null,
      watchedHashes: [],
      initialConfig: { enabled: true },
    });
    const result = await service.pollOnce();
    expect(result.targets).toBe(0);
    expect(result.priced).toBe(0);
  });

  it("fetches and merges prices for watched (starred) items in given order", async () => {
    const snap = snapshot({ Expensive: 5.0, Cheap: 0.05 });
    const fetchUsd = vi.fn(async (hash: string) => ({
      ok: true,
      usd: hash === "Expensive" ? 6.5 : null,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["Expensive", "Cheap"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const result = await service.pollOnce();
    // 新逻辑：图鉴只轮询星标（watched）物品，walked 顺序保留，threshold 不参与筛选
    expect(result.targets).toBe(2);
    expect(result.priced).toBe(2); // 两个都 ok=true（Cheap 返回 null 也算 priced）
    expect(fetchUsd).toHaveBeenCalledTimes(2);
    expect(fetchUsd).toHaveBeenCalledWith("Expensive");
    expect(fetchUsd).toHaveBeenCalledWith("Cheap");

    // Should broadcast a merged snapshot via IPC.LOOKUP_PRICES
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channel).toBe(IPC.LOOKUP_PRICES);
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    expect(payload.prices["Expensive"]).toBe(6.5);
    expect(payload.prices["Cheap"]).toBeNull(); // Cheap 被轮询，fetchUsd 返回 null
    expect(payload.fetchedUtc?.["Expensive"]).toBeTruthy();
  });

  it("includes watched hashes regardless of price", async () => {
    const snap = snapshot({ "Watched Priced": 0.05 });
    const fetchUsd = vi.fn(async () => ({
      ok: true,
      usd: 0.08,
      rateLimited: false,
    }));
    const { service } = makeService({
      snapshot: snap,
      fetchUsd,
      initialConfig: {
        enabled: true,
        thresholdUsd: 1.0,
        watchedHashes: ["Watched Priced", "Watched Not In Snapshot"],
      },
    });

    const result = await service.pollOnce();
    expect(result.targets).toBe(2);
    expect(result.priced).toBe(2);
  });

  it("aborts after MAX_CONSECUTIVE_RATE_LIMITS consecutive 429s", async () => {
    const snap = snapshot({
      A: 2.0,
      B: 2.0,
      C: 2.0,
      D: 2.0,
      E: 2.0,
    });
    const fetchUsd = vi.fn(async () => ({
      ok: false,
      usd: null,
      rateLimited: true,
    }));
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B", "C", "D", "E"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const result = await service.pollOnce();
    expect(result.aborted).toBe(true);
    expect(result.rateLimited).toBeGreaterThanOrEqual(3);
    // Should have stopped after 3 consecutive 429s, not exhausted all 5 targets
    expect(fetchUsd).toHaveBeenCalledTimes(3);
  });

  it("resets consecutive rate-limit counter after a success", async () => {
    const snap = snapshot({
      A: 2.0,
      B: 2.0,
      C: 2.0,
      D: 2.0,
    });
    // 2× 429, then success, then 2× 429 (should NOT abort because counter reset)
    const seq = [true, true, false, true, true];
    let i = 0;
    const fetchUsd = vi.fn(async () => {
      const rl = seq[i++] ?? false;
      return { ok: !rl, usd: rl ? null : 3.0, rateLimited: rl };
    });
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B", "C", "D"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const result = await service.pollOnce();
    expect(result.aborted).toBe(false);
    expect(result.priced).toBe(1);
    expect(fetchUsd).toHaveBeenCalledTimes(4);
  });

  it("does not broadcast when no prices were fetched", async () => {
    const snap = snapshot({ A: 2.0 });
    const fetchUsd = vi.fn(async () => ({
      ok: false,
      usd: null,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    await service.pollOnce();
    expect(broadcasts).toHaveLength(0);
  });

  it("preserves generatedUtc and fx from original snapshot", async () => {
    const snap: LookupPriceSnapshot = {
      schemaVersion: 1,
      generatedUtc: "2026-07-26T08:00:00.000Z",
      baseCurrency: "USD",
      prices: { A: 5.0 },
      fetchedUtc: { A: "2026-07-26T07:00:00.000Z" },
      fx: { USD: 1, BRL: 5.2, EUR: 0.92 },
    };
    const fetchUsd = vi.fn(async () => ({
      ok: true,
      usd: 6.0,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    await service.pollOnce();
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    expect(payload.generatedUtc).toBe("2026-07-26T08:00:00.000Z");
    expect(payload.fx).toEqual({ USD: 1, BRL: 5.2, EUR: 0.92 });
  });

  it("skips cycle when previous cycle still running", async () => {
    const snap = snapshot({ A: 5.0 });
    let resolveFirst: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const fetchUsd = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        await firstCall; // 阻塞第一次调用
      }
      return { ok: true, usd: 6.0, rateLimited: false };
    });
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const firstPromise = service.pollOnce();
    const skippedResult = await service.pollOnce();
    expect(skippedResult.aborted).toBe(true);
    expect(skippedResult.targets).toBe(0);

    resolveFirst!();
    await firstPromise;
  });

  it("writes pricesLocal and localCurrency when target currency is non-USD", async () => {
    const snap: LookupPriceSnapshot = {
      schemaVersion: 1,
      generatedUtc: "2026-07-26T08:00:00.000Z",
      baseCurrency: "USD",
      prices: { A: 5.0, B: 2.0 },
      fetchedUtc: {},
      fx: { USD: 1, BRL: 5.2 },
    };
    // fetchLocal 优先于 fetchUsd，覆盖目标货币抓取路径
    const fetchLocal = vi.fn(async (hash: string, currency: string) => ({
      ok: true,
      amount: hash === "A" ? 32.0 : currency === "BRL" ? 12.0 : null,
      rateLimited: false,
    }));
    const fetchUsd = vi.fn(async () => ({ ok: true, usd: 99, rateLimited: false }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B"],
      fetchLocal,
      fetchUsd,
      getCurrency: () => "BRL",
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const result = await service.pollOnce();
    expect(result.priced).toBe(2);
    // fetchLocal 应被调用（fetchUsd 被忽略）
    expect(fetchLocal).toHaveBeenCalledTimes(2);
    expect(fetchLocal).toHaveBeenCalledWith("A", "BRL");
    expect(fetchLocal).toHaveBeenCalledWith("B", "BRL");
    expect(fetchUsd).not.toHaveBeenCalled();

    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    // pricesLocal 用 fetchLocal 返回的目标货币价格
    expect(payload.pricesLocal?.["A"]).toBe(32.0);
    expect(payload.pricesLocal?.["B"]).toBe(12.0);
    expect(payload.localCurrency).toBe("BRL");
    // prices 字段保留原值（fetchLocal 路径不写 prices）
    expect(payload.prices["A"]).toBe(5.0);
    expect(payload.prices["B"]).toBe(2.0);
  });

  it("writes medianLocal and buyOrderLocal alongside pricesLocal", async () => {
    const snap: LookupPriceSnapshot = {
      schemaVersion: 1,
      generatedUtc: "2026-07-26T08:00:00.000Z",
      baseCurrency: "USD",
      prices: { A: 5.0, B: 2.0 },
      fetchedUtc: {},
      fx: { USD: 1, BRL: 5.2 },
    };
    // fetchLocal 同时返回 lowest + median；fetchBuyOrder 独立注入
    const fetchLocal = vi.fn(async (hash: string) => ({
      ok: true,
      amount: hash === "A" ? 32.0 : 12.0,
      median: hash === "A" ? 30.5 : 11.0,
      rateLimited: false,
    }));
    const fetchBuyOrder = vi.fn(async (hash: string) => ({
      ok: true,
      buyOrder: hash === "A" ? 28.0 : 9.5,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B"],
      fetchLocal,
      fetchBuyOrder,
      getCurrency: () => "BRL",
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const result = await service.pollOnce();
    expect(result.priced).toBe(2);
    expect(fetchLocal).toHaveBeenCalledTimes(2);
    expect(fetchBuyOrder).toHaveBeenCalledTimes(2);
    expect(fetchBuyOrder).toHaveBeenCalledWith("A", "BRL");
    expect(fetchBuyOrder).toHaveBeenCalledWith("B", "BRL");

    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    // 三档价格同时写入对应字段
    expect(payload.pricesLocal?.["A"]).toBe(32.0);
    expect(payload.medianLocal?.["A"]).toBe(30.5);
    expect(payload.buyOrderLocal?.["A"]).toBe(28.0);
    expect(payload.pricesLocal?.["B"]).toBe(12.0);
    expect(payload.medianLocal?.["B"]).toBe(11.0);
    expect(payload.buyOrderLocal?.["B"]).toBe(9.5);
    expect(payload.localCurrency).toBe("BRL");
  });

  it("skips buyOrder when fetchBuyOrder not injected and nameIdService absent", async () => {
    const snap = snapshot({ A: 5.0 });
    const fetchLocal = vi.fn(async () => ({
      ok: true,
      amount: 32.0,
      median: 30.5,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchLocal,
      getCurrency: () => "BRL",
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    await service.pollOnce();
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    // lowest + median 写入；buyOrder 未抓取（fetchBuyOrder/nameIdService 都未注入）
    // buyOrderLocal 字段会被 merge 成 {}，但条目缺失 → resolve 时回退为 null
    expect(payload.pricesLocal?.["A"]).toBe(32.0);
    expect(payload.medianLocal?.["A"]).toBe(30.5);
    expect(payload.buyOrderLocal?.["A"] ?? null).toBeNull();
  });

  it("writes buyOrder=null when fetchBuyOrder returns ok=false", async () => {
    const snap = snapshot({ A: 5.0 });
    const fetchLocal = vi.fn(async () => ({
      ok: true,
      amount: 32.0,
      median: 30.5,
      rateLimited: false,
    }));
    const fetchBuyOrder = vi.fn(async () => ({
      ok: false,
      buyOrder: null,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchLocal,
      fetchBuyOrder,
      getCurrency: () => "BRL",
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    await service.pollOnce();
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    // buyOrderLocal[hash] = null 表示「已确认无收购单」
    expect(payload.buyOrderLocal?.["A"]).toBeNull();
  });

  it("6h 刷新缓存：上次成功 cycle 距今不足 6h 时 pollOnce 跳过不抓取", async () => {
    const snap = snapshot({ A: 5.0 });
    let now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const fetchUsd = vi.fn(async () => ({ ok: true, usd: 6.0, rateLimited: false }));
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchUsd,
      now: () => now,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    // 首次 cycle 成功，触发抓取
    const first = await service.pollOnce();
    expect(first.priced).toBe(1);
    expect(fetchUsd).toHaveBeenCalledTimes(1);

    // 3h 后再次触发：命中 6h 缓存 → 跳过，不抓取
    now += 3 * 3600_000;
    const second = await service.pollOnce();
    expect(second.aborted).toBe(false);
    expect(second.targets).toBe(0);
    expect(fetchUsd).toHaveBeenCalledTimes(1);

    // 6h 缓存过期后再次触发 → 重新抓取
    now += 4 * 3600_000;
    const third = await service.pollOnce();
    expect(third.priced).toBe(1);
    expect(fetchUsd).toHaveBeenCalledTimes(2);
  });

  it("持久化：上次成功 cycle 时间戳保存后，新实例启动即命中 6h 缓存不抓取", async () => {
    const snap = snapshot({ A: 5.0, B: 8.0 });
    let now = Date.UTC(2026, 7, 7, 10, 0, 0);
    let persisted: number | null = null;
    const fetchUsd = vi.fn(async () => ({ ok: true, usd: 6.0, rateLimited: false }));

    // 第一个实例跑完整 cycle 成功，并把时间戳持久化
    const { service: s1 } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B"],
      fetchUsd,
      now: () => now,
      saveLastSuccessfulCycleAtMs: (ms) => {
        persisted = ms;
      },
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });
    const first = await s1.pollOnce();
    expect(first.priced).toBe(2);
    expect(persisted).toBe(now);

    // 模拟重启：新实例从 loadLastSuccessfulCycleAtMs 恢复时间戳，2h 后触发
    now += 2 * 3600_000;
    const { service: s2 } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B"],
      fetchUsd,
      now: () => now,
      loadLastSuccessfulCycleAtMs: () => persisted,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });
    const second = await s2.pollOnce();
    expect(second.aborted).toBe(false);
    expect(second.targets).toBe(0);
    expect(fetchUsd).toHaveBeenCalledTimes(2); // 仅第一次实例抓过

    // 超过 6h 后新实例应重新抓取
    now += 5 * 3600_000;
    const { service: s3 } = makeService({
      snapshot: snap,
      watchedHashes: ["A", "B"],
      fetchUsd,
      now: () => now,
      loadLastSuccessfulCycleAtMs: () => persisted,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });
    const third = await s3.pollOnce();
    expect(third.priced).toBe(2);
    expect(fetchUsd).toHaveBeenCalledTimes(4);
  });

  it("手动 force：6h 缓存未过期时 pollOnce(true) 仍抓取", async () => {
    const snap = snapshot({ A: 5.0 });
    let now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const fetchUsd = vi.fn(async () => ({ ok: true, usd: 6.0, rateLimited: false }));
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchUsd,
      now: () => now,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    // 首次 cycle 成功，触发抓取
    const first = await service.pollOnce();
    expect(first.priced).toBe(1);
    expect(fetchUsd).toHaveBeenCalledTimes(1);

    // 3h 后：自动 pollOnce() 仍受 6h 缓存约束跳过
    now += 3 * 3600_000;
    const auto = await service.pollOnce();
    expect(auto.targets).toBe(0);
    expect(fetchUsd).toHaveBeenCalledTimes(1);

    // 但 pollOnce(true) 手动触发绕过 cooldown，立即重新抓取
    const forced = await service.pollOnce(true);
    expect(forced.priced).toBe(1);
    expect(fetchUsd).toHaveBeenCalledTimes(2);
  });

  it("pollOnce 分批：超过 10 个目标时，每批 10 个后等待 2 分钟再拉下一批", async () => {
    const hashes = Array.from({ length: 12 }, (_, i) => "H" + String(i).padStart(2, "0"));
    const snap = snapshot(Object.fromEntries(hashes.map((h) => [h, 5.0])));
    const sleeps: number[] = [];
    const fetchLocal = vi.fn(async () => ({
      ok: true,
      amount: 6.0,
      median: 6.0,
      rateLimited: false,
    }));
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: hashes,
      fetchLocal,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const res = await service.pollOnce();
    expect(res.priced).toBe(12);
    expect(fetchLocal).toHaveBeenCalledTimes(12);
    // 12 个目标 = 批 10 + 批 2 → 恰好 1 次 2 分钟批间等待
    const batchGaps = sleeps.filter((ms) => ms === 2 * 60 * 1000);
    expect(batchGaps.length).toBe(1);
  });
});

describe("LookupPricePollingService.setConfig", () => {
  it("starts timer when enabled toggles to true", () => {
    const { service } = makeService({});
    service.setConfig({ enabled: true, intervalMinutes: 5 });
    expect(service.isRunning()).toBe(false); // not running because no cycle in flight
    // start() should have scheduled a poll cycle; we can't easily test setInterval
    // without fake timers, but at least verify config took effect:
    expect(service.getConfig().enabled).toBe(true);
    expect(service.getConfig().intervalMinutes).toBe(5);
    service.stop();
  });

  it("stops timer when enabled toggles to false", () => {
    const { service } = makeService({});
    service.setConfig({ enabled: true, intervalMinutes: 5 });
    service.setConfig({ enabled: false });
    expect(service.getConfig().enabled).toBe(false);
  });
});

describe("LookupPricePollingService.pollSingleHash", () => {
  it("aborts when hash is empty/whitespace", async () => {
    const { service } = makeService({});
    expect((await service.pollSingleHash("")).aborted).toBe(true);
    expect((await service.pollSingleHash("   ")).aborted).toBe(true);
  });

  it("fetches and merges three-tier prices for a single hash regardless of polling config", async () => {
    // 关键：polling 关闭（enabled=false），pollSingleHash 仍然抓取
    const snap: LookupPriceSnapshot = {
      schemaVersion: 1,
      generatedUtc: "2026-07-26T08:00:00.000Z",
      baseCurrency: "USD",
      prices: { "Ethereal Earring (Cosmic) A": 853.72 },
      fetchedUtc: {},
      fx: { USD: 1, CNY: 7.2 },
    };
    const fetchLocal = vi.fn(async () => ({
      ok: true,
      amount: 6174.5,
      median: 6100.0,
      rateLimited: false,
    }));
    const fetchBuyOrder = vi.fn(async () => ({
      ok: true,
      buyOrder: 5800.0,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: [], // 不 owned 也能抓
      fetchLocal,
      fetchBuyOrder,
      getCurrency: () => "CNY",
      // 故意不设 initialConfig.enabled = true，验证手动路径绕过 enabled
    });

    const result = await service.pollSingleHash("Ethereal Earring (Cosmic) A");
    expect(result.targets).toBe(1);
    expect(result.priced).toBe(1);
    expect(result.rateLimited).toBe(0);
    expect(result.aborted).toBe(false);
    expect(fetchLocal).toHaveBeenCalledTimes(1);
    expect(fetchLocal).toHaveBeenCalledWith("Ethereal Earring (Cosmic) A", "CNY");
    expect(fetchBuyOrder).toHaveBeenCalledTimes(1);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channel).toBe(IPC.LOOKUP_PRICES);
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    expect(payload.pricesLocal?.["Ethereal Earring (Cosmic) A"]).toBe(6174.5);
    expect(payload.medianLocal?.["Ethereal Earring (Cosmic) A"]).toBe(6100.0);
    expect(payload.buyOrderLocal?.["Ethereal Earring (Cosmic) A"]).toBe(5800.0);
    expect(payload.localCurrency).toBe("CNY");
    // 原 CI prices 字段保留（fetchLocal 路径不写 prices）
    expect(payload.prices["Ethereal Earring (Cosmic) A"]).toBe(853.72);
  });

  it("returns aborted when another cycle is running", async () => {
    const snap = snapshot({ A: 5.0 });
    let resolveFirst: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const fetchUsd = vi.fn(async () => {
      callCount++;
      if (callCount === 1) await firstCall;
      return { ok: true, usd: 6.0, rateLimited: false };
    });
    const { service } = makeService({
      snapshot: snap,
      watchedHashes: ["A"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const pollOncePromise = service.pollOnce();
    // pollSingleHash 应被 cycleRunning 拦截
    const singleResult = await service.pollSingleHash("A");
    expect(singleResult.aborted).toBe(true);
    expect(singleResult.targets).toBe(0);

    resolveFirst!();
    await pollOncePromise;
  });

  it("reports rate-limited result without merging when fetchLocal returns 429", async () => {
    const snap = snapshot({ A: 5.0 });
    const fetchLocal = vi.fn(async () => ({
      ok: false,
      amount: null,
      rateLimited: true,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: [],
      fetchLocal,
      getCurrency: () => "CNY",
    });

    const result = await service.pollSingleHash("A");
    expect(result.priced).toBe(0);
    expect(result.rateLimited).toBe(1);
    expect(broadcasts).toHaveLength(0); // 没有价格，不广播
  });

  it("writes buyOrder=null when fetchBuyOrder returns ok=false (no buy orders)", async () => {
    const snap = snapshot({ A: 5.0 });
    const fetchLocal = vi.fn(async () => ({
      ok: true,
      amount: 32.0,
      median: 30.5,
      rateLimited: false,
    }));
    const fetchBuyOrder = vi.fn(async () => ({
      ok: false,
      buyOrder: null,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: [],
      fetchLocal,
      fetchBuyOrder,
      getCurrency: () => "BRL",
    });

    await service.pollSingleHash("A");
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    expect(payload.buyOrderLocal?.["A"]).toBeNull();
    expect(payload.medianLocal?.["A"]).toBe(30.5);
  });

  it("preserves generatedUtc and fx from original snapshot", async () => {
    const snap: LookupPriceSnapshot = {
      schemaVersion: 1,
      generatedUtc: "2026-07-25T21:33:00.000Z",
      baseCurrency: "USD",
      prices: { A: 5.0 },
      fetchedUtc: {},
      fx: { USD: 1, CNY: 7.2, BRL: 5.2 },
    };
    const fetchLocal = vi.fn(async () => ({
      ok: true,
      amount: 36.0,
      median: 35.0,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      watchedHashes: [],
      fetchLocal,
      getCurrency: () => "CNY",
    });

    await service.pollSingleHash("A");
    const payload = broadcasts[0].payload as LookupPriceSnapshot;
    expect(payload.generatedUtc).toBe("2026-07-25T21:33:00.000Z");
    expect(payload.fx).toEqual({ USD: 1, CNY: 7.2, BRL: 5.2 });
  });
});
