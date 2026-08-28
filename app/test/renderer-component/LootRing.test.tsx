import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LootRing } from "../../src/renderer/components/loot/LootRing";

describe("LootRing", () => {
  it("renders nothing when lapSeconds is not positive (zero from corrupt config)", () => {
    const { container } = render(
      <LootRing lastDropWallTime={Date.now() / 1000 - 100} lapSeconds={0} />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("caps the number of completed lap rings (long idle must not explode SVG nodes)", () => {
    const now = Date.now() / 1000;
    // 5 hours since last drop with 1s laps = 18000 laps before the fix.
    const { container } = render(<LootRing lastDropWallTime={now - 5 * 3600} lapSeconds={1} />);
    const paths = container.querySelectorAll("path");
    // Max 3 completed laps + 1 current lap, each lap = 2 paths (glow + main).
    expect(paths.length).toBeLessThanOrEqual(8);
  });
});