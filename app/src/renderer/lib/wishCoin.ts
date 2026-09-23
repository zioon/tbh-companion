// 祈愿硬币面板的纯派生工具（Wish v2，renderer 侧）。
//
// W1 定稿：硬币面板**不**新增 `WishStats.heldCoins` 字段，而是在 renderer 侧
// 用 `useInventory().rows`（已解析的背包行）+ `useLookupCatalog()`（图鉴目录）
// 现场 join 得到「背包持有的献祭硬币」。这样 main 侧的 `buildStats` 无需读
// inventory（不变量 I9 分层），renderer 又天然随背包刷新而更新。
//
// 本模块**纯函数**：无 React / IPC / DOM 依赖，可单测。

import type {
  LookupItem,
  ResolvedInventory,
  WishCoinCandidate,
  WishGrade,
  WishHeldCoin,
} from "../../../shared/types";
import { WISH_COIN_KEYS } from "../../core/wish/constants";

/** coinKey 闭集（`readonly number[]`）。 */
const COIN_KEY_SET: ReadonlySet<number> = new Set(WISH_COIN_KEYS);

/** 把任意 grade 字符串窄化为 `WishGrade`（未知值回落 UNKNOWN，UI 侧不崩）。 */
function asWishGrade(grade: string): WishGrade {
  return grade as WishGrade;
}

/** 该 itemKey 是否为献祭硬币（闭集判定）。 */
export function isCoinKey(itemKey: number): boolean {
  return COIN_KEY_SET.has(itemKey);
}

/**
 * 从背包行 + 图鉴目录派生「背包持有的献祭硬币」列表。
 *
 * join 规则：
 *  - 只取 `rows` 中 `itemKey ∈ WISH_COIN_KEYS` 的行（其余忽略）；
 *  - `grade` / `iconPath` 优先取图鉴目录 `LookupItem`（权威，W6），目录缺失时
 *    退回行自身的 `grade` / 空 `iconPath`；
 *  - `quantity` 取行的 `count`（背包持有数量）。
 *
 * 输出按 coinKey 升序（稳定顺序，便于渲染与快照对比）。
 *
 * @param inventory 已解析背包（`useInventory()`，可能为 null）。
 * @param catalog   图鉴目录（`useLookupCatalog()`，可能为 null）。
 * @returns 持有硬币列表；无硬币或背包未就绪时返回空数组（永不为 null）。
 */
export function heldCoinsFromInventory(
  inventory: ResolvedInventory | null,
  catalog: LookupItem[] | null,
): WishHeldCoin[] {
  if (!inventory) return [];
  const byId = new Map<number, LookupItem>();
  for (const item of catalog ?? []) byId.set(item.id, item);

  const rows = inventory.rows.filter((r) => isCoinKey(r.itemKey));
  const held: WishHeldCoin[] = rows.map((r) => {
    const meta = byId.get(r.itemKey);
    return {
      coinKey: r.itemKey,
      name: meta?.name ?? r.name,
      grade: asWishGrade(meta?.grade ?? r.grade),
      quantity: r.count,
      iconPath: meta?.iconPath ?? "",
    };
  });
  // 稳定顺序：coinKey 升序。
  held.sort((a, b) => a.coinKey - b.coinKey);
  return held;
}

/**
 * 取归因对象的「展示硬币」：observed → 自身 coinKey；否则 null。
 *
 * 说明：`inferred` / `unknown` 不显示单枚硬币（候选由 {@link candidateNames} 展示）。
 */
export function displayedCoinKey(
  coin: { confidence: "observed" | "inferred" | "unknown"; coinKey: number | null } | undefined,
): number | null {
  if (!coin) return null;
  return coin.confidence === "observed" ? coin.coinKey : null;
}

/**
 * 把候选集合映射为「硬币名 + 池概率」的展示三元组（供 tooltip / 徽章）。
 *
 * @param candidates 归因候选（`WishCoinCandidate[]`）。
 * @param coinName   coinKey → 硬币名解析器；缺省回落 `#<key>`。
 */
export function candidateNames(
  candidates: readonly WishCoinCandidate[],
  coinName: (coinKey: number) => string | undefined,
): { coinKey: number; name: string; poolPct: number; held?: boolean }[] {
  return candidates.map((c) => ({
    coinKey: c.coinKey,
    name: coinName(c.coinKey) ?? `#${c.coinKey}`,
    poolPct: c.poolPct,
    ...(c.held !== undefined ? { held: c.held } : {}),
  }));
}

/**
 * coinKey → 硬币元数据（名 / 品质 / 图标）解析器工厂。
 *
 * 优先图鉴目录（权威），目录缺失时以 `WISH_COIN_GRADE_FALLBACK` 阶梯兜底品质，
 * 名称回落 `#<key>`、图标回落空串（UI 已对空图标做降级）。
 */
export function makeCoinResolver(
  catalog: LookupItem[] | null,
): (
  coinKey: number,
) => { coinKey: number; name: string; grade: string; iconPath: string } | undefined {
  const byId = new Map<number, LookupItem>();
  for (const item of catalog ?? []) byId.set(item.id, item);
  return (coinKey: number) => {
    if (!COIN_KEY_SET.has(coinKey)) return undefined;
    const meta = byId.get(coinKey);
    return {
      coinKey,
      name: meta?.name ?? `#${coinKey}`,
      grade: meta?.grade ?? "UNKNOWN",
      iconPath: meta?.iconPath ?? "",
    };
  };
}
