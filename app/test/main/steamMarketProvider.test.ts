import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OwnedPriceTarget } from "../../src/core/inventory/ownedPriceTargets";

let userDataDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const fetchSteamPrice = vi.fn();

vi.mock("../../src/main/services/steamPriceApi", () => ({
  fetchSteamPrice: (...args: unknown[]) => fetchSteamPrice(...args),
}));

vi.mock("../../src/main/services/steamBuyOrderApi", () => ({
  fetchSteamBuyOrder: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    buyOrder: 0.5,
    rawBuyOrder: "$0.50",
    buyOrderQuantity: 1,
    buyOrderLevels: [{ price: 0.5, quantity: 1 }],
  }),
}));

vi.mock("../../src/main/services/steamItemNameId", () => ({
  getSteamItemNameIdService: () => ({
    getSync: () => 12345,
    resolve: vi.fn().mockResolvedValue({ ok: true, nameId: 12345, status: 200 }),
  }),
}));

import { SteamMarketProvider } from "../../src/main/steamMarketProvider";
import { priceCachePath } from "../../src/main/services/priceCache";

const entry = {
  lowest: 1,
  median: 2,
  volume: 0,
  rawLowest: "$1",
  rawMedian: "$2",
  fetchedUtc: new Date().toISOString(),
  buyOrder: null,
  rawBuyOrder: null,
  buyOrderFetched: true,
  buyOrderCheckUtc: new Date().toISOString(),
};

function mat(hash: string): OwnedPriceTarget {
  return { kind: "material", hash };
}

function gear(...candidates: string[]): OwnedPriceTarget {
  return { kind: "gear", candidates };
}

