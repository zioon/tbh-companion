import { describe, it, expect } from "vitest";
import {
  DEFAULT_VISIBLE_INVENTORY_COLUMNS,
  INVENTORY_TABLE_PREFS_VERSION,
  normalizeInventoryTablePrefs,
} from "../../src/core/inventory/columnPrefs";

describe("inventory column prefs", () => {
  it("returns defaults when prefs missing", () => {
    const prefs = normalizeInventoryTablePrefs(undefined);
    expect(prefs.visibleColumns).toEqual(DEFAULT_VISIBLE_INVENTORY_COLUMNS);
    expect(prefs.version).toBe(INVENTORY_TABLE_PREFS_VERSION);
  });

  it("filters unknown column ids", () => {
    const prefs = normalizeInventoryTablePrefs({
      visibleColumns: ["grade", "not-a-column" as "grade", "marketPrice"],
      version: INVENTORY_TABLE_PREFS_VERSION,
    });
    expect(prefs.visibleColumns).toEqual(["grade", "marketPrice"]);
  });

  it("falls back to defaults when all columns filtered out", () => {
    const prefs = normalizeInventoryTablePrefs({
      visibleColumns: ["not-a-column" as "grade"],
      version: INVENTORY_TABLE_PREFS_VERSION,
    });
    expect(prefs.visibleColumns).toEqual(DEFAULT_VISIBLE_INVENTORY_COLUMNS);
  });

  it("drops the removed instantSellAverage column from legacy configs", () => {
    const prefs = normalizeInventoryTablePrefs({
      visibleColumns: ["grade", "instantSellAverage" as "grade", "instantSell"],
    });
    expect(prefs.visibleColumns).not.toContain("instantSellAverage");
    expect(prefs.visibleColumns).toContain("grade");
  });

  it("adds instantSellNet once when migrating a legacy (unversioned) config", () => {
    const prefs = normalizeInventoryTablePrefs({
      visibleColumns: ["grade", "marketPrice"],
    });
    expect(prefs.visibleColumns).toEqual(["grade", "marketPrice", "instantSellNet"]);
    expect(prefs.version).toBe(INVENTORY_TABLE_PREFS_VERSION);
  });

  it("keeps a versioned config where the user hid instantSellNet", () => {
    const prefs = normalizeInventoryTablePrefs({
      visibleColumns: ["grade", "marketPrice"],
      version: INVENTORY_TABLE_PREFS_VERSION,
    });
    expect(prefs.visibleColumns).toEqual(["grade", "marketPrice"]);
  });
});
