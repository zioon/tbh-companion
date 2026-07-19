import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { formatPriceRefreshMessage } from "../../src/renderer/lib/formatPriceRefreshMessage";

// Stand-in for i18next's t. Returns the key (optionally with interpolation
// markers stripped) so tests can assert on substrings without depending on the
// actual English copy in market.json.
const t = ((key: string, opts?: Record<string, unknown>) => {
  const params = opts as Record<string, unknown> | undefined;
  if (key === "refreshMessage.noop" && params && typeof params.count === "number") {
    return `All ${params.count} items are up to date (updated within 24h). Nothing to fetch.`;
  }
  if (key === "refreshMessage.noopOne") {
    return "All 1 item is up to date (updated within 24h). Nothing to fetch.";
  }
  if (key === "refreshMessage.queued") return "queued";
  if (key === "refreshMessage.noInventory") return "No inventory loaded";
  if (key === "refreshMessage.alreadyRunning") return "Refresh already in progress.";
  if (key === "refreshMessage.cancelled") return " (cancelled)";
  if (key === "refreshMessage.failed") {
    return `Refresh failed: ${params?.error ?? ""}.`;
  }
  if (key === "refreshMessage.success") {
    return `Priced ${params?.priced}, skipped ${params?.skipped} fresh, ${params?.failed} failed${params?.stopMsg ?? ""}.`;
  }
  return key;
}) as unknown as TFunction<"market">;

describe("formatPriceRefreshMessage", () => {
  it("describes a queued refresh", () => {
    expect(
      formatPriceRefreshMessage(t, {
        ok: true,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "completed",
        queued: true,
      }),
    ).toContain("queued");
  });

  it("describes a no-op when all items are fresh", () => {
    expect(
      formatPriceRefreshMessage(t, {
        ok: true,
        priced: 0,
        skipped: 5,
        failed: 0,
        stopped: "completed",
        noop: true,
      }),
    ).toBe("All 5 items are up to date (updated within 24h). Nothing to fetch.");
  });

  it("describes missing inventory", () => {
    expect(
      formatPriceRefreshMessage(t, {
        ok: true,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "completed",
        ownedTargets: 0,
      }),
    ).toContain("No inventory loaded");
  });

  it("describes a normal completed refresh", () => {
    expect(
      formatPriceRefreshMessage(t, {
        ok: true,
        priced: 2,
        skipped: 3,
        failed: 1,
        stopped: "completed",
      }),
    ).toBe("Priced 2, skipped 3 fresh, 1 failed.");
  });

  it("describes cancellation and failures", () => {
    expect(
      formatPriceRefreshMessage(t, {
        ok: true,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "cancelled",
      }),
    ).toContain("cancelled");
    expect(
      formatPriceRefreshMessage(t, {
        ok: false,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "completed",
        error: "network",
      }),
    ).toContain("Refresh failed");
  });
});
