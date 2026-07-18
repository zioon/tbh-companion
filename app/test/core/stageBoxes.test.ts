import { describe, it, expect } from "vitest";
import { buildStageBoxCatalog, isStageBoxItemKey, stageBoxIdSet } from "../../src/core/stageBoxes";
import { loadStageBoxTrackerRoutes } from "../../src/core/stageBoxTracker";

describe("stageBoxes", () => {
  it("maps all 59 wiki stage box ItemKeys", () => {
    const catalog = buildStageBoxCatalog();
    expect(catalog.count).toBe(59);
    expect(catalog.items.find((i) => i.id === 920501)?.name).toBe("Stage Boss Box Lv50");
    expect(catalog.items.find((i) => i.id === 910151)?.level).toBe(15);
  });

  it("recognizes stage box ids", () => {
    const ids = stageBoxIdSet(buildStageBoxCatalog().items);
    expect(isStageBoxItemKey(920501, ids)).toBe(true);
    expect(isStageBoxItemKey(322111, ids)).toBe(false);
  });
});

describe("stageBoxTracker", () => {
  it("loads 10 canonical obtainable rare routes", () => {
    // Box 1/2/3/6 (920001/920002/920003/920022) had phantom tracker entries
    // removed — those boxes don't drop from any stage. The remaining 10 RARE
    // routes cover Lv4/5/7/15/20/30/40/50/65/80.
    const routes = loadStageBoxTrackerRoutes();
    expect(routes).toHaveLength(10);
    expect(routes.find((route) => route.boxId === 920501)?.idealStageKey).toBe(2305);
    expect(routes.find((route) => route.boxId === 920501)?.dropStageRangeLabel).toContain(
      "Nightmare 3-5",
    );
    expect(routes.some((route) => route.boxId === 920251)).toBe(false);
  });
});
