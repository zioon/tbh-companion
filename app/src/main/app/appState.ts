import {
  app,
  BrowserWindow,
  dialog,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  loadConfig,
  saveConfig,
  expandPath,
  normalizeConfigFromRaw,
  type AppConfig,
} from "../config";
import { TrackingService } from "../services/TrackingService";
import { InventoryService } from "../services/InventoryService";
import { ChestService } from "../services/ChestService";
import { PetService } from "../services/PetService";
import { BoxTimerService } from "../services/BoxTimerService";
import { StageRunService } from "../services/StageRunService";
import { SessionStateService } from "../services/SessionStateService";
import { LookupService } from "../services/LookupService";
import { LookupPriceService } from "../services/LookupPriceService";
import { LookupPricePollingService } from "../services/LookupPricePollingService";
import { MarketVolumeService } from "../services/MarketVolumeService";
import { getSteamItemNameIdService } from "../services/steamItemNameId";
import { LiveMemoryService } from "../services/LiveMemoryService";
import { CatalogRefreshService } from "../catalogRefreshService";
import { AutoClassifyService } from "../services/AutoClassifyService";
import { loadActBossTrackerRoutes, loadCommonChestTrackerRoutes } from "../../core/stageBoxTracker";
import { broadcast } from "../services/broadcast";
import { applyConfigPatch } from "../ipc/configPatch";
import { IPC } from "../../../shared/ipc";
import { clearDiagnosticLogs, createLogger, logRendererError } from "../log";
import { clearAppDataFiles, getAppDataPaths, resolveUserDataDir } from "../services/appData";
import { UpdateService } from "../services/UpdateService";
import { NotificationService } from "../services/NotificationService";
import type {
  AppDataClearTarget,
  BoxTrackerSortOrder,
  ClassifyPromptResolvePayload,
  ExportMarketVolumeResult,
  ImportMarketVolumeResult,
  RendererLogPayload,
  SessionUiSnapshot,
  WindowLayoutPrefs,
} from "../../../shared/types";

const appDataLog = createLogger("appData");
import { createMainWindow as buildMainWindow } from "../windows/mainWindow";
import { createOverlayWindow as buildOverlayWindow } from "../windows/overlayWindow";
import { createBoxTrackerWindow as buildBoxTrackerWindow } from "../windows/boxTrackerWindow";
import { isAppQuitting, rebuildTrayMenu } from "../tray/trayService";
import { applyWindowTopmost } from "../windows/alwaysOnTop";
import { changeLanguage, readGameLanguage, t } from "../i18n";
import { resolveLanguage, type ResolvedLanguage } from "../../../shared/language";
import { loadLocaleCatalog, mergeGameLocaleIntoCatalog } from "../../core/localeCatalog";
import { selectHistoryRefreshTargets } from "../../core/lookupPrice";
import { POLLING_DEFAULT_THRESHOLD_USD } from "../services/LookupPricePollingService";

let config: AppConfig;

/**
 * 包装 normalizeConfigFromRaw，注入运行时派生字段 `resolvedLanguage` 与
 * `stageMetadata`。`resolvedLanguage` 仅当 config.language === "game" 时填充
 * （从游戏注册表读取）；其它情况下字段为 undefined，渲染进程会自行用
 * resolveLanguage(cfg.language, navigator.language) 推断。
 *
 * `stageMetadata` 在每次调用时都填充（stageKey → 本地化关卡名），供渲染
 * 进程的 `boxLootFilters` 文本匹配使用（无需自己重新读取 catalog）。
 *
 * 主进程读注册表是因为渲染进程没有 reg.exe 访问权限；通过现有的 getConfig
 * IPC 返回值传递，无需新增 IPC 通道。
 */
function getConfigWithRuntime(): AppConfig {
  const base = normalizeConfigFromRaw(config);
  // 计算解析后的语言：game 模式读注册表（失败则回退到 system locale）；
  // auto 模式按 system locale 推断；具体语言直接使用其本身。该值既用于
  // 填充 `resolvedLanguage`（仅 game 模式），也用于加载 LocaleCatalog。
  const gameLang = base.language === "game" ? readGameLanguage() : null;
  const systemLocale = safeGetSystemLocale();
  const resolved: ResolvedLanguage = resolveLanguage(base.language, systemLocale, gameLang);

  // 构建 stageMetadata：catalog.stages 的 key 是 "1<act><stage>" 4 位数（前置
  // "1" 固定为 NORMAL 难度），同一 act/stage 在 4 个难度下共用同一本地化名。
  // 对每个 catalog 条目展开成 4 个 stageKey，覆盖所有用户可能用到的过滤目标。
  const catalog = loadLocaleCatalog(resolved);
  const stageMetadata: Record<number, string> = {};
  for (const [catalogKey, name] of Object.entries(catalog.stages)) {
    if (catalogKey.length !== 4) continue;
    const act = catalogKey.charCodeAt(1) - 48;
    const stage = parseInt(catalogKey.slice(2), 10);
    if (!Number.isFinite(act) || !Number.isFinite(stage)) continue;
    for (let diff = 1; diff <= 4; diff++) {
      const stageKey = diff * 1000 + act * 100 + stage;
      stageMetadata[stageKey] = name;
    }
  }

  // 沿用既有语义：只有当 language === "game" 且注册表读取成功时才回填
  // resolvedLanguage，其它情况让渲染进程自行解析。
  if (base.language === "game" && gameLang) {
    return { ...base, resolvedLanguage: resolved, stageMetadata };
  }
  return { ...base, stageMetadata };
}

