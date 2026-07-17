// Orchestrates catalog refresh: locate game install → read 3 asset files →
// extract catalog via core/unityAssets → write userData/gamedata.json →
// reload GameDataProvider. Reports status via getStatus() and broadcasts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractCatalog } from "../core/unityAssets/catalogExtractor";
import type { GameDataProvider } from "./gameDataProvider";
import type { LiveMemoryService } from "./services/LiveMemoryService";
import { IPC } from "../../shared/ipc";
import type { CatalogRefreshResult, CatalogStatus } from "../../shared/types";
import { createLogger } from "./log";
import { resolveUserDataDir } from "./services/appData";

type BroadcastFn = (channel: string, payload: unknown) => void;

const log = createLogger("catalogRefresh");

const GAMEDATA_FILE = "gamedata.json";

// Default install path (Steam). Overridable by env for non-standard installs.
const DEFAULT_GAME_INSTALL = "D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data";
const GAME_INSTALL_ENV = "TBH_GAME_INSTALL_DATA_DIR";

function resolveGameInstallDir(): string | null {
  const fromEnv = process.env[GAME_INSTALL_ENV];
  if (fromEnv) return fromEnv;
  if (existsSync(DEFAULT_GAME_INSTALL)) return DEFAULT_GAME_INSTALL;
  return null;
}

function resolveAssetPaths(installDir: string): {
  sharedassets0: string;
  sharedBundle: string;
  enBundle: string;
} {
  const aa = join(installDir, "StreamingAssets", "aa", "StandaloneWindows64");
  return {
    sharedassets0: join(installDir, "sharedassets0.assets"),
    sharedBundle: join(aa, "localization-assets-shared_assets_all.bundle"),
    enBundle: join(aa, "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"),
  };
}

export class CatalogRefreshService {
  private lastRefreshMs: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly gameData: GameDataProvider,
    private readonly liveMemory: LiveMemoryService,
    private readonly userDataDir: string = resolveUserDataDir(),
    private readonly broadcast?: BroadcastFn,
  ) {}

  /** Current status snapshot. Call after any refresh attempt or version change. */
  getStatus(): CatalogStatus {
    const catalogVersion = this.gameData.getVersion();
    const gameVersion = this.liveMemory.getStatus()?.gameVersion ?? null;
    const stale = catalogVersion !== null && gameVersion !== null && catalogVersion !== gameVersion;
    return {
      catalogVersion,
      gameVersion,
      stale,
      source: this.lastRefreshMs !== null ? "userData" : "bundled",
      itemCount: this.gameData.itemCount(),
      lastRefreshMs: this.lastRefreshMs,
      lastError: this.lastError,
    };
  }

  /** Trigger a refresh. Returns the result; also broadcasts status. */
  async refresh(): Promise<CatalogRefreshResult> {
    try {
      const installDir = resolveGameInstallDir();
      if (!installDir) {
        throw new Error(
          `game install dir not found (set ${GAME_INSTALL_ENV} or install at ${DEFAULT_GAME_INSTALL})`,
        );
      }
      const paths = resolveAssetPaths(installDir);
      for (const [key, path] of Object.entries(paths)) {
        if (!existsSync(path)) {
          throw new Error(`required asset file missing: ${key} (${path})`);
        }
      }
      log.info(`refreshing catalog from ${installDir}`);
      const sharedassets0 = readFileSync(paths.sharedassets0);
      const sharedBundle = readFileSync(paths.sharedBundle);
      const enBundle = readFileSync(paths.enBundle);

      const extracted = extractCatalog({ sharedassets0, sharedBundle, enBundle });
      const gameVersion = this.liveMemory.getStatus()?.gameVersion ?? extracted.gameVersion;

      // Write to userData.
      mkdirSync(this.userDataDir, { recursive: true });
      const outPath = join(this.userDataDir, GAMEDATA_FILE);
      const payload = {
        gameVersion,
        items: extracted.items,
      };
      writeFileSync(outPath, JSON.stringify(payload), "utf-8");
      log.info(
        `wrote ${outPath}: ${extracted.items.length} items (resolved ${extracted.stats.resolvedNames} names)`,
      );

      // Reload GameDataProvider.
      this.gameData.reload(this.userDataDir);

      this.lastRefreshMs = Date.now();
      this.lastError = null;

      const result: CatalogRefreshResult = {
        ok: true,
        gameVersion,
        itemCount: extracted.items.length,
        resolvedNames: extracted.stats.resolvedNames,
      };
      this.broadcastStatus();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`refresh failed: ${msg}`);
      this.lastError = msg;
      this.broadcastStatus();
      return { ok: false, gameVersion: null, itemCount: 0, resolvedNames: 0, error: msg };
    }
  }

  /** Called by LiveMemoryService when gameVersion changes — broadcast status so
   * the renderer can show the stale banner. Does NOT auto-refresh. */
  onGameVersionChanged(): void {
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    if (this.broadcast) {
      this.broadcast(IPC.CATALOG_STATUS, this.getStatus());
    }
  }
}
