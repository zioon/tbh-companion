// Detailed "auto-classify queue" list for the Loot tab. Shows each dropped
// chest awaiting its open event, with the source box label, the remaining
// time until the chest auto-opens, and when the queue entry expires (TTL).
// Pure presentational component — the data comes from `useLoot`'s polling
// of `getAutoClassifyState` (1 Hz).

import type { AutoClassifyQueueItem } from "../../../../shared/types";
import { boxLabel } from "../../../core/boxOpenLog";
import { Card } from "../../design-system/primitives/Card/Card";

/** Format ms as m:ss, clamping negatives to 0. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function LootQueueList({ items }: { items: ReadonlyArray<AutoClassifyQueueItem> }) {
  return (
    <Card padding="default" className="flex h-full flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        Auto-classify queue
      </div>
      {items.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">No chests waiting.</p>
      ) : (
        <ul className="m-0 flex flex-col gap-1 p-0">
          {items.map((item, i) => (
            <li
              key={`${item.boxKey}-${item.droppedAtMs}-${i}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]"
            >
              <span className="font-medium text-text">{boxLabel(item.boxKey)}</span>
              <span className="text-muted">·</span>
              <span className="text-muted">opens in</span>
              <span className="tabular-nums font-medium text-ideal">
                {formatCountdown(item.autoOpenInMs)}
              </span>
              <span className="text-muted">·</span>
              <span className="text-muted">expires in</span>
              <span className="text-muted tabular-nums">{formatCountdown(item.expiresInMs)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
