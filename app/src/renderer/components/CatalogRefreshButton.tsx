import { useState } from "react";
import { Button } from "../design-system/primitives/Button/Button";
import { cn } from "../lib/cn";
import { reportIpcError } from "../lib/reportError";
import type { CatalogStatus } from "../../../shared/types";

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={cn("size-3.5 shrink-0", spinning && "animate-spin")}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V6h-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CatalogRefreshButton({
  status,
  onRefresh,
}: {
  status: CatalogStatus | null;
  onRefresh: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);

  async function handleClick(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await onRefresh();
    } catch (err) {
      reportIpcError(err, "catalog-refresh-button");
    } finally {
      setPending(false);
    }
  }

  const message = status?.lastError
    ? `Refresh failed: ${status.lastError}`
    : status?.lastRefreshMs
      ? `Refreshed ${status.itemCount} items${
          status.gameVersion ? ` for v${status.gameVersion}` : ""
        }`
      : null;

  return (
    <div className="flex items-center gap-2">
      <Button variant="default" type="button" disabled={pending} onClick={() => void handleClick()}>
        <RefreshIcon spinning={pending} />
        <span className="ml-1.5">{pending ? "Refreshing…" : "Refresh catalog"}</span>
      </Button>
      {message && (
        <span className={cn("text-xs", status?.lastError ? "text-warning" : "text-muted")}>
          {message}
        </span>
      )}
    </div>
  );
}
