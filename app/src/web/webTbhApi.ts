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
import {
  analyzeSaveFile,
  resolveWebInventory,
  webPriceContext,
  type AnalyzeResult,
} from "./analyzeSave";
import { classifySaveFileError } from "./errors";
import { installWebDataSource } from "./dataSource";
import { ensureWebPricesLoaded, getWebPriceSnapshot, subscribeWebPrices } from "./pricesSnapshot";
import {
  ensureBoxSourcesLoaded,
  getWebBoxSources,
} from "./boxSourcesSnapshot";
import {
  ensureItemSourcesLoaded,
  getWebItemSources,
  getWebStages,
} from "./itemSourcesSnapshot";
import {
  loadLookupItems,
  loadOfferings,
  loadSynthesisModel,
} from "../core/lookup/catalog";
import { gameItemName } from "../core/gamedata";
import { loadLocaleCatalog } from "../core/localeCatalog";
import { resolveLanguage, type ResolvedLanguage } from "../../shared/language";
import type {
  AppConfig,
  ChestState,
  LookupItem,
  PetState,
  PriceStatus,
  ResolvedInventory,
  TbhApi,
} from "../../shared/types";

type Listener<T> = (value: T) => void;
const NOOP_UNSUBSCRIBE = (): void => {};

/** Tabs the web build renders with real data; the rest show a desktop notice. */
export type WebTabId = "inventory" | "chests" | "settings";

interface WebRuntimeState {
  inventory: ResolvedInventory | null;
  analyze: AnalyzeResult | null;
  /** Pet unlock progress from the loaded save (null until one is loaded). */
  pets: PetState | null;
  /** Chest slot/capacity state from the loaded save (null until one is loaded). */
  chests: ChestState | null;
  fileName: string | null;
  loading: boolean;
  error: string | null;
  /** Steam Market display currency. Mirrors `config.currency` so panels can
   *  react to a change without a config push channel. */
  currency: string;
}

const runtime: WebRuntimeState = {
  inventory: null,
  analyze: null,
  pets: null,
  chests: null,
  fileName: null,
  loading: false,
  error: null,
  currency: "USD",
};

// `useSyncExternalStore` compares successive `getSnapshot()` results with
// `Object.is` and skips the re-render when they are equal. `runtime` above is a
// stable object that we mutate in place, so returning it directly would make
// every update look like a no-op and the UI would never refresh. Each mutation
// therefore publishes a fresh shallow copy, and `webRuntime()` hands out the
// most recent one — the identity changes exactly when the state does.
let runtimeSnapshot: Readonly<WebRuntimeState> = { ...runtime };

let config: AppConfig = {
  ...WEB_DEFAULT_CONFIG,
  resolvedLanguage: resolveLanguage(WEB_DEFAULT_CONFIG.language, navigator.language, null),
};

/**
 * Recompute the runtime `resolvedLanguage` from the configured `language`.
 *
 * On desktop this field is injected by main (it has the game's language
 * registry); the browser has no registry, so it is derived here — "auto"/"game"
 * follow `navigator.language` and unknown locales fall back to English. It is a
 * derived value and is never persisted.
 */
function resolveWebLanguage(cfg: AppConfig): ResolvedLanguage {
  return resolveLanguage(cfg.language, navigator.language, cfg.resolvedLanguage ?? null);
}
const inventoryListeners = new Set<Listener<ResolvedInventory>>();
const petsListeners = new Set<Listener<PetState>>();
const chestsListeners = new Set<Listener<ChestState>>();
const runtimeSubscribers = new Set<() => void>();
/** Lookup reads the display currency off `pricesStatus()`; pushed on change. */
const priceStatusListeners = new Set<Listener<PriceStatus>>();

/** Push the current (no-polling) status to every `onPriceStatus` subscriber. */
function broadcastPriceStatus(): void {
  const status = emptyPriceStatus(config.currency);
  for (const cb of [...priceStatusListeners]) cb(status);
}

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
  runtime.pets = null;
  runtime.chests = null;
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
      webPriceContext(getWebPriceSnapshot(), config.currency),
    );
    runtime.analyze = result;
    runtime.inventory = result.inventory;
    runtime.pets = result.pets;
    runtime.chests = result.chests;
    runtime.fileName = file.name;
    runtime.currency = config.currency;
    for (const cb of [...inventoryListeners]) cb(result.inventory);
    for (const cb of [...petsListeners]) cb(result.pets);
    for (const cb of [...chestsListeners]) cb(result.chests);
    // The inventory is priced from the CI snapshot; make sure it is being
    // fetched so a save loaded before it arrives is re-priced on arrival.
    void ensureWebPricesLoaded();
    return result.inventory;
  } catch (err) {
    runtime.error = classifySaveFileError(err);
    return null;
  } finally {
    runtime.loading = false;
    notifyRuntime();
  }
}

