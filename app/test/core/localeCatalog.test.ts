import { describe, expect, it } from "vitest";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";

describe("localeCatalog", () => {
  describe("emptyLocaleCatalog", () => {
    it("returns an object with all empty records", () => {
      const c = emptyLocaleCatalog();
      expect(c.items).toEqual({});
      expect(c.stages).toEqual({});
      expect(c.heroes).toEqual({});
      expect(c.difficulties).toEqual({});
    });

    it("returns a fresh object each call (no shared reference)", () => {
      const a = emptyLocaleCatalog();
      const b = emptyLocaleCatalog();
      expect(a).not.toBe(b);
      expect(a.items).not.toBe(b.items);
    });
  });

  describe("LocaleCatalog type", () => {
    it("accepts a populated catalog", () => {
      const c: LocaleCatalog = {
        items: { "110001": "Goblin Hide" },
        stages: { "1101": "Pasture" },
        heroes: { "101": "Knight" },
        difficulties: { NORMAL: "Normal" },
      };
      expect(c.items["110001"]).toBe("Goblin Hide");
      expect(c.stages["1101"]).toBe("Pasture");
      expect(c.heroes["101"]).toBe("Knight");
      expect(c.difficulties.NORMAL).toBe("Normal");
    });
  });
});
