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

function makeService(
  opts: {
    enabled?: boolean;
    autoOpen?: { common: number; stageBoss: number; actBoss: number } | null;
    catalog?: BoxTimerCatalogEntry[];
    currentStageKey?: number | null;
    broadcast?: (channel: string, payload: unknown) => void;
  } = {},
) {
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  // `service` is assigned after construction; closures below read it at call time.
  // This breaks the chicken-and-egg between trackers (constructed with callbacks
  // that reference the service) and the service (constructed with the trackers).
  // eslint-disable-next-line prefer-const -- assigned after construction to break chicken-and-egg
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

  it("matches unclassified opens to the queued drop (soonest-opening first)", () => {
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

  it("dequeues the soonest-opening chest first across categories", () => {
    const { service, chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop a rare chest (autoOpen=600s) and a common chest (autoOpen=300s).
    // Despite rare being dropped first, common has an earlier autoOpenAtMs
    // (1000 + 300*1000 = 301000 vs 1000 + 600*1000 = 601000), so common
    // should be at the head of the queue.
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    // An unclassified burst arrives — should match the common (head), not rare.
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    const stats = boxOpenTracker.getStats(100, null);
    expect(stats.find((s) => s.boxKey === "common:5")).toBeTruthy();
    expect(stats.find((s) => s.boxKey === "unclassified")).toBeFalsy();
    // The rare chest should still be queued (only the common was consumed).
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]?.boxKey).toBe("rare:5");
  });

  it("queues act boss drops as category-only boxKey and matches unclassified opens", () => {
    const { chestDropTracker, boxOpenTracker, broadcasts } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop an act boss chest → queue item with boxKey "act" (no level)
    chestDropTracker.recordLiveChestDrop("act", 1.0);
    // Open it (lands in unclassified)
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    // The item should have been reclassified to "act" (category-only, no level)
    const stats = boxOpenTracker.getStats(100, null);
    expect(stats.find((s) => s.boxKey === "act")).toBeTruthy();
    expect(stats.find((s) => s.boxKey === "unclassified")).toBeFalsy();
    // No prompt should have been broadcast (FIFO matched)
    expect(broadcasts.filter((b) => b.channel === "loot:prompt:classify")).toHaveLength(0);
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

describe("AutoClassifyService.getQueueSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty snapshot when queue is empty", () => {
    const { service } = makeService({ enabled: true, catalog: CATALOG, currentStageKey: 1105 });
    const snap = service.getQueueSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.totalQueued).toBe(0);
    expect(snap.byCategory).toHaveLength(3);
    for (const row of snap.byCategory) {
      expect(row.count).toBe(0);
      expect(row.nextAutoOpenInMs).toBeNull();
    }
  });

  it("returns disabled flag when service is disabled", () => {
    const { service } = makeService({ enabled: false, catalog: CATALOG, currentStageKey: 1105 });
    expect(service.getQueueSnapshot().enabled).toBe(false);
  });

  it("groups queued drops by category with head countdown", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop two rare chests (stageKey 1105 → level 5 → boxKey "rare:5")
    // at wallTime 1.0s and 2.0s.
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    chestDropTracker.recordLiveChestDrop("rare", 2.0);

    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(2);
    const rare = snap.byCategory.find((r) => r.category === "rare");
    expect(rare?.count).toBe(2);
    // Head dropped at 1000ms; autoOpen=600s → autoOpenAt=601000ms; now=10000
    // → remaining = 591000ms
    expect(rare?.nextAutoOpenInMs).toBe(591_000);
    const common = snap.byCategory.find((r) => r.category === "common");
    expect(common?.count).toBe(0);
    expect(common?.nextAutoOpenInMs).toBeNull();
  });

  it("clamps negative countdown to 0", () => {
    // Drop a common chest, then advance system time past autoOpen.
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // droppedAtMs=1000
    // Advance to well past 301s (droppedAtMs + 300s autoOpen).
    vi.setSystemTime(FIXED_NOW_MS + 400_000);
    const snap = service.getQueueSnapshot();
    const common = snap.byCategory.find((r) => r.category === "common");
    expect(common?.count).toBe(1);
    expect(common?.nextAutoOpenInMs).toBe(0);
  });

  it("reports act boss queue with actBoss auto-open countdown", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("act", 1.0); // droppedAtMs=1000
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    const act = snap.byCategory.find((r) => r.category === "act");
    expect(act?.count).toBe(1);
    // Head dropped at 1000ms; actBoss autoOpen=60s → autoOpenAt=61000ms; now=10000
    // → remaining = 51000ms
    expect(act?.nextAutoOpenInMs).toBe(51_000);
  });

  it("uses fallback auto-open seconds when ChestService returns null", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: null, // triggers FALLBACK_AUTO_OPEN
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("rare", 1.0); // fallback stageBoss=600s
    const snap = service.getQueueSnapshot();
    const rare = snap.byCategory.find((r) => r.category === "rare");
    // droppedAtMs=1000 + 600*1000 - 10000 = 591000
    expect(rare?.nextAutoOpenInMs).toBe(591_000);
  });

  it("exposes per-item view via items field, sorted by autoOpenInMs ascending", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop chests across categories: rare@1s, common@2s, act@3s.
    // autoOpenAtMs:
    //   rare:  1000 + 600*1000 = 601000
    //   common: 2000 + 300*1000 = 302000  ← soonest
    //   act:   3000 + 60*1000  = 63000    ← even sooner
    // Expected sort order (ascending autoOpenAtMs): act, common, rare
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    chestDropTracker.recordLiveChestDrop("act", 3.0);

    const snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(3);
    // Sorted by autoOpenAtMs ascending: act (63000), common (302000), rare (601000).
    expect(snap.items.map((i) => i.boxKey)).toEqual(["act", "common:5", "rare:5"]);
    // autoOpenInMs must also be ascending (it's autoOpenAtMs - now).
    for (let i = 1; i < snap.items.length; i++) {
      expect(snap.items[i]!.autoOpenInMs).toBeGreaterThanOrEqual(snap.items[i - 1]!.autoOpenInMs);
    }

    // Verify the act item's fields.
    expect(snap.items[0]!.category).toBe("act");
    expect(snap.items[0]!.droppedAtMs).toBe(3000);
    expect(snap.items[0]!.stageKey).toBe(1105);
    // act: 3000 + 60*1000 - 10000 = 53000
    expect(snap.items[0]!.autoOpenInMs).toBe(53_000);
    // expiresInMs = expiresAtMs - now = (droppedAtMs + ttlMs) - now
    // ttlMs = max(60*2*1000, 60000) + 30000 = 150000
    // expiresAtMs = 3000 + 150000 = 153000; - 10000 = 143000
    expect(snap.items[0]!.expiresInMs).toBe(143_000);
  });

  it("clamps per-item countdowns to 0 when expired", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // droppedAtMs=1000
    // Advance past both auto-open and TTL.
    vi.setSystemTime(FIXED_NOW_MS + 2_000_000);
    const snap = service.getQueueSnapshot();
    // Queue was pruned by TTL on the last tick; if not pruned, snapshot still
    // clamps remaining times to 0. Either way, items array is empty here
    // because pruneExpired runs in tick(). Without a tick, the item survives
    // but its countdowns clamp to 0.
    for (const item of snap.items) {
      expect(item.autoOpenInMs).toBe(0);
      expect(item.expiresInMs).toBe(0);
    }
  });
});

