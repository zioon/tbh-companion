import { useState } from "react";
import type { BoxOpenStats } from "../../../../shared/types";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { Button } from "../../design-system/primitives/Button/Button";
import { Card } from "../../design-system/primitives/Card/Card";
import { DataTable, DataTableRow } from "../../design-system/primitives/DataTable/DataTable";
import { Dialog } from "../../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../../design-system/primitives/Dialog/DialogParts";
import { Input } from "../../design-system/primitives/Input/Input";
import {
  MultiSelect,
  type MultiSelectOption,
} from "../../design-system/primitives/MultiSelect/MultiSelect";
import { Select, type SelectOption } from "../../design-system/primitives/Select/Select";
import {
  DEFAULT_LOOT_FILTER_STATE,
  filterAndSortLoot,
  gradeOptionsFromLoot,
  type LootFilterState,
} from "../../lib/lootFilters";

function fmtPct(pct: number): string {
  return `${(pct * 100).toFixed(1)}%`;
}

function fmtGold(value: number | null): string {
  if (value == null) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function fmtGoldPerHour(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value).toLocaleString("en-US")}/h`;
}

const RECLASSIFY_CATEGORY_OPTIONS: SelectOption[] = [
  { value: "common", label: "Common" },
  { value: "rare", label: "Stage boss" },
  { value: "act", label: "Act boss" },
];

interface ReclassifyRowState {
  category: string;
  level: string;
}

export function LootBoxSection({
  stats,
  onReset,
  onReclassify,
}: {
  stats: BoxOpenStats;
  onReset: (boxKey: string) => void;
  onReclassify?: (itemKey: number, fromBoxKey: string, toBoxKey: string) => void;
}) {
  const [filter, setFilter] = useState<LootFilterState>(DEFAULT_LOOT_FILTER_STATE);
  const [confirming, setConfirming] = useState(false);
  const [reclassifyState, setReclassifyState] = useState<Record<number, ReclassifyRowState>>({});

  const rows = filterAndSortLoot(stats.breakdown, filter);
  const gradeOptions = gradeOptionsFromLoot(stats.breakdown);
  const gradeSelectOptions: MultiSelectOption[] = gradeOptions.map((g) => ({ value: g, label: g }));
  const isUnclassified = stats.category === "unclassified" && onReclassify;

  const columns = isUnclassified
    ? [
        { label: "Item" },
        { label: "Count", align: "right" as const, width: "64px" },
        { label: "Drop%", align: "right" as const, width: "72px" },
        { label: "Buyout", align: "right" as const, width: "96px" },
        { label: "Assign to", align: "center" as const, width: "200px" },
      ]
    : [
        { label: "Item" },
        { label: "Count", align: "right" as const, width: "64px" },
        { label: "Drop%", align: "right" as const, width: "72px" },
        { label: "Buyout", align: "right" as const, width: "96px" },
        { label: "Hourly", align: "right" as const, width: "104px" },
      ];

  function getReclassifyRow(itemKey: number): ReclassifyRowState {
    return reclassifyState[itemKey] ?? { category: "common", level: "" };
  }

  function setReclassifyRow(itemKey: number, patch: Partial<ReclassifyRowState>): void {
    setReclassifyState((prev) => ({
      ...prev,
      [itemKey]: { ...getReclassifyRow(itemKey), ...patch },
    }));
  }

  function handleAssign(itemKey: number): void {
    const state = getReclassifyRow(itemKey);
    const levelNum = Number.parseInt(state.level, 10);
    const toBoxKey =
      Number.isFinite(levelNum) && levelNum > 0
        ? `${state.category}:${levelNum}`
        : state.category;
    onReclassify?.(itemKey, stats.boxKey, toBoxKey);
    setReclassifyState((prev) => {
      const next = { ...prev };
      delete next[itemKey];
      return next;
    });
  }

  return (
    <Card padding="default" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-sm font-semibold">{stats.label}</h2>
          <Badge variant="muted">{stats.totalOpens} opens</Badge>
          {stats.hourlyValue != null && (
            <Badge variant="info">{fmtGoldPerHour(stats.hourlyValue)}</Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Reset
        </Button>
      </div>

      {isUnclassified && (
        <p className="m-0 text-xs text-muted">
          Box type couldn't be read from memory. Assign each item to a chest category to include it
          in the stats.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Input
          className="min-w-0 flex-1"
          placeholder="Search items..."
          value={filter.query}
          onChange={(e) => setFilter({ ...filter, query: e.target.value })}
        />
        {gradeSelectOptions.length > 0 && (
          <MultiSelect
            className="w-40"
            label="Grade"
            allLabel="All grades"
            value={filter.gradeFilter}
            onValueChange={(value) => setFilter({ ...filter, gradeFilter: value })}
            options={gradeSelectOptions}
          />
        )}
      </div>

      <DataTable columns={columns} maxHeight="320px">
        {rows.map((row, i) => (
          <DataTableRow
            key={row.itemKey}
            index={i}
            cells={
              isUnclassified
                ? [
                    { content: row.name },
                    { content: String(row.count), align: "right" },
                    { content: fmtPct(row.dropPct), align: "right" },
                    { content: fmtGold(row.buyOrderUnit), align: "right" },
                    {
                      content: (
                        <div className="flex items-center gap-1">
                          <Select
                            className="min-w-0 flex-1"
                            triggerClassName="py-1 text-xs"
                            options={RECLASSIFY_CATEGORY_OPTIONS}
                            value={getReclassifyRow(row.itemKey).category}
                            onValueChange={(v) =>
                              setReclassifyRow(row.itemKey, { category: String(v) })
                            }
                          />
                          <Input
                            className="w-12 text-xs"
                            placeholder="Lv"
                            value={getReclassifyRow(row.itemKey).level}
                            onChange={(e) =>
                              setReclassifyRow(row.itemKey, { level: e.target.value })
                            }
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAssign(row.itemKey)}
                          >
                            Assign
                          </Button>
                        </div>
                      ),
                      align: "center",
                    },
                  ]
                : [
                    { content: row.name },
                    { content: String(row.count), align: "right" },
                    { content: fmtPct(row.dropPct), align: "right" },
                    { content: fmtGold(row.buyOrderUnit), align: "right" },
                    { content: fmtGoldPerHour(row.hourlyValue), align: "right" },
                  ]
            }
          />
        ))}
      </DataTable>

      {confirming && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <DialogTitle className="m-0 text-base font-semibold">Reset {stats.label}?</DialogTitle>
            <p className="m-0 text-sm text-muted">
              This clears all recorded opens and history for this box. The session timer is not
              affected. This cannot be undone.
            </p>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <DialogClose
                render={
                  <Button
                    variant="danger"
                    onClick={() => {
                      onReset(stats.boxKey);
                      setConfirming(false);
                    }}
                  >
                    Reset
                  </Button>
                }
              />
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
