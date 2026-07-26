import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoClassifyService } from "../../src/main/services/AutoClassifyService";
import { ChestDropTracker } from "../../src/core/chestDropTracker";
import { BoxOpenTracker } from "../../src/core/boxOpenTracker";
import type { BoxTimerCatalogEntry } from "../../shared/types";
import type { StageBoxTrackerRoute } from "../../src/core/stageBoxTracker";

// Hoist the log mocks so test bodies can inspect call counts for log-suppression checks.
const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../src/main/log", () => ({
  createLogger: () => logMocks,
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
    /**
     * Mutable ref for autoOpen, allowing tests to change autoOpenSeconds
     * mid-session (e.g. to simulate rune purchases or FALLBACK→real-value
     * transitions). When provided, takes precedence over `autoOpen`.
     */
    autoOpenRef?: { value: { common: number; stageBoss: number; actBoss: number } | null };
    catalog?: BoxTimerCatalogEntry[];
    actBossRoutes?: StageBoxTrackerRoute[];
    commonRoutes?: StageBoxTrackerRoute[];
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
      getAutoOpenSeconds: () => {
        if (opts.autoOpenRef) return opts.autoOpenRef.value;
        return opts.autoOpen ?? { common: 300, stageBoss: 600, actBoss: 60 };
      },
    },
    stageBoxCatalog: () => opts.catalog ?? [],
    actBossRoutes: () => opts.actBossRoutes ?? ACT_BOSS_ROUTES,
    commonRoutes: () => opts.commonRoutes ?? COMMON_ROUTES,
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

// Mock LEGENDARY act boss tracker routes mirroring data/stage_boxes.json.
// Act bosses drop on stage 10 of each act's final stage (not stage 9).
// Lv1 ← 1110 (Normal 1-10), Lv20 ← 1210 (Normal 2-10), Lv60 ← 3110 (Hell 1-10),
// Lv90 ← 4210/4310 (Torment 2-10 / 3-10).
// Used by AutoClassifyService.levelFromRoutes to infer act chest level.
const ACT_BOSS_ROUTES: StageBoxTrackerRoute[] = [
  {
    boxId: 930101,
    level: 1,
    idealStageKey: 1110,
    idealStageLabel: "Normal 1-10",
    dropStageKeys: [1110],
    dropStageRangeLabel: "Normal 1-10",
  },
  {
    boxId: 930201,
    level: 20,
    idealStageKey: 1210,
    idealStageLabel: "Normal 2-10",
    dropStageKeys: [1210],
    dropStageRangeLabel: "Normal 2-10",
  },
  {
    boxId: 930601,
    level: 60,
    idealStageKey: 3110,
    idealStageLabel: "Hell 1-10",
    dropStageKeys: [3110],
    dropStageRangeLabel: "Hell 1-10",
  },
  {
    boxId: 930901,
    level: 90,
    idealStageKey: 4210,
    idealStageLabel: "Torment 2-10",
    dropStageKeys: [4210, 4310],
    dropStageRangeLabel: "Torment 2-10 · Torment 3-10",
  },
];

// Mock COMMON normal monster box tracker routes mirroring data/stage_boxes.json.
// COMMON chests share the same dropStageKeys as RARE stage boss boxes, but have
// different level numbering at low levels (Lv1/5/10 vs RARE Lv4/5/7). Only the
// low-level entries that differ from RARE are included here; from Lv15 onwards
// COMMON and RARE levels coincide. Used by AutoClassifyService.levelFromRoutes
// to infer common chest level.
const COMMON_ROUTES: StageBoxTrackerRoute[] = [
  {
    boxId: 910011,
    level: 1,
    idealStageKey: 1101,
    idealStageLabel: "Normal 1-1",
    dropStageKeys: [1101, 1102, 1103],
    dropStageRangeLabel: "Normal 1-1 – 1-3",
  },
  {
    boxId: 910051,
    level: 5,
    idealStageKey: 1104,
    idealStageLabel: "Normal 1-4",
    dropStageKeys: [1104, 1105, 1106, 1107],
    dropStageRangeLabel: "Normal 1-4 – 1-7",
  },
  {
    boxId: 910101,
    level: 10,
    idealStageKey: 1108,
    idealStageLabel: "Normal 1-8",
    dropStageKeys: [1108, 1109, 1201, 1202],
    dropStageRangeLabel: "Normal 1-8 – 1-9 · Normal 2-1 – 2-2",
  },
  {
    boxId: 910151,
    level: 15,
    idealStageKey: 1203,
    idealStageLabel: "Normal 2-3",
    dropStageKeys: [1203, 1204, 1205, 1206, 1207],
    dropStageRangeLabel: "Normal 2-3 – 2-7",
  },
];

