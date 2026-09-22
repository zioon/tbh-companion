// Owned items to refresh on Steam Market — one logical target per catalog piece.

import type { GameItem } from "../gamedata";
import { marketHashCandidates, limitGearVariantHashes } from "../marketName";
import type { InventorySnapshot } from "../../../shared/types";

export type OwnedPriceTarget =
  | { kind: "material"; hash: string }
  | { kind: "gear"; candidates: readonly string[] };

/** All market_hash_name keys that may appear in the price cache for owned items. */
export function flattenOwnedHashes(targets: readonly OwnedPriceTarget[]): string[] {
  const names = new Set<string>();
  for (const target of targets) {
    if (target.kind === "material") {
      names.add(target.hash);
    } else {
      target.candidates.forEach((hash) => names.add(hash));
    }
  }
  return [...names];
}

export function ownedPriceTargetForItem(item: GameItem): OwnedPriceTarget | null {
  const candidates = marketHashCandidates(item);
  if (candidates.length === 0) return null;
  if (item.type === "MATERIAL") return { kind: "material", hash: candidates[0] };
  return { kind: "gear", candidates: limitGearVariantHashes(candidates) };
}

export function ownedPriceTargets(
  snapshot: InventorySnapshot,
  lookup: (itemKey: number) => GameItem | undefined,
  excludeItemKey?: (itemKey: number) => boolean,
): OwnedPriceTarget[] {
  const targets: OwnedPriceTarget[] = [];
  const seenItemKeys = new Set<number>();

  const addItemKey = (itemKey: number): void => {
    if (excludeItemKey?.(itemKey)) return;
    if (seenItemKeys.has(itemKey)) return;
    seenItemKeys.add(itemKey);

    const catalogItem = lookup(itemKey);
    if (!catalogItem) return;

    const target = ownedPriceTargetForItem(catalogItem);
    if (target) targets.push(target);
  };

  snapshot.items.forEach((instance) => addItemKey(instance.itemKey));

  // Materials can exist ONLY as stack holdings (no assignable `itemSaveDatas`
  // instance — the sole durable record is the per-slot `Quantity`). Without
  // this pass those materials would never get a price target and would show no
  // market value on the Inventory tab.
  snapshot.materialStacks?.forEach((stack, itemKey) => {
    if (stack.total <= 0) return;
    addItemKey(itemKey);
  });

  return targets;
}
