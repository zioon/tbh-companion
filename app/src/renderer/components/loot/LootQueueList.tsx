// Detailed "auto-classify queue" list for the Loot tab. Shows each dropped
// chest awaiting its open event, with the source box label, the remaining
// time until the chest auto-opens, and when the queue entry expires (TTL).
// Pure presentational component — the data comes from `useLoot`'s polling
// of `getAutoClassifyState` (1 Hz).
//
// Uses a real <table> (not fl/grid) so the columns (chest / opens in / expires)
// align vertically across rows — and across the sibling Recent drops card,
// which uses the same column structure (name / count / source / time).

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
        <table className="m-0 w-full border-collapse text-[13px]">
          <tbody>
            {items.map((item, i) => (
              <tr key={`${item.boxKey}-${item.droppedAtMs}-${i}`} className="align-baseline">
                <td className="truncate py-0.5 pr-3 font-medium text-text">
                  {boxLabel(item.boxKey)}
                </td>
                <td className="whitespace-nowrap py-0.5 pr-3 text-right text-muted">opens in</td>
                <td className="whitespace-nowrap py-0.5 pr-3 text-right tabular-nums font-medium text-ideal">
                  {formatCountdown(item.autoOpenInMs)}
                </td>
                <td className="whitespace-nowrap py-0.5 pr-3 text-right text-muted">expires in</td>
                <td className="whitespace-nowrap py-0.5 text-right text-muted tabular-nums">
                  {formatCountdown(item.expiresInMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
