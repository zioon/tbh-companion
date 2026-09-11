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

  it("falls back to item-<key> for non-stage-box keys", () => {
    expect(boxIconPath(140002)).toBe("item-140002");
  });
});
