import { useTranslation } from "react-i18next";
import type {
  AutoClassifyStatePayload,
  BoxSlotStatus,
  ChestState,
  LiveChestSlots,
} from "../../../../shared/types";
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
   * Live per-category chest slot counts from `PlayerSaveData.BoxData` runtime
   * (5 Hz via LiveMemorySnapshot). When non-null, the renderer prefers these
   * over the save-derived `slot.quantity` for the "current/capacity" display —
   * this gives second-level responsiveness to manual opens and auto-opens
   * (save path has tens-of-seconds latency).
   *
   * `null` = live path unavailable this tick → fall back to `slot.quantity`.
   * `capacity` always comes from `slot.capacity` (save path is authoritative
   * for rune-purchased cap increases, which are low-frequency).
   */
  liveChestSlots?: LiveChestSlots | null;
  /**
   * Per-category drop rate (chests/hour). `common` and `rare` come from
   * `stats.chestDrops.commonPerHour` / `rarePerHour`; `act` has no periodic
   * drop rate so it should be `null`.
   */
  dropsPerHour: { [K in QueueCategory]: number | null };
}

export function LootQueueSlots({ queue, chests, liveChestSlots, dropsPerHour }: LootQueueSlotsProps) {
  const { t } = useTranslation("loot");

  return (
    <Card padding="default" className="flex h-full flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("queueSlots.title")}
      </div>
      <div className="flex flex-col gap-1.5">
        {SLOT_ROWS.map((row) => {
          const queueEntry = queue.byCategory.find((c) => c.category === row.queueCategory);
          const nextAutoOpenInMs = queueEntry?.nextAutoOpenInMs ?? null;
          const lastAutoOpenInMs = queueEntry?.lastAutoOpenInMs ?? null;

          const slot: BoxSlotStatus | null = chests?.[row.slotKey] ?? null;

          // Live quantity takes precedence when available (5 Hz); falls back to
          // save-derived `slot.quantity` when the live path is unavailable this
          // tick (offsets not derived / pointer walk failed / reader detached).
          // `capacity` always comes from save (rune-purchased cap is
          // low-frequency, save path is authoritative).
          const saveQuantity = slot?.quantity ?? 0;
          const liveQuantity = liveChestSlots?.[row.queueCategory];
          const quantity = liveQuantity ?? saveQuantity;
          const capacity = slot?.capacity ?? 0;
          // `isFull` re-derived from the merged quantity + save capacity so the
          // "Full" badge reflects the live state, not the stale save state.
          const isFull = capacity > 0 ? quantity >= capacity : false;
          const pct =
            capacity > 0 ? Math.min(100, (quantity / capacity) * 100) : 0;

          // Queue clears-in: under the slot-parallel model every queued chest
          // has its own independent timer. The queue is fully cleared when
          // the latest-opening (tail) chest auto-opens, so `clearsInMs` is
          // simply the tail item's remaining time. `null` when the queue is
          // empty.
          const clearsInMs = lastAutoOpenInMs;

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
