// Web shell: Trading page.
//
// The desktop Trading tab depends on a local, continuously-polled price-history
// store which the web build has no equivalent of. The web page instead reads the
// same catalog the Lookup tab uses, keeps only tradable items
// (`marketHashName() != null`), and shows each one's latest Steam Market listing
// price from the same-origin snapshot.
//
// The catalog always renders; only the price column degrades. When the snapshot
// is *missing* (404 / network error / bad shape) a yellow banner appears; while
// it is still *loading* it does not.
//
// Filters mirror the Lookup tab's control language (type checkboxes + grade
// MultiSelect + search + SortControl) with one trading-specific toggle: priced
// only. Sort comparators intentionally match `filterAndSortItems` (GRADE_RANK
// for grade, itemDescriptor for type) so both pages order identically; the
// price sort pins unpriced rows to the bottom regardless of direction.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GRADE_RANK } from "../../core/grades";
import { resolveLookupPrice } from "../../core/lookupPrice";
import { marketHashName } from "../../core/marketName";
import { useLookupCatalog } from "../../renderer/lib/useLookupCatalog";
import { useEntityPanel } from "../../renderer/context/entityPanelContext";
import { ItemLink } from "../../renderer/components/ItemLink";
import { gradeColor } from "../../renderer/lib/gradeColor";
import { gradeLabel, typeLabel } from "../../renderer/lib/itemLabels";
import { gradeOptionsFromItems, typeOptionsFromItems } from "../../renderer/lib/lookupFilters";
import { itemDescriptor } from "../../renderer/lib/lookupDisplay";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { TabHeader } from "../../renderer/design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../../renderer/design-system/primitives/TabPage/TabPage";
import { Input } from "../../renderer/design-system/primitives/Input/Input";
import { Checkbox } from "../../renderer/design-system/primitives/Checkbox/Checkbox";
import { MultiSelect } from "../../renderer/design-system/primitives/MultiSelect/MultiSelect";
import { SortControl } from "../../renderer/components/filters/SortControl";
import type { SelectOption } from "../../renderer/design-system/primitives/Select/Select";
import { useWebPrices } from "../lib/useWebPrices";
import { useWebRuntime } from "../lib/useWebRuntime";
import { MissingPricesBanner } from "../components/MissingPricesBanner";

type TradingSortKey = "price" | "name" | "grade" | "type";

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="none" className="flex flex-col gap-1.5 p-4">
      <span className="text-[10.5px] font-medium tracking-[0.06em] uppercase text-muted">
        {label}
      </span>
      <span className="font-mono text-[26px] leading-none font-medium tabular-nums text-accent">
        {value}
      </span>
    </Card>
  );
}

const FILTER_LABEL = "text-[10px] font-medium uppercase tracking-wide text-muted";

function defaultSortDir(key: TradingSortKey): "asc" | "desc" {
  return key === "grade" || key === "price" ? "desc" : "asc";
}

