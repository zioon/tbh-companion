import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { gradeLabel, typeLabel } from "../../../core/labels";
import type { LocationFilter, SortKey } from "../../lib/inventoryFilters";
import { Input } from "../../design-system/primitives/Input/Input";
import { Checkbox } from "../../design-system/primitives/Checkbox/Checkbox";
import {
  MultiSelect,
  type MultiSelectOption,
} from "../../design-system/primitives/MultiSelect/MultiSelect";
import { Tooltip } from "../../design-system/primitives/Tooltip/Tooltip";

export interface InventoryFiltersProps {
  query: string;
  tradableOnly: boolean;
  unequippedOnly: boolean;
  gradeFilter: string[];
  typeFilter: string[];
  locationFilter: LocationFilter[];
  gradeOptions: string[];
  typeOptions: string[];
  shownCount: number;
  columnPicker?: ReactNode;
  onQueryChange: (q: string) => void;
  onTradableOnlyChange: (v: boolean) => void;
  onUnequippedOnlyChange: (v: boolean) => void;
  onGradeFilterChange: (g: string[]) => void;
  onTypeFilterChange: (t: string[]) => void;
  onLocationFilterChange: (l: LocationFilter[]) => void;
}

export function InventoryFilters({
  query,
  tradableOnly,
  unequippedOnly,
  gradeFilter,
  typeFilter,
  locationFilter,
  gradeOptions,
  typeOptions,
  shownCount,
  columnPicker,
  onQueryChange,
  onTradableOnlyChange,
  onUnequippedOnlyChange,
  onGradeFilterChange,
  onTypeFilterChange,
  onLocationFilterChange,
}: InventoryFiltersProps) {
  const { t } = useTranslation("inventory");

  const locationOptions: MultiSelectOption[] = useMemo(
    () => [
      { value: "inventory", label: t("location.inventory") },
      { value: "stash", label: t("location.stash") },
      { value: "trading", label: t("location.trading") },
      { value: "equipped", label: t("location.equipped") },
      { value: "unknown", label: t("location.unknown") },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <MultiSelect
          className="w-40"
          label={t("filters.grade")}
          allLabel={t("filters.allGrades")}
          value={gradeFilter}
          onValueChange={onGradeFilterChange}
          options={gradeOptions.map((g) => ({ value: g, label: gradeLabel(g) }))}
        />
        <MultiSelect
          className="w-40"
          label={t("filters.itemType")}
          allLabel={t("filters.allItemTypes")}
          searchable={false}
          value={typeFilter}
          onValueChange={onTypeFilterChange}
          options={typeOptions.map((tp) => ({ value: tp, label: typeLabel(tp) }))}
        />
        <MultiSelect
          className="w-40"
          label={t("filters.location")}
          allLabel={t("filters.allLocations")}
          searchable={false}
          value={locationFilter}
          onValueChange={(value) => onLocationFilterChange(value as LocationFilter[])}
          options={locationOptions}
        />
      </div>

      <div className="flex items-center gap-4">
        <Input
          className="min-w-0 flex-1"
          placeholder={t("searchPlaceholder")}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <span className="shrink-0 whitespace-nowrap text-xs text-muted">
          {t("itemsCount", { count: shownCount })}
        </span>
        <Tooltip
          trigger={
            <span>
              <Checkbox
                label={
                  <span className="underline decoration-dotted decoration-muted underline-offset-2">
                    {t("filters.unequippedOnly")}
                  </span>
                }
                checked={unequippedOnly}
                onCheckedChange={onUnequippedOnlyChange}
              />
            </span>
          }
        >
          {t("filters.unequippedOnlyTip")}
        </Tooltip>
        <Checkbox
          label={t("filters.tradableOnly")}
          checked={tradableOnly}
          onCheckedChange={onTradableOnlyChange}
        />
        {columnPicker != null ? <div className="ml-auto shrink-0">{columnPicker}</div> : null}
      </div>
    </div>
  );
}

export type { SortKey };
