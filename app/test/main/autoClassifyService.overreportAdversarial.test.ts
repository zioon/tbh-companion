/**
 * Adversarial / boundary regression tests for the Loot-tab slot over-report fix
 * (掉落页 slots 数量校正后仍偏高).
 *
 * These complement the primary cases in `autoClassifyService.test.ts`
 * ("AutoClassifyService liveSlots over-report regression"). They target the
 * EDGES the primary cases do NOT cover, specifically probing for any residual
 * path that can still leave `liveSlots` ABOVE the save truth:
 *
 *   A. a real NEW drop arriving AFTER a save credit was armed must still +1
 *      (the credit must not swallow a second, genuinely-new chest);
 *   B. a credit that expires unclaimed must not leak into a later real drop;
 *   C. repeated save-increase + live-burst cycles must not ratchet (long-run);
 *   D. a save DECREASE must snap down and never go negative across ticks;
 *   E. inventory-full pause branch (tick early-return) must not by itself make
 *      liveSlots disagree with the save when a credit is armed;
 *   F. two credits armed in one reconcile (increase of 2) are both consumed by
 *      two trailing live bursts — no phantom +1;
 *   G. cross-category credits must not cross-consume (a rare credit must not
 *      suppress a common drop's increment).
 *
 * Each test drives the REAL ordering through ChestDropTracker.recordLiveChestDrop
 * (which fires onDrop -> handleChestDrop), so it exercises the actual integration
 * rather than poking service internals.
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

const CATALOG: BoxTimerCatalogEntry[] = [
  {
    boxId: 920151,
    name: "Stage Boss Box 5",
    level: 5,
    category: "rare",
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

const ACT_BOSS_ROUTES: StageBoxTrackerRoute[] = [
  {
    boxId: 930101,
    level: 1,
    idealStageKey: 1110,
    idealStageLabel: "Normal 1-10",
    dropStageKeys: [1110],
    dropStageRangeLabel: "Normal 1-10",
  },
];

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

function makeService(
  opts: {
    enabled?: boolean;
    currentStageKey?: number | null;
    inventoryStatus?: { used: number; capacity: number } | null;
  } = {},
) {
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
    getCurrentStageKey: () => opts.currentStageKey ?? null,
    getInventoryStatus: () => opts.inventoryStatus ?? null,
    broadcast: () => {},
  });
  if (opts.enabled !== false) service.setEnabled(true);
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

describe("liveSlots over-report — adversarial / boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A. A genuinely NEW drop arriving after a credit was armed must still +1.
  //    (a credit must only absorb ONE already-counted chest, never a second
  //     real chest.)
  it("[adv] a second real drop beyond the armed credit still increments", () => {
    const { service, chestDropTracker } = makeService({ currentStageKey: 1105 });
    service.reconcileWithChestSlots(zero());

    const t0 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t0);
    // Save sees 1 new rare (arms 1 credit), then the SAME chest flushes live.
    service.reconcileWithChestSlots({ ...zero(), rare: 1 });
    chestDropTracker.recordLiveChestDrop("rare", t0 / 1000); // consumes the credit
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(1);

    // A SECOND, genuinely-new drop arrives within the credit window. There is
    // no credit left for it, so it MUST increment to 2.
    vi.setSystemTime(t0 + 500);
    chestDropTracker.recordLiveChestDrop("rare", (t0 + 500) / 1000);
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(2);
  });

  // B. An armed credit that the live reader never cashes must NOT leak: after
  //    expiry a later genuine drop still increments.
  it("[adv] an armed-then-expired credit does not suppress a later real drop", () => {
    const { service, chestDropTracker } = makeService({ currentStageKey: 1105 });
    service.reconcileWithChestSlots(zero());

    const t0 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t0);
    service.reconcileWithChestSlots({ ...zero(), rare: 1 }); // arms credit
    // No live burst follows. Advance past RECOVERY_GRACE_MS and tick to prune.
    vi.setSystemTime(t0 + 20_000);
    service.tick();
    // Now a real drop (save not reflecting it) must increment (1 -> 2).
    chestDropTracker.recordLiveChestDrop("rare", (t0 + 20_000) / 1000);
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(2);
  });

  // C. Long-run: repeated save-increase + live-burst cycles never ratchet.
  it("[adv] 12 save-then-live cycles keep liveSlots == save (no ratchet)", () => {
    const { service, chestDropTracker } = makeService({ currentStageKey: 1105 });
    service.reconcileWithChestSlots(zero());
    let saveRare = 0;
    for (let cycle = 1; cycle <= 12; cycle++) {
      const t = FIXED_NOW_MS + cycle * 4_000;
      vi.setSystemTime(t);
      saveRare += 1;
      service.reconcileWithChestSlots({ ...zero(), rare: saveRare });
      chestDropTracker.recordLiveChestDrop("rare", t / 1000);
      expect(service.getQueueSnapshot().liveSlots?.rare).toBe(saveRare);
    }
  });

  // D. Save decrease snaps down and never goes negative across repeated ticks.
  it("[adv] save decrease snaps down and never goes negative", () => {
    const { service, chestDropTracker } = makeService({ currentStageKey: 1105 });
    service.reconcileWithChestSlots(zero());
    for (let i = 0; i < 4; i++) chestDropTracker.recordLiveChestDrop("rare", 1.0 + i);
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(4);

    vi.setSystemTime(FIXED_NOW_MS + 2_000);
    service.reconcileWithChestSlots({ ...zero(), rare: 1 });
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(1);

    for (const t of [FIXED_NOW_MS + 700_000, FIXED_NOW_MS + 1_300_000, FIXED_NOW_MS + 1_900_000]) {
      vi.setSystemTime(t);
      service.tick();
      const v = service.getQueueSnapshot().liveSlots?.rare ?? 0;
      expect(v).toBeGreaterThanOrEqual(0);
      // The save truth is 1, and no live drops arrive — must stay exactly 1.
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  // E. Inventory-full pause branch must not by itself inflate liveSlots when a
  //    credit is armed (the tick early-return skips the decrement loop).
  it("[adv] inventory-full pause does not inflate liveSlots around an armed credit", () => {
    const { service, chestDropTracker } = makeService({
      currentStageKey: 1105,
      inventoryStatus: { used: 10, capacity: 10 }, // full from the start
    });
    service.reconcileWithChestSlots(zero());
    // Pause detection runs in tick() (not reconcile); drive one tick so
    // `inventoryFullSinceMs` is latched before we assert the paused branch.
    service.tick();
    expect(service.getQueueSnapshot().paused).toBe(true);

    const t0 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t0);
    service.reconcileWithChestSlots({ ...zero(), rare: 1 }); // arms 1 credit
    // The same chest's live burst arrives while paused.
    chestDropTracker.recordLiveChestDrop("rare", t0 / 1000);
    // Credit consumed → still the save truth (1), NOT 2.
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(1);
  });

  // F. An increase of 2 in one reconcile arms 2 credits; two trailing live
  //    bursts for those SAME two chests consume both — no phantom +1.
  it("[adv] increase of 2 arms 2 credits, both trailing live bursts consume them", () => {
    const { service, chestDropTracker } = makeService({ currentStageKey: 1105 });
    service.reconcileWithChestSlots(zero());

    const t0 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t0);
    service.reconcileWithChestSlots({ ...zero(), rare: 2 }); // arms 2 credits
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(2);
    // Both live bursts for those same chests flush.
    chestDropTracker.recordLiveChestDrop("rare", t0 / 1000);
    chestDropTracker.recordLiveChestDrop("rare", (t0 + 100) / 1000);
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(2);

    // A THIRD, genuinely new drop (no credit left) must increment to 3.
    vi.setSystemTime(t0 + 200);
    chestDropTracker.recordLiveChestDrop("rare", (t0 + 200) / 1000);
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(3);
  });

  // G. Credits are per-category: a rare credit must NOT suppress a common drop.
  it("[adv] a rare credit does not suppress a common drop's increment", () => {
    const { service, chestDropTracker } = makeService({ currentStageKey: 1105 });
    service.reconcileWithChestSlots(zero());

    const t0 = FIXED_NOW_MS + 1_000;
    vi.setSystemTime(t0);
    // Rare increases (arms a rare credit); common does NOT.
    service.reconcileWithChestSlots({ ...zero(), rare: 1 });
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(0);
    // A common live drop must still increment common (0 -> 1) — the rare credit
    // must not cross-consume.
    chestDropTracker.recordLiveChestDrop("common", t0 / 1000);
    expect(service.getQueueSnapshot().liveSlots?.common).toBe(1);
    // And the rare credit is still armed, so the rare chest's own burst is
    // still absorbed (rare stays at the save truth 1).
    chestDropTracker.recordLiveChestDrop("rare", t0 / 1000);
    expect(service.getQueueSnapshot().liveSlots?.rare).toBe(1);
  });
});
