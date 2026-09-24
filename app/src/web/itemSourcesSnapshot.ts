// Web build: same-origin item/stage-source store.
//
// The desktop Lookup tab reads the item source graph — where an item drops,
// what it crafts into, which recipes consume it — and the stage graph out of
// `lookup_sources.json`, which is 10.8 MB and deliberately NOT shipped to the
// browser (docs/business-flows/13-web-inspector.md §25.4).
// `scripts/build-web-item-sources.mjs` therefore emits a slim payload
// (`data/item-sources.json`, ~1.9 MB raw / ~75 KB gzipped) with drop and
// material rows reduced to tuples. This store fetches it lazily and rehydrates
// it into the exact `LookupSources["items"]` / `["stages"]` shapes the desktop
// `ItemDetailCard` / stage detail consume — so the web detail is the same view
// the desktop shows, not a web-only approximation.
//
// Name rehydration sources:
//   * drop box names  → the box-sources payload (same build chain, lossless)
//   * material names  → the bundled `lookup_items.json`
//   * rare unknown keys → the payload's `extras` fallback table
//
// Every failure degrades to "missing" (`items = null`) rather than throwing:
// the Lookup tab keeps rendering and the source sections simply stay hidden.

import { useSyncExternalStore } from "react";
import type { LookupItemSources, LookupSources } from "../../shared/types";
import { loadLookupItems } from "../core/lookup/catalog";
import { installWebDataSource } from "./dataSource";
import { ensureBoxSourcesLoaded, getWebBoxSources } from "./boxSourcesSnapshot";

export type WebItemSourcesStatus = "idle" | "loading" | "ready" | "missing";

/** Slim wire shape emitted by `build-web-item-sources.mjs`. */
interface SlimItem {
  /** `[via, boxItemKey, dropPct, grade]` */
  drops: Array<[string, number, number, string | null]>;
  crafting: Array<{
    recipeKey: number;
    tier: number;
    craftingType: string;
    level: { min: number; max: number };
    outputPct: number;
    /** `[itemKey, amount]` */
    m: Array<[number, number]>;
  }>;
  usedIn: Array<{
    recipeKey: number;
    craftingType: string;
    tier: number;
    level: { min: number; max: number };
    /** `[itemKey, amount]` */
    m: Array<[number, number]>;
    /** `[itemKey, poolPct]` */
    outputs: Array<[number, number]>;
  }>;
}

interface SlimPayload {
  schemaVersion: number;
  items: Record<string, SlimItem>;
  stages: LookupSources["stages"];
  /** Labels for item keys that are not in the bundled catalog. */
  extras: Record<string, { name: string; grade: string | null }>;
}

interface WebItemSourcesState {
  status: WebItemSourcesStatus;
  items: Record<string, LookupItemSources> | null;
  stages: LookupSources["stages"] | null;
}

let state: WebItemSourcesState = { status: "idle", items: null, stages: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function setState(next: WebItemSourcesState): void {
  state = next;
  for (const cb of [...listeners]) cb();
}

/** The rehydrated item source graph, or null when absent/unreadable. */
export function getWebItemSources(): Record<string, LookupItemSources> | null {
  return state.items;
}

/** The stage graph (verbatim from the payload), or null when absent/unreadable. */
export function getWebStages(): LookupSources["stages"] | null {
  return state.stages;
}

export function getWebItemSourcesStatus(): WebItemSourcesStatus {
  return state.status;
}

export function subscribeItemSources(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function itemSourcesUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}data/item-sources.json`;
}

function isSlimPayload(value: unknown): value is SlimPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.items === "object" && v.items !== null && !Array.isArray(v.items);
}

function materialName(
  itemKey: number,
  catalogById: Map<number, { name: string }>,
  extras: SlimPayload["extras"],
): string {
  return catalogById.get(itemKey)?.name ?? extras[itemKey]?.name ?? `#${itemKey}`;
}

