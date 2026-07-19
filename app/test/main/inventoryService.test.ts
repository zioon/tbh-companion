import { describe, it, expect, vi } from "vitest";
import { InventoryService, mergeLookupNames } from "../../src/main/services/InventoryService";
import type { GameItem } from "../../src/core/gamedata";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";
import type { InventorySnapshot, LookupItem } from "../../shared/types";

function snap(used: number, capacity: number): InventorySnapshot {
  return { items: [], chests: [], saveMtime: 0, inventoryCapacity: capacity, inventoryUsed: used };
}

describe("InventoryService almost-full threshold", () => {
  it("fires once on the rising edge across the threshold", () => {
    const service = new InventoryService();
    const onAlmostFull = vi.fn();
    service.setOnAlmostFull(onAlmostFull, () => 90);

    service.onInventory(snap(80, 100));
    expect(onAlmostFull).not.toHaveBeenCalled();

    service.onInventory(snap(90, 100));
    expect(onAlmostFull).toHaveBeenCalledTimes(1);
    expect(onAlmostFull).toHaveBeenCalledWith({ used: 90, capacity: 100 });

    service.onInventory(snap(95, 100));
    expect(onAlmostFull).toHaveBeenCalledTimes(1);
  });

  it("re-fires after dropping back below the threshold and crossing again", () => {
    const service = new InventoryService();
    const onAlmostFull = vi.fn();
    service.setOnAlmostFull(onAlmostFull, () => 90);

    service.onInventory(snap(90, 100));
    service.onInventory(snap(80, 100));
    service.onInventory(snap(90, 100));

    expect(onAlmostFull).toHaveBeenCalledTimes(2);
  });

  it("does not fire when no callback is registered", () => {
    const service = new InventoryService();
    expect(() => service.onInventory(snap(100, 100))).not.toThrow();
  });

  it("skips when capacity is zero", () => {
    const service = new InventoryService();
    const onAlmostFull = vi.fn();
    service.setOnAlmostFull(onAlmostFull, () => 90);
    service.onInventory(snap(0, 0));
    expect(onAlmostFull).not.toHaveBeenCalled();
  });
});

