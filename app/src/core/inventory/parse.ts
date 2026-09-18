// Parse owned items and chests from decrypted save JSON.

import { catalogItemKeyFromSave, isMarketPipelineSaveItemKey } from "../gamedata";
import { unwrapEs3Entry } from "../save/snapshot";
import { materialStacksFromAggregates, parseAggregateEntries } from "./aggregates";
import type {
  InventoryItemInstance,
  ChestHolding,
  InventorySnapshot,
  ItemLocation,
  BoxCategory,
} from "../../../shared/types";

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sliceJsonArray(text: string, key: string): string {
  const at = text.indexOf(key);
  if (at === -1) return "";
  const open = text.indexOf("[", at);
  if (open === -1) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

function parseEquippedIds(playerStr: string): Set<string> {
  const equipped = new Set<string>();
  const re = /"equippedItemIds"\s*:\s*\[([^\]]*)\]/g;
  for (const m of playerStr.matchAll(re)) {
    for (const id of m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      equipped.add(id);
    }
  }
  return equipped;
}

const SLOT_ID_RE = /"ItemUniqueId"\s*:\s*(\d+)/g;

function parseSlotUniqueIds(playerStr: string, arrayKey: string): Set<string> {
  const arr = sliceJsonArray(playerStr, arrayKey);
  const ids = new Set<string>();
  for (const m of arr.matchAll(SLOT_ID_RE)) {
    const id = m[1];
    if (id !== "0") ids.add(id);
  }
  return ids;
}

/** Counts unlocked inventory slots and how many hold an item, from a flat slot-object array.
 *  Uses depth-aware splitting (same as `splitTopLevelObjects`) so a save format that
 *  later adds nested sub-objects inside a slot (e.g. enchant data) is not mis-parsed. */
function parseSlotCapacity(arrText: string): { capacity: number; used: number } {
  let capacity = 0;
  let used = 0;
  for (const obj of splitTopLevelObjects(arrText)) {
    const isUnlock = /"IsUnlock"\s*:\s*true/.test(obj);
    if (!isUnlock) continue;
    capacity++;
    const idMatch = /"ItemUniqueId"\s*:\s*(\d+)/.exec(obj);
    if (idMatch && idMatch[1] !== "0") used++;
  }
  return { capacity, used };
}

/**
 * Split a JSON array literal (e.g. `[{...},{...}]`) into its top-level object
 * substrings. Tracks string state and brace depth so nested objects (e.g.
 * `itemSaveDatas[].EnchantData[].{StatModKey,...}`) are not split mid-object.
 * Returns each top-level `{...}` substring, or an empty array if the input has
 * no top-level objects. Used so item-field extraction is **field-order
 * agnostic** — game v1.00.28+ inserts `PrevUniqueId` / `IsBlocked` /
 * `IsServerPendingItem` between `UniqueId` and `IsChaotic`, which broke the
 * previous "ItemKey,UniqueId,IsChaotic adjacent" regex.
 */
