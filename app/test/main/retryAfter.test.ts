import { describe, it, expect } from "vitest";
import { parseRetryAfterMs } from "../../src/main/services/retryAfter";

function resWithHeader(header: string | null): Response {
  const headers = new Headers();
  if (header != null) headers.set("retry-after", header);
  return new Response(null, { status: 429, headers });
}

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterMs(resWithHeader("30"))).toBe(30_000);
  });

  it("parses HTTP-date in the future", () => {
    const future = new Date(Date.now() + 60_000);
    const ms = parseRetryAfterMs(resWithHeader(future.toUTCString()));
    // Allow ±5s wiggle for test runtime.
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("returns undefined when the date is in the past", () => {
    const past = new Date(Date.now() - 1000);
    expect(parseRetryAfterMs(resWithHeader(past.toUTCString()))).toBeUndefined();
  });

  it("returns undefined when the header is missing", () => {
    expect(parseRetryAfterMs(resWithHeader(null))).toBeUndefined();
  });

  it("returns undefined for unparseable values", () => {
    expect(parseRetryAfterMs(resWithHeader("not a date"))).toBeUndefined();
  });

  it("caps absurdly large values at 5 minutes", () => {
    expect(parseRetryAfterMs(resWithHeader("3600"))).toBe(5 * 60 * 1000);
  });

  it("returns undefined for zero or negative values", () => {
    expect(parseRetryAfterMs(resWithHeader("0"))).toBeUndefined();
    expect(parseRetryAfterMs(resWithHeader("-5"))).toBeUndefined();
  });
});