export function TradingPanel() {
  const { t, i18n } = useTranslation("web");
  const { t: tTabs } = useTranslation("tabs");
  const { t: tLookup } = useTranslation("lookup");
  const catalog = useLookupCatalog();
  const { snapshot } = useWebPrices();
  const runtime = useWebRuntime();

  // The user's display currency, not the snapshot's base: `resolveLookupPrice`
  // converts through the snapshot's FX table, so every row and KPI follows the
  // header switcher.
  const currency = runtime.currency;

  // Filter state — mirrors the Lookup tab's shape, minus lookup-only facets
  // (gear/material/effect/level/plague/watched) that make no sense here.
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [gradeFilter, setGradeFilter] = useState<string[]>([]);
  const [pricedOnly, setPricedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<TradingSortKey>("price");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Tradable catalog rows, each resolved against the snapshot (unfiltered —
  // the KPIs always describe the whole tradable set).
  const priceable = useMemo(
    () => (catalog ?? []).filter((item) => marketHashName(item) != null),
    [catalog],
  );
  const allRows = useMemo(
    () =>
      priceable.map((item) => ({
        item,
        price: resolveLookupPrice(item, snapshot, currency),
      })),
    [priceable, snapshot, currency],
  );

  const typeOptions = useMemo(() => typeOptionsFromItems(priceable), [priceable]);
  const gradeOptions = useMemo(() => gradeOptionsFromItems(priceable), [priceable]);

  // Filtered + sorted view. Sort comparators mirror `filterAndSortItems`:
  // GRADE_RANK for grade, itemDescriptor for type, name tie-break — except the
  // price key, which pins unpriced rows to the bottom in both directions.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allRows.filter(({ item, price }) => {
      if (typeFilter.length > 0 && !typeFilter.includes(item.type)) return false;
      if (gradeFilter.length > 0 && !gradeFilter.includes(item.grade)) return false;
      if (pricedOnly && price.state !== "priced") return false;
      if (q && !item.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "price") {
        const aUsd = a.price.usd;
        const bUsd = b.price.usd;
        if (aUsd == null && bUsd == null) return a.item.name.localeCompare(b.item.name);
        if (aUsd == null) return 1;
        if (bUsd == null) return -1;
        const cmp = aUsd - bUsd;
        return cmp !== 0 ? cmp * dir : a.item.name.localeCompare(b.item.name);
      }
      let cmp: number;
      if (sortKey === "name") cmp = a.item.name.localeCompare(b.item.name);
      else if (sortKey === "grade") {
        cmp = (GRADE_RANK[a.item.grade] ?? -1) - (GRADE_RANK[b.item.grade] ?? -1);
      } else cmp = itemDescriptor(a.item).localeCompare(itemDescriptor(b.item));
      if (cmp === 0 && sortKey !== "name") cmp = a.item.name.localeCompare(b.item.name);
      return cmp * dir;
    });
  }, [allRows, query, typeFilter, gradeFilter, pricedOnly, sortKey, sortDir]);

  const priced = allRows.filter((row) => row.price.state === "priced").length;
  const coverage = allRows.length > 0 ? Math.round((priced / allRows.length) * 100) : 0;

  const sortOptions = useMemo<SelectOption[]>(
    () => [
      { value: "price", label: t("trading.sortPrice") },
      { value: "name", label: tLookup("sort.name") },
      { value: "grade", label: tLookup("sort.grade") },
      { value: "type", label: tLookup("sort.type") },
    ],
    [t, tLookup],
  );

  // Feeds the hover peek card on the item link, same as the Lookup tab.
  const itemIndex = useMemo(
    () => new Map((catalog ?? []).map((item) => [item.id, item])),
    [catalog],
  );
  const peekItem = useCallback((id: number) => itemIndex.get(id), [itemIndex]);
  const { open } = useEntityPanel();

  const updatedLabel = useMemo(() => {
    if (!snapshot?.generatedUtc) return t("trading.updatedUnknown");
    const date = new Date(snapshot.generatedUtc);
    if (Number.isNaN(date.getTime())) return t("trading.updatedUnknown");
    return t("trading.updatedAt", { time: date.toLocaleString(i18n.language) });
  }, [snapshot, t, i18n.language]);

  function toggleType(value: string, checked: boolean) {
    setTypeFilter((prev) => (checked ? [...prev, value] : prev.filter((tp) => tp !== value)));
  }

  function changeSortKey(key: string) {
    const next = key as TradingSortKey;
    setSortKey(next);
    setSortDir(defaultSortDir(next));
  }

  return (
    <TabPage className="gap-5">
      <TabHeader title={tTabs("trading")} intro={t("trading.intro")} />

      <MissingPricesBanner />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label={t("trading.kpiTradable")} value={allRows.length.toLocaleString()} />
        <Kpi label={t("trading.kpiPriced")} value={priced.toLocaleString()} />
        <Kpi label={t("trading.kpiCoverage")} value={`${coverage}%`} />
      </div>

      <p className="m-0 text-xs text-muted">{updatedLabel}</p>

      {allRows.length === 0 ? (
        <Card padding="none" className="p-4 text-muted">
          {t("trading.empty")}
        </Card>
      ) : (
        <>
          <Card padding="none" className="flex flex-col gap-3 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className={FILTER_LABEL}>{tLookup("filters.itemType")}</span>
                <div className="flex items-center gap-3 py-1.5">
                  {typeOptions.map((type) => (
                    <Checkbox
                      key={type}
                      label={typeLabel(type, tLookup)}
                      checked={typeFilter.includes(type)}
                      onCheckedChange={(checked) => toggleType(type, checked)}
                    />
                  ))}
                </div>
              </div>
              <MultiSelect
                className="w-40"
                label={tLookup("filters.grade")}
                allLabel={tLookup("filters.allGrades")}
                value={gradeFilter}
                onValueChange={setGradeFilter}
                options={gradeOptions.map((g) => ({
                  value: g,
                  label: gradeLabel(g, tLookup),
                  color: gradeColor(g),
                }))}
              />
            </div>
            <div className="flex items-center gap-3">
              <SortControl
                options={sortOptions}
                sortKey={sortKey}
                onSortKeyChange={changeSortKey}
                sortDir={sortDir}
                onSortDirToggle={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              />
              <Input
                className="min-w-0 flex-1"
                placeholder={tLookup("filters.searchItems")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted">
                <Checkbox
                  checked={pricedOnly}
                  onCheckedChange={(c) => setPricedOnly(c)}
                  aria-label={t("trading.filtersPricedOnly")}
                />
                <span>{t("trading.filtersPricedOnly")}</span>
              </label>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted">
                {tLookup("filters.itemsCount", { count: rows.length })}
              </span>
            </div>
          </Card>

          {rows.length === 0 ? (
            <Card padding="none" className="p-4 text-muted">
              {t("trading.filtersEmpty")}
            </Card>
          ) : (
            <Card padding="none" className="overflow-hidden">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-panel text-left text-muted">
                    <th className="px-4 py-3 font-medium">{t("trading.colItem")}</th>
                    <th className="px-4 py-3 font-medium">{t("trading.colType")}</th>
                    <th className="px-4 py-3 font-medium">{t("trading.colGrade")}</th>
                    <th className="px-4 py-3 text-right font-medium">{t("trading.colPrice")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ item, price }) => (
                    <tr key={item.id} className="border-t border-border-soft">
                      <td className="px-4 py-2.5">
                        {/* Same entity link the Lookup tab uses: click opens the
                            side detail panel, hover shows the mini item card. The
                            panel degrades gracefully where web data is absent. */}
                        <ItemLink
                          node={{ type: "item", id: item.id }}
                          name={item.name}
                          grade={item.grade}
                          iconPath={item.iconPath}
                          onNavigate={open}
                          peekItem={peekItem}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-muted">{typeLabel(item.type, tLookup)}</td>
                      <td className="px-4 py-2.5" style={{ color: gradeColor(item.grade) }}>
                        {gradeLabel(item.grade, tLookup)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {price.display ?? <span className="text-muted">{t("trading.never")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </TabPage>
  );
}
