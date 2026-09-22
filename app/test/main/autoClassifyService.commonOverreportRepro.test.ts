/**
 * Reproduction tests for the report: "普通宝箱数量还是有问题" (common chest slot
 * count still over-reports after save calibration).
 *
 * Root-cause hypothesis validated against the REAL runtime log
 * (AppData/Roaming/tbh-companion/logs/app.log, 2026-09-22/23):
 *
 *   00:33:02  reconcile: backfilled 7 common item(s) (queue 0 < slots 7)   <- save truth = 7
 *   00:36:12  queued drop boxKey=common:90 queueLen=9                      <- ONE drop took queue 7 -> 9
 *   23:56:38  reconcile: pruned 1 excess common item(s) (queue 9 > slots 7; 1 elapsed, 8 still counting down)
 *
 * An independent decrypt of SaveFile_Live.es3 confirms common = 7. So the
 * queue/liveSlots sit +2 above the save truth and the excess-prune can only
 * shave ONE item (the elapsed one) — it never converges for common.
 *
 * The defect: when the SAVE already counts a chest AND the same chest's live
 * burst has already been recorded BEFORE the reconcile that sees the increase,
 * `prev[category]` is taken from `lastReconcileSlots` which ALREADY consumed
 * the increase in the previous reconcile — so no credit is armed this round,
 * yet the chest is enqueued AGAIN by backfill. Net: one chest, two queue slots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoClassifyService } from "../../src/main/services/AutoClassifyService";
import { ChestDropTracker } from "../../src/core/chestDropTracker";
import { BoxOpenTracker } from "../../src/core/boxOpenTracker";
import type { BoxTimerCatalogEntry } from "../../shared/types";
import type { StageBoxTrackerRoute } from "../../src/core/stageBoxTracker";

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const FIXED_NOW_MS = 10_000;

const AUTO_OPEN = {
  common: 300,
  stageBoss: 600,
  actBoss: 60,
  plagueCommon: 600,
  plagueRare: 1200,
  plagueAct: 120,
} as const;

const CATALOG: BoxTimerCatalogEntry[] = [];
const ACT_BOSS_ROUTES: StageBoxTrackerRoute[] = [];
const COMMON_ROUTES: StageBoxTrackerRoute[] = [
  {
    boxId: 910011,
    level: 1,
    idealStageKey: 1101,
    idealStageLabel: "Normal 1-1",
    dropStageKeys: [1101, 1102, 1103],
    dropStageRangeLabel: "Normal 1-1 – 1-3",
  },
];

function makeService(opts: { currentStageKey?: number | null } = {}) {
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
    chestService: { getAutoOpenSeconds: () => AUTO_OPEN },
    stageBoxCatalog: () => CATALOG,
    actBossRoutes: () => ACT_BOSS_ROUTES,
    commonRoutes: () => COMMON_ROUTES,
    getCurrentStageKey: () => opts.currentStageKey ?? 1101,
    getInventoryStatus: () => null,
    broadcast: () => {},
  });
  service.setEnabled(true);
  return { service, chestDropTracker, boxOpenTracker };
}

const zero = () => ({
  common: 0,
  rare: 0,
  act: 0,
  plagueCommon: 0,
  plagueRare: 0,
  plagueAct: 0,
});

/** Count queued items of a category from the public snapshot. */
function queueCount(service: AutoClassifyService, cat: string): number {
  const snap = service.getQueueSnapshot();
  const entry = snap.byCategory.find((c) => c.category === cat);
  return entry?.count ?? 0;
}