function splitTopLevelObjects(arrText: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < arrText.length; i++) {
    const ch = arrText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push(arrText.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objects;
}

/** Extract the raw text of a numeric field, preserving full precision.
 *  `UniqueId` exceeds `Number.MAX_SAFE_INTEGER` and must NOT be coerced to a
 *  number — the equipped/inventory/stash/trading id sets key on the original
 *  digit string, so any rounding breaks slot resolution. */
function extractRawNumberText(objText: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`).exec(objText);
  return m ? m[1] : null;
}

/** Extract a boolean field, defaulting to false when absent. */
function extractBoolField(objText: string, field: string): boolean {
  const m = new RegExp(`"${field}"\\s*:\\s*(true|false)`).exec(objText);
  return m ? m[1] === "true" : false;
}

/** Returns catalog id for assignable rows; tracks pipeline vs playable ids in the sets. */
function trackSaveItemKey(
  rawItemKey: number,
  assignableCatalogIds: Set<number>,
  pipelineCatalogIds: Set<number>,
): number | null {
  const catalogId = catalogItemKeyFromSave(rawItemKey);
  if (catalogId <= 0) return null;
  if (isMarketPipelineSaveItemKey(rawItemKey)) {
    pipelineCatalogIds.add(catalogId);
    return null;
  }
  assignableCatalogIds.add(catalogId);
  return catalogId;
}

function marketPipelineOnlyCatalogKeys(
  assignableCatalogIds: Set<number>,
  pipelineCatalogIds: Set<number>,
): Set<number> {
  return new Set([...pipelineCatalogIds].filter((id) => !assignableCatalogIds.has(id)));
}

function resolveLocation(
  uniqueId: string,
  equipped: Set<string>,
  inventory: Set<string>,
  stash: Set<string>,
  trading: Set<string>,
): ItemLocation {
  if (equipped.has(uniqueId)) return "equipped";
  if (inventory.has(uniqueId)) return "inventory";
  if (stash.has(uniqueId)) return "stash";
  if (trading.has(uniqueId)) return "trading";
  return "unknown";
}

function parseItemsFromPlayerString(playerStr: string): {
  items: InventoryItemInstance[];
  marketPipelineOnlyCatalogKeys: Set<number>;
} {
  const equipped = parseEquippedIds(playerStr);
  const inventory = parseSlotUniqueIds(playerStr, '"inventorySaveDatas":');
  const stash = parseSlotUniqueIds(playerStr, '"stashSaveDatas":');
  const trading = parseSlotUniqueIds(playerStr, '"tradingStashSaveDatas":');
  const arr = sliceJsonArray(playerStr, '"itemSaveDatas":');
  const items: InventoryItemInstance[] = [];
  const assignableCatalogIds = new Set<number>();
  const pipelineCatalogIds = new Set<number>();
  // v1.00.28+ saves insert PrevUniqueId / IsBlocked / IsServerPendingItem
  // between UniqueId and IsChaotic, so the legacy "ItemKey,UniqueId,IsChaotic
  // adjacent" regex matched zero items and the inventory tab rendered empty.
  // Splitting top-level objects and extracting each field independently makes
  // the parser field-order agnostic — see splitTopLevelObjects.
  for (const objText of splitTopLevelObjects(arr)) {
    const rawItemKeyText = extractRawNumberText(objText, "ItemKey");
    if (rawItemKeyText === null) continue;
    const rawItemKey = Math.trunc(Number(rawItemKeyText));
    const catalogId = trackSaveItemKey(rawItemKey, assignableCatalogIds, pipelineCatalogIds);
    if (catalogId === null) continue;
    // UniqueId is kept as a string — it exceeds Number.MAX_SAFE_INTEGER
    // and the equipped/inventory/stash/trading id sets key on the digit text.
    const uniqueId = extractRawNumberText(objText, "UniqueId") ?? "0";
    const isChaotic = extractBoolField(objText, "IsChaotic");
    const location = resolveLocation(uniqueId, equipped, inventory, stash, trading);
    items.push({
      itemKey: catalogId,
      isChaotic,
      inUse: equipped.has(uniqueId),
      location,
    });
  }
  return {
    items,
    marketPipelineOnlyCatalogKeys: marketPipelineOnlyCatalogKeys(
      assignableCatalogIds,
      pipelineCatalogIds,
    ),
  };
}

function parseItemsFromPlayerObject(player: Record<string, unknown>): {
  items: InventoryItemInstance[];
  marketPipelineOnlyCatalogKeys: Set<number>;
} {
  const items: InventoryItemInstance[] = [];
  const assignableCatalogIds = new Set<number>();
  const pipelineCatalogIds = new Set<number>();
  const arr = player.itemSaveDatas;
  if (!Array.isArray(arr)) {
    return { items, marketPipelineOnlyCatalogKeys: new Set() };
  }
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const rawItemKey = Math.trunc(toNum(it.ItemKey, 0));
    const catalogId = trackSaveItemKey(rawItemKey, assignableCatalogIds, pipelineCatalogIds);
    if (catalogId === null) continue;
    items.push({
      itemKey: catalogId,
      isChaotic: Boolean(it.IsChaotic),
      inUse: false,
      location: "unknown",
    });
  }
  return {
    items,
    marketPipelineOnlyCatalogKeys: marketPipelineOnlyCatalogKeys(
      assignableCatalogIds,
      pipelineCatalogIds,
    ),
  };
}

function parseChests(
  player: Record<string, unknown> | undefined,
  playerStr?: string | null,
  classifyBoxItemKey?: (itemKey: number) => { category: BoxCategory; label: string } | null,
): ChestHolding[] {
  const chests: ChestHolding[] = [];
  if (!player) return chests;
  const box = player.BoxData as Record<string, unknown> | undefined;
  if (box && typeof box === "object") {
    const types = Array.isArray(box.BoxTypes) ? (box.BoxTypes as unknown[]) : [];
    const quantities = Array.isArray(box.BoxQuantity) ? (box.BoxQuantity as unknown[]) : [];
    for (let i = 0; i < types.length; i++) {
      const quantity = Math.trunc(toNum(quantities[i], 0));
      if (quantity <= 0) continue;
      chests.push({ type: Math.trunc(toNum(types[i], 0)), quantity });
    }
    return chests;
  }
  // v1.2.2+：BoxData 被移除，未开箱子以普通物品形式存在于 itemSaveDatas。
  // UniqueId 超 Number.MAX_SAFE_INTEGER，必须走原始文本（playerStr）按字符串
  // 比较，与 parseItemsFromPlayerString 同理。
  if (!playerStr) return chests;
  // 已开桶（UseBoxList）中的箱子不计持有（已经打开/用完）；未开桶（GetBoxList）
  // 用于兜底识别 gamedata 未知 id 的箱子（保留 unclassified 展示）。
  const usedMatch = /"BoxBucketUseBoxList"\s*:\s*\[([^\]]*)\]/.exec(playerStr);
  const usedIds = new Set(usedMatch ? (usedMatch[1]!.match(/\d+/g) ?? []) : []);
  const getMatch = /"BoxBucketGetBoxList"\s*:\s*\[([^\]]*)\]/.exec(playerStr);
  const unopenedIds = new Set(getMatch ? (getMatch[1]!.match(/\d+/g) ?? []) : []);
  const arr = sliceJsonArray(playerStr, '"itemSaveDatas":');
  for (const objText of splitTopLevelObjects(arr)) {
    const itemKeyText = extractRawNumberText(objText, "ItemKey");
    if (itemKeyText === null) continue;
    const itemKey = Math.trunc(Number(itemKeyText));
    const uniqueId = extractRawNumberText(objText, "UniqueId");
    // 已开桶中的箱子不在持有（已经打开/用完）。
    if (uniqueId != null && usedIds.has(uniqueId)) continue;
    const meta = classifyBoxItemKey?.(itemKey) ?? null;
    if (meta == null) {
      // gamedata 未知 id：仅当出现在未开桶中才作为（unclassified）箱子计入，
      // 避免误收装备/材料等非箱子物品。
      if (uniqueId == null || !unopenedIds.has(uniqueId)) continue;
      chests.push({ type: itemKey, quantity: 1, uniqueId });
      continue;
    }
    // 已知 STAGEBOX 箱子：只要不在已开桶即视为持有。
    // 章节 Boss 箱的 UniqueId 可能既不在 Get 也不在 Use 桶（v1.2.2 实测，
    // 910901/920901 在 Get 而 930901 两桶皆不在），若严格限定"未开桶"会把
    // 章节 Boss 箱误判为已开而丢弃 —— 即"掉落章节宝箱后队列被误归零"。
    // uniqueId 供会话作用域过滤（core/boxes/sessionScope.ts）识别 v1.2.4
    // 跨会话遗留的 act 幽灵条目。
    chests.push({
      type: itemKey,
      quantity: 1,
      category: meta.category,
      label: meta.label,
      uniqueId: uniqueId ?? undefined,
    });
  }
  return chests;
}

export function parseInventory(
  decryptedText: string,
  saveMtime = 0,
  isMaterialItemKey?: (itemKey: number) => boolean,
  classifyBoxItemKey?: (itemKey: number) => { category: BoxCategory; label: string } | null,
): InventorySnapshot {
  const root = JSON.parse(decryptedText) as Record<string, unknown>;
  const playerEntry = root?.PlayerSaveData as { value?: unknown } | undefined;
  const playerStr = typeof playerEntry?.value === "string" ? playerEntry.value : null;
  const player = unwrapEs3Entry(root?.PlayerSaveData) as Record<string, unknown> | undefined;

  let items: InventoryItemInstance[] = [];
  let marketPipelineOnlyCatalogKeys: Set<number> | undefined;
  if (playerStr) {
    ({ items, marketPipelineOnlyCatalogKeys } = parseItemsFromPlayerString(playerStr));
  } else if (player && typeof player === "object") {
    ({ items, marketPipelineOnlyCatalogKeys } = parseItemsFromPlayerObject(player));
  }

  const chests = parseChests(player, playerStr, classifyBoxItemKey);
  let materialStacks: Map<number, number> | undefined;
  if (isMaterialItemKey) {
    materialStacks = materialStacksFromAggregates(parseAggregateEntries(player), isMaterialItemKey);
  }

  let inventoryCapacity = 0;
  let inventoryUsed = 0;
  if (playerStr) {
    const arr = sliceJsonArray(playerStr, '"inventorySaveDatas":');
    ({ capacity: inventoryCapacity, used: inventoryUsed } = parseSlotCapacity(arr));
  } else if (player && Array.isArray(player.inventorySaveDatas)) {
    for (const raw of player.inventorySaveDatas) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      if (!row.IsUnlock) continue;
      inventoryCapacity++;
      if (toNum(row.ItemUniqueId, 0) !== 0) inventoryUsed++;
    }
  }

  return {
    items,
    chests,
    saveMtime,
    materialStacks,
    inventoryCapacity,
    inventoryUsed,
    marketPipelineOnlyCatalogKeys,
  };
}
