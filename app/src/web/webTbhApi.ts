// Web build: a `window.tbh` implementation backed by a locally-loaded save file
// instead of Electron IPC.
//
// The renderer is written against the full desktop `TbhApi`, so this shim has to
// satisfy the same surface. It fully implements the inventory read path and
// provides inert values for everything that requires the desktop app (file
// watching, live memory, Steam price refresh, overlays, auto-update).
// Unsupported methods resolve rather than throw, so tabs that merely *peek* at a
// capability still mount — the web shell's notice card is what actually tells
// the user to download the desktop app.
//
// Every return value is typed against the real shared interfaces, so a drift
// from the desktop contract fails `pnpm typecheck` instead of surfacing as a
// runtime `undefined` in the UI.

import {
  DEFAULT_CATALOG_STATUS,
  emptyAutoClassifyState,
  emptyBoxTimerState,
  emptyMarketVolumeItemStats,
  emptyMarketVolumeRefreshResult,
  emptyMarketVolumeStats,
  emptyPollingCycleResult,
  emptyPriceRefreshResult,
  emptyPriceStatus,
  emptyRecordLogPage,
  emptyStageRunStats,
  idleUpdateStatus,
  unavailableAppDataPaths,
  unavailableClearResult,
} from "./webStubs";
import { WEB_DEFAULT_CONFIG } from "./defaultConfig";
import { analyzeSaveFile, type AnalyzeResult } from "./analyzeSave";
import { classifySaveFileError } from "./errors";
import { installWebDataSource } from "./dataSource";
import { loadLookupItems } from "../core/lookup/catalog";
import { gameItemName } from "../core/gamedata";
import { loadLocaleCatalog } from "../core/localeCatalog";
import type { AppConfig, LookupItem, ResolvedInventory, TbhApi } from "../../shared/types";

type Listener<T> = (value: T) => void;
const NOOP_UNSUBSCRIBE = (): void => {};

/** Tabs the web build renders with real data; the rest show a desktop notice. */
export type WebTabId = "inventory" | "chests" | "settings";

interface WebRuntimeState {
  inventory: ResolvedInventory | null;
  analyze: AnalyzeResult | null;
  fileName: string | null;
  loading: boolean;
  error: string | null;
}

const runtime: WebRuntimeState = {
  inventory: null,
  analyze: null,
  fileName: null,
  loading: false,
  error: null,
};

// `useSyncExternalStore` compares successive `getSnapshot()` results with
// `Object.is` and skips the re-render when they are equal. `runtime` above is a
// stable object that we mutate in place, so returning it directly would make
// every update look like a no-op and the UI would never refresh. Each mutation
// therefore publishes a fresh shallow copy, and `webRuntime()` hands out the
// most recent one — the identity changes exactly when the state does.
let runtimeSnapshot: Readonly<WebRuntimeState> = { ...runtime };

let config: AppConfig = { ...WEB_DEFAULT_CONFIG };
const inventoryListeners = new Set<Listener<ResolvedInventory>>();
const runtimeSubscribers = new Set<() => void>();

/** Current shim state, for the web UI shell. */
export function webRuntime(): Readonly<WebRuntimeState> {
  return runtimeSnapshot;
}

/** Subscribe to runtime changes (loading / error / file name). */
export function onWebRuntimeChange(cb: () => void): () => void {
  runtimeSubscribers.add(cb);
  return () => {
    runtimeSubscribers.delete(cb);
  };
}

function notifyRuntime(): void {
  // Republish before notifying: subscribers read the snapshot synchronously
  // inside `getSnapshot()`, so it has to be current by the time they run.
  runtimeSnapshot = { ...runtime };
  for (const cb of [...runtimeSubscribers]) cb();
}

/** Clear the loaded save (used by the "load another file" action). */
export function clearWebSave(): void {
  runtime.inventory = null;
  runtime.analyze = null;
  runtime.fileName = null;
  runtime.error = null;
  notifyRuntime();
}

