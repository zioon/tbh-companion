// Lifetime aggregate counters from PlayerSaveData.aggregateSaveDatas.
// Type/SubKey semantics are partially decoded — see docs/SAVE_FORMAT.md.

export interface AggregateEntry {
  type: number;
  subKey: number;
  value: number;
}

export function parseAggregateEntries(
  player: Record<string, unknown> | null | undefined,
): AggregateEntry[] {
  if (!player) return [];
  const raw = player.aggregateSaveDatas;
  if (!Array.isArray(raw)) return [];
  const out: AggregateEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = Math.trunc(Number(r.Type ?? r.type ?? -1));
    const subKey = Math.trunc(Number(r.SubKey ?? r.subKey ?? 0));
    const value = Math.trunc(Number(r.Value ?? r.value ?? 0));
    if (!Number.isFinite(type) || type < 0 || subKey <= 0 || value <= 0) continue;
    out.push({ type, subKey, value });
  }
  return out;
}

/**
 * Best-effort SubKey -> ItemKey for stackable materials (Type 0).
 * Returns null when the mapping is unknown — never guess a wrong ItemKey.
 */
export function aggregateSubKeyToItemKey(type: number, subKey: number): number | null {
  if (type !== 0 || subKey <= 0) return null;

  // Full ItemKey stored directly as SubKey (e.g. 141002).
  if (subKey >= 110_001 && subKey <= 639_999) return subKey;

  // Partial pattern: 140000 + (SubKey % 10000) — verified for some Type 0 rows (e.g. 10002 -> Stone).
  return 140_000 + (subKey % 10_000);
}

/**
 * Legacy fallback: ItemKey -> quantity from lifetime aggregate rows (materials
 * only).
 *
 * `aggregateSaveDatas` is a set of **lifetime counters**, not a live inventory
 * snapshot — it keeps counting even after materials are consumed. It was the
 * only material source before the stacking update; now the authoritative source
 * is the per-slot `Quantity` on `inventorySaveDatas`/`stashSaveDatas` (see
 * `./stacks.ts`). This function is therefore used **only** when no slot-based
 * stacking data is available (old save, or field removed).
 *
 * When two distinct SubKeys map to the same ItemKey we take the larger counter
 * — summing them would double-count the same lifetime tally. The result is
 * still clamped per catalog semantics downstream; here we only avoid emitting a
 * value above {@link MAX_STACK_PER_SLOT}-derived totals is left to callers
 * because aggregates are lifetime totals, not per-slot stacks.
 */
export function materialStacksFromAggregates(
  entries: AggregateEntry[],
  isMaterialItemKey: (itemKey: number) => boolean,
): Map<number, number> {
  const stacks = new Map<number, number>();
  for (const e of entries) {
    const itemKey = aggregateSubKeyToItemKey(e.type, e.subKey);
    if (itemKey == null || !isMaterialItemKey(itemKey)) continue;
    const prev = stacks.get(itemKey) ?? 0;
    stacks.set(itemKey, Math.max(prev, e.value));
  }
  return stacks;
}
