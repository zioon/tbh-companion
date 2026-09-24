import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebDataSource } from "../../src/web/dataSource";
import { loadLookupItems } from "../../src/core/lookup/catalog";

// The web chest detail is the desktop `BoxDetailCard` fed by a slim payload
// (`data/box-sources.json`, built from `lookup_sources.json` by
// `build-web-box-sources.mjs`) whose drops are reduced to `[itemKey, dropPct]`
// pairs. This pins the rehydration contract: names/grades come back from the
// bundled catalog, the handful of item keys that are not in the catalog keep
// their label from `extras`, and any failure degrades to "missing" rather than
// throwing.

const PAYLOAD = {
  schemaVersion: 1,
  boxes: {
    "910011": {
      name: "Normal Monster Box 1",
      grade: "COMMON",
      category: "common",
      drops: [
        [300001, 6.438],
        [999999, 1.5],
      ],
      stages: [],
      dropStageRangeLabel: "Normal 1-1 – 1-3",
      firstDropOnly: false,
      firstDropStages: [],
    },
  },
  extras: { "999999": { name: "Removed Trinket", grade: "RARE" } },
};

describe("web box sources store", () => {
  beforeEach(() => {
    vi.resetModules();
    installWebDataSource();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is idle until requested", async () => {
    const store = await import("../../src/web/boxSourcesSnapshot");
    expect(store.getWebBoxSourcesStatus()).toBe("idle");
    expect(store.getWebBoxSources()).toBeNull();
  });

  it("rehydrates drops from the bundled catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }));
    const store = await import("../../src/web/boxSourcesSnapshot");
    await store.ensureBoxSourcesLoaded();

    expect(store.getWebBoxSourcesStatus()).toBe("ready");
    const box = store.getWebBoxSources()?.["910011"];
    expect(box?.name).toBe("Normal Monster Box 1");
    expect(box?.drops).toHaveLength(2);

    // A catalogued drop rehydrates its name/grade from `lookup_items.json`.
    const catalogued = box!.drops[0];
    expect(catalogued.itemKey).toBe(300001);
    expect(catalogued.dropPct).toBe(6.438);
    // The real bundled catalog is the source of truth, so look the expectation
    // up rather than hard-coding it.
    const expected = loadLookupItems().find((item) => item.id === 300001);
    expect(expected).toBeDefined();
    expect(catalogued.name).toBe(expected!.name);
    expect(catalogued.grade).toBe(expected!.grade);
  });

  it("keeps the label of a drop whose item key is not in the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }));
    const store = await import("../../src/web/boxSourcesSnapshot");
    await store.ensureBoxSourcesLoaded();

    const orphan = store.getWebBoxSources()?.["910011"].drops[1];
    expect(orphan).toEqual({
      itemKey: 999999,
      dropPct: 1.5,
      name: "Removed Trinket",
      grade: "RARE",
    });
  });

  it("degrades to missing on a 404 instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    const store = await import("../../src/web/boxSourcesSnapshot");
    await store.ensureBoxSourcesLoaded();

    expect(store.getWebBoxSourcesStatus()).toBe("missing");
    expect(store.getWebBoxSources()).toBeNull();
    // Idempotent: a second call does not refetch.
    await store.ensureBoxSourcesLoaded();
    expect(store.getWebBoxSourcesStatus()).toBe("missing");
  });

  it("degrades to missing on a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: 1 }) }),
    );
    const store = await import("../../src/web/boxSourcesSnapshot");
    await store.ensureBoxSourcesLoaded();

    expect(store.getWebBoxSourcesStatus()).toBe("missing");
    expect(store.getWebBoxSources()).toBeNull();
  });
});
