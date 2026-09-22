import type { GameItem } from "../gamedata";
import { marketHashName } from "../marketName";
import { flattenOwnedHashes, ownedPriceTargets } from "./ownedPriceTargets";
import { pickMarketUnit } from "../steamPrice";
import type { SteamMarketFeeRates } from "../steamMarketFee";
import { getTbhMarketFeeRates } from "../steamMarketFeeBundled";
import { computeInventoryComposition } from "./composition";
import type {
  InventorySnapshot,
  InventoryItemInstance,
  ItemLocation,
  ResolvedInventory,
  ResolvedInventoryRow,
  InventoryPriceInfo,
  BuyOrderLevel,
  MaterialStackTotal,
} from "../../../shared/types";

export interface PriceLookup {
  (marketHashName: string): InventoryPriceInfo | undefined;
}

export interface ResolveInventoryOptions {
  /** Omit rows from the inventory table and composition (e.g. stage boxes). */
  excludeItemKey?: (itemKey: number) => boolean;
  /** Steam market fee rates for net-after-fees totals. Defaults to TBH bundled rates. */
  marketFeeRates?: SteamMarketFeeRates;
}

const EMPTY_UNIT = { unit: null, raw: null, source: null } as const;

type MarketUnit = ReturnType<typeof pickMarketUnit>;

interface MarketResolution {
  hash: string | null;
  unit: MarketUnit;
  rawMedian: string | null;
  rawLowest: string | null;
  priceChecked: boolean;
  buyOrderUnit: number | null;
  buyOrderRaw: string | null;
  buyOrderQuantity: number | null;
  buyOrderLevels: BuyOrderLevel[] | null;
  buyOrderChecked: boolean;
}

const NO_MARKET: MarketResolution = {
  hash: null,
  unit: EMPTY_UNIT,
  rawMedian: null,
  rawLowest: null,
  priceChecked: false,
  buyOrderUnit: null,
  buyOrderRaw: null,
  buyOrderQuantity: null,
  buyOrderLevels: null,
  buyOrderChecked: false,
};

function sellRawFromPrice(price: InventoryPriceInfo): {
  rawMedian: string | null;
  rawLowest: string | null;
} {
  return {
    rawMedian: price.rawMedian ?? null,
    rawLowest: price.rawLowest ?? null,
  };
}

function buyOrderFromPrice(price: InventoryPriceInfo): {
  unit: number | null;
  raw: string | null;
  quantity: number | null;
  levels: BuyOrderLevel[] | null;
  checked: boolean;
} {
  return {
    unit: price.buyOrder ?? null,
    raw: price.rawBuyOrder ?? null,
    quantity: price.buyOrderQuantity ?? null,
    levels: price.buyOrderLevels ?? null,
    checked: price.buyOrderFetched === true,
  };
}

function resolveMarketHashAndPrice(
  catalogItem: GameItem,
  priceLookup?: PriceLookup,
): MarketResolution {
  const hash = marketHashName(catalogItem);
  if (!hash) return NO_MARKET;

  const price = priceLookup?.(hash);
  if (!price) {
    return {
      hash,
      unit: EMPTY_UNIT,
      rawMedian: null,
      rawLowest: null,
      priceChecked: false,
      buyOrderUnit: null,
      buyOrderRaw: null,
      buyOrderQuantity: null,
      buyOrderLevels: null,
      buyOrderChecked: false,
    };
  }

  const unit = pickMarketUnit(price);
  const buy = buyOrderFromPrice(price);
  const sellRaw = sellRawFromPrice(price);
  return {
    hash,
    unit,
    rawMedian: sellRaw.rawMedian,
    rawLowest: sellRaw.rawLowest,
    priceChecked: true,
    buyOrderUnit: buy.unit,
    buyOrderRaw: buy.raw,
    buyOrderQuantity: buy.quantity,
    buyOrderLevels: buy.levels,
    buyOrderChecked: buy.checked,
  };
}

function createResolvedRow(
  itemKey: number,
  catalogItem: GameItem | undefined,
  market: MarketResolution,
): ResolvedInventoryRow {
  return {
    itemKey,
    name: catalogItem?.name ?? `Unknown #${itemKey}`,
    grade: catalogItem?.grade ?? "UNKNOWN",
    type: catalogItem?.type ?? "UNKNOWN",
    level: catalogItem?.level ?? null,
    marketTradable: catalogItem?.marketTradable ?? false,
    marketHashName: market.hash,
    count: 0,
    inUseCount: 0,
    inventoryCount: 0,
    stashCount: 0,
    tradingCount: 0,
    chaoticCount: 0,
    known: Boolean(catalogItem),
    priceRaw: market.unit.raw,
    rawMedian: market.rawMedian,
    rawLowest: market.rawLowest,
    unitPrice: market.unit.unit,
    priceSource: market.unit.source,
    priceChecked: market.priceChecked,
    value: null,
    buyOrderRaw: market.buyOrderRaw,
    buyOrderUnit: market.buyOrderUnit,
    buyOrderQuantity: market.buyOrderQuantity,
    buyOrderLevels: market.buyOrderLevels,
    buyOrderValue: null,
    buyOrderCoveredCount: null,
    buyOrderChecked: market.buyOrderChecked,
  };
}

