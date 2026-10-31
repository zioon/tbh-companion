// Single source of truth for "which chest family does this box item id belong to".
//
// The tracker vocabulary lives in `shared/types.ts` (`BoxCategory`); the drop
// vocabulary (`ChestDropCategory`) and the lookup vocabulary
// (`LookupBoxCategory`) are supersets/subsets of it, but all three agree on
// the **id bands**, so the band table belongs in one place.
//
// ID bands (gamedata `ItemInfoData`, ITEMTYPE=STAGEBOX):
//
//   | band    | family        | content                                    |
//   |---------|---------------|--------------------------------------------|
//   | 910xxx  | common        | Normal Monster Box                         |
//   | 915xxx  | plagueCommon  | Contaminated Normal Box                     |
//   | 920xxx  | rare          | Stage Boss Box                              |
//   | 925xxx  | plagueRare    | Contaminated Stage Box                      |
//   | 930xxx  | act           | Act Boss Box                                |
//   | 935xxx  | plagueAct     | Contaminated ActBoss Box                    |
//   | 940xxx  | eventNormal   | Halloween Normal Box (CONTENTTYPE=EVENT)    |
//   | 941xxx  | eventStage    | Halloween Stage Box  (CONTENTTYPE=EVENT)    |
//
// v1.3.0 的万圣节活动箱（940xxx/941xxx）在 companion 侧是**两个独立类别**：
// `eventNormal`（940xxx，普通型）与 `eventStage`（941xxx，关卡型）——与普通箱
// / 关卡宝箱的切分方式对称。它们在游戏里占 common / rare 桶（没有专属的容量 /
// 自动开箱 / 掉落冷却链），但 companion 侧按产品决策把它们单列，便于在 Chests
// 页与掉落统计里与普通、关卡宝箱分开归类。
// 详见 `docs/business-flows/09-chest-and-autoclassify.md` §13.7。

import type { BoxCategory } from "../../shared/types";

/**
 * The chest families a box id can belong to — {@link BoxCategory} minus the
 * `unclassified` sentinel (which is a *bookkeeping* fallback, never a real
 * chest family, and is not part of the drop vocabulary).
 */
export type BoxFamily = Exclude<BoxCategory, "unclassified">;

/** Lower bound of the Halloween event box id band (inclusive). */
export const EVENT_BOX_BAND_START = 940_000;
/** Upper bound of the Halloween event box id band (exclusive). */
export const EVENT_BOX_BAND_END = 942_000;

/**
 * Map a chest item id to its family. Returns null for ids that are not chests
 * (materials, equipment, …).
 *
 * The bands are checked in descending specificity: the plague bands (915 /
 * 925 / 935) sit INSIDE the numeric ranges of their base tiers (910–919 /
 * 920–929 / 930–939), so they must be tested first or a Contaminated box would
 * be misread as a normal one. The two event bands (940 / 941) are siblings, not
 * nested, so they are split by their exact thousand.
 */
export function categoryFromBoxItemId(itemId: number): BoxFamily | null {
  if (!Number.isFinite(itemId)) return null;
  if (itemId >= 915_000 && itemId < 916_000) return "plagueCommon";
  if (itemId >= 925_000 && itemId < 926_000) return "plagueRare";
  if (itemId >= 935_000 && itemId < 936_000) return "plagueAct";
  if (itemId >= 910_000 && itemId < 920_000) return "common";
  if (itemId >= 920_000 && itemId < 930_000) return "rare";
  if (itemId >= 930_000 && itemId < 940_000) return "act";
  if (itemId >= 940_000 && itemId < 941_000) return "eventNormal";
  if (itemId >= 941_000 && itemId < 942_000) return "eventStage";
  return null;
}

/** Whether a chest item id belongs to the v1.3.0 Halloween event family. */
export function isEventBoxItemId(itemId: number): boolean {
  return Number.isFinite(itemId) && itemId >= EVENT_BOX_BAND_START && itemId < EVENT_BOX_BAND_END;
}

/**
 * Whether a chest family is one the game auto-opens.
 *
 * The game's auto-open chain is keyed by the box's own type (the
 * `UnlockAutoOpen*Chest` / `ReduceAutoOpen*ChestTime` rune families, one per
 * common / stage-boss / act-boss / plague tier). The v1.3.0 event boxes have
 * no such chain — `RuneInfoData` / `RuneLevelInfoData` carry no
 * `UnlockAutoOpenEvent*Chest` node — so the game never opens them on a timer;
 * the player opens them by hand. Event chests therefore never enter the
 * auto-classify queue (there is no countdown to predict).
 */
export function isAutoOpenedCategory(cat: BoxCategory | null | undefined): boolean {
  return cat != null && cat !== "eventNormal" && cat !== "eventStage" && cat !== "unclassified";
}
