import type { InventoryColumnId, InventoryTablePrefs } from "../../../shared/types";

export const INVENTORY_COLUMN_IDS: InventoryColumnId[] = [
  "grade",
  "synthesisPoints",
  "level",
  "type",
  "location",
  "inUse",
  "marketPrice",
  "inHand",
  "listValue",
  "instantSell",
  "instantSellNet",
  "instantTotal",
];

export const DEFAULT_VISIBLE_INVENTORY_COLUMNS: InventoryColumnId[] = [
  "grade",
  "synthesisPoints",
  "level",
  "type",
  "location",
  "inUse",
  "marketPrice",
  "inHand",
  "listValue",
  "instantSell",
  "instantSellNet",
  "instantTotal",
];

/** 当前列配置版本；旧配置（无 version）视为 1。 */
export const INVENTORY_TABLE_PREFS_VERSION = 2;

export function normalizeInventoryTablePrefs(
  prefs: InventoryTablePrefs | undefined,
): InventoryTablePrefs {
  const raw = prefs?.visibleColumns ?? DEFAULT_VISIBLE_INVENTORY_COLUMNS;
  const allowed = new Set(INVENTORY_COLUMN_IDS);
  // 不在当前列清单里的 id（如已移除的 "instantSellAverage"）会被静默丢弃，
  // 旧配置无需额外清理逻辑。
  const visibleColumns = raw.filter((id) => allowed.has(id));
  const version = prefs?.version ?? 1;
  // v1 → v2：一次性为旧配置补上新增的「立即到手价」列。写入 version 后，
  // 用户再手动隐藏该列不会被迁移重新补回。
  if (version < INVENTORY_TABLE_PREFS_VERSION && !visibleColumns.includes("instantSellNet")) {
    visibleColumns.push("instantSellNet");
  }
  if (visibleColumns.length === 0) {
    return {
      visibleColumns: [...DEFAULT_VISIBLE_INVENTORY_COLUMNS],
      version: INVENTORY_TABLE_PREFS_VERSION,
    };
  }
  return { visibleColumns, version: INVENTORY_TABLE_PREFS_VERSION };
}

export function isInventoryColumnVisible(
  prefs: InventoryTablePrefs | undefined,
  id: InventoryColumnId,
): boolean {
  return normalizeInventoryTablePrefs(prefs).visibleColumns.includes(id);
}
