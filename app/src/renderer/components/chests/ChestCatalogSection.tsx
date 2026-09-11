import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LookupBoxSources, LookupItem, LookupSources } from "../../../../shared/types";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { Button } from "../../design-system/primitives/Button/Button";
import { Card } from "../../design-system/primitives/Card/Card";
import { RangeSlider } from "../../design-system/primitives/RangeSlider/RangeSlider";
import { Switch } from "../../design-system/primitives/Switch/Switch";
import { useEntityPanel } from "../../context/entityPanelContext";
import { cn } from "../../lib/cn";
import { BoxCardDropSummary, BoxCardHeader } from "../lookup/BoxCardParts";
import { localizedBoxName } from "../../lib/boxDisplay";
import { fmtCompactLocale } from "../../lib/format";
import { useLookupCatalog } from "../../lib/useLookupCatalog";
import { useMaterialSynthesisPoints } from "../../lib/useMaterialSynthesisPoints";
import { isAccessoryItem, synthesisPointsForItemKey } from "../../../core/synthesisPoints";
import {
  chestCategoryFromKey,
  chestCategoryLabelKey,
  CHEST_GROUPS,
  type ChestGroupCategory,
} from "../../lib/chests";

function dropUnitPoints(
  drop: { itemKey: number; grade: string | null },
  item: LookupItem | null | undefined,
  overrideMap?: Record<number, number> | null,
): number | null {
  return synthesisPointsForItemKey(
    drop.itemKey,
    item?.grade ?? drop.grade,
    isAccessoryItem(item),
    overrideMap,
  );
}

function CatalogChestCard({
  boxItemKey,
  box,
  heldQuantity,
  itemIndex,
  materialPoints,
}: {
  boxItemKey: number;
  box: LookupBoxSources;
  heldQuantity: number;
  itemIndex: Map<number, LookupItem>;
  materialPoints: Record<number, number> | null;
}) {
  const { open } = useEntityPanel();
  const { t } = useTranslation("chests");
  const { t: tLookup, i18n } = useTranslation("lookup");
  const displayName = localizedBoxName(tLookup, box, boxItemKey);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  // Expected synthesis points = Σ(每件掉落率 × 该内容物的单件合成点)，与宝箱详情一致。
  const expectedPoints = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const drop of box.drops) {
      const unit = dropUnitPoints(drop, itemIndex.get(drop.itemKey), materialPoints);
      if (unit == null) continue;
      any = true;
      sum += (drop.dropPct / 100) * unit;
    }
    return any ? sum : null;
  }, [box.drops, itemIndex, materialPoints]);

  return (
    <button
      type="button"
      onClick={() => open({ type: "box", id: boxItemKey })}
      className="flex w-full flex-col text-left"
    >
      <Card
        padding="compact"
        className="flex h-full w-full cursor-pointer flex-col gap-1.5 transition-colors hover:border-accent/60"
      >
        <div className="relative">
          {heldQuantity > 0 ? (
            <Badge className="absolute -top-2 right-0 z-10">
              {t("catalogHeldQty", { count: heldQuantity })}
            </Badge>
          ) : null}
          <BoxCardHeader
            box={box}
            boxItemKey={boxItemKey}
            iconSize="md"
            nameOverride={displayName}
            pointsLine={
              expectedPoints != null ? (
                <>
                  <span className="font-semibold text-fg/60">
                    {tLookup("box.expectedSynthesisPoints")}：
                  </span>
                  {fmtCompactLocale(expectedPoints, locale)}
                </>
              ) : null
            }
          />
        </div>
        <BoxCardDropSummary box={box} />
      </Card>
    </button>
  );
}

