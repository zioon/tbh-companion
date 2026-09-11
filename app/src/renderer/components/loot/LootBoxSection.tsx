import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  BoxOpenBreakdownRow,
  BoxOpenStats,
  BoxTimerCatalogEntry,
  LookupItem,
  LootRingSeconds,
} from "../../../../shared/types";
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
import { gradeColor } from "../../lib/gradeColor";
import { gradeLabel } from "../../lib/itemLabels";
import { useEntityPanel } from "../../context/entityPanelContext";
import { useTbhContext } from "../../context/tbhContext";
import { ItemLink } from "../ItemLink";
import { cn } from "../../lib/cn";
import { formatMoney } from "../../../core/steamPrice";
import { LootRing } from "./LootRing";
import { translateBoxLabel } from "../../lib/boxLabel";

function fmtPct(pct: number): string {
  return `${(pct * 100).toFixed(1)}%`;
}

function ringKeyForCategory(category: string): keyof LootRingSeconds | null {
  if (category === "common") return "common";
  if (category === "rare") return "stage";
  if (category === "plagueCommon") return "plagueCommon";
  if (category === "plagueRare") return "plagueRare";
  if (category === "plagueAct") return "plagueAct";
  return null;
}

function fmtMoney(value: number | null, currency: string): string {
  if (value == null) return "—";
  return formatMoney(value, currency);
}

function fmtMoneyPerDrop(value: number | null, currency: string): string {
  if (value == null) return "—";
  return `${formatMoney(value, currency)}/次`;
}

