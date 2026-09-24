// Chest slot/capacity card for one chest category (common, stage boss, act
// boss, plague variants). Shared by the desktop Chests tab and the web
// ChestsPanel — moved out of `renderer/tabs/Chests.tsx` verbatim so both
// surfaces render the identical card (holding count, capacity bar, remaining
// slots, auto-open time, capacity breakdown).

import { useTranslation } from "react-i18next";
import type { BoxSlotStatus, ChestCapacityBreakdown } from "../../../../shared/types";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { CapacityBar } from "../../design-system/primitives/CapacityBar/CapacityBar";
import { Card } from "../../design-system/primitives/Card/Card";
import { fmtShortDuration } from "../../lib/format";

/** "Base N" + optional "runes +M" parts of the capacity breakdown line. */
export function capacityParts(
  t: ReturnType<typeof useTranslation<"chests">>["t"],
  breakdown: ChestCapacityBreakdown,
): string[] {
  const parts = [t("capacityBase", { count: breakdown.base })];
  if (breakdown.runeBonus > 0) {
    parts.push(
      t("capacityRuneBonus", {
        bonus: breakdown.runeBonus,
        nodes: breakdown.purchasedCapRuneNodes,
        runeLabel: breakdown.runeLabel,
      }),
    );
  }
  return parts;
}

export function ChestCategoryCard({
  title,
  slot,
  breakdown,
  autoOpenSeconds,
  fillVariant,
}: {
  title: string;
  slot: BoxSlotStatus;
  breakdown: ChestCapacityBreakdown;
  /** Effective seconds this chest type takes to auto-open (base − rune reduction). */
  autoOpenSeconds: number;
  fillVariant: "gray" | "blue" | "red" | "green";
}) {
  const { t } = useTranslation("chests");
  const pct = slot.capacity > 0 ? Math.min(100, (slot.quantity / slot.capacity) * 100) : 0;

  return (
    <Card className="flex h-full flex-col">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="m-0 text-sm">{title}</h2>
        {slot.isFull ? <Badge>{t("full")}</Badge> : null}
      </div>
      <p
        className="mb-1.5 mt-0 text-lg font-semibold"
        aria-label={t("slotsAria", { used: slot.quantity, capacity: slot.capacity })}
      >
        {slot.quantity} / {slot.capacity}
      </p>
      <CapacityBar
        percent={pct}
        variant={fillVariant}
        compact
        role="progressbar"
        aria-valuenow={slot.quantity}
        aria-valuemin={0}
        aria-valuemax={slot.capacity}
      />
      <p className="m-0 mt-1.5 min-h-[1.125rem] text-xs text-muted">
        {!slot.isFull
          ? slot.slotsRemaining === 1
            ? t("slotsRemainingOne")
            : t("slotsRemaining", { count: slot.slotsRemaining })
          : "\u00a0"}
      </p>
      <p className="m-0 mt-1 text-xs text-muted">
        {t("autoOpenTime", { value: fmtShortDuration(autoOpenSeconds) })}
      </p>
      <div className="mt-auto flex flex-col gap-0.5 pt-2">
        <p className="m-0 text-xs font-semibold text-fg/80">{t("capacityDetails")}</p>
        <p className="m-0 text-xs text-muted">{capacityParts(t, breakdown).join(", ")}</p>
      </div>
    </Card>
  );
}
