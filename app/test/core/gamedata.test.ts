import { describe, it, expect } from "vitest";
import {
  catalogItemKeyFromSave,
  isMarketPipelineSaveItemKey,
  indexById,
  normalizeGameItem,
  gameItemName,
  type GameItem,
} from "../../src/core/gamedata";
import type { LocaleCatalog } from "../../src/core/localeCatalog";

describe("gamedata", () => {
  it("normalizes catalog rows from JSON", () => {
    expect(
      normalizeGameItem({
        id: 322111,
        name: "Void Staff",
        grade: "RARE",
        type: "GEAR",
        level: 50,
        marketTradable: false,
      }),
    ).toEqual({
      id: 322111,
      name: "Void Staff",
      grade: "RARE",
      type: "GEAR",
      level: 50,
      marketTradable: false,
    });
  });

  it("indexes by id for ItemKey lookup", () => {
    const items: GameItem[] = [
      {
        id: 322111,
        name: "Void Staff",
        grade: "RARE",
        type: "GEAR",
        level: 50,
        marketTradable: false,
      },
    ];
    const idx = indexById(items);
    expect(idx.get(322111)?.name).toBe("Void Staff");
    expect(idx.get(999999)).toBeUndefined();
  });

  it("maps suffixed save ItemKeys to catalog ids", () => {
    expect(catalogItemKeyFromSave(322111)).toBe(322111);
    expect(catalogItemKeyFromSave(514051900)).toBe(514051);
    expect(catalogItemKeyFromSave(140001900)).toBe(140001);
    expect(catalogItemKeyFromSave(910151900)).toBe(910151);
    expect(catalogItemKeyFromSave(1_500_000_000)).toBe(1_500_000_000);
  });

  it("detects market-pipeline save ItemKeys (suffix 900)", () => {
    expect(isMarketPipelineSaveItemKey(160006900)).toBe(true);
    expect(isMarketPipelineSaveItemKey(514051900)).toBe(true);
    expect(isMarketPipelineSaveItemKey(514051800)).toBe(false);
    expect(isMarketPipelineSaveItemKey(160006)).toBe(false);
  });

  it("returns null for invalid catalog rows", () => {
    expect(normalizeGameItem({ name: "no id" })).toBeNull();
  });
});

describe("gameItemName with LocaleCatalog", () => {
  const baseItem: GameItem = {
    id: 530017,
    name: "ItemName_530017",
    grade: "COMMON",
    type: "MATERIAL",
    level: null,
    marketTradable: true,
  };

  it("returns localized name when item.name is 'ItemName_<id>' and catalog has the id", () => {
    const catalog: LocaleCatalog = {
      items: { "530017": "Goblin Hide" },
      stages: {},
      heroes: {},
      difficulties: {},
    };
    expect(gameItemName({ ...baseItem }, catalog)).toBe("Goblin Hide");
  });

  it("falls back to item.name when item.name is 'ItemName_<id>' but catalog is null", () => {
    expect(gameItemName({ ...baseItem }, null)).toBe("ItemName_530017");
  });

  it("falls back to item.name when item.name is 'ItemName_<id>' but catalog does not have the id", () => {
    const catalog: LocaleCatalog = {
      items: {},
      stages: {},
      heroes: {},
      difficulties: {},
    };
    expect(gameItemName({ ...baseItem }, catalog)).toBe("ItemName_530017");
  });

  it("returns item.name directly when it is a hardcoded English name (not 'ItemName_*')", () => {
    const item: GameItem = {
      id: 110001,
      name: "Long Sword",
      grade: "COMMON",
      type: "GEAR",
      level: 1,
      marketTradable: false,
    };
    const catalog: LocaleCatalog = {
      items: { "999": "Should not be used" },
      stages: {},
      heroes: {},
      difficulties: {},
    };
    expect(gameItemName(item, catalog)).toBe("Long Sword");
  });

  it("returns item.name when catalog is null and name is not 'ItemName_*'", () => {
    const item: GameItem = {
      id: 110002,
      name: "Iron Helmet",
      grade: "COMMON",
      type: "GEAR",
      level: 1,
      marketTradable: false,
    };
    expect(gameItemName(item, null)).toBe("Iron Helmet");
  });
});
