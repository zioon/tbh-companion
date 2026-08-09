import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";

// Dynamic import so electron mock is established before the module evaluates.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ConfigModule = typeof import("../../src/main/config");
let mod: ConfigModule;

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/tbh-test-userdata",
  },
}));

beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../src/main/config");
});

describe("normalizeConfigFromRaw", () => {
  it("migrates legacy chestSoundVariant to notificationPrefs", () => {
    const cfg = mod.normalizeConfigFromRaw({ chestSoundVariant: "double-tap" });
    expect(cfg.notificationPrefs.chestReady).toEqual({ enabled: true, sound: "double-tap" });
    expect(cfg.notificationPrefs.chestDrop).toEqual(DEFAULT_NOTIFICATION_PREFS.chestDrop);
  });

  it("sanitizes invalid notification sound ids", () => {
    const cfg = mod.normalizeConfigFromRaw({
      notificationPrefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        heroLevelUp: { enabled: true, sound: "not-valid" as "soft-chime" },
      },
    });
    expect(cfg.notificationPrefs.heroLevelUp.sound).toBe(
      DEFAULT_NOTIFICATION_PREFS.heroLevelUp.sound,
    );
  });

  it("applies defaults for an empty raw config", () => {
    const cfg = mod.normalizeConfigFromRaw({});
    expect(cfg.notificationPrefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(cfg.notificationVolume).toBe(100);
    expect(cfg.savePath).toContain("SaveFile_Live.es3");
  });

  it("sanitizes notification volume", () => {
    expect(mod.normalizeConfigFromRaw({ notificationVolume: 200 }).notificationVolume).toBe(100);
    expect(mod.normalizeConfigFromRaw({ notificationVolume: -1 }).notificationVolume).toBe(0);
    expect(mod.normalizeConfigFromRaw({ notificationVolume: 42.6 }).notificationVolume).toBe(43);
  });

  it("defaults inventoryAlmostFullThresholdPercent to 90", () => {
    expect(mod.normalizeConfigFromRaw({}).inventoryAlmostFullThresholdPercent).toBe(90);
  });

  it("defaults chestAutoOpenEnabled to all false", () => {
    expect(mod.normalizeConfigFromRaw({}).chestAutoOpenEnabled).toEqual({
      common: false,
      stageBoss: false,
    });
  });

  it("sanitizes partial/malformed chestAutoOpenEnabled", () => {
    expect(
      mod.normalizeConfigFromRaw({
        chestAutoOpenEnabled: { common: true } as never,
      }).chestAutoOpenEnabled,
    ).toEqual({ common: true, stageBoss: false });
  });

  it("defaults liveMemory to off (disabled, no consent)", () => {
    expect(mod.normalizeConfigFromRaw({}).liveMemory).toEqual({
      enabled: false,
      consentAccepted: false,
    });
  });

  it("sanitizes partial/malformed liveMemory to booleans", () => {
    expect(
      mod.normalizeConfigFromRaw({
        liveMemory: { enabled: 1, consentAccepted: "yes" } as never,
      }).liveMemory,
    ).toEqual({ enabled: true, consentAccepted: true });
    expect(
      mod.normalizeConfigFromRaw({ liveMemory: { enabled: true } as never }).liveMemory,
    ).toEqual({ enabled: true, consentAccepted: false });
  });

  it("preserves an accepted-consent enabled liveMemory block", () => {
    expect(
      mod.normalizeConfigFromRaw({ liveMemory: { enabled: true, consentAccepted: true } })
        .liveMemory,
    ).toEqual({ enabled: true, consentAccepted: true });
  });

  it("clamps inventoryAlmostFullThresholdPercent to 50-100", () => {
    expect(
      mod.normalizeConfigFromRaw({ inventoryAlmostFullThresholdPercent: 10 })
        .inventoryAlmostFullThresholdPercent,
    ).toBe(50);
    expect(
      mod.normalizeConfigFromRaw({ inventoryAlmostFullThresholdPercent: 150 })
        .inventoryAlmostFullThresholdPercent,
    ).toBe(100);
  });
});

describe("lootAutoClassifyEnabled", () => {
  it("defaults to false", () => {
    expect(mod.normalizeConfigFromRaw({}).lootAutoClassifyEnabled).toBe(false);
  });
  it("preserves explicit true", () => {
    expect(
      mod.normalizeConfigFromRaw({ lootAutoClassifyEnabled: true }).lootAutoClassifyEnabled,
    ).toBe(true);
  });
  it("coerces non-boolean to false", () => {
    expect(
      mod.normalizeConfigFromRaw({ lootAutoClassifyEnabled: "yes" } as never)
        .lootAutoClassifyEnabled,
    ).toBe(false);
    expect(
      mod.normalizeConfigFromRaw({ lootAutoClassifyEnabled: 1 } as never).lootAutoClassifyEnabled,
    ).toBe(false);
    expect(
      mod.normalizeConfigFromRaw({ lootAutoClassifyEnabled: null } as never)
        .lootAutoClassifyEnabled,
    ).toBe(false);
  });
});

