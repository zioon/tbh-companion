import { describe, it, expect } from "vitest";
import { stageName } from "../../src/core/stages";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";

describe("stageName", () => {
  it("decodes difficulty/act/stage", () => {
    expect(stageName(3205)).toBe("Hell 2-5");
    expect(stageName(2309)).toBe("Nightmare 3-9");
    expect(stageName(1101)).toBe("Normal 1-1");
    expect(stageName(4510)).toBe("Torment 5-10");
  });

  it("appends the wave when given", () => {
    expect(stageName(2309)).toBe("Nightmare 3-9");
  });

  it("handles unknown/invalid keys", () => {
    expect(stageName(0)).toBe("?");
    expect(stageName(-5)).toBe("?");
    expect(stageName(9101)).toBe("D9 1-1");
  });
});

describe("stageName with catalog", () => {
  it("uses catalog.stages when entry exists", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "1205": "Pasture" },
      difficulties: { NORMAL: "Normal", NIGHTMARE: "Nightmare", HELL: "Hell", TORMENT: "Torment" },
    };
    expect(stageName(3205, catalog)).toBe("Pasture");
  });

  it("falls back to <difficulty> <act>-<stage> when catalog.stages misses", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      difficulties: { NORMAL: "Normal", NIGHTMARE: "Nightmare", HELL: "Hell", TORMENT: "Torment" },
    };
    expect(stageName(3205, catalog)).toBe("Hell 2-5");
  });

  it("uses catalog.difficulties for fallback difficulty name", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      difficulties: { HELL: "地狱" },
    };
    expect(stageName(3205, catalog)).toBe("地狱 2-5");
  });

  it("returns ? for invalid key", () => {
    expect(stageName(0, null)).toBe("?");
    expect(stageName(-1, null)).toBe("?");
  });

  it("falls back to English default when catalog is null", () => {
    expect(stageName(3205, null)).toBe("Hell 2-5");
  });

  it("handles stage key with act 3 stage 10 (1310 → catalog '1310')", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "1310": "Hell Command Chamber" },
    };
    expect(stageName(1310, catalog)).toBe("Hell Command Chamber");
    expect(stageName(3310, catalog)).toBe("Hell Command Chamber");
  });
});
