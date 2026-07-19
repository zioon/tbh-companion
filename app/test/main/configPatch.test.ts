import { describe, it, expect, vi } from "vitest";
import { applyConfigPatch } from "../../src/main/ipc/configPatch";
import type { AppConfig } from "../../src/main/config";
import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";
import { XpTracker } from "../../src/core/tracker";

function baseConfig(): AppConfig {
  return {
    savePath: "%USERPROFILE%\\save.es3",
    es3Password: "test",
    pollIntervalSeconds: 5,
    rollingWindowMinutes: 5,
    startTopmost: true,
    logHistoryCsv: true,
    currency: "USD",
    notificationsEnabled: true,
    notifyOnUpdateAvailable: true,
    notificationVolume: 100,
    notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
    inventoryAlmostFullThresholdPercent: 90,
    chestAutoOpenEnabled: { common: false, stageBoss: false },
    marketAutoScanEnabled: true,
    marketLowValueThresholdUsd: 0.05,
    lootAutoClassifyEnabled: false,
    lootRingSeconds: { common: 300, stage: 420 },
    liveMemory: { enabled: false, consentAccepted: false },
    language: "auto",
  };
}

describe("applyConfigPatch", () => {
  it("re-fetches prices when currency changes", () => {
    let cfg = baseConfig();
    const ensureOwnedPrices = vi.fn();
    const market = { setCurrency: vi.fn() };

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => market as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices,
      },
      { currency: "BRL" },
    );

    expect(market.setCurrency).toHaveBeenCalledWith("BRL");
    expect(ensureOwnedPrices).toHaveBeenCalledWith(true);
  });

  it("updates CSV logger without recreating tracker when only logHistoryCsv toggles", () => {
    let cfg = baseConfig();
    const tracker = new XpTracker(300);
    tracker.onHistory = () => {};
    const setTracker = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => tracker,
        setTracker,
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
      },
      { logHistoryCsv: false },
    );

    expect(setTracker).not.toHaveBeenCalled();
    expect(tracker.onHistory).toBeNull();
  });

  it("starts the reader when liveMemory is enabled with consent (no restart)", () => {
    let cfg = baseConfig();
    const setLiveMemoryEnabled = vi.fn();
    const onLiveMemoryToggled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setLiveMemoryEnabled,
        onLiveMemoryToggled,
      },
      { liveMemory: { enabled: true, consentAccepted: true } },
    );

    expect(setLiveMemoryEnabled).toHaveBeenCalledWith(true);
    expect(onLiveMemoryToggled).toHaveBeenCalledTimes(1);
  });

  it("stops the reader when liveMemory is disabled", () => {
    let cfg = {
      ...baseConfig(),
      liveMemory: { enabled: true, consentAccepted: true },
    };
    const setLiveMemoryEnabled = vi.fn();
    const onLiveMemoryToggled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setLiveMemoryEnabled,
        onLiveMemoryToggled,
      },
      { liveMemory: { enabled: false, consentAccepted: true } },
    );

    expect(setLiveMemoryEnabled).toHaveBeenCalledWith(false);
    expect(onLiveMemoryToggled).toHaveBeenCalledTimes(1);
  });

  it("does not start the reader when enabled but consent was not accepted", () => {
    let cfg = baseConfig();
    const setLiveMemoryEnabled = vi.fn();
    const onLiveMemoryToggled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setLiveMemoryEnabled,
        onLiveMemoryToggled,
      },
      { liveMemory: { enabled: true, consentAccepted: false } },
    );

    expect(setLiveMemoryEnabled).toHaveBeenCalledWith(false);
    expect(onLiveMemoryToggled).not.toHaveBeenCalled();
  });

  it("leaves the reader untouched when the patch does not include liveMemory", () => {
    let cfg = baseConfig();
    const setLiveMemoryEnabled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setLiveMemoryEnabled,
      },
      { currency: "EUR" },
    );

    expect(setLiveMemoryEnabled).not.toHaveBeenCalled();
  });

  it("fills notificationVolume when patching legacy config missing the field", () => {
    let cfg = baseConfig();

    const next = applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
      },
      { currency: "EUR" },
    );

    expect(next.notificationVolume).toBe(100);
    expect(cfg.notificationVolume).toBe(100);
  });

  it("toggles the market auto-scan flag through to InventoryService", () => {
    let cfg = baseConfig();
    const setMarketAutoScanEnabled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setMarketAutoScanEnabled,
      },
      { marketAutoScanEnabled: false },
    );

    expect(setMarketAutoScanEnabled).toHaveBeenCalledWith(false);
    expect(cfg.marketAutoScanEnabled).toBe(false);
  });

  it("does not call setMarketAutoScanEnabled when the patch omits it", () => {
    let cfg = baseConfig();
    const setMarketAutoScanEnabled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setMarketAutoScanEnabled,
      },
      { currency: "EUR" },
    );

    expect(setMarketAutoScanEnabled).not.toHaveBeenCalled();
  });

  it("does not call setMarketAutoScanEnabled when the value is unchanged", () => {
    let cfg = baseConfig();
    const setMarketAutoScanEnabled = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setMarketAutoScanEnabled,
      },
      { marketAutoScanEnabled: true },
    );

    expect(setMarketAutoScanEnabled).not.toHaveBeenCalled();
  });

  it("updates the low-value threshold through to InventoryService", () => {
    let cfg = baseConfig();
    const setMarketLowValueThresholdUsd = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setMarketLowValueThresholdUsd,
      },
      { marketLowValueThresholdUsd: 0.5 },
    );

    expect(setMarketLowValueThresholdUsd).toHaveBeenCalledWith(0.5);
    expect(cfg.marketLowValueThresholdUsd).toBe(0.5);
  });

  it("does not call setMarketLowValueThresholdUsd when the patch omits it", () => {
    let cfg = baseConfig();
    const setMarketLowValueThresholdUsd = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        setMarketLowValueThresholdUsd,
      },
      { currency: "EUR" },
    );

    expect(setMarketLowValueThresholdUsd).not.toHaveBeenCalled();
  });

  it("calls onLanguageChanged when language changes", () => {
    let cfg = baseConfig();
    const onLanguageChanged = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        onLanguageChanged,
      },
      { language: "zh-CN" },
    );

    expect(onLanguageChanged).toHaveBeenCalledWith("zh-CN");
    expect(cfg.language).toBe("zh-CN");
  });

  it("does not call onLanguageChanged when the patch omits language", () => {
    let cfg = baseConfig();
    const onLanguageChanged = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        onLanguageChanged,
      },
      { currency: "EUR" },
    );

    expect(onLanguageChanged).not.toHaveBeenCalled();
  });

  it("does not call onLanguageChanged when the value is unchanged", () => {
    let cfg = baseConfig();
    cfg.language = "en";
    const onLanguageChanged = vi.fn();

    applyConfigPatch(
      {
        getConfig: () => cfg,
        setConfig: (c) => {
          cfg = c;
        },
        saveConfig: vi.fn(),
        getTracker: () => new XpTracker(300),
        setTracker: vi.fn(),
        getMarket: () => ({ setCurrency: vi.fn() }) as never,
        restartWatcher: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        pushStats: vi.fn(),
        resolveAndPushInventory: vi.fn(),
        ensureOwnedPrices: vi.fn(),
        onLanguageChanged,
      },
      { language: "en" },
    );

    expect(onLanguageChanged).not.toHaveBeenCalled();
  });
});