/**
 * `app.getLocale()` 在 app.whenReady() 之前会抛错；此处兜底返回 "en-US"。
 * 与 i18n.ts 中的 safeGetLocale 行为一致，用于 `getConfigWithRuntime` 在
 * 启动早期被调用时（理论上不会发生，但兜底以防崩溃）。
 */
function safeGetSystemLocale(): string {
  try {
    return app.getLocale();
  } catch {
    return "en-US";
  }
}

const sessionState = new SessionStateService();
const inventory = new InventoryService();
const chests = new ChestService();
const pets = new PetService();
const boxTimers = new BoxTimerService();
const stageRuns = new StageRunService();
const lookup = new LookupService();
const lookupPrices = new LookupPriceService();
const marketVolume = new MarketVolumeService({
  getCatalog: () => lookup.getCatalog(),
  getCurrency: () => config.currency,
  // 用户填写的 Steam 社区 Cookie（可为空）；带上后 pricehistory（历史走势）
  // 才能拿到登录后的真实历史成交额，否则回退到轮询采样走势。
  getCookie: () => config.steamCookie ?? "",
  // 价格历史查询的批次数量与批间间隔（可在 Settings 调整，规避 Steam 限流）。
  getHistoryBatchSize: () => config.marketHistoryBatchSize,
  getHistoryBatchDelaySec: () => config.marketHistoryBatchDelaySec,
  // 刷新排序：星标无条件优先；无交易额物品按图鉴快照价格兜底；覆盖率阈值决定
  // 自动路径「用最少刷新覆盖最多交易额」的主区大小。
  getWatchedHashes: () => config.lookupPricePolling?.watchedHashes ?? [],
  getSnapshotPriceUsd: (hash) => {
    const snapshot = lookupPrices.getSnapshot();
    const price = snapshot?.prices?.[hash];
    return typeof price === "number" && price > 0 ? price : 0;
  },
  getCoverageThreshold: () => config.marketHistoryCoverageThreshold,
  // 历史走势覆盖 owned ∪ watched 的物品集合（与轮询目标一致，控制 pricehistory 请求量）。
  getTargetHashes: () => {
    const watched = config.lookupPricePolling.watchedHashes ?? [];
    return [...new Set([...inventory.getOwnedPriceHashes(), ...watched])];
  },
  // 交易页「刷新历史价格」的实时进度：转为 MarketVolumeRefreshProgress 推给 renderer。
  onHistoryProgress: (p) => {
    broadcast(IPC.MARKET_VOLUME_REFRESH_PROGRESS, {
      running: p.running,
      total: p.total,
      done: p.done,
      currentHash: p.current,
      ...(p.cookieExpired ? { cookieExpired: true } : {}),
      ...(p.updatedItem ? { updatedItem: p.updatedItem } : {}),
      ...(p.pending ? { pending: p.pending } : {}),
    });
    // 该物品成功返回并已并入 priceHistory 时，同步广播顶部交易额走势，
    // 让最上方走势图的时间范围随每个成功物品实时更新（而非等整批结束）。
    if (p.trendChanged) {
      broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
    }
  },
});
const lookupPricePolling = new LookupPricePollingService({
  lookupPrices,
  getCurrency: () => config.currency,
  // 注入共享的 nameId 单例，让 polling 在抓 buyOrder 时复用客户端已有的
  // item_nameid 缓存（bundled map + userData/steam_item_nameids.json），
  // 避免每个 hash 都重新抓 listing HTML。未注入时 polling 跳过 buyOrder。
  nameIdService: getSteamItemNameIdService(),
  broadcast: (channel, payload) => broadcast(channel, payload),
  onStatusChange: (status) => broadcast(IPC.LOOKUP_PRICES_POLL_STATUS, status),
  // 市场交易额：把每次抓到的成交量累积进 MarketVolumeService，每轮结束聚合
  // 一次采样并广播给 renderer。
  onVolumeSample: (sample) =>
    marketVolume.recordVolume(sample.hash, sample.volume, sample.median, sample.currency),
  // 轮询成功结束时，把市场交易额的实时映射裁剪到本轮目标集，清理已取消星标的
  // 陈旧条目，避免它们持续被计入总交易额与兜底卡片。
  onCycleComplete: (targets) => marketVolume.pruneLive(new Set(targets)),
  onCycleEnd: () => {
    const updated = marketVolume.sampleNow();
    if (updated) {
      broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
      broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
    }
    // 轮询结束后顺带刷新一次 pricehistory 历史走势（带缓存去抖，不阻塞轮询）。
    marketVolume.refreshHistory().then((didRefresh) => {
      if (didRefresh) {
        broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
        broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
      }
    });
  },
});
const liveMemory = new LiveMemoryService();
const catalogRefresh = new CatalogRefreshService(
  inventory.getGameData(),
  liveMemory,
  resolveUserDataDir(),
  (channel, payload) => broadcast(channel, payload),
  () => config.gameInstallDir ?? "",
);
liveMemory.setOnGameVersionChanged(() => catalogRefresh.onGameVersionChanged());
/**
 * AutoClassifyService instance, created in `startTracking()` after
 * `tracking.start()` has instantiated the chest-drop and box-open trackers.
 * Disposed in `stopTracking()`. Held as `let` so the toggle IPC handler can
 * reach it via closure.
 */
