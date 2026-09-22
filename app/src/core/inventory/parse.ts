// Parse owned items and chests from decrypted save JSON.

import { catalogItemKeyFromSave, isMarketPipelineSaveItemKey } from "../gamedata";
import { unwrapEs3Entry } from "../save/snapshot";
import { materialStacksFromAggregates, parseAggregateEntries } from "./aggregates";
import { materialStacksFromSlots, type SlotEntry, type StackSlotLocation } from "./stacks";
import type {
  InventoryItemInstance,
  ChestHolding,
  InventorySnapshot,
  ItemLocation,
  BoxCategory,
  MaterialStackTotal,
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

/** Extract the raw text of a field, preserving full precision (UniqueId etc.). */
const SLOT_UNIQUE_ID_RE = /"ItemUniqueId"\s*:\s*(\d+)/;
const SLOT_UNLOCK_RE = /"(?:IsUnlock|IsUnLock)"\s*:\s*true/;
const SLOT_QUANTITY_RE = /"Quantity"\s*:\s*(-?\d+)/;

/**
 * Parse the flat slot-object arrays (`inventorySaveDatas` / `stashSaveDatas` /
 * `remakeTradingStashSaveDatas`) into normalized {@link SlotEntry} records.
 *
 * Uses depth-aware splitting (same as `splitTopLevelObjects`) so a save format
 * that nests sub-objects inside a slot is not mis-parsed. `ItemUniqueId` is kept
 * as a digit **string** — ids exceed `Number.MAX_SAFE_INTEGER`. `Quantity` is
 * `null` when the field is absent (pre-stacking save / field removed), which the
 * stack builder treats as "no contribution", letting the aggregate fallback run.
 */
function parseSlots(arrText: string): SlotEntry[] {
  const slots: SlotEntry[] = [];
  for (const obj of splitTopLevelObjects(arrText)) {
    const idMatch = SLOT_UNIQUE_ID_RE.exec(obj);
    if (!idMatch) continue;
    const qtyMatch = SLOT_QUANTITY_RE.exec(obj);
    slots.push({
      itemUniqueId: idMatch[1],
      isUnlock: SLOT_UNLOCK_RE.test(obj),
      quantity: qtyMatch ? Math.trunc(Number(qtyMatch[1])) : null,
    });
  }
  return slots;
}

/** Capacity/used from parsed slot entries — shared by the string and object paths
 *  so the dual occupancy criterion can never drift between them. See
 *  {@link parseSlotCapacity} for the criterion rationale. */
function slotCapacityFromEntries(slots: readonly SlotEntry[]): { capacity: number; used: number } {
  const slotsWithQuantity = slots.filter((slot) => slot.quantity != null).length;
  let capacity = 0;
  let used = 0;
  for (const slot of slots) {
    if (!slot.isUnlock) continue;
    capacity++;
    if (slotsWithQuantity > 0) {
      if (slot.quantity != null && slot.quantity > 0) used++;
    } else if (slot.itemUniqueId !== "0") {
      used++;
    }
  }
  return { capacity, used };
}

/** Counts unlocked inventory slots and how many hold an item, from a flat slot-object array.
 *  Uses depth-aware splitting (same as `splitTopLevelObjects`) so a save format that
 *  later adds nested sub-objects inside a slot (e.g. enchant data) is not mis-parsed.
 *  A stacked material slot (Quantity > 1) still counts as exactly ONE used slot.
 *
 *  Occupancy criterion is **explicitly dual**:
 *   - New format (any slot carries a `Quantity` field): a slot is used iff
 *     `Quantity > 0`. The game also zeroes the `ItemUniqueId` of empty slots, so
 *     both criteria agree today — but keying on `Quantity` keeps us correct if a
 *     future patch clears only `Quantity` and leaves a stale `ItemUniqueId`.
 *   - Old format (no slot has `Quantity`): fall back to `ItemUniqueId !== "0"`.
 *     Without this fallback a pre-stacking save would collapse `used` to 0.
 *  `capacity` always counts only unlocked slots.
 *
 *  Capacity never depends on stacking: a slot holding a 5-stack occupies one
 *  slot, exactly like a slot holding a single item.
 *
 *  Shared by the inventory, stash and trading arrays. Only the **inventory**
 *  pair is exposed on `InventorySnapshot` — the game pauses chest auto-open
 *  timers solely when the *inventory* is full, and stash capacity is a pure
 *  slot count (stacking is irrelevant to it), so the stash/trading results are
 *  deliberately not surfaced rather than missing.
 */
function parseSlotCapacity(arrText: string): { capacity: number; used: number } {
  return slotCapacityFromEntries(parseSlots(arrText));
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

/**
 * Build `UniqueId (string) -> catalog ItemKey` from the `itemSaveDatas` master
 * list. Used to resolve a material slot's `ItemUniqueId` to the material it
 * stacks. Keys on the lossless digit **string**: `UniqueId` exceeds
 * `Number.MAX_SAFE_INTEGER` and rounding would collide distinct stacks.
 *
 * Pipeline (suffix `900`) rows are included too — a slot can hold a listed
 * copy — but the catalog id is derived with the same normalizer as the rest of
 * the parser so `141002900 -> 141002`.
 */
function buildItemKeyByUniqueIdFromString(playerStr: string): Map<string, number> {
  const arr = sliceJsonArray(playerStr, '"itemSaveDatas":');
  const map = new Map<string, number>();
  for (const objText of splitTopLevelObjects(arr)) {
    const uniqueId = extractRawNumberText(objText, "UniqueId");
    if (uniqueId == null || uniqueId === "0") continue;
    const rawItemKeyText = extractRawNumberText(objText, "ItemKey");
    if (rawItemKeyText === null) continue;
    const catalogId = catalogItemKeyFromSave(Math.trunc(Number(rawItemKeyText)));
    if (catalogId <= 0) continue;
    map.set(uniqueId, catalogId);
  }
  return map;
}

/** Object-path twin of {@link buildItemKeyByUniqueIdFromString}. */
function buildItemKeyByUniqueIdFromObject(player: Record<string, unknown>): Map<string, number> {
  const map = new Map<string, number>();
  const arr = player.itemSaveDatas;
  if (!Array.isArray(arr)) return map;
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    // UniqueId may arrive as a string (preferred) or a (lossy) number.
    const uniqueId =
      typeof it.UniqueId === "string" ? it.UniqueId : String(Math.trunc(toNum(it.UniqueId, 0)));
    if (uniqueId === "0" || uniqueId === "NaN") continue;
    const catalogId = catalogItemKeyFromSave(Math.trunc(toNum(it.ItemKey, 0)));
    if (catalogId <= 0) continue;
    map.set(uniqueId, catalogId);
  }
  return map;
}

/** Slot arrays that can hold stacked materials, with their resolved bag. */
const STACK_SLOT_ARRAYS = [
  { key: '"inventorySaveDatas":', objectKey: "inventorySaveDatas", location: "inventory" },
  { key: '"stashSaveDatas":', objectKey: "stashSaveDatas", location: "stash" },
  {
    key: '"remakeTradingStashSaveDatas":',
    objectKey: "remakeTradingStashSaveDatas",
    location: "trading",
  },
] as const;

/** Collect every slot entry from the bag/stash/trading arrays (string path). */
function collectMaterialSlotsFromString(playerStr: string): SlotEntry[] {
  const slots: SlotEntry[] = [];
  for (const { key, location } of STACK_SLOT_ARRAYS) {
    for (const slot of parseSlots(sliceJsonArray(playerStr, key))) {
      slots.push({ ...slot, location });
    }
  }
  return slots;
}

/** Normalize one object-path slot array into {@link SlotEntry} records. */
function slotsFromObjectArray(arr: readonly unknown[], location: StackSlotLocation): SlotEntry[] {
  const slots: SlotEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const rawId = row.ItemUniqueId;
    if (rawId == null) continue;
    const uniqueId = typeof rawId === "string" ? rawId : String(Math.trunc(toNum(rawId, 0)));
    const rawQty = row.Quantity;
    const quantity =
      rawQty == null || !Number.isFinite(Number(rawQty)) ? null : Math.trunc(Number(rawQty));
    slots.push({
      itemUniqueId: uniqueId,
      quantity,
      isUnlock: Boolean(row.IsUnlock ?? row.IsUnLock),
      location,
    });
  }
  return slots;
}