describe("common slot over-report — real-world ordering reproduction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // REPRO 1: save lands first (backfill fills it), then the SAME chest's live
  // burst flushes after the next reconcile has already folded the increase into
  // `lastReconcileSlots`. The chest must NOT be counted twice.
  it("[repro] a chest already backfilled from the save is not re-added by its lagging live burst", () => {
    const { service, chestDropTracker } = makeService();
    service.reconcileWithChestSlots(zero());

    // Save now reports 1 common (the chest the game just wrote). Backfill 1.
    const t1 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t1);
    service.reconcileWithChestSlots({ ...zero(), common: 1 });
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(1);
    expect(queueCount(service, "common")).toBe(1);

    // A no-op reconcile happens (save unchanged, e.g. the 5s watcher re-reads an
    // identical file) BEFORE the lagging live burst arrives.
    const t2 = FIXED_NOW_MS + 2_000;
    vi.setSystemTime(t2);
    service.reconcileWithChestSlots({ ...zero(), common: 1 });
    expect(queueCount(service, "common")).toBe(1);

    // Now the lagging live burst for THAT SAME chest flushes.
    chestDropTracker.recordLiveChestDrop("common", t2 / 1000);

    // The save truth is 1 — must still be 1, not 2, in BOTH liveSlots and the
    // queue. (Regression guard: the slot count was previously kept correct
    // while the queue silently gained a duplicate, so asserting only
    // `liveSlots` let the bug through.)
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(1);
    expect(queueCount(service, "common")).toBe(1);

    // A following save parse must not "recover" the phantom into existence.
    const t3 = FIXED_NOW_MS + 3_000;
    vi.setSystemTime(t3);
    service.reconcileWithChestSlots({ ...zero(), common: 1 });
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(1);
    expect(queueCount(service, "common")).toBe(1);
  });

  // REPRO 1b: the duplicate must not survive the grace window either. Once the
  // 5 s credit expires, a later burst for a NEW chest must add exactly one.
  it("[repro] a second, genuinely new drop still counts once after the grace lapses", () => {
    const { service, chestDropTracker } = makeService();
    service.reconcileWithChestSlots(zero());

    const t1 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t1);
    service.reconcileWithChestSlots({ ...zero(), common: 1 });
    chestDropTracker.recordLiveChestDrop("common", t1 / 1000); // credited, no-op
    expect(queueCount(service, "common")).toBe(1);

    // Well past RECOVERY_GRACE_MS (5 s): the credit is expired, so this burst is
    // a real new drop and must raise the queue by exactly one.
    const t2 = FIXED_NOW_MS + 20_000;
    vi.setSystemTime(t2);
    chestDropTracker.recordLiveChestDrop("common", t2 / 1000);
    expect(queueCount(service, "common")).toBe(2);

    const t3 = FIXED_NOW_MS + 21_000;
    vi.setSystemTime(t3);
    service.reconcileWithChestSlots({ ...zero(), common: 2 });
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(2);
    expect(queueCount(service, "common")).toBe(2);
  });

  // REPRO 2: the exact sequence from the real log — establish a baseline, then
  // one physical drop, then a save parse that already includes it. Total queue
  // must grow by exactly 1 for that drop.
  it("[repro] one physical common drop grows the queue by exactly one", () => {
    const { service, chestDropTracker } = makeService();
    // Launch baseline: save already holds 7 common (matches the real save).
    service.reconcileWithChestSlots({ ...zero(), common: 7 });
    expect(queueCount(service, "common")).toBe(7);

    // The drop happens; live burst flushes first (25 Hz reader beats the 5 s watcher).
    const t1 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t1);
    chestDropTracker.recordLiveChestDrop("common", t1 / 1000);
    expect(queueCount(service, "common")).toBe(8);

    // The save watcher then parses the save that now contains that chest.
    const t2 = FIXED_NOW_MS + 2_000;
    vi.setSystemTime(t2);
    service.reconcileWithChestSlots({ ...zero(), common: 8 });

    // One drop => 7 -> 8. Must never reach 9.
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(8);
    expect(queueCount(service, "common")).toBe(8);
  });

  // REPRO 3: steady state — repeated single drops must not accumulate a surplus.
  it("[repro] repeated single common drops never accumulate a surplus over the save", () => {
    const { service, chestDropTracker } = makeService();
    service.reconcileWithChestSlots({ ...zero(), common: 7 });

    let save = 7;
    for (let cycle = 1; cycle <= 6; cycle++) {
      const t = FIXED_NOW_MS + cycle * 5_000;
      vi.setSystemTime(t);
      // live burst first
      chestDropTracker.recordLiveChestDrop("common", t / 1000);
      // save catches up (watcher poll)
      vi.setSystemTime(t + 500);
      save += 1;
      service.reconcileWithChestSlots({ ...zero(), common: save });

      expect(queueCount(service, "common")).toBe(save);
      expect(service.getQueueSnapshot().liveSlots?.common).toBe(save);
    }
  });
});