let autoClassify: AutoClassifyService | null = null;

function focusMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  openMainWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

const notifications = new NotificationService(
  () => normalizeConfigFromRaw(config),
  focusMainWindow,
  t,
);
const updates = new UpdateService({
  getConfig: () => getConfigWithRuntime(),
  onUpdateAvailable: (version) => notifications.showUpdateAvailable(version),
});

boxTimers.setOnChestReady((payload) => notifications.showChestReady(payload));
boxTimers.setOnChestDropped((payload) => notifications.showChestDrop(payload));
inventory.setOnAlmostFull(
  (payload) => notifications.showInventoryAlmostFull(payload),
  () => normalizeConfigFromRaw(config).inventoryAlmostFullThresholdPercent,
);
const tracking = new TrackingService(
  (snap) => inventory.onInventory(snap),
  (text, mtime) => {
    const inv = inventory.parseFromSave(text, mtime);
    chests.onSave(text, mtime, inv.chests);
    pets.onSave(text, mtime);
    return inv;
  },
  (stageKey) => boxTimers.setCurrentStageKey(stageKey),
  sessionState,
  (events) => notifications.showHeroLevelUp(events),
  (stageKey) => {
    boxTimers.tryMarkDroppedFromLiveStage(stageKey);
  },
  (stageKey, clearTimeSec, xpGained, goldGained) => {
    stageRuns.recordClear(stageKey, clearTimeSec, xpGained, goldGained);
  },
  (stageKey, failedWave) => {
    stageRuns.recordFailure(stageKey, failedWave);
  },
  // Live chest slot counts from PlayerSaveData.BoxData runtime are no longer
  // routed to AutoClassifyService — the service now tracks slots via save data
  // (recalibration on every save parse) + real-time adjustments (drops +1,
  // opens/auto-opens -1). This works on all game versions including v1.00.28
  // where the live memory path is unavailable. The `chestSlots` field still
  // exists in LiveMemorySnapshot for diagnostic/display purposes.
);

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let boxTrackerWindow: BrowserWindow | null = null;

function persistWindowLayout<K extends keyof WindowLayoutPrefs>(
  key: K,
  entry: NonNullable<WindowLayoutPrefs[K]>,
): void {
  config = {
    ...config,
    windowLayout: {
      ...config.windowLayout,
      [key]: entry,
    },
  };
  saveConfig(config);
}

/**
 * 为当前解析出的语言构建一份新的 LocaleCatalog，并注入到所有依赖本地化
 * 的服务（TrackingService / InventoryService / BoxTimerService /
 * StageRunService / LiveMemoryService）。在启动期间和语言切换时各调用一次。
 *
 * 注意：服务自身的 `setLocaleCatalog` 不会主动 re-broadcast；调用方需在
 * 语言切换后显式触发 re-emit（见 `onLanguageChanged`）。
 */
function reloadLocaleCatalog(): void {
  const base = normalizeConfigFromRaw(config);
  const gameLang = base.language === "game" ? readGameLanguage() : null;
  const resolved: ResolvedLanguage = resolveLanguage(
    base.language,
    safeGetSystemLocale(),
    gameLang,
  );
  const baseCatalog = loadLocaleCatalog(resolved);
  // Overlay game-extracted translations (ItemName_*, StageName_*, etc.) on top
  // of the bundled offline JSON. This is what gives the 12 languages without
  // dedicated locale_strings_<lang>.json files native item/stage/hero names
  // from the game's own localization bundles. For the 4 languages with
  // offline JSON, game values still win (they track the current game version).
  const gameLocale = catalogRefresh.getLocaleData();
  const catalog = mergeGameLocaleIntoCatalog(baseCatalog, gameLocale, resolved);
  const gameItemCount = gameLocale
    ? Object.keys(gameLocale.locales[resolved] ?? {}).filter((k) => k.startsWith("ItemName_"))
        .length
    : 0;
  appDataLog.info(
    `catalog loaded: lang=${resolved} base=${Object.keys(baseCatalog.items).length} items, game=${gameItemCount} items`,
  );
  tracking.setLocaleCatalog(catalog);
  inventory.setLocaleCatalog(catalog);
  boxTimers.setLocaleCatalog(catalog);
  stageRuns.setLocaleCatalog(catalog);
  liveMemory.setLocaleCatalog(catalog);
  lookup.setLocaleCatalog(catalog);
}

