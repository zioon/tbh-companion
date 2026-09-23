// 手工硬币分类覆盖（祈愿页「物品手工分类对应硬币」）—— 纯函数。
//
// 自动归因（帧差分 + candidates 兜底）无法覆盖的物品，由用户在 UI 上手工绑定到
// 某枚硬币。本模块把**用户绑定**叠加到 `coinGroupsFromHistory` 的派生结果上：
//
//   - 绑定的物品从 `unattributed` 移入对应 `coinKey` 的分组（该分组不存在则新建）；
//   - 分组按 `coinKey` 升序重排（与 `coinGroupsFromHistory` 的输出约定一致）；
//   - 未绑定的物品原样留在 `unattributed`。
//
// 优先级：`manual` > `observed` > `inferred` > `unknown`（见 CoinAttributionConfidence）。
//
// 为什么不改 main 侧的 `feed()`：归因在 `feed()` 时算出并随快照冻结，而用户的
// 手工绑定是**事后**建立的，且必须能对**已经记录的历史**生效（否则用户改了映射
// 却看不到变化）。因此实现为 renderer 侧的幂等再派生：无需新 IPC、无需重算历史。
//
// 无 electron / node:fs / fetch / React 依赖（I9）；core 不 import 数据。

import type {
  WishCoinAttribution,
  WishCoinGroup,
  WishCoinGroupItem,
  WishCoinOverride,
  WishGrade,
  WishHistoryEntry,
  WishRecentResult,
  WishUnattributedGroup,
} from "../../../shared/types";

/** coinKey → { name, grade } 解析器；miss 时返回 undefined（降级）。 */
export type OverrideCoinMetaResolver = (
  coinKey: number,
) => { name: string; grade: WishGrade } | undefined;

/** itemName → coinKey 的查找表（O(1)），后写覆盖先写（与 config 侧去重语义一致）。 */
export function overrideIndex(overrides: readonly WishCoinOverride[]): Map<string, number> {
  const byName = new Map<string, number>();
  for (const o of overrides) byName.set(o.itemName, o.coinKey);
  return byName;
}

/** 构造一条 `manual` 归因（用户手工指定，唯一 coinKey）。 */
export function manualAttribution(coinKey: number): WishCoinAttribution {
  return { confidence: "manual", coinKey, candidates: [], basis: "manual" };
}

/** 该物品名是否被用户手工绑定；未绑定返回 undefined。 */
export function overrideCoinKey(
  overrides: ReadonlyMap<string, number>,
  itemName: string,
): number | undefined {
  return overrides.get((itemName ?? "").trim());
}

/**
 * 把用户手工绑定应用到「未归因」分区，返回修正后的两个分区。
 *
 * 纯函数：不 mutate 入参。无绑定（`overrides` 为空）或未归因区为空时，
 * 原样返回内容等价的副本（避免调用方误以为发生了变更）。
 *
 * 计数口径：`coinGroupsFromHistory` 产出的 `offeringCount` / `itemCount` 是
 * 完整口径（覆盖全部 history 行）。手工绑定只搬移**未被计入任何分组**的条目
 * 的件数，因此：
 *   - `itemCount` = 原值 + 绑定条目的件数；
 *   - `offeringCount` = 原值 + 绑定条目数（每个未归因条目至少对应一次祈愿，
 *     以条目数为下界，保证「次数 ≤ 件数」的既有关系不被打破）。
 *
 * @param coinGroups   `coinGroupsFromHistory` 的 observed 分组。
 * @param unattributed `coinGroupsFromHistory` 的未归因分区。
 * @param overrides    `config.wishCoinOverrides`。
 * @param coinMeta     coinKey → { name, grade }；miss 时名称降级 `#<key>`、品质 UNKNOWN。
 */
