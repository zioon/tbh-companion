import { memo, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { gradeLabel, typeLabel } from "../../lib/itemLabels";
import {
  isInventoryColumnVisible,
  normalizeInventoryTablePrefs,
} from "../../../core/inventory/columnPrefs";
import { formatMoney, formatRawMoney } from "../../../core/steamPrice";
import { unassignedCount } from "../../../core/inventory/location";
import { gradeColor } from "../../lib/gradeColor";
import { useLookupCatalog } from "../../lib/useLookupCatalog";
import { useEntityPanel } from "../../context/entityPanelContext";
import { ItemLink } from "../ItemLink";
import { MarketListingLink } from "./MarketListingLink";
import { MarketPriceCell } from "./MarketPriceCell";
import { ItemPriceRefreshButton } from "./ItemPriceRefreshButton";
import type {
  InventoryColumnId,
  InventoryTablePrefs,
  LookupItem,
  ResolvedInventoryRow,
} from "../../../../shared/types";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { Button } from "../../design-system/primitives/Button/Button";
import { Card } from "../../design-system/primitives/Card/Card";
import { Tooltip } from "../../design-system/primitives/Tooltip/Tooltip";
import { cn } from "../../lib/cn";
import { buyOrderAverage, type SortKey } from "../../lib/inventoryFilters";
import { isUnresolvedLocalizationKey } from "../../lib/lookupFilters";
import type { TFunction } from "i18next";

function priceSourceTitle(
  t: TFunction<"inventory">,
  source: ResolvedInventoryRow["priceSource"],
): string | undefined {
  if (source === "median") return t("priceSource.median");
  if (source === "lowest") return t("priceSource.lowest");
  return undefined;
}

function emptyBuyOrderDisplay(
  t: TFunction<"inventory">,
  row: ResolvedInventoryRow,
): { label: string; title: string } {
  if (row.buyOrderChecked) {
    return {
      label: t("buyOrder.noOrdersLabel"),
      title: t("buyOrder.noOrdersTitle"),
    };
  }
  return {
    label: t("buyOrder.notLoadedLabel"),
    title: t("buyOrder.notLoadedTitle"),
  };
}

export interface InventoryTableProps {
  rows: ResolvedInventoryRow[];
  currency: string;
  columnPrefs: InventoryTablePrefs;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  onClearFilters: () => void;
  emptyMessage?: string;
}

function SortArrow({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return <>{dir === "asc" ? " \u25b2" : " \u25bc"}</>;
}

const thClass =
  "sticky top-0 z-[1] bg-panel px-2.5 py-1.5 text-left text-muted cursor-pointer select-none border-b border-border font-semibold";
const thNumClass = cn(thClass, "text-right");
const tdClass = "px-2.5 py-1.5 border-b border-border";
const tdNumClass = cn(tdClass, "text-right");

type ColumnDef = {
  id: InventoryColumnId | "name" | "count";
  label: string;
  sortKey?: SortKey;
  align: "left" | "right";
  alwaysVisible?: boolean;
  render: (row: ResolvedInventoryRow, currency: string) => ReactNode;
};

function buildColumnDefs(
  t: TFunction<"inventory">,
  itemIndex: Map<number, LookupItem>,
  onNavigate: (itemKey: number) => void,
): ColumnDef[] {
  return [
    {
      id: "name",
      label: t("columns.name"),
      sortKey: "name",
      align: "left",
      alwaysVisible: true,
      render: (row) => {
        const catalogItem = itemIndex.get(row.itemKey);
        // row.name comes from the runtime-extracted gamedata.json (CatalogRefreshService).
        // When the EN stringtable lacks an ItemName_<id> entry, the extractor falls back
        // to the literal placeholder. Fall back to the bundled lookup_items.json name
        // (same source the tooltip uses via useLookupCatalog) so the row matches.
        const displayName =
          isUnresolvedLocalizationKey(row.name) && catalogItem?.name ? catalogItem.name : row.name;
        const suffix = row.chaoticCount > 0 ? "◆" : undefined;
        const refreshButton = row.marketHashName ? (
          <ItemPriceRefreshButton itemKey={row.itemKey} itemName={displayName} />
        ) : null;

        if (catalogItem) {
          return (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <ItemLink
                node={{ type: "item", id: row.itemKey }}
                name={displayName}
                grade={row.grade}
                iconPath={catalogItem.iconPath}
                suffix={suffix}
                onNavigate={() => onNavigate(row.itemKey)}
                peekItem={(id) => itemIndex.get(id)}
              />
              {refreshButton}
            </span>
          );
        }

        return (
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <span
              className="mr-1 inline-block size-[9px] shrink-0 rounded-full"
              style={{ background: gradeColor(row.grade) }}
            />
            <span className="min-w-0 truncate">{displayName}</span>
            {row.chaoticCount > 0 && (
              <Tooltip trigger={<span className="shrink-0 cursor-help text-gold"> &#9670;</span>}>
                {t("chaotic")}
              </Tooltip>
            )}
            {refreshButton}
          </span>
        );
      },
    },
    {
      id: "grade",
      label: t("columns.grade"),
      sortKey: "grade",
      align: "left",
      render: (row) => (
        <span style={{ color: gradeColor(row.grade) }}>{gradeLabel(row.grade, t)}</span>
      ),
    },
    {
      id: "level",
      label: t("columns.level"),
      sortKey: "level",
      align: "right",
      render: (row) => (row.level != null ? row.level : <span className="text-muted">-</span>),
    },
    {
      id: "type",
      label: t("columns.type"),
      sortKey: "type",
      align: "left",
      render: (row) => <span className="text-muted">{typeLabel(row.type, t)}</span>,
    },
    {
      id: "count",
      label: t("columns.count"),
      sortKey: "count",
      align: "right",
      alwaysVisible: true,
      render: (row) => row.count,
    },
    {
      id: "location",
      label: t("columns.location"),
      align: "right",
      render: (row) => {
        const inUse = row.inUseCount ?? 0;
        return (
          <>
            {(row.inventoryCount ?? 0) > 0 && (
              <Tooltip
                underline
                trigger={
                  <span className="mr-1.5 inline-block text-[11px] text-muted">
                    {t("locationCell.inv", { count: row.inventoryCount })}
                  </span>
                }
              >
                {t("location.inventory")}
              </Tooltip>
            )}
            {(row.stashCount ?? 0) > 0 && (
              <Tooltip
                underline
                trigger={
                  <span className="mr-1.5 inline-block text-[11px] text-muted">
                    {t("locationCell.stash", { count: row.stashCount })}
                  </span>
                }
              >
                {t("location.stash")}
              </Tooltip>
            )}
            {(row.tradingCount ?? 0) > 0 && (
              <Tooltip
                underline
                trigger={
                  <span className="mr-1.5 inline-block text-[11px] text-muted">
                    {t("locationCell.trading", { count: row.tradingCount })}
                  </span>
                }
              >
                {t("location.trading")}
              </Tooltip>
            )}
            {inUse > 0 && (
              <Tooltip
                underline
                trigger={
                  <span className="mr-1.5 inline-block text-[11px] text-muted">
                    {t("locationCell.equipped", { count: inUse })}
                  </span>
                }
              >
                {t("location.equipped")}
              </Tooltip>
            )}
            {unassignedCount(row) > 0 && (
              <Tooltip
                underline
                trigger={<span className="mr-1.5 inline-block text-[11px] text-muted">?</span>}
              >
                {t("locationCell.unassignedTitle")}
              </Tooltip>
            )}
          </>
        );
      },
    },
    {
      id: "inUse",
      label: t("columns.inUse"),
      sortKey: "inUse",
      align: "right",
      render: (row) => {
        const inUse = row.inUseCount ?? 0;
        if (inUse <= 0) return <span className="text-muted">-</span>;
        const title =
          inUse < row.count
            ? t("inUse.someEquipped", { inUse, count: row.count })
            : t("inUse.allEquipped");
        return (
          <Tooltip
            underline
            trigger={
              <span className="text-accent">
                {inUse}
                {inUse < row.count ? `/${row.count}` : ""}
              </span>
            }
          >
            {title}
          </Tooltip>
        );
      },
    },
    {
      id: "marketPrice",
      label: t("columns.marketPrice"),
      sortKey: "price",
      align: "right",
      render: (row, currency) => {
        if (!row.marketHashName) {
          return (
            <Tooltip underline trigger={<span className="text-muted">-</span>}>
              {t("marketPrice.notPricedTitle")}
            </Tooltip>
          );
        }
        return <MarketPriceCell row={row} hash={row.marketHashName} currency={currency} />;
      },
    },
    {
      id: "listValue",
      label: t("columns.listValue"),
      sortKey: "value",
      align: "right",
      render: (row, currency) => {
        if (!row.marketHashName) return "-";
        const sourceTitle = priceSourceTitle(t, row.priceSource);
        return (
          <MarketListingLink
            hash={row.marketHashName}
            title={
              row.value != null && Number.isFinite(row.value)
                ? `${sourceTitle ?? t("priceSource.default")} · ${t("marketPrice.totalIfListed")}`
                : t("marketPrice.openOnSteam")
            }
          >
            {row.value != null && Number.isFinite(row.value)
              ? formatMoney(row.value, currency)
              : "-"}
          </MarketListingLink>
        );
      },
    },
    {
      id: "instantSell",
      label: t("columns.instantSell"),
      sortKey: "buyOrder",
      align: "right",
      render: (row, currency) => {
        if (!row.marketHashName) return "-";
        const empty = emptyBuyOrderDisplay(t, row);
        if (row.buyOrderRaw) {
          const display = formatRawMoney(row.buyOrderRaw, currency) ?? row.buyOrderRaw;
          return (
            <MarketListingLink hash={row.marketHashName} title={t("buyOrder.highestTitle")}>
              {display}
            </MarketListingLink>
          );
        }
        return (
          <MarketListingLink hash={row.marketHashName} title={empty.title}>
            <span className="text-muted">{empty.label}</span>
          </MarketListingLink>
        );
      },
    },
    {
      id: "instantTotal",
      label: t("columns.instantTotal"),
      sortKey: "buyOrderValue",
      align: "right",
      render: (row, currency) => {
        if (!row.marketHashName) return "-";
        const covered = row.buyOrderCoveredCount ?? 0;
        const capped = row.buyOrderValue != null && covered < row.count;
        const title = capped
          ? t("instantTotal.cappedTitle", {
              covered: covered.toLocaleString(),
              count: row.count.toLocaleString(),
            })
          : t("instantTotal.defaultTitle");
        return (
          <MarketListingLink hash={row.marketHashName} title={title}>
            {row.buyOrderValue != null && Number.isFinite(row.buyOrderValue)
              ? formatMoney(row.buyOrderValue, currency)
              : "-"}
            {capped ? (
              <Badge variant="muted" className="ml-1.5">
                {covered.toLocaleString()} / {row.count.toLocaleString()}
              </Badge>
            ) : null}
          </MarketListingLink>
        );
      },
    },
    {
      id: "instantSellAverage",
      label: t("columns.instantSellAverage"),
      sortKey: "buyOrderAverage",
      align: "right",
      render: (row, currency) => {
        if (!row.marketHashName) return "-";
        const average = buyOrderAverage(row);
        return (
          <MarketListingLink hash={row.marketHashName} title={t("buyOrder.averageTitle")}>
            {average != null && Number.isFinite(average) ? formatMoney(average, currency) : "-"}
          </MarketListingLink>
        );
      },
    },
  ]; // end buildColumnDefs
}

function visibleColumns(defs: ColumnDef[], prefs: InventoryTablePrefs): ColumnDef[] {
  const normalized = normalizeInventoryTablePrefs(prefs);
  return defs.filter((col) => {
    if (col.alwaysVisible) return true;
    return isInventoryColumnVisible(normalized, col.id as InventoryColumnId);
  });
}

const InventoryRow = memo(function InventoryRow({
  row,
  currency,
  columns,
}: {
  row: ResolvedInventoryRow;
  currency: string;
  columns: ColumnDef[];
}) {
  return (
    <tr
      className={cn(
        "hover:bg-card [content-visibility:auto] [contain-intrinsic-size:0_36px]",
        !row.known && "opacity-70",
      )}
    >
      {columns.map((col) => (
        <td key={col.id} className={col.align === "right" ? tdNumClass : tdClass}>
          {col.render(row, currency)}
        </td>
      ))}
    </tr>
  );
});

export function InventoryTable({
  rows,
  currency,
  columnPrefs,
  sortKey,
  sortDir,
  onSort,
  onClearFilters,
  emptyMessage,
}: InventoryTableProps) {
  const { t } = useTranslation("inventory");
  const catalog = useLookupCatalog();
  const { open } = useEntityPanel();
  const itemIndex = useMemo(
    () => new Map((catalog ?? []).map((item) => [item.id, item])),
    [catalog],
  );
  const columnDefs = useMemo(
    () => buildColumnDefs(t, itemIndex, (id) => open({ type: "item", id })),
    [t, itemIndex, open],
  );
  const columns = useMemo(() => visibleColumns(columnDefs, columnPrefs), [columnDefs, columnPrefs]);
  const effectiveEmptyMessage = emptyMessage ?? t("emptyMessage");

  return (
    <Card padding="none" className="min-h-[200px] flex-1 overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {columns.map((col) => {
              const th = col.align === "right" ? thNumClass : thClass;
              const clickable = col.sortKey != null;
              return (
                <th
                  key={col.id}
                  className={cn(th, !clickable && "cursor-default")}
                  onClick={col.sortKey ? () => onSort(col.sortKey!) : undefined}
                >
                  {col.label}
                  {col.sortKey ? (
                    <SortArrow active={sortKey === col.sortKey} dir={sortDir} />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
                {effectiveEmptyMessage}{" "}
                <Button size="sm" className="ml-1.5" onClick={onClearFilters}>
                  {t("clearFilters")}
                </Button>
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <InventoryRow key={row.itemKey} row={row} currency={currency} columns={columns} />
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}
