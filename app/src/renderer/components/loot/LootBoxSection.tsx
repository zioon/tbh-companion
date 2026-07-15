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

export function LootBoxSection({
  stats,
  onReset,
}: {
  stats: BoxOpenStats;
  onReset: (boxKey: string) => void;
}) {
  const [filter, setFilter] = useState<LootFilterState>(DEFAULT_LOOT_FILTER_STATE);
  const [confirming, setConfirming] = useState(false);

  const rows = filterAndSortLoot(stats.breakdown, filter);
  const gradeOptions = gradeOptionsFromLoot(stats.breakdown);
  const gradeSelectOptions: MultiSelectOption[] = gradeOptions.map((g) => ({ value: g, label: g }));

  const columns = [
    { label: "Item" },
    { label: "Count", align: "right" as const, width: "64px" },
    { label: "Drop%", align: "right" as const, width: "72px" },
    { label: "Buyout", align: "right" as const, width: "96px" },
    { label: "Hourly", align: "right" as const, width: "104px" },
  ];

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
            cells={[
              { content: row.name },
              { content: String(row.count), align: "right" },
              { content: fmtPct(row.dropPct), align: "right" },
              { content: fmtGold(row.buyOrderUnit), align: "right" },
              { content: fmtGoldPerHour(row.hourlyValue), align: "right" },
            ]}
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
            <DialogTitle className="m-0 text-base font-semibold">
              Reset {stats.label}?
            </DialogTitle>
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
