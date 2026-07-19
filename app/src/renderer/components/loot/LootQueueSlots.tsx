import { useTranslation } from "react-i18next";
import type { AutoClassifyStatePayload, BoxSlotStatus, ChestState } from "../../../../shared/types";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { CapacityBar } from "../../design-system/primitives/CapacityBar/CapacityBar";
import { Card } from "../../design-system/primitives/Card/Card";

/**
 * Queue categories shown in the slot summary. Excludes `unclassified` (which
 * has no chest slot / drop rate) — only the three real chest categories are
 * rendered.
 */
type QueueCategory = "common" | "rare" | "act";

/**
 * Per-category slot view for the auto-classify queue. Replaces the older
 * per-chest `LootQueueList` with an aggregate "chest slots" style layout
 * inspired by the Chests tab: one compact row per category (common / rare /
 * act) showing current/capacity, the head chest's auto-open countdown, the
 * estimated queue-clear time, and the estimated time for the slot to fill.
 *
 * Data sources:
 *  - `queue.byCategory` — head chest auto-open countdown + queued count
 *    (polled at 1 Hz via `getAutoClassifyState`).
 *  - `chests` — `ChestState` from `useChests()` providing per-category
 *    `BoxSlotStatus` (quantity / capacity / isFull) and effective auto-open
 *    seconds.
 *  - `dropsPerHour` — per-category drop rate from `stats.chestDrops`, used to
 *    estimate slot-fill time. `act` has no rate (boss drops aren't periodic),
 *    so it surfaces as `null` and the UI shows "—".
 *
 * The mapping between queue `BoxCategory` ("common" / "rare" / "act") and
 * `ChestState` slot keys ("common" / "stageBoss" / "actBoss") is fixed and
 * encoded in `SLOT_ROWS` below.
 */

/** Format ms as m:ss, clamping negatives to 0. Returns "—" for null. */
function formatCountdown(ms: number | null): string {
  if (ms == null) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Format hours as a compact human-readable duration. Returns "—" for null. */
function formatHours(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "—";
  if (hours <= 0) return "—";
  if (hours < 1 / 60) return "< 1m";
  if (hours < 1) return `~${Math.round(hours * 60)}m`;
  if (hours < 24) return `~${hours.toFixed(1)}h`;
  return `~${Math.round(hours / 24)}d`;
}

interface SlotRow {
  /** Queue category (matches `AutoClassifyStatePayload.byCategory[].category`). */
  queueCategory: QueueCategory;
  /** ChestState slot key for this category. */
  slotKey: "common" | "stageBoss" | "actBoss";
  /** i18n key under `loot:category` for this category's label. */
  labelKey: "common" | "rare" | "act";
  /** CapacityBar fill color. */
  fillVariant: "gray" | "blue" | "red";
}

const SLOT_ROWS: readonly SlotRow[] = [
  { queueCategory: "common", slotKey: "common", labelKey: "common", fillVariant: "gray" },
  { queueCategory: "rare", slotKey: "stageBoss", labelKey: "rare", fillVariant: "blue" },
  { queueCategory: "act", slotKey: "actBoss", labelKey: "act", fillVariant: "red" },
];

interface LootQueueSlotsProps {
  /** Polled at 1 Hz from `window.tbh.getAutoClassifyState()`. */
  queue: AutoClassifyStatePayload;
  /** Live chest slot state from `useChests()`. `null` while waiting for save. */
  chests: ChestState | null;
  /**
   * Per-category drop rate (chests/hour). `common` and `rare` come from
   * `stats.chestDrops.commonPerHour` / `rarePerHour`; `act` has no periodic
   * drop rate so it should be `null`.
   */
  dropsPerHour: { [K in QueueCategory]: number | null };
}

export function LootQueueSlots({ queue, chests, dropsPerHour }: LootQueueSlotsProps) {
  const { t } = useTranslation("loot");

  return (
    <Card padding="default" className="flex h-full flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("queueSlots.title")}
      </div>
      <div className="flex flex-col gap-1.5">
        {SLOT_ROWS.map((row) => {
          const queueEntry = queue.byCategory.find((c) => c.category === row.queueCategory);
          const queuedCount = queueEntry?.count ?? 0;
          const nextAutoOpenInMs = queueEntry?.nextAutoOpenInMs ?? null;

          const slot: BoxSlotStatus | null = chests?.[row.slotKey] ?? null;
          const autoOpenSeconds = chests?.autoOpen?.[row.slotKey] ?? null;

          const quantity = slot?.quantity ?? 0;
          const capacity = slot?.capacity ?? 0;
          const isFull = slot?.isFull ?? false;
          const pct = capacity > 0 ? Math.min(100, (quantity / capacity) * 100) : 0;

          // Queue clears-in: time for every queued chest of this category to
          // auto-open. Head opens in `nextAutoOpenInMs`; each subsequent chest
          // opens `autoOpenSeconds` later (serial per-category auto-open).
          // `null` when the queue is empty or auto-open seconds are unknown.
          let clearsInMs: number | null = null;
          if (queuedCount > 0 && nextAutoOpenInMs != null && autoOpenSeconds != null) {
            clearsInMs = nextAutoOpenInMs + (queuedCount - 1) * autoOpenSeconds * 1000;
          }

          // Slots fill-in: time for `quantity` to reach `capacity` based on
          // the observed drop rate. `null` when already full, no rate, or
          // rate <= 0 (queue would drain instead of fill).
          let fillsInHours: number | null = null;
          const rate = dropsPerHour[row.queueCategory];
          if (slot != null && !isFull && rate != null && rate > 0) {
            const slotsRemaining = Math.max(0, capacity - quantity);
            fillsInHours = slotsRemaining / rate;
          }

          return (
            <div
              key={row.queueCategory}
              className="flex flex-col gap-1 border-b border-border/40 py-1.5 last:border-b-0 last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-text">
                    {t(`category.${row.labelKey}`)}
                  </span>
                  {isFull && <Badge>{t("queueSlots.full")}</Badge>}
                </div>
                <span
                  className="text-[13px] font-semibold tabular-nums text-text"
                  aria-label={t("queueSlots.slotsAria", { used: quantity, capacity })}
                >
                  {quantity} / {capacity}
                </span>
              </div>
              <CapacityBar
                percent={pct}
                variant={row.fillVariant}
                compact
                role="progressbar"
                aria-valuenow={quantity}
                aria-valuemin={0}
                aria-valuemax={capacity}
              />
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                <span>
                  {t("queueSlots.opensIn")}{" "}
                  <span className="font-medium tabular-nums text-text">
                    {formatCountdown(nextAutoOpenInMs)}
                  </span>
                </span>
                <span>
                  {t("queueSlots.clearsIn")}{" "}
                  <span className="font-medium tabular-nums text-text">
                    {formatCountdown(clearsInMs)}
                  </span>
                </span>
                <span>
                  {t("queueSlots.fillsIn")}{" "}
                  <span className="font-medium tabular-nums text-text">
                    {formatHours(fillsInHours)}
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
