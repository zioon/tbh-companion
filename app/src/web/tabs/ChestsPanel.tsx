// Web shell: Chests page.
//
// The desktop Chests tab can't be reused: its catalog is driven by
// `lookup_sources.json` (10 MB, deliberately not shipped to the browser) and its
// slot/capacity/auto-open sections are desktop + live-memory concepts. The web
// panel therefore rebuilds the catalog from the bundled `stage_boxes.json`
// (shipped, 46 KB) and renders the *save* side from `ResolvedInventory.chests`.
//
// Both ends degrade safely:
//   - No save: the full obtainable-chest catalog still renders.
//   - Old saves (where `ChestHolding.type` is a 0..5 boxType, not a gamedata id):
//     the catalog intersection is empty, so no badges appear, but every held row
//     is still listed in the "held in this save" section as label × quantity.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { loadStageBoxCatalogFile, type StageBoxCatalogItem } from "../../core/stageBoxTracker";
import type { LookupBoxCategory } from "../../../shared/types";
import { Badge } from "../../renderer/design-system/primitives/Badge/Badge";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { ItemIcon } from "../../renderer/design-system/primitives/ItemIcon/ItemIcon";
import { TabHeader } from "../../renderer/design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../../renderer/design-system/primitives/TabPage/TabPage";
import { boxIconPath } from "../../renderer/lib/boxIconPath";
import { localizedBoxName, localizeDifficultyWords } from "../../renderer/lib/boxDisplay";
import {
  CHEST_GROUPS,
  chestCategoryFromKey,
  chestCategoryLabelKey,
  type ChestGroupCategory,
} from "../../renderer/lib/chests";
import { gradeColor } from "../../renderer/lib/gradeColor";
import { gradeLabel } from "../../renderer/lib/itemLabels";
import { iconSrc } from "../../renderer/lib/iconSrc";
import { useWebRuntime } from "../lib/useWebRuntime";

/** Map a stage-box item key to the lookup display category used for its name. */
function categoryForKey(itemKey: number): LookupBoxCategory {
  switch (chestCategoryFromKey(itemKey)) {
    case "common":
      return "common";
    case "rare":
      return "stage_boss";
    case "act":
      return "act_boss";
    default:
      return "unknown";
  }
}

function WebChestCard({ box, heldQuantity }: { box: StageBoxCatalogItem; heldQuantity: number }) {
  const { t } = useTranslation("chests");
  const { t: tLookup } = useTranslation("lookup");
  const name = localizedBoxName(
    tLookup,
    { name: box.name, category: categoryForKey(box.id), level: box.level },
    box.id,
  );
  const rangeLabel = box.tracker?.dropStageRangeLabel
    ? localizeDifficultyWords(tLookup, box.tracker.dropStageRangeLabel)
    : null;

  return (
    <Card padding="none" className="relative flex h-full items-center gap-3 p-3.5">
      {heldQuantity > 0 ? (
        <Badge className="absolute -top-2 right-2 z-10">
          {t("catalogHeldQty", { count: heldQuantity })}
        </Badge>
      ) : null}
      <ItemIcon src={iconSrc(boxIconPath(box.id))} color={gradeColor(box.grade)} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 truncate text-[12.5px] font-medium text-fg">{name}</p>
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
          <span style={{ color: gradeColor(box.grade) }}>{gradeLabel(box.grade, tLookup)}</span>
          {rangeLabel ? <span className="text-muted">{rangeLabel}</span> : null}
        </p>
      </div>
    </Card>
  );
}

export function ChestsPanel() {
  const { t } = useTranslation("chests");
  const runtime = useWebRuntime();

  // `stage_boxes.json` is bundled, so this works with or without a save.
  const catalog = useMemo<StageBoxCatalogItem[]>(() => {
    try {
      return loadStageBoxCatalogFile().items.filter((item) => item.obtainable);
    } catch {
      // Data source not installed (e.g. an isolated render) — render the shell
      // rather than crashing.
      return [];
    }
  }, []);

  const groups = useMemo(() => {
    const byGroup = new Map<ChestGroupCategory, StageBoxCatalogItem[]>();
    for (const cat of CHEST_GROUPS) byGroup.set(cat, []);
    for (const box of catalog) {
      const cat = chestCategoryFromKey(box.id);
      if (cat) byGroup.get(cat)!.push(box);
    }
    for (const rows of byGroup.values()) rows.sort((a, b) => a.id - b.id);
    return byGroup;
  }, [catalog]);

  // Held quantity keyed by `ChestHolding.type`. On v1.2.2+ saves this is the
  // gamedata id (matches `stage_boxes.json` ids); on older saves it is a
  // boxType, in which case the intersection is empty and only the held list
  // renders.
  const heldByType = useMemo(() => {
    const m = new Map<number, number>();
    for (const chest of runtime.inventory?.chests ?? []) {
      m.set(chest.type, (m.get(chest.type) ?? 0) + chest.quantity);
    }
    return m;
  }, [runtime.inventory]);

  const heldRows = runtime.inventory?.chests ?? [];

  return (
    <TabPage className="gap-6">
      <TabHeader title={t("tabTitle")} intro={t("catalogIntro")} />

      {heldRows.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[15.5px] font-semibold text-fg">{t("heldHeading")}</h2>
            <p className="m-0 text-xs text-muted">{t("heldIntro")}</p>
          </div>
          <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {heldRows.map((row, index) => (
              <Card
                as="li"
                key={row.uniqueId ?? `${row.type}-${index}`}
                padding="none"
                className="flex items-center justify-between gap-3 px-3.5 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">
                  {row.label ?? `#${row.type}`}
                </span>
                <Badge>{t("heldQty", { count: row.quantity })}</Badge>
              </Card>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="chest-catalog-heading" className="flex flex-col gap-5">
        <h2 id="chest-catalog-heading" className="m-0 text-[15.5px] font-semibold text-fg">
          {t("catalogHeading")}
        </h2>
        {CHEST_GROUPS.map((cat) => {
          const rows = groups.get(cat)!;
          if (rows.length === 0) return null;
          return (
            <div key={cat} className="flex flex-col gap-2.5">
              <h3 className="m-0 text-[11px] font-semibold tracking-[0.06em] uppercase text-fg/70">
                {t(chestCategoryLabelKey(cat))}
                <span className="ml-1.5 font-mono text-[11px] normal-case tracking-normal text-muted">
                  {t("catalogItemsCount", { count: rows.length })}
                </span>
              </h3>
              <div className="grid grid-cols-1 items-stretch gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((box) => (
                  <WebChestCard key={box.id} box={box} heldQuantity={heldByType.get(box.id) ?? 0} />
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </TabPage>
  );
}
