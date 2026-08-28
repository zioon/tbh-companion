// Resolve Steam market item_nameid for itemordershistogram (bundled map + lazy cache).
// Lazy scrape matches tbh-data `build:steam-nameids`: legacy listing HTML with bMarketOptOut.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBundledJson } from "../../core/bundledData";
import { TBH_STEAM_APP_ID } from "../../core/steamPrice";
import { createLogger } from "../log";
import { getProxyDispatcher } from "./proxyResolver";
import { parseRetryAfterMs } from "./retryAfter";

const log = createLogger("market");

/** Legacy market HTML (embeds Market_LoadOrderSpread); beta SPA omits item_nameid. */
const MARKET_OPT_OUT_COOKIE = "bMarketOptOut=1";
const LISTING_NAMEID_RE = /Market_LoadOrderSpread\s*\(\s*(\d+)/;

export type NameIdResolveResult =
  | { ok: true; nameId: number; status: number }
  | { ok: false; status: number; retryAfterMs?: number };

type NameIdMap = Record<string, number>;

function userCachePath(): string {
  try {
    return join(app.getPath("userData"), "steam_item_nameids.json");
  } catch {
    return join(process.cwd(), "steam_item_nameids.json");
  }
}

function loadUserCache(): NameIdMap {
  const path = userCachePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as NameIdMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Cap on the user cache size: bounds memory and keeps every write bounded. */
const MAX_NAMEID_CACHE = 50_000;
/** Coalescing window for cache writes — one disk write per resolve burst. */
const PERSIST_THROTTLE_MS = 500;

let persistTimer: NodeJS.Timeout | null = null;
let pendingPersistMap: NameIdMap | null = null;

/** Best-effort disk write; failures are logged, never thrown to callers. */
function writeUserCache(map: NameIdMap): void {
  try {
    const path = userCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map));
  } catch (err) {
    log.warn(
      `Failed to persist steam_item_nameids cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Coalesce multiple cache writes within PERSIST_THROTTLE_MS into one disk write. */
function persistUserCache(map: NameIdMap): void {
  pendingPersistMap = map;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const toWrite = pendingPersistMap;
    pendingPersistMap = null;
    if (toWrite) writeUserCache(toWrite);
  }, PERSIST_THROTTLE_MS);
}

/** Flush a pending throttled write immediately (used on quit). */
function flushUserCacheWrite(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingPersistMap) {
    const toWrite = pendingPersistMap;
    pendingPersistMap = null;
    writeUserCache(toWrite);
  }
}

// Flush the throttled cache write on quit so a burst resolved right before exit
// isn't lost. Guarded because unit tests may leave electron's `app` unmocked or
// mock it without `on`.
if (typeof app !== "undefined" && typeof app.on === "function") {
  app.on("before-quit", flushUserCacheWrite);
}

export function parseNameIdFromListingHtml(html: string): number | null {
  const match = html.match(LISTING_NAMEID_RE);
  return match ? Number(match[1]) : null;
}

export class SteamItemNameIdService {
  private bundled: NameIdMap = {};
  private userCache: NameIdMap = {};
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.bundled = readBundledJson<NameIdMap>("steam_item_nameids.json");
    } catch {
      this.bundled = {};
    }
    this.userCache = loadUserCache();
  }

  /** Drop the oldest entries (insertion order) once the cache exceeds its cap. */
  private trimUserCache(): void {
    const keys = Object.keys(this.userCache);
    if (keys.length <= MAX_NAMEID_CACHE) return;
    const excess = keys.length - MAX_NAMEID_CACHE;
    for (let i = 0; i < excess; i++) {
      delete this.userCache[keys[i]!];
    }
  }

  getSync(marketHashName: string): number | undefined {
    this.ensureLoaded();
    const fromUser = this.userCache[marketHashName];
    if (fromUser != null) return fromUser;
    const fromBundled = this.bundled[marketHashName];
    if (fromBundled != null) return fromBundled;
    return undefined;
  }

  async resolve(marketHashName: string): Promise<NameIdResolveResult> {
    const cached = this.getSync(marketHashName);
    if (cached != null) return { ok: true, nameId: cached, status: 200 };

    const listingUrl = `https://steamcommunity.com/market/listings/${TBH_STEAM_APP_ID}/${encodeURIComponent(marketHashName)}`;
    try {
      const res = await fetch(listingUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Cookie: MARKET_OPT_OUT_COOKIE,
          Referer: `https://steamcommunity.com/market/search?appid=${TBH_STEAM_APP_ID}`,
        },
        signal: AbortSignal.timeout(30_000),
        ...getProxyDispatcher(),
      });
      if (res.status === 429) {
        return { ok: false, status: 429, retryAfterMs: parseRetryAfterMs(res) };
      }
      if (!res.ok) {
        log.warn(`Nameid scrape HTTP ${res.status} for ${marketHashName}`);
        return { ok: false, status: res.status };
      }
      const nameId = parseNameIdFromListingHtml(await res.text());
      if (nameId == null) {
        log.warn(`Nameid scrape parse miss for ${marketHashName}`);
        return { ok: false, status: res.status };
      }
      this.userCache[marketHashName] = nameId;
      this.trimUserCache();
      persistUserCache(this.userCache);
      log.info(`Resolved item_nameid for ${marketHashName}: ${nameId}`);
      return { ok: true, nameId, status: res.status };
    } catch {
      log.warn(`Nameid scrape failed for ${marketHashName}`);
      return { ok: false, status: 0 };
    }
  }
}

let singleton: SteamItemNameIdService | null = null;

export function getSteamItemNameIdService(): SteamItemNameIdService {
  if (!singleton) singleton = new SteamItemNameIdService();
  return singleton;
}
