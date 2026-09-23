// 按硬币分组聚合（P0-8）—— 纯函数派生。
//
// 输入 `WishTracker.history`（含每条条目的 `coin` 归因），输出：
//   - `coinGroups`：按 `confidence==="observed"` 的 `coinKey` 分组；每组的
//     `offeringCount` = 结果行数，`itemCount` = 件数之和；`items` 按 count 降序
//     （同值 name 升序）；
//   - `unattributed`：所有非 observed（inferred/unknown/无 coin）条目汇入一个
//     分区，元素携带 `coin` 归因供 UI 展示候选。
//
// 单一数据源：本函数是唯一的派生入口，保证可单测。
// 无 electron / node:fs / fetch / React 依赖（I9）。

import type {
  WishCoinGroup,
  WishCoinGroupItem,
  WishGrade,
  WishHistoryEntry,
  WishUnattributedGroup,
} from "../../../shared/types";

/** coinKey → { name, grade } 解析器；miss 时返回 undefined（降级）。 */
export type CoinMetaResolver = (coinKey: number) => { name: string; grade: WishGrade } | undefined;

/** 可变的内部聚合体（分区累积用）。 */
interface GroupAccum {
  coinKey: number;
  offeringCount: number;
  itemCount: number;
  /** name → 件数。 */
  countsByName: Map<string, number>;
  /** name → 品质（首见）。 */
  gradeByName: Map<string, WishGrade>;
}

/** 未归因累积体。 */
interface UnattrAccum {
  countsByName: Map<string, number>;
  gradeByName: Map<string, WishGrade>;
  /** name → 该条目最后一次携带的归因（供 UI 展示候选）。 */
  coinByName: Map<string, WishHistoryEntry["coin"]>;
}

/** 把 counts/grade 映射成型为排序后的 `WishCoinGroupItem[]`。 */
function toSortedItems(
  countsByName: Map<string, number>,
  gradeByName: Map<string, WishGrade>,
  coinByName?: Map<string, WishHistoryEntry["coin"]>,
): WishCoinGroupItem[] {
  const items: WishCoinGroupItem[] = [];
  for (const [name, count] of countsByName) {
    if (count <= 0) continue;
    const item: WishCoinGroupItem = {
      name,
      count,
      grade: gradeByName.get(name) ?? "UNKNOWN",
    };
    if (coinByName) {
      const coin = coinByName.get(name);
      if (coin) item.coin = coin;
    }
    items.push(item);
  }
  // count 降序；同值 name 升序（保证稳定）。
  items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return items;
}

/**
 * 从历史记录派生「按硬币分组」与「未归因」两个分区（纯函数）。
 *
 * @param history  `WishTracker.history`（可含 `coin` 归因；无则视为未归因）。
 * @param coinMeta coinKey → { name, grade }；miss 时 coinName 降级为 `String(coinKey)`，
 *                 grade 降级为 `UNKNOWN`。
 */
export function coinGroupsFromHistory(
  history: readonly WishHistoryEntry[],
  coinMeta: CoinMetaResolver,
): { coinGroups: WishCoinGroup[]; unattributed: WishUnattributedGroup } {
  const groups = new Map<number, GroupAccum>();
  const unattr: UnattrAccum = {
    countsByName: new Map(),
    gradeByName: new Map(),
    coinByName: new Map(),
  };

  for (const entry of history) {
    const name = (entry.name ?? "").trim();
    if (!name) continue;
    const count = entry.count != null && entry.count >= 1 ? entry.count : 1;
    const grade: WishGrade = entry.grade ?? "UNKNOWN";

    const coin = entry.coin;
    const observed = coin != null && coin.confidence === "observed" && coin.coinKey != null;

    if (observed) {
      const coinKey = coin!.coinKey as number;
      let acc = groups.get(coinKey);
      if (!acc) {
        acc = {
          coinKey,
          offeringCount: 0,
          itemCount: 0,
          countsByName: new Map(),
          gradeByName: new Map(),
        };
        groups.set(coinKey, acc);
      }
      acc.offeringCount += 1;
      acc.itemCount += count;
      acc.countsByName.set(name, (acc.countsByName.get(name) ?? 0) + count);
      if (!acc.gradeByName.has(name)) acc.gradeByName.set(name, grade);
    } else {
      unattr.countsByName.set(name, (unattr.countsByName.get(name) ?? 0) + count);
      if (!unattr.gradeByName.has(name)) unattr.gradeByName.set(name, grade);
      // 最后一次携带的归因（inferred → 候选；unknown/无 → 无候选）。
      if (coin) unattr.coinByName.set(name, coin);
    }
  }

  const coinGroups: WishCoinGroup[] = [...groups.values()]
    .map((acc) => {
      const meta = coinMeta(acc.coinKey);
      const grade: WishGrade = meta?.grade ?? "UNKNOWN";
      return {
        coinKey: acc.coinKey,
        coinName: meta?.name ?? String(acc.coinKey),
        grade,
        offeringCount: acc.offeringCount,
        itemCount: acc.itemCount,
        items: toSortedItems(acc.countsByName, acc.gradeByName),
      };
    })
    // 分区按 coinKey 升序（确定性输出）。
    .sort((a, b) => a.coinKey - b.coinKey);

  const unattributed: WishUnattributedGroup = {
    items: toSortedItems(unattr.countsByName, unattr.gradeByName, unattr.coinByName),
  };

  return { coinGroups, unattributed };
}
