// Compact "Recent drops" strip for the Loot tab. Shows the last N recorded
// box-open outcomes across all boxKeys (newest first), each row giving the
// item name (grade-colored, with an ItemCard peek tooltip), count, source
// chest label, and wall-clock time.
//
// Uses a real <table> matching the sibling LootQueueList layout (name / label
// / label / value) so each column aligns vertically across rows and across
// the two cards when they sit side-by-side.

import { useMemo } from "react";
import type { BoxOpenHistoryEntry } from "../../../../shared/types";
import { boxLabel } from "../../../core/boxOpenLog";
import { Card } from "../../design-system/primitives/Card/Card";
import { fmtClock } from "../../lib/format";
import { gradeColor } from "../../lib/gradeColor";
import { useLookupCatalog } from "../../lib/useLookupCatalog";
import { useEntityPanel } from "../../context/entityPanelContext";
import { ItemLink } from "../ItemLink";

export function LootRecentDrops({ drops }: { drops: BoxOpenHistoryEntry[] }) {
  const catalog = useLookupCatalog();
  const { open: openEntity } = useEntityPanel();
  const itemIndex = useMemo(
    () => new Map((catalog ?? []).map((item) => [item.id, item])),
    [catalog],
  );

  if (drops.length === 0) return null;
  return (
    <Card padding="default" className="flex h-full flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">Recent drops</div>
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
                  {boxLabel(d.boxKey)}
                </td>
                <td className="whitespace-nowrap py-0.5 text-right text-muted tabular-nums">
                  {fmtClock(d.wallTime)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
