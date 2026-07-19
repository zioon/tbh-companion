// Orchestrates catalog refresh: locate game install → read asset files →
// extract catalog via core/unityAssets → write userData/gamedata.json →
// reload GameDataProvider. Also discovers and reads ALL available locale
// bundles (4 or 16, depending on game version), extracts locale data, and
// writes userData/locale.json for the renderer to consume.
// Reports status via getStatus() and broadcasts.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
const LOCALE_BUNDLE_PREFIX = "localization-string-tables-";
const EN_BUNDLE_FILENAME =
  "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle";

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
  /** Discovered locale bundles keyed by BCP-47 app code (e.g. "zh-CN", "ja", "fr-FR"). Excludes "en". */
  localeBundles: Record<string, string>;
}

/**
 * Map a lowercased BCP-47 code from a bundle filename (e.g. "en-us", "zh-hans")
 * to the app's ResolvedLanguage code (e.g. "en", "zh-CN", "zh-Hant").
 *
 * - en-us → en (app uses bare "en")
 * - ja-jp → ja, ko-kr → ko (bare language code)
 * - zh-hans → zh-CN, zh-hant → zh-Hant
 * - Other codes: title-case the region subtag (de-de → de-DE, pt-br → pt-BR, ...)
 */
function normalizeLocaleCode(raw: string): string | null {
  const lower = raw.toLowerCase();
  const SPECIAL: Record<string, string> = {
    "en-us": "en",
    "ja-jp": "ja",
    "ko-kr": "ko",
    "zh-hans": "zh-CN",
    "zh-hant": "zh-Hant",
  };
  if (SPECIAL[lower]) return SPECIAL[lower];
  const [lang, region] = lower.split("-");
  if (!lang || !region) return null;
  return `${lang}-${region.toUpperCase()}`;
}

/**
 * Parse a locale bundle filename and return the normalized app language code,
 * or null if the filename doesn't match the expected pattern.
 *
 * Expected pattern:
 *   localization-string-tables-<language>(<region>)(<code>)_assets_all.bundle
 *   localization-string-tables-<language>(<region>)(<code>)_assets_all_<hash>.bundle
 *
 * Examples:
 *   localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle → "en"
 *   localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle → "zh-CN"
 *   localization-string-tables-vietnamese(vietnam)(vi-vn)_assets_all_abc123.bundle → "vi-VN"
 */
export function parseLocaleBundleFilename(filename: string): string | null {
  if (!filename.startsWith(LOCALE_BUNDLE_PREFIX)) return null;
  // Find the parenthetical group containing a BCP-47 code (lowercased, hyphenated).
  // The code is the LAST parenthetical group with a hyphen — earlier groups like
  // `(unitedstates)` or `(simplified)` won't match.
  const matches = filename.match(/\(([a-z]{2,3}-[a-z]{2,8})\)/i);
  if (!matches) return null;
  return normalizeLocaleCode(matches[1]);
}

function resolveAssetPaths(installDir: string): AssetPaths {
  const aa = join(installDir, "StreamingAssets", "aa", "StandaloneWindows64");
  const enBundle = join(aa, EN_BUNDLE_FILENAME);
  // Discover all available locale bundles dynamically (handles 4 or 16 languages,
  // plus any future additions, without code changes). The English bundle is
  // excluded from this map because it's already required as `enBundle` for
  // catalog extraction (and re-added to the locale buffer during refresh()).
  const localeBundles: Record<string, string> = {};
  if (existsSync(aa)) {
    for (const file of readdirSync(aa)) {
      if (!file.startsWith(LOCALE_BUNDLE_PREFIX)) continue;
      if (file === EN_BUNDLE_FILENAME) continue;
      const code = parseLocaleBundleFilename(file);
      if (!code) continue;
      localeBundles[code] = join(aa, file);
    }
  }
  return {
    sharedassets0: join(installDir, "sharedassets0.assets"),
    sharedBundle: join(aa, "localization-assets-shared_assets_all.bundle"),
    enBundle,
    localeBundles,
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
      // (localeBundles is discovered dynamically and may be empty/partial.)
      const coreKeys = ["sharedassets0", "sharedBundle", "enBundle"] as const;
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
      // Always include `en` (from the required enBundle) plus every dynamically
      // discovered locale bundle. Missing files yield empty maps, not errors.
      const localeBuffers: Record<string, Buffer> = { en: enBundle };
      const missing: string[] = [];
      for (const [code, file] of Object.entries(paths.localeBundles)) {
        if (!existsSync(file)) {
          missing.push(code);
          continue;
        }
        localeBuffers[code] = readFileSync(file);
      }
      if (missing.length > 0) {
        log.warn(`locale bundles missing for languages: ${missing.join(", ")}`);
      }
      const localeData = extractLocales({ sharedBundle, locales: localeBuffers });
      if (localeData) {
        // Include gameVersion so the renderer can detect staleness.
        const localePayload: GameLocaleData = {
          version: gameVersion,
          locales: localeData,
        };
        const localePath = join(this.userDataDir, LOCALE_FILE);
        writeFileSync(localePath, JSON.stringify(localePayload), "utf-8");
        this.cachedLocale = localePayload;
        const counts = Object.entries(localeData).map(
          ([k, v]) => `${k}=${Object.keys(v).length}`,
        );
        log.info(
          `wrote ${localePath}: ${Object.keys(localeData).length} languages (${counts.join(", ")})`,
        );
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
