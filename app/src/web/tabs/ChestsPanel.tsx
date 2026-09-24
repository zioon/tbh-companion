// Web shell: Chests page.
//
// The desktop Chests tab can't be reused wholesale: its catalog is driven by
// `lookup_sources.json` (10 MB, deliberately not shipped to the browser) and its
// slot/capacity/auto-open sections are desktop + live-memory concepts. The web
// panel therefore rebuilds the catalog from the bundled `stage_boxes.json`
// (shipped, 46 KB) and renders the *save* side from `ResolvedInventory.chests`.
//
// What IS shared with the desktop is the chest detail card: the slim
// `box-sources.json` payload (built from `lookup_sources.json` at build time,
// fetched lazily by `boxSourcesSnapshot.ts`) rehydrates into the exact
// `LookupBoxSources` shape `BoxDetailCard` consumes, so clicking a chest opens
// the same drop list / farm stages view the desktop shows.
//
// Filters mirror the desktop catalog: multi-select category chips plus a level
// range slider.
//
// Both ends degrade safely:
//   - No save: the full obtainable-chest catalog still renders.
//   - Missing payload: the catalog renders, chest cards stop being clickable.
//   - Old saves (where `ChestHolding.type` is a 0..5 boxType, not a gamedata
//     id): the catalog intersection is empty, so no badges appear, but every
//     held row is still listed in the "held in this save" section.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadStageBoxCatalogFile, type StageBoxCatalogItem } from "../../core/stageBoxTracker";
import { loadBoxTypeCatalog, resolveChestHoldings } from "../../core/boxes";
import type { LookupBoxSources, LookupItem, ResolvedChestRow } from "../../../shared/types";
import { Badge } from "../../renderer/design-system/primitives/Badge/Badge";
import { Button } from "../../renderer/design-system/primitives/Button/Button";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { ItemIcon } from "../../renderer/design-system/primitives/ItemIcon/ItemIcon";
import { RangeSlider } from "../../renderer/design-system/primitives/RangeSlider/RangeSlider";
import { SidePanel } from "../../renderer/design-system/primitives/SidePanel/SidePanel";
import { TabHeader } from "../../renderer/design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../../renderer/design-system/primitives/TabPage/TabPage";
import { BoxDetailCard } from "../../renderer/components/lookup/BoxDetailCard";
import { ItemDetailCard } from "../../renderer/components/lookup/ItemDetailCard";
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
import { cn } from "../../renderer/lib/cn";
import type { LookupNavNode } from "../../renderer/lib/useLookupNav";
import { loadLookupItems } from "../../core/lookup/catalog";
import { ensureBoxSourcesLoaded, useBoxSources } from "../boxSourcesSnapshot";
import { useWebRuntime } from "../lib/useWebRuntime";

/** Map a stage-box item key to the lookup display category used for its name. */
function categoryForKey(itemKey: number): LookupBoxSources["category"] {
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

function WebChestCard({
  box,
  heldQuantity,
  onOpen,
}: {
  box: StageBoxCatalogItem;
  heldQuantity: number;
  onOpen: () => void;
}) {
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
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer text-left"
      aria-label={name}
    >
      <Card
        padding="none"
        className="relative flex h-full w-full items-center gap-3 p-3.5 transition-colors hover:border-accent/50"
      >
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
    </button>
  );
}

