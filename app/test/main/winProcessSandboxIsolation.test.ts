// Tests for the pure selection helper used by multi-instance sandbox
// isolation in WinProcess.findByNames. The FFI calls inside findByNames
// (OpenProcess, EnumProcessModulesEx, GetModuleHandleW) cannot be unit-
// tested, but the candidate-selection logic they feed into can.
//
// Covers the regression where a host companion silently attached to a
// sandboxed TBH (whose PID was larger because it started later), mixing
// live data across instances.

import { describe, it, expect } from "vitest";
import { selectProcessBySandbox } from "../../src/main/liveMemory/winProcess";

describe("selectProcessBySandbox", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectProcessBySandbox([], false)).toBeNull();
    expect(selectProcessBySandbox([], true)).toBeNull();
  });

  it("returns the only candidate when sandbox states match", () => {
    expect(selectProcessBySandbox([{ pid: 100, inSandbox: false }], false)).toBe(100);
    expect(selectProcessBySandbox([{ pid: 100, inSandbox: true }], true)).toBe(100);
  });

  it("falls back to the only candidate when sandbox states do not match", () => {
    // Regression guard: a single host TBH + sandboxed companion (or vice
    // versa) must still attach to something rather than return null and
    // leave the worker idle.
    expect(selectProcessBySandbox([{ pid: 100, inSandbox: false }], true)).toBe(100);
    expect(selectProcessBySandbox([{ pid: 100, inSandbox: true }], false)).toBe(100);
  });

  it("prefers same-sandbox candidates and picks the highest PID among them", () => {
    // Host companion (inSandbox=false) with two host TBH + one sandboxed TBH
    // (whose PID is largest). Must pick the largest host PID, not the
    // largest overall — this is the core multi-instance isolation behavior.
    const candidates = [
      { pid: 1000, inSandbox: false },
      { pid: 2000, inSandbox: true }, // sandboxed, would be picked by legacy logic
      { pid: 1500, inSandbox: false },
    ];
    expect(selectProcessBySandbox(candidates, false)).toBe(1500);
  });

  it("selects the sandboxed TBH when the companion is sandboxed", () => {
    // Mirror of the previous case: sandboxed companion must ignore the
    // higher host PID and pick the sandboxed candidate.
    const candidates = [
      { pid: 5000, inSandbox: false },
      { pid: 4000, inSandbox: true },
      { pid: 6000, inSandbox: false },
    ];
    expect(selectProcessBySandbox(candidates, true)).toBe(4000);
  });

  it("falls back to highest PID across all candidates when none match companion state", () => {
    // All candidates are sandboxed but companion is in the host (e.g. sbie
    // detection failed for the companion's own process). Should not return
    // null — degrade to the legacy tiebreak.
    const candidates = [
      { pid: 100, inSandbox: true },
      { pid: 300, inSandbox: true },
      { pid: 200, inSandbox: true },
    ];
    expect(selectProcessBySandbox(candidates, false)).toBe(300);
  });

  it("handles all candidates already matching the companion state", () => {
    // No sandbox in play at all — every TBH is on the host. Should reduce
    // to the legacy highest-PID behavior.
    const candidates = [
      { pid: 100, inSandbox: false },
      { pid: 300, inSandbox: false },
      { pid: 200, inSandbox: false },
    ];
    expect(selectProcessBySandbox(candidates, false)).toBe(300);
  });

  it("picks the highest PID when multiple sandboxed candidates exist", () => {
    const candidates = [
      { pid: 100, inSandbox: true },
      { pid: 500, inSandbox: true },
      { pid: 200, inSandbox: true },
    ];
    expect(selectProcessBySandbox(candidates, true)).toBe(500);
  });

  it("does not mutate the input array", () => {
    const candidates = [
      { pid: 300, inSandbox: false },
      { pid: 100, inSandbox: false },
    ];
    const snapshot = candidates.map((c) => ({ ...c }));
    selectProcessBySandbox(candidates, false);
    expect(candidates).toEqual(snapshot);
  });
});