describe("SteamMarketProvider", () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "tbh-market-"));
    fetchSteamPrice.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  async function runRefresh(
    provider: SteamMarketProvider,
    targets: OwnedPriceTarget[],
    opts: {
      force?: boolean;
      onProgress?: (p: unknown) => void;
      onFinished?: (r: unknown) => void;
    } = {},
  ) {
    const promise = provider.refresh(targets, opts);
    await vi.runAllTimersAsync();
    return promise;
  }

  it("prunes orphan cache entries and persists", async () => {
    fetchSteamPrice.mockResolvedValue({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    expect(provider.pruneCache(["Item A"])).toBe(0);

    await runRefresh(provider, [mat("Item A"), mat("Item B")], { force: true });

    const removedOrphans = provider.pruneCache(["Item A"]);
    expect(removedOrphans).toBe(1);
    const raw = JSON.parse(readFileSync(priceCachePath("USD"), "utf-8")) as {
      prices: Record<string, unknown>;
    };
    expect(Object.keys(raw.prices)).toEqual(["Item A"]);
  });

  it("treats sell-only cache entries as fresh when sell price is fresh", async () => {
    vi.useRealTimers();

    fetchSteamPrice.mockResolvedValue({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    const now = Date.now();
    const sellOnly = {
      ...entry,
      buyOrderFetched: true,
      buyOrderCheckUtc: undefined,
      buyOrder: null,
      rawBuyOrder: null,
      buyOrderQuantity: null,
      buyOrderLevels: null,
      fetchedUtc: new Date(now).toISOString(),
    };
    provider["cache"].prices["Legacy Item"] = sellOnly;

    expect(provider.isFresh("Legacy Item", now)).toBe(true);

    vi.useFakeTimers();
  });

  it("short-circuits when all targets are fresh", async () => {
    fetchSteamPrice.mockResolvedValue({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    await runRefresh(provider, [mat("Fresh Item")], { force: true });

    const onFinished = vi.fn();
    const result = await runRefresh(provider, [mat("Fresh Item")], { onFinished });

    expect(result.noop).toBe(true);
    expect(result.skipped).toBe(1);
    expect(fetchSteamPrice).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ noop: true }));
  });

  it("reports owned target counts in status", async () => {
    fetchSteamPrice.mockResolvedValue({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    await runRefresh(provider, [mat("A")], { force: true });

    const status = provider.status([mat("A"), mat("B")]);
    expect(status.ownedTargets).toBe(2);
    expect(status.freshCount).toBe(1);
    expect(status.staleCount).toBe(1);
  });

  it("continues after fetch timeout (status 0)", async () => {
    fetchSteamPrice
      .mockResolvedValueOnce({ ok: false, status: 0, reason: "network" })
      .mockResolvedValueOnce({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    const result = await runRefresh(provider, [mat("A"), mat("B")], { force: true });

    expect(result.failed).toBe(1);
    expect(result.priced).toBe(1);
    expect(fetchSteamPrice).toHaveBeenCalledTimes(2);
  });

  it("prices gear variant A only even when target lists extra letters", async () => {
    fetchSteamPrice.mockResolvedValue({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    await runRefresh(
      provider,
      [gear("Sword (Legendary) A", "Sword (Legendary) B", "Sword (Legendary) C")],
      { force: true },
    );

    expect(fetchSteamPrice).toHaveBeenCalledTimes(1);
    expect(fetchSteamPrice).toHaveBeenCalledWith("Sword (Legendary) A", "USD");
  });

  it("prices gear from buy orders on variant A when sell listing is missing", async () => {
    const buyOnlyEntry = {
      lowest: null,
      median: null,
      volume: 0,
      rawLowest: null,
      rawMedian: null,
      fetchedUtc: new Date().toISOString(),
      buyOrder: null,
      rawBuyOrder: null,
    };
    fetchSteamPrice.mockResolvedValue({
      ok: false,
      status: 200,
      reason: "no_sell_price",
      entry: buyOnlyEntry,
    });

    const provider = new SteamMarketProvider("USD");
    const result = await runRefresh(provider, [gear("Boots (Legendary) A")], { force: true });

    expect(result.priced).toBe(1);
    expect(result.failed).toBe(0);
    const cached = provider.get("Boots (Legendary) A");
    expect(cached?.buyOrder).toBeCloseTo(0.5);
    expect(cached?.buyOrderFetched).toBe(true);
  });

  it("gives up on a target after MAX_RETRIES_PER_TARGET 429s and advances to the next", async () => {
    // With MAX_RETRIES_PER_TARGET=2, a stuck target burns 2 calls before
    // the give-up branch fires. After give-up, consecutiveRateLimits=2
    // (below the breaker threshold of 3), so the refresh continues to the
    // next target, which succeeds and resets the breaker counter.
    const rateLimited = { ok: false, status: 429, reason: "http" as const };
    fetchSteamPrice
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited) // target A: give up, failed=1
      .mockResolvedValue({ ok: true, status: 200, entry }); // target B succeeds

    const provider = new SteamMarketProvider("USD");
    const result = await runRefresh(provider, [mat("Stuck Item"), mat("Healthy Item")], {
      force: true,
    });

    expect(result.failed).toBe(1);
    expect(result.priced).toBe(1);
    expect(result.stopped).toBe("completed");
    expect(fetchSteamPrice).toHaveBeenCalledTimes(3);
  });

  it("circuit breaker stops the refresh after MAX_CONSECUTIVE_RATE_LIMITS 429s", async () => {
    // With MAX_CONSECUTIVE_RATE_LIMITS=3 and MAX_RETRIES_PER_TARGET=2, the
    // breaker fires after target A gives up (2 retries) and target B's first
    // retry — that's 3 consecutive 429s. Healthy target C is never probed.
    const rateLimited = { ok: false, status: 429, reason: "http" as const };
    fetchSteamPrice
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited) // target A: give up, failed=1
      .mockResolvedValueOnce(rateLimited) // target B retry 1 → consecutive=3 → breaker
      .mockResolvedValue({ ok: true, status: 200, entry }); // never called

    const provider = new SteamMarketProvider("USD");
    const result = await runRefresh(
      provider,
      [mat("Stuck Item"), mat("Also Stuck"), mat("Healthy Item")],
      { force: true },
    );

    // Breaker fired: only 3 calls, no successes, stopped="rate-limited".
    expect(result.failed).toBe(1); // target A gave up before breaker
    expect(result.priced).toBe(0);
    expect(result.stopped).toBe("rate-limited");
    expect(fetchSteamPrice).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After header when Steam provides it", async () => {
    // Steam returns 429 with Retry-After: 10 (seconds). The backoff should
    // be max(retryAfterMs=10000, exponentialBackoff=6000) = 10000ms, not
    // the default 6000ms exponential backoff.
    const rateLimited = {
      ok: false,
      status: 429,
      reason: "http" as const,
      retryAfterMs: 10000,
    };
    fetchSteamPrice
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited) // give up after 2 retries
      .mockResolvedValue({ ok: true, status: 200, entry });

    const provider = new SteamMarketProvider("USD");
    const onProgress = vi.fn();
    await runRefresh(provider, [mat("Stuck Item"), mat("Healthy Item")], {
      force: true,
      onProgress,
    });

    // Find the rate-limited progress event — it should mention 10s wait.
    const rateLimitedProgress = onProgress.mock.calls.find((call) => {
      const p = call[0] as { current?: string } | undefined;
      return p?.current?.includes("rate-limited, waiting 10s");
    });
    expect(rateLimitedProgress).toBeDefined();
  });

  it("resets consecutive rate-limit counter on success", async () => {
    // Two 429s then a success then two more 429s: breaker should NOT fire
    // because the success reset the counter.
    const rateLimited = { ok: false, status: 429, reason: "http" as const };
    fetchSteamPrice
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited) // target A: give up, failed=1
      .mockResolvedValueOnce({ ok: true, status: 200, entry }) // target B: success
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited) // target C: give up, failed=2
      .mockResolvedValue({ ok: true, status: 200, entry }); // target D: success

    const provider = new SteamMarketProvider("USD");
    const result = await runRefresh(provider, [mat("A"), mat("B"), mat("C"), mat("D")], {
      force: true,
    });

    // Two give-ups but no breaker (each give-up followed by success).
    expect(result.failed).toBe(2);
    expect(result.priced).toBe(2);
    expect(result.stopped).toBe("completed");
  });
});