export function ChestsPanel() {
  const { t } = useTranslation("chests");
  const { t: tLookup } = useTranslation("lookup");
  const { t: tCommon } = useTranslation("common");
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

  // The bundled item catalog feeds the detail panel's hover cards and item
  // navigation.
  const lookupItems = useMemo<LookupItem[]>(() => {
    try {
      return loadLookupItems();
    } catch {
      return [];
    }
  }, []);
  const itemIndex = useMemo(
    () => new Map(lookupItems.map((item) => [item.id, item])),
    [lookupItems],
  );
  const stageBoxById = useMemo(() => new Map(catalog.map((box) => [box.id, box])), [catalog]);

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

  // --- Filters (mirrors the desktop ChestCatalogSection) -------------------

  const [selectedCategories, setSelectedCategories] = useState<Set<ChestGroupCategory>>(
    () => new Set(CHEST_GROUPS),
  );
  const levelBounds = useMemo(() => {
    const levels = catalog
      .map((box) => box.level)
      .filter((level): level is number => level != null);
    return levels.length > 0 ? { min: Math.min(...levels), max: Math.max(...levels) } : null;
  }, [catalog]);
  const [levelRange, setLevelRange] = useState<[number, number] | null>(null);

  const hasCategoryFilter = selectedCategories.size !== CHEST_GROUPS.length;
  const hasLevelFilter = levelRange != null && levelBounds != null;

  const toggleCategory = (cat: ChestGroupCategory): void => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const visible = useMemo(() => {
    const out: Array<{ cat: ChestGroupCategory; rows: StageBoxCatalogItem[] }> = [];
    let total = 0;
    for (const cat of CHEST_GROUPS) {
      if (hasCategoryFilter && !selectedCategories.has(cat)) continue;
      const rows = (groups.get(cat) ?? []).filter((box) => {
        if (!hasLevelFilter) return true;
        const [lo, hi] = levelRange!;
        // A chest with no annotated level cannot be placed in a range.
        return box.level != null && box.level >= lo && box.level <= hi;
      });
      if (rows.length === 0) continue;
      total += rows.length;
      out.push({ cat, rows });
    }
    return { groups: out, total };
  }, [groups, selectedCategories, hasCategoryFilter, hasLevelFilter, levelRange]);

  // --- Held chests ---------------------------------------------------------

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

  // Held chests, aggregated exactly the way the desktop Chest tab aggregates
  // them (`resolveChestHoldings`): the raw holdings are one entry per chest
  // instance, each with `quantity: 1`, so rendering them directly produced a
  // ×1 row per chest instead of one row per box type with the total.
  // Grouped by category to match what the section intro promises; categories
  // outside the known six trail without a heading, as on desktop.
  const heldGroups = useMemo(() => {
    const chests = runtime.inventory?.chests ?? [];
    if (chests.length === 0) return { known: [], leftover: [] };

    let rows: ResolvedChestRow[];
    try {
      rows = resolveChestHoldings(chests, loadBoxTypeCatalog());
    } catch {
      // Data source not installed (isolated render) — fall back to a plain
      // aggregate so the quantities are still correct.
      const byType = new Map<number, ResolvedChestRow>();
      for (const c of chests) {
        const prev = byType.get(c.type);
        if (prev) prev.quantity += c.quantity;
        else
          byType.set(c.type, {
            boxType: c.type,
            label: c.label ?? `Type ${c.type}`,
            category: c.category ?? "unclassified",
            quantity: c.quantity,
          });
      }
      rows = [...byType.values()];
    }

    const known = CHEST_GROUPS.flatMap((cat) => {
      const group = rows.filter((r) => r.category === cat);
      return group.length > 0 ? [{ cat, rows: group }] : [];
    });
    const leftover = rows.filter((r) => !CHEST_GROUPS.includes(r.category as ChestGroupCategory));
    return { known, leftover };
  }, [runtime.inventory]);

  // --- Chest detail side panel --------------------------------------------

  // Warm the payload when the page mounts so the first click opens instantly.
  useEffect(() => {
    void ensureBoxSourcesLoaded();
  }, []);

  const { status: boxStatus, boxes: boxSources } = useBoxSources();
  const [panelNode, setPanelNode] = useState<LookupNavNode | null>(null);

  const labelFor = useCallback(
    (node: LookupNavNode): string => {
      if (node.type === "item") {
        return itemIndex.get(node.id)?.name ?? tCommon("entityPanel.itemFallback", { id: node.id });
      }
      const stageBox = stageBoxById.get(node.id);
      if (stageBox) {
        return localizedBoxName(
          tLookup,
          { name: stageBox.name, category: categoryForKey(node.id), level: stageBox.level },
          node.id,
        );
      }
      return (
        boxSources?.[String(node.id)]?.name ?? tCommon("entityPanel.boxFallback", { id: node.id })
      );
    },
    [itemIndex, stageBoxById, boxSources, tCommon, tLookup],
  );

  const peekItem = useCallback((id: number) => itemIndex.get(id), [itemIndex]);

  /** Box detail payload, enriched with the chest level from `stage_boxes.json`. */
  const boxFor = useCallback(
    (id: number): LookupBoxSources | null => {
      const box = boxSources?.[String(id)];
      if (!box) return null;
      return { ...box, level: stageBoxById.get(id)?.level ?? null };
    },
    [boxSources, stageBoxById],
  );

  const title = panelNode ? labelFor(panelNode) : t("tabTitle");

  return (
    <TabPage className="gap-6">
      <TabHeader title={t("tabTitle")} intro={t("catalogIntro")} />

      {heldGroups.known.length > 0 || heldGroups.leftover.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[15.5px] font-semibold text-fg">{t("heldHeading")}</h2>
            <p className="m-0 text-xs text-muted">{t("heldIntro")}</p>
          </div>

          {heldGroups.known.map(({ cat, rows }) => (
            <div key={cat} className="flex flex-col gap-2.5">
              <h3 className="m-0 text-[11px] font-semibold tracking-[0.06em] uppercase text-fg/70">
                {t(chestCategoryLabelKey(cat))}
                <span className="ml-1.5 font-mono text-[11px] normal-case tracking-normal text-muted">
                  {t("catalogItemsCount", { count: rows.length })}
                </span>
              </h3>
              <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((row) => (
                  <Card
                    as="li"
                    key={row.boxType}
                    padding="none"
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">
                      {row.label}
                    </span>
                    <Badge>{t("heldQty", { count: row.quantity })}</Badge>
                  </Card>
                ))}
              </ul>
            </div>
          ))}

          {heldGroups.leftover.length > 0 ? (
            <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
              {heldGroups.leftover.map((row) => (
                <Card
                  as="li"
                  key={row.boxType}
                  padding="none"
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">
                    {row.label}
                  </span>
                  <Badge>{t("heldQty", { count: row.quantity })}</Badge>
                </Card>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="chest-catalog-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="chest-catalog-heading" className="m-0 text-[15.5px] font-semibold text-fg">
            {t("catalogHeading")}
          </h2>
          <p className="m-0 text-xs text-muted">{t("catalogIntro")}</p>
        </div>

        {/* Filters — same shape as the desktop catalog: multi-select category
            chips plus a chest-level range. */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel/50 p-3">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-fg/80">{t("filterCategoryLabel")}</span>
              <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
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

          {levelBounds ? (
            <RangeSlider
              min={levelBounds.min}
              max={levelBounds.max}
              step={1}
              value={levelRange ?? [levelBounds.min, levelBounds.max]}
              onValueChange={setLevelRange}
              label={t("filterLevelLabel")}
            />
          ) : null}
        </div>

        {visible.groups.length === 0 ? (
          <p className="m-0 text-xs text-muted">{t("filterNoMatch")}</p>
        ) : (
          visible.groups.map(({ cat, rows }) => (
            <div key={cat} className="flex flex-col gap-2.5">
              <h3 className="m-0 text-[11px] font-semibold tracking-[0.06em] uppercase text-fg/70">
                {t(chestCategoryLabelKey(cat))}
                <span className="ml-1.5 font-mono text-[11px] normal-case tracking-normal text-muted">
                  {t("catalogItemsCount", { count: rows.length })}
                </span>
              </h3>
              <div className="grid grid-cols-1 items-stretch gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((box) => (
                  <WebChestCard
                    key={box.id}
                    box={box}
                    heldQuantity={heldByType.get(box.id) ?? 0}
                    onOpen={() => setPanelNode({ type: "box", id: box.id })}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <SidePanel
        open={panelNode != null}
        onOpenChange={(open) => !open && setPanelNode(null)}
        title={title}
      >
        {panelNode == null ? null : panelNode.type === "box" ? (
          boxFor(panelNode.id) ? (
            <BoxDetailCard
              box={boxFor(panelNode.id) as LookupBoxSources}
              boxItemKey={panelNode.id}
              onNavigate={setPanelNode}
              peekItem={peekItem}
            />
          ) : boxStatus === "loading" ? (
            <p className="m-0 text-xs text-muted">{t("detailLoading")}</p>
          ) : (
            <p className="m-0 text-xs text-muted">{t("detailUnavailable")}</p>
          )
        ) : (
          (() => {
            const item = itemIndex.get(panelNode.id);
            if (!item) {
              return (
                <p className="m-0 text-xs text-muted">{tLookup("entityDetail.itemNotFound")}</p>
              );
            }
            return (
              <ItemDetailCard
                item={item}
                onNavigate={setPanelNode}
                peekItem={peekItem}
                peekBox={(id) => boxSources?.[String(id)]}
              />
            );
          })()
        )}
      </SidePanel>
    </TabPage>
  );
}
