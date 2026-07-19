import { GRADE_ORDER, GRADE_RANK } from "../../core/grades";
import type { BoxOpenBreakdownRow } from "../../../shared/types";
import { matchesMulti } from "./lootFilterCommon";

export type LootSortKey = "count" | "dropPct" | "name" | "grade" | "buyOrderValue";

export interface LootFilterState {
  query: string;
  gradeFilter: string[];
  sortKey: LootSortKey;
  sortDir: "asc" | "desc";
}

export const DEFAULT_LOOT_FILTER_STATE: LootFilterState = {
  query: "",
  gradeFilter: [],
  sortKey: "count",
  sortDir: "desc",
};

// P2-2: `matchesMulti` moved to lootFilterCommon.ts.

export function filterAndSortLoot(
  rows: BoxOpenBreakdownRow[],
  state: LootFilterState,
): BoxOpenBreakdownRow[] {
  const q = state.query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (!matchesMulti(state.gradeFilter, row.grade)) return false;
    if (q && !row.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const dir = state.sortDir === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => {
    let cmp: number;
    if (state.sortKey === "name") {
      cmp = a.name.localeCompare(b.name);
    } else if (state.sortKey === "grade") {
      cmp = (GRADE_RANK[a.grade ?? ""] ?? -1) - (GRADE_RANK[b.grade ?? ""] ?? -1);
    } else if (state.sortKey === "dropPct") {
      cmp = a.dropPct - b.dropPct;
    } else if (state.sortKey === "buyOrderValue") {
      cmp = (a.buyOrderValue ?? -1) - (b.buyOrderValue ?? -1);
    } else {
      cmp = a.count - b.count;
    }
    if (cmp === 0 && state.sortKey !== "count") cmp = b.count - a.count;
    return cmp * dir;
  });
}

export function gradeOptionsFromLoot(rows: BoxOpenBreakdownRow[]): string[] {
  const present = new Set(rows.map((r) => r.grade).filter(Boolean) as string[]);
  const ordered = GRADE_ORDER.filter((g) => present.has(g));
  const extras = [...present].filter((g) => GRADE_RANK[g] === undefined).sort();
  return [...ordered, ...extras];
}
