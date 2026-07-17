import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GameDataProvider } from "../../src/main/gameDataProvider";
import * as bundledData from "../../src/core/bundledData";

type ProcessWithResources = NodeJS.Process & { resourcesPath?: string };

describe("GameDataProvider", () => {
  let tempResources = "";
  let previousResourcesPath: string | undefined;

  beforeEach(() => {
    tempResources = mkdtempSync(join(tmpdir(), "tbh-gamedata-"));
    previousResourcesPath = (process as ProcessWithResources).resourcesPath;
    (process as ProcessWithResources).resourcesPath = tempResources;
  });

  afterEach(() => {
    const proc = process as ProcessWithResources;
    if (previousResourcesPath === undefined)
      (proc as { resourcesPath?: string }).resourcesPath = undefined;
    else proc.resourcesPath = previousResourcesPath;
    rmSync(tempResources, { recursive: true, force: true });
  });

  function writeBundledData(gamedata: unknown, stageBoxes?: unknown): void {
    const dataDir = join(tempResources, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "gamedata.json"), JSON.stringify(gamedata));
    writeFileSync(
      join(dataDir, "stage_boxes.json"),
      JSON.stringify(
        stageBoxes ?? {
          items: [
            {
              id: 920501,
              name: "Stage Boss Box Lv50",
              grade: "RARE",
              type: "STAGEBOX",
              level: 50,
              marketTradable: false,
            },
          ],
        },
      ),
    );
  }

  it("loads bundled gamedata and resolves known items", () => {
    writeBundledData({
      source: "test",
      fetchedUtc: "2026-01-01T00:00:00.000Z",
      items: [
        {
          id: 322111,
          name: "Void Staff",
          grade: "RARE",
          type: "GEAR",
          level: 50,
          marketTradable: false,
        },
      ],
    });

    const provider = new GameDataProvider();
    provider.load();
    expect(provider.isLoaded()).toBe(true);
    expect(provider.get(322111)?.name).toBe("Void Staff");
    expect(provider.get(999999)).toBeUndefined();
  });

  it("throws when gamedata cannot be resolved", () => {
    vi.spyOn(bundledData, "resolveBundledDataPath").mockImplementation(() => {
      throw new Error("Bundled data file not found: gamedata.json");
    });
    const provider = new GameDataProvider();
    expect(() => provider.load()).toThrow(/gamedata\.json/);
    vi.restoreAllMocks();
  });

  it("throws when gamedata.json has empty items", () => {
    writeBundledData({ items: [] });
    const provider = new GameDataProvider();
    expect(() => provider.load()).toThrow(/empty items array/);
  });

  it("throws when gamedata.json is invalid JSON", () => {
    const dataDir = join(tempResources, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "gamedata.json"), "{not json");
    writeFileSync(join(dataDir, "stage_boxes.json"), JSON.stringify({ items: [] }));

    const provider = new GameDataProvider();
    expect(() => provider.load()).toThrow(/invalid JSON/);
  });

  it("throws when gamedata.json has no valid item rows", () => {
    writeBundledData({ items: [{ name: "no id" }] });
    const provider = new GameDataProvider();
    expect(() => provider.load()).toThrow(/no valid item rows/);
  });

  it("loads bundled catalog when userData is empty", () => {
    // Point resourcesPath at an empty temp dir so the search falls through
    // to the repo's bundled data/gamedata.json (cwd/../data/gamedata.json).
    const emptyTmp = mkdtempSync(join(tmpdir(), "tbh-gamedata-empty-"));
    try {
      (process as ProcessWithResources).resourcesPath = emptyTmp;
      const provider = new GameDataProvider();
      provider.load(emptyTmp);
      expect(provider.itemCount()).toBeGreaterThan(5000);
      expect(provider.getVersion()).toBe("1.00.28");
    } finally {
      (process as ProcessWithResources).resourcesPath = tempResources;
      rmSync(emptyTmp, { recursive: true, force: true });
    }
  });

  it("prefers userData/gamedata.json when present", () => {
    const userCatalog = {
      gameVersion: "9.9.99",
      items: [
        { id: 1, name: "Test Item", grade: "COMMON", type: "MATERIAL", level: null, marketTradable: false },
      ],
    };
    const userDataDir = mkdtempSync(join(tmpdir(), "tbh-userdata-"));
    try {
      writeFileSync(join(userDataDir, "gamedata.json"), JSON.stringify(userCatalog));
      const provider = new GameDataProvider();
      provider.load(userDataDir);
      expect(provider.getVersion()).toBe("9.9.99");
      expect(provider.get(1)?.name).toBe("Test Item");
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it("reload re-reads from disk", () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "tbh-reload-"));
    try {
      const provider = new GameDataProvider();
      provider.load(userDataDir);

      const newCatalog = {
        gameVersion: "9.9.99",
        items: [
          { id: 1, name: "Reloaded", grade: "COMMON", type: "MATERIAL", level: null, marketTradable: false },
        ],
      };
      writeFileSync(join(userDataDir, "gamedata.json"), JSON.stringify(newCatalog));
      provider.reload(userDataDir);
      expect(provider.getVersion()).toBe("9.9.99");
      expect(provider.get(1)?.name).toBe("Reloaded");
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
