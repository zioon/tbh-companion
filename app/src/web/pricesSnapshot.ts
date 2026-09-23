// Web build: same-origin Lookup price snapshot store.
//
// The desktop Lookup tab reads its price snapshot over IPC. The browser cannot
// call Steam (no CORS) and must not poll thousands of hashes from a visitor's
// IP, so it fetches one pre-built `LookupPriceSnapshot` from the same origin
// instead: `website/data/prices.json`, staged by the Pages workflow from the
// rolling `lookup-prices` release and contractually identical to the shared
// interface (built by `core/lookupPrice/snapshot.ts#buildSnapshot`).
//
// A module-level singleton (like `useLookupPrices` on the desktop) so the
// hundreds of Lookup cards and the Trading table share one fetch. It is
// `useSyncExternalStore`-friendly: `getWebPricesStatus` returns a primitive and
// `getWebPriceSnapshot` a stable reference, so `Object.is` comparison behaves.
//
// Every failure mode degrades to "missing" (`snapshot = null`) rather than
// throwing or blanking the catalog: a 404, a network error, or a payload whose
// shape doesn't match the snapshot contract all leave the views rendering with
// no prices plus a warning banner.

import type { LookupPriceSnapshot } from "../../shared/types";

export type WebPricesStatus = "idle" | "loading" | "ready" | "missing";

interface WebPricesState {
  status: WebPricesStatus;
  snapshot: LookupPriceSnapshot | null;
}

let state: WebPricesState = { status: "idle", snapshot: null };
const listeners = new Set<() => void>();

/** In-flight load, so concurrent callers share one request (idempotency). */
let inflight: Promise<void> | null = null;

function setState(next: WebPricesState): void {
  state = next;
  for (const cb of [...listeners]) cb();
}

/** The loaded snapshot, or null when absent/unreadable. */
export function getWebPriceSnapshot(): LookupPriceSnapshot | null {
  return state.snapshot;
}

/** Lifecycle of the snapshot fetch: idle → loading → ready | missing. */
export function getWebPricesStatus(): WebPricesStatus {
  return state.status;
}

/** Subscribe to snapshot/status changes (stable across a session). */
export function subscribeWebPrices(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Same-origin snapshot URL.
 *
 * `import.meta.env.BASE_URL` honours Vite's `base` (`"./"` for the web build),
 * so this resolves correctly whether the app is served from the site root or a
 * subpath. A trailing slash is always present in BASE_URL, but guard for the
 * empty-string case so the path never becomes garbage.
 */
function pricesUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}data/prices.json`;
}

/**
 * Minimal structural check for a `LookupPriceSnapshot`. A corrupt or
 * mis-served payload (e.g. an HTML error page that still parses as JSON) must
 * be rejected as "missing" rather than crashing `resolveLookupPrice`.
 */
function isSnapshot(value: unknown): value is LookupPriceSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.generatedUtc === "string" &&
    typeof v.prices === "object" &&
    v.prices !== null &&
    // Reject arrays — `prices` must be a hash→price object.
    !Array.isArray(v.prices)
  );
}

async function fetchSnapshot(cache: RequestCache): Promise<void> {
  setState({ status: "loading", snapshot: state.snapshot });
  try {
    const res = await fetch(pricesUrl(), { cache });
    if (!res.ok) {
      setState({ status: "missing", snapshot: null });
      return;
    }
    const parsed: unknown = await res.json();
    if (!isSnapshot(parsed)) {
      setState({ status: "missing", snapshot: null });
      return;
    }
    setState({ status: "ready", snapshot: parsed });
  } catch {
    // Network failure, aborted request, or JSON parse error — degrade, never throw.
    setState({ status: "missing", snapshot: null });
  }
}

/**
 * Load the snapshot once. Idempotent: repeated calls share the in-flight
 * request and short-circuit once a terminal status has been reached.
 */
export function ensureWebPricesLoaded(): Promise<void> {
  if (inflight) return inflight;
  if (state.status === "ready" || state.status === "missing") return Promise.resolve();
  inflight = fetchSnapshot("default").finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Force a re-fetch that bypasses the HTTP cache (user-initiated refresh). */
export function refreshWebPrices(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchSnapshot("reload").finally(() => {
    inflight = null;
  });
  return inflight;
}