describe("InventoryService auto market-scan toggle", () => {
  it("calls ensureOwnedPrices on inventory updates by default", () => {
    const service = new InventoryService();
    const spy = vi.spyOn(service, "ensureOwnedPrices").mockResolvedValue(undefined);

    service.onInventory(snap(1, 100));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips ensureOwnedPrices when auto-scan is disabled", () => {
    const service = new InventoryService();
    const spy = vi.spyOn(service, "ensureOwnedPrices").mockResolvedValue(undefined);

    service.setAutoScanEnabled(false);
    spy.mockClear();
    service.onInventory(snap(1, 100));

    expect(spy).not.toHaveBeenCalled();
  });

  it("re-enables auto-scan and catches up via ensureOwnedPrices", () => {
    const service = new InventoryService();
    const spy = vi.spyOn(service, "ensureOwnedPrices").mockResolvedValue(undefined);

    service.setAutoScanEnabled(false);
    spy.mockClear();
    service.setAutoScanEnabled(true);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when toggling to the same value", () => {
    const service = new InventoryService();
    const spy = vi.spyOn(service, "ensureOwnedPrices").mockResolvedValue(undefined);

    // Default is true → toggling to true should be a no-op (no catch-up call).
    service.setAutoScanEnabled(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("cancels the in-flight refresh and clears the queue when disabled", () => {
    const service = new InventoryService();
    const cancel = vi.fn();
    // Inject a stub market so we can observe cancel() being called.
    Object.defineProperty(service, "market", {
      configurable: true,
      value: { cancel, status: () => ({ running: true, currency: "USD" }) },
    });

    service.setAutoScanEnabled(false);

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("InventoryService low-value skip filter", () => {
  it("drops targets whose lookup price is at or below the threshold", () => {
    const service = new InventoryService();
    service.setLookupPriceSnapshot({
      schemaVersion: 1,
      generatedUtc: new Date().toISOString(),
      baseCurrency: "USD",
      prices: {
        "Cheap Ore": 0.02, // at threshold (default 0.05) → skip
        "Gold Ingot": 5.0, // well above → keep
        "Silver Bar": null, // confirmed no listing → skip
      },
      fetchedUtc: {},
      fx: {},
    });

    // Use the private filter via reflection so we don't have to mock the
    // whole market refresh pipeline.
    const filtered = service["filterLowValueTargets"](
      [
        { kind: "material", hash: "Cheap Ore" },
        { kind: "material", hash: "Gold Ingot" },
        { kind: "material", hash: "Silver Bar" },
        { kind: "material", hash: "Unknown Crystal" }, // not in snapshot → keep
      ],
      false,
    );

    const hashes = filtered.map((t) => (t.kind === "material" ? t.hash : ""));
    // "Cheap Ore" (0.02 ≤ 0.05) → skip; "Silver Bar" (null = no listing) → skip;
    // "Gold Ingot" (5.0 > 0.05) → keep; "Unknown Crystal" (not in snapshot) → keep.
    expect(hashes).toEqual(["Gold Ingot", "Unknown Crystal"]);
  });

  it("keeps everything when threshold is 0", () => {
    const service = new InventoryService();
    service.setLowValueThresholdUsd(0);
    service.setLookupPriceSnapshot({
      schemaVersion: 1,
      generatedUtc: new Date().toISOString(),
      baseCurrency: "USD",
      prices: { "Cheap Ore": 0.001 },
      fetchedUtc: {},
      fx: {},
    });

    const filtered = service["filterLowValueTargets"](
      [{ kind: "material", hash: "Cheap Ore" }],
      false,
    );

    expect(filtered).toHaveLength(1);
  });

  it("keeps everything when snapshot is missing", () => {
    const service = new InventoryService();
    service.setLookupPriceSnapshot(null);

    const filtered = service["filterLowValueTargets"](
      [{ kind: "material", hash: "Anything" }],
      false,
    );

    expect(filtered).toHaveLength(1);
  });

  it("force refresh bypasses the filter", () => {
    const service = new InventoryService();
    service.setLookupPriceSnapshot({
      schemaVersion: 1,
      generatedUtc: new Date().toISOString(),
      baseCurrency: "USD",
      prices: { "Cheap Ore": 0.01 },
      fetchedUtc: {},
      fx: {},
    });

    const filtered = service["filterLowValueTargets"](
      [{ kind: "material", hash: "Cheap Ore" }],
      true,
    );

    expect(filtered).toHaveLength(1);
  });
});

describe("mergeLookupNames", () => {
  function makeGameItem(overrides: Partial<GameItem> = {}): GameItem {
    return {
      id: 1,
      name: "Iron Ingot",
      grade: "UNCOMMON",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
      ...overrides,
    };
  }

  function makeLookupItem(overrides: Partial<LookupItem> = {}): LookupItem {
    return {
      id: 1,
      name: "Iron Ingot",
      grade: "UNCOMMON",
      type: "MATERIAL",
      gearType: null,
      gearGroup: null,
      materialType: null,
      level: null,
      iconPath: "item-1",
      marketTradable: true,
      ...overrides,
    };
  }

  it("replaces ItemName_<id> placeholder names with the lookup catalog's real name", () => {
    const gameData = new Map<number, GameItem>([
      [160006, makeGameItem({ id: 160006, name: "ItemName_160006" })],
      [141002, makeGameItem({ id: 141002, name: "Iron Ingot" })],
    ]);
    const lookup = new Map<number, LookupItem>([
      [160006, makeLookupItem({ id: 160006, name: "Empire 50th Anniversary Coin" })],
    ]);
    const merged = mergeLookupNames(gameData, lookup);
    expect(merged.get(160006)?.name).toBe("Empire 50th Anniversary Coin");
    // Untouched when name is already a real string.
    expect(merged.get(141002)?.name).toBe("Iron Ingot");
  });

  it("leaves placeholder names in place when the lookup catalog has no entry", () => {
    const gameData = new Map<number, GameItem>([
      [999999, makeGameItem({ id: 999999, name: "ItemName_999999" })],
    ]);
    const merged = mergeLookupNames(gameData, new Map());
    expect(merged.get(999999)?.name).toBe("ItemName_999999");
  });

  it("returns the original map reference when lookup is empty (no copy cost)", () => {
    const gameData = new Map<number, GameItem>([[1, makeGameItem()]]);
    expect(mergeLookupNames(gameData, new Map())).toBe(gameData);
  });

  it("does not mutate the input GameItem objects (returns new objects for replaced rows)", () => {
    const original = makeGameItem({ id: 160006, name: "ItemName_160006" });
    const gameData = new Map<number, GameItem>([[160006, original]]);
    const lookup = new Map<number, LookupItem>([
      [160006, makeLookupItem({ id: 160006, name: "Empire 50th Anniversary Coin" })],
    ]);
    mergeLookupNames(gameData, lookup);
    expect(original.name).toBe("ItemName_160006");
  });
});

describe("InventoryService.setLookupCatalog", () => {
  it("replaces placeholder names seen by the per-row price refresh path", () => {
    const service = new InventoryService();
    // Inject a stub gameData via reflection. The provider's `get` is what
    // `getMergedGameItem` consults, so we stub the lookup the same way the
    // existing low-value-skip test does.
    const placeholderItem: GameItem = {
      id: 160006,
      name: "ItemName_160006",
      grade: "ARCANA",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
    };
    service["gameData"]["index"] = new Map([[160006, placeholderItem]]);
    service["gameData"]["loaded"] = true;

    const lookupItem: LookupItem = {
      id: 160006,
      name: "Empire 50th Anniversary Coin",
      grade: "ARCANA",
      type: "MATERIAL",
      gearType: null,
      gearGroup: null,
      materialType: "OFFERING",
      level: null,
      iconPath: "item-160006",
      marketTradable: true,
    };

    // Before the catalog is injected, the merged item still has the placeholder.
    expect(service["getMergedGameItem"](160006)?.name).toBe("ItemName_160006");

    // setLookupCatalog also schedules a worker re-init + resolve. Stub the
    // worker + market so the call doesn't spawn a utility process or crash.
    service["worker"].init = vi.fn().mockResolvedValue(undefined);
    service["worker"].isReady = vi.fn().mockReturnValue(false);
    service["market"] = { status: () => ({ currency: "USD" }) } as never;

    service.setLookupCatalog([lookupItem]);

    // After injection, the same item resolves to the real name — used by
    // `refreshItemPrices` and the worker's `marketHashName` lookup.
    expect(service["getMergedGameItem"](160006)?.name).toBe("Empire 50th Anniversary Coin");
    // The worker init payload should also carry the merged name.
    const initArgs = (service["worker"].init as ReturnType<typeof vi.fn>).mock.calls[0];
    const mergedMap = initArgs?.[0] as Map<number, GameItem>;
    expect(mergedMap.get(160006)?.name).toBe("Empire 50th Anniversary Coin");
  });
});

describe("InventoryService with LocaleCatalog", () => {
  function makePlaceholderItem(id: number): GameItem {
    return {
      id,
      name: `ItemName_${id}`,
      grade: "COMMON",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
    };
  }

  /** Inject a stub gameData via reflection — mirrors the setLookupCatalog test. */
  function injectItem(service: InventoryService, item: GameItem): void {
    service["gameData"]["index"] = new Map([[item.id, item]]);
    service["gameData"]["loaded"] = true;
  }

  it("has setLocaleCatalog method", () => {
    const service = new InventoryService();
    expect(typeof service.setLocaleCatalog).toBe("function");
  });

  it("defaults to emptyLocaleCatalog when no catalog is provided", () => {
    const service = new InventoryService();
    injectItem(service, makePlaceholderItem(530017));
    // No catalog → gameItemName returns the placeholder unchanged; the
    // lookup catalog is also empty so the placeholder stays.
    expect(service["getMergedGameItem"](530017)?.name).toBe("ItemName_530017");
  });

  it("uses catalog to localize item names via gameItemName", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      items: { "530017": "Goblin Hide" },
    };
    const service = new InventoryService(catalog);
    injectItem(service, makePlaceholderItem(530017));
    expect(service["getMergedGameItem"](530017)?.name).toBe("Goblin Hide");
  });

  it("setLocaleCatalog swaps the catalog used for item names", () => {
    const service = new InventoryService();
    injectItem(service, makePlaceholderItem(530017));
    // Initially empty catalog → placeholder name passes through.
    expect(service["getMergedGameItem"](530017)?.name).toBe("ItemName_530017");
    // Swap in a catalog with the localized name.
    service.setLocaleCatalog({
      ...emptyLocaleCatalog(),
      items: { "530017": "Goblin Hide" },
    });
    expect(service["getMergedGameItem"](530017)?.name).toBe("Goblin Hide");
  });

  it("locale catalog takes precedence over lookup catalog for placeholder names", () => {
    // Construct with a locale catalog that has the localized name.
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      items: { "530017": "Goblin Hide" },
    };
    const service = new InventoryService(catalog);
    injectItem(service, makePlaceholderItem(530017));
    // Stub worker + market so setLookupCatalog doesn't spawn a utility
    // process or crash (mirrors the setLookupCatalog test setup).
    service["worker"].init = vi.fn().mockResolvedValue(undefined);
    service["worker"].isReady = vi.fn().mockReturnValue(false);
    service["market"] = { status: () => ({ currency: "USD" }) } as never;

    // Inject a lookup catalog with a different English name. The locale
    // catalog should win.
    const lookupItem: LookupItem = {
      id: 530017,
      name: "Goblin Hide (English Fallback)",
      grade: "COMMON",
      type: "MATERIAL",
      gearType: null,
      gearGroup: null,
      materialType: null,
      level: null,
      iconPath: "item-530017",
      marketTradable: true,
    };
    service.setLookupCatalog([lookupItem]);

    expect(service["getMergedGameItem"](530017)?.name).toBe("Goblin Hide");
  });

  it("localizes hardcoded English names when catalog has the item id", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      items: { "530017": "Goblin Hide" },
    };
    const service = new InventoryService(catalog);
    const englishItem: GameItem = {
      id: 530017,
      name: "Iron Ingot",
      grade: "COMMON",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
    };
    injectItem(service, englishItem);
    // gameItemName looks up catalog.items[String(item.id)] first, so even
    // hardcoded English names get localized when the catalog has the id.
    expect(service["getMergedGameItem"](530017)?.name).toBe("Goblin Hide");
  });

  it("leaves hardcoded English names untouched when catalog lacks the item id", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      items: { "999999": "Should not be used" },
    };
    const service = new InventoryService(catalog);
    const englishItem: GameItem = {
      id: 530017,
      name: "Iron Ingot",
      grade: "COMMON",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
    };
    injectItem(service, englishItem);
    expect(service["getMergedGameItem"](530017)?.name).toBe("Iron Ingot");
  });
});
