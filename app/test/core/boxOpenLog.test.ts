import { describe, it, expect } from "vitest";
import {
  resolveBoxKey,
  boxCategoryFromType,
  boxLabel,
  categoryFromBoxKey,
  levelFromBoxKey,
  UNCLASSIFIED_BOX_KEY,
} from "../../src/core/boxOpenLog";

describe("boxCategoryFromType", () => {
  it("maps 0 -> common, 1 -> rare, 2 -> act", () => {
    expect(boxCategoryFromType(0)).toBe("common");
    expect(boxCategoryFromType(1)).toBe("rare");
    expect(boxCategoryFromType(2)).toBe("act");
  });

  it("returns null for unknown types", () => {
    expect(boxCategoryFromType(99)).toBeNull();
    expect(boxCategoryFromType(undefined)).toBeNull();
  });
});

describe("resolveBoxKey", () => {
  it("produces category-only key when level is absent", () => {
    expect(resolveBoxKey(0)).toBe("common");
    expect(resolveBoxKey(1)).toBe("rare");
    expect(resolveBoxKey(2)).toBe("act");
  });

  it("appends level when provided and > 0", () => {
    expect(resolveBoxKey(1, 3)).toBe("rare:3");
    expect(resolveBoxKey(0, 5)).toBe("common:5");
  });

  it("falls back to category-only when level is 0 or negative", () => {
    expect(resolveBoxKey(1, 0)).toBe("rare");
    expect(resolveBoxKey(1, -1)).toBe("rare");
  });

  it("returns null for unknown boxType", () => {
    expect(resolveBoxKey(99)).toBeNull();
  });
});

describe("boxLabel", () => {
  it("labels category-only keys", () => {
    expect(boxLabel("common")).toBe("Common chest");
    expect(boxLabel("rare")).toBe("Stage boss chest");
    expect(boxLabel("act")).toBe("Act boss chest");
    expect(boxLabel(UNCLASSIFIED_BOX_KEY)).toBe("Unclassified");
  });

  it("labels levelled keys", () => {
    expect(boxLabel("rare:3")).toBe("Stage boss chest Lv3");
    expect(boxLabel("common:5")).toBe("Common chest Lv5");
  });

  it("falls back to the raw key for unknown shapes", () => {
    expect(boxLabel("unknown:42")).toBe("unknown:42");
  });
});

describe("categoryFromBoxKey", () => {
  it("extracts category from levelled keys", () => {
    expect(categoryFromBoxKey("rare:3")).toBe("rare");
    expect(categoryFromBoxKey("common:5")).toBe("common");
  });

  it("returns the category for category-only keys", () => {
    expect(categoryFromBoxKey("common")).toBe("common");
    expect(categoryFromBoxKey("act")).toBe("act");
    expect(categoryFromBoxKey(UNCLASSIFIED_BOX_KEY)).toBe("unclassified");
  });

  it("returns null for unknown categories", () => {
    expect(categoryFromBoxKey("unknown:42")).toBeNull();
    expect(categoryFromBoxKey("unknown")).toBeNull();
  });
});

describe("levelFromBoxKey", () => {
  it("extracts level from levelled keys", () => {
    expect(levelFromBoxKey("rare:3")).toBe(3);
    expect(levelFromBoxKey("common:5")).toBe(5);
  });

  it("returns null for category-only keys", () => {
    expect(levelFromBoxKey("common")).toBeNull();
    expect(levelFromBoxKey("rare")).toBeNull();
  });
});
