import { describe, expect, it } from "vitest";
import { boxIconPath } from "../../src/renderer/lib/boxIconPath";

describe("boxIconPath", () => {
  it("maps normal monster box keys to the common category icon", () => {
    expect(boxIconPath(910151)).toBe("item-910011");
    expect(boxIconPath(910201)).toBe("item-910011");
  });

  it("maps stage boss box keys to the rare category icon", () => {
    expect(boxIconPath(920151)).toBe("item-920011");
    expect(boxIconPath(920201)).toBe("item-920011");
  });

  it("maps act boss box keys to the legendary category icon", () => {
    expect(boxIconPath(930201)).toBe("item-930011");
  });

  it("maps plague common box keys to the extracted plague common icon", () => {
    expect(boxIconPath(915001)).toBe("item-915001");
    expect(boxIconPath(915201)).toBe("item-915001");
  });

  it("maps plague stage boss box keys to the extracted plague stage icon", () => {
    expect(boxIconPath(925011)).toBe("item-925001");
  });

  it("maps plague act boss box keys to the extracted plague act icon", () => {
    expect(boxIconPath(935001)).toBe("item-935001");
  });

  it("maps the v1.3.0 Halloween event boxes to their own icons", () => {
    // All three difficulties of a band share one sprite in the game assets
    // (ItemInfoData.IconPath points every 940xxx row at Item_940001).
    expect(boxIconPath(940001)).toBe("item-940001");
    expect(boxIconPath(940101)).toBe("item-940001");
    expect(boxIconPath(940201)).toBe("item-940001");
    expect(boxIconPath(941001)).toBe("item-941001");
    expect(boxIconPath(941101)).toBe("item-941001");
    expect(boxIconPath(941201)).toBe("item-941001");
  });

  it("falls back to item-<key> for non-stage-box keys", () => {
    expect(boxIconPath(140002)).toBe("item-140002");
  });
});
