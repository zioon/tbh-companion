import { useEffect, useState } from "react";
import type { LiveMemorySnapshot, LiveMemoryStatus } from "../../../shared/types";
import { reportIpcError } from "./reportError";

/**
 * Subscribe only to live-memory status (low-frequency, state-change driven).
 * Use this in components that don't need the 25 Hz snapshot stream — e.g. the
 * toolbar indicator badge — to avoid unnecessary React re-renders and heap
 * pressure from large snapshot objects.
 */
export function useLiveMemoryStatus(): LiveMemoryStatus | null {
  const [status, setStatus] = useState<LiveMemoryStatus | null>(null);

  useEffect(() => {
    let active = true;
    window.tbh
      .getLiveMemoryStatus?.()
      ?.then((s) => {
        if (active && s) setStatus(s);
      })
      .catch((err: unknown) => reportIpcError(err, "useLiveMemoryStatus:getStatus"));
    const offStatus = window.tbh.onLiveMemoryStatus?.((s) => setStatus(s));
    return () => {
      active = false;
      offStatus?.();
    };
  }, []);

  return status;
}

/**
 * Standalone live-memory subscription. Intentionally NOT part of TbhProvider:
 * snapshots arrive at the poll rate and only the components that read live data
 * should re-render — never the whole app.
 *
 * When the reader stops (a `running: false` status), the snapshot is cleared so
 * every stat reverts to its save-file source (per-stat live/save blend).
 *
 * Only use this hook in components that actually render snapshot data (e.g. the
 * Live tab). For status-only needs, prefer useLiveMemoryStatus to avoid
 * subscribing to the 25 Hz snapshot stream.
 */
export function useLiveMemory(): {
  snapshot: LiveMemorySnapshot | null;
  status: LiveMemoryStatus | null;
} {
  const [snapshot, setSnapshot] = useState<LiveMemorySnapshot | null>(null);
  const [status, setStatus] = useState<LiveMemoryStatus | null>(null);

  useEffect(() => {
    let active = true;
    window.tbh
      .getLiveMemory?.()
      ?.then((s) => {
        if (active && s) setSnapshot(s);
      })
      .catch((err: unknown) => reportIpcError(err, "useLiveMemory:getSnapshot"));
    window.tbh
      .getLiveMemoryStatus?.()
      ?.then((s) => {
        if (active && s) setStatus(s);
      })
      .catch((err: unknown) => reportIpcError(err, "useLiveMemory:getStatus"));
    const offSnap = window.tbh.onLiveMemory?.((s) => setSnapshot(s));
    const offStatus = window.tbh.onLiveMemoryStatus?.((s) => {
      setStatus(s);
      if (!s.running) setSnapshot(null);
    });
    return () => {
      active = false;
      offSnap?.();
      offStatus?.();
    };
  }, []);

  return { snapshot, status };
}
