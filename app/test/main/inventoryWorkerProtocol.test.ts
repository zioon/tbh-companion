import { describe, expect, it } from "vitest";
import {
  handleInit,
  handleResolve,
  type InventoryWorkerState,
  type InventoryWorkerInitMessage,
  type InventoryWorkerResolveMessage,
} from "../../src/main/services/inventoryWorkerProtocol";
import type { GameItem } from "../../src/core/gamedata";
import type {
  InventoryItemInstance,
  InventoryPriceInfo,
  InventorySnapshot,
} from "../../shared/types";
import { getTbhMarketFeeRates } from "../../src/core/steamMarketFeeBundled";

const FEE_RATES = getTbhMarketFeeRates();

function makeGameItem(overrides: Partial<GameItem> = {}): GameItem {
  return {
    id: 1,
    name: "Test Item",
    grade: "COMMON",
    type: "GEAR",
    level: null,
    marketTradable: true,
    ...overrides,
  };
}

function makeSnapshot(items: InventoryItemInstance[]): InventorySnapshot {
  return {
    items,
    chests: [],
    saveMtime: 0,
    inventoryCapacity: 100,
    inventoryUsed: items.length,
  };
}

function makeInstance(itemKey: number): InventoryItemInstance {
  return {
    itemKey,
    location: "inventory",
    inUse: false,
    isChaotic: false,
  };
}

function makePriceInfo(overrides: Partial<InventoryPriceInfo> = {}): InventoryPriceInfo {
  return {
    median: 10,
    lowest: 5,
    rawMedian: "$10.00",
    rawLowest: "$5.00",
    buyOrder: null,
    rawBuyOrder: null,
    ...overrides,
  };
}

describe("inventoryWorkerProtocol", () => {
  describe("handleInit", () => {
    it("builds state from init message with gameData map and fee rates", () => {
      const gameItem = makeGameItem({ id: 42, name: "Sword" });
      const msg: InventoryWorkerInitMessage = {
        type: "init",
        gameDataEntries: [[42, gameItem]],
        feeRates: FEE_RATES,
      };
      const state = handleInit(null, msg);
      expect(state.gameDataMap.get(42)).toEqual(gameItem);
      expect(state.feeRates).toBe(FEE_RATES);
    });

    it("replaces previous state on re-init (does not merge)", () => {
      const oldItem = makeGameItem({ id: 1, name: "Old" });
      const newItem = makeGameItem({ id: 2, name: "New" });
      const prev: InventoryWorkerState = {
        gameDataMap: new Map([[1, oldItem]]),
        feeRates: FEE_RATES,
      };
      const msg: InventoryWorkerInitMessage = {
        type: "init",
        gameDataEntries: [[2, newItem]],
        feeRates: FEE_RATES,
      };
      const state = handleInit(prev, msg);
      expect(state.gameDataMap.has(1)).toBe(false);
      expect(state.gameDataMap.get(2)).toEqual(newItem);
    });
  });

  describe("handleResolve", () => {
    it("throws when state is null (not initialized)", () => {
      const msg: InventoryWorkerResolveMessage = {
        type: "resolve",
        id: 1,
        snapshot: makeSnapshot([]),
        priceLookupEntries: [],
      };
      expect(() => handleResolve(null, msg)).toThrow(/not initialized/i);
    });

    it("resolves an empty snapshot to an empty rows array", () => {
      const state = handleInit(null, {
        type: "init",
        gameDataEntries: [],
        feeRates: FEE_RATES,
      });
      const msg: InventoryWorkerResolveMessage = {
        type: "resolve",
        id: 1,
        snapshot: makeSnapshot([]),
        priceLookupEntries: [],
      };
      const result = handleResolve(state, msg);
      expect(result.rows).toEqual([]);
      expect(result.inventoryUsed).toBe(0);
    });

    it("resolves instances against the cached gameData map", () => {
      const gameItem = makeGameItem({ id: 7, name: "Helm", grade: "RARE" });
      const state = handleInit(null, {
        type: "init",
        gameDataEntries: [[7, gameItem]],
        feeRates: FEE_RATES,
      });
      const msg: InventoryWorkerResolveMessage = {
        type: "resolve",
        id: 1,
        snapshot: makeSnapshot([makeInstance(7), makeInstance(7)]),
        priceLookupEntries: [],
      };
      const result = handleResolve(state, msg);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].itemKey).toBe(7);
      expect(result.rows[0].name).toBe("Helm");
      expect(result.rows[0].count).toBe(2);
      expect(result.rows[0].grade).toBe("RARE");
    });

    it("applies price lookup entries to rows with matching market_hash_name", () => {
      // MATERIAL items are always priceable (hash = item name). GEAR needs a
      // Legendary+ grade to be priceable, which would couple this test to
      // grade-ranking logic — MATERIAL keeps the assertion isolated.
      const gameItem = makeGameItem({ id: 7, name: "Iron Ore", type: "MATERIAL" });
      const state = handleInit(null, {
        type: "init",
        gameDataEntries: [[7, gameItem]],
        feeRates: FEE_RATES,
      });
      const msg: InventoryWorkerResolveMessage = {
        type: "resolve",
        id: 1,
        snapshot: makeSnapshot([makeInstance(7)]),
        priceLookupEntries: [],
      };
      const result = handleResolve(state, msg);
      // Without priceLookup, unitPrice is null and priceChecked is false.
      expect(result.rows[0].unitPrice).toBeNull();
      expect(result.rows[0].priceChecked).toBe(false);
      expect(result.rows[0].marketHashName).toBe("Iron Ore");

      // Feed a price entry under the resolved hash and verify wiring.
      const priced: InventoryWorkerResolveMessage = {
        ...msg,
        id: 2,
        priceLookupEntries: [["Iron Ore", makePriceInfo({ median: 100, rawMedian: "$100.00" })]],
      };
      const pricedResult = handleResolve(state, priced);
      expect(pricedResult.rows[0].priceChecked).toBe(true);
      expect(pricedResult.rows[0].rawMedian).toBe("$100.00");
    });

    it("excludes items by itemKey when excludeItemKeys is provided", () => {
      const gameItem = makeGameItem({ id: 99, name: "Stage Box", type: "STAGEBOX" });
      const keepItem = makeGameItem({ id: 5, name: "Sword", type: "GEAR" });
      const state = handleInit(null, {
        type: "init",
        gameDataEntries: [
          [99, gameItem],
          [5, keepItem],
        ],
        feeRates: FEE_RATES,
      });
      const msg: InventoryWorkerResolveMessage = {
        type: "resolve",
        id: 1,
        snapshot: makeSnapshot([makeInstance(99), makeInstance(5)]),
        priceLookupEntries: [],
        excludeItemKeys: [99],
      };
      const result = handleResolve(state, msg);
      expect(result.rows.map((r) => r.itemKey)).toEqual([5]);
    });
  });
});