describe("marketAutoScanEnabled", () => {
  it("defaults to true (preserves pre-toggle behavior)", () => {
    expect(mod.normalizeConfigFromRaw({}).marketAutoScanEnabled).toBe(true);
  });
  it("preserves explicit false", () => {
    expect(mod.normalizeConfigFromRaw({ marketAutoScanEnabled: false }).marketAutoScanEnabled).toBe(
      false,
    );
  });
  it("coerces non-boolean to true (only explicit false disables)", () => {
    expect(
      mod.normalizeConfigFromRaw({ marketAutoScanEnabled: "no" } as never).marketAutoScanEnabled,
    ).toBe(true);
    expect(
      mod.normalizeConfigFromRaw({ marketAutoScanEnabled: 0 } as never).marketAutoScanEnabled,
    ).toBe(true);
    expect(
      mod.normalizeConfigFromRaw({ marketAutoScanEnabled: null } as never).marketAutoScanEnabled,
    ).toBe(true);
  });
});

describe("marketLowValueThresholdUsd", () => {
  it("defaults to 0.05 USD (skip Steam's $0.03 floor items)", () => {
    expect(mod.normalizeConfigFromRaw({}).marketLowValueThresholdUsd).toBe(0.05);
  });
  it("preserves explicit values", () => {
    expect(
      mod.normalizeConfigFromRaw({ marketLowValueThresholdUsd: 0.1 }).marketLowValueThresholdUsd,
    ).toBe(0.1);
    expect(
      mod.normalizeConfigFromRaw({ marketLowValueThresholdUsd: 0 }).marketLowValueThresholdUsd,
    ).toBe(0);
  });
  it("falls back to default on invalid input", () => {
    expect(
      mod.normalizeConfigFromRaw({ marketLowValueThresholdUsd: -1 } as never)
        .marketLowValueThresholdUsd,
    ).toBe(0.05);
    expect(
      mod.normalizeConfigFromRaw({ marketLowValueThresholdUsd: "high" } as never)
        .marketLowValueThresholdUsd,
    ).toBe(0.05);
    expect(
      mod.normalizeConfigFromRaw({ marketLowValueThresholdUsd: NaN } as never)
        .marketLowValueThresholdUsd,
    ).toBe(0.05);
  });
  it("caps at 100 USD so a typo can't silently skip everything", () => {
    expect(
      mod.normalizeConfigFromRaw({ marketLowValueThresholdUsd: 1000 } as never)
        .marketLowValueThresholdUsd,
    ).toBe(100);
  });
});

describe("config language", () => {
  it("defaults to 'auto' when missing", () => {
    expect(mod.normalizeConfigFromRaw({}).language).toBe("auto");
  });
  it("preserves explicit 'auto'", () => {
    expect(mod.normalizeConfigFromRaw({ language: "auto" }).language).toBe("auto");
  });
  it("preserves supported explicit languages (en, zh-CN, ja, ko)", () => {
    expect(mod.normalizeConfigFromRaw({ language: "en" }).language).toBe("en");
    expect(mod.normalizeConfigFromRaw({ language: "zh-CN" }).language).toBe("zh-CN");
    expect(mod.normalizeConfigFromRaw({ language: "ja" }).language).toBe("ja");
    expect(mod.normalizeConfigFromRaw({ language: "ko" }).language).toBe("ko");
  });
  it("preserves 'game' (follow the game's registry-set language)", () => {
    expect(mod.normalizeConfigFromRaw({ language: "game" }).language).toBe("game");
  });
  it("falls back to 'auto' on unsupported / malformed values", () => {
    expect(mod.normalizeConfigFromRaw({ language: "fr" } as never).language).toBe("auto");
    expect(mod.normalizeConfigFromRaw({ language: "english" } as never).language).toBe("auto");
    expect(mod.normalizeConfigFromRaw({ language: 42 } as never).language).toBe("auto");
    expect(mod.normalizeConfigFromRaw({ language: null } as never).language).toBe("auto");
    expect(mod.normalizeConfigFromRaw({ language: "" } as never).language).toBe("auto");
  });
});

