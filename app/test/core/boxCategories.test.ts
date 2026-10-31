import { describe, it, expect } from "vitest";

import {
  categoryFromBoxItemId,
  isAutoOpenedCategory,
  isEventBoxItemId,
} from "../../src/core/boxCategories";

describe("categoryFromBoxItemId", () => {
  it("maps the plain chest bands", () => {
    expect(categoryFromBoxItemId(910901)).toBe("common");
    expect(categoryFromBoxItemId(920901)).toBe("rare");
    expect(categoryFromBoxItemId(930901)).toBe("act");
  });

  it("maps the plague bands before their base-tier ranges", () => {
    // 915xxx sits INSIDE the 910-919 numeric range, 925xxx inside 920-929 and
    // 935xxx inside 930-939 — the plague band must win.
    expect(categoryFromBoxItemId(915001)).toBe("plagueCommon");
    expect(categoryFromBoxItemId(925001)).toBe("plagueRare");
    expect(categoryFromBoxItemId(935001)).toBe("plagueAct");
  });

  it("maps the v1.3.0 Halloween event bands to their own family", () => {
    // The two event tiers stay separate, mirroring the normal / stage-boss split.
    expect(categoryFromBoxItemId(940001)).toBe("eventNormal");
    expect(categoryFromBoxItemId(941001)).toBe("eventStage");
    expect(categoryFromBoxItemId(940999)).toBe("eventNormal");
    expect(categoryFromBoxItemId(941999)).toBe("eventStage");
  });

  it("returns null for ids that are not chests", () => {
    expect(categoryFromBoxItemId(110001)).toBeNull();
    expect(categoryFromBoxItemId(949999)).toBeNull();
    expect(categoryFromBoxItemId(Number.NaN)).toBeNull();
  });
});

describe("isEventBoxItemId", () => {
  it("covers exactly the 940/941 bands", () => {
    expect(isEventBoxItemId(940001)).toBe(true);
    expect(isEventBoxItemId(941201)).toBe(true);
    expect(isEventBoxItemId(939999)).toBe(false);
    expect(isEventBoxItemId(942000)).toBe(false);
  });
});

describe("isAutoOpenedCategory", () => {
  it("excludes the event boxes — the game has no auto-open chain for them", () => {
    // `RuneInfoData` / `RuneLevelInfoData` ship no `UnlockAutoOpenEvent*Chest`
    // node, so the game never opens an event chest on a timer.
    expect(isAutoOpenedCategory("eventNormal")).toBe(false);
    expect(isAutoOpenedCategory("eventStage")).toBe(false);
    expect(isAutoOpenedCategory("unclassified")).toBe(false);
    expect(isAutoOpenedCategory(null)).toBe(false);
  });

  it("keeps every auto-opened family", () => {
    expect(isAutoOpenedCategory("common")).toBe(true);
    expect(isAutoOpenedCategory("rare")).toBe(true);
    expect(isAutoOpenedCategory("act")).toBe(true);
    expect(isAutoOpenedCategory("plagueCommon")).toBe(true);
    expect(isAutoOpenedCategory("plagueRare")).toBe(true);
    expect(isAutoOpenedCategory("plagueAct")).toBe(true);
  });
});