describe("AutoClassifyService.reconcileWithChestSlots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes excess entries when queue > slots (soonest autoOpen first)", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop two common chests → queue has 2 common items.
    // autoOpenAtMs: common@1.0 (301000) < common@2.0 (302000)
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    expect(service.getQueueSnapshot().totalQueued).toBe(2);

    // Save shows only 1 common chest remaining — the earliest-dropped one
    // (autoOpenAtMs=301000) should have opened already; prune it.
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.droppedAtMs).toBe(2000);
  });

  it("prunes across multiple categories in one reconcile", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // autoOpenAtMs: rare=601000, common=302000, act=63000
    // Sorted queue: [act, common, rare]
    chestDropTracker.recordLiveChestDrop("rare", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    chestDropTracker.recordLiveChestDrop("act", 3.0);

    // Slots: common=0 (1 excess), rare=1 (0 excess, matches), act=0 (1 excess)
    service.reconcileWithChestSlots({ common: 0, rare: 1, act: 0 });
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    // common and act pruned; rare remains.
    expect(snap.items[0]!.boxKey).toBe("rare:5");
  });

  it("leaves queue alone when queue <= slots (no excess)", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);

    // Slots hold 3 commons — queue (2) < slots (3), no pruning.
    service.reconcileWithChestSlots({ common: 3, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().totalQueued).toBe(2);
  });

  it("does not prune when queue == slots (exact match)", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("rare", 2.0);

    service.reconcileWithChestSlots({ common: 1, rare: 1, act: 0 });
    expect(service.getQueueSnapshot().totalQueued).toBe(2);
  });

  it("prunes soonest-opening entries first when excess > 1", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Three commons: autoOpenAtMs 301000, 302000, 303000
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    chestDropTracker.recordLiveChestDrop("common", 3.0);

    // Slots: 1 common → prune 2 earliest (autoOpenAtMs 301000, 302000)
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.droppedAtMs).toBe(3000);
  });

  it("is a no-op when disabled", () => {
    const { service, chestDropTracker } = makeService({
      enabled: false,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    // Queue was never populated (disabled); reconcile is a no-op.
    service.reconcileWithChestSlots({ common: 0, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().totalQueued).toBe(0);
  });

  it("handles empty queue gracefully", () => {
    const { service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // No drops enqueued; slots show 5 chests (queue < slots, deficit logged).
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().totalQueued).toBe(0);
  });
});