describe("topmost", () => {
  it("defaults to all three windows pinned when neither field is present", () => {
    expect(mod.normalizeConfigFromRaw({}).topmost).toEqual({
      main: true,
      overlay: true,
      boxTracker: true,
    });
  });

  it("migrates legacy `startTopmost: true` to all three windows pinned", () => {
    expect(mod.normalizeConfigFromRaw({ startTopmost: true }).topmost).toEqual({
      main: true,
      overlay: true,
      boxTracker: true,
    });
  });

  it("migrates legacy `startTopmost: false` to all three windows unpinned", () => {
    expect(mod.normalizeConfigFromRaw({ startTopmost: false }).topmost).toEqual({
      main: false,
      overlay: false,
      boxTracker: false,
    });
  });

  it("uses `topmost` per-field, falling back to legacy seed for missing windows", () => {
    // startTopmost=true seeds all three, then topmost.overlay=false overrides
    // only the overlay window. The remaining windows keep the legacy seed.
    expect(
      mod.normalizeConfigFromRaw({
        startTopmost: true,
        topmost: { overlay: false },
      }).topmost,
    ).toEqual({ main: true, overlay: false, boxTracker: true });
  });

  it("uses `topmost` per-field, falling back to defaults when legacy is absent", () => {
    expect(mod.normalizeConfigFromRaw({ topmost: { main: false } }).topmost).toEqual({
      main: false,
      overlay: true,
      boxTracker: true,
    });
  });

  it("coerces non-boolean per-window values to defaults (treats them as missing)", () => {
    expect(
      mod.normalizeConfigFromRaw({
        topmost: { main: "yes", overlay: 1, boxTracker: null } as never,
      }).topmost,
    ).toEqual({ main: true, overlay: true, boxTracker: true });
  });
});

describe("steamCookie", () => {
  it("defaults all fields to empty when missing", () => {
    const c = mod.normalizeConfigFromRaw({});
    expect(c.steamCookie).toBe("");
    expect(c.steamCookieSessionid).toBe("");
    expect(c.steamCookieLoginSecure).toBe("");
  });

  it("composes cookie from the two split fields", () => {
    const c = mod.normalizeConfigFromRaw({
      steamCookieSessionid: " abc123 ",
      steamCookieLoginSecure: " tok%7C%7Cxyz ",
    });
    expect(c.steamCookieSessionid).toBe("abc123");
    expect(c.steamCookieLoginSecure).toBe("tok%7C%7Cxyz");
    expect(c.steamCookie).toBe("sessionid=abc123; steamLoginSecure=tok%7C%7Cxyz");
  });

  it("drops empty split fields when composing", () => {
    expect(mod.normalizeConfigFromRaw({ steamCookieSessionid: "sid1" }).steamCookie).toBe(
      "sessionid=sid1",
    );
    expect(mod.normalizeConfigFromRaw({ steamCookieLoginSecure: "tok" }).steamCookie).toBe(
      "steamLoginSecure=tok",
    );
  });

  it("migrates legacy single-field cookie to the split fields (sessionid key)", () => {
    const c = mod.normalizeConfigFromRaw({
      steamCookie: " Steam_Language=english; sessionid=abc123; steamLoginSecure=%7C%7Ctok ",
    });
    expect(c.steamCookieSessionid).toBe("abc123");
    expect(c.steamCookieLoginSecure).toBe("%7C%7Ctok");
    expect(c.steamCookie).toBe("sessionid=abc123; steamLoginSecure=%7C%7Ctok");
  });

  it("also accepts legacy `id` key aliased to sessionid (back-compat)", () => {
    const c = mod.normalizeConfigFromRaw({
      steamCookie: "id=76561198000000000; steamLoginSecure=%7C%7Ctok",
    });
    expect(c.steamCookieSessionid).toBe("76561198000000000");
    expect(c.steamCookieLoginSecure).toBe("%7C%7Ctok");
    expect(c.steamCookie).toBe("sessionid=76561198000000000; steamLoginSecure=%7C%7Ctok");
  });

  it("keeps split fields when legacy is also present (split wins)", () => {
    const c = mod.normalizeConfigFromRaw({
      steamCookie: "sessionid=legacy; steamLoginSecure=old",
      steamCookieSessionid: "newsid",
      steamCookieLoginSecure: "newtok",
    });
    expect(c.steamCookieSessionid).toBe("newsid");
    expect(c.steamCookieLoginSecure).toBe("newtok");
    expect(c.steamCookie).toBe("sessionid=newsid; steamLoginSecure=newtok");
  });

  it("results in empty cookie when legacy has no sessionid/steamLoginSecure parts", () => {
    const c = mod.normalizeConfigFromRaw({
      steamCookie: "Steam_Language=english; webTradeEligibility=1",
    });
    expect(c.steamCookie).toBe("");
    expect(c.steamCookieSessionid).toBe("");
    expect(c.steamCookieLoginSecure).toBe("");
  });

  it("coerces non-string split fields to empty", () => {
    const c = mod.normalizeConfigFromRaw({
      steamCookieSessionid: 42,
      steamCookieLoginSecure: 7,
    } as never);
    expect(c.steamCookie).toBe("");
    expect(c.steamCookieSessionid).toBe("");
    expect(c.steamCookieLoginSecure).toBe("");
  });
});
