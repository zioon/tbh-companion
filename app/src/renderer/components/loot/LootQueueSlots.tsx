import { useTranslation } from "react-i18next";
import type {
  AutoClassifyStatePayload,
  BoxSlotStatus,
  ChestAutoOpenPrefs,
  ChestState,
} from "../../../../shared/types";
import type { PredictFillTimeResult } from "../../../core/inventory/predictFillTime";
import { fmtFillEta, fmtHoursUntilFull } from "../../lib/format";
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
  /**
   * Inventory capacity/used from `useInventory()`. When `null` (no save yet)
   * the inventory row is hidden. The auto-open setting is shared with the
   * Live tab (`config.chestAutoOpenEnabled`) — the Loot tab does not expose
   * its own toggle, it just reads the Live tab's result.
   */
  inventory: { inventoryCapacity: number; inventoryUsed: number } | null;
  /** Auto-open prefs mirrored from `config.chestAutoOpenEnabled` (Live tab). */
  autoOpenEnabled: ChestAutoOpenPrefs;
  /** Output of `predictFillTime()` for the inventory. `null` while data missing. */
  fillPrediction: PredictFillTimeResult | null;
}

export function LootQueueSlots({
  queue,
  chests,
  dropsPerHour,
  inventory,
  autoOpenEnabled,
  fillPrediction,
}: LootQueueSlotsProps) {
  const { t } = useTranslation("loot");

  return (
    <Card padding="default" className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("queueSlots.title")}
      </div>
      <div className="flex flex-col gap-1.5">
        {SLOT_ROWS.map((row) => {
          const queueEntry = queue.byCategory.find((c) => c.category === row.queueCategory);
          const nextAutoOpenInMs = queueEntry?.nextAutoOpenInMs ?? null;
          const lastAutoOpenInMs = queueEntry?.lastAutoOpenInMs ?? null;

          const slot: BoxSlotStatus | null = chests?.[row.slotKey] ?? null;

          // Live quantity (from AutoClassifyService.liveSlots) takes precedence
          // when available — it's recalibrated on every save parse, then
          // adjusted in real-time: +1 on chest drop, -1 on auto-open timer
          // elapse, -1 on detected manual open via unclassified burst. Falls
          // back to save-derived `slot.quantity` when liveSlots is null (before
          // the first save parse completes).
          // `capacity` always comes from save (rune-purchased cap is
          // low-frequency, save path is authoritative).
          const saveQuantity = slot?.quantity ?? 0;
          const liveQuantity = queue.liveSlots?.[row.queueCategory];
          const quantity = liveQuantity ?? saveQuantity;
          const capacity = slot?.capacity ?? 0;
          // `isFull` re-derived from the merged quantity + save capacity so the
          // "Full" badge reflects the live state, not the stale save state.
          const isFull = capacity > 0 ? quantity >= capacity : false;
          const pct = capacity > 0 ? Math.min(100, (quantity / capacity) * 100) : 0;

          // Queue clears-in: under the serial-queue model the tail's auto-open
          // moment is head + (depth-1) * autoOpenSeconds, so `clearsInMs` is
          // the time until the last queued chest opens (queue fully drains).
          // `null` when the queue is empty. When `queue.paused` is true the
          // game's auto-open timer is frozen (inventory full); the main process
          // still reports the frozen countdown, but we surface "Paused" instead
          // of a stale 0:00 / clamped value to make the state obvious.
          const clearsInMs = lastAutoOpenInMs;
          const pausedLabel = queue.paused ? t("queueSlots.paused") : null;

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
                    {pausedLabel ?? formatCountdown(nextAutoOpenInMs)}
                  </span>
                </span>
                <span>
                  {t("queueSlots.clearsIn")}{" "}
                  <span className="font-medium tabular-nums text-text">
                    {pausedLabel ?? formatCountdown(clearsInMs)}
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

      {inventory && inventory.inventoryCapacity > 0 && (
        <InventoryRow
          capacity={inventory.inventoryCapacity}
          used={inventory.inventoryUsed}
          autoOpenEnabled={autoOpenEnabled}
          fillPrediction={fillPrediction}
        />
      )}
    </Card>
  );
}

/**
 * Inventory slot summary row. Mirrors the Live tab's "inventory fill
 * prediction" but in the Loot tab's compact slot-row style. The auto-open
 * setting is shared with the Live tab — there's no toggle here, we just
 * reflect whatever the user picked on the Live tab.
 */
function InventoryRow({
  capacity,
  used,
  autoOpenEnabled,
  fillPrediction,
}: {
  capacity: number;
  used: number;
  autoOpenEnabled: ChestAutoOpenPrefs;
  fillPrediction: PredictFillTimeResult | null;
}) {
  const { t } = useTranslation("loot");
  const isFull = capacity > 0 && used >= capacity;
  const pct = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;

  // Hours-until-full text + ETA. Four states:
  // 1. Already full → "—" (the Full badge already conveys this).
  // 2. Auto-open is off for both chest types → tell the user to enable on Live tab.
  // 3. Prediction returned null (will never fill) → "—".
  // 4. Prediction returned a positive number → "<duration> — <clock time>".
  let fillText: string;
  if (isFull) {
    fillText = "—";
  } else if (!autoOpenEnabled.common && !autoOpenEnabled.stageBoss) {
    fillText = t("queueSlots.inventoryTurnOn");
  } else if (fillPrediction?.hoursUntilFull == null) {
    fillText = "—";
  } else {
    fillText = `${fmtHoursUntilFull(fillPrediction.hoursUntilFull)} — ${fmtFillEta(fillPrediction.hoursUntilFull)}`;
  }

  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text">
            {t("queueSlots.inventoryLabel")}
          </span>
          {isFull && <Badge>{t("queueSlots.inventoryFull")}</Badge>}
        </div>
        <span
          className="text-[13px] font-semibold tabular-nums text-text"
          aria-label={t("queueSlots.inventorySlotsAria", { used, capacity })}
        >
          {used} / {capacity}
        </span>
      </div>
      <CapacityBar
        percent={pct}
        variant="gray"
        compact
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={capacity}
      />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span>
          {t("queueSlots.inventoryFullIn")}{" "}
          <span className="font-medium tabular-nums text-text">{fillText}</span>
        </span>
      </div>
    </div>
  );
}