describe("AutoClassifyService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    // Clear log mock call history so per-test assertions on warn/info calls
    // (e.g. fallback-path warn log) only see calls from the current test.
    vi.clearAllMocks();
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

  it("queues act boss drops with per-act level boxKey and matches unclassified opens", () => {
    const { chestDropTracker, boxOpenTracker, broadcasts } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      // stageKey 1110 (Normal 1-10) → matches Lv1 route → boxKey "act:1".
      currentStageKey: 1110,
    });
    // Drop an act boss chest → queue item with boxKey "act:1" (per-act level)
    chestDropTracker.recordLiveChestDrop("act", 1.0);
    // Open it (lands in unclassified)
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    // The item should have been reclassified to "act:1"
    const stats = boxOpenTracker.getStats(100, null);
    expect(stats.find((s) => s.boxKey === "act:1")).toBeTruthy();
    expect(stats.find((s) => s.boxKey === "unclassified")).toBeFalsy();
    // No prompt should have been broadcast (FIFO matched)
    expect(broadcasts.filter((b) => b.channel === "loot:prompt:classify")).toHaveLength(0);
  });

  it("resolves act boss level from LEGENDARY catalog dropStageKeys", () => {
    // stageKey 1210 (Normal 2-10) → matches Lv20 route → boxKey "act:20".
    const { chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1210,
    });
    chestDropTracker.recordLiveChestDrop("act", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    const stats = boxOpenTracker.getStats(100, null);
    expect(stats.find((s) => s.boxKey === "act:20")).toBeTruthy();
    expect(stats.find((s) => s.boxKey === "act:1")).toBeFalsy();
  });

  it("resolves act boss level for Hell stages (Lv60)", () => {
    // stageKey 3110 (Hell 1-10) → matches Lv60 route → boxKey "act:60".
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 3110,
    });
    chestDropTracker.recordLiveChestDrop("act", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]?.boxKey).toBe("act:60");
  });

  it("resolves act boss level for Torment 3-10 (Lv90, shared with Torment 2-10)", () => {
    // stageKey 4310 (Torment 3-10) → matches Lv90 route → boxKey "act:90".
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 4310,
    });
    chestDropTracker.recordLiveChestDrop("act", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]?.boxKey).toBe("act:90");
  });

  it("falls back to category-only boxKey when act boss routes are empty", () => {
    const { chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      actBossRoutes: [], // no routes → levelFromRoutes returns null
      currentStageKey: 1110,
    });
    chestDropTracker.recordLiveChestDrop("act", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    const stats = boxOpenTracker.getStats(100, null);
    // No routes → level is null → boxKey is just "act" (no level suffix).
    expect(stats.find((s) => s.boxKey === "act")).toBeTruthy();
  });

  it("resolves common chest level from COMMON tracker routes (Lv1 on stage 1101)", () => {
    // stageKey 1101 (Normal 1-1) → COMMON Lv1 route → boxKey "common:1".
    // This is the key fix: previously common used the RARE catalog and returned
    // Lv4 (Stage Boss Box 4 also drops on 1101-1103), but COMMON chests have
    // their own level numbering (Lv1, not Lv4).
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1101,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]?.boxKey).toBe("common:1");
  });

  it("resolves common chest level for Lv5 on stage 1104", () => {
    // stageKey 1104 (Normal 1-4) → COMMON Lv5 route → boxKey "common:5".
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1104,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]?.boxKey).toBe("common:5");
  });

  it("resolves common chest level for Lv10 on stage 1108", () => {
    // stageKey 1108 (Normal 1-8) → COMMON Lv10 route → boxKey "common:10".
    // Previously this returned Lv7 (RARE Stage Boss Box 7 level), but COMMON
    // chests use Lv10 on the same stages.
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1108,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]?.boxKey).toBe("common:10");
  });

  it("falls back to category-only boxKey when common routes are empty", () => {
    const { chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      commonRoutes: [], // no routes → levelFromRoutes returns null
      currentStageKey: 1101,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    const stats = boxOpenTracker.getStats(100, null);
    // No routes → level is null → boxKey is just "common" (no level suffix).
    expect(stats.find((s) => s.boxKey === "common")).toBeTruthy();
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
    // Tail chained from head: autoOpenAtMs = 601000 + 600*1000 = 1201000; now=10000
    // → remaining = 1191000ms
    expect(rare?.lastAutoOpenInMs).toBe(1_191_000);
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
    // Sorted by autoOpenAtMs ascending: act:1 (63000), common:5 (302000), rare:5 (601000).
    expect(snap.items.map((i) => i.boxKey)).toEqual(["act:1", "common:5", "rare:5"]);
    // autoOpenInMs must also be ascending (it's autoOpenAtMs - now). Under the
    // serial-queue model every queued chest has a concrete autoOpenAtMs, so
    // autoOpenInMs is always a number — no "waiting" state.
    for (let i = 1; i < snap.items.length; i++) {
      expect(snap.items[i]!.autoOpenInMs).toBeGreaterThanOrEqual(snap.items[i - 1]!.autoOpenInMs);
    }

    // Verify the act item's fields.
    expect(snap.items[0]!.category).toBe("act");
    expect(snap.items[0]!.droppedAtMs).toBe(3000);
    expect(snap.items[0]!.stageKey).toBe(1105);
    // act: 3000 + 60*1000 - 10000 = 53000
    expect(snap.items[0]!.autoOpenInMs).toBe(53_000);
    // expiresInMs = expiresAtMs - now. TTL is anchored to autoOpenAtMs:
    //   autoOpenAtMs = 3000 + 60*1000 = 63000
    //   ttlMs = max(60*1000, 60000) + 30000 = 90000
    //   expiresAtMs = 63000 + 90000 = 153000; - 10000 (now) = 143000
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
    // autoOpenAtMs: common@1.0 (301000) < common@2.0 (601000, chained from 1st)
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    expect(service.getQueueSnapshot().totalQueued).toBe(2);

    // Save shows only 1 common chest remaining — the soonest-autoOpen one
    // (autoOpenAtMs=301000) should have opened already; prune it.
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.droppedAtMs).toBe(2000);
    // Serial-queue invariant: remaining item keeps its original autoOpenAtMs
    // (601000, chained from the pruned head), not re-timer'd.
    // autoOpenInMs = 601000 - 10000 (now) = 591000.
    expect(snap.items[0]!.autoOpenInMs).toBe(591_000);
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
    // Three commons: autoOpenAtMs 301000, 601000 (chained), 901000 (chained)
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    chestDropTracker.recordLiveChestDrop("common", 3.0);

    // Slots: 1 common → prune 2 earliest (autoOpenAtMs 301000, 601000)
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

  it("suppresses the 'queue < slots' info log when slots are unchanged across high-frequency reconcile calls", () => {
    const { service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    logMocks.info.mockClear();
    // Simulate 5 Hz live-snapshot reconcile: same slots, called repeatedly.
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    const firstCallInfoCount = logMocks.info.mock.calls.filter((c) =>
      String(c[0]).includes("queue (0) < slots (5)"),
    ).length;
    expect(firstCallInfoCount).toBe(1); // first call logs the deficit
    // Subsequent calls with same slots must NOT re-log the deficit.
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    const totalInfoCount = logMocks.info.mock.calls.filter((c) =>
      String(c[0]).includes("queue (0) < slots (5)"),
    ).length;
    expect(totalInfoCount).toBe(1); // still 1 — suppressed on unchanged slots
    // When slots change, the new deficit IS logged.
    service.reconcileWithChestSlots({ common: 3, rare: 0, act: 0 });
    const afterChangeCount = logMocks.info.mock.calls.filter((c) =>
      String(c[0]).includes("queue (0) < slots (3)"),
    ).length;
    expect(afterChangeCount).toBe(1);
  });

  it("re-logs the deficit after disable/re-enable (lastReconcileSlots reset)", () => {
    const { service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    service.setEnabled(false);
    service.setEnabled(true);
    logMocks.info.mockClear();
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    const reloggedCount = logMocks.info.mock.calls.filter((c) =>
      String(c[0]).includes("queue (0) < slots (5)"),
    ).length;
    expect(reloggedCount).toBe(1); // first call after re-enable logs again
  });
});

describe("AutoClassifyService.liveSlots tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    // Clear log mock call history so per-test assertions on warn/info calls
    // (e.g. fallback-path warn log) only see calls from the current test.
    // Without this, warn calls from earlier tests in this describe block
    // (e.g. "falls back to head...") leak into later tests' assertions.
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("liveSlots is null before the first save parse completes", () => {
    const { service } = makeService({
      enabled: true,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    expect(service.getQueueSnapshot().liveSlots).toBeNull();
  });

  it("reconcileWithChestSlots recalibrates liveSlots to save's absolute values", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop two common chests — liveSlots is still null so no increment happens.
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    expect(service.getQueueSnapshot().liveSlots).toBeNull();

    // Save parse arrives with absolute slot counts: 3 common, 1 rare, 0 act.
    // liveSlots should now hold these exact values (recalibration discards
    // any pending real-time adjustments — there are none here since liveSlots
    // was null before).
    service.reconcileWithChestSlots({ common: 3, rare: 1, act: 0 });
    expect(service.getQueueSnapshot().liveSlots).toEqual({
      common: 3,
      rare: 1,
      act: 0,
    });
  });

  it("handleChestDrop increments liveSlots[cat] after a drop", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Initialize liveSlots from save (common=2, rare=1, act=0).
    service.reconcileWithChestSlots({ common: 2, rare: 1, act: 0 });
    // Drop a common chest → liveSlots.common should increment to 3.
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({
      common: 3,
      rare: 1,
      act: 0,
    });
    // Drop a rare chest → liveSlots.rare should increment to 2.
    chestDropTracker.recordLiveChestDrop("rare", 2.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({
      common: 3,
      rare: 2,
      act: 0,
    });
  });

  it("tick decrements liveSlots[cat] for items whose autoOpenAtMs has elapsed", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Initialize liveSlots from save (common=2).
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    // Drop a common chest at wallTime=1.0s → droppedAtMs=1000,
    // autoOpenAtMs = 1000 + 300*1000 = 301000ms. liveSlots.common → 3.
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // Advance time past autoOpenAtMs (now > 301000).
    vi.setSystemTime(302_000);
    service.tick();
    // Item's autoOpenAtMs has elapsed → liveSlots.common decrements back to 2.
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });
  });

  it("processEvent (manual open via unclassified burst) decrements liveSlots[cat]", () => {
    const { service, chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Initialize liveSlots from save (common=2).
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    // Drop a common chest → liveSlots.common = 3.
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // Player manually opens the chest (unclassified burst) BEFORE autoOpenAtMs
    // elapses — processEvent dequeues the item and decrements liveSlots.
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });
  });

  it("does not double-decrement when auto-opened item is later dequeued by processEvent", () => {
    const { service, chestDropTracker, boxOpenTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Initialize liveSlots from save (common=2).
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    // Drop a common chest → liveSlots.common = 3.
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // Advance time past autoOpenAtMs and tick — auto-open detected,
    // liveSlots.common decrements to 2. Item is added to slotDecrementedItems WeakSet.
    vi.setSystemTime(302_000);
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });

    // Now the unclassified burst from the auto-open arrives — processEvent
    // dequeues the same item, but it's in slotDecrementedItems, so no decrement.
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 302.5);
    boxOpenTracker.flushUnclassified();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });
  });

  it("liveSlots is reset to null on disable", () => {
    const { service } = makeService({
      enabled: true,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    service.reconcileWithChestSlots({ common: 5, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 5, rare: 0, act: 0 });
    service.setEnabled(false);
    expect(service.getQueueSnapshot().liveSlots).toBeNull();
  });

  it("real-time adjustments are discarded on the next save recalibration", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // First save parse: common=2.
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    // Drop a chest → liveSlots.common = 3 (real-time adjustment).
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // Second save parse arrives with the ground truth: common=3 (the dropped
    // chest is still there, hasn't opened yet). Recalibration discards the
    // real-time adjustment and replaces it with the save's absolute value.
    service.reconcileWithChestSlots({ common: 3, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });
  });

  it("tick decrements liveSlots for every elapsed item, not just the global head (audit M1)", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Initialize liveSlots from save (common=2).
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    // Drop two common chests at wallTime 1.0s and 2.0s.
    // Serial-queue model:
    //   1st: queue empty → autoOpenAtMs = 1000 + 300*1000 = 301000
    //   2nd: tail=301000 → autoOpenAtMs = 301000 + 300*1000 = 601000
    // liveSlots.common increments to 4 (2 + 2 drops).
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 4, rare: 0, act: 0 });

    // Advance time past head's autoOpenAtMs (301000) but before tail's (601000).
    vi.setSystemTime(302_000);
    service.tick();
    // Head elapsed → liveSlots.common decrements to 3. Tail (601000) is still
    // in the future, so the loop breaks at it.
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // Advance time past tail's autoOpenAtMs (601000). Both items are now
    // elapsed. Head is in WeakSet (skip), tail is NOT in WeakSet → decrement.
    // This is the audit M1 fix: previously only the global head was checked,
    // so the tail's slot was never freed until a burst arrived or a save
    // parse reconciled. Now tick walks the elapsed prefix.
    vi.setSystemTime(602_000);
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });

    // Advance time past the head's TTL so pruneExpired removes it.
    // Head's expiresAtMs = 301000 + 330000 = 631000.
    vi.setSystemTime(632_000);
    service.tick();
    // Both items are in WeakSet → no decrement. pruneExpired removes the
    // expired head (expiresAtMs=631000 <= 632000). Queue is now [common@2.0s].
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });
    // Next tick: new head (common@2.0s) is already in WeakSet → no decrement.
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });
  });

  it("tick does not decrement tail before its autoOpenAtMs elapses (serial-queue)", () => {
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Initialize liveSlots from save (common=1).
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    // Drop two common chests → liveSlots.common = 3.
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs = 301000
    chestDropTracker.recordLiveChestDrop("common", 2.0); // autoOpenAtMs = 601000 (chained)
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // Advance to 302000ms — head's autoOpenAtMs (301000) has elapsed.
    vi.setSystemTime(302_000);
    service.tick();
    // Head auto-opened → liveSlots.common = 2. Tail (601000) is still in the
    // future, so the loop breaks before reaching it — no decrement for tail.
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });

    // Advance to 602000ms — tail's autoOpenAtMs (601000) has now elapsed.
    // tick walks the elapsed prefix: head is in WeakSet (skip), tail is
    // elapsed and not in WeakSet → decrement to 1.
    vi.setSystemTime(602_000);
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 1, rare: 0, act: 0 });

    // Verify the tail is still in queue (waiting for processEvent or TTL).
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(2); // both items still queued
    expect(snap.items[1]!.droppedAtMs).toBe(2000); // tail is the 2nd common
  });

  // ---------------------------------------------------------------------------
  // Plan A: autoOpenSeconds drift detection + queue recomputation.
  // Long-session defense: under the serial-queue model any per-item
  // autoOpenSeconds error accumulates down the tail (N × δ), so rune
  // purchases / FALLBACK→real-value transitions / save-driven updates must
  // trigger a full recomputation to prevent tail autoOpenAtMs from drifting
  // away from the real auto-open moment.
  // ---------------------------------------------------------------------------

  it("recalibrates queue autoOpenAtMs when autoOpenSeconds changes past the drift threshold", () => {
    // Start with autoOpen.common = 300s. Drop two common chests:
    //   1st: queue empty → autoOpenAtMs = 1000 + 300*1000 = 301000
    //   2nd: tail=301000 → autoOpenAtMs = 301000 + 300*1000 = 601000 (chained)
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    // now=10000. Verify pre-recalibration autoOpenInMs:
    //   head: 301000 - 10000 = 291000
    //   tail: 601000 - 10000 = 591000
    let snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(2);
    expect(snap.items[0]!.autoOpenInMs).toBe(291_000);
    expect(snap.items[1]!.autoOpenInMs).toBe(591_000);

    // Rune purchase: autoOpen.common 300s → 150s (50% change, well above 1%).
    autoOpenRef.value = { common: 150, stageBoss: 600, actBoss: 60 };
    // Trigger drift detection via a new drop. maybeRecalibrateQueue runs
    // BEFORE the new chest is enqueued, so the existing two items are
    // recomputed first, then the new chest chains onto the recomputed tail.
    // Recomputed (autoOpen.common=150):
    //   1st (dropped@1.0s): autoOpenAtMs = 1000 + 150*1000 = 151000
    //   2nd (dropped@2.0s): autoOpenAtMs = 151000 + 150*1000 = 301000 (chained)
    //   3rd (dropped@3.0s): autoOpenAtMs = 301000 + 150*1000 = 451000 (chained)
    chestDropTracker.recordLiveChestDrop("common", 3.0);
    snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(3);
    expect(snap.items[0]!.droppedAtMs).toBe(1000);
    expect(snap.items[0]!.autoOpenInMs).toBe(141_000); // 151000 - 10000
    expect(snap.items[1]!.droppedAtMs).toBe(2000);
    expect(snap.items[1]!.autoOpenInMs).toBe(291_000); // 301000 - 10000
    expect(snap.items[2]!.droppedAtMs).toBe(3000);
    expect(snap.items[2]!.autoOpenInMs).toBe(441_000); // 451000 - 10000
  });

  it("does not recalibrate when autoOpenSeconds changes are below the drift threshold", () => {
    // 300s → 302s is a 0.67% change — below the 1% threshold. Existing items
    // keep their original autoOpenAtMs (computed with 300s); only the new
    // chest enqueued after the change uses 302s.
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    // 1st item: autoOpenAtMs = 1000 + 300*1000 = 301000
    let snap = service.getQueueSnapshot();
    expect(snap.items[0]!.autoOpenInMs).toBe(291_000); // 301000 - 10000

    // Tiny drift (below threshold).
    autoOpenRef.value = { common: 302, stageBoss: 600, actBoss: 60 };
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(2);
    // 1st item NOT recomputed — still anchored to 301000 (autoOpenSeconds=300).
    expect(snap.items[0]!.droppedAtMs).toBe(1000);
    expect(snap.items[0]!.autoOpenInMs).toBe(291_000);
    // 2nd item enqueued with new autoOpen=302s, chained to existing tail:
    //   autoOpenAtMs = 301000 + 302*1000 = 603000
    expect(snap.items[1]!.droppedAtMs).toBe(2000);
    expect(snap.items[1]!.autoOpenInMs).toBe(593_000); // 603000 - 10000
  });

  it("recalibrates on reconcileWithChestSlots (save parse moment)", () => {
    // Save parse is the canonical moment when rune purchases become visible
    // to ChestService, so reconcileWithChestSlots also triggers drift
    // detection. This test confirms the path works without a new drop.
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // Drop a chest with autoOpen=300s → autoOpenAtMs = 301000.
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    // Change autoOpen WITHOUT dropping a new chest — only a save parse
    // arrives. reconcileWithChestSlots must detect drift and recompute.
    autoOpenRef.value = { common: 100, stageBoss: 600, actBoss: 60 };
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    // Recomputed: 1000 + 100*1000 = 101000. now=10000 → autoOpenInMs=91000.
    const snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]!.autoOpenInMs).toBe(91_000);
  });

  // ---------------------------------------------------------------------------
  // Plan C: burst-time window matching in processEvent.
  // When an unclassified burst arrives, find the queue item whose
  // autoOpenAtMs is closest to the burst's wall time and within ±15s grace.
  // Defends against: (a) manual opens of non-head chests, (b) autoOpenAtMs
  // drift after rune changes, (c) head auto-open detected by tick but burst
  // arriving slightly late. Falls back to head when no item is in-window.
  // ---------------------------------------------------------------------------

  it("matches the burst to a non-head tail item when its autoOpenAtMs is within the grace window", () => {
    // Queue: [common@1.0s (autoOpenAtMs=301000), common@2.0s (autoOpenAtMs=601000)]
    // Burst at wallTime=601.4s → burstMs=601400. Tail's delta=400ms (in window);
    // head's delta=300400ms (out of window). Tail should be consumed, head kept.
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    chestDropTracker.recordLiveChestDrop("common", 2.0); // autoOpenAtMs=601000 (chained)
    // Burst at wallTime=601.4s — simulates the player manually opening the
    // tail chest right when its auto-open timer elapses.
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 601.4);
    boxOpenTracker.flushUnclassified();
    // The burst should have matched the TAIL (autoOpenAtMs=601000, delta=400ms),
    // leaving the HEAD (autoOpenAtMs=301000) still queued.
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.droppedAtMs).toBe(1000); // head remains
  });

  it("falls back to head when no queue item is within the burst grace window", () => {
    // Queue: [common@1.0s (autoOpenAtMs=301000)]. Burst at wallTime=2.0s →
    // burstMs=2000. Head's delta=299000ms (>> 15000ms grace) → no match.
    // processEvent falls back to dequeueing the head and emits a warn log.
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    // Burst arrives ~299s before the head's autoOpenAtMs — way outside the
    // ±15s grace window. processEvent should fall back to the head.
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 2.0);
    boxOpenTracker.flushUnclassified();
    // Head consumed (fallback path), queue empty.
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(0);
    // Warn log emitted by the fallback path.
    expect(logMocks.warn).toHaveBeenCalledWith(expect.stringContaining("no queue item within"));
  });

  it("matches the head when burst arrives within grace of head's autoOpenAtMs (normal auto-open)", () => {
    // Queue: [common@1.0s (autoOpenAtMs=301000)]. Burst at wallTime=301.5s →
    // burstMs=301500. Head's delta=500ms (in window) → matched. This is the
    // normal auto-open path: head's autoOpenAtMs ≈ burst time.
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 301.5);
    boxOpenTracker.flushUnclassified();
    // Head consumed via the in-window match path (no warn fallback log).
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(0);
    const fallbackCalls = logMocks.warn.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("no queue item within"),
    );
    expect(fallbackCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // H1: Plan A drift threshold boundary (audit gap).
  // Threshold check is `drift < AUTO_OPEN_DRIFT_THRESHOLD` (strict <), so
  // exactly 1.00% drift triggers recompute; 0.99% does not.
  // ---------------------------------------------------------------------------

  it("Plan A: triggers recompute at exactly 1.00% drift (boundary, strict <)", () => {
    // 300 → 303 = exactly 1.00%. drift = 3/300 = 0.01; `0.01 < 0.01` is false
    // → not "all below threshold" → recompute fires.
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    autoOpenRef.value = { common: 303, stageBoss: 600, actBoss: 60 };
    chestDropTracker.recordLiveChestDrop("common", 2.0); // triggers recalibration
    // Recomputed with autoOpen=303: 1st item autoOpenAtMs = 1000 + 303000 = 304000
    // now=10000 → autoOpenInMs = 294000 (not 291000 which would be the no-recompute value)
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]!.autoOpenInMs).toBe(294_000);
  });

  it("Plan A: does NOT trigger recompute at 0.99% drift (below threshold)", () => {
    // 300 → 302.97 = 0.99% drift. 0.0099 < 0.01 = true → no recompute.
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    autoOpenRef.value = { common: 302.97, stageBoss: 600, actBoss: 60 };
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    // 1st item NOT recomputed: autoOpenAtMs still 301000 → autoOpenInMs=291000
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]!.autoOpenInMs).toBe(291_000);
  });

  it("Plan A: triggers recompute at 1.01% drift (above threshold)", () => {
    // 300 → 303.03 = 1.01% drift. 0.0101 < 0.01 = false → recompute fires.
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    autoOpenRef.value = { common: 303.03, stageBoss: 600, actBoss: 60 };
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    // Recomputed: 1000 + 303.03*1000 = 304030 → autoOpenInMs = 294030
    const snap = service.getQueueSnapshot();
    expect(snap.items[0]!.autoOpenInMs).toBe(294_030);
  });

  // ---------------------------------------------------------------------------
  // H2: Plan C burst window boundary (audit gap).
  // Match check is `delta <= BURST_MATCH_GRACE_MS` (inclusive), so exactly
  // 15000ms matches; 15001ms falls back to head.
  // ---------------------------------------------------------------------------

  it("Plan C: matches head at exactly 15000ms delta (boundary, inclusive <=)", () => {
    // autoOpenAtMs=301000. burstMs = 301000 - 15000 = 286000 → wallTime=286.0s.
    // delta = 15000 → `15000 <= 15000` = true → match (stage 1 head).
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 286.0);
    boxOpenTracker.flushUnclassified();
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(0); // head consumed via match
    const fallbackCalls = logMocks.warn.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("no queue item within"),
    );
    expect(fallbackCalls).toHaveLength(0);
  });

  it("Plan C: matches head at 14999ms delta (just inside window)", () => {
    // burstMs = 301000 - 14999 = 286001 → wallTime=286.001s. delta=14999 → match.
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 286.001);
    boxOpenTracker.flushUnclassified();
    expect(service.getQueueSnapshot().totalQueued).toBe(0);
  });

  it("Plan C: falls back to head at 15001ms delta (just outside window)", () => {
    // burstMs = 301000 - 15001 = 285999 → wallTime=285.999s. delta=15001
    // → `15001 <= 15000` = false → no match → fallback to head (consumes
    // head via dequeue, emits warn log).
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 285.999);
    boxOpenTracker.flushUnclassified();
    // Head still consumed (fallback path), but via dequeue not match.
    expect(service.getQueueSnapshot().totalQueued).toBe(0);
    expect(logMocks.warn).toHaveBeenCalledWith(expect.stringContaining("no queue item within"));
  });

  // ---------------------------------------------------------------------------
  // M2: cross-category head-priority match (audit fix verification).
  // Two queue items from different categories both fall in-window; stage 1
  // must match the head (FIFO) rather than the closer tail, preventing
  // cross-category misclassification.
  // ---------------------------------------------------------------------------

  it("M2 fix: prefers head over a closer tail item from a different category", () => {
    // Queue: [common@1.0s (autoOpenAtMs=301000), act@241.5s (autoOpenAtMs=301500)]
    // Burst at wallTime=301.7s → burstMs=301700.
    //   head (common) delta = |301000-301700| = 700ms (in 15s window)
    //   tail (act)    delta = |301500-301700| = 200ms (in window, smaller)
    // Stage 1 matches head (common) even though tail has smaller delta.
    const { chestDropTracker, boxOpenTracker, service } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105, // common→level 5 (routes), act→level 1 (fallback)
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    chestDropTracker.recordLiveChestDrop("act", 241.5); // autoOpenAtMs=301500
    // Verify queue order: head is common (autoOpenAtMs=301000 < 301500)
    let snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(2);
    expect(snap.items[0]!.boxKey).toBe("common:5");
    expect(snap.items[1]!.boxKey).toBe("act:1");
    // Burst at wallTime=301.7s — both items in window, but stage 1 matches
    // the head (common), not the closer tail (act).
    boxOpenTracker.recordOpen("unclassified", 100, "Sword", "COMMON", 1, 301.7);
    boxOpenTracker.flushUnclassified();
    // Head (common) consumed; tail (act) remains.
    snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.boxKey).toBe("act:1");
  });
});

