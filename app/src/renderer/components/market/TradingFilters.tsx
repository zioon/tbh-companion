import { useTranslation } from "react-i18next";
import {
  MultiSelect,
  type MultiSelectOption,
} from "../../design-system/primitives/MultiSelect/MultiSelect";
import { RangeSlider } from "../../design-system/primitives/RangeSlider/RangeSlider";
import { NumberInput } from "../../design-system/primitives/NumberField/NumberField";
import { Input } from "../../design-system/primitives/Input/Input";
import { gradeColor } from "../../lib/gradeColor";
import { gradeLabel, typeLabel } from "../../lib/itemLabels";
import { LEVEL_MAX, LEVEL_MIN } from "../../lib/lookupFilters";

const FILTER_LABEL = "text-[10px] font-medium uppercase tracking-wide text-muted";

/** 数值下限筛选项：维度名 label + 输入框，单位（货币/件）作为输入框内嵌后缀，排版统一。 */
function MoneyThresholdField({
  label,
  unit,
  value,
  onValueChange,
}: {
  label: string;
  unit: string;
  value: number | null;
  onValueChange: (v: number | null) => void;
}) {
  return (
    <div className="flex w-32 flex-col gap-1">
      <span className={FILTER_LABEL}>{label}</span>
      <div className="relative">
        <NumberInput
          className="h-8 w-full pr-8 text-[12px]"
          min={0}
          value={value}
          onValueChange={onValueChange}
          aria-label={label}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] text-muted">
          {unit}
        </span>
      </div>
    </div>
  );
}

/** 交易页卡片筛选栏：名称 + 品质 + 部位 + 种类 + 等级 + 价格/成交量/成交额下限。 */
export function TradingFilters({
  query,
  gradeFilter,
  gearTypeFilter,
  materialKindFilter,
  levelRange,
  minTotal,
  minVolume,
  minPrice,
  currency,
  gradeOptions,
  gearTypeOptions,
  materialKindOptions,
  shownCount,
  onQueryChange,
  onGradeFilterChange,
  onGearTypeFilterChange,
  onMaterialKindFilterChange,
  onLevelRangeChange,
  onMinTotalChange,
  onMinVolumeChange,
  onMinPriceChange,
}: {
  query: string;
  gradeFilter: string[];
  gearTypeFilter: string[];
  materialKindFilter: string[];
  levelRange: [number, number];
  minTotal: number | null;
  minVolume: number | null;
  minPrice: number | null;
  currency: string;
  gradeOptions: string[];
  gearTypeOptions: string[];
  materialKindOptions: string[];
  shownCount: number;
  onQueryChange: (q: string) => void;
  onGradeFilterChange: (g: string[]) => void;
  onGearTypeFilterChange: (g: string[]) => void;
  onMaterialKindFilterChange: (m: string[]) => void;
  onLevelRangeChange: (range: [number, number]) => void;
  onMinTotalChange: (v: number | null) => void;
  onMinVolumeChange: (v: number | null) => void;
  onMinPriceChange: (v: number | null) => void;
}) {
  const { t } = useTranslation("market");
  const gradeSelectOptions: MultiSelectOption[] = gradeOptions.map((g) => ({
    value: g,
    label: gradeLabel(g, t),
    color: gradeColor(g),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-48 flex-col gap-1">
          <Input
            placeholder={t("trading.filters.searchItems")}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className={FILTER_LABEL}>{t("trading.filters.grade")}</span>
          <MultiSelect
            className="w-36"
            allLabel={t("trading.filters.allGrades")}
            value={gradeFilter}
            onValueChange={onGradeFilterChange}
            options={gradeSelectOptions}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className={FILTER_LABEL}>{t("trading.filters.gearType")}</span>
          <MultiSelect
            className="w-36"
            allLabel={t("trading.filters.allGearTypes")}
            value={gearTypeFilter}
            onValueChange={onGearTypeFilterChange}
            options={gearTypeOptions.map((g) => ({ value: g, label: typeLabel(g, t) }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className={FILTER_LABEL}>{t("trading.filters.materialKind")}</span>
          <MultiSelect
            className="w-36"
            allLabel={t("trading.filters.allMaterialKinds")}
            value={materialKindFilter}
            onValueChange={onMaterialKindFilterChange}
            options={materialKindOptions.map((m) => ({ value: m, label: typeLabel(m, t) }))}
          />
        </div>

        <RangeSlider
          className="w-56"
          label={t("trading.filters.level")}
          min={LEVEL_MIN}
          max={LEVEL_MAX}
          value={levelRange}
          formatValue={(n) => t("common:labels.levelShort", { level: n })}
          onValueChange={onLevelRangeChange}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <MoneyThresholdField
          label={t("trading.filters.total")}
          unit={currency}
          value={minTotal}
          onValueChange={onMinTotalChange}
        />
        <MoneyThresholdField
          label={t("trading.filters.volume")}
          unit={t("trading.filters.unitCount")}
          value={minVolume}
          onValueChange={onMinVolumeChange}
        />
        <MoneyThresholdField
          label={t("trading.filters.price")}
          unit={currency}
          value={minPrice}
          onValueChange={onMinPriceChange}
        />
        <span className="ml-auto shrink-0 whitespace-nowrap pb-1 text-xs text-muted">
          {t("trading.filters.shownCount", { count: shownCount })}
        </span>
      </div>
    </div>
  );
}
