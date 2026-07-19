// P2-2: shared helpers used by every loot-filter module (lootFilters,
// boxLootFilters, offeringLootFilters). Previously each module defined its own
// private `matchesMulti` with identical semantics; centralizing it here removes
// the triplication and makes future filter helpers (e.g. a shared
// grade-options builder) easy to add without a new copy.

/**
 * Multi-select filter semantics: an empty `selected` array means "no filter"
 * (match everything); a non-empty array matches when `value` is included.
 * `null` value never matches a non-empty selection.
 */
export function matchesMulti(selected: string[], value: string | null): boolean {
  return selected.length === 0 || (value != null && selected.includes(value));
}