function locationCountKey(
  location: ItemLocation,
): "inventoryCount" | "stashCount" | "tradingCount" | null {
  if (location === "inventory") return "inventoryCount";
  if (location === "stash") return "stashCount";
  if (location === "trading") return "tradingCount";
  return null;
}

function applyInstance(row: ResolvedInventoryRow, instance: InventoryItemInstance): void {
  row.count++;
  if (instance.inUse) row.inUseCount++;
  if (instance.isChaotic) row.chaoticCount++;
  const countKey = locationCountKey(instance.location);
  if (countKey) row[countKey]++;
}

function ensureRow(
  rowsByItemKey: Map<number, ResolvedInventoryRow>,
  itemKey: number,
  catalogItem: GameItem | undefined,
  priceLookup?: PriceLookup,
): ResolvedInventoryRow {
  const existing = rowsByItemKey.get(itemKey);
  if (existing) return existing;

  const market = catalogItem ? resolveMarketHashAndPrice(catalogItem, priceLookup) : NO_MARKET;
  const row = createResolvedRow(itemKey, catalogItem, market);
  rowsByItemKey.set(itemKey, row);
  return row;
}

function accumulateInstances(
  rowsByItemKey: Map<number, ResolvedInventoryRow>,
  items: InventoryItemInstance[],
  lookup: (itemKey: number) => GameItem | undefined,
  priceLookup: PriceLookup | undefined,
  excludeItemKey?: (itemKey: number) => boolean,
): void {
  items.forEach((instance) => {
    if (excludeItemKey?.(instance.itemKey)) return;
    const row = ensureRow(rowsByItemKey, instance.itemKey, lookup(instance.itemKey), priceLookup);
    applyInstance(row, instance);
  });
}

function mergeMaterialStacks(
  rowsByItemKey: Map<number, ResolvedInventoryRow>,
  stacks: Map<number, MaterialStackTotal>,
  snapshot: InventorySnapshot,
  lookup: (itemKey: number) => GameItem | undefined,
  priceLookup: PriceLookup | undefined,
  excludeItemKey?: (itemKey: number) => boolean,
): void {
  stacks.forEach((stack, itemKey) => {
    if (excludeItemKey?.(itemKey)) return;
    if (snapshot.marketPipelineOnlyCatalogKeys?.has(itemKey)) return;

    const catalogItem = lookup(itemKey);
    if (!catalogItem) return;
    // Material rows carry stack totals; gear never appears in `materialStacks`.
    if (catalogItem.type !== "MATERIAL") return;
    if (stack.total <= 0) return;

    const row = rowsByItemKey.has(itemKey)
      ? rowsByItemKey.get(itemKey)!
      : ensureRow(rowsByItemKey, itemKey, catalogItem, priceLookup);

    // `materialStacks` is the authoritative total (sum of per-slot `Quantity`).
    // `itemSaveDatas` material rows are stack *templates* — the same UniqueId is
    // repeated once per holding slot (verified: one id can appear 24× in a live
    // save), so counting instances would inflate the total. Overwrite the row's
    // counted fields with the slot sums; leave `inUseCount` / `chaoticCount`
    // (set by the instance pass) untouched.
    row.count = stack.total;
    row.inventoryCount = stack.inventory;
    row.stashCount = stack.stash;
    row.tradingCount = stack.trading;
  });
}

export function resolveInventory(
  snapshot: InventorySnapshot,
  lookup: (itemKey: number) => GameItem | undefined,
  gameDataLoaded: boolean,
  priceLookup?: PriceLookup,
  options?: ResolveInventoryOptions,
): ResolvedInventory {
  const excludeItemKey = options?.excludeItemKey;
  const feeRates = options?.marketFeeRates ?? getTbhMarketFeeRates();
  const rowsByItemKey = new Map<number, ResolvedInventoryRow>();

  accumulateInstances(rowsByItemKey, snapshot.items, lookup, priceLookup, excludeItemKey);

  if (snapshot.materialStacks) {
    mergeMaterialStacks(
      rowsByItemKey,
      snapshot.materialStacks,
      snapshot,
      lookup,
      priceLookup,
      excludeItemKey,
    );
  }

  // Drop zero-count rows (e.g. pipeline-only materials skipped during merge).
  const rows = [...rowsByItemKey.values()].filter((row) => row.count > 0);
  const composition = computeInventoryComposition(rows, feeRates);

  return {
    rows,
    composition,
    chests: snapshot.chests,
    saveMtime: snapshot.saveMtime,
    gameDataLoaded,
    currency: null,
    inventoryCapacity: snapshot.inventoryCapacity,
    inventoryUsed: snapshot.inventoryUsed,
  };
}

/** Flat market_hash_name list for cache prune (gear variant A only). */
export function ownedMarketNames(
  snapshot: InventorySnapshot,
  lookup: (itemKey: number) => GameItem | undefined,
  excludeItemKey?: (itemKey: number) => boolean,
): string[] {
  return flattenOwnedHashes(ownedPriceTargets(snapshot, lookup, excludeItemKey));
}
