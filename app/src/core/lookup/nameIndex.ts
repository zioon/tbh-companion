// 名称 → itemKey 索引（Q2 定稿）。
//
// 祈愿行只有**本地化物品名**（无结构化 itemKey），而 `offerings` 反查需要 itemKey。
// 本模块把 `LookupItem.name`（当前显示名）+ `LookupItem.sourceName`（英文源名）
// 同时入索引，提高本地化命中率。
//
// **不做模糊匹配**（避免误归因，I7）。首见优先（同一名称映射到多个 id 时保留首个）。
// 纯函数：无 electron / node:fs / fetch / React 依赖（I9）。

import type { LookupItem } from "./types";

/**
 * 构建「名称 → itemKey」索引。
 *
 * @param items lookup_items.json 的条目（可含本地化 name 与英文 sourceName）。
 * @returns Map<name, id>；只收录非空名称。
 */
export function buildNameIndex(items: readonly LookupItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const item of items) {
    const name = (item.name ?? "").trim();
    if (name && !index.has(name)) index.set(name, item.id);
    const sourceName = (item.sourceName ?? "").trim();
    if (sourceName && !index.has(sourceName)) index.set(sourceName, item.id);
  }
  return index;
}