/**
 * Re-resolve the loaded save with the current language, Steam currency and
 * price snapshot, republishing to subscribers.
 *
 * The parse (`InventorySnapshot`) is language-, currency- and price-independent,
 * so this never re-decrypts — only the resolve step reruns, which for a few
 * hundred rows is effectively free. One entry point for all three triggers:
 * the price snapshot arriving, the UI language changing, and the display
 * currency changing.
 *
 * A language change used to re-decrypt the retained buffer; that was wasteful
 * (nothing in the parse reads the language) and is why the parse result is now
 * the thing that is retained.
 *
 * Deliberately never touches `runtime.error`: a missing or malformed snapshot
 * is not a save error, and the page must keep the rows it already has.
 */
function republishLoadedInventory(): void {
  const analyze = runtime.analyze;
  if (!analyze) return;
  try {
    const inventory = resolveWebInventory(
      analyze.snapshot,
      config.resolvedLanguage ?? "en",
      webPriceContext(getWebPriceSnapshot(), config.currency),
    );
    runtime.analyze = { ...analyze, inventory };
    runtime.inventory = inventory;
    for (const cb of [...inventoryListeners]) cb(inventory);
    notifyRuntime();
  } catch (err) {
    console.warn("[web] could not re-resolve the loaded inventory", err);
  }
}

subscribeWebPrices(() => republishLoadedInventory());

const CONFIG_STORAGE_KEY = "tbh-web-config";

