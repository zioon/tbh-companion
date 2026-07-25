import type { AppLanguage } from "../../../shared/language";
import type { AppConfig, WindowTopmostPrefs } from "../../../shared/types";
import { isLiveMemoryActive } from "../../core/sessionState";
import type { XpTracker } from "../../core/tracker";
import { expandPath, normalizeConfigFromRaw } from "../config";
import { createLogger } from "../log";

const configLog = createLogger("config");
import type { SteamMarketProvider } from "../steamMarketProvider";
import { makeHistoryLogger } from "../historyLog";
import { XpTracker as TrackerCtor } from "../../core/tracker";

export interface ConfigPatchDeps {
  getConfig: () => AppConfig;
  setConfig: (c: AppConfig) => void;
  saveConfig: (c: AppConfig) => void;
  getTracker: () => XpTracker;
  setTracker: (t: XpTracker) => void;
  getMarket: () => SteamMarketProvider | null;
  restartWatcher: () => void;
  setAlwaysOnTop: (v: WindowTopmostPrefs) => void;
  pushStats: () => void;
  resolveAndPushInventory: () => void;
  ensureOwnedPrices: (force?: boolean) => void | Promise<void>;
  onSavePathChange?: () => void;
  /** Start (true) or stop (false) the live-memory reader process. */
  setLiveMemoryEnabled?: (enabled: boolean) => void;
  /** Reset session stats when the effective live-memory mode changes. */
  onLiveMemoryToggled?: () => void;
  /** Toggle Steam Market auto-scan on inventory updates without restart. */
  setMarketAutoScanEnabled?: (enabled: boolean) => void;
  /** Update the USD threshold below which low-value items are skipped on auto-refresh. */
  setMarketLowValueThresholdUsd?: (value: number) => void;
  /** Fires when the UI language changes so the main process can refresh i18n + tray. */
  onLanguageChanged?: (newLanguage: AppLanguage) => void;
  /** 本地高价值价格轮询配置变更：让 LookupPricePollingService 应用新配置（启停/间隔/阈值/收藏列表）。 */
  onLookupPricePollingChanged?: (cfg: AppConfig["lookupPricePolling"]) => void;
}

/** Apply settings patch and run side effects. */
export function applyConfigPatch(deps: ConfigPatchDeps, patch: Partial<AppConfig>): AppConfig {
  const needsWatcher =
    patch.savePath !== undefined ||
    patch.pollIntervalSeconds !== undefined ||
    patch.es3Password !== undefined;
  const needsTracker = patch.rollingWindowMinutes !== undefined;
  const csvToggled = patch.logHistoryCsv !== undefined;

  const prev = deps.getConfig();
  const next = normalizeConfigFromRaw({ ...prev, ...patch });
  deps.setConfig(next);
  deps.saveConfig(next);

  if (patch.savePath !== undefined && expandPath(patch.savePath) !== expandPath(prev.savePath)) {
    deps.onSavePathChange?.();
  }

  const changedKeys = (Object.keys(patch) as (keyof AppConfig)[]).filter(
    (key) => patch[key] !== undefined,
  );
  if (changedKeys.length > 0) {
    const safe = changedKeys.map((key) => (key === "es3Password" ? "es3Password (redacted)" : key));
    configLog.info(`Config updated: ${safe.join(", ")}`);
  }

  const market = deps.getMarket();

  if (patch.currency !== undefined && market) {
    market.setCurrency(next.currency);
    deps.resolveAndPushInventory();
    void deps.ensureOwnedPrices(true);
  }

  if (needsTracker) {
    const tracker = new TrackerCtor(next.rollingWindowMinutes * 60);
    if (next.logHistoryCsv) tracker.onHistory = makeHistoryLogger();
    deps.setTracker(tracker);
  } else if (csvToggled) {
    const tracker = deps.getTracker();
    tracker.onHistory = next.logHistoryCsv ? makeHistoryLogger() : null;
  }

  if (needsWatcher) deps.restartWatcher();

  // Live-memory reader: start/stop the isolated process on toggle (no app restart).
  // Only runs once consent has been accepted.
  if (patch.liveMemory !== undefined) {
    const prevActive = isLiveMemoryActive(prev);
    const nextActive = isLiveMemoryActive(next);
    deps.setLiveMemoryEnabled?.(nextActive);
    if (prevActive !== nextActive) {
      deps.onLiveMemoryToggled?.();
    }
  }

  // Steam Market auto-scan toggle: gate InventoryService's auto refresh on
  // inventory updates without restart.
  if (
    patch.marketAutoScanEnabled !== undefined &&
    prev.marketAutoScanEnabled !== next.marketAutoScanEnabled
  ) {
    deps.setMarketAutoScanEnabled?.(next.marketAutoScanEnabled);
  }

  // Low-value skip threshold: lower values → fewer items skipped, more
  // rate-limit budget consumed. Notify InventoryService so the next
  // refresh applies the new threshold without restart.
  if (
    patch.marketLowValueThresholdUsd !== undefined &&
    prev.marketLowValueThresholdUsd !== next.marketLowValueThresholdUsd
  ) {
    deps.setMarketLowValueThresholdUsd?.(next.marketLowValueThresholdUsd);
  }

  // UI language: refresh the main-process i18n instance and the tray menu
  // (renderer windows refresh themselves from the saved config returned by
  // the SAVE_CONFIG invoke handler — no new IPC channel needed).
  if (patch.language !== undefined && prev.language !== next.language) {
    deps.onLanguageChanged?.(next.language);
  }

  // 本地高价值价格轮询：任何子字段变化都让 service 重新评估（service 内部
  // 会判断 enabled/interval 是否真的变了，避免无谓重启定时器）。
  if (patch.lookupPricePolling !== undefined) {
    deps.onLookupPricePollingChanged?.(next.lookupPricePolling);
  }

  deps.setAlwaysOnTop(next.topmost);
  deps.pushStats();
  deps.resolveAndPushInventory();

  return { ...next };
}