export function startTracking(): SessionUiSnapshot {
  config = loadConfig();
  inventory.initMarket(config.currency);
  inventory.setAutoScanEnabled(config.marketAutoScanEnabled);
  inventory.setLowValueThresholdUsd(config.marketLowValueThresholdUsd);
  // Pass resolveUserDataDir() so a previously refreshed userData/gamedata.json
  // is preferred over the bundled copy — otherwise a manual catalog refresh
  // wouldn't survive a restart and the UI would show a false "stale" banner.
  inventory.loadGameData(resolveUserDataDir());
  lookupPrices.start();
  // 启动本地高价值价格轮询（如果配置开启了）。start() 内部会立即触发一次
  // 轮询，然后按 intervalMinutes 周期性触发。即使图鉴快照尚未拉到，
  // selectPollingTargets 会返回空列表，cycle 安全跳过。
  lookupPricePolling.setConfig(config.lookupPricePolling);
  // Restore the persisted opt-in reader state (off by default; only if consented).
  if (config.liveMemory.enabled && config.liveMemory.consentAccepted) liveMemory.start();
  liveMemory.setOnSnapshot((snap) => tracking.ingestLiveFrame(snap));
  const ui = sessionState.load(config);
  tracking.start(config);
  // Feed inventory + lookup-price snapshots to TrackingService for box-open price resolution.
  tracking.setGameDataLookup(inventory.getGameDataLookup());
  // Inject the lookup catalog so TrackingService.variantIndex is built from
  // the same source as the renderer's itemIndex (lookup_items.json). Without
  // this, variant remap could return ids only gamedata.json has — the renderer
  // would then show "item not found" for high-rarity drops.
  tracking.setLookupCatalog(lookup.getCatalog());
  // Inject the lookup catalog into InventoryService too, so the inventory
  // worker can replace placeholder `ItemName_<id>` names from gamedata.json
  // with real display names — keeps `marketHashName()`, per-row price refresh,
  // and string search working for items the EN stringtable didn't resolve
  // (e.g. Empire 50th Anniversary Coin).
  inventory.setLookupCatalog(lookup.getCatalog());
  tracking.setInventorySnapshot(inventory.getInventory());
  inventory.setOnInventoryUpdated((snap) => tracking.setInventorySnapshot(snap));
  tracking.setLookupPriceSnapshot(lookupPrices.getSnapshot());
  inventory.setLookupPriceSnapshot(lookupPrices.getSnapshot());
  // Single subscriber — fan out to both tracking (resolved item prices) and
  // inventory (low-value pre-filter on auto-refresh).
  lookupPrices.setOnSnapshotUpdated((snap) => {
    tracking.setLookupPriceSnapshot(snap);
    inventory.setLookupPriceSnapshot(snap);
  });
  // AutoClassifyService wires its callbacks into the trackers via the service
  // setter; the trackers query the service at call time, so toggling enabled/
  // disabled doesn't require re-wiring. Must be created after `tracking.start`
  // so the tracker instances exist for the deps getters to return.
  autoClassify = new AutoClassifyService({
    chestDropTracker: tracking.getChestDropTracker(),
    boxOpenTracker: tracking.getBoxOpenTracker(),
    chestService: chests,
    stageBoxCatalog: () => boxTimers.getState().catalog,
    actBossRoutes: () => loadActBossTrackerRoutes(),
    commonRoutes: () => loadCommonChestTrackerRoutes(),
    getCurrentStageKey: () => tracking.getCurrentStageKey(),
    // Inventory (item bag) used/capacity from the save. When `used >=
    // capacity` the game pauses all chest auto-open timers (it cannot drop
    // loot into a full bag); AutoClassifyService freezes effectiveNow at
    // that moment and resumes by shifting queued items' autoOpenAtMs
    // forward once the inventory is no longer full. Returns null before
    // the first save parse — pause detection stays disabled until then.
    getInventoryStatus: () => {
      const inv = inventory.getInventory();
      if (!inv) return null;
      return { used: inv.inventoryUsed, capacity: inv.inventoryCapacity };
    },
    broadcast,
    // A stage-boss (rare) drop recovered from the save slot increase during
    // reconcile (live-memory reader missed it) arms the same BoxTimer cooldown
    // as a live-detected rare drop.
    onLiveStageBossDrop: (stageKey) => boxTimers.tryMarkDroppedFromLiveStage(stageKey),
  });
  // On every save parse, ChestService reports the current per-category slot
  // counts; AutoClassifyService reconciles its queue against those counts —
  // pruning entries whose chest already opened (queue > slots) and logging
  // when drops were missed (queue < slots). This keeps the loot queue accurate
  // even when chests open via auto-open (no unclassified burst) or manually.
  const autoClassifyRef = autoClassify;
  chests.setOnReconcile((slots) => autoClassifyRef.reconcileWithChestSlots(slots));
  autoClassify.setEnabled(config.lootAutoClassifyEnabled);
  tracking.setAutoClassifyService(autoClassify);
  // Load the LocaleCatalog for the current resolved language and inject it
  // into all 5 localizing services. Done after `tracking.start()` so the
  // service instances exist; subsequent snapshots will use the catalog when
  // building Stats / BoxTimerState / StageRunStats / ResolvedInventory /
  // LiveMemorySnapshot.heroes.
  reloadLocaleCatalog();
  // Re-push inventory after locale catalog is set so the renderer receives
  // localized item names immediately. (Inventory was already resolved in
  // loadGameData() above — before the catalog was available — so the first
  // broadcast carries English/placeholder names without this nudge.)
  // TrackingService pushes on its own 1-second cadence and will pick up the
  // new catalog on the next tick; no explicit pushStats needed here.
  inventory.resolveAndPushInventory();

  // Auto-trigger catalog refresh if locale data is missing or stale. This
  // ensures the 12 languages without offline locale_strings_<lang>.json get
  // native item/stage/hero names from the game's own locale bundles on first
  // run (or after a game update). Fire-and-forget: refresh runs in the
  // background, and on success we reload the catalog + re-emit snapshots so
  // the renderer sees the updated names without a manual refresh click.
  void (async () => {
    const status = catalogRefresh.getStatus();
    const localeData = catalogRefresh.getLocaleData();
    const needsRefresh = !localeData || status.stale;
    if (!needsRefresh) return;
    const result = await catalogRefresh.refresh();
    if (!result.ok) return;
    reloadLocaleCatalog();
    // Re-emit snapshots so the renderer picks up the new translations.
    tracking.pushStats();
    boxTimers.push();
    stageRuns.push();
    inventory.resolveAndPushInventory();
  })();

  return ui;
}

