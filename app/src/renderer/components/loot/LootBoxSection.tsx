import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BoxOpenBreakdownRow,
  BoxOpenStats,
  BoxQueueItem,
  BoxQueueSnapshot,
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
import { useLookupCatalog } from "../../lib/useLookupCatalog";
import { useBoxTimers } from "../../lib/useBoxTimers";
import { useEntityPanel } from "../../context/entityPanelContext";
import { useTbhContext } from "../../context/tbhContext";
import { ItemLink } from "../ItemLink";
import { cn } from "../../lib/cn";
import { formatMoney } from "../../../core/steamPrice";
import { LootRing } from "./LootRing";
import { LootQueuePreview } from "./LootQueuePreview";

function fmtPct(pct: number): string {
  return `${(pct * 100).toFixed(1)}%`;
}

/**
 * Default loot-ring lap durations, mirroring `app/src/main/config.ts`
 * `DEFAULT_LOOT_RING_SECONDS`. Used as the initial state before the persisted
 * config arrives via `window.tbh.getConfig()` — the real values overwrite
 * these on the first effect tick.
 */
const DEFAULT_RING_SECONDS: LootRingSeconds = {
  common: 5 * 60,
  stage: 7 * 60,
};

/**
 * Map a tracker {@link BoxCategory} to the loot-ring config key. Only Common
 * chests (`"common"`) and Stage-boss chests (`"rare"`) get a ring — matches
 * the user's request. Act-boss (`"act"`) and `"unclassified"` return null,
 * so no ring renders on those cards.
 */
function ringKeyForCategory(category: string): keyof LootRingSeconds | null {
  if (category === "common") return "common";
  if (category === "rare") return "stage";
  return null;
}

/**
 * Format an epoch-seconds timestamp as a short local time string ("HH:mm")
 * for the "tracking since" badge in the card header. Returns "—" when the
 * anchor is null (corrupt snapshot with no history and no reset stamp —
 * shouldn't normally happen, but the UI shouldn't crash if it does).
 */
