// Tests for the integrity-level self-check helpers used by the live reader.
//
// Context: a companion that runs below Medium integrity (a "Low mandatory
// level" label on the program directory) cannot see the Medium-integrity
// game process — Windows filters the process list for low-integrity callers
// and denies OpenProcess on it. The reader then reports "game process not
// found" while the game is plainly running, so the reader has to be able to
// name that cause.
//
// The FFI token query cannot be unit-tested on every platform (it is
// Windows-only), but the RID -> level mapping and the "is this level
// blocking?" decision are pure and are what the reader's behaviour hinges on.

import { describe, it, expect } from "vitest";
import {
  INTEGRITY_RID,
  integrityLevelName,
  isBelowMediumIntegrity,
  inspectIntegrity,
} from "../../src/main/liveMemory/winProcess";

describe("integrityLevelName", () => {
  it("maps the well-known mandatory integrity RIDs", () => {
    expect(integrityLevelName(INTEGRITY_RID.untrusted)).toBe("untrusted");
    expect(integrityLevelName(INTEGRITY_RID.low)).toBe("low");
    expect(integrityLevelName(INTEGRITY_RID.medium)).toBe("medium");
    expect(integrityLevelName(INTEGRITY_RID.high)).toBe("high");
    expect(integrityLevelName(INTEGRITY_RID.system)).toBe("system");
  });

  it("maps unknown RIDs to 'unknown' instead of throwing", () => {
    expect(integrityLevelName(0x1234)).toBe("unknown");
    expect(integrityLevelName(-1)).toBe("unknown");
  });
});

describe("isBelowMediumIntegrity", () => {
  it("treats Low and Untrusted as blocking", () => {
    expect(isBelowMediumIntegrity(INTEGRITY_RID.low)).toBe(true);
    expect(isBelowMediumIntegrity(INTEGRITY_RID.untrusted)).toBe(true);
  });

  it("treats Medium and above as not blocking", () => {
    expect(isBelowMediumIntegrity(INTEGRITY_RID.medium)).toBe(false);
    expect(isBelowMediumIntegrity(INTEGRITY_RID.high)).toBe(false);
    expect(isBelowMediumIntegrity(INTEGRITY_RID.system)).toBe(false);
  });

  it("does not block when the level is unknown", () => {
    // The probe is a diagnostic aid, not a gate: an unreadable token must
    // not turn into "the game is missing".
    expect(isBelowMediumIntegrity(null)).toBe(false);
  });
});

describe("inspectIntegrity", () => {
  it("reports the level of the current process on Windows", () => {
    if (process.platform !== "win32") return;
    const result = inspectIntegrity();
    expect(result.rid).not.toBeNull();
    expect(["low", "medium", "high", "system"]).toContain(result.level);
    expect(result.belowMedium).toBe(result.level === "low");
  });

  it("falls back to an unknown level when the token cannot be read", () => {
    if (process.platform === "win32") return;
    const result = inspectIntegrity();
    expect(result.rid).toBeNull();
    expect(result.level).toBe("unknown");
    expect(result.belowMedium).toBe(false);
  });
});