/**
 * Decrypt + analyze a user-supplied save file and publish the result.
 * Returns null and records `runtime.error` when the file cannot be read.
 */
export async function loadWebSaveFile(file: File): Promise<ResolvedInventory | null> {
  runtime.loading = true;
  runtime.error = null;
  notifyRuntime();

  try {
    installWebDataSource();
    const buffer = await file.arrayBuffer();
    const result = await analyzeSaveFile(
      buffer,
      config.resolvedLanguage ?? "en",
      file.lastModified,
    );
    runtime.analyze = result;
    runtime.inventory = result.inventory;
    runtime.fileName = file.name;
    for (const cb of [...inventoryListeners]) cb(result.inventory);
    return result.inventory;
  } catch (err) {
    runtime.error = classifySaveFileError(err);
    return null;
  } finally {
    runtime.loading = false;
    notifyRuntime();
  }
}

const CONFIG_STORAGE_KEY = "tbh-web-config";

function persistConfig(next: AppConfig): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — the in-memory value still applies for this session.
  }
}

/** Restore previously saved web preferences, if any. */
export function restoreWebConfig(): void {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return;
    // `resolvedLanguage` is runtime-only and never persisted — recompute it.
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    config = { ...config, ...parsed, resolvedLanguage: config.resolvedLanguage };
  } catch {
    // Ignore corrupt payloads and fall back to defaults.
  }
}

const unsupported = (): Promise<void> => Promise.resolve();

/**
 * Localized `lookup_items.json` for the current UI language.
 *
 * Mirrors `LookupService.getCatalog()`: swap the display `name` for the
 * localized one but keep the English original in `sourceName`, so
 * `marketHashName()` keeps producing English Steam hashes. Cached per
 * language because the renderer calls this on startup and again on every
 * language switch.
 */
let lookupCatalogCache: { language: string; items: LookupItem[] } | null = null;

function webLookupCatalog(): LookupItem[] {
  const language = config.resolvedLanguage ?? "en";
  if (lookupCatalogCache?.language === language) return lookupCatalogCache.items;

  installWebDataSource();
  const catalog = loadLocaleCatalog(language);
  const items = loadLookupItems().map((item) => {
    const localizedName = gameItemName(item, catalog);
    if (localizedName === item.name) return item;
    return { ...item, name: localizedName, sourceName: item.name };
  });

  lookupCatalogCache = { language, items };
  return items;
}

