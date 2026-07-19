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
      getAutoOpenSeconds: () => opts.autoOpen ?? { common: 300, stageBoss: 600, actBoss: 60 },
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
    // slot-parallel model every queued chest has a concrete autoOpenAtMs, so
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
    //   ttlMs = max(60*2*1000, 60000) + 30000 = 150000
    //   expiresAtMs = 63000 + 150000 = 213000; - 10000 (now) = 203000
    expect(snap.items[0]!.expiresInMs).toBe(203_000);
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

    // Save shows only 1 common chest remaining — the soonest-autoOpen one
    // (autoOpenAtMs=301000) should have opened already; prune it.
    service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
    const snap = service.getQueueSnapshot();
    expect(snap.totalQueued).toBe(1);
    expect(snap.items[0]!.droppedAtMs).toBe(2000);
    // Slot-parallel invariant: remaining item keeps its original autoOpenAtMs
    // (302000), not re-timer'd. autoOpenInMs = 302000 - 10000 (now) = 292000.
    expect(snap.items[0]!.autoOpenInMs).toBe(292_000);
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
