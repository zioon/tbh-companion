// Web build: inert-but-well-typed return values for capabilities the browser
// cannot provide. Each helper returns the exact shared interface the desktop
// main process would return, so the renderer's existing null/empty handling
// applies unchanged — no tab needs a browser-specific branch to stay mounted.

import type {
  AppDataPaths,
  AutoClassifyStatePayload,
  BoxTimerState,
  CatalogStatus,
  ClearAppDataResult,
  MarketVolumeItemStats,
  MarketVolumeRefreshResult,
  MarketVolumeStats,
  PollingCycleResult,
  PriceRefreshResult,
  PriceStatus,
  RecordLogPage,
  StageRunStats,
  UpdateStatus,
} from "../../shared/types";

/** No Steam pricing on the web: the browser cannot call Steam's market API. */
export function emptyPriceStatus(currency: string): PriceStatus {
  return {
    currency,
    count: 0,
    ownedTargets: 0,
    freshCount: 0,
    staleCount: 0,
    fetchedUtc: null,
    running: false,
  };
}

/** `refreshPrices` resolves with the refresh summary *and* the resulting status. */
export function emptyPriceRefreshResult(
  currency: string,
  error?: string,
): PriceRefreshResult & { status: PriceStatus } {
  return {
    ok: false,
    priced: 0,
    skipped: 0,
    failed: 0,
    stopped: "completed",
    currency,
    error,
    noop: true,
    status: emptyPriceStatus(currency),
  };
}

export function emptyMarketVolumeStats(currency = "USD"): MarketVolumeStats {
  return {
    latest: null,
    hourly: [],
    itemCount: 0,
    itemCountsByCategory: {},
    currency,
  };
}

export function emptyMarketVolumeItemStats(currency = "USD"): MarketVolumeItemStats {
  return { items: [], currency };
}

/** No refresh on the web: return the empty item stats plus an empty pending list. */
export function emptyMarketVolumeRefreshResult(currency = "USD"): MarketVolumeRefreshResult {
  return { stats: emptyMarketVolumeItemStats(currency), pending: [] };
}

/** Chest cooldowns only exist while the game is running and being watched. */
export function emptyBoxTimerState(): BoxTimerState {
  return {
    rows: [],
    catalog: [],
    enabledCount: 0,
    readyCount: 0,
    cooldownCount: 0,
    sortOrder: "cooldown-first",
    currentStageKey: 0,
    currentStageLabel: "",
    defaultCooldownSeconds: 0,
  };
}

/** Stage-clear history has no save-file fallback — it requires the live reader. */
export function emptyStageRunStats(): StageRunStats {
  return { history: [], readerRequired: true };
}

export function emptyRecordLogPage(pageSize = 0): RecordLogPage {
  void pageSize;
  return { entries: [], total: 0, sources: {} };
}

/** Auto-classify only runs while chest drops are observed from live memory. */
export function emptyAutoClassifyState(): AutoClassifyStatePayload {
  return {
    enabled: false,
    totalQueued: 0,
    byCategory: [],
    items: [],
    liveSlots: null,
    paused: false,
    pendingBurstsCount: 0,
  };
}

/** No Steam polling on the web — nothing is ever fetched. */
export function emptyPollingCycleResult(): PollingCycleResult {
  return { targets: 0, priced: 0, rateLimited: 0, failed: 0, aborted: false };
}

export function idleUpdateStatus(): UpdateStatus {
  // "disabled" rather than "idle": the web build has no updater at all, and the
  // About tab renders this phase as "not applicable" instead of a spinner.
  return { phase: "disabled", currentVersion: "" };
}

export const DEFAULT_CATALOG_STATUS: CatalogStatus = {
  catalogVersion: null,
  gameVersion: null,
  stale: false,
  source: "bundled",
  itemCount: 0,
  lastRefreshMs: null,
  lastError: null,
};

export function unavailableAppDataPaths(): AppDataPaths {
  return { userDataDir: "", configPath: "", diagnosticLogPath: "", entries: [] };
}

export function unavailableClearResult(): ClearAppDataResult {
  return { ok: false, cleared: [], error: "desktop-only" };
}