function fmtTrackingSince(epochSeconds: number | null): string {
  if (epochSeconds == null) return "—";
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a money value with currency symbol and 2-decimal precision, matching
 * the Inventory page's market price formatting. Falls back to "—" when the
 * value is null (no buy-order book / no data yet) — but still shows the
 * currency symbol + "0.00" when the value is 0, so the user sees the active
 * currency even on items with no buyout.
 */
function fmtMoney(value: number | null, currency: string): string {
  if (value == null) return "—";
  return formatMoney(value, currency);
}

/** Like {@link fmtMoney} but appends "/h" for the per-hour rate column. */
function fmtMoneyPerHour(value: number | null, currency: string): string {
  if (value == null) return "—";
  return `${formatMoney(value, currency)}/h`;
}

const RECLASSIFY_CATEGORY_OPTIONS: SelectOption[] = [
  { value: "common", label: "Common" },
  { value: "rare", label: "Stage boss" },
  { value: "act", label: "Act boss" },
];

/**
 * Derive the available chest levels and a sensible default for the "Assign to"
 * dropdown on unclassified loot rows, using the chest tracker's catalog as the
 * source of truth — these are the discrete, canonical stage-box levels the game
 * actually drops (1-7, 15, 20, 30, 40, 50, 65, 80; see `data/stage_boxes.json`
 * and `BoxTimerCatalogEntry`). Hard-coding a 1-50 range would surface levels
 * that don't exist as drops and let the user reclassify into boxKeys that the
 * tracker never aggregates.
 *
 * The default mirrors `resolveTrackedDropBoxIdForStage`'s strategy: pick the
 * highest-level box whose `farmStageOptions` (drop stages) include the player's
 * current stage. Falls back to the lowest available level when no route drops
 * on the current stage (e.g. an act-boss stage) or the catalog hasn't loaded.
 */
function useChestLevelDefaults(currentStageKey: number | null): {
  levelOptions: SelectOption[];
  defaultLevel: number;
} {
  const boxTimers = useBoxTimers();
  const catalog = boxTimers?.catalog;

  const { levelOptions, sortedLevels } = useMemo(() => {
    const set = new Set<number>();
    for (const entry of catalog ?? []) {
      if (entry.level != null) set.add(entry.level);
    }
    const levels = [...set].sort((a, b) => a - b);
    return {
      levelOptions: levels.map((lv) => ({ value: String(lv), label: `Lv ${lv}` })),
      sortedLevels: levels,
    };
  }, [catalog]);

  const defaultLevel = useMemo(() => {
    const fallback = sortedLevels[0] ?? 1;
    if (!catalog || !currentStageKey || currentStageKey <= 0) return fallback;
    const candidates = catalog.filter((entry) =>
      entry.farmStageOptions.some((opt) => opt.stageKey === currentStageKey),
    );
    if (candidates.length === 0) return fallback;
    // Match `resolveTrackedDropBoxIdForStage`: prefer the highest level among
    // boxes that drop on this stage.
    return (
      candidates.map((c) => c.level ?? 0).reduce((max, lv) => (lv > max ? lv : max), 0) || fallback
    );
  }, [catalog, currentStageKey, sortedLevels]);

  return { levelOptions, defaultLevel };
}

interface ReclassifyRowState {
  category: string;
  level: string;
}

/**
 * Renders a loot breakdown item name the same way the Inventory page does:
 * grade-colored label, icon + peek card when the catalog has the item, and
 * clickable to open the global entity panel for that item. Falls back to a
 * minimal colored clickable span when the catalog hasn't loaded or the item
 * isn't known (e.g. items from newer game versions).
 */
function LootItemNameCell({
  row,
  itemIndex,
  onOpenItem,
}: {
  row: BoxOpenBreakdownRow;
  itemIndex: Map<number, LookupItem>;
  onOpenItem: (itemKey: number) => void;
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

export function LootBoxSection({
  stats,
  currentStageKey,
  onReset,
  onReclassify,
  lastDropWallTime,
  boxQueueItems,
  boxQueueStatus,
  className,
}: {
  stats: BoxOpenStats;
  currentStageKey: number | null;
  onReset: (boxKey: string) => void;
  onReclassify?: (itemKey: number, fromBoxKey: string, toBoxKey: string) => void;
  /**
   * Epoch seconds of the most recent chest DROP for this card's category, or
   * null when no drops have been recorded. Drives the border ring's lap
   * progress — the ring advances from the last *drop* (not the last open),
   * so the player can see how long it's been since a chest of this type
   * dropped regardless of whether it's been opened yet. Sourced from
   * `chestDrops.history` via `useLoot().lastDropWallTimeByCategory`.
   */
  lastDropWallTime: number | null;
  /**
   * Box-queue ("stargaze") prediction for this card's boxKey, or undefined
   * when no prediction is available for this card (either the queue scanner
   * hasn't located the runtime singleton yet, or the current stage doesn't
   * map to this card's level). When non-empty, a collapsed footer renders
   * below the breakdown table showing the next predicted drops.
   */
  boxQueueItems?: ReadonlyArray<BoxQueueItem>;
  /** Scanner status from the live reader — drives the empty-state message. */
  boxQueueStatus?: BoxQueueSnapshot["status"] | null;
  /** Extra class for the section root (e.g. col-span-2 to span a grid row). */
  className?: string;
}) {
  const [filter, setFilter] = useState<LootFilterState>(DEFAULT_LOOT_FILTER_STATE);
  const [confirming, setConfirming] = useState(false);
  const [reclassifyState, setReclassifyState] = useState<Record<number, ReclassifyRowState>>({});
  // Ring lap durations per category. Loaded from config on mount; updated
  // via `window.tbh.saveConfig` when the user edits them in the settings dialog.
  const [ringSeconds, setRingSeconds] = useState<LootRingSeconds>(DEFAULT_RING_SECONDS);
  // Local input value while the settings dialog is open (string so the user
  // can clear / retype freely before committing).
  const [editingRing, setEditingRing] = useState(false);
  const [ringDraft, setRingDraft] = useState<string>("");

  // Load the persisted loot-ring config once on mount. The same component is
  // re-mounted for each boxKey in the grid, but the config read is cheap and
  // shares the same source across all sections — better than threading the
  // value through props from Loot.tsx (which would force every card to
  // re-render when one card edits the duration).
  useEffect(() => {
    let cancelled = false;
    void window.tbh
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        if (cfg.lootRingSeconds) setRingSeconds(cfg.lootRingSeconds);
      })
      // Never let a config-read failure break the card's rendering — the
      // defaults are still usable.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const catalog = useLookupCatalog();
  const { open: openEntity } = useEntityPanel();
  // Currency comes from the latest resolved inventory snapshot (same source
  // as the Inventory page) so buyout / hourly formatting matches what the
  // player sees elsewhere. Falls back to "USD" before the first inventory
  // snapshot arrives.
  const { inventory } = useTbhContext();
  const currency = inventory?.currency ?? "USD";
  const itemIndex = useMemo(
    () => new Map((catalog ?? []).map((item) => [item.id, item])),
    [catalog],
  );
  const onOpenItem = useCallback(
    (itemKey: number) => openEntity({ type: "item", id: itemKey }),
    [openEntity],
  );

  // Ring is only rendered for Common and Stage-boss chests. The lap duration
  // is keyed by category so the user can configure them independently.
  const ringKey = ringKeyForCategory(stats.category);
  const ringLapSeconds = ringKey != null ? ringSeconds[ringKey] : null;

  // Default level and level options come from the chest tracker's catalog —
  // see `useChestLevelDefaults`. The hook is also what subscribes to the
  // boxTimers IPC stream; calling it unconditionally here keeps that
  // subscription alive while the Loot tab is mounted.
  const { levelOptions: reclassifyLevelOptions, defaultLevel } =
    useChestLevelDefaults(currentStageKey);
  const defaultLevelStr = String(defaultLevel);
  const defaultRow = useMemo<ReclassifyRowState>(
    () => ({ category: "common", level: defaultLevelStr }),
    [defaultLevelStr],
  );

  // P1-10: memoize derived data so a parent re-render (e.g. stats broadcast at
  // 5 Hz) doesn't re-filter+sort the breakdown or rebuild grade options when
  // the inputs are referentially unchanged. `stats.breakdown` is rebuilt by the
  // main process on every broadcast, so the memo also shields the DataTable
  // from re-rendering when only price fields changed but filter input didn't.
  const rows = useMemo(() => filterAndSortLoot(stats.breakdown, filter), [stats.breakdown, filter]);
  const gradeSelectOptions: MultiSelectOption[] = useMemo(
    () => gradeOptionsFromLoot(stats.breakdown).map((g) => ({ value: g, label: g })),
    [stats.breakdown],
  );
  const isUnclassified = stats.category === "unclassified" && onReclassify;

  const columns = useMemo(
    () =>
      isUnclassified
        ? [
            { label: "Item", width: "30%" },
            { label: "Count", align: "right" as const, width: "12%" },
            { label: "Drop%", align: "right" as const, width: "14%" },
            { label: "Buyout", align: "right" as const, width: "16%" },
            { label: "Assign to", align: "center" as const, width: "28%" },
          ]
        : [
            { label: "Item", width: "38%" },
            { label: "Count", align: "right" as const, width: "14%" },
            { label: "Drop%", align: "right" as const, width: "14%" },
            { label: "Buyout", align: "right" as const, width: "17%" },
            { label: "Hourly", align: "right" as const, width: "17%" },
          ],
    [isUnclassified],
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

  // Assign every visible (filtered) unclassified row to the same category+level
  // in one click. Uses the default row state so the bulk action mirrors what a
  // fresh per-row Select would show — the player's current stage level by
  // default, or whatever they last picked for category. Items already
  // reclassified in this render cycle keep using their own state.
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

  // --- Ring duration editor ------------------------------------------------
  // Open the settings dialog with the current lap duration pre-filled (in
  // minutes, rounded to 1 decimal so the user can set 4.5 min etc.). Saving
  // converts back to seconds, clamps to [1, 3600], and persists via the
  // standard config patch flow — same IPC the Settings tab uses.
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
      seconds = DEFAULT_RING_SECONDS[ringKey];
    } else {
      // Clamp to [1s, 1h] mirroring `sanitizeLootRingSeconds` in config.ts.
      seconds = Math.min(Math.max(Math.round(minutes * 60), 1), 3600);
    }
    const next = { ...ringSeconds, [ringKey]: seconds };
    setRingSeconds(next);
    setEditingRing(false);
    // Persist via the same IPC flow the Settings tab uses. The main process
    // re-sanitizes so we don't have to worry about a sibling card racing
    // with a different value.
    void window.tbh.saveConfig({ lootRingSeconds: next }).catch(() => {});
  }, [ringDraft, ringKey, ringSeconds]);

  return (
    <Card padding="default" className={cn("relative flex flex-col gap-2", className)}>
      {/* Border ring overlay (Common / Stage-boss only). Rendered inside the
          Card so it inherits `relative` positioning and stays clipped to the
          card's rounded border. `pointer-events-none` so clicks pass through.
          The ring advances from the last chest DROP of this category (not
          the last open) — see `useLoot().lastDropWallTimeByCategory`. */}
      {ringLapSeconds != null && (
        <LootRing lastDropWallTime={lastDropWallTime} lapSeconds={ringLapSeconds} />
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-sm font-semibold">{stats.label}</h2>
          <Badge variant="muted">{stats.totalOpens} opens</Badge>
          {stats.hourlyValue != null && (
            <Badge variant="info">{fmtMoneyPerHour(stats.hourlyValue, currency)}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* "Tracking since" badge: the per-box accumulation-window start
              (last reset, or first drop when never reset). Drives the
              `hourlyValue` divisor — see `BoxOpenTracker.trackingSinceByKey`.
              Shown as a muted local-time string so the player can see at a
              glance when this chest's hourly rate started being measured. */}
          <span
            className="text-xs text-muted"
            title={`Hourly rate measured since this time (resets on Reset)`}
          >
            Since {fmtTrackingSince(stats.trackingSinceWallTime)}
          </span>
          {/* Ring-lap settings: only shown when this card renders a ring. */}
          {ringLapSeconds != null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={openRingEditor}
              aria-label={`Ring duration for ${stats.label}`}
              title={`Ring lap: ${Math.round(ringLapSeconds / 60)} min`}
            >
              {/* Gear icon (Unicode ⚙) — stays legible at small sizes. */}
              {"\u2699"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={`Reset ${stats.label} drops`}
          >
            Reset
          </Button>
        </div>
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
          aria-label="Search items"
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
        {isUnclassified && rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleAssignAll}>
            Assign all
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        maxHeight="320px"
        // P1-10: opt into Chromium-native CSS virtualization (content-visibility)
        // when the breakdown is large enough that rendering every row on each
        // 5 Hz stats broadcast would be wasteful. The audit's threshold is
        // > 50 rows; below that the intrinsic-size hint adds layout cost
        // without saving anything.
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
                        <LootItemNameCell row={row} itemIndex={itemIndex} onOpenItem={onOpenItem} />
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
                            options={RECLASSIFY_CATEGORY_OPTIONS}
                            value={getReclassifyRow(row.itemKey).category}
                            onValueChange={(v) =>
                              setReclassifyRow(row.itemKey, { category: String(v) })
                            }
                            ariaLabel={`Assign ${row.name} to category`}
                          />
                          <Select
                            className="w-20 shrink-0"
                            triggerClassName="py-1 text-xs"
                            options={reclassifyLevelOptions}
                            value={getReclassifyRow(row.itemKey).level}
                            onValueChange={(v) =>
                              setReclassifyRow(row.itemKey, { level: String(v) })
                            }
                            ariaLabel={`Level for ${row.name}`}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAssign(row.itemKey)}
                            aria-label={`Confirm assignment of ${row.name}`}
                          >
                            Assign
                          </Button>
                        </div>
                      ),
                      align: "center",
                    },
                  ]
                : [
                    {
                      content: (
                        <LootItemNameCell row={row} itemIndex={itemIndex} onOpenItem={onOpenItem} />
                      ),
                    },
                    { content: String(row.count), align: "right" },
                    { content: fmtPct(row.dropPct), align: "right" },
                    { content: fmtMoney(row.buyOrderUnit, currency), align: "right" },
                    { content: fmtMoneyPerHour(row.hourlyValue, currency), align: "right" },
                  ]
            }
          />
        ))}
      </DataTable>

      <LootQueuePreview
        items={boxQueueItems ?? []}
        itemIndex={itemIndex}
        status={boxQueueStatus ?? null}
      />

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
              This clears all recorded box opens for {stats.label}. The session timer is not
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

      {editingRing && ringKey != null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingRing(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <DialogTitle className="m-0 text-base font-semibold">
              Ring lap duration — {stats.label}
            </DialogTitle>
            <p className="m-0 text-sm text-muted">
              How long one full traversal of the border ring takes. The ring fills clockwise from
              the top each time a chest of this type drops; completed laps layer underneath in a
              warmer color.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Minutes</span>
              <Input
                className="w-24"
                type="number"
                min={1 / 60}
                max={60}
                step={0.5}
                value={ringDraft}
                onChange={(e) => setRingDraft(e.target.value)}
                aria-label="Ring lap duration in minutes"
              />
            </label>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingRing(false)}>
                Cancel
              </Button>
              <DialogClose
                render={
                  <Button variant="primary" onClick={commitRingDraft}>
                    Save
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
