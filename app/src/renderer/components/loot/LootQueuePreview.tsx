// Box-queue ("stargaze") prediction preview — renders the not-yet-consumed
// predicted drops for one chest card as a horizontally scrollable strip of
// item icons. Sits inside LootBoxSection as a collapsed-by-default footer.
//
// Pure presentational: receives an array of BoxQueueItem (itemKey + optional
// gradeType) plus a lookup itemIndex for name/icon/grade resolution. When
// the queue is empty, shows a status line ("waiting for prediction" / reason)
// so the user knows the feature is active.

import { useState } from "react";
import type { BoxQueueItem, BoxQueueSnapshot, LookupItem } from "../../../../shared/types";
import { GRADE_ORDER } from "../../../core/grades";
import { gradeColor } from "../../lib/gradeColor";
import { iconSrc } from "../../lib/iconSrc";
import { useEntityPanel } from "../../context/entityPanelContext";
import { ItemIcon } from "../../design-system/primitives/ItemIcon/ItemIcon";
import { cn } from "../../lib/cn";

/**
 * Max items to render in the expanded strip. The core scanner caps each
 * bucket at 64 entries (MAX_ITEMS_PER_BUCKET), so we mirror that here — the
 * strip is horizontally scrollable so all rendered items are reachable
 * without overflowing the card's width.
 */
const MAX_RENDERED_ITEMS = 64;

/**
 * Resolve a `gradeType` integer (0=COMMON, 1=UNCOMMON, ...) to the catalog
 * grade string. Returns null when out of range — the caller falls back to
 * the catalog grade of the resolved LookupItem.
 */
function gradeFromType(gradeType: number | undefined): string | null {
  if (gradeType == null || gradeType < 0 || gradeType >= GRADE_ORDER.length) return null;
  return GRADE_ORDER[gradeType]!;
}

/** Human-readable reason for each non-ok status, shown when the queue is empty. */
function statusReason(status: BoxQueueSnapshot["status"] | null | undefined): string {
  switch (status) {
    case "class_not_found":
      return "预测类未找到（游戏版本不兼容）";
    case "instance_lost":
      return "等待扫描堆内存定位队列实例…";
    case "scan_failed":
      return "堆扫描未找到实例，将在 30 秒后重试";
    case "ok":
      return "";
    default:
      return "等待预测数据…";
  }
}

export function LootQueuePreview({
  items,
  itemIndex,
  status,
}: {
  /** Predicted drops, head-first (items[0] is the next drop). */
  items: ReadonlyArray<BoxQueueItem>;
  /** Lookup catalog index, keyed by item id — same one LootBoxSection uses. */
  itemIndex: Map<number, LookupItem>;
  /** Scanner status from the live reader — drives the empty-state message. */
  status?: BoxQueueSnapshot["status"] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { open: openEntity } = useEntityPanel();

  const isEmpty = items.length === 0;
  const reason = isEmpty ? statusReason(status) : "";

  // Cap rendered items at MAX_RENDERED_ITEMS to bound DOM size; the container
  // is `overflow-x-auto` so the user can scroll to see every rendered icon.
  const rendered = items.slice(0, MAX_RENDERED_ITEMS);

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between rounded text-[11px] uppercase tracking-wide text-muted hover:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ideal/50"
        aria-expanded={expanded}
      >
        <span>
          {isEmpty
            ? `预测掉落 · ${reason}`
            : expanded
              ? "收起预测掉落"
              : `预测掉落 · 下一件 +${items.length}`}
        </span>
        <span className="text-[10px]">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && !isEmpty && (
        <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
          {rendered.map((item, i) => {
            const catalogItem = itemIndex.get(item.itemKey);
            const grade = gradeFromType(item.gradeType) ?? catalogItem?.grade ?? "UNKNOWN";
            const color = gradeColor(grade);
            const name = catalogItem?.name ?? `#${item.itemKey}`;
            return (
              <button
                key={`${item.itemKey}-${i}`}
                type="button"
                onClick={() => openEntity({ type: "item", id: item.itemKey })}
                title={name}
                className={cn(
                  "group relative flex shrink-0 flex-col items-center gap-0.5 rounded p-0.5",
                  "hover:bg-ideal/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ideal/50",
                )}
              >
                <ItemIcon
                  src={catalogItem ? iconSrc(catalogItem.iconPath) : ""}
                  color={color}
                  size="sm"
                />
                <span
                  className="block size-1.5 rounded-full"
                  style={{ background: color }}
                  aria-label={grade}
                />
              </button>
            );
          })}
        </div>
      )}
      {expanded && isEmpty && <p className="mt-1.5 text-[10px] text-muted/70">{reason}</p>}
    </div>
  );
}