/** Object-path twin of {@link collectMaterialSlotsFromString}. */
function collectMaterialSlotsFromObject(player: Record<string, unknown>): SlotEntry[] {
  const slots: SlotEntry[] = [];
  for (const { objectKey, location } of STACK_SLOT_ARRAYS) {
    const arr = player[objectKey];
    if (!Array.isArray(arr)) continue;
    slots.push(...slotsFromObjectArray(arr, location));
  }
  return slots;
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
    // Known STAGEBOX chests — holding criterion is asymmetric per category (2026-09-23 fix).
    //
    //   act (Act Boss Box, 93xxxx): the UniqueId NEVER enters either the Get or the
    //     Use bucket (since v1.2.2, still true on v1.2.8), so bucket membership is
    //     meaningless for it. Keep the loose "held unless opened" rule; ghost rows
    //     are handled by the session-scope filter (core/boxes/sessionScope.ts).
    //
    //   common / rare / plague*: the game restores their holdings from GetBoxList,
    //     so they must appear in it to count as held. The old "not in Use => held"
    //     rule is wrong for these: rows the game never restores after a level-up or
    //     restart linger in itemSaveDatas (invisible in-game) and the old rule
    //     counted them all, inflating the holding count. Measured on a real v1.2.8
    //     save (2026-09-23): GetBoxList matches the in-game ground truth item for
    //     item (5 common + 3 rare + 0 act) while itemSaveDatas holds 3 extra common
    //     ghosts => the old rule showed 8 common.
    //
    // History: this block was once loosened to all categories because a strict
    // Get filter dropped Act Boss boxes (which zeroed the Loot queue after an act
    // drop). That loosening is still required for act but was over-broad for
    // common/rare — hence the per-category split, satisfying both constraints.
    if (meta.category !== "act" && (uniqueId == null || !unopenedIds.has(uniqueId))) {
      continue;
    }
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

/**
 * Legacy fallback: shape the lifetime-aggregate totals as `MaterialStackTotal`.
 * Used only when no slot carries a `Quantity` (pre-stacking save). The aggregate
 * value is a lifetime counter, not a live bag holding, so it is attributed to
 * the bag (`inventory`) for display/filter purposes.
 */
function aggregateTotalsAsStacks(
  entries: ReturnType<typeof parseAggregateEntries>,
  isMaterialItemKey: (itemKey: number) => boolean,
): Map<number, MaterialStackTotal> {
  const out = new Map<number, MaterialStackTotal>();
  materialStacksFromAggregates(entries, isMaterialItemKey).forEach((quantity, itemKey) => {
    out.set(itemKey, { total: quantity, inventory: quantity, stash: 0, trading: 0 });
  });
  return out;
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
  let materialStacks: Map<number, MaterialStackTotal> | undefined;
  if (playerStr) {
    ({ items, marketPipelineOnlyCatalogKeys } = parseItemsFromPlayerString(playerStr));
  } else if (player && typeof player === "object") {
    ({ items, marketPipelineOnlyCatalogKeys } = parseItemsFromPlayerObject(player));
  }

  const chests = parseChests(player, playerStr, classifyBoxItemKey);

  // Material stacks: the authoritative source is the per-slot `Quantity` on the
  // bag/stash slot arrays (game update: materials stack up to MAX_STACK_PER_SLOT
  // per slot, multiple slots sum). Falls back to the lifetime-aggregate
  // counters only when no slot carries a `Quantity` (pre-stacking save / field
  // removed) so old saves keep behaving.
  if (isMaterialItemKey) {
    const slotStacks: Map<number, MaterialStackTotal> = playerStr
      ? materialStacksFromSlots(
          collectMaterialSlotsFromString(playerStr),
          buildItemKeyByUniqueIdFromString(playerStr),
          isMaterialItemKey,
        )
      : player && typeof player === "object"
        ? materialStacksFromSlots(
            collectMaterialSlotsFromObject(player),
            buildItemKeyByUniqueIdFromObject(player),
            isMaterialItemKey,
          )
        : new Map();

    materialStacks =
      slotStacks.size > 0
        ? slotStacks
        : aggregateTotalsAsStacks(parseAggregateEntries(player), isMaterialItemKey);
  }

  let inventoryCapacity = 0;
  let inventoryUsed = 0;
  if (playerStr) {
    const arr = sliceJsonArray(playerStr, '"inventorySaveDatas":');
    ({ capacity: inventoryCapacity, used: inventoryUsed } = parseSlotCapacity(arr));
  } else if (player && Array.isArray(player.inventorySaveDatas)) {
    // Object path reuses the same normalized slot entries + dual criterion as the
    // string path, so a stacked slot (Quantity > 1) still counts as ONE used slot.
    ({ capacity: inventoryCapacity, used: inventoryUsed } = slotCapacityFromEntries(
      slotsFromObjectArray(player.inventorySaveDatas, "inventory"),
    ));
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
