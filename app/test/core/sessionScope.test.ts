import { describe, it, expect } from "vitest";
import {
  applySessionScope,
  deriveSession,
  emptySessionScopeState,
  extractGameVersion,
  noteSessionSave,
  LEGACY_SESSION_ID,
  SESSION_GAP_SEC,
  type SessionScopeState,
} from "../../src/core/boxes/sessionScope";
import type { ChestHolding } from "../../shared/types";

function actHolding(uid: string): ChestHolding {
  return { type: 930901, quantity: 1, category: "act", label: "Act Boss Box", uniqueId: uid };
}

function commonHolding(uid: string): ChestHolding {
  return {
    type: 910901,
    quantity: 1,
    category: "common",
    label: "Normal Monster Box",
    uniqueId: uid,
  };
}

describe("extractGameVersion", () => {
  it("reads plain and escaped version fields", () => {
    expect(extractGameVersion('{"version":"1.2.4"}')).toBe("1.2.4");
    expect(extractGameVersion('{\\"version\\":\\"1.2.4\\",\\"x\\":1}')).toBe("1.2.4");
    expect(extractGameVersion('{"nope":1}')).toBe("");
  });

  it("ignores EnchantVersion-like keys", () => {
    expect(extractGameVersion('{"EnchantVersion":"9","version":"1.2.4"}')).toBe("1.2.4");
  });
});

describe("deriveSession", () => {
  it("first parse starts s1 as a boundary", () => {
    const r = deriveSession(emptySessionScopeState(), 1000, "1.2.4");
    expect(r).toEqual({ sessionId: "s1", boundary: "first" });
  });

  it("steady-state saves keep the session", () => {
    const state = noteSessionSave({ ...emptySessionScopeState(), sessionId: "s1" }, 1000, "1.2.4");
    expect(deriveSession(state, 1060, "1.2.4")).toEqual({ sessionId: "s1", boundary: "none" });
  });

  it("version change starts a new session", () => {
    const state = noteSessionSave({ ...emptySessionScopeState(), sessionId: "s1" }, 1000, "1.2.2");
    expect(deriveSession(state, 1060, "1.2.4")).toEqual({ sessionId: "s2", boundary: "version" });
  });

  it("mtime regression starts a new session (restore / path switch)", () => {
    const state = noteSessionSave({ ...emptySessionScopeState(), sessionId: "s3" }, 5000, "1.2.4");
    expect(deriveSession(state, 4000, "1.2.4")).toEqual({ sessionId: "s4", boundary: "regress" });
  });

  it("a save gap longer than SESSION_GAP_SEC starts a new session", () => {
    const state = noteSessionSave({ ...emptySessionScopeState(), sessionId: "s1" }, 1000, "1.2.4");
    expect(deriveSession(state, 1000 + SESSION_GAP_SEC + 1, "1.2.4")).toEqual({
      sessionId: "s2",
      boundary: "gap",
    });
  });

  it("non-canonical session ids grow a + suffix instead of corrupting", () => {
    const state: SessionScopeState = {
      ...emptySessionScopeState(),
      sessionId: "custom",
      lastSaveMtime: 1000,
      lastGameVersion: "1.2.2",
    };
    expect(deriveSession(state, 1060, "1.2.4").sessionId).toBe("custom+");
  });
});

describe("applySessionScope", () => {
  it("first run records pre-existing act entries as legacy and excludes them", () => {
    const chests = [commonHolding("u1"), actHolding("a1"), actHolding("a2")];
    const d = applySessionScope(chests, emptySessionScopeState(), "s1");
    expect(d.chests).toEqual([commonHolding("u1")]);
    expect(d.excludedActUids).toEqual(["a1", "a2"]);
    expect(d.state.act["a1"]).toBe(LEGACY_SESSION_ID);
    expect(d.state.act["a2"]).toBe(LEGACY_SESSION_ID);
    expect(d.actMapChanged).toBe(true);
  });

  it("same-session act entries pass through and stay recorded", () => {
    const prev: SessionScopeState = {
      ...emptySessionScopeState(),
      sessionId: "s1",
      act: { a1: "s1" },
    };
    const d = applySessionScope([actHolding("a1")], prev, "s1");
    expect(d.chests).toEqual([actHolding("a1")]);
    expect(d.excludedActUids).toEqual([]);
    expect(d.actMapChanged).toBe(false);
  });

  it("pre-session act entries (recorded in an older session) are excluded", () => {
    const prev: SessionScopeState = {
      ...emptySessionScopeState(),
      sessionId: "s2",
      act: { a1: "s1" },
    };
    const d = applySessionScope([actHolding("a1")], prev, "s2");
    expect(d.chests).toEqual([]);
    expect(d.excludedActUids).toEqual(["a1"]);
  });

  it("a newly dropped act entry in the current session is kept", () => {
    const prev: SessionScopeState = {
      ...emptySessionScopeState(),
      sessionId: "s2",
      act: { a1: "s1" },
    };
    const d = applySessionScope([actHolding("a2")], prev, "s2");
    expect(d.chests).toEqual([actHolding("a2")]);
    expect(d.state.act["a2"]).toBe("s2");
    expect(d.actMapChanged).toBe(true);
  });

  it("non-act categories always pass through, even pre-session", () => {
    const prev: SessionScopeState = {
      ...emptySessionScopeState(),
      sessionId: "s2",
      act: {},
    };
    const chests = [
      commonHolding("u1"),
      { type: 910901, quantity: 3, category: "common" as const }, // legacy BoxData path, no uid
      { type: 930901, quantity: 2, category: "act" as const }, // legacy act without uid → passthrough
    ];
    const d = applySessionScope(chests, prev, "s2");
    expect(d.chests).toEqual(chests);
    expect(d.excludedActUids).toEqual([]);
    expect(d.actMapChanged).toBe(false);
  });

  it("does not mutate the input state", () => {
    const prev = emptySessionScopeState();
    applySessionScope([actHolding("a1")], prev, "s1");
    expect(prev.act).toEqual({});
    expect(prev.sessionId).toBe("");
  });

  it("prunes stale-session entries first when over the cap", () => {
    const act: Record<string, string> = {};
    for (let i = 0; i < 300; i++) act[`old${i}`] = "s1";
    const prev: SessionScopeState = { ...emptySessionScopeState(), sessionId: "s2", act };
    const d = applySessionScope([actHolding("new1")], prev, "s2");
    const keys = Object.keys(d.state.act);
    // Trimmed to the cap (256): the 45 oldest stale entries are gone first,
    // the newest stale entries and the current-session entry survive.
    expect(keys).toHaveLength(256);
    expect(keys[0]).toBe("old45");
    expect(d.state.act["new1"]).toBe("s2");
    expect(d.state.act["old0"]).toBeUndefined();
    expect(d.actMapChanged).toBe(true);
  });
});

describe("noteSessionSave", () => {
  it("updates mtime and version bookkeeping without touching the act map", () => {
    const prev: SessionScopeState = {
      ...emptySessionScopeState(),
      sessionId: "s1",
      act: { a1: "s1" },
    };
    const next = noteSessionSave(prev, 42, "1.2.4");
    expect(next.lastSaveMtime).toBe(42);
    expect(next.lastGameVersion).toBe("1.2.4");
    expect(next.act).toEqual({ a1: "s1" });
    expect(prev.lastSaveMtime).toBe(0);
  });

  it("keeps the previous version when the parse found none", () => {
    const prev = noteSessionSave(emptySessionScopeState(), 1, "1.2.4");
    const next = noteSessionSave(prev, 2, "");
    expect(next.lastGameVersion).toBe("1.2.4");
  });
});
