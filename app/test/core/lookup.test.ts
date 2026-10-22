import { describe, expect, it } from "vitest";
import { loadLookupItems, loadLookupSources, lookupItemIndex } from "../../src/core/lookup/catalog";
import { classForGearType } from "../../src/core/lookup/classRestriction";

describe("lookup catalog", () => {
  it("loads only obtainable gear and materials", () => {
    const items = loadLookupItems();
    expect(items.length).toBeGreaterThan(1000);
    for (const item of items) {
      expect(["GEAR", "MATERIAL"]).toContain(item.type);
      expect(item.iconPath).toBeTruthy();
    }
  });

  it("gear rows carry stats, material rows carry gearGroup outcomes", () => {
    const items = loadLookupItems();
    const gear = items.find((i) => i.type === "GEAR");
    const material = items.find((i) => i.type === "MATERIAL");
    expect(gear?.stats?.base.length).toBeGreaterThan(0);
    expect(material?.gearGroups?.length).toBeGreaterThan(0);
  });

  it("indexes items by id", () => {
    const items = loadLookupItems();
    const index = lookupItemIndex(items);
    expect(index.size).toBe(items.length);
    expect(index.get(items[0].id)).toEqual(items[0]);
  });

  it("carries the v1.3.0 relic family's inherent stat range", () => {
    const items = loadLookupItems();
    const relics = items.filter((i) => i.relic != null);
    expect(relics.length).toBeGreaterThan(100);
    for (const relic of relics) {
      expect(relic.gearGroup).toBe("RELIC");
      expect(relic.relic!.relicType).toBeTruthy();
      // The inherent stat is a ROLL range, not a fixed value.
      if (relic.relic!.inherent) {
        const { rawMin, rawMax, displayMin, displayMax, displayText } = relic.relic!.inherent;
        expect(rawMax).toBeGreaterThanOrEqual(rawMin);
        expect(displayMax).toBeGreaterThanOrEqual(displayMin);
        expect(displayText).toBeTruthy();
      }
    }
    // A relic with a real stat range exists (tier 1 = COMMON).
    const withStat = relics.find((r) => r.relic!.inherent != null);
    expect(withStat).toBeTruthy();
  });

  it("carries the v1.3.0 reliquary's stat pool, slots and resonances", () => {
    const items = loadLookupItems();
    const reliquaries = items.filter((i) => i.reliquary != null);
    expect(reliquaries.length).toBeGreaterThan(100);
    for (const box of reliquaries) {
      expect(box.gearGroup).toBe("RELIQUARY");
      const rq = box.reliquary!;
      expect(rq.inherentPool?.length ?? 0).toBeGreaterThan(0);
      expect(rq.inherentStatCount ?? 0).toBeGreaterThan(0);
      expect(rq.slotIndexes?.length ?? 0).toBeGreaterThan(0);
      for (const resonance of rq.resonances ?? []) {
        expect(resonance.condition).toBeTruthy();
        expect(resonance.effect.mod).toBeTruthy();
      }
    }
  });

  it("carries the attunement cost for relics and reliquaries", () => {
    const items = loadLookupItems();
    const withCost = items.filter((i) => i.attunement != null);
    expect(withCost.length).toBeGreaterThan(100);
    for (const item of withCost) {
      expect(item.attunement!.baseCost).toBeGreaterThan(0);
      expect(item.attunement!.costIncrease).toBeGreaterThan(0);
      expect(item.attunement!.maxCount).toBeGreaterThan(0);
    }
  });

  it("does not treat the relic family as class-restricted gear", () => {
    // Relics / reliquaries have no weapon type — they must not inherit a
    // hero class restriction from the weapon mapping.
    expect(classForGearType("RELIC_RED")).toBeNull();
    expect(classForGearType("RELIQUARY")).toBeNull();
  });

  it("loads the item/box/stage source graph keyed by id", () => {
    const sources = loadLookupSources();
    expect(Object.keys(sources.items).length).toBeGreaterThan(0);
    expect(Object.keys(sources.boxes).length).toBeGreaterThan(0);
    expect(Object.keys(sources.stages).length).toBeGreaterThan(0);
    const box = sources.boxes["910011"];
    expect(box.name).toBeTruthy();
    expect(box.category).toBe("common");
    expect(box.dropStageRangeLabel).toBeTruthy();
    expect(box.firstDropOnly).toBe(false);
    expect(box.stages[0]?.spawnPct).toBeGreaterThan(0);
  });

  it("material items carry a usedIn reverse-index for crafting recipes", () => {
    const sources = loadLookupSources();
    const leather = sources.items["140003"];
    expect(leather).toBeDefined();
    expect(leather.usedIn).toBeDefined();
    expect(leather.usedIn!.length).toBeGreaterThan(0);
    const entry = leather.usedIn![0];
    expect(entry.recipeKey).toBeGreaterThan(0);
    expect(typeof entry.craftingType).toBe("string");
    expect(entry.tier).toBeGreaterThan(0);
    expect(entry.level.min).toBeGreaterThan(0);
    expect(entry.level.max).toBeGreaterThanOrEqual(entry.level.min);
    expect(entry.materials.length).toBeGreaterThan(0);
    expect(entry.outputs.length).toBeGreaterThan(0);
    expect(entry.outputs[0].itemKey).toBeGreaterThan(0);
    expect(entry.outputs[0].poolPct).toBeGreaterThan(0);
  });

  it("usedIn is present on craftable materials only", () => {
    const sources = loadLookupSources();
    const withUsedIn = Object.values(sources.items).filter((src) => (src.usedIn?.length ?? 0) > 0);
    expect(withUsedIn).toHaveLength(36);
    expect(sources.items["301011"]?.usedIn).toBeUndefined();
    expect(sources.items["112005"]?.usedIn).toBeUndefined();
    expect(sources.items["144002"]?.usedIn?.length).toBeGreaterThan(0);
  });
});

describe("classForGearType", () => {
  it("maps weapon gearTypes to their class", () => {
    expect(classForGearType("SCEPTER")).toBe("Priest");
    expect(classForGearType("TOME")).toBe("Priest");
    expect(classForGearType("BOW")).toBe("Ranger");
    expect(classForGearType("ARROW")).toBe("Ranger");
    expect(classForGearType("AXE")).toBe("Slayer");
  });

  it("returns null for class-agnostic armor/accessory gearTypes", () => {
    expect(classForGearType("HELMET")).toBeNull();
    expect(classForGearType("AMULET")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(classForGearType(null)).toBeNull();
  });
});