/** Reopen Mini overlay / Stage chest tracker from persisted UI flags. */
export function restoreSessionWindows(ui: SessionUiSnapshot): void {
  if (ui.miniOverlayOpen) {
    openOverlayWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    sessionState.setMiniOverlayOpen(true);
  } else {
    openMainWindow();
  }
  if (ui.boxTrackerOpen) {
    openBoxTrackerWindow();
    sessionState.setBoxTrackerOpen(true);
  }
}

export function stopTracking(): void {
  tracking.flushSession();
  tracking.stop();
  autoClassify?.setEnabled(false);
  autoClassify = null;
  boxTimers.stopTick();
  lookupPrices.stop();
  lookupPricePolling.stop();
  liveMemory.stop();
}

export function openMainWindow(): BrowserWindow {
  return buildMainWindow(
    () => mainWindow,
    (w) => {
      mainWindow = w;
    },
    () => config.topmost.main,
    config.windowLayout?.main,
    (entry) => persistWindowLayout("main", entry),
  );
}

export function openOverlayWindow(): BrowserWindow {
  return buildOverlayWindow(
    () => overlayWindow,
    (w) => {
      overlayWindow = w;
    },
    () => config.topmost.overlay,
    () => {
      if (isAppQuitting()) return;
      sessionState.setMiniOverlayOpen(false);
      tracking.flushSession();
    },
    config.windowLayout?.overlay,
    (entry) => persistWindowLayout("overlay", entry),
  );
}

export function openBoxTrackerWindow(): BrowserWindow {
  return buildBoxTrackerWindow(
    () => boxTrackerWindow,
    (w) => {
      boxTrackerWindow = w;
    },
    () => config.topmost.boxTracker,
    () => boxTimers.startTick(),
    () => {
      boxTimers.stopTick();
      if (isAppQuitting()) return;
      sessionState.setBoxTrackerOpen(false);
      tracking.flushSession();
    },
    config.windowLayout?.boxTracker,
    (entry) => persistWindowLayout("boxTracker", entry),
  );
}

