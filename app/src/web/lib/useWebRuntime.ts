// Web build: React binding for the shim's runtime state (loaded save, error,
// file name). Extracted so the shell and each web panel subscribe through one
// hook instead of re-deriving the `useSyncExternalStore` tuple everywhere.

import { useSyncExternalStore } from "react";
import { onWebRuntimeChange, webRuntime } from "../webTbhApi";

/** The shape `webRuntime()` exposes — re-exported for panel prop typing. */
export type WebRuntimeState = ReturnType<typeof webRuntime>;

/** Current shim runtime state, re-rendering on load / error / clear. */
export function useWebRuntime(): WebRuntimeState {
  return useSyncExternalStore(
    (cb) => onWebRuntimeChange(cb),
    () => webRuntime(),
    () => webRuntime(),
  );
}
