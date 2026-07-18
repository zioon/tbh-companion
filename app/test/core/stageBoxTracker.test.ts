import { describe, it, expect } from "vitest";
import {
  loadStageBoxTrackerRoutes,
  loadActBossTrackerRoutes,
  canonicalTrackerBoxId,
  resolveTrackedDropBoxId,
  resolveTrackedDropBoxIdForStage,
  inferLevelFromStage,
} from "../../src/core/stageBoxTracker";

describe("stageBoxTracker", () => {
  it("loads canonical routes from bundled stage_boxes.json", () => {
    const routes = loadStageBoxTrackerRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.dropStageRangeLabel.length > 0)).toBe(true);
  });

  it("maps duplicate ItemKeys to canonical tracker ids", () => {
    expect(canonicalTrackerBoxId(920501)).toBe(920501);
    expect(canonicalTrackerBoxId(920004)).toBe(920003);
    expect(canonicalTrackerBoxId(910501)).toBeNull();
  });

  it("resolveTrackedDropBoxId requires tracked route and enabled level", () => {
    const enabled = new Set([920151, 920003]);
    const isTrackedRoute = (boxId: number) => boxId === 920151 || boxId === 920003;

    expect(resolveTrackedDropBoxId(920151, enabled, isTrackedRoute)).toBe(920151);
    expect(resolveTrackedDropBoxId(920004, enabled, isTrackedRoute)).toBe(920003);
    expect(resolveTrackedDropBoxId(920501, enabled, isTrackedRoute)).toBeNull();
    expect(resolveTrackedDropBoxId(920151, new Set(), isTrackedRoute)).toBeNull();
  });

  it("resolveTrackedDropBoxIdForStage picks the enabled route for the current map", () => {
    const routes = loadStageBoxTrackerRoutes();
    const torment80 = routes.find((route) => route.boxId === 920801);
    expect(torment80?.dropStageKeys).toContain(4103);

    const enabled = new Set([920801]);
    expect(resolveTrackedDropBoxIdForStage(4103, enabled, routes)).toBe(920801);
    expect(resolveTrackedDropBoxIdForStage(4103, new Set(), routes)).toBeNull();
    expect(resolveTrackedDropBoxIdForStage(9999, enabled, routes)).toBeNull();
  });
});

describe("loadActBossTrackerRoutes", () => {
  it("loads LEGENDARY act boss routes from bundled stage_boxes.json", () => {
    const routes = loadActBossTrackerRoutes();
    expect(routes.length).toBeGreaterThan(0);
    // All routes come from LEGENDARY act boss boxes (id range 930xxx).
    expect(routes.every((route) => route.boxId >= 930000 && route.boxId < 940000)).toBe(true);
    // Each route must have at least one dropStageKey for stage-based level inference.
    expect(routes.every((route) => route.dropStageKeys.length > 0)).toBe(true);
    // Routes are sorted by level ascending.
    for (let i = 1; i < routes.length; i++) {
      expect(routes[i]!.level).toBeGreaterThanOrEqual(routes[i - 1]!.level);
    }
  });

  it("excludes RARE stage boss routes (those come from loadStageBoxTrackerRoutes)", () => {
    const rareRoutes = loadStageBoxTrackerRoutes();
    const actRoutes = loadActBossTrackerRoutes();
    const rareIds = new Set(rareRoutes.map((r) => r.boxId));
    // No overlap between RARE and LEGENDARY route box ids.
    expect(actRoutes.every((r) => !rareIds.has(r.boxId))).toBe(true);
  });

  it("maps Normal 1-10 (1110) to Lv1 act boss route", () => {
    const routes = loadActBossTrackerRoutes();
    const lv1 = routes.find((r) => r.level === 1);
    expect(lv1).toBeTruthy();
    expect(lv1?.dropStageKeys).toContain(1110);
  });

  it("maps Torment 3-10 (4310) to Lv90 act boss route", () => {
    const routes = loadActBossTrackerRoutes();
    const lv90 = routes.find((r) => r.level === 90);
    expect(lv90).toBeTruthy();
    expect(lv90?.dropStageKeys).toContain(4310);
    expect(lv90?.dropStageKeys).toContain(4210);
  });
});

describe("inferLevelFromStage", () => {
  const catalog = [
    { level: 3, farmStageOptions: [{ stageKey: 1103 }, { stageKey: 1104 }] },
    { level: 5, farmStageOptions: [{ stageKey: 1105 }] },
    { level: 8, farmStageOptions: [{ stageKey: 3308 }] },
  ] as const;

  it("returns the highest matching level when stageKey matches", () => {
    // 1105 only matches level 5
    expect(inferLevelFromStage(catalog, 1105)).toBe(5);
  });
  it("returns highest level when multiple match", () => {
    const multi = [
      { level: 3, farmStageOptions: [{ stageKey: 1101 }] },
      { level: 7, farmStageOptions: [{ stageKey: 1101 }] },
    ];
    expect(inferLevelFromStage(multi, 1101)).toBe(7);
  });
  it("falls back to lowest catalog level when no match", () => {
    expect(inferLevelFromStage(catalog, 9999)).toBe(3);
  });
  it("returns null when catalog is empty", () => {
    expect(inferLevelFromStage([], 1105)).toBeNull();
  });
  it("returns fallback when stageKey is 0 or negative", () => {
    expect(inferLevelFromStage(catalog, 0)).toBe(3);
    expect(inferLevelFromStage(catalog, -1)).toBe(3);
  });
});