/** The web `TbhApi`. Every method is type-checked against the desktop interface. */
function buildWebApi(): TbhApi {
  const api: TbhApi = {
    // --- Inventory: fully supported ---
    getInventory: () => Promise.resolve(runtime.inventory),
    onInventory(cb: Listener<ResolvedInventory>) {
      inventoryListeners.add(cb);
      return () => {
        inventoryListeners.delete(cb);
      };
    },

    // --- Config: in-memory + localStorage ---
    getConfig: () => Promise.resolve(config),
    saveConfig: (patch: Partial<AppConfig>) => {
      // `resolvedLanguage` is derived per-session, never persisted.
      config = { ...config, ...patch, resolvedLanguage: config.resolvedLanguage };
      persistConfig(config);
      return Promise.resolve(config);
    },

    // --- Wish coin overrides: desktop-only feature (wish tracking needs live memory) ---
    // The web build has no wish record at all, so these are inert: an empty list and
    // a no-op subscription. `set` echoes the incoming value back so the optimistic
    // update in `useWish()` settles rather than rejecting.
    getWishCoinOverrides: () => Promise.resolve([]),
    setWishCoinOverrides: (overrides) => Promise.resolve(overrides),
    onWishCoinOverrides: () => () => {},

    // --- Catalog: bundled snapshot only, no refresh (that needs the game install) ---
    // The inventory table resolves names, grade colors and icons through
    // `useLookupCatalog()`, so answering with an empty array left every row
    // showing its raw English gamedata name with no icon box at all. The
    // bundled `lookup_items.json` is already in the web bundle (see
    // `dataSource.ts`), so serve it localized the same way the desktop
    // `LookupService.getCatalog()` does — preserving the English source name
    // so `marketHashName()` still derives English Steam hashes.
    getLookupCatalog: () => Promise.resolve(webLookupCatalog()),
    getLocaleData: () => Promise.resolve(null),
    // The web bundle ships only the catalogs the inventory analyzer reads
    // (lookup_items / gamedata / locales). Loot-source, synthesis-model and
    // offering data are desktop-only, so these answer with empty shells rather
    // than rejecting — a tab that merely peeks at them still mounts.
    getLookupSources: () => Promise.resolve({ items: {}, boxes: {}, stages: {} }),
    getLookupSynthesisModel: () =>
      Promise.resolve({ gradeWeights: {}, recipesByType: {}, buckets: {} }),
    getOfferings: () => Promise.resolve([]),
    getCatalogStatus: () => Promise.resolve(DEFAULT_CATALOG_STATUS),
    onCatalogStatus: () => NOOP_UNSUBSCRIBE,
    refreshCatalog: () =>
      Promise.resolve({ ok: false, gameVersion: null, itemCount: 0, resolvedNames: 0 }),

    // --- Save file picker: the web shell owns file input, not the API ---
    pickSaveFile: () => Promise.resolve(null),

    // --- Prices: the browser cannot call Steam's market endpoints directly
    // (no CORS), and polling thousands of hashes from a visitor's IP would be
    // abusive. Desktop-only by design. ---
    pricesStatus: () => Promise.resolve(emptyPriceStatus(config.currency)),
    refreshPrices: () => Promise.resolve(emptyPriceRefreshResult(config.currency, "unavailable")),
    refreshItemPrices: () =>
      Promise.resolve(emptyPriceRefreshResult(config.currency, "unavailable")),
    cancelPrices: () => undefined,
    setCurrency: (iso: string) => {
      config = { ...config, currency: iso };
      persistConfig(config);
      return Promise.resolve(emptyPriceStatus(iso));
    },
    setMarketAutoScanEnabled: unsupported,
    onPricesProgress: () => NOOP_UNSUBSCRIBE,
    onPriceStatus: () => NOOP_UNSUBSCRIBE,
    getLookupPrices: () => Promise.resolve(null),
    onLookupPrices: () => NOOP_UNSUBSCRIBE,
    getLookupPricePollStatus: () => Promise.resolve(null),
    onLookupPricePollStatus: () => NOOP_UNSUBSCRIBE,
    pollLookupPrices: () => Promise.resolve(emptyPollingCycleResult()),
    getMarketVolume: () => Promise.resolve(emptyMarketVolumeStats()),
    onMarketVolume: () => NOOP_UNSUBSCRIBE,
    getMarketVolumeItems: () => Promise.resolve(emptyMarketVolumeItemStats()),
    onMarketVolumeItems: () => NOOP_UNSUBSCRIBE,
    refreshMarketVolumeItems: () => Promise.resolve(emptyMarketVolumeRefreshResult()),
    onMarketVolumeRefreshProgress: () => NOOP_UNSUBSCRIBE,
    refreshMarketVolumeItem: unsupported,
    exportMarketVolumeHistory: () => Promise.resolve({ ok: false, error: "desktop-only" }),
    analyzeMarketVolumeBackup: () => Promise.resolve({ ok: false, error: "desktop-only" }),
    importMarketVolumeHistory: () => Promise.resolve({ ok: false, error: "desktop-only" }),
    cancelHistoryRefresh: () => undefined,

    // --- Live stats / memory: requires the running game process ---
    onStats: () => NOOP_UNSUBSCRIBE,
    getStats: () => Promise.resolve(null),
    reset: () => undefined,
    getStageRuns: () => Promise.resolve(emptyStageRunStats()),
    onStageRuns: () => NOOP_UNSUBSCRIBE,
    getLiveMemory: () => Promise.resolve(null),
    getLiveMemoryStatus: () => Promise.resolve(null),
    onLiveMemory: () => NOOP_UNSUBSCRIBE,
    onLiveMemoryStatus: () => NOOP_UNSUBSCRIBE,

    // --- Chest timers: cooldowns only exist while the game runs ---
    getChests: () => Promise.resolve(null),
    onChests: () => NOOP_UNSUBSCRIBE,
    getBoxTimers: () => Promise.resolve(emptyBoxTimerState()),
    onBoxTimers: () => NOOP_UNSUBSCRIBE,
    markBoxDropped: () => Promise.resolve(emptyBoxTimerState()),
    clearBoxTimer: () => Promise.resolve(emptyBoxTimerState()),
    setBoxTrackerBoxes: () => Promise.resolve(emptyBoxTimerState()),
    setBoxTrackerCooldown: () => Promise.resolve(emptyBoxTimerState()),
    clearBoxTrackerCooldown: () => Promise.resolve(emptyBoxTimerState()),
    setBoxTrackerFarmStage: () => Promise.resolve(emptyBoxTimerState()),
    clearBoxTrackerFarmStage: () => Promise.resolve(emptyBoxTimerState()),
    setBoxTrackerNotify: () => Promise.resolve(emptyBoxTimerState()),
    setBoxTrackerSortOrder: () => Promise.resolve(emptyBoxTimerState()),

    // --- Pets / loot history: driven by save watching and live memory ---
    getPets: () => Promise.resolve(null),
    onPets: () => NOOP_UNSUBSCRIBE,
    getRecordLogPage: (_page: number, pageSize = 0) =>
      Promise.resolve(emptyRecordLogPage(pageSize)),
    getAcquireRing: () => Promise.resolve(null),
    resetLootBox: unsupported,
    resetLootAll: unsupported,
    reclassifyLootItem: unsupported,
    setLootAutoClassifyEnabled: unsupported,
    getAutoClassifyState: () => Promise.resolve(emptyAutoClassifyState()),
    onClassifyPrompt: () => NOOP_UNSUBSCRIBE,
    resolveClassifyPrompt: () => undefined,

    // --- Windows, notifications, auto-update: desktop-only ---
    openOverlay: () => undefined,
    showMain: () => undefined,
    closeOverlay: () => undefined,
    openBoxTracker: () => undefined,
    closeBoxTracker: () => undefined,
    minimizeBoxTracker: () => undefined,
    onPlayNotificationSound: () => NOOP_UNSUBSCRIBE,
    getUpdateStatus: () => Promise.resolve(idleUpdateStatus()),
    checkForUpdates: () => Promise.resolve(idleUpdateStatus()),
    downloadUpdate: () => Promise.resolve(idleUpdateStatus()),
    quitAndInstall: unsupported,
    onUpdateStatus: () => NOOP_UNSUBSCRIBE,

    // --- Paths / diagnostics: no local filesystem in the browser ---
    getDataPaths: () => Promise.resolve(unavailableAppDataPaths()),
    clearAppData: () => Promise.resolve(unavailableClearResult()),
    clearDiagnosticLogs: () => Promise.resolve(unavailableClearResult()),
    logRendererError: () => Promise.resolve(),
  };

  return api;
}

let cachedApi: TbhApi | null = null;

/** The web `window.tbh` implementation (memoized). */
export function createWebTbhApi(): TbhApi {
  if (!cachedApi) cachedApi = buildWebApi();
  return cachedApi;
}

/** Install the web API on `window.tbh` before the renderer mounts. */
export function installWebTbhApi(): void {
  restoreWebConfig();
  (window as unknown as { tbh: TbhApi }).tbh = createWebTbhApi();
}
