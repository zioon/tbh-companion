import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CatalogRefreshService,
  parseLocaleBundleFilename,
  resolveGameInstallDir,
} from "../../src/main/catalogRefreshService";
import type { GameDataProvider } from "../../src/main/gameDataProvider";
import type { LiveMemoryService } from "../../src/main/services/LiveMemoryService";

function makeMocks() {
  const gameData: Pick<GameDataProvider, "load" | "reload" | "getVersion" | "itemCount"> = {
    load: vi.fn(),
    reload: vi.fn(),
    getVersion: vi.fn().mockReturnValue("1.00.28"),
    itemCount: vi.fn().mockReturnValue(6030),
  };
  const liveMemory: Pick<LiveMemoryService, "getStatus"> = {
    getStatus: vi.fn().mockReturnValue({
      gameVersion: "1.00.28",
      supported: true,
      running: true,
      attached: true,
      pid: 1234,
      note: null,
    }),
  };
  return { gameData, liveMemory };
}

describe("CatalogRefreshService", () => {
  it("returns current status as not stale when versions match", () => {
    const { gameData, liveMemory } = makeMocks();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    const status = svc.getStatus();
    expect(status.stale).toBe(false);
    expect(status.catalogVersion).toBe("1.00.28");
    expect(status.gameVersion).toBe("1.00.28");
    expect(status.source).toBe("bundled");
    expect(status.itemCount).toBe(6030);
    expect(status.lastRefreshMs).toBeNull();
    expect(status.lastError).toBeNull();
  });

  it("marks stale when game version differs from catalog", () => {
    const { gameData, liveMemory } = makeMocks();
    (liveMemory.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      gameVersion: "1.00.29",
      supported: true,
      running: true,
      attached: true,
      pid: 1234,
      note: null,
    });
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(svc.getStatus().stale).toBe(true);
  });

  it("marks not stale when gameVersion is null (live reader not attached)", () => {
    const { gameData, liveMemory } = makeMocks();
    (liveMemory.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      gameVersion: null,
      supported: false,
      running: false,
      attached: false,
      pid: null,
      note: null,
    });
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(svc.getStatus().stale).toBe(false);
    expect(svc.getStatus().gameVersion).toBeNull();
  });

  it("marks not stale when catalogVersion is null (catalog not loaded)", () => {
    const { gameData, liveMemory } = makeMocks();
    (gameData.getVersion as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(svc.getStatus().stale).toBe(false);
    expect(svc.getStatus().catalogVersion).toBeNull();
  });

  it("broadcasts status via broadcast callback when provided", () => {
    const { gameData, liveMemory } = makeMocks();
    const broadcast = vi.fn();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
      broadcast,
    );
    svc.onGameVersionChanged();
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload] = broadcast.mock.calls[0];
    expect(channel).toBe("catalog-status");
    expect(payload).toHaveProperty("catalogVersion", "1.00.28");
    expect(payload).toHaveProperty("stale", false);
  });

  it("does not throw when broadcast is not provided", () => {
    const { gameData, liveMemory } = makeMocks();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(() => svc.onGameVersionChanged()).not.toThrow();
  });

  it("getLocaleData returns bundled fallback before any refresh", () => {
    const { gameData, liveMemory } = makeMocks();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    // Before any refresh, cachedLocale is null but the bundled
    // _game_locale_dump.json provides a fallback so the renderer can show
    // localized names immediately on startup. `version` is null because no
    // gameVersion has been captured yet (that comes from refresh()).
    const data = svc.getLocaleData();
    expect(data).not.toBeNull();
    expect(data?.version).toBeNull();
    expect(data?.locales).toBeTruthy();
    // At least one language should be present in the bundled dump.
    expect(Object.keys(data?.locales ?? {}).length).toBeGreaterThan(0);
  });

  describe("resolveGameInstallDir priority", () => {
    const ENV_KEY = "TBH_GAME_INSTALL_DATA_DIR";
    let prevEnv: string | undefined;
    // The default Steam path constant in catalogRefreshService. Only present
    // on dev machines with the game actually installed there — tests can't
    // rely on existsSync returning true, so they cover config/env/null paths
    // and treat the default branch as "best effort".
    const DEFAULT_GAME_INSTALL =
      "D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data";

    beforeEach(() => {
      prevEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });
    afterEach(() => {
      if (prevEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prevEnv;
    });

    it("config path wins over env and default", () => {
      process.env[ENV_KEY] = "C:\\from-env";
      const result = resolveGameInstallDir("C:\\from-config");
      expect(result).toBe("C:\\from-config");
    });

    it("env var wins over default when config is empty", () => {
      process.env[ENV_KEY] = "C:\\from-env";
      const result = resolveGameInstallDir("");
      expect(result).toBe("C:\\from-env");
    });

    it("env var wins over default when config is undefined", () => {
      process.env[ENV_KEY] = "C:\\from-env";
      const result = resolveGameInstallDir(undefined);
      expect(result).toBe("C:\\from-env");
    });

    it("returns null when config and env are both empty and default path does not exist", () => {
      // The default path almost certainly doesn't exist on CI / dev machines
      // without the game installed at D:\SteamLibrary — so this branch is the
      // expected "no install found" return. If the test happens to run on a
      // machine where DEFAULT_GAME_INSTALL exists, fall back to asserting that
      // the result is either null or the default path.
      const result = resolveGameInstallDir("");
      expect([null, DEFAULT_GAME_INSTALL]).toContain(result);
    });

    it("trims whitespace from config path before checking", () => {
      const result = resolveGameInstallDir("  C:\\padded  ");
      expect(result).toBe("C:\\padded");
    });

    it("treats whitespace-only config as empty (falls through to env/default)", () => {
      process.env[ENV_KEY] = "C:\\from-env";
      const result = resolveGameInstallDir("   ");
      expect(result).toBe("C:\\from-env");
    });
  });
});

