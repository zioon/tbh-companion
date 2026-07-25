import { useTranslation } from "react-i18next";
import type { BoxOpenHistoryEntry, LookupItem } from "../../../../shared/types";
import { translateBoxLabel } from "../../lib/boxLabel";
import { Card } from "../../design-system/primitives/Card/Card";
import { fmtClock } from "../../lib/format";
import { gradeColor } from "../../lib/gradeColor";
import { useEntityPanel } from "../../context/entityPanelContext";
import { ItemLink } from "../ItemLink";

export function LootRecentDrops({
  drops,
  itemIndex,
}: {
  drops: BoxOpenHistoryEntry[];
  itemIndex: Map<number, LookupItem>;
}) {
  const { t } = useTranslation("loot");
  const { open: openEntity } = useEntityPanel();

  if (drops.length === 0) return null;
  return (
    <Card padding="none" className="relative overflow-hidden">
      {/*
        Grid track sizing: an auto row track sizes to the max-content of its
        items. If this Card's content flowed normally, a long drop list would
        inflate the track and the Card would grow instead of scrolling. By
        absolutely positioning the inner content, the Card's max-content
        contribution becomes 0, so the track height is driven solely by the
        left card (LootQueueSlots). The Card then stretches to that track
        height (grid default `align-self: stretch`) and the absolute inner
        layer fills it, scrolling when content overflows.
      */}
      <div className="absolute inset-0 flex flex-col gap-1.5 p-3">
        <div className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
          {t("recentDrops.title")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <table className="m-0 w-full border-collapse text-[13px]">
            <tbody>
              {drops.map((d, i) => {
                const color = d.grade ? gradeColor(d.grade) : undefined;
                const catalogItem = itemIndex.get(d.itemKey);
                return (
                  <tr key={`${d.wallTime}-${d.itemKey}-${i}`} className="align-baseline">
                    <td className="truncate px-3 py-2">
                      {catalogItem ? (
                        <ItemLink
                          node={{ type: "item", id: d.itemKey }}
                          name={d.itemName}
                          grade={d.grade}
                          iconPath={catalogItem.iconPath}
                          onNavigate={() => openEntity({ type: "item", id: d.itemKey })}
                          peekItem={(id) => itemIndex.get(id)}
                        />
                      ) : (
                        <span
                          className="inline-flex items-center gap-1.5 font-medium"
                          style={color ? { color } : undefined}
                          title={d.itemName}
                        >
                          <span
                            className="size-[9px] shrink-0 rounded-full"
                            style={{ background: color ?? gradeColor("UNKNOWN") }}
                            aria-hidden
                          />
                          <span className="min-w-0 truncate">{d.itemName}</span>
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-muted">
                      {d.count > 1 ? `×${d.count}` : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-muted">
                      {translateBoxLabel(t, d.boxKey)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-muted tabular-nums">
                      {fmtClock(d.wallTime)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
