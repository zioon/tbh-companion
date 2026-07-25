import { describe, it, expect } from "vitest";
import { heroName } from "../../src/core/heroes";
import type { LocaleCatalog } from "../../src/core/localeCatalog";

describe("heroName with LocaleCatalog", () => {
  it("returns localized name when catalog has the hero key", () => {
    const catalog: LocaleCatalog = {
      items: {},
      stages: {},
      heroes: { "101": "骑士" },
      difficulties: {},
    };
    expect(heroName("101", catalog)).toBe("骑士");
  });

  it("falls back to HERO_NAMES when catalog is null", () => {
    expect(heroName("101", null)).toBe("Knight");
  });

  it("falls back to HERO_NAMES when catalog does not have the hero key", () => {
    const catalog: LocaleCatalog = {
      items: {},
      stages: {},
      heroes: {},
      difficulties: {},
    };
    expect(heroName("101", catalog)).toBe("Knight");
  });

  it("returns the raw key when neither catalog nor HERO_NAMES has it", () => {
    const catalog: LocaleCatalog = {
      items: {},
      stages: {},
      heroes: {},
      difficulties: {},
    };
    expect(heroName("999", catalog)).toBe("999");
  });
});
