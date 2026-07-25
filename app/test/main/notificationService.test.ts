import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";
import { IPC } from "../../shared/ipc";

const notificationCtor = vi.hoisted(() =>
  vi.fn(function MockNotification(this: { show: () => void; on: () => void }) {
    this.show = vi.fn();
    this.on = vi.fn();
  }),
);

const sendNotificationSoundMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  Notification: Object.assign(notificationCtor, { isSupported: vi.fn(() => true) }),
}));

vi.mock("../../src/main/services/broadcast", () => ({
  sendNotificationSound: sendNotificationSoundMock,
}));

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { Notification } from "electron";
import { NotificationService } from "../../src/main/services/NotificationService";
import type { AppConfig } from "../../shared/types";

const baseConfig: AppConfig = {
  savePath: "",
  es3Password: "",
  pollIntervalSeconds: 5,
  rollingWindowMinutes: 5,
  topmost: { main: true, overlay: true, boxTracker: true },
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
  lookupPricePolling: { enabled: false, intervalMinutes: 10, thresholdUsd: 1.0, watchedHashes: [] },
  language: "auto",
};

/**
 * Minimal English-only t() mock that mirrors the on-disk en/notifications.json
 * strings so existing assertions stay valid. The renderer's i18n instance is
 * exercised separately in test/main/i18n.test.ts.
 */
function tMock(key: string, opts?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    "notifications:updateAvailableTitle": "Update available",
    "notifications:updateAvailableBody":
      "TBH Companion v{{version}} is available. Open About to download.",
    "notifications:inventoryAlmostFullTitle": "Inventory almost full",
    "notifications:inventoryAlmostFullBody": "{{used}}/{{capacity}} slots used ({{percent}}%).",
  };
  let s = map[key] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      s = s.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return s;
}

function makeService(getConfig: () => AppConfig): NotificationService {
  return new NotificationService(getConfig, vi.fn(), tMock);
}

describe("NotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Notification.isSupported).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips update notification when master toggle is off", () => {
    const service = makeService(() => ({ ...baseConfig, notificationsEnabled: false }));
    service.showUpdateAvailable("2.0.0");
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("skips update notification when update toggle is off", () => {
    const service = makeService(() => ({ ...baseConfig, notifyOnUpdateAvailable: false }));
    service.showUpdateAvailable("2.0.0");
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("dedupes update notifications per version", () => {
    const service = makeService(() => baseConfig);
    service.showUpdateAvailable("2.0.0");
    service.showUpdateAvailable("2.0.0");
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("plays chest ready sound via renderer IPC", () => {
    const service = makeService(() => baseConfig);
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).toHaveBeenCalledWith({
      soundId: "soft-chime",
      volumePercent: 100,
    });
  });

  it("plays chest drop sound for chestDrop kind", () => {
    const service = makeService(() => baseConfig);
    service.showChestDrop({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).toHaveBeenCalledWith({
      soundId: "treasure-fanfare",
      volumePercent: 100,
    });
  });

  it("plays hero level up sound for heroLevelUp kind", () => {
    const service = makeService(() => baseConfig);
    service.showHeroLevelUp([{ key: "101", previousLevel: 5, newLevel: 6 }]);
    expect(sendNotificationSoundMock).toHaveBeenCalledWith({
      soundId: "level-triumph",
      volumePercent: 100,
    });
  });

  it("plays inventory almost full sound for inventoryAlmostFull kind", () => {
    const service = makeService(() => baseConfig);
    service.showInventoryAlmostFull({ used: 90, capacity: 100 });
    expect(notificationCtor).toHaveBeenCalledWith({
      title: "Inventory almost full",
      body: "90/100 slots used (90%).",
    });
    expect(sendNotificationSoundMock).toHaveBeenCalledWith({
      soundId: "happy-ping",
      volumePercent: 100,
    });
  });

  it("plays hero level up sound once for a batch of level-ups", () => {
    const service = makeService(() => baseConfig);
    service.showHeroLevelUp([
      { key: "101", previousLevel: 5, newLevel: 6 },
      { key: "201", previousLevel: 2, newLevel: 3 },
    ]);
    expect(sendNotificationSoundMock).toHaveBeenCalledTimes(1);
  });

  it("skips hero level up sound for an empty batch", () => {
    const service = makeService(() => baseConfig);
    service.showHeroLevelUp([]);
    expect(sendNotificationSoundMock).not.toHaveBeenCalled();
  });

  it("skips kind sound when master toggle is off", () => {
    const service = makeService(() => ({ ...baseConfig, notificationsEnabled: false }));
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).not.toHaveBeenCalled();
  });

  it("skips kind sound when kind is disabled", () => {
    const service = makeService(() => ({
      ...baseConfig,
      notificationPrefs: {
        ...baseConfig.notificationPrefs,
        chestReady: { enabled: false, sound: "soft-chime" },
      },
    }));
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).not.toHaveBeenCalled();
  });

  it("skips sound when kind sound is none", () => {
    const service = makeService(() => ({
      ...baseConfig,
      notificationPrefs: {
        ...baseConfig.notificationPrefs,
        chestReady: { enabled: true, sound: "none" },
      },
    }));
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).not.toHaveBeenCalled();
  });

  it("skips sound when notification volume is zero", () => {
    const service = makeService(() => ({ ...baseConfig, notificationVolume: 0 }));
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).not.toHaveBeenCalled();
  });

  it("passes scaled volume percent when below 100", () => {
    const service = makeService(() => ({ ...baseConfig, notificationVolume: 25 }));
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).toHaveBeenCalledWith({
      soundId: "soft-chime",
      volumePercent: 25,
    });
  });

  it("defaults volume when notificationVolume is missing from config", () => {
    const service = makeService(() => ({
      ...baseConfig,
      notificationVolume: undefined as unknown as number,
    }));
    service.showChestReady({ boxId: 920151, name: "Test box", level: 15 });
    expect(sendNotificationSoundMock).toHaveBeenCalledWith({
      soundId: "soft-chime",
      volumePercent: 100,
    });
  });
});

describe("sendNotificationSound IPC channel", () => {
  it("uses the play-notification-sound push channel", () => {
    expect(IPC.PLAY_NOTIFICATION_SOUND).toBe("play-notification-sound");
  });
});
