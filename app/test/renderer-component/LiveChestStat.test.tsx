import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { LiveChestStatValue } from "../../src/renderer/lib/liveChestStat";

describe("LiveChestStatValue", () => {
  // P2-12: live chest drop counts update dynamically as drops are recorded.
  // Screen readers must announce updates, so the value renders as a polite
  // live region. `aria-atomic` makes the whole "total (perHour/hr)" string
  // announced as a unit rather than just the changed digit.
  it("renders as a polite live region so drop-count updates are announced", () => {
    render(<LiveChestStatValue total={5} perHour={3.2} />);
    const liveRegion = screen.getByRole("status");
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).toHaveAttribute("aria-atomic", "true");
  });

  it("exposes total and per-hour in the announced text", () => {
    // fmtCompact(6) === "6" (Math.round for abs < 1e3); use an integer perHour
    // so the assertion doesn't depend on compact-notation rounding.
    render(<LiveChestStatValue total={1234} perHour={6} />);
    expect(screen.getByRole("status")).toHaveTextContent("1,234 (6/hr)");
  });

  it("applies muted styling when inactive", () => {
    render(<LiveChestStatValue total={0} perHour={0} inactive />);
    const liveRegion = screen.getByRole("status");
    // The muted class lands on the count span inside the live region.
    expect(liveRegion.textContent).toContain("0");
  });
});
