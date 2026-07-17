import { describe, it, expect, vi } from "vitest";
import { CatalogRefreshService } from "../../src/main/catalogRefreshService";
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
});
