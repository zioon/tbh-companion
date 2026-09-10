import { describe, it, expect, beforeEach } from "vitest";
import { LookupService } from "../../src/main/services/LookupService";
import { clearBundledJsonCache } from "../../src/core/bundledData";
import type { GameItem } from "../../src/core/gamedata";

const coin: GameItem = {
  id: 150001,
  name: "Coin",
  grade: "COMMON",
  type: "MATERIAL",
  level: null,
  marketTradable: false,
};

/** A hypothetical new material absent from the bundled catalog. */
const futureMaterial: GameItem = {
  id: 999999,
  name: "Future Material",
  grade: "COMMON",
  type: "MATERIAL",
  level: null,
  marketTradable: false,
};

// LookupService mutates the cached bundled array in place (setGameData pushes
// into sourceItems) — clear the read cache so each test starts fresh.
beforeEach(() => {
  clearBundledJsonCache();
});

describe("LookupService.setGameData", () => {
  it("merges new gamedata items into the catalog and filters non-playable types", () => {
    const svc = new LookupService();
    const before = svc.getCatalog();
    const stagebox: GameItem = {
      id: 910011,
      name: "Normal Monster Box 1",
      grade: "COMMON",
      type: "STAGEBOX",
      level: 1,
      marketTradable: false,
    };
    svc.setGameData([futureMaterial, stagebox]);
    const after = svc.getCatalog();
    // Only the playable (MATERIAL) item is added; STAGEBOX is excluded.
    expect(after.length).toBe(before.length + 1);
    const found = after.find((it) => it.id === 999999);
    expect(found).toBeTruthy();
    expect(found?.type).toBe("MATERIAL");
    expect(after.find((it) => it.id === 910011)).toBeUndefined();
  });

  it("is idempotent across repeated calls", () => {
    const svc = new LookupService();
    svc.setGameData([futureMaterial]);
    const n1 = svc.getCatalog().length;
    svc.setGameData([futureMaterial]);
    expect(svc.getCatalog().length).toBe(n1);
  });

  it("skips name+grade variants already represented in the catalog", () => {
    const svc = new LookupService();
    const before = svc.getCatalog();
    // 160101 is the non-tradable copy of 160001 (same name/grade/icon).
    const copy: GameItem = {
      id: 160101,
      name: "Coin",
      grade: "COMMON",
      type: "MATERIAL",
      level: null,
      marketTradable: false,
    };
    svc.setGameData([futureMaterial, copy]);
    const after = svc.getCatalog();
    // the new material is added; the same-name/grade copy is skipped.
    expect(after.find((it) => it.id === 999999)).toBeTruthy();
    expect(after.find((it) => it.id === 160101)).toBeUndefined();
    expect(after.length).toBe(before.length + 1);
  });

  it("localizes the merged item name after setLocaleCatalog", () => {
    const svc = new LookupService();
    svc.setGameData([coin]);
    // Simulate a Chinese LocaleCatalog containing the new item id.
    svc.setLocaleCatalog({ items: { "150001": "铜币" }, stages: {}, heroes: {}, difficulties: {} });
    const localized = svc.getCatalog().find((it) => it.id === 150001);
    expect(localized?.name).toBe("铜币");
    expect(localized?.sourceName).toBe("Coin");
  });
});