function persistConfig(next: AppConfig): void {
  try {
    // `resolvedLanguage` is derived at runtime (`resolveWebLanguage`); strip it
    // so `restoreWebConfig` recomputes it instead of trusting a stale value.
    const persisted: Partial<AppConfig> = { ...next };
    delete persisted.resolvedLanguage;
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(persisted));
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
    const merged = { ...config, ...parsed };
    config = { ...merged, resolvedLanguage: resolveWebLanguage(merged) };
    // The runtime mirrors the persisted currency so the header switcher and the
    // panels agree before the first save is loaded.
    runtime.currency = config.currency;
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
    saveConfig: async (patch: Partial<AppConfig>) => {
      // `resolvedLanguage` is derived per-session, never persisted.
      const previousLanguage = config.resolvedLanguage;
      const previousCurrency = config.currency;
      const merged = { ...config, ...patch };
      const nextLanguage = resolveWebLanguage(merged);
      config = { ...merged, resolvedLanguage: nextLanguage };
      persistConfig(config);

      // A language change re-localizes the loaded inventory (its rows were
      // resolved with the previous language); a currency change re-prices it
      // through the snapshot's FX table. Both rerun only the resolve step — the
      // parse is language- and currency-independent — so this stays synchronous
      // and the caller observes a consistent (config, data) pair when it
      // returns. Currency changes also have to reach Lookup, which reads the
      // currency off `pricesStatus()`.
      const languageChanged = nextLanguage !== previousLanguage;
      const currencyChanged = config.currency !== previousCurrency;
      if (currencyChanged) {
        runtime.currency = config.currency;
        broadcastPriceStatus();
      }
      if ((languageChanged || currencyChanged) && runtime.analyze) {
        republishLoadedInventory();
      } else if (currencyChanged) {
        notifyRuntime();
      }
      return config;
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
    // The full item/box/stage source graph is served as slim same-origin
    // payloads (`data/box-sources.json` + `data/item-sources.json`, built from
    // `lookup_sources.json` at CI time and fetched lazily). Both requests are
    // awaited here so the Lookup tab receives the exact `LookupSources` shape
    // the desktop returns — synthesis paths, used-in, offerings and box
    // details light up with zero UI changes. A missing payload degrades to an
    // empty subtree rather than rejecting.
    getLookupSources: () =>
      Promise.all([ensureBoxSourcesLoaded(), ensureItemSourcesLoaded()]).then(() => ({
        items: getWebItemSources() ?? {},
        boxes: getWebBoxSources() ?? {},
        stages: getWebStages() ?? {},
      })),
    // `synthesis_model.json` and `offerings.json` ship in the web bundle
    // (`dataSource.ts`), so the same core loaders the desktop uses answer
    // here — the item detail's synthesis-path card renders for real.
    getLookupSynthesisModel: () => {
      installWebDataSource();
      return Promise.resolve(loadSynthesisModel());
    },
    getOfferings: () => {
      installWebDataSource();
      return Promise.resolve(loadOfferings());
    },
    getCatalogStatus: () => Promise.resolve(DEFAULT_CATALOG_STATUS),
    onCatalogStatus: () => NOOP_UNSUBSCRIBE,
    refreshCatalog: () =>
      Promise.resolve({ ok: false, gameVersion: null, itemCount: 0, resolvedNames: 0 }),

    // --- Save file picker: the web shell owns file input, not the API ---
    pickSaveFile: () => Promise.resolve(null),

    // --- Prices: the browser cannot call Steam's market endpoints directly
    // (no CORS), and polling thousands of hashes from a visitor's IP would be
    // abusive. The *Lookup* snapshot, however, is pre-built by CI and served
    // same-origin, so those two channels are real: they read
    // `website/data/prices.json`. All other price surfaces stay inert. ---
    pricesStatus: () => Promise.resolve(emptyPriceStatus(config.currency)),
    refreshPrices: () => Promise.resolve(emptyPriceRefreshResult(config.currency, "unavailable")),
    refreshItemPrices: () =>
      Promise.resolve(emptyPriceRefreshResult(config.currency, "unavailable")),
    cancelPrices: () => undefined,
    setCurrency: (iso: string) => {
      const changed = config.currency !== iso;
      config = { ...config, currency: iso };
      persistConfig(config);
      runtime.currency = iso;
      // Lookup reads the display currency off `pricesStatus()`, so a change has
      // to be pushed to its subscribers as well as re-pricing the inventory.
      broadcastPriceStatus();
      if (changed && runtime.analyze) republishLoadedInventory();
      else notifyRuntime();
      return Promise.resolve(emptyPriceStatus(iso));
    },
    setMarketAutoScanEnabled: unsupported,
    onPricesProgress: () => NOOP_UNSUBSCRIBE,
    onPriceStatus: (cb: (status: PriceStatus) => void) => {
      priceStatusListeners.add(cb);
      // Push the current status on subscribe so a fresh `usePriceStatus()` has a
      // value immediately instead of waiting for the next currency change.
      cb(emptyPriceStatus(config.currency));
      return () => {
        priceStatusListeners.delete(cb);
      };
    },
    getLookupPrices: () => ensureWebPricesLoaded().then(getWebPriceSnapshot),
    onLookupPrices: (cb) => subscribeWebPrices(() => cb(getWebPriceSnapshot())),
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

    // --- Chest slots: computed from the loaded save (`analyzeSave.ts`) ---
    // No live cooldowns (that needs the running game), but the slot/capacity
    // cards on the web Chests page are the real `ChestState`. Subscribers get
    // an immediate callback when data is already loaded — the web has no push
    // channel, and `useChests()` is a `getChests()` → `onChests()` two-step.
    getChests: () => Promise.resolve(runtime.chests),
    onChests: (cb: Listener<ChestState>) => {
      chestsListeners.add(cb);
      if (runtime.chests) cb(runtime.chests);
      return () => {
        chestsListeners.delete(cb);
      };
    },
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

    // --- Pets: resolved from the loaded save (`analyzeSave.ts`) ---
    // The web has no save watcher or live memory, so pets publish exactly
    // once per loaded save. Subscribers get an immediate callback when data
    // is already present (`usePets()` is a `getPets()` → `onPets()` two-step
    // and the immediate callback keeps the two observations consistent).
    getPets: () => Promise.resolve(runtime.pets),
    onPets: (cb: Listener<PetState>) => {
      petsListeners.add(cb);
      if (runtime.pets) cb(runtime.pets);
      return () => {
        petsListeners.delete(cb);
      };
    },
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
