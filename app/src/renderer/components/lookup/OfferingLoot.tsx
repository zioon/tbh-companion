import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { typeLabel } from "../../lib/itemLabels";
import { fmtDropPct } from "../../lib/lookupDisplay";
import { filterAndSortLoot, resolveOfferingLoot } from "../../lib/offeringLootFilters";
import { Card } from "../../design-system/primitives/Card/Card";
import { DataList, DataListRow } from "../../design-system/primitives/DataList/DataList";
import { Input } from "../../design-system/primitives/Input/Input";
import { SectionHeadingRow } from "./itemCardParts";
import { ItemLink } from "../ItemLink";
import type { LookupItem, OfferingEntry } from "../../../../shared/types";
import type { LookupNavNode } from "../../lib/useLookupNav";

export function OfferingLoot({
  offering,
  onNavigate,
  peekItem,
}: {
  offering: OfferingEntry;
  onNavigate?: (node: LookupNavNode) => void;
  peekItem: (id: number) => LookupItem | undefined;
}) {
  const { t } = useTranslation("lookup");
  const [query, setQuery] = useState("");

  const resolved = useMemo(
    () => resolveOfferingLoot(offering.loot, peekItem),
    [offering, peekItem],
  );

  // The loot list is small and always ranked by drop chance — search is the only
  // filter; sort is fixed to drop % descending.
  const filtered = useMemo(
    () =>
      filterAndSortLoot(resolved, {
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
        label={t("offering.lootLabel")}
        help={t("offering.lootHelp")}
        helpLabel={t("offering.lootHelpLabel")}
      />

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
              {t("box.noLootMatchFilters")}
            </DataListRow>
          ) : (
            filtered.map((row, i) => (
              <DataListRow key={row.itemKey} index={i}>
                <ItemLink
                  node={{ type: "item", id: row.itemKey }}
                  name={row.item?.name ?? t("itemFallback", { id: row.itemKey })}
                  grade={row.item?.grade}
                  iconPath={row.item?.iconPath}
                  suffix={`· ${fmtDropPct(row.poolPct)}%${row.item ? ` · ${typeLabel(row.item.type, t)}` : ""}`}
                  onNavigate={onNavigate}
                  peekItem={peekItem}
                />
              </DataListRow>
            ))
          )}
        </DataList>
      </Card>
    </div>
  );
}
