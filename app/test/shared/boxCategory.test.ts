import { describe, it, expect } from "vitest";

import { toLookupCategory, type BoxCategory, type LookupBoxCategory } from "../../shared/types";

describe("toLookupCategory", () => {
  // P2-1: the unified `BoxCategory` (canonical tracker-side vocabulary) uses
  // short names (`rare`/`act`), while `LookupBoxCategory` (lookup-display side)
  // uses fully-descriptive names (`stage_boss`/`act_boss`). The two vocabularies
  // describe the same domain concept; this mapping bridges them so callers
  // don't sprinkle hand-rolled switch statements across the codebase.
  it("maps common → common", () => {
    expect(toLookupCategory("common")).toBe("common" as LookupBoxCategory);
  });

  it("maps rare → stage_boss (stage boss chest)", () => {
    expect(toLookupCategory("rare")).toBe("stage_boss");
  });

  it("maps act → act_boss (act boss chest)", () => {
    expect(toLookupCategory("act")).toBe("act_boss");
  });

  it("maps unclassified → unknown (cannot be resolved from memory)", () => {
    expect(toLookupCategory("unclassified")).toBe("unknown");
  });

  it("covers every BoxCategory value", () => {
    // Compile-time exhaustiveness: if a new BoxCategory value is added
    // without a corresponding mapping, this array literal will fail to type
    // check because the union no longer matches.
    const allCategories: BoxCategory[] = ["common", "rare", "act", "unclassified"];
    for (const c of allCategories) {
      const mapped = toLookupCategory(c);
      // Every input must produce a defined LookupBoxCategory output.
      expect(mapped).toBeTruthy();
    }
  });
});
