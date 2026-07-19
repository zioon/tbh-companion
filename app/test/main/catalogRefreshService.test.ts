import { describe, it, expect, vi } from "vitest";
import { CatalogRefreshService, parseLocaleBundleFilename } from "../../src/main/catalogRefreshService";
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

  it("getLocaleData returns null before any refresh", () => {
    const { gameData, liveMemory } = makeMocks();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(svc.getLocaleData()).toBeNull();
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
