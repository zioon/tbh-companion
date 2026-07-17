import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoClassifyService } from "../../src/main/services/AutoClassifyService";
import { ChestDropTracker } from "../../src/core/chestDropTracker";
import { BoxOpenTracker } from "../../src/core/boxOpenTracker";
import type { BoxTimerCatalogEntry } from "../../shared/types";

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Fixed system time (ms). Drop/open wallTime values (seconds) are small (1.0, 2.0, ...)
// so drops at wallTime=1.0 → droppedAtMs=1000; with system time pinned at 10_000ms,
// queue items (TTL ≥ 90s) are NOT expired at dequeue time, letting FIFO matching work.
// Without fake timers, Date.now() (~1.7e12 ms) would expire every test-fixture drop
// instantly since droppedAtMs (~1000) is decades in the past.
const FIXED_NOW_MS = 10_000;

function makeService(opts: {
  enabled?: boolean;
  autoOpen?: { common: number; stageBoss: number; actBoss: number } | null;
  catalog?: BoxTimerCatalogEntry[];
  currentStageKey?: number | null;
  broadcast?: (channel: string, payload: unknown) => void;
} = {}) {
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  // `service` is assigned after construction; closures below read it at call time.
  // This breaks the chicken-and-egg between trackers (constructed with callbacks
  // that reference the service) and the service (constructed with the trackers).
  let service: AutoClassifyService | undefined;
  const chestDropTracker = new ChestDropTracker({
    onDrop: (e) => service?.handleChestDrop(e),
  });
  const boxOpenTracker = new BoxOpenTracker({
    onUnclassified: (entries) => service?.handleUnclassifiedBatch(entries),
  });
  service = new AutoClassifyService({
    chestDropTracker,
    boxOpenTracker,
    chestService: {
      getAutoOpenSeconds: () => opts.autoOpen ?? { common: 300, stageBoss: 600, actBoss: 60 },
    },
    stageBoxCatalog: () => opts.catalog ?? [],
    getCurrentStageKey: () => opts.currentStageKey ?? null,
    broadcast: (channel, payload) => {
      broadcasts.push({ channel, payload });
      opts.broadcast?.(channel, payload);
    },
  });
  if (opts.enabled) service.setEnabled(true);
  return { service, chestDropTracker, boxOpenTracker, broadcasts };
}

const CATALOG: BoxTimerCatalogEntry[] = [
  {
    boxId: 920151,
    name: "Stage Boss Box 5",
    level: 5,
    idealStageKey: 1105,
    idealStageLabel: "1-1-5",
    defaultIdealStageKey: 1105,
    defaultIdealStageLabel: "1-1-5",
    idealStageIsCustom: false,
    farmStageOptions: [{ stageKey: 1105, label: "1-1-5" }],
    dropStageRangeLabel: "1-1-5",
    cooldownSeconds: 600,
    cooldownIsCustom: false,
    enabled: true,
    notifyWhenReady: true,
  },
];

describe("AutoClassifyService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when disabled", () => {
    const { chestDropTracker, boxOpenTracker, broadcasts } = makeService({ enabled: false });
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    expect(broadcasts).toEqual([]);
  });

  it("matches unclassified opens to the queued drop via FIFO", () => {
    const { chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop a rare chest on stage 1105 → queue item with boxKey "rare:5"
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    // Open it (lands in unclassified)
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    // The item should have been reclassified to "rare:5"
    const stats = boxOpenTracker.getStats(100, null);
    expect(stats.find((s) => s.boxKey === "rare:5")).toBeTruthy();
    expect(stats.find((s) => s.boxKey === "unclassified")).toBeFalsy();
  });

  it("prompts when queue is empty and auto-classify is enabled", () => {
    const { boxOpenTracker, broadcasts } = makeService({
      enabled: true,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    expect(broadcasts.find((b) => b.channel === "loot:prompt:classify")).toBeTruthy();
  });

  it("accumulates subsequent batches into the pending prompt", () => {
    const { boxOpenTracker, broadcasts } = makeService({
      enabled: true,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    // First batch broadcasts a prompt
    expect(broadcasts.filter((b) => b.channel === "loot:prompt:classify")).toHaveLength(1);
    // Second batch before resolve should NOT broadcast again (accumulates into pending)
    boxOpenTracker.recordOpen("unclassified", 200, "Shield", "COMMON", 1, 3.0);
    boxOpenTracker.flushUnclassified();
    expect(broadcasts.filter((b) => b.channel === "loot:prompt:classify")).toHaveLength(1);
  });

  it("resolves pending prompt by reclassifying all accumulated items", () => {
    const { service, boxOpenTracker, broadcasts } = makeService({
      enabled: true,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    boxOpenTracker.recordOpen("unclassified", 200, "Shield", "COMMON", 1, 3.0);
    boxOpenTracker.flushUnclassified();
    const prompt = broadcasts.find((b) => b.channel === "loot:prompt:classify")!;
    const payload = prompt.payload as { promptId: number; itemKeys: number[] };
    service.resolvePrompt({
      promptId: payload.promptId,
      category: "common",
      itemKeys: payload.itemKeys,
    });
    const stats = boxOpenTracker.getStats(100, null);
    // Items should have moved from unclassified to common (level 5 from stage)
    const commonStats = stats.find((s) => s.boxKey === "common:5");
    expect(commonStats).toBeTruthy();
    expect(commonStats?.totalOpens).toBe(2);
  });

  it("clears queue and pending when disabled", () => {
    const { service, chestDropTracker, boxOpenTracker, broadcasts } = makeService({
      enabled: true,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    // First open matches the queued drop (no prompt)
    expect(broadcasts.filter((b) => b.channel === "loot:prompt:classify")).toHaveLength(0);
    service.setEnabled(false);
    // After disable, new events should not trigger anything
    chestDropTracker.recordLiveChestDrop("rare", 3.0);
    boxOpenTracker.recordOpen("unclassified", 200, "Shield", "COMMON", 1, 4.0);
    boxOpenTracker.flushUnclassified();
    expect(broadcasts.filter((b) => b.channel === "loot:prompt:classify")).toHaveLength(0);
  });

  it("prunes expired queue items on tick", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 0, stageBoss: 0, actBoss: 0 }, // 90s TTL
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    // tick() prunes expired items; with FIXED_NOW_MS=10_000 and droppedAtMs=1000,
    // TTL=90s → expiresAtMs=91000 > 10000, so item survives. Verify no exceptions.
    expect(() => service.tick()).not.toThrow();
  });
});
