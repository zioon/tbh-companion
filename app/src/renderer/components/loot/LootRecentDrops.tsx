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
    <Card padding="default" className="flex h-full flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("recentDrops.title")}
      </div>
      <div className="max-h-[220px] overflow-y-auto">
        <table className="m-0 w-full border-collapse text-[13px]">
          <tbody>
            {drops.map((d, i) => {
              const color = d.grade ? gradeColor(d.grade) : undefined;
              const catalogItem = itemIndex.get(d.itemKey);
              return (
                <tr key={`${d.wallTime}-${d.itemKey}-${i}`} className="align-baseline">
                  <td
                    className="size-[9px] shrink-0 rounded-full py-0.5 pr-2"
                    style={{ background: color ?? gradeColor("UNKNOWN") }}
                    aria-hidden
                  />
                  <td className="truncate py-0.5 pr-3">
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
                        className="font-medium"
                        style={color ? { color } : undefined}
                        title={d.itemName}
                      >
                        {d.itemName}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-0.5 pr-3 text-right text-muted">
                    {d.count > 1 ? `×${d.count}` : ""}
                  </td>
                  <td className="whitespace-nowrap py-0.5 pr-3 text-right text-muted">
                    {translateBoxLabel(t, d.boxKey)}
                  </td>
                  <td className="whitespace-nowrap py-0.5 text-right text-muted tabular-nums">
                    {fmtClock(d.wallTime)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
