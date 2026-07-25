import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LuStar } from "react-icons/lu";
import { cn } from "../../lib/cn";
import { gradeLabel, typeLabel } from "../../lib/itemLabels";
import {
  LEVEL_MAX,
  LEVEL_MIN,
  type LookupOptionGroup,
  type LookupSortKey,
} from "../../lib/lookupFilters";
import { Input } from "../../design-system/primitives/Input/Input";
import { Checkbox } from "../../design-system/primitives/Checkbox/Checkbox";
import { RangeSlider } from "../../design-system/primitives/RangeSlider/RangeSlider";
import { MultiSelect } from "../../design-system/primitives/MultiSelect/MultiSelect";
import { SortControl } from "../filters/SortControl";
import type { SelectOption } from "../../design-system/primitives/Select/Select";
import { gradeColor } from "../../lib/gradeColor";

const SORT_OPTIONS: { value: LookupSortKey; labelKey: string }[] = [
  { value: "name", labelKey: "sort.name" },
  { value: "grade", labelKey: "sort.grade" },
  { value: "level", labelKey: "sort.level" },
  { value: "type", labelKey: "sort.type" },
];

const FILTER_LABEL = "text-[10px] font-medium uppercase tracking-wide text-muted";

export interface LookupFiltersProps {
  query: string;
  typeFilter: string[];
  gradeFilter: string[];
  gearTypeFilter: string[];
  materialKindFilter: string[];
  effectFilter: string[];
  uniqueOnly: boolean;
  watchedOnly: boolean;
  watchedCount: number;
  levelRange: [number, number];
  sortKey: LookupSortKey;
  sortDir: "asc" | "desc";
  gradeOptions: string[];
  typeOptions: string[];
  gearTypeGroups: LookupOptionGroup[];
  materialKindOptions: string[];
  effectGroups: LookupOptionGroup[];
  shownCount: number;
  onQueryChange: (q: string) => void;
  onTypeFilterChange: (t: string[]) => void;
  onGradeFilterChange: (g: string[]) => void;
  onGearTypeFilterChange: (g: string[]) => void;
  onMaterialKindFilterChange: (m: string[]) => void;
  onEffectFilterChange: (e: string[]) => void;
  onUniqueOnlyChange: (v: boolean) => void;
  onWatchedOnlyChange: (v: boolean) => void;
  onLevelRangeChange: (range: [number, number]) => void;
  onSortKeyChange: (key: LookupSortKey) => void;
  onSortDirToggle: () => void;
}

export function LookupFilters({
  query,
  typeFilter,
  gradeFilter,
  gearTypeFilter,
  materialKindFilter,
  effectFilter,
  uniqueOnly,
  watchedOnly,
  watchedCount,
  levelRange,
  sortKey,
  sortDir,
  gradeOptions,
  typeOptions,
  gearTypeGroups,
  materialKindOptions,
  effectGroups,
  shownCount,
  onQueryChange,
  onTypeFilterChange,
  onGradeFilterChange,
  onGearTypeFilterChange,
  onMaterialKindFilterChange,
  onEffectFilterChange,
  onUniqueOnlyChange,
  onWatchedOnlyChange,
  onLevelRangeChange,
  onSortKeyChange,
  onSortDirToggle,
}: LookupFiltersProps) {
  const { t } = useTranslation("lookup");
  const sortOptions = useMemo<SelectOption[]>(
    () => SORT_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t],
  );
  const showGearFilters = typeFilter.length === 0 || typeFilter.includes("GEAR");
  const showMaterialFilters = typeFilter.length === 0 || typeFilter.includes("MATERIAL");

  function toggleType(value: string, checked: boolean) {
    onTypeFilterChange(checked ? [...typeFilter, value] : typeFilter.filter((tp) => tp !== value));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className={FILTER_LABEL}>{t("filters.itemType")}</span>
          <div className="flex items-center gap-3 py-1.5">
            {typeOptions.map((type) => (
              <Checkbox
                key={type}
                label={typeLabel(type, t)}
                checked={typeFilter.includes(type)}
                onCheckedChange={(checked) => toggleType(type, checked)}
              />
            ))}
          </div>
        </div>

        <MultiSelect
          className="w-40"
          label={t("filters.grade")}
          allLabel={t("filters.allGrades")}
          value={gradeFilter}
          onValueChange={onGradeFilterChange}
          options={gradeOptions.map((g) => ({
            value: g,
            label: gradeLabel(g, t),
            color: gradeColor(g),
          }))}
        />

        {showGearFilters ? (
          <MultiSelect
            className="w-44"
            label={t("filters.gearType")}
            allLabel={t("filters.allGearTypes")}
            value={gearTypeFilter}
            onValueChange={onGearTypeFilterChange}
            options={gearTypeGroups}
          />
        ) : null}

        <MultiSelect
          className="w-44"
          label={t("filters.modifier")}
          allLabel={t("filters.allModifiers")}
          value={effectFilter}
          onValueChange={onEffectFilterChange}
          options={effectGroups}
        />

        {showMaterialFilters ? (
          <MultiSelect
            className="w-44"
            label={t("filters.materialKind")}
            allLabel={t("filters.allMaterialKinds")}
            value={materialKindFilter}
            onValueChange={onMaterialKindFilterChange}
            options={materialKindOptions.map((m) => ({ value: m, label: typeLabel(m, t) }))}
          />
        ) : null}
      </div>

      {showGearFilters ? (
        <div className="flex flex-wrap items-end gap-4">
          <RangeSlider
            className="w-48"
            label={t("filters.level")}
            min={LEVEL_MIN}
            max={LEVEL_MAX}
            value={levelRange}
            onValueChange={onLevelRangeChange}
          />
          <Checkbox
            className="self-end pb-1.5"
            label={t("filters.uniqueOnly")}
            checked={uniqueOnly}
            onCheckedChange={onUniqueOnlyChange}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <SortControl
          options={sortOptions}
          sortKey={sortKey}
          onSortKeyChange={(key) => onSortKeyChange(key as LookupSortKey)}
          sortDir={sortDir}
          onSortDirToggle={onSortDirToggle}
        />
        <Input
          className="min-w-0 flex-1"
          placeholder={t("filters.searchItems")}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <label
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted"
          title={t("filters.watchedOnlyHint", { count: watchedCount })}
        >
          <Checkbox
            checked={watchedOnly}
            onCheckedChange={(c) => onWatchedOnlyChange(c)}
            aria-label={t("filters.watchedOnly")}
          />
          <LuStar
            className={cn("size-3.5", watchedOnly && "fill-current text-amber-400")}
            aria-hidden
          />
          <span className={cn(watchedOnly && "text-amber-400")}>
            {t("filters.watchedOnly")}
            {watchedCount > 0 ? ` (${watchedCount})` : ""}
          </span>
        </label>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted">
          {t("filters.itemsCount", { count: shownCount })}
        </span>
      </div>
    </div>
  );
}
