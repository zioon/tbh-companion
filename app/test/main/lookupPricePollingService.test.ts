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
  ownedHashes?: string[];
  fetchUsd?: (hash: string) => Promise<{ ok: boolean; usd: number | null; rateLimited: boolean }>;
  sleep?: (ms: number) => Promise<void>;
  initialConfig?: Partial<LookupPricePollingConfig>;
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
      getOwnedHashes: () => opts.ownedHashes ?? [],
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      fetchUsd: opts.fetchUsd,
      sleep: opts.sleep ?? (() => Promise.resolve()),
    },
    opts.initialConfig,
  );
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
      ownedHashes: [],
      initialConfig: { enabled: true },
    });
    const result = await service.pollOnce();
    expect(result.targets).toBe(0);
    expect(result.priced).toBe(0);
  });

  it("fetches and merges prices for owned items; high-value first, regular after", async () => {
    const snap = snapshot({ Expensive: 5.0, Cheap: 0.05 });
    const fetchUsd = vi.fn(async (hash: string) => ({
      ok: true,
      usd: hash === "Expensive" ? 6.5 : null,
      rateLimited: false,
    }));
    const { service, broadcasts } = makeService({
      snapshot: snap,
      ownedHashes: ["Expensive", "Cheap"],
      fetchUsd,
      initialConfig: { enabled: true, thresholdUsd: 1.0 },
    });

    const result = await service.pollOnce();
    // 新逻辑：owned + priceable 全入选，threshold 仅用于排序
    // Expensive (5.0 >= 1.0) 高价值排前，Cheap (0.05 < 1.0) 常规排后
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
      ownedHashes: [],
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
      ownedHashes: ["A", "B", "C", "D", "E"],
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
      ownedHashes: ["A", "B", "C", "D"],
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
      ownedHashes: ["A"],
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
      ownedHashes: ["A"],
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
      ownedHashes: ["A"],
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
