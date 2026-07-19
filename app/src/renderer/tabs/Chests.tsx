import { useTranslation } from "react-i18next";
import { useChests } from "../lib/useChests";
import type { BoxSlotStatus, ChestCapacityBreakdown } from "../../../shared/types";
import { Badge } from "../design-system/primitives/Badge/Badge";
import { CapacityBar } from "../design-system/primitives/CapacityBar/CapacityBar";
import { Card } from "../design-system/primitives/Card/Card";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { ChestsTrackerPanel } from "../components/ChestsTrackerPanel";

function capacityParts(
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

function ChestCategoryCard({
  title,
  slot,
  breakdown,
  fillVariant,
}: {
  title: string;
  slot: BoxSlotStatus;
  breakdown: ChestCapacityBreakdown;
  fillVariant: "gray" | "blue" | "red";
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
      <div className="mt-auto flex flex-col gap-0.5 pt-2">
        <p className="m-0 text-xs font-semibold text-fg/80">{t("capacityDetails")}</p>
        <p className="m-0 text-xs text-muted">{capacityParts(t, breakdown).join(", ")}</p>
      </div>
    </Card>
  );
}

export function Chests() {
  const { t } = useTranslation("chests");
  const chests = useChests();

  if (!chests) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">{t("tabTitle")}</h1>
        <p className="m-0 text-muted">{t("waiting")}</p>
      </div>
    );
  }

  const { common, stageBoss, actBoss, totalHeld } = chests;

  return (
    <TabPage>
      <TabHeader title={t("tabTitle")} intro={t("intro", { count: totalHeld.toLocaleString() })} />

      <section aria-labelledby="chest-slots-heading" className="flex flex-col gap-2">
        <h2 id="chest-slots-heading" className="m-0 text-sm font-semibold">
          {t("chestSlotsHeading")}
        </h2>
        <div className="grid grid-cols-3 items-stretch gap-2.5 max-[720px]:grid-cols-1">
          <ChestCategoryCard
            title={t("category.common")}
            slot={common}
            breakdown={chests.capacity.common}
            fillVariant="gray"
          />
          <ChestCategoryCard
            title={t("category.stageBoss")}
            slot={stageBoss}
            breakdown={chests.capacity.stageBoss}
            fillVariant="blue"
          />
          <ChestCategoryCard
            title={t("category.actBoss")}
            slot={actBoss}
            breakdown={chests.capacity.actBoss}
            fillVariant="red"
          />
        </div>
      </section>

      <ChestsTrackerPanel />
    </TabPage>
  );
}
