import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebDataSource } from "../../src/web/dataSource";
import { loadLookupItems } from "../../src/core/lookup/catalog";

// The web item detail is the desktop `ItemDetailCard` fed by a slim payload
// (`data/item-sources.json`, built from `lookup_sources.json` by
// `build-web-item-sources.mjs`) whose drops/materials/outputs are reduced to
// tuples. This pins the rehydration contract: drop box names come from the
// box-sources payload, material names come from the bundled catalog, the rare
// uncatalogued item keys keep their label from `extras`, and any failure
// degrades to "missing" rather than throwing.

const BOX_PAYLOAD = {
  schemaVersion: 1,
  boxes: {
    "910011": {
      name: "Normal Monster Box 1",
      grade: "COMMON",
      category: "common",
      drops: [],
      stages: [],
      dropStageRangeLabel: "",
      firstDropOnly: false,
      firstDropStages: [],
    },
  },
  extras: {},
};

const ITEM_PAYLOAD = {
  schemaVersion: 1,
  items: {
    "300001": {
      drops: [
        ["monster_box", 910011, 6.438, "RARE"],
        ["boss_box", 987654, 1.5, null],
      ],
      crafting: [
        {
          recipeKey: 6001001,
          tier: 1,
          craftingType: "MainWeapon",
          level: { min: 1, max: 10 },
          outputPct: 2.7778,
          m: [[140003, 1]],
        },
      ],
      usedIn: [
        {
          recipeKey: 6001007,
          craftingType: "Accessory",
          tier: 1,
          level: { min: 1, max: 10 },
          m: [
            [300001, 1],
            [999888, 2],
          ],
          outputs: [[601011, 2.5253]],
        },
      ],
    },
  },
  stages: {
    "101": {
      monsters: ["Slime"],
      boxes: [{ boxItemKey: 910011, name: "Normal Monster Box 1", grade: "COMMON" }],
    },
  },
  extras: { "999888": { name: "Removed Material", grade: null } },
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("box-sources.json")) {
        return { ok: true, json: async () => BOX_PAYLOAD };
      }
      if (url.endsWith("item-sources.json")) {
        return { ok: true, json: async () => ITEM_PAYLOAD };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

describe("web item sources store", () => {
  beforeEach(() => {
    vi.resetModules();
    installWebDataSource();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is idle until requested", async () => {
    const store = await import("../../src/web/itemSourcesSnapshot");
    expect(store.getWebItemSourcesStatus()).toBe("idle");
    expect(store.getWebItemSources()).toBeNull();
    expect(store.getWebStages()).toBeNull();
  });

  it("rehydrates drops, crafting and usedIn from the slim payload", async () => {
    stubFetch();
    const store = await import("../../src/web/itemSourcesSnapshot");
    await store.ensureItemSourcesLoaded();

    expect(store.getWebItemSourcesStatus()).toBe("ready");
    const item = store.getWebItemSources()?.["300001"];
    expect(item).toBeDefined();

    // Drop box names come from the box-sources payload, not the item payload.
    expect(item!.drops[0]).toEqual({
      via: "monster_box",
      boxItemKey: 910011,
      dropPct: 6.438,
      grade: "RARE",
      boxName: "Normal Monster Box 1",
    });

    // Material names rehydrate from the bundled `lookup_items.json`.
    const expectedMaterial = loadLookupItems().find((it) => it.id === 140003);
    expect(expectedMaterial).toBeDefined();
    expect(item!.crafting[0].materials[0]).toEqual({
      itemKey: 140003,
      amount: 1,
      name: expectedMaterial!.name,
    });
    expect(item!.crafting[0].outputPct).toBe(2.7778);

    // Outputs map back to the `{ itemKey, poolPct }` shape.
    expect(item!.usedIn![0].outputs[0]).toEqual({ itemKey: 601011, poolPct: 2.5253 });
  });

  it("keeps the label of a material whose item key is not in the catalog", async () => {
    stubFetch();
    const store = await import("../../src/web/itemSourcesSnapshot");
    await store.ensureItemSourcesLoaded();

    const item = store.getWebItemSources()?.["300001"];
    expect(item!.usedIn![0].materials[1]).toEqual({
      itemKey: 999888,
      amount: 2,
      name: "Removed Material",
    });
  });

  it("falls back to a #id box name when the box-sources payload lacks the box", async () => {
    stubFetch();
    const store = await import("../../src/web/itemSourcesSnapshot");
    await store.ensureItemSourcesLoaded();

    const item = store.getWebItemSources()?.["300001"];
    expect(item!.drops[1].boxName).toBe("#987654");
    // A drop with no grade in the payload degrades to null, never undefined.
    expect(item!.drops[1].grade).toBeNull();
  });

  it("passes the stages subtree through verbatim", async () => {
    stubFetch();
    const store = await import("../../src/web/itemSourcesSnapshot");
    await store.ensureItemSourcesLoaded();

    expect(store.getWebStages()).toEqual(ITEM_PAYLOAD.stages);
  });

  it("degrades to missing on a 404 instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    const store = await import("../../src/web/itemSourcesSnapshot");
    await store.ensureItemSourcesLoaded();

    expect(store.getWebItemSourcesStatus()).toBe("missing");
    expect(store.getWebItemSources()).toBeNull();
    // Idempotent: a second call does not refetch.
    await store.ensureItemSourcesLoaded();
    expect(store.getWebItemSourcesStatus()).toBe("missing");
  });

  it("degrades to missing on a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ nope: 1 }) })),
    );
    const store = await import("../../src/web/itemSourcesSnapshot");
    await store.ensureItemSourcesLoaded();

    expect(store.getWebItemSourcesStatus()).toBe("missing");
    expect(store.getWebItemSources()).toBeNull();
  });
});
