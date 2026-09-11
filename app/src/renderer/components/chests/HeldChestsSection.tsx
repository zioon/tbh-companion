import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChestState, LookupBoxSources, LookupSources } from "../../../../shared/types";
import { Badge } from "../../design-system/primitives/Badge/Badge";
import { Card } from "../../design-system/primitives/Card/Card";
import { useEntityPanel } from "../../context/entityPanelContext";
import { BoxCardHeader } from "../lookup/BoxCardParts";
import { localizedBoxName } from "../../lib/boxDisplay";
import { chestCategoryLabelKey, CHEST_GROUPS, type ChestGroupCategory } from "../../lib/chests";

/**
 * Filter `rows` down to those belonging to a known chest group; rows with an
 * unrecognized category (e.g. `unclassified`) are returned separately.
 */
function splitHeldRows(chests: ChestState | null): {
  groups: Map<ChestGroupCategory, ChestState["rows"]>;
  leftover: ChestState["rows"];
} {
  const groups = new Map<ChestGroupCategory, ChestState["rows"]>();
  for (const cat of CHEST_GROUPS) groups.set(cat, []);
  const leftover: ChestState["rows"] = [];
  for (const row of chests?.rows ?? []) {
    const cat = CHEST_GROUPS.find((c) => c === row.category);
    if (cat) groups.get(cat)!.push(row);
    else leftover.push(row);
  }
  return { groups, leftover };
}

function HeldChestCard({
  boxType,
  rowLabel,
  quantity,
  box,
}: {
  boxType: number;
  rowLabel: string;
  quantity: number;
  box: LookupBoxSources | undefined;
}) {
  const { open } = useEntityPanel();
  const { t } = useTranslation("chests");
  const { t: tLookup } = useTranslation("lookup");

  return (
    <button
      type="button"
      disabled={box == null}
      onClick={() => (box != null ? open({ type: "box", id: boxType }) : undefined)}
      className="flex w-full text-left"
    >
      <Card padding="compact" className={cnHeldCard(box != null)}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {box != null ? (
              <BoxCardHeader
                box={box}
                boxItemKey={boxType}
                iconSize="md"
                nameOverride={localizedBoxName(tLookup, box, boxType)}
              />
            ) : (
              <p className="m-0 truncate text-[13px] font-medium text-fg">{rowLabel}</p>
            )}
          </div>
          <Badge>{t("heldQty", { count: quantity })}</Badge>
        </div>
        {box == null ? <p className="m-0 text-[11px] text-muted">{t("heldNoDetail")}</p> : null}
      </Card>
    </button>
  );
}

function cnHeldCard(clickable: boolean): string {
  return clickable
    ? "flex h-full w-full cursor-pointer flex-col gap-1.5 transition-colors hover:border-accent/60"
    : "flex h-full w-full flex-col gap-1.5";
}

export function HeldChestsSection({
  chests,
  sources,
}: {
  chests: ChestState | null;
  sources: LookupSources | null;
}) {
  const { t } = useTranslation("chests");

  const boxIndex = sources?.boxes;
  const { groups, leftover } = useMemo(() => splitHeldRows(chests), [chests]);

  return (
    <section aria-labelledby="chest-held-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="chest-held-heading" className="m-0 text-sm font-semibold">
          {t("heldHeading")}
        </h2>
        <p className="m-0 text-xs text-muted">{t("heldIntro")}</p>
      </div>

      {CHEST_GROUPS.map((cat) => {
        const rows = groups.get(cat)!;
        if (rows.length === 0) return null;
        return (
          <div key={cat} className="flex flex-col gap-2">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg/70">
              {t(chestCategoryLabelKey(cat))}
              <span className="ml-1.5 text-muted normal-case">
                {t("catalogItemsCount", { count: rows.length })}
              </span>
            </h3>
            <div className="grid grid-cols-2 items-stretch gap-2.5 max-[720px]:grid-cols-1">
              {rows.map((row) => (
                <HeldChestCard
                  key={row.boxType}
                  boxType={row.boxType}
                  rowLabel={boxIndex?.[String(row.boxType)]?.name ?? row.label}
                  quantity={row.quantity}
                  box={boxIndex?.[String(row.boxType)]}
                />
              ))}
            </div>
          </div>
        );
      })}

      {leftover.length > 0 ? (
        <div className="grid grid-cols-2 items-stretch gap-2.5 max-[720px]:grid-cols-1">
          {leftover.map((row) => (
            <HeldChestCard
              key={row.boxType}
              boxType={row.boxType}
              rowLabel={row.label}
              quantity={row.quantity}
              box={boxIndex?.[String(row.boxType)]}
            />
          ))}
        </div>
      ) : null}

      {chests != null && chests.rows.length === 0 ? (
        <p className="m-0 text-xs text-muted">{t("heldEmpty")}</p>
      ) : null}
    </section>
  );
}
