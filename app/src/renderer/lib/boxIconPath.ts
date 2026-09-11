/**
 * Stage-box keys (910/920/930xxx) share three category icons in data/icons/.
 * Plague (Contaminated) boxes use disjoint 9xxx prefixes (915/925/935xxx) and
 * have their OWN sprites in the game assets (Item_915001/925001/935001), so
 * they map to the extracted plague icons rather than the plain chest icons.
 */
export function boxIconPath(boxItemKey: number): string {
  const id = String(boxItemKey);
  if (id.startsWith("935")) return "item-935001"; // plague act boss
  if (id.startsWith("930")) return "item-930011";
  if (id.startsWith("925")) return "item-925001"; // plague stage boss
  if (id.startsWith("920")) return "item-920011";
  if (id.startsWith("915")) return "item-915001"; // plague common
  if (id.startsWith("910")) return "item-910011";
  return `item-${boxItemKey}`;
}