describe("parseLocaleBundleFilename", () => {
  it("returns null for non-localization-string-tables files", () => {
    expect(parseLocaleBundleFilename("localization-assets-shared_assets_all.bundle")).toBeNull();
    expect(parseLocaleBundleFilename("localization-locales_assets_all.bundle")).toBeNull();
    expect(parseLocaleBundleFilename("sharedassets0.assets")).toBeNull();
    expect(parseLocaleBundleFilename("gamedata.json")).toBeNull();
  });

  it("parses the 4 original locale bundles", () => {
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
      ),
    ).toBe("en");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle",
      ),
    ).toBe("zh-CN");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-japanese(japan)(ja-jp)_assets_all.bundle",
      ),
    ).toBe("ja");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-korean(southkorea)(ko-kr)_assets_all.bundle",
      ),
    ).toBe("ko");
  });

  it("parses the 12 new locale bundles (BCP-47 normalization)", () => {
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-german(germany)(de-de)_assets_all.bundle",
      ),
    ).toBe("de-DE");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-spanish(spain)(es-es)_assets_all.bundle",
      ),
    ).toBe("es-ES");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-french(france)(fr-fr)_assets_all.bundle",
      ),
    ).toBe("fr-FR");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-polish(poland)(pl-pl)_assets_all.bundle",
      ),
    ).toBe("pl-PL");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-portuguese(brazil)(pt-br)_assets_all.bundle",
      ),
    ).toBe("pt-BR");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-russian(russia)(ru-ru)_assets_all.bundle",
      ),
    ).toBe("ru-RU");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-turkish(turkey)(tr-tr)_assets_all.bundle",
      ),
    ).toBe("tr-TR");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-ukrainian(ukraine)(uk-ua)_assets_all.bundle",
      ),
    ).toBe("uk-UA");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-chinese(traditional)(zh-hant)_assets_all.bundle",
      ),
    ).toBe("zh-Hant");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-thai(thailand)(th-th)_assets_all.bundle",
      ),
    ).toBe("th-TH");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-vietnamese(vietnam)(vi-vn)_assets_all.bundle",
      ),
    ).toBe("vi-VN");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-indonesian(indonesia)(id-id)_assets_all.bundle",
      ),
    ).toBe("id-ID");
  });

  it("handles hash suffix before .bundle (Unity Addressables)", () => {
    // vi-VN bundle in the wild has a hash suffix on _assets_all.
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-vietnamese(vietnam)(vi-vn)_assets_all_abc123def.bundle",
      ),
    ).toBe("vi-VN");
    expect(
      parseLocaleBundleFilename(
        "localization-string-tables-french(france)(fr-fr)_assets_all_3714c8.bundle",
      ),
    ).toBe("fr-FR");
  });

  it("returns null for a string-tables file with no BCP-47 code in parens", () => {
    // The shared bundle has no parenthetical code — should be skipped.
    expect(
      parseLocaleBundleFilename("localization-string-tables-shared_assets_all.bundle"),
    ).toBeNull();
  });
});
