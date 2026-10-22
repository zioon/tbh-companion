import { describe, it, expect } from "vitest";
import { buildStageBoxCatalog, isStageBoxItemKey, stageBoxIdSet } from "../../src/core/stageBoxes";
import { loadStageBoxTrackerRoutes } from "../../src/core/stageBoxTracker";

describe("stageBoxes", () => {
  it("maps all 146 stage box ItemKeys", () => {
    // 140 through v1.2.8; game v1.3.0 added the 6 Halloween event boxes
    // (940001/940101/940201 normal tier + 941001/941101/941201 stage tier).
    const catalog = buildStageBoxCatalog();
    expect(catalog.count).toBe(146);
    expect(catalog.items.find((i) => i.id === 920501)?.name).toBe("Stage Boss Box Lv50");
    expect(catalog.items.find((i) => i.id === 910151)?.level).toBe(15);
    expect(catalog.items.find((i) => i.id === 940001)?.name).toBe(
      "Halloween Normal Box (Nightmare)",
    );
    expect(catalog.items.find((i) => i.id === 941201)?.name).toBe("Halloween Stage Box (Torment)");
  });

  it("recognizes stage box ids", () => {
    const ids = stageBoxIdSet(buildStageBoxCatalog().items);
    expect(isStageBoxItemKey(920501, ids)).toBe(true);
    expect(isStageBoxItemKey(940001, ids)).toBe(true);
    expect(isStageBoxItemKey(322111, ids)).toBe(false);
  });
});

describe("stageBoxTracker", () => {
  it("loads 74 canonical obtainable rare routes", () => {
    // Box 1/2/3/6 (920001/920002/920003/920022) had phantom tracker entries
    // removed — those boxes don't drop from any stage. game v1.2.2 added many
    // higher-level stage boss boxes (925xxx, Torment act 2/3), bringing the
    // tracked RARE routes to 71; game v1.3.0 added the 3 Halloween stage
    // boxes (941xxx) on the event stages → 74.
    const routes = loadStageBoxTrackerRoutes();
    expect(routes).toHaveLength(74);
    expect(routes.find((route) => route.boxId === 920501)?.idealStageKey).toBe(2305);
    expect(routes.find((route) => route.boxId === 920501)?.dropStageRangeLabel).toContain(
      "Nightmare 3-5",
    );
    expect(routes.some((route) => route.boxId === 920251)).toBe(false);
    // The Halloween event routes ride on the EVENT stages (2901/3901/4901).
    expect(routes.find((route) => route.boxId === 941001)?.idealStageKey).toBe(2901);
  });
});
