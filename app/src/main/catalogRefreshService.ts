// Orchestrates catalog refresh: locate game install → read 3 asset files →
// extract catalog via core/unityAssets → write userData/gamedata.json →
// reload GameDataProvider. Also reads all 4 locale bundles, extracts locale
// data, and writes userData/locale.json for the renderer to consume.
// Reports status via getStatus() and broadcasts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractCatalog } from "../core/unityAssets/catalogExtractor";
import { extractLocales } from "../core/unityAssets/localeExtractor";
import type { GameDataProvider } from "./gameDataProvider";
import type { LiveMemoryService } from "./services/LiveMemoryService";
import { IPC } from "../../shared/ipc";
import type { CatalogRefreshResult, CatalogStatus } from "../../shared/types";
import type { GameLocaleData } from "../../shared/types";
import { createLogger } from "./log";
import { resolveUserDataDir } from "./services/appData";

type BroadcastFn = (channel: string, payload: unknown) => void;

const log = createLogger("catalogRefresh");

const GAMEDATA_FILE = "gamedata.json";
const LOCALE_FILE = "locale.json";

// Default install path (Steam). Overridable by env for non-standard installs.
const DEFAULT_GAME_INSTALL = "D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data";
const GAME_INSTALL_ENV = "TBH_GAME_INSTALL_DATA_DIR";

function resolveGameInstallDir(): string | null {
  const fromEnv = process.env[GAME_INSTALL_ENV];
  if (fromEnv) return fromEnv;
  if (existsSync(DEFAULT_GAME_INSTALL)) return DEFAULT_GAME_INSTALL;
  return null;
}

interface AssetPaths {
  sharedassets0: string;
  sharedBundle: string;
  enBundle: string;
  zhCNBundle: string;
  jaBundle: string;
  koBundle: string;
}

function resolveAssetPaths(installDir: string): AssetPaths {
  const aa = join(installDir, "StreamingAssets", "aa", "StandaloneWindows64");
  return {
    sharedassets0: join(installDir, "sharedassets0.assets"),
    sharedBundle: join(aa, "localization-assets-shared_assets_all.bundle"),
    enBundle: join(aa, "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"),
    zhCNBundle: join(
      aa,
      "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle",
    ),
    jaBundle: join(aa, "localization-string-tables-japanese(japan)(ja-jp)_assets_all.bundle"),
    koBundle: join(aa, "localization-string-tables-korean(southkorea)(ko-kr)_assets_all.bundle"),
  };
}

export class CatalogRefreshService {
  private lastRefreshMs: number | null = null;
  private lastError: string | null = null;
  /** Cached locale data — written by refresh(), read by getLocaleData(). */
  private cachedLocale: GameLocaleData | null = null;

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

  /** Return the cached locale data (null if not yet refreshed). */
  getLocaleData(): GameLocaleData | null {
    return this.cachedLocale;
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
      // Only the three core assets are required for catalog refresh.
      const coreKeys: (keyof AssetPaths)[] = ["sharedassets0", "sharedBundle", "enBundle"];
      for (const key of coreKeys) {
        if (!existsSync(paths[key])) {
          throw new Error(`required asset file missing: ${key} (${paths[key]})`);
        }
      }
      log.info(`refreshing catalog from ${installDir}`);
      const sharedassets0 = readFileSync(paths.sharedassets0);
      const sharedBundle = readFileSync(paths.sharedBundle);
      const enBundle = readFileSync(paths.enBundle);

      const extracted = extractCatalog({ sharedassets0, sharedBundle, enBundle });
      const gameVersion = this.liveMemory.getStatus()?.gameVersion ?? extracted.gameVersion;

      // Write gamedata.json.
      mkdirSync(this.userDataDir, { recursive: true });
      const gamedataPath = join(this.userDataDir, GAMEDATA_FILE);
      writeFileSync(gamedataPath, JSON.stringify({ gameVersion, items: extracted.items }), "utf-8");
      log.info(
        `wrote ${gamedataPath}: ${extracted.items.length} items (resolved ${extracted.stats.resolvedNames} names)`,
      );

      // Reload GameDataProvider.
      this.gameData.reload(this.userDataDir);

      // --- Locale extraction (best-effort: non-fatal) ---
      const localeKeys: (keyof AssetPaths)[] = ["zhCNBundle", "jaBundle", "koBundle"];
      for (const key of localeKeys) {
        if (!existsSync(paths[key])) {
          log.warn(`locale bundle missing (${key}), skipping locale extraction`);
        }
      }
      const localeInput = {
        sharedBundle,
        enBundle,
        zhCNBundle: existsSync(paths.zhCNBundle) ? readFileSync(paths.zhCNBundle) : Buffer.alloc(0),
        jaBundle: existsSync(paths.jaBundle) ? readFileSync(paths.jaBundle) : Buffer.alloc(0),
        koBundle: existsSync(paths.koBundle) ? readFileSync(paths.koBundle) : Buffer.alloc(0),
      };
      const localeData = extractLocales(localeInput);
      if (localeData) {
        // Include gameVersion so the renderer can detect staleness.
        const localePayload: GameLocaleData = {
          version: gameVersion,
          en: localeData.en,
          "zh-CN": localeData["zh-CN"],
          ja: localeData.ja,
          ko: localeData.ko,
        };
        const localePath = join(this.userDataDir, LOCALE_FILE);
        writeFileSync(localePath, JSON.stringify(localePayload), "utf-8");
        this.cachedLocale = localePayload;
        log.info(`wrote ${localePath}: ${Object.keys(localeData.en).length} keys`);
      } else {
        log.warn("locale extraction returned no data (game bundles may be unavailable)");
      }

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
