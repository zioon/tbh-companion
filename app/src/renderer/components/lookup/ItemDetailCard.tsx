import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LookupBoxSources,
  LookupItem,
  LookupItemSources,
  LookupUsedInEntry,
  OfferingsModel,
  SynthesisModel,
  SynthesisPathToItem,
} from "../../../../shared/types";
import { gradeLabel } from "../../../core/labels";
import { offeringForCoin, offeringSourcesForItem } from "../../../core/lookup/offerings";
import {
  formatMaterialAverageLevelRange,
  formatSynthesisResultRange,
  materialAverageLevelRange,
  pathsToItem,
  recipeTierResultRange,
  synthesisPathKey,
  synthesisTypeForItem,
} from "../../../core/lookup/synthesis";
import { Accordion } from "../../design-system/primitives/Accordion/Accordion";
import { Card } from "../../design-system/primitives/Card/Card";
import { CardContent, CardHeader } from "../../design-system/primitives/Card/CardParts";
import { DataList, DataListRow } from "../../design-system/primitives/DataList/DataList";
import { Input } from "../../design-system/primitives/Input/Input";
import { boxIconPath } from "../../lib/boxIconPath";
import { cn } from "../../lib/cn";
import { gradeColor } from "../../lib/gradeColor";
import { fmtDropPct, fmtLookupPct, hasDropChance, humanizeStatKey } from "../../lib/lookupDisplay";
import { filterUsedInOutputs, sortUsedInRecipes } from "../../lib/usedInFilters";
import type { LookupNavNode } from "../../lib/useLookupNav";
import { ItemLink } from "../ItemLink";
import {
  ItemCardHeader,
  MaterialGroup,
  SectionHeading,
  SectionHeadingRow,
  SectionLabelRow,
  StatGroup,
} from "./itemCardParts";
import { LookupPrice } from "./LookupPrice";
import { OfferingLoot } from "./OfferingLoot";

const SCROLL_SECTION_MAX = "max-h-44";

function SynthesisPathRow({
  path,
  synthesisType,
  model,
  isBest,
  index,
}: {
  path: SynthesisPathToItem;
  synthesisType: string;
  model: SynthesisModel;
  isBest: boolean;
  index: number;
}) {
  const { t } = useTranslation("lookup");
  const tierRange = recipeTierResultRange(model, synthesisType, path.tier);
  const avgRange = materialAverageLevelRange(path);
  const setup =
    tierRange != null
      ? t("synthesis.tierRange", {
          tier: path.tier,
          range: formatSynthesisResultRange(tierRange.min, tierRange.max),
        })
      : t("synthesis.tierOnly", { tier: path.tier });

  return (
    <DataListRow
      index={index}
      className={cn(
        "flex items-baseline justify-between gap-2 py-1.5",
        isBest && "border-l-2 border-l-status-success",
      )}
    >
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-fg">
        {setup}
        <span className="text-[11px] text-muted">
          {" "}
          · {formatMaterialAverageLevelRange(avgRange)}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 text-[13px] tabular-nums",
          isBest ? "text-status-success" : "text-fg",
        )}
      >
        {fmtLookupPct(path.chance)}%
      </span>
    </DataListRow>
  );
}

function SynthesisGradeCard({
  materialAmount,
  inputGrade,
  paths,
  synthesisType,
  model,
  bestPathKey,
}: {
  materialAmount: number;
  inputGrade: string;
  paths: SynthesisPathToItem[];
  synthesisType: string;
  model: SynthesisModel;
  bestPathKey: string | null;
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="border-b border-border px-3 py-2">
        <p className="m-0 text-[12px] font-semibold" style={{ color: gradeColor(inputGrade) }}>
          {materialAmount}× {gradeLabel(inputGrade)}
        </p>
      </div>
      <DataList shell="none" scrollable className={SCROLL_SECTION_MAX}>
        {paths.map((path, i) => (
          <SynthesisPathRow
            key={synthesisPathKey(path)}
            path={path}
            synthesisType={synthesisType}
            model={model}
            isBest={synthesisPathKey(path) === bestPathKey}
            index={i}
          />
        ))}
      </DataList>
    </Card>
  );
}