export function applyCoinOverrides(
  coinGroups: readonly WishCoinGroup[],
  unattributed: WishUnattributedGroup,
  overrides: readonly WishCoinOverride[],
  coinMeta: OverrideCoinMetaResolver,
): { coinGroups: WishCoinGroup[]; unattributed: WishUnattributedGroup } {
  if (overrides.length === 0 || unattributed.items.length === 0) {
    return { coinGroups: [...coinGroups], unattributed };
  }
  const byName = overrideIndex(overrides);

  /** 分组累积体（从既有分组浅拷贝条目，保证不 mutate 入参）。 */
  interface Acc {
    coinKey: number;
    countsByName: Map<string, number>;
    gradeByName: Map<string, WishGrade>;
    /** 该分组既有的完整口径计数。 */
    baseOfferingCount: number;
    baseItemCount: number;
  }

  const accs = new Map<number, Acc>();
  const ensureAcc = (coinKey: number): Acc => {
    let acc = accs.get(coinKey);
    if (!acc) {
      acc = {
        coinKey,
        countsByName: new Map(),
        gradeByName: new Map(),
        baseOfferingCount: 0,
        baseItemCount: 0,
      };
      accs.set(coinKey, acc);
    }
    return acc;
  };

  for (const g of coinGroups) {
    const acc = ensureAcc(g.coinKey);
    acc.baseOfferingCount = g.offeringCount;
    acc.baseItemCount = g.itemCount;
    for (const item of g.items) {
      acc.countsByName.set(item.name, (acc.countsByName.get(item.name) ?? 0) + item.count);
      if (!acc.gradeByName.has(item.name)) acc.gradeByName.set(item.name, item.grade);
    }
  }

  /** 手工绑定贡献的增量（按 coinKey 累计）。 */
  const delta = new Map<number, { offerings: number; items: number }>();

  const remaining: WishCoinGroupItem[] = [];
  for (const item of unattributed.items) {
    const target = overrideCoinKey(byName, item.name);
    if (target == null) {
      remaining.push(item);
      continue;
    }
    const acc = ensureAcc(target);
    acc.countsByName.set(item.name, (acc.countsByName.get(item.name) ?? 0) + item.count);
    if (!acc.gradeByName.has(item.name)) acc.gradeByName.set(item.name, item.grade);
    const d = delta.get(target) ?? { offerings: 0, items: 0 };
    d.offerings += 1;
    d.items += item.count;
    delta.set(target, d);
  }

  const patched: WishCoinGroup[] = [...accs.values()]
    .map((acc) => {
      const meta = coinMeta(acc.coinKey);
      const items: WishCoinGroupItem[] = [];
      for (const [name, count] of acc.countsByName) {
        if (count <= 0) continue;
        items.push({ name, count, grade: acc.gradeByName.get(name) ?? "UNKNOWN" });
      }
      // count 降序；同值 name 升序（与 coinGroupsFromHistory 一致）。
      items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      const d = delta.get(acc.coinKey);
      return {
        coinKey: acc.coinKey,
        coinName: meta?.name ?? String(acc.coinKey),
        grade: meta?.grade ?? "UNKNOWN",
        offeringCount: acc.baseOfferingCount + (d?.offerings ?? 0),
        itemCount: acc.baseItemCount + (d?.items ?? 0),
        items,
      };
    })
    // 分区按 coinKey 升序（确定性输出，与 coinGroupsFromHistory 一致）。
    .sort((a, b) => a.coinKey - b.coinKey);

  return { coinGroups: patched, unattributed: { items: remaining } };
}

/**
 * 把 history 中已被手工绑定的行替换为 `manual` 归因（纯函数，返回新数组）。
 *
 * 用途：`recentResults` / `WishHistory` 的硬币列需与「按硬币分组」口径一致 ——
 * 用户在未归因区绑定了某物品后，最近结果里的同一物品也应显示归属硬币。
 * 未绑定的行原样保留（含其自动归因）。
 */
export function applyOverridesToHistory(
  entries: readonly WishHistoryEntry[],
  overrides: readonly WishCoinOverride[],
): WishHistoryEntry[] {
  if (overrides.length === 0) return [...entries];
  const byName = overrideIndex(overrides);
  return entries.map((e) => {
    const target = overrideCoinKey(byName, e.name);
    if (target == null) return e;
    return { ...e, coin: manualAttribution(target) };
  });
}

/**
 * 把「最近祈愿结果」中已被手工绑定的行替换为 `manual` 归因（纯函数）。
 *
 * 与 {@link applyOverridesToHistory} 同构，但 `WishRecentResult` 的 `coin` 是
 * **必填**字段（历史条目为可选），因此单独一件。用途相同：保证最近结果的
 * 硬币列与「按硬币分组」口径一致。
 */
export function applyOverridesToRecent(
  rows: readonly WishRecentResult[],
  overrides: readonly WishCoinOverride[],
): WishRecentResult[] {
  if (overrides.length === 0) return [...rows];
  const byName = overrideIndex(overrides);
  return rows.map((r) => {
    const target = overrideCoinKey(byName, r.name);
    if (target == null) return r;
    return { ...r, coin: manualAttribution(target) };
  });
}
