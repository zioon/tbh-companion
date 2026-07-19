import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InventoryColumnId, InventoryTablePrefs } from "../../../../shared/types";
import {
  DEFAULT_VISIBLE_INVENTORY_COLUMNS,
  INVENTORY_COLUMN_IDS,
  normalizeInventoryTablePrefs,
} from "../../../core/inventory/columnPrefs";
import { Popover } from "../../design-system/primitives/Popover/Popover";
import { Button } from "../../design-system/primitives/Button/Button";
import { Checkbox } from "../../design-system/primitives/Checkbox/Checkbox";

export interface InventoryColumnPickerProps {
  prefs: InventoryTablePrefs;
  onChange: (prefs: InventoryTablePrefs) => void;
}

export function InventoryColumnPicker({ prefs, onChange }: InventoryColumnPickerProps) {
  const { t } = useTranslation("inventory");
  const [open, setOpen] = useState(false);
  const normalized = normalizeInventoryTablePrefs(prefs);
  const visible = new Set(normalized.visibleColumns);

  const columnLabels = useMemo(
    () =>
      ({
        grade: t("columns.grade"),
        level: t("columns.level"),
        type: t("columns.type"),
        location: t("columns.location"),
        inUse: t("columns.inUse"),
        marketPrice: t("columns.marketPrice"),
        listValue: t("columns.listValue"),
        instantSell: t("columns.instantSell"),
        instantTotal: t("columns.instantTotal"),
        instantSellAverage: t("columns.instantSellAverage"),
      }) as Record<InventoryColumnId, string>,
    [t],
  );

  function toggle(id: InventoryColumnId, checked: boolean): void {
    const next = checked
      ? [...normalized.visibleColumns, id]
      : normalized.visibleColumns.filter((col) => col !== id);
    onChange(normalizeInventoryTablePrefs({ visibleColumns: next }));
  }

  function reset(): void {
    onChange({ visibleColumns: [...DEFAULT_VISIBLE_INVENTORY_COLUMNS] });
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      aria-label={t("columnPicker.ariaLabel")}
      trigger={
        <Button size="sm" type="button">
          {t("columnPicker.edit")}
        </Button>
      }
    >
      <div className="mb-2 flex flex-col gap-1.5">
        {INVENTORY_COLUMN_IDS.map((id) => (
          <Checkbox
            key={id}
            label={columnLabels[id]}
            checked={visible.has(id)}
            onCheckedChange={(checked) => toggle(id, checked)}
          />
        ))}
      </div>
      <Button size="sm" variant="ghost" className="w-full" onClick={reset}>
        {t("columnPicker.reset")}
      </Button>
    </Popover>
  );
}
