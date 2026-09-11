import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { typeLabel } from "../../lib/itemLabels";
import { fmtDropPct } from "../../lib/lookupDisplay";
import { filterAndSortBoxLoot, resolveBoxLoot } from "../../lib/boxLootFilters";
import { boxExpectedValue } from "../../../core/lookup/boxDisplay";
import { isAccessoryItem, synthesisPointsForItemKey } from "../../../core/synthesisPoints";
import { useMaterialSynthesisPoints } from "../../lib/useMaterialSynthesisPoints";
import { useLookupPrices } from "../../lib/useLookupPrices";
import { formatMoney } from "../../../core/steamPrice";
import { Card } from "../../design-system/primitives/Card/Card";
import { DataList, DataListRow } from "../../design-system/primitives/DataList/DataList";
import { Input } from "../../design-system/primitives/Input/Input";
import { SectionHeadingRow, StatGroup } from "./itemCardParts";
import { ItemLink } from "../ItemLink";
import type { LookupBoxDrop, LookupItem } from "../../../../shared/types";
import type { LookupNavNode } from "../../lib/useLookupNav";

/** Compact合成点数（按当前语言进 万/亿/K/M/B）。null → "—"。 */
function fmtPoints(value: number | null, language: string | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** 一条内容物的单件合成点数：特殊材料按「对应 ACT 箱/offer 清单」覆盖值，否则按物品（饰品判 gearGroup）品质。未知 → null。 */
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

export function BoxLoot({
  drops,
  onNavigate,
  peekItem,
}: {
  drops: LookupBoxDrop[];
  onNavigate?: (node: LookupNavNode) => void;
  peekItem: (id: number) => LookupItem | undefined;
}) {
  const { t, i18n } = useTranslation("lookup");
  const language = i18n.resolvedLanguage ?? undefined;
  const { resolve, currency } = useLookupPrices();
  const materialPoints = useMaterialSynthesisPoints();
  const [query, setQuery] = useState("");

  const resolved = useMemo(() => resolveBoxLoot(drops, peekItem), [drops, peekItem]);

  const expected = useMemo(
    () =>
      boxExpectedValue(drops, (itemKey) => {
        const item = peekItem(itemKey);
        return item ? resolve(item).amount : null;
      }),
    [drops, peekItem, resolve],
  );

  const expectedPoints = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const drop of drops) {
      const unit = dropUnitPoints(drop, peekItem(drop.itemKey), materialPoints);
      if (unit == null) continue;
      any = true;
      sum += (drop.dropPct / 100) * unit;
    }
    return any ? sum : null;
  }, [drops, peekItem, materialPoints]);

  const filtered = useMemo(
    () =>
      filterAndSortBoxLoot(resolved, {
        query,
        gradeFilter: [],
        typeFilter: [],
        sortKey: "dropPct",
        sortDir: "desc",
      }),
    [resolved, query],
  );

  return (
    <div className="flex flex-col gap-2">
      <SectionHeadingRow
        label={t("box.lootLabel")}
        help={t("box.lootHelp")}
        helpLabel={t("box.lootHelpLabel")}
      />

      {expected.value != null ? (
        <StatGroup
          title={t("box.expectedValue")}
          tone="base"
          rows={[
            { display: formatMoney(expected.value, currency) },
            {
              display: t("box.valueCoverage", {
                priced: expected.pricedCount,
                total: expected.totalCount,
              }),
            },
          ]}
        />
      ) : expected.pricedCount === 0 && expected.totalCount > 0 ? (
        <StatGroup
          title={t("box.expectedValue")}
          tone="base"
          rows={[{ display: t("box.noMarketValue") }]}
        />
      ) : null}

      {expectedPoints != null && (
        <StatGroup
          title={t("box.expectedSynthesisPoints")}
          tone="base"
          rows={[{ display: fmtPoints(expectedPoints, language) }]}
        />
      )}

      <div className="flex items-center gap-3">
        <Input
          className="min-w-0 flex-1"
          placeholder={t("box.searchLoot")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="shrink-0 whitespace-nowrap text-xs text-muted">
          {t("box.itemsCount", { count: filtered.length })}
        </span>
      </div>

      <Card padding="none" className="overflow-hidden">
        <DataList scrollable className="max-h-64">
          {filtered.length === 0 ? (
            <DataListRow index={0} className="text-xs text-muted">
              {t("box.noLootMatch")}
            </DataListRow>
          ) : (
            filtered.map((row, i) => {
              const price = row.item ? resolve(row.item) : null;
              const priced = price != null && price.state === "priced";
              const unitPoints = dropUnitPoints(row, row.item, materialPoints);
              return (
                <DataListRow key={row.itemKey} index={i}>
                  <div className="flex w-full items-center justify-between gap-2">
                    <ItemLink
                      node={{ type: "item", id: row.itemKey }}
                      name={row.item?.name ?? row.name}
                      grade={row.item?.grade ?? row.grade}
                      iconPath={row.item?.iconPath}
                      suffix={`· ${fmtDropPct(row.dropPct)}%${row.item ? ` · ${typeLabel(row.item.type, t)}` : ""}`}
                      onNavigate={onNavigate}
                      peekItem={peekItem}
                    />
                    <div className="flex shrink-0 items-center gap-2.5">
                      {unitPoints != null ? (
                        <span className="whitespace-nowrap text-[12px] tabular-nums text-muted">
                          {t("box.synthesisPointsShort", {
                            value: fmtPoints(unitPoints, language),
                          })}
                        </span>
                      ) : null}
                      {priced && price ? (
                        <span className="whitespace-nowrap text-[12px] tabular-nums text-accent">
                          {price.display}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </DataListRow>
              );
            })
          )}
        </DataList>
      </Card>
    </div>
  );
}