// ---------------------------------------------------------------------------
// H3: FALLBACK → 真实值首次过渡（prev=null 路径）。
// 启动时 ChestService 还没有 save，返回 null → 使用 FALLBACK_AUTO_OPEN。
// 首次 save 解析后 ChestService 返回真实值，maybeRecalibrateQueue 看到
// prev=null → 走 "first calibration" 分支，触发 recompute。这是 Plan A
// 在会话生命周期起点必须覆盖的关键场景：玩家装了减少冷却的符文，实际
// autoOpenSeconds 与 FALLBACK 显著不同，若不 recompute 会造成整条队列
// autoOpenAtMs 偏移 N × δ。
// ---------------------------------------------------------------------------

describe("AutoClassifyService session lifecycle (H3/H4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("H3: FALLBACK→真实值首次过渡触发 recompute (prev=null 路径)", () => {
    // 启动时 ChestService 还没有 save，返回 null → 使用 FALLBACK_AUTO_OPEN
    // (common=300, stageBoss=600, actBoss=60)。
    const autoOpenRef = {
      value: null as { common: number; stageBoss: number; actBoss: number } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // 掉落两个 common 宝箱，按 FALLBACK (300s) 计算 autoOpenAtMs：
    //   1st: queue empty → 1000 + 300*1000 = 301000
    //   2nd: tail=301000 → 301000 + 300*1000 = 601000 (chained)
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    chestDropTracker.recordLiveChestDrop("common", 2.0);
    let snap = service.getQueueSnapshot();
    expect(snap.items[0]!.autoOpenInMs).toBe(291_000); // 301000 - 10000
    expect(snap.items[1]!.autoOpenInMs).toBe(591_000); // 601000 - 10000

    // 首次 save 解析：ChestService 返回真实值 common=120s（玩家装了减少冷却的符文）。
    // maybeRecalibrateQueue 看到 prev=null → "first calibration" 分支触发 recompute。
    // Recomputed (autoOpen.common=120):
    //   1st (dropped@1.0s): autoOpenAtMs = 1000 + 120*1000 = 121000
    //   2nd (dropped@2.0s): autoOpenAtMs = 121000 + 120*1000 = 241000 (chained)
    autoOpenRef.value = { common: 120, stageBoss: 600, actBoss: 60 };
    // 通过 reconcileWithChestSlots 触发（这是 save 解析的入口）。
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(2);
    expect(snap.items[0]!.droppedAtMs).toBe(1000);
    expect(snap.items[0]!.autoOpenInMs).toBe(111_000); // 121000 - 10000
    expect(snap.items[1]!.droppedAtMs).toBe(2000);
    expect(snap.items[1]!.autoOpenInMs).toBe(231_000); // 241000 - 10000
  });

  it("H3: FALLBACK→真实值过渡后 WeakSet 重置，tick 重新处理 elapsed item", () => {
    // 验证 recomputeQueueAutoOpenAtMs 在 H3 场景下也重置 slotDecrementedItems WeakSet
    // （M3 fix 在 H3 上的体现）。场景：FALLBACK 阶段 drop + tick 让 item 进入
    // WeakSet；首次 save 解析后 autoOpen 从 300s → 100s，recompute 后 item 的
    // autoOpenAtMs 从 301000 变为 101000（已过去）。WeakSet 必须重置，否则
    // tick 会跳过这个 item（旧引用仍命中 WeakSet），导致 liveSlots 不一致。
    const autoOpenRef = {
      value: null as { common: number; stageBoss: number; actBoss: number } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // 掉落并 tick 越过 FALLBACK autoOpenAtMs，让 item 进入 WeakSet。
    // liveSlots: 2 (save) + 1 (drop) - 1 (tick auto-open) = 2.
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    vi.setSystemTime(302_000);
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });

    // 首次 save 解析：autoOpen.common 从 FALLBACK 300s → 100s。
    // recompute 后 item 的 autoOpenAtMs = 1000 + 100*1000 = 101000（已过去，
    // 因为 now=302000）。WeakSet 重置，item 重新可被 tick 处理。
    // reconcileWithChestSlots 设置 liveSlots = { common: 2 }（save is ground truth）。
    // queue 里仍有 1 个 common item（autoOpenAtMs=101000）；slots.common=2
    // >= queue.common=1，不 prune。
    autoOpenRef.value = { common: 100, stageBoss: 600, actBoss: 60 };
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });

    // tick 越过新 autoOpenAtMs（101000 < now=302000）→ 应该 decrement liveSlots。
    // 若 WeakSet 未重置，tick 会跳过这个 item（旧引用仍命中 WeakSet），
    // liveSlots 保持 2，造成不一致。
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 1, rare: 0, act: 0 });
  });

  it("H3: 真实值→FALLBACK 回退不触发 recompute (current=null 早返回)", () => {
    // 边界场景：save 解析失败导致 ChestService 再次返回 null。
    // maybeRecalibrateQueue 在 current=null 时早返回，不破坏队列。
    const autoOpenRef = {
      value: { common: 120, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=121000 (120s)
    let snap = service.getQueueSnapshot();
    expect(snap.items[0]!.autoOpenInMs).toBe(111_000); // 121000 - 10000

    // save 解析失败 → autoOpenRef.value=null。maybeRecalibrateQueue 早返回，
    // lastAutoOpenSeconds 也保持原值（不被 null 覆盖），队列保持原状。
    autoOpenRef.value = null;
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]!.autoOpenInMs).toBe(111_000); // 未变
  });

  // ---------------------------------------------------------------------------
  // H4: 重启后状态恢复（disable→enable）。
  // disable 时清空 queue / pending / liveSlots / lastReconcileSlots /
  // lastAutoOpenSeconds；重新 enable 后行为与首次启动一致：liveSlots 为 null
  // 直到下一次 reconcileWithChestSlots，lastAutoOpenSeconds 为 null 使下一次
  // autoOpenSeconds 读取走 "first calibration" 路径。slotDecrementedItems WeakSet
  // 虽未被显式重置，但 queue=[] 后旧 item 失去引用，新 drop 创建新对象，
  // WeakSet.has(newItem) 返回 false，不会泄露。
  // ---------------------------------------------------------------------------

  it("H4: disable→enable 后状态完全重置，行为与首次启动一致", () => {
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // 会话期内状态：liveSlots 已初始化、queue 有 items、lastAutoOpenSeconds 已设置。
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    expect(service.getQueueSnapshot().totalQueued).toBe(1);
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });

    // 禁用：状态全部清空。
    service.setEnabled(false);
    const disabledSnap = service.getQueueSnapshot();
    expect(disabledSnap.totalQueued).toBe(0);
    expect(disabledSnap.liveSlots).toBeNull();

    // 重新启用：状态重置，行为与首次启动一致。
    service.setEnabled(true);
    const reenabledSnap = service.getQueueSnapshot();
    expect(reenabledSnap.totalQueued).toBe(0);
    expect(reenabledSnap.liveSlots).toBeNull(); // 等待 reconcileWithChestSlots 恢复

    // 重新启用后掉落一个 chest：lastAutoOpenSeconds=null（已重置），不会触发
    // recompute（prev=null → maybeRecalibrateQueue 在 queue.length===0 时早返回；
    // 即使 queue 非空，prev=null 也走 first calibration 分支但不会 recompute
    // 已经为空的队列）。
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.autoOpenInMs).toBe(291_000); // 301000 - 10000
    // liveSlots 仍为 null（reconcile 还没来），handleChestDrop 不会 ++null。
    expect(snap.liveSlots).toBeNull();

    // save 解析到达，liveSlots 恢复。reconcileWithChestSlots 直接覆盖为 save 的绝对值
    // （不会叠加 drop 的 ++：save is ground truth）。
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 1, rare: 0, act: 0 });
  });

  it("H4: 重启后 tick 正确递减 liveSlots（旧 WeakSet 引用不泄露）", () => {
    // 验证 disable→enable 后，新 drop 创建的新 item 对象不被旧的
    // slotDecrementedItems WeakSet 抑制（即使 WeakSet 未显式重置）。
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // 第一次会话：drop 一个 chest，tick 自动开启它，liveSlots 递减，
    // item 进入 slotDecrementedItems WeakSet。
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000
    vi.setSystemTime(302_000);
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });

    // 重启：disable→enable。queue 清空，slotDecrementedItems WeakSet 仍持有旧 item
    // 引用，但 queue=[] 后旧 item 不再被引用。新 drop 创建新 item 对象，
    // WeakSet.has(newItem) 返回 false。
    service.setEnabled(false);
    service.setEnabled(true);
    // 重新初始化 liveSlots 并 drop 一个新 chest。
    service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
    chestDropTracker.recordLiveChestDrop("common", 1.0); // 新 item, autoOpenAtMs=301000
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 3, rare: 0, act: 0 });
    // tick 越过 autoOpenAtMs → liveSlots 应该递减（不被旧 WeakSet 抑制）。
    vi.setSystemTime(302_000);
    service.tick();
    expect(service.getQueueSnapshot().liveSlots).toEqual({ common: 2, rare: 0, act: 0 });
  });

  it("H4: 重启后 lastAutoOpenSeconds=null，首次 autoOpen 读取走 first calibration", () => {
    // 验证重启后 lastAutoOpenSeconds 被重置为 null，使下一次 autoOpenSeconds
    // 读取走 "first calibration" 路径（prev=null → recompute 触发）。
    // 这保证：如果重启后 ChestService 返回的 autoOpenSeconds 与重启前不同
    // （比如玩家在重启间隙修改了符文配置），队列会被重新校准。
    const autoOpenRef = {
      value: { common: 300, stageBoss: 600, actBoss: 60 } as {
        common: number;
        stageBoss: number;
        actBoss: number;
      } | null,
    };
    const { service, chestDropTracker } = makeService({
      enabled: true,
      autoOpenRef,
      catalog: CATALOG,
      currentStageKey: 1105,
    });
    // 第一次会话：drop 一个 chest，建立 lastAutoOpenSeconds={common:300,...}。
    chestDropTracker.recordLiveChestDrop("common", 1.0); // autoOpenAtMs=301000

    // 重启。
    service.setEnabled(false);
    service.setEnabled(true);

    // 重启后玩家改了符文：autoOpen.common 300s → 100s。
    // drop 一个新 chest：maybeRecalibrateQueue 看到 prev=null（重启时已重置）
    // → first calibration 分支。但此时 queue=[]（重启时已清空），所以
    // recomputeQueueAutoOpenAtMs 早返回，不执行任何 recompute。
    // 新 chest 直接用新 autoOpen=100s enqueue：
    //   autoOpenAtMs = 1000 + 100*1000 = 101000
    autoOpenRef.value = { common: 100, stageBoss: 600, actBoss: 60 };
    chestDropTracker.recordLiveChestDrop("common", 1.0);
    const snap = service.getQueueSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]!.autoOpenInMs).toBe(91_000); // 101000 - 10000
  });
});
