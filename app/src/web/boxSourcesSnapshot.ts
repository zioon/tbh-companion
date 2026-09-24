// Web build: same-origin chest-source store.
//
// The desktop box detail card reads the box graph — drop list with chances,
// farm stages, first-clear stages — out of `lookup_sources.json`, which is
// 10.8 MB and deliberately NOT shipped to the browser
// (docs/business-flows/13-web-inspector.md §25.4). The Chests page only needs
// the `boxes` subtree, and even that is 2.6 MB, almost all of it the per-drop
// `name`/`grade` strings that duplicate the bundled `lookup_items.json`.
//
// `scripts/build-web-box-sources.mjs` therefore emits a slim payload
// (`data/box-sources.json`, ~590 KB raw / ~76 KB gzipped) with drops reduced to
// `[itemKey, dropPct]` pairs. This store fetches it lazily and rehydrates it
// into the exact `LookupSources["boxes"]` shape the desktop `BoxDetailCard`
// consumes — so the chest detail is the same view the desktop shows, not a
// web-only approximation.
//
// Every failure degrades to "missing" (`boxes = null`) rather than throwing:
// the chest catalog keeps rendering and the cards simply stop being clickable.

import { useSyncExternalStore } from "react";
import type { LookupBoxSources, LookupSources } from "../../shared/types";
import { loadLookupItems } from "../core/lookup/catalog";
import { installWebDataSource } from "./dataSource";

export type WebBoxSourcesStatus = "idle" | "loading" | "ready" | "missing";

/** Slim wire shape emitted by `build-web-box-sources.mjs`. */
interface SlimBox {
  name: string;
  grade: string | null;
  category: string;
  drops: Array<[number, number]>;
  stages: LookupBoxSources["stages"];
  dropStageRangeLabel: string;
  firstDropOnly: boolean;
  firstDropStages: LookupBoxSources["firstDropStages"];
}

interface SlimPayload {
  schemaVersion: number;
  boxes: Record<string, SlimBox>;
  /** Labels for drop item keys that are not in the bundled catalog. */
  extras: Record<string, { name: string; grade: string }>;
}

interface WebBoxSourcesState {
  status: WebBoxSourcesStatus;
  boxes: LookupSources["boxes"] | null;
}

let state: WebBoxSourcesState = { status: "idle", boxes: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function setState(next: WebBoxSourcesState): void {
  state = next;
  for (const cb of [...listeners]) cb();
}

/** The rehydrated box graph, or null when absent/unreadable. */
export function getWebBoxSources(): LookupSources["boxes"] | null {
  return state.boxes;
}

export function getWebBoxSourcesStatus(): WebBoxSourcesStatus {
  return state.status;
}

export function subscribeBoxSources(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function boxSourcesUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}data/box-sources.json`;
}

function isSlimPayload(value: unknown): value is SlimPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.boxes === "object" && v.boxes !== null && !Array.isArray(v.boxes);
}

/**
 * Rebuild the full `LookupBoxSources` from the slim payload.
 *
 * Drop names/grades are rehydrated from the bundled catalog — the build script
 * verified the pairing is lossless (0 mismatches across ~34k drops). The 14
 * item keys that are not in the catalog keep their label from `extras`.
 */
function rehydrate(
  payload: SlimPayload,
  catalogById: Map<number, { name: string; grade: string }>,
): LookupSources["boxes"] {
  const boxes: LookupSources["boxes"] = {};
  for (const [id, slim] of Object.entries(payload.boxes)) {
    boxes[id] = {
      name: slim.name,
      grade: slim.grade,
      category: slim.category as LookupBoxSources["category"],
      drops: slim.drops.map(([itemKey, dropPct]) => {
        const extra = payload.extras[itemKey];
        const item = catalogById.get(itemKey);
        return {
          itemKey,
          dropPct,
          name: item?.name ?? extra?.name ?? `#${itemKey}`,
          grade: item?.grade ?? extra?.grade ?? "UNKNOWN",
        };
      }),
      stages: slim.stages,
      dropStageRangeLabel: slim.dropStageRangeLabel,
      firstDropOnly: slim.firstDropOnly,
      firstDropStages: slim.firstDropStages,
    };
  }
  return boxes;
}

async function fetchBoxSources(): Promise<void> {
  setState({ status: "loading", boxes: state.boxes });
  try {
    const res = await fetch(boxSourcesUrl(), { cache: "default" });
    if (!res.ok) {
      setState({ status: "missing", boxes: null });
      return;
    }
    const parsed: unknown = await res.json();
    if (!isSlimPayload(parsed)) {
      setState({ status: "missing", boxes: null });
      return;
    }
    // The bundled catalog is the name/grade source for every drop.
    installWebDataSource();
    const catalogById = new Map(loadLookupItems().map((item) => [item.id, item]));
    setState({ status: "ready", boxes: rehydrate(parsed, catalogById) });
  } catch {
    // Network failure, aborted request, or JSON parse error — degrade, never throw.
    setState({ status: "missing", boxes: null });
  }
}

/**
 * Load the chest-source payload once. Idempotent, and **only called when the
 * Chests page needs it** — the 590 KB parse is not paid on pages that never
 * open a chest detail.
 */
export function ensureBoxSourcesLoaded(): Promise<void> {
  if (inflight) return inflight;
  if (state.status === "ready" || state.status === "missing") return Promise.resolve();
  inflight = fetchBoxSources().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** React binding: `{ status, boxes }`, kicking off the (idempotent) load. */
export function useBoxSources(): {
  status: WebBoxSourcesStatus;
  boxes: LookupSources["boxes"] | null;
} {
  const status = useSyncExternalStore(
    subscribeBoxSources,
    getWebBoxSourcesStatus,
    getWebBoxSourcesStatus,
  );
  const boxes = useSyncExternalStore(subscribeBoxSources, getWebBoxSources, getWebBoxSources);
  return { status, boxes };
}
