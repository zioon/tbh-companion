import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSteamPriceFailure,
  fetchSteamPrice,
  fetchSteamPriceHistory,
  parsePriceHistoryTimestamp,
} from "../../src/main/services/steamPriceApi";

describe("fetchSteamPrice", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          lowest_price: "$0.04",
          median_price: "$0.05",
          volume: "12",
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns sell prices on success", async () => {
    const result = await fetchSteamPrice("Iron Ingot", "USD");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.median).toBeCloseTo(0.05);
      expect(result.entry.lowest).toBeCloseTo(0.04);
    }
  });

  it("reports no_listing when Steam success is false", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: false }),
    } as Response);

    const result = await fetchSteamPrice("Missing Item", "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_listing");
      expect(result.entry?.median).toBeNull();
      expect(result.entry?.fetchedUtc).toBeTruthy();
    }
    expect(
      describeSteamPriceFailure(result as { ok: false; status: number; reason: "no_listing" }),
    ).toContain("no Steam market listing");
  });

  it("returns partial entry when success but no sell prices", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, volume: "0" }),
    } as Response);

    const result = await fetchSteamPrice("Buy Only Item", "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_sell_price");
      expect(result.entry?.median).toBeNull();
      expect(result.entry?.fetchedUtc).toBeTruthy();
    }
  });

  it("reports network on fetch throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));

    const result = await fetchSteamPrice("Iron Ingot", "USD");
    expect(result).toEqual({ ok: false, status: 0, reason: "network" });
  });

  it("reports http on non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    const result = await fetchSteamPrice("Iron Ingot", "USD");
    expect(result).toEqual({ ok: false, status: 503, reason: "http" });
  });
});

describe("parsePriceHistoryTimestamp", () => {
  it("parses UTC string timestamps like 'May 27 2026 01: +0'", () => {
    expect(parsePriceHistoryTimestamp("May 27 2026 01: +0")).toBe(Date.UTC(2026, 4, 27, 1) / 1000);
    expect(parsePriceHistoryTimestamp("Aug 08 2026 14: +0")).toBe(Date.UTC(2026, 7, 8, 14) / 1000);
  });

  it("passes through numeric epoch seconds", () => {
    expect(parsePriceHistoryTimestamp(1_752_000_000)).toBe(1_752_000_000);
  });

  it("returns NaN for unparseable input", () => {
    expect(Number.isNaN(parsePriceHistoryTimestamp("not a date"))).toBe(true);
    expect(Number.isNaN(parsePriceHistoryTimestamp("Frob 32 2026 01: +0"))).toBe(true);
    expect(Number.isNaN(parsePriceHistoryTimestamp(null))).toBe(true);
    expect(Number.isNaN(parsePriceHistoryTimestamp(undefined))).toBe(true);
  });
});

describe("fetchSteamPriceHistory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses string timestamps and volume from the pricehistory payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          `\n5\n` +
          `{"success":true,"prices":[` +
          `["May 27 2026 01: +0",0.461,"290"],` +
          `["Aug 08 2026 14: +0",0.157,"1"]` +
          `]}`,
      } as Response),
    );

    const result = await fetchSteamPriceHistory("Iron Ingot", "USD");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.points).toHaveLength(2);
      expect(result.points[0].timestamp).toBe(Date.UTC(2026, 4, 27, 1) / 1000);
      expect(result.points[0].price).toBeCloseTo(0.461);
      expect(result.points[0].volume).toBe(290);
      expect(result.points[1].timestamp).toBe(Date.UTC(2026, 7, 8, 14) / 1000);
      expect(result.points[1].volume).toBe(1);
    }
  });

  it("reports parse error on malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => `not json at all`,
      } as Response),
    );

    const result = await fetchSteamPriceHistory("Iron Ingot", "USD");
    expect(result).toEqual({ ok: false, status: 200, reason: "parse" });
  });

  it("classifies HTTP 400 as unauthorized (Cookie 失效/未登录)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => `{"success":false}`,
      } as Response),
    );

    const result = await fetchSteamPriceHistory("Iron Ingot", "USD", "sessionid=expired");
    expect(result).toEqual({ ok: false, status: 400, reason: "unauthorized" });
  });

  it("sends the configured Cookie header when a cookie is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `{"success":true,"prices":[["May 27 2026 01: +0",0.461,"290"]]}`,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fetchSteamPriceHistory("Iron Ingot", "USD", "sessionid=abc; steamLoginSecure=xyz");
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Cookie).toBe("sessionid=abc; steamLoginSecure=xyz");
  });

  it("omits the Cookie header when no cookie is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `{"success":true,"prices":[["May 27 2026 01: +0",0.461,"290"]]}`,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fetchSteamPriceHistory("Iron Ingot", "USD");
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Cookie).toBeUndefined();
  });
});
