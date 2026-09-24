import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChests } from "../lib/useChests";
import { useLookupSources } from "../lib/useLookupSources";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { HeldChestsSection } from "../components/chests/HeldChestsSection";
import { ChestCatalogSection } from "../components/chests/ChestCatalogSection";
import { ChestCategoryCard } from "../components/chests/ChestCategoryCard";

// Re-exported so existing import sites keep working; the card now lives in
// `components/chests/` and is shared with the web ChestsPanel.
export { ChestCategoryCard };

export function Chests() {
  const { t } = useTranslation("chests");
  const chests = useChests();
  const sources = useLookupSources();

  // Box itemKey → held quantity, to badge owned chests in the catalog section.
  const heldQuantities = useMemo(() => {
    const m = new Map<number, number>();
    for (const row of chests?.rows ?? []) m.set(row.boxType, row.quantity);
    return m;
  }, [chests]);

  if (!chests) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">{t("tabTitle")}</h1>
        <p className="m-0 text-muted">{t("waiting")}</p>
      </div>
    );
  }

  const { common, stageBoss, actBoss, plagueCommon, plagueRare, plagueAct, totalHeld } = chests;

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
            autoOpenSeconds={chests.autoOpen.common}
            fillVariant="gray"
          />
          <ChestCategoryCard
            title={t("category.stageBoss")}
            slot={stageBoss}
            breakdown={chests.capacity.stageBoss}
            autoOpenSeconds={chests.autoOpen.stageBoss}
            fillVariant="blue"
          />
          <ChestCategoryCard
            title={t("category.actBoss")}
            slot={actBoss}
            breakdown={chests.capacity.actBoss}
            autoOpenSeconds={chests.autoOpen.actBoss}
            fillVariant="red"
          />
          <ChestCategoryCard
            title={t("category.plagueCommon")}
            slot={plagueCommon}
            breakdown={chests.capacity.plagueCommon}
            autoOpenSeconds={chests.autoOpen.plagueCommon}
            fillVariant="green"
          />
          <ChestCategoryCard
            title={t("category.plagueRare")}
            slot={plagueRare}
            breakdown={chests.capacity.plagueRare}
            autoOpenSeconds={chests.autoOpen.plagueRare}
            fillVariant="green"
          />
          <ChestCategoryCard
            title={t("category.plagueAct")}
            slot={plagueAct}
            breakdown={chests.capacity.plagueAct}
            autoOpenSeconds={chests.autoOpen.plagueAct}
            fillVariant="green"
          />
        </div>
        {chests.orphanExclusions && chests.orphanExclusions.act > 0 ? (
          <p className="m-0 text-xs text-muted">
            {t("orphanExcluded", { count: chests.orphanExclusions.act })}
          </p>
        ) : null}
      </section>

      <HeldChestsSection chests={chests} sources={sources} />
      <ChestCatalogSection sources={sources} heldQuantities={heldQuantities} />
    </TabPage>
  );
}
