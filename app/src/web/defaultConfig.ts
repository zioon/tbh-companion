// Web build: default `AppConfig` for the browser.
//
// Reuses the shared notification defaults so the two targets cannot drift, and
// mirrors the desktop defaults in `src/main/config.ts` for the remaining fields
// the renderer reads during mount (language resolution, inventory table prefs).
//
// Desktop-only fields (save path, ES3 password, live memory, Steam cookies) are
// present so the object satisfies `AppConfig`, but are never used: the web shim's
// `getConfig`/`saveConfig` own this object and there is no config.json to read.

import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";
import type { AppConfig } from "../../shared/types";

export const WEB_DEFAULT_CONFIG: AppConfig = {
  savePath: "",
  es3Password: "",
  pollIntervalSeconds: 5,
  rollingWindowMinutes: 5,
  topmost: { main: false, overlay: false, boxTracker: false },
  logHistoryCsv: false,
  currency: "USD",
  notificationsEnabled: false,
  notifyOnUpdateAvailable: false,
  notificationVolume: 0,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
  inventoryAlmostFullThresholdPercent: 90,
  chestAutoOpenEnabled: { common: false, stageBoss: false },
  marketAutoScanEnabled: false,
  lootAutoClassifyEnabled: false,
  lootRingSeconds: { common: 300, stage: 420, plagueCommon: 300, plagueRare: 300, plagueAct: 420 },
  liveMemory: { enabled: false, consentAccepted: false },
  lookupPricePolling: { enabled: false, intervalMinutes: 10, thresholdUsd: 1, watchedHashes: [] },
  marketLowValueThresholdUsd: 0.05,
  language: "auto",
  gameInstallDir: "",
  marketHistoryBatchSize: 10,
  marketHistoryBatchDelaySec: 120,
  marketHistoryCoverageThreshold: 0.95,
  wishCoinOverrides: [],
};