export function ChestCatalogSection({
  sources,
  heldQuantities,
}: {
  sources: LookupSources | null;
  heldQuantities: ReadonlyMap<number, number>;
}) {
  const { t } = useTranslation("chests");
  const catalog = useLookupCatalog();
  const materialPoints = useMaterialSynthesisPoints();
  const itemIndex = useMemo(() => new Map((catalog ?? []).map((i) => [i.id, i])), [catalog]);

  // Category filter: a selected subset of CHEST_GROUPS. An empty selection means
  // "show all" (matches the project's matchesMulti semantics used in loot/box-loot).
  // Defaults to empty so every category chip starts unselected (still shows all boxes).
  const [selectedCategories, setSelectedCategories] = useState<Set<ChestGroupCategory>>(new Set());
  // Level filter: null = off (show all levels); otherwise an inclusive [lo, hi].
  const [levelRange, setLevelRange] = useState<[number, number] | null>(null);
  // Hide boxes that have no findable source stage, or that drop once (first-time
  // only) and are effectively unobtainable. On by default so the catalog stays clean.
  const [hideUnobtainable, setHideUnobtainable] = useState(true);

  // Group every catalog entry by its 9xxx item-key prefix so plague boxes land
  // in their own groups (lookup's `box.category` reports them as "unknown").
  const { groups, levelMin, levelMax } = useMemo(() => {
    const byGroup = new Map<
      ChestGroupCategory,
      Array<{ boxItemKey: number; box: LookupBoxSources }>
    >();
    for (const cat of CHEST_GROUPS) byGroup.set(cat, []);
    let min = Infinity;
    let max = -Infinity;
    if (sources) {
      for (const [key, box] of Object.entries(sources.boxes)) {
        const boxItemKey = Number(key);
        const cat = chestCategoryFromKey(boxItemKey);
        if (cat == null) continue;
        byGroup.get(cat)!.push({ boxItemKey, box });
        if (box.level != null) {
          min = Math.min(min, box.level);
          max = Math.max(max, box.level);
        }
      }
    }
    for (const rows of byGroup.values()) rows.sort((a, b) => a.boxItemKey - b.boxItemKey);
    return {
      groups: byGroup,
      levelMin: Number.isFinite(min) ? min : null,
      levelMax: Number.isFinite(max) ? max : null,
    };
  }, [sources]);

  const hasCategoryFilter =
    selectedCategories.size > 0 && selectedCategories.size < CHEST_GROUPS.length;
  const hasLevelFilter = levelRange != null;
  const showLevelSlider = levelMin != null && levelMax != null && levelMax > levelMin;

  const toggleCategory = (cat: ChestGroupCategory): void => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const activeLevelRange: [number, number] =
    levelRange ?? (showLevelSlider ? [levelMin!, levelMax!] : [0, 0]);

  // Apply the category + level filters once, then render only non-empty groups.
  const visible = useMemo(() => {
    const out: Array<{
      cat: ChestGroupCategory;
      rows: Array<{ boxItemKey: number; box: LookupBoxSources }>;
    }> = [];
    let total = 0;
    for (const cat of CHEST_GROUPS) {
      const all = groups.get(cat)!;
      const selected = selectedCategories.has(cat);
      const rows = all.filter(({ box }) => {
        if (hideUnobtainable && ((box.stages?.length ?? 0) === 0 || box.firstDropOnly === true)) {
          return false;
        }
        if (hasCategoryFilter && !selected) return false;
        if (hasLevelFilter && box.level != null) {
          const [lo, hi] = levelRange!;
          if (box.level < lo || box.level > hi) return false;
        }
        return true;
      });
      if (rows.length === 0) continue;
      total += rows.length;
      out.push({ cat, rows });
    }
    return { groups: out, total };
  }, [groups, selectedCategories, hasCategoryFilter, hasLevelFilter, levelRange, hideUnobtainable]);

  return (
    <section aria-labelledby="chest-catalog-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="chest-catalog-heading" className="m-0 text-sm font-semibold">
          {t("catalogHeading")}
        </h2>
        <p className="m-0 text-xs text-muted">{t("catalogIntro")}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel/50 p-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-fg/80">{t("filterCategoryLabel")}</span>
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <label
                className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-fg/70"
                title={t("filterHideUnobtainableHint")}
              >
                <Switch
                  checked={hideUnobtainable}
                  onCheckedChange={(c) => setHideUnobtainable(c)}
                  aria-label={t("filterHideUnobtainable")}
                />
                <span>{t("filterHideUnobtainable")}</span>
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedCategories(new Set(CHEST_GROUPS));
                  setLevelRange(null);
                }}
              >
                {t("filterSelectAll")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedCategories(new Set());
                  setLevelRange(null);
                }}
              >
                {t("filterClear")}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CHEST_GROUPS.map((cat) => {
              const selected = selectedCategories.has(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-semibold leading-snug transition-colors",
                    selected
                      ? "border-accent bg-ideal/15 text-accent"
                      : "border-border bg-card text-muted hover:border-muted hover:text-fg",
                  )}
                >
                  {t(chestCategoryLabelKey(cat))}
                </button>
              );
            })}
          </div>
        </div>

        {showLevelSlider ? (
          <RangeSlider
            min={levelMin!}
            max={levelMax!}
            step={1}
            value={activeLevelRange}
            onValueChange={setLevelRange}
            label={t("filterLevelLabel")}
          />
        ) : null}
      </div>

      {visible.groups.map(({ cat, rows }) => (
        <div key={cat} className="flex flex-col gap-2">
          <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg/70">
            {t(chestCategoryLabelKey(cat))}
            <span className="ml-1.5 text-muted normal-case">
              {t("catalogItemsCount", { count: rows.length })}
            </span>
          </h3>
          <div className="grid grid-cols-2 items-stretch gap-2.5 max-[720px]:grid-cols-1">
            {rows.map(({ boxItemKey, box }) => (
              <CatalogChestCard
                key={boxItemKey}
                boxItemKey={boxItemKey}
                box={box}
                heldQuantity={heldQuantities.get(boxItemKey) ?? 0}
                itemIndex={itemIndex}
                materialPoints={materialPoints}
              />
            ))}
          </div>
        </div>
      ))}

      {(hasCategoryFilter || hasLevelFilter || hideUnobtainable) && visible.total === 0 ? (
        <p className="m-0 text-xs text-muted">{t("filterNoMatch")}</p>
      ) : null}
    </section>
  );
}