/** Compact合成点数（按当前语言，高位自动进 万/亿/K/M/B）。null → "—"。 */
function fmtPoints(value: number | null, language: string | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function reclassifyCategoryOptions(t: TFunction<"loot">): SelectOption[] {
  return [
    { value: "common", label: t("boxSection.categoryOptionCommon") },
    { value: "rare", label: t("boxSection.categoryOptionStageBoss") },
    { value: "act", label: t("boxSection.categoryOptionActBoss") },
    { value: "plagueCommon", label: t("boxSection.categoryOptionPlagueCommon") },
    { value: "plagueRare", label: t("boxSection.categoryOptionPlagueRare") },
    { value: "plagueAct", label: t("boxSection.categoryOptionPlagueAct") },
  ];
}

interface ReclassifyRowState {
  category: string;
  level: string;
}

function LootItemNameCell({
  row,
  itemIndex,
  onOpenItem,
  catalogReady,
}: {
  row: BoxOpenBreakdownRow;
  itemIndex: Map<number, LookupItem>;
  onOpenItem: (itemKey: number) => void;
  catalogReady: boolean;
}) {
  const catalogItem = itemIndex.get(row.itemKey);
  const color = row.grade ? gradeColor(row.grade) : undefined;

  if (catalogItem) {
    return (
      <ItemLink
        node={{ type: "item", id: row.itemKey }}
        name={row.name}
        grade={row.grade}
        iconPath={catalogItem.iconPath}
        onNavigate={() => onOpenItem(row.itemKey)}
        peekItem={(id) => itemIndex.get(id)}
      />
    );
  }

  // 目录未就绪时用骨架条占位，避免目录到达后「灰点 → 图标 + 品质色」二次更新。
  if (!catalogReady) {
    return (
      <span
        className="inline-block h-4 w-28 animate-pulse rounded-sm bg-muted/25"
        aria-hidden="true"
      />
    );
  }

  return (
    <button
      type="button"
      className="inline-flex w-fit max-w-full items-center gap-1 rounded text-[13px] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ideal/50"
      onClick={() => onOpenItem(row.itemKey)}
    >
      <span
        className="mr-1 inline-block size-[9px] shrink-0 rounded-full"
        style={{ background: color ?? gradeColor("UNKNOWN") }}
      />
      <span className="min-w-0 truncate" style={color ? { color } : undefined}>
        {row.name}
      </span>
    </button>
  );
}

export const LootBoxSection = memo(function LootBoxSection({
  stats,
  currentStageKey,
  onReset,
  onReclassify,
  lastDropWallTime,
  itemIndex,
  catalogReady = true,
  boxCatalog,
  ringSeconds,
  onUpdateRingSeconds,
  className,
  language,
}: {
  stats: BoxOpenStats;
  currentStageKey: number | null;
  onReset: (boxKey: string) => void;
  onReclassify?: (itemKey: number, fromBoxKey: string, toBoxKey: string) => void;
  lastDropWallTime: number | null;
  itemIndex: Map<number, LookupItem>;
  /** 图鉴目录是否已就绪。未就绪时名称单元格渲染骨架屏而非灰点占位。 */
  catalogReady?: boolean;
  boxCatalog: BoxTimerCatalogEntry[] | undefined;
  ringSeconds: LootRingSeconds;
  onUpdateRingSeconds: (next: LootRingSeconds) => void;
  className?: string;
  /** Forces React.memo to re-render on language change (i18n from useTranslation alone isn't enough). */
  language?: string;
}) {
  const { t } = useTranslation("loot");
  const [filter, setFilter] = useState<LootFilterState>(DEFAULT_LOOT_FILTER_STATE);
  const [confirming, setConfirming] = useState(false);
  const [reclassifyState, setReclassifyState] = useState<Record<number, ReclassifyRowState>>({});
  const [editingRing, setEditingRing] = useState(false);
  const [ringDraft, setRingDraft] = useState<string>("");

  // Re-translate boxKey via i18next so the chest category and level honor the
  // active locale. The main-process `stats.label` is English-only (core layer
  // can't import i18next); this renderer-side translation is the source of
  // truth for display.
  const localizedLabel = translateBoxLabel(t, stats.boxKey);

  const { open: openEntity } = useEntityPanel();
  const { inventory } = useTbhContext();
  const currency = inventory?.currency ?? "USD";
  const onOpenItem = useCallback(
    (itemKey: number) => openEntity({ type: "item", id: itemKey }),
    [openEntity],
  );

  const ringKey = ringKeyForCategory(stats.category);
  const ringLapSeconds = ringKey != null ? ringSeconds[ringKey] : null;

  const catalog = boxCatalog;

  const { levelOptions: reclassifyLevelOptions, defaultLevel } = useMemo(() => {
    const set = new Set<number>();
    for (const entry of catalog ?? []) {
      if (entry.level != null) set.add(entry.level);
    }
    const sortedLevels = [...set].sort((a, b) => a - b);
    const levelOptions = sortedLevels.map((lv) => ({
      value: String(lv),
      label: t("boxSection.levelOption", { level: lv }),
    }));
    const fallback = sortedLevels[0] ?? 1;

    let defaultLevel: number;
    if (!catalog || !currentStageKey || currentStageKey <= 0) {
      defaultLevel = fallback;
    } else {
      const candidates = catalog.filter((entry) =>
        entry.farmStageOptions.some((opt) => opt.stageKey === currentStageKey),
      );
      if (candidates.length === 0) {
        defaultLevel = fallback;
      } else {
        defaultLevel =
          candidates.map((c) => c.level ?? 0).reduce((max, lv) => (lv > max ? lv : max), 0) ||
          fallback;
      }
    }
    return { levelOptions, defaultLevel };
  }, [catalog, currentStageKey, t]);

  const defaultLevelStr = String(defaultLevel);
  const defaultRow = useMemo<ReclassifyRowState>(
    () => ({ category: "common", level: defaultLevelStr }),
    [defaultLevelStr],
  );

  const rows = useMemo(() => filterAndSortLoot(stats.breakdown, filter), [stats.breakdown, filter]);
  const gradeSelectOptions: MultiSelectOption[] = useMemo(
    () =>
      gradeOptionsFromLoot(stats.breakdown).map((g) => ({
        value: g,
        label: gradeLabel(g, t),
        color: gradeColor(g),
      })),
    [stats.breakdown, t],
  );
  const isUnclassified = stats.category === "unclassified" && onReclassify;

  const categoryOptions = useMemo(() => reclassifyCategoryOptions(t), [t]);

  const columns = useMemo(
    () =>
      isUnclassified
        ? [
            { label: t("boxSection.columnItem"), width: "26%" },
            { label: t("boxSection.columnCount"), align: "right" as const, width: "12%" },
            { label: t("boxSection.columnDropPct"), align: "right" as const, width: "14%" },
            { label: t("boxSection.columnBuyout"), align: "right" as const, width: "14%" },
            { label: t("boxSection.columnAssignTo"), align: "center" as const, width: "34%" },
          ]
        : [
            { label: t("boxSection.columnItem"), width: "38%" },
            { label: t("boxSection.columnCount"), align: "right" as const, width: "12%" },
            { label: t("boxSection.columnDropPct"), align: "right" as const, width: "12%" },
            { label: t("boxSection.columnBuyout"), align: "right" as const, width: "16%" },
            { label: t("boxSection.columnSynthesisPoints"), align: "right" as const, width: "16%" },
          ],
    [isUnclassified, t],
  );

  const getReclassifyRow = useCallback(
    (itemKey: number): ReclassifyRowState => reclassifyState[itemKey] ?? defaultRow,
    [reclassifyState, defaultRow],
  );

  const setReclassifyRow = useCallback(
    (itemKey: number, patch: Partial<ReclassifyRowState>): void => {
      setReclassifyState((prev) => ({
        ...prev,
        [itemKey]: {
          ...(prev[itemKey] ?? defaultRow),
          ...patch,
        },
      }));
    },
    [defaultRow],
  );

  const handleAssign = useCallback(
    (itemKey: number): void => {
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
    },
    [getReclassifyRow, onReclassify, stats.boxKey],
  );

  const handleAssignAll = useCallback(() => {
    if (!onReclassify) return;
    for (const row of rows) {
      const state = getReclassifyRow(row.itemKey);
      const levelNum = Number.parseInt(state.level, 10);
      const toBoxKey =
        Number.isFinite(levelNum) && levelNum > 0
          ? `${state.category}:${levelNum}`
          : state.category;
      onReclassify(row.itemKey, stats.boxKey, toBoxKey);
    }
    setReclassifyState({});
  }, [getReclassifyRow, onReclassify, rows, stats.boxKey]);

  const openRingEditor = useCallback(() => {
    if (ringKey == null) return;
    const secs = ringSeconds[ringKey];
    setRingDraft((secs / 60).toFixed(1));
    setEditingRing(true);
  }, [ringKey, ringSeconds]);

  const commitRingDraft = useCallback(() => {
    if (ringKey == null) return;
    const minutes = Number.parseFloat(ringDraft);
    let seconds: number;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      seconds = ringSeconds[ringKey];
    } else {
      seconds = Math.min(Math.max(Math.round(minutes * 60), 1), 3600);
    }
    const next = { ...ringSeconds, [ringKey]: seconds };
    setEditingRing(false);
    onUpdateRingSeconds(next);
  }, [ringDraft, ringKey, ringSeconds, onUpdateRingSeconds]);

  return (
    <Card padding="default" className={cn("relative flex flex-col gap-2", className)}>
      {ringLapSeconds != null && (
        <LootRing lastDropWallTime={lastDropWallTime} lapSeconds={ringLapSeconds} />
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-sm font-semibold">{localizedLabel}</h2>
          <Badge variant="muted">{t("boxSection.opensBadge", { count: stats.totalItems })}</Badge>
          {stats.perDropValue != null && (
            <Badge variant="info">{fmtMoneyPerDrop(stats.perDropValue, currency)}</Badge>
          )}
          {stats.totalSynthesisPoints != null && (
            <Badge variant="info">
              {t("boxSection.pointsTotalLabel", {
                // 只展示每次均值（合成点合计 ÷ 掉落次数），与钱的 per-drop 徽标口径一致。
                mean: fmtPoints(
                  stats.totalSynthesisPoints / Math.max(stats.totalItems, 1),
                  language,
                ),
              })}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {ringLapSeconds != null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={openRingEditor}
              aria-label={t("boxSection.ringAriaLabel", { label: localizedLabel })}
              title={t("boxSection.ringLapTitle", { minutes: Math.round(ringLapSeconds / 60) })}
            >
              {"\u2699"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={t("boxSection.resetAriaLabel", { label: localizedLabel })}
          >
            {t("boxSection.reset")}
          </Button>
        </div>
      </div>

      {isUnclassified && (
        <p className="m-0 text-xs text-muted">{t("boxSection.unclassifiedHint")}</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Input
          className="min-w-0 flex-1"
          placeholder={t("boxSection.searchPlaceholder")}
          value={filter.query}
          onChange={(e) => setFilter({ ...filter, query: e.target.value })}
          aria-label={t("boxSection.searchAriaLabel")}
        />
        {gradeSelectOptions.length > 0 && (
          <MultiSelect
            className="w-40"
            label={t("boxSection.gradeLabel")}
            allLabel={t("boxSection.allGrades")}
            value={filter.gradeFilter}
            onValueChange={(value) => setFilter({ ...filter, gradeFilter: value })}
            options={gradeSelectOptions}
          />
        )}
        {isUnclassified && rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleAssignAll}>
            {t("boxSection.assignAll")}
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        maxHeight="320px"
        rowContainSize={rows.length > 50 ? "36px 0" : undefined}
      >
        {rows.map((row, i) => (
          <DataTableRow
            key={`${row.itemKey}|${row.grade ?? ""}`}
            index={i}
            cells={
              isUnclassified
                ? [
                    {
                      content: (
                        <LootItemNameCell
                          row={row}
                          itemIndex={itemIndex}
                          onOpenItem={onOpenItem}
                          catalogReady={catalogReady}
                        />
                      ),
                    },
                    { content: String(row.count), align: "right" },
                    { content: fmtPct(row.dropPct), align: "right" },
                    { content: fmtMoney(row.buyOrderUnit, currency), align: "right" },
                    {
                      content: (
                        <div className="flex items-center gap-1">
                          <Select
                            className="min-w-0 flex-1"
                            triggerClassName="py-1 text-xs"
                            options={categoryOptions}
                            value={getReclassifyRow(row.itemKey).category}
                            onValueChange={(v) =>
                              setReclassifyRow(row.itemKey, { category: String(v) })
                            }
                            ariaLabel={t("boxSection.assignCategoryAriaLabel", { name: row.name })}
                          />
                          <Select
                            className="w-28 shrink-0"
                            triggerClassName="py-1 text-xs"
                            options={reclassifyLevelOptions}
                            value={getReclassifyRow(row.itemKey).level}
                            onValueChange={(v) =>
                              setReclassifyRow(row.itemKey, { level: String(v) })
                            }
                            ariaLabel={t("boxSection.levelForAriaLabel", { name: row.name })}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAssign(row.itemKey)}
                            aria-label={t("boxSection.confirmAssignAriaLabel", { name: row.name })}
                          >
                            {t("boxSection.assign")}
                          </Button>
                        </div>
                      ),
                      align: "center",
                    },
                  ]
                : [
                    {
                      content: (
                        <LootItemNameCell
                          row={row}
                          itemIndex={itemIndex}
                          onOpenItem={onOpenItem}
                          catalogReady={catalogReady}
                        />
                      ),
                    },
                    { content: String(row.count), align: "right" },
                    { content: fmtPct(row.dropPct), align: "right" },
                    { content: fmtMoney(row.buyOrderUnit, currency), align: "right" },
                    { content: fmtPoints(row.synthesisPointsUnit, language), align: "right" },
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
            <DialogTitle className="m-0 text-base font-semibold">
              {t("boxSection.resetTitle", { label: localizedLabel })}
            </DialogTitle>
            <p className="m-0 text-sm text-muted">{t("boxSection.resetBody")}</p>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("cancel")}
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
                    {t("boxSection.reset")}
                  </Button>
                }
              />
            </div>
          </div>
        </Dialog>
      )}

      {editingRing && ringKey != null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingRing(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <DialogTitle className="m-0 text-base font-semibold">
              {t("boxSection.ringDialogTitle", { label: localizedLabel })}
            </DialogTitle>
            <p className="m-0 text-sm text-muted">{t("boxSection.ringDialogBody")}</p>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">{t("boxSection.minutesLabel")}</span>
              <Input
                className="w-24"
                type="number"
                min={1 / 60}
                max={60}
                step={0.5}
                value={ringDraft}
                onChange={(e) => setRingDraft(e.target.value)}
                aria-label={t("boxSection.ringMinutesAriaLabel")}
              />
            </label>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingRing(false)}>
                {t("cancel")}
              </Button>
              <DialogClose
                render={
                  <Button variant="primary" onClick={commitRingDraft}>
                    {t("boxSection.save")}
                  </Button>
                }
              />
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
});