/**
 * Rebuild the full `LookupItemSources` graph from the slim payload.
 *
 * Drop box names come from the box-sources store (`ensureItemSourcesLoaded`
 * awaits it first); material names come from the bundled catalog, with the
 * payload's `extras` covering the handful of keys that are not catalogued.
 */
function rehydrate(
  payload: SlimPayload,
  catalogById: Map<number, { name: string }>,
  boxes: LookupSources["boxes"] | null,
): Record<string, LookupItemSources> {
  const items: Record<string, LookupItemSources> = {};
  for (const [id, slim] of Object.entries(payload.items)) {
    items[id] = {
      drops: slim.drops.map(([via, boxItemKey, dropPct, grade]) => ({
        via,
        boxItemKey,
        dropPct,
        grade: grade ?? null,
        boxName: boxes?.[String(boxItemKey)]?.name ?? `#${boxItemKey}`,
      })),
      crafting: (slim.crafting ?? []).map((recipe) => ({
        recipeKey: recipe.recipeKey,
        tier: recipe.tier,
        craftingType: recipe.craftingType,
        level: recipe.level,
        outputPct: recipe.outputPct,
        materials: (recipe.m ?? []).map(([itemKey, amount]) => ({
          itemKey,
          amount,
          name: materialName(itemKey, catalogById, payload.extras ?? {}),
        })),
      })),
      usedIn: (slim.usedIn ?? []).map((recipe) => ({
        recipeKey: recipe.recipeKey,
        craftingType: recipe.craftingType,
        tier: recipe.tier,
        level: recipe.level,
        materials: (recipe.m ?? []).map(([itemKey, amount]) => ({
          itemKey,
          amount,
          name: materialName(itemKey, catalogById, payload.extras ?? {}),
        })),
        outputs: (recipe.outputs ?? []).map(([itemKey, poolPct]) => ({ itemKey, poolPct })),
      })),
    };
  }
  return items;
}

async function fetchItemSources(): Promise<void> {
  setState({ status: "loading", items: state.items, stages: state.stages });
  try {
    // Drop box names live in the box-sources payload, so warm it first. It
    // resolves even when it 404s (that store degrades to "missing"), in which
    // case box names fall back to `#<boxItemKey>`.
    await ensureBoxSourcesLoaded();
    const res = await fetch(itemSourcesUrl(), { cache: "default" });
    if (!res.ok) {
      setState({ status: "missing", items: null, stages: null });
      return;
    }
    const parsed: unknown = await res.json();
    if (!isSlimPayload(parsed)) {
      setState({ status: "missing", items: null, stages: null });
      return;
    }
    // The bundled catalog is the material-name source; the box-sources store
    // is the drop-box-name source.
    installWebDataSource();
    const catalogById = new Map(loadLookupItems().map((item) => [item.id, item]));
    setState({
      status: "ready",
      items: rehydrate(parsed, catalogById, getWebBoxSources()),
      stages: parsed.stages ?? {},
    });
  } catch {
    // Network failure, aborted request, or JSON parse error — degrade, never throw.
    setState({ status: "missing", items: null, stages: null });
  }
}

/**
 * Load the item-source payload once. Idempotent, and **only called when the
 * Lookup tab needs it** — the ~1.9 MB parse is not paid on pages that never
 * open an item detail.
 */
export function ensureItemSourcesLoaded(): Promise<void> {
  if (inflight) return inflight;
  if (state.status === "ready" || state.status === "missing") return Promise.resolve();
  inflight = fetchItemSources().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** React binding: `{ status, items, stages }`, kicking off the (idempotent) load. */
export function useItemSources(): {
  status: WebItemSourcesStatus;
  items: Record<string, LookupItemSources> | null;
  stages: LookupSources["stages"] | null;
} {
  const status = useSyncExternalStore(
    subscribeItemSources,
    getWebItemSourcesStatus,
    getWebItemSourcesStatus,
  );
  const items = useSyncExternalStore(subscribeItemSources, getWebItemSources, getWebItemSources);
  const stages = useSyncExternalStore(subscribeItemSources, getWebStages, getWebStages);
  return { status, items, stages };
}
