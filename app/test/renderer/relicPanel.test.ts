import { describe, expect, it } from "vitest";
import { resonanceConditionText } from "../../src/renderer/lib/itemLabels";

/** Minimal TFunction stand-in: resolves the two keys the helper uses. */
function fakeT() {
  return ((key: string, opts?: Record<string, unknown>) => {
    if (key === "relic.noResonanceCondition") return "None";
    if (key === "relic.conditionEntry") {
      return `${opts?.count}× ${opts?.color}`;
    }
    if (key === "relic.conditionJoin") return " + ";
    if (key.startsWith("common:labels.types.RELIC_")) {
      // No translation loaded → the helper falls back to the raw color name.
      return key.slice("common:labels.types.RELIC_".length);
    }
    return key;
  }) as unknown as Parameters<typeof resonanceConditionText>[1];
}

describe("resonanceConditionText", () => {
  it("renders a single condition", () => {
    expect(resonanceConditionText("Blue_2", fakeT())).toBe("2× BLUE");
  });

  it("joins multiple conditions", () => {
    expect(resonanceConditionText("Blue_2 Red_1", fakeT())).toBe("2× BLUE + 1× RED");
  });

  it("falls back to None for an empty condition", () => {
    expect(resonanceConditionText("", fakeT())).toBe("None");
  });

  it("defaults a missing count to 1", () => {
    expect(resonanceConditionText("Blue", fakeT())).toBe("1× BLUE");
  });
});