export function getAppServices() {
  return {
    // Exposed for lifecycle teardown (before-quit disposes the inventory worker).
    inventory,
    getStats: () => tracking.getStats(),
    resetTracker: () => {
      tracking.reset();
      stageRuns.resetStorage();
    },
    getInventory: () => inventory.getInventory(),
    getChests: () => chests.getChests(),
    getPets: () => pets.getPets(),
    getBoxTimers: () => boxTimers.getState(),
    markBoxDropped: (boxId: number) => boxTimers.markDropped(boxId),
    clearBoxTimer: (boxId: number) => boxTimers.clearTimer(boxId),
    setBoxTrackerBoxes: (boxIds: number[]) => boxTimers.setEnabledBoxIds(boxIds),
    setBoxTrackerCooldown: (boxId: number, cooldownSeconds: number) =>
      boxTimers.setCooldownSeconds(boxId, cooldownSeconds),
    clearBoxTrackerCooldown: (boxId: number) => boxTimers.clearCooldownOverride(boxId),
    setBoxTrackerFarmStage: (boxId: number, stageKey: number) =>
      boxTimers.setFarmStageKey(boxId, stageKey),
    clearBoxTrackerFarmStage: (boxId: number) => boxTimers.clearFarmStageOverride(boxId),
    setBoxTrackerNotify: (boxId: number, enabled: boolean) =>
      boxTimers.setBoxTrackerNotify(boxId, enabled),
    setBoxTrackerSortOrder: (sortOrder: BoxTrackerSortOrder) => boxTimers.setSortOrder(sortOrder),
    pricesStatus: () => inventory.pricesStatus(),
    refreshPrices: (force?: boolean) => inventory.refreshPrices(force),
    refreshItemPrices: (itemKey: number) => inventory.refreshItemPrices(itemKey),
    cancelPrices: () => inventory.cancelPrices(),
    setCurrency: (iso: string) => {
      config.currency = iso;
      saveConfig(config);
      return inventory.setCurrency(iso);
    },
    setMarketAutoScanEnabled: (enabled: boolean) => {
      inventory.setAutoScanEnabled(enabled);
      config = { ...config, marketAutoScanEnabled: enabled };
      saveConfig(config);
    },
    setMarketLowValueThresholdUsd: (value: number) => {
      inventory.setLowValueThresholdUsd(value);
      config = { ...config, marketLowValueThresholdUsd: value };
      saveConfig(config);
    },
    getConfig: () => getConfigWithRuntime(),
    pickSaveFile: async (): Promise<string | null> => {
      const current = expandPath(config.savePath);
      const parent =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const options: OpenDialogOptions = {
        title: t("dialogs:chooseSaveFile"),
        defaultPath: dirname(current),
        properties: ["openFile"],
        filters: [{ name: t("dialogs:saveFileFilter"), extensions: ["es3"] }],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
    saveConfigPatch: (patch: Partial<AppConfig>) =>
      applyConfigPatch(
        {
          getConfig: () => config,
          setConfig: (c) => {
            config = c;
            tracking.updateConfig(c);
          },
          saveConfig,
          getTracker: () => tracking.getTracker(),
          setTracker: (t) => tracking.setTracker(t),
          getMarket: () => inventory.getMarket(),
          restartWatcher: () => tracking.restartWatcher(),
          setAlwaysOnTop: (v) => {
            if (mainWindow && !mainWindow.isDestroyed()) applyWindowTopmost(mainWindow, v.main);
            if (overlayWindow && !overlayWindow.isDestroyed())
              applyWindowTopmost(overlayWindow, v.overlay, true);
            if (boxTrackerWindow && !boxTrackerWindow.isDestroyed())
              applyWindowTopmost(boxTrackerWindow, v.boxTracker, true);
          },
          pushStats: () => tracking.pushStats(),
          resolveAndPushInventory: () => inventory.resolveAndPushInventory(),
          ensureOwnedPrices: (force) => inventory.ensureOwnedPrices(force),
          onSavePathChange: () => tracking.onSavePathChanged(),
          setLiveMemoryEnabled: (enabled) => (enabled ? liveMemory.start() : liveMemory.stop()),
          onLiveMemoryToggled: () => tracking.onLiveMemoryToggled(),
          setMarketAutoScanEnabled: (enabled) => inventory.setAutoScanEnabled(enabled),
          setMarketLowValueThresholdUsd: (value) => inventory.setLowValueThresholdUsd(value),
          onLookupPricePollingChanged: (cfg) => lookupPricePolling.setConfig(cfg),
          onLanguageChanged: (newLanguage) => {
            changeLanguage(newLanguage);
            // Swap the LocaleCatalog on all 5 localizing services so the
            // next snapshot / build uses the new language. `applyConfigPatch`
            // re-broadcasts Stats + Inventory right after this callback via
            // its own `pushStats` + `resolveAndPushInventory` deps, so we
            // only need to re-emit the services it doesn't touch.
            reloadLocaleCatalog();
            boxTimers.push();
            stageRuns.push();
            rebuildTrayMenu(getAppServices());
          },
        },
        patch,
      ),
    getDataPaths: () => getAppDataPaths(),
    clearAppData: (target: AppDataClearTarget) => {
      const result = clearAppDataFiles(target);
      if (!result.ok) {
        appDataLog.warn(`Cache clear failed (${target}): ${result.error ?? "unknown"}`);
        return result;
      }
      if (result.cleared.length > 0) {
        appDataLog.info(`Cache cleared (${target}): ${result.cleared.join(", ")}`);
      }

      const reloadPrices = target === "prices" || target === "all-except-config";
      const reloadLookupPrices = target === "lookup-prices" || target === "all-except-config";
      const reloadTimers = target === "box-timers" || target === "all-except-config";
      const reloadStageRuns = target === "stage-runs" || target === "all-except-config";
      const reloadSession = target === "session" || target === "all-except-config";

      if (reloadPrices) inventory.reloadPriceCache();
      if (reloadLookupPrices) lookupPrices.reloadFromDisk();
      if (reloadTimers) boxTimers.resetStorage();
      if (reloadStageRuns) stageRuns.resetStorage();
      if (reloadSession) {
        tracking.onSessionFileDeleted();
        tracking.clearSession();
      }

      return result;
    },
    clearDiagnosticLogs: () => {
      const result = clearDiagnosticLogs();
      if (result.ok && result.cleared.length > 0) {
        appDataLog.info(`Diagnostic logs cleared: ${result.cleared.join(", ")}`);
      }
      return result;
    },
    logRendererError: (payload: RendererLogPayload) => {
      logRendererError(payload);
    },
    openOverlay: () => {
      openOverlayWindow();
      // Destroy the main window to release renderer resources while in mini
      // mode. The window is re-created on next showMain().
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        mainWindow = null;
      }
      sessionState.setMiniOverlayOpen(true);
      tracking.flushSession();
    },
    openBoxTracker: () => {
      openBoxTrackerWindow();
      sessionState.setBoxTrackerOpen(true);
      tracking.flushSession();
    },
    closeBoxTracker: () => boxTrackerWindow?.close(),
    minimizeBoxTracker: () => {
      if (boxTrackerWindow && !boxTrackerWindow.isDestroyed()) {
        boxTrackerWindow.minimize();
      }
    },
    showMain: () => {
      openMainWindow();
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
      overlayWindow?.close();
      sessionState.setMiniOverlayOpen(false);
      tracking.flushSession();
    },
    closeOverlay: () => {
      overlayWindow?.close();
    },
    flushSession: () => tracking.flushSession(),
    getUpdateStatus: () => updates.getStatus(),
    checkForUpdates: () => updates.checkForUpdates(),
    downloadUpdate: () => updates.downloadUpdate(),
    quitAndInstall: () => updates.quitAndInstall(),
    startUpdates: () => updates.start(),
    stopUpdates: () => updates.stop(),
    getLookupCatalog: () => lookup.getCatalog(),
    getLookupSources: () => lookup.getSources(),
    getLookupSynthesisModel: () => lookup.getSynthesisModel(),
    getOfferings: () => lookup.getOfferings(),
    getLookupPrices: () => lookupPrices.getSnapshot(),
    getLookupPricePollStatus: () => lookupPricePolling.getPollingStatus(),
    pollLookupPrices: (hash?: string) =>
      hash ? lookupPricePolling.pollSingleHash(hash) : lookupPricePolling.pollOnce(),
    getMarketVolume: () => {
      const stats = marketVolume.getStats();
      // 打开 Market 页时按需刷新一次 pricehistory 历史走势（带缓存去抖）。
      marketVolume.refreshHistory().then((didRefresh) => {
        if (didRefresh) {
          broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
          broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
        }
      });
      return stats;
    },
    getMarketVolumeItems: () => {
      const items = marketVolume.getVolumeItems();
      // 打开交易页时按需刷新一次 pricehistory 历史走势（带缓存去抖），
      // 让物品卡片尽量带上逐小时走势；刷新成功推送新数据。
      marketVolume.refreshHistory().then((didRefresh) => {
        if (didRefresh) broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
      });
      return items;
    },
    // 交易页「刷新历史价格」按钮：强制拉取「星标 ∪ 快照价格达到阈值」的物品的
    // pricehistory，绕过 30min 缓存，刷新成功后推送交易额走势与物品卡片。
    refreshMarketVolumeItems: (cardOrder?: string[]) => {
      const items = marketVolume.getVolumeItems();
      let orderedTargets: string[];
      if (cardOrder && cardOrder.length > 0) {
        // renderer 传入的「物品卡排序」（当前窗口成交额降序）：严格按此顺序刷新，
        // 使逐个更新的顺序与交易页物品卡片当前排序完全一致。
        orderedTargets = [...new Set(cardOrder.filter(Boolean))];
      } else {
        const snapshot = lookupPrices.getSnapshot();
        const polling = config.lookupPricePolling ?? {};
        const targets = selectHistoryRefreshTargets({
          snapshot,
          watchedHashes: polling.watchedHashes ?? [],
          thresholdUsd: polling.thresholdUsd ?? POLLING_DEFAULT_THRESHOLD_USD,
        });
        // 无星标/快照达标物品时（目标为空），兜底为交易页主列表展示的全部物品，
        // 保证点「刷新」必有实际目标——进而有进度条、占位卡片与刷新亮环反馈，
        // 避免目标为空时刷新瞬间结束、页面毫无反应。
        const fallbackTargets = targets.length > 0 ? targets : items.items.map((i) => i.hash);
        // 二次及以后刷新按交易额从高到低依次刷新：占位卡片与拉取顺序都先服务
        // 交易额高的物品。首次刷新（尚无交易额数据）保持目标集原顺序（星标优先、
        // 快照达标按价格降序）。
        orderedTargets = marketVolume.sortTargetsByVolume(fallbackTargets);
      }
      // 待刷新目标物品的占位卡片（刷新进行中提前展示）。
      const pending = marketVolume.buildPendingItems(orderedTargets);
      marketVolume.refreshHistory(Date.now(), { targets: orderedTargets, force: true }).then(() => {
        broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
        broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
      });
      return { stats: items, pending };
    },
    // 交易页单物品卡片上的「手动刷新」：只拉取该 hash 的历史价格并实时并入，
    // 更新后推送整体数据（卡片与顶部走势实时刷新）。遇 Cookie 失效走进度通道
    // 让交易页提示横幅，与整批刷新行为一致。
    refreshMarketVolumeItem: async (hash: string) => {
      const result = await marketVolume.refreshItem(hash);
      broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
      broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
      if (result.cookieExpired) {
        broadcast(IPC.MARKET_VOLUME_REFRESH_PROGRESS, {
          running: false,
          total: 1,
          done: 1,
          currentHash: null,
          cookieExpired: true,
        });
      }
    },
    // 手动终止当前整次历史价格刷新。
    cancelHistoryRefresh: () => marketVolume.abortHistoryRefresh(),
    // 交易页「导出历史数据」：保存对话框选择路径后写入完整历史快照 JSON。
    exportMarketVolumeHistory: async (): Promise<ExportMarketVolumeResult> => {
      const parent =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const options: SaveDialogOptions = {
        title: t("dialogs:exportMarketVolumeTitle"),
        defaultPath: `market_volume_history_${new Date()
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, "")}.json`,
        filters: [{ name: t("dialogs:jsonFilter"), extensions: ["json"] }],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true };
      try {
        writeFileSync(result.filePath, JSON.stringify(marketVolume.exportHistory(), null, 2));
        return { ok: true, path: result.filePath };
      } catch (err) {
        appDataLog.warn(`Failed to export market volume history: ${(err as Error).message}`);
        return { ok: false, reason: (err as Error).message };
      }
    },
    // 交易页「导入历史数据」：打开对话框读 JSON，整体替换历史数据并广播刷新。
    importMarketVolumeHistory: async (): Promise<ImportMarketVolumeResult> => {
      const parent =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const options: OpenDialogOptions = {
        title: t("dialogs:importMarketVolumeTitle"),
        properties: ["openFile"],
        filters: [{ name: t("dialogs:jsonFilter"), extensions: ["json"] }],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };
      const filePath = result.filePaths[0] ?? "";
      let json: string;
      try {
        json = readFileSync(filePath, "utf-8");
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
      const itemCount = marketVolume.importHistory(json);
      if (itemCount === null) return { ok: false, reason: "invalid_backup" };
      broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
      broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
      return { ok: true, itemCount };
    },
    getLiveMemory: () => liveMemory.getSnapshot(),
    getLiveMemoryStatus: () => liveMemory.getStatus(),
    getStageRuns: () => stageRuns.getStats(),
    getCatalogStatus: () => catalogRefresh.getStatus(),
    refreshCatalog: async () => {
      const result = await catalogRefresh.refresh();
      if (result.ok) {
        // Reload the LocaleCatalog so the 12 languages without offline
        // locale_strings_<lang>.json pick up game-bundle translations
        // (ItemName_*, StageName_*, etc.) from the freshly-extracted
        // locale data. Without this, manual catalog refresh would write
        // locale.json but never apply it to the running services.
        reloadLocaleCatalog();
        // Re-emit snapshots with the updated catalog.
        tracking.pushStats();
        boxTimers.push();
        stageRuns.push();
        inventory.resolveAndPushInventory();
      }
      return result;
    },
    getLocaleData: () => catalogRefresh.getLocaleData(),
    resetLootBox: (boxKey: string) => tracking.resetLootBox(boxKey),
    resetLootAll: () => tracking.resetLootAll(),
    reclassifyLootItem: (itemKey: number, fromBoxKey: string, toBoxKey: string) =>
      tracking.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey),
    setLootAutoClassifyEnabled: (enabled: boolean) => {
      autoClassify?.setEnabled(enabled);
      config = { ...config, lootAutoClassifyEnabled: enabled };
      saveConfig(config);
    },
    resolveClassifyPrompt: (payload: ClassifyPromptResolvePayload) =>
      autoClassify?.resolvePrompt(payload),
    getAutoClassifyState: () =>
      autoClassify?.getQueueSnapshot() ?? {
        enabled: false,
        totalQueued: 0,
        byCategory: [
          { category: "common", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
          { category: "rare", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
          { category: "act", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
        ],
        items: [],
        liveSlots: null,
        paused: false,
      },
  };
}

export type AppServices = ReturnType<typeof getAppServices>;