function groupPathsByInput(paths: SynthesisPathToItem[]) {
  const groups = new Map<string, SynthesisPathToItem[]>();
  for (const path of paths) {
    const key = `${path.inputGrade}|${path.gradeStep}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(path);
  }
  return [...groups.entries()]
    .map(([key, groupPaths]) => {
      const [inputGrade, gradeStepStr] = key.split("|");
      const paths = groupPaths.toSorted((a, b) => b.chance - a.chance);
      return {
        inputGrade,
        gradeStep: Number(gradeStepStr),
        materialAmount: groupPaths[0]?.materialAmount ?? 9,
        paths,
        bestChance: paths[0]?.chance ?? 0,
      };
    })
    .toSorted((a, b) => b.bestChance - a.bestChance);
}

function UsedInRecipeCard({
  entry,
  peekItem,
  onNavigate,
  outputItemIndex,
}: {
  entry: LookupUsedInEntry;
  peekItem?: (id: number) => LookupItem | undefined;
  onNavigate?: (node: LookupNavNode) => void;
  outputItemIndex: Map<number, LookupItem>;
}) {
  const { t } = useTranslation("lookup");
  const [query, setQuery] = useState("");
  const filteredOutputs = useMemo(
    () => filterUsedInOutputs(entry.outputs, query, outputItemIndex),
    [entry.outputs, query, outputItemIndex],
  );
  const showPoolPct = entry.outputs.length > 1;

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[13px] text-fg">
        {t("tierLevelBand", {
          tier: entry.tier,
          min: entry.level.min,
          max: entry.level.max,
        })}{" "}
        · {humanizeStatKey(entry.craftingType)}
      </p>
      <div className="flex flex-col gap-1 pl-1">
        {entry.materials.map((material) => {
          const matItem = peekItem?.(material.itemKey);
          return (
            <ItemLink
              key={material.itemKey}
              node={{ type: "item", id: material.itemKey }}
              name={matItem?.name ?? material.name}
              grade={matItem?.grade}
              iconPath={matItem?.iconPath}
              suffix={material.amount > 1 ? `×${material.amount}` : undefined}
              onNavigate={onNavigate}
              peekItem={peekItem}
            />
          );
        })}
      </div>
      <Accordion
        title={t("usedIn.possibleOutputs", { count: entry.outputs.length })}
        variant="panel"
      >
        <div className="flex flex-col gap-2">
          <Input
            className="min-w-0 flex-1"
            placeholder={t("usedIn.searchOutputs")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Card padding="none" className="overflow-hidden">
            <DataList scrollable className={SCROLL_SECTION_MAX}>
              {filteredOutputs.length === 0 ? (
                <DataListRow index={0} className="text-xs text-muted">
                  {t("usedIn.noMatch")}
                </DataListRow>
              ) : (
                filteredOutputs.map((output, i) => {
                  const outItem = peekItem?.(output.itemKey);
                  const pctSuffix = showPoolPct ? ` · ${fmtLookupPct(output.poolPct)}%` : undefined;
                  return (
                    <DataListRow key={output.itemKey} index={i}>
                      <ItemLink
                        node={{ type: "item", id: output.itemKey }}
                        name={outItem?.name ?? t("itemFallback", { id: output.itemKey })}
                        grade={outItem?.grade}
                        iconPath={outItem?.iconPath}
                        suffix={pctSuffix}
                        onNavigate={onNavigate}
                        peekItem={peekItem}
                      />
                    </DataListRow>
                  );
                })
              )}
            </DataList>
          </Card>
        </div>
      </Accordion>
    </div>
  );
}

/**
 * Reusable item detail surface — drives the Lookup tab's detail panel and
 * (later) Inventory row hover. Links are inert unless onNavigate is passed.
 */
export function ItemDetailCard({
  item,
  sources,
  synthesisModel,
  offerings,
  onNavigate,
  peekItem,
  peekBox,
}: {
  item: LookupItem;
  sources?: LookupItemSources;
  synthesisModel?: SynthesisModel | null;
  offerings?: OfferingsModel | null;
  onNavigate?: (node: LookupNavNode) => void;
  peekItem?: (id: number) => LookupItem | undefined;
  peekBox?: (id: number) => LookupBoxSources | undefined;
}) {
  const { t } = useTranslation("lookup");
  const synthesisPaths = useMemo(
    () => (synthesisModel ? pathsToItem(item, synthesisModel) : []),
    [item, synthesisModel],
  );

  const offering =
    item.materialType === "OFFERING" && offerings ? offeringForCoin(offerings, item.id) : null;
  const offeringSources = useMemo(
    () => (offerings ? offeringSourcesForItem(offerings, item.id) : []),
    [offerings, item.id],
  );

  const hasCrafting = (sources?.crafting.length ?? 0) > 0;
  const hasSynthesis = synthesisPaths.length > 0 && synthesisModel != null;
  const sortedDrops = sources
    ? [...sources.drops].filter(hasDropChance).sort((a, b) => (b.dropPct ?? -1) - (a.dropPct ?? -1))
    : [];
  const hasDrops = sortedDrops.length > 0;
  const hasOfferingSources = offeringSources.length > 0;
  const hasAcquisition = hasCrafting || hasSynthesis || hasDrops || hasOfferingSources;
  const hasUsedIn = item.type === "MATERIAL" && (sources?.usedIn?.length ?? 0) > 0;

  const usedInRecipes = useMemo(() => sortUsedInRecipes(sources?.usedIn ?? []), [sources?.usedIn]);

  const outputItemIndex = useMemo(() => {
    const map = new Map<number, LookupItem>();
    if (!sources?.usedIn || !peekItem) return map;
    for (const entry of sources.usedIn) {
      for (const output of entry.outputs) {
        const resolved = peekItem(output.itemKey);
        if (resolved) map.set(output.itemKey, resolved);
      }
    }
    return map;
  }, [sources, peekItem]);

  const pathGroups = groupPathsByInput(synthesisPaths);
  const synthesisType = synthesisTypeForItem(item);
  const bestPathKey = synthesisPaths[0] != null ? synthesisPathKey(synthesisPaths[0]) : null;

  const hasStats =
    (item.stats != null &&
      (item.stats.base.length > 0 ||
        item.stats.inherent.length > 0 ||
        item.stats.unique != null)) ||
    (item.gearGroups?.length ?? 0) > 0;

  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <ItemCardHeader
          item={item}
          iconSize="lg"
          trailing={<LookupPrice item={item} interactive />}
        />
      </CardHeader>

      <CardContent className="gap-3">
        {hasStats ? (
          <div className="flex min-w-0 flex-col gap-3">
            {item.stats ? (
              <>
                <StatGroup title={t("stats.base")} rows={item.stats.base} tone="base" />
                <StatGroup title={t("stats.inherent")} rows={item.stats.inherent} tone="inherent" />
                {item.stats.unique ? (
                  <StatGroup
                    title={t("stats.unique")}
                    rows={[{ display: item.stats.unique.text }]}
                    tone="unique"
                  />
                ) : null}
              </>
            ) : null}

            {item.gearGroups?.map((group) => (
              <MaterialGroup key={group.gearGroup} group={group} />
            ))}
          </div>
        ) : null}

        <div className={cn("flex flex-col gap-3", hasStats && "border-t border-border pt-3")}>
          <SectionHeading>{t("whereToFind")}</SectionHeading>

          {!hasAcquisition ? (
            <p className="m-0 text-xs text-muted">{t("notAcquirable")}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {hasCrafting && sources ? (
                <div className="flex flex-col gap-2">
                  <SectionLabelRow
                    label={t("crafting.label")}
                    help={t("crafting.help")}
                    helpLabel={t("crafting.helpLabel")}
                  />
                  <Card padding="none" className="overflow-hidden">
                    <div className="flex flex-col gap-3 p-3">
                      {sources.crafting.map((recipe) => (
                        <div key={recipe.recipeKey} className="flex flex-col gap-1">
                          <p className="m-0 text-[13px] text-fg">
                            {t("tierLevelBand", {
                              tier: recipe.tier,
                              min: recipe.level.min,
                              max: recipe.level.max,
                            })}{" "}
                            · {humanizeStatKey(recipe.craftingType)} ·{" "}
                            {fmtLookupPct(recipe.outputPct)}%
                          </p>
                          <div className="flex flex-col gap-1 pl-1">
                            {recipe.materials.map((material) => {
                              const matItem = peekItem?.(material.itemKey);
                              return (
                                <ItemLink
                                  key={material.itemKey}
                                  node={{ type: "item", id: material.itemKey }}
                                  name={matItem?.name ?? material.name}
                                  grade={matItem?.grade}
                                  iconPath={matItem?.iconPath}
                                  suffix={material.amount > 1 ? `×${material.amount}` : undefined}
                                  onNavigate={onNavigate}
                                  peekItem={peekItem}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              ) : null}

              {hasDrops ? (
                <div className="flex flex-col gap-2">
                  <SectionLabelRow
                    label={t("drop.label")}
                    help={t("drop.help")}
                    helpLabel={t("drop.helpLabel")}
                  />
                  <Card padding="none" className="overflow-hidden">
                    <DataList scrollable className={SCROLL_SECTION_MAX}>
                      {sortedDrops.map((drop, i) => (
                        <DataListRow key={drop.boxItemKey} index={i}>
                          <ItemLink
                            node={{ type: "box", id: drop.boxItemKey }}
                            name={drop.boxName}
                            grade={drop.grade}
                            iconPath={boxIconPath(drop.boxItemKey)}
                            suffix={`· ${fmtDropPct(drop.dropPct)}%`}
                            onNavigate={onNavigate}
                            peekBox={peekBox}
                          />
                        </DataListRow>
                      ))}
                    </DataList>
                  </Card>
                </div>
              ) : null}

              {hasSynthesis && synthesisModel && synthesisType ? (
                <div className="flex flex-col gap-2">
                  <SectionLabelRow
                    label={t("synthesis.label")}
                    help={t("synthesis.help")}
                    helpLabel={t("synthesis.helpLabel")}
                  />
                  <div className="flex flex-col gap-2">
                    {pathGroups.map((group) => (
                      <SynthesisGradeCard
                        key={`${group.inputGrade}-${group.gradeStep}`}
                        materialAmount={group.materialAmount}
                        inputGrade={group.inputGrade}
                        paths={group.paths}
                        synthesisType={synthesisType}
                        model={synthesisModel}
                        bestPathKey={bestPathKey}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {hasOfferingSources ? (
                <div className="flex flex-col gap-2">
                  <SectionLabelRow
                    label={t("offering.sourceLabel")}
                    help={t("offering.sourceHelp")}
                    helpLabel={t("offering.sourceHelpLabel")}
                  />
                  <Card padding="none" className="overflow-hidden">
                    <DataList scrollable className={SCROLL_SECTION_MAX}>
                      {offeringSources.map((source, i) => {
                        const coinItem = peekItem?.(source.coinKey);
                        return (
                          <DataListRow key={source.coinKey} index={i}>
                            <ItemLink
                              node={{ type: "item", id: source.coinKey }}
                              name={coinItem?.name ?? t("coinFallback", { id: source.coinKey })}
                              grade={coinItem?.grade}
                              iconPath={coinItem?.iconPath}
                              suffix={`· ${fmtDropPct(source.poolPct)}%`}
                              onNavigate={onNavigate}
                              peekItem={peekItem}
                            />
                          </DataListRow>
                        );
                      })}
                    </DataList>
                  </Card>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {hasUsedIn ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <SectionHeadingRow
              label={t("usedIn.label")}
              help={t("usedIn.help")}
              helpLabel={t("usedIn.helpLabel")}
            />
            <div className="flex flex-col gap-3">
              {usedInRecipes.map((entry) => (
                <UsedInRecipeCard
                  key={entry.recipeKey}
                  entry={entry}
                  peekItem={peekItem}
                  onNavigate={onNavigate}
                  outputItemIndex={outputItemIndex}
                />
              ))}
            </div>
          </div>
        ) : null}

        {offering ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <OfferingLoot
              offering={offering}
              onNavigate={onNavigate}
              peekItem={peekItem ?? (() => undefined)}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
