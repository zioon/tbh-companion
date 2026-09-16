import { describe, expect, it } from "vitest";
import {
  gradeFromAcquireColor,
  parseAcquireMessage,
  stripRichText,
} from "../../src/core/acquireLog";

describe("parseAcquireMessage", () => {
  it("extracts an item name wrapped in a color tag", () => {
    const r = parseAcquireMessage("获得了<color=#D7D7D7>永恒之弓</color>。");
    expect(r.kind).toBe("item");
    expect(r.name).toBe("永恒之弓");
    expect(r.color).toBe("#D7D7D7");
    expect(r.count).toBe(1);
  });

  it("uppercases the color hex and handles xN counts", () => {
    const r = parseAcquireMessage("获得了<color=#a1b2c3>回旋镖</color> x3");
    expect(r).toEqual({ kind: "item", name: "回旋镖", color: "#A1B2C3", count: 3 });
  });

  it("detects gold", () => {
    const r = parseAcquireMessage("获得金币");
    expect(r.kind).toBe("gold");
    expect(r.count).toBe(1);
  });

  it("treats unknown messages as other but keeps the text", () => {
    const r = parseAcquireMessage("<color=#FFFFFF>首领出现</color>");
    expect(r.kind).toBe("item");
    expect(r.name).toBe("首领出现");
  });
});

describe("stripRichText", () => {
  it("removes color markup", () => {
    expect(stripRichText("<color=#D7D7D7>永恒之弓</color>。")).toBe("永恒之弓。");
  });
});

describe("gradeFromAcquireColor", () => {
  // Every colour here was confirmed against the bundled catalog: log lines whose
  // name resolves to a single catalog row have exactly one possible grade.
  it("maps the measured item tints", () => {
    expect(gradeFromAcquireColor("#D7D7D7")).toBe("COMMON");
    expect(gradeFromAcquireColor("#7CE937")).toBe("UNCOMMON");
    expect(gradeFromAcquireColor("#519FFF")).toBe("RARE");
    expect(gradeFromAcquireColor("#EBBB00")).toBe("LEGENDARY");
    expect(gradeFromAcquireColor("#E8695A")).toBe("IMMORTAL");
    expect(gradeFromAcquireColor("#FB86FF")).toBe("ARCANA");
    expect(gradeFromAcquireColor("#00F6FF")).toBe("CELESTIAL");
  });

  it("is case-insensitive and tolerates stray whitespace", () => {
    expect(gradeFromAcquireColor("  #d7d7d7 ")).toBe("COMMON");
  });

  it("returns null for missing colours", () => {
    expect(gradeFromAcquireColor(null)).toBeNull();
    expect(gradeFromAcquireColor("")).toBeNull();
  });

  it("refuses to guess for the notice tints (chest / clear / hero)", () => {
    // These tints belong to non-item lines. Mapping them to a grade would make
    // a chest notice look like real loot, so they must stay unknown.
    expect(gradeFromAcquireColor("#A4A4A4")).toBeNull();
    expect(gradeFromAcquireColor("#0070C0")).toBeNull();
    expect(gradeFromAcquireColor("#A69255")).toBeNull();
    expect(gradeFromAcquireColor("#7030A5")).toBeNull();
  });

  it("returns null for the never-observed top grades rather than inventing one", () => {
    // BEYOND / DIVINE / COSMIC never appeared in the measured sample.
    expect(gradeFromAcquireColor("#123456")).toBeNull();
  });
});
