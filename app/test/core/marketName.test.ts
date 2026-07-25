import { describe, it, expect } from "vitest";
import {
  isPriceableItem,
  isPlaceholderItemName,
  marketHashName,
  marketHashMatch,
  marketHashCandidates,
  limitGearVariantHashes,
  GEAR_MARKET_VARIANT_LETTERS,
} from "../../src/core/marketName";
import type { GameItem } from "../../src/core/gamedata";

const mat: GameItem = {
  id: 141002,
  name: "Iron Ingot",
  grade: "UNCOMMON",
  type: "MATERIAL",
  level: null,
  marketTradable: true,
};

const gearLeg: GameItem = {
  id: 303071,
  name: "Knight Sword",
  grade: "LEGENDARY",
  type: "GEAR",
  level: 30,
  marketTradable: true,
};

const gearRare: GameItem = {
  id: 322111,
  name: "Void Staff",
  grade: "RARE",
  type: "GEAR",
  level: 50,
  marketTradable: true,
};

describe("isPriceableItem", () => {
  it("prices all tradable materials regardless of grade", () => {
    expect(isPriceableItem("MATERIAL", "COMMON", true)).toBe(true);
    expect(isPriceableItem("MATERIAL", "RARE", true)).toBe(true);
  });

  it("only prices Legendary+ gear", () => {
    expect(isPriceableItem("GEAR", "RARE", true)).toBe(false);
    expect(isPriceableItem("GEAR", "LEGENDARY", true)).toBe(true);
    expect(isPriceableItem("GEAR", "IMMORTAL", true)).toBe(true);
  });

  it("skips non-tradable items", () => {
    expect(isPriceableItem("GEAR", "LEGENDARY", false)).toBe(false);
  });
});

describe("marketHashName", () => {
  it("maps materials by display name", () => {
    expect(marketHashName(mat)).toBe("Iron Ingot");
  });

  it("maps Legendary gear to (<Grade>) A", () => {
    expect(marketHashName(gearLeg)).toBe("Knight Sword (Legendary) A");
  });

  it("returns null for Rare gear", () => {
    expect(marketHashName(gearRare)).toBeNull();
  });

  it("builds hash from name and grade", () => {
    const dusk: GameItem = {
      id: 314071,
      name: "Dusk Bow",
      grade: "IMMORTAL",
      type: "GEAR",
      level: 30,
      marketTradable: true,
    };
    expect(marketHashName(dusk)).toBe("Dusk Bow (Immortal) A");
  });

  it("uses exact grade (no cross-grade fallback)", () => {
    const boots: GameItem = {
      id: 533111,
      name: "Mystic Boots",
      grade: "LEGENDARY",
      type: "GEAR",
      level: 50,
      marketTradable: true,
    };
    expect(marketHashMatch(boots)?.name).toBe("Mystic Boots (Legendary) A");
  });

  it("lists variant A only for gear Steam probing", () => {
    expect(GEAR_MARKET_VARIANT_LETTERS).toEqual(["A"]);
    expect(marketHashCandidates(gearLeg)).toEqual(["Knight Sword (Legendary) A"]);
    expect(marketHashCandidates(mat)).toEqual(["Iron Ingot"]);
  });

  it("drops non-A gear variant hashes from stale inputs", () => {
    expect(
      limitGearVariantHashes([
        "Knight Sword (Legendary) A",
        "Knight Sword (Legendary) B",
        "Knight Sword (Legendary) C",
        "Iron Ingot",
      ]),
    ).toEqual(["Knight Sword (Legendary) A", "Iron Ingot"]);
  });
});

describe("sourceName (English hash under localized UI)", () => {
  it("prefers sourceName over name for MATERIAL hash", () => {
    // Simulate a coin rendered in Chinese: display name is "铜币" but the
    // English source name "Copper Coin" is preserved via sourceName.
    // The snapshot is keyed by "Copper Coin", so the hash must be English.
    const localizedMat: GameItem & { sourceName?: string } = {
      ...mat,
      name: "铜币",
      sourceName: "Iron Ingot",
    };
    expect(marketHashName(localizedMat)).toBe("Iron Ingot");
    expect(marketHashMatch(localizedMat)?.name).toBe("Iron Ingot");
    expect(marketHashCandidates(localizedMat)).toEqual(["Iron Ingot"]);
  });

  it("prefers sourceName over name for GEAR hash", () => {
    const localizedGear: GameItem & { sourceName?: string } = {
      ...gearLeg,
      name: "骑士之剑",
      sourceName: "Knight Sword",
    };
    expect(marketHashName(localizedGear)).toBe("Knight Sword (Legendary) A");
    expect(marketHashCandidates(localizedGear)).toEqual(["Knight Sword (Legendary) A"]);
  });

  it("falls back to name when sourceName is absent", () => {
    // GameItem from the bundled catalog has no sourceName — hash falls back
    // to name (English). This is the path used by snapshot builders and
    // inventory/TrackingService, which all work with English source data.
    expect(marketHashName(mat)).toBe("Iron Ingot");
    expect(marketHashName(gearLeg)).toBe("Knight Sword (Legendary) A");
  });

  it("treats sourceName placeholder as non-priceable even when name is localized", () => {
    // Edge case: bundled item whose English source name is an unresolved
    // ItemName_ placeholder. The localized name might look real, but Steam
    // has no listing for placeholders — guard on sourceName wins.
    const placeholderLocalized: GameItem & { sourceName?: string } = {
      id: 145002,
      name: "铜币",
      grade: "ARCANA",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
      sourceName: "ItemName_145002",
    };
    expect(marketHashName(placeholderLocalized)).toBeNull();
    expect(marketHashCandidates(placeholderLocalized)).toEqual([]);
  });
});

describe("isPlaceholderItemName", () => {
  it("flags unresolved ItemName_ keys from build_catalog.py fallback", () => {
    expect(isPlaceholderItemName("ItemName_145002")).toBe(true);
    expect(isPlaceholderItemName("ItemName_420017")).toBe(true);
  });

  it("lets real localized names through", () => {
    expect(isPlaceholderItemName("Iron Ingot")).toBe(false);
    expect(isPlaceholderItemName("Knight Sword")).toBe(false);
    expect(isPlaceholderItemName("#145002")).toBe(false);
  });
});

describe("placeholder name defense", () => {
  it("marketHashName returns null for ItemName_ placeholders even when priceable", () => {
    const placeholderMat: GameItem = {
      id: 145002,
      name: "ItemName_145002",
      grade: "ARCANA",
      type: "MATERIAL",
      level: null,
      marketTradable: true,
    };
    // Sanity: would be priceable if the name were real.
    expect(
      isPriceableItem(placeholderMat.type, placeholderMat.grade, placeholderMat.marketTradable),
    ).toBe(true);
    // But the placeholder guard wins:
    expect(marketHashName(placeholderMat)).toBeNull();
    expect(marketHashMatch(placeholderMat)).toBeNull();
    expect(marketHashCandidates(placeholderMat)).toEqual([]);
  });

  it("marketHashName returns null for ItemName_ gear placeholders even at Legendary+", () => {
    const placeholderGear: GameItem = {
      id: 420017,
      name: "ItemName_420017",
      grade: "LEGENDARY",
      type: "GEAR",
      level: 80,
      marketTradable: true,
    };
    expect(
      isPriceableItem(placeholderGear.type, placeholderGear.grade, placeholderGear.marketTradable),
    ).toBe(true);
    expect(marketHashName(placeholderGear)).toBeNull();
    expect(marketHashCandidates(placeholderGear)).toEqual([]);
  });
});
