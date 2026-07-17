// Compact "Recent drops" strip for the Loot tab. Shows the last N recorded
// box-open outcomes across all boxKeys (newest first), each line giving the
// item name (grade-colored, with an ItemCard peek tooltip), count, source
// chest label, and wall-clock time.

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
      <ul className="m-0 flex flex-col gap-1 p-0">
        {drops.map((d, i) => {
          const color = d.grade ? gradeColor(d.grade) : undefined;
          const catalogItem = itemIndex.get(d.itemKey);
          return (
            <li
              key={`${d.wallTime}-${d.itemKey}-${i}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]"
            >
              <span
                className="inline-block size-[9px] shrink-0 rounded-full"
                style={{ background: color ?? gradeColor("UNKNOWN") }}
                aria-hidden
              />
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
              {d.count > 1 && <span className="text-muted">×{d.count}</span>}
              <span className="text-muted">·</span>
              <span className="text-muted">{boxLabel(d.boxKey)}</span>
              <span className="text-muted">·</span>
              <span className="text-muted tabular-nums">{fmtClock(d.wallTime)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
