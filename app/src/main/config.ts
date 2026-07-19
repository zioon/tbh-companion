// Loads companion settings, reusing the existing config.json shape.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import {
  DEFAULT_NOTIFICATION_PREFS,
  migrateNotificationPrefs,
  sanitizeInventoryAlmostFullThresholdPercent,
  sanitizeNotificationVolume,
  type LegacyChestSoundVariant,
} from "../../shared/notificationCatalog";
import { APP_LANGUAGES, DEFAULT_LANGUAGE, type AppLanguage } from "../../shared/language";
import type {
  AppConfig,
  ChestAutoOpenPrefs,
  LiveMemoryPrefs,
  LootRingSeconds,
  NotificationPrefs,
} from "../../shared/types";
import { DEFAULT_PASSWORD } from "../core/es3";

export type { AppConfig };

const DEFAULT_SAVE = join(
  "%USERPROFILE%",
  "AppData",
  "LocalLow",
  "TesseractStudio",
  "TaskbarHero",
  "SaveFile_Live.es3",
);

const DEFAULT_CHEST_AUTO_OPEN: ChestAutoOpenPrefs = {
  common: false,
  stageBoss: false,
};

const DEFAULT_LIVE_MEMORY: LiveMemoryPrefs = {
  enabled: false,
  consentAccepted: false,
};

// Lap duration defaults: Common chest = 5 min, Stage-boss chest = 7 min
// (matches the mini overlay's boss-chest ring lap duration).
const DEFAULT_LOOT_RING_SECONDS: LootRingSeconds = {
  common: 5 * 60,
  stage: 7 * 60,
};

const DEFAULTS: AppConfig = {
  savePath: DEFAULT_SAVE,
  es3Password: DEFAULT_PASSWORD,
  pollIntervalSeconds: 5,
  rollingWindowMinutes: 5,
  startTopmost: true,
  logHistoryCsv: true,
  currency: "USD",
  notificationsEnabled: true,
  notifyOnUpdateAvailable: true,
  notificationVolume: 100,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
  inventoryAlmostFullThresholdPercent: 90,
  chestAutoOpenEnabled: DEFAULT_CHEST_AUTO_OPEN,
  liveMemory: DEFAULT_LIVE_MEMORY,
  // On by default so the inventory stays priced without user action — the
  // pre-toggle behavior. Disabling stops auto refreshes on save parses,
  // leaving only explicit Refresh / Force / per-item user actions.
  marketAutoScanEnabled: true,
  // Skip items at or below 5¢ USD on auto-refresh — they sit at Steam's
  // $0.03 listing floor and waste rate-limit budget. Set to 0 to disable.
  marketLowValueThresholdUsd: 0.05,
  lootAutoClassifyEnabled: false,
  lootRingSeconds: DEFAULT_LOOT_RING_SECONDS,
  language: DEFAULT_LANGUAGE,
};

type RawConfig = Partial<AppConfig> & { chestSoundVariant?: LegacyChestSoundVariant };

function sanitizeChestAutoOpenPrefs(
  raw: Partial<ChestAutoOpenPrefs> | undefined,
): ChestAutoOpenPrefs {
  return {
    common: Boolean(raw?.common),
    stageBoss: Boolean(raw?.stageBoss),
  };
}

function sanitizeLiveMemoryPrefs(raw: Partial<LiveMemoryPrefs> | undefined): LiveMemoryPrefs {
  return {
    enabled: Boolean(raw?.enabled),
    consentAccepted: Boolean(raw?.consentAccepted),
  };
}

/**
 * Sanitize loot-ring lap durations: clamp each to a sane range (1s – 1h)
 * so a malformed config can't produce a non-functional ring (0s would divide
 * by zero, a huge value would never visibly progress). Falls back to the
 * matching default when missing or invalid.
 */
function sanitizeLootRingSeconds(raw: Partial<LootRingSeconds> | undefined): LootRingSeconds {
  const clamp = (v: unknown, fallback: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.round(n), 1), 3600);
  };
  return {
    common: clamp(raw?.common, DEFAULT_LOOT_RING_SECONDS.common),
    stage: clamp(raw?.stage, DEFAULT_LOOT_RING_SECONDS.stage),
  };
}

/**
 * Coerce the low-value skip threshold (USD) to a finite, non-negative number.
 * Negative or non-numeric values fall back to the default (0.05). Capped at
 * 100 USD so a stray typo can't silently skip every item.
 */
function sanitizeMarketLowValueThresholdUsd(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULTS.marketLowValueThresholdUsd;
  return Math.min(n, 100);
}

/**
 * Coerce the UI language preference to a supported value. Accepts "auto" or
 * any entry in APP_LANGUAGES; anything else falls back to the default ("auto").
 */
function sanitizeLanguage(raw: unknown): AppLanguage {
  if (raw === "auto") return "auto";
  if (typeof raw === "string" && (APP_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as AppLanguage;
  }
  return DEFAULT_LANGUAGE;
}

function normalizeConfig(raw: RawConfig): AppConfig {
  const {
    chestSoundVariant: _legacy,
    notificationPrefs: _prefs,
    notificationVolume: _volume,
    inventoryAlmostFullThresholdPercent: _threshold,
    chestAutoOpenEnabled: _autoOpen,
    liveMemory: _liveMemory,
    marketAutoScanEnabled: _marketAutoScan,
    marketLowValueThresholdUsd: _marketLowValue,
    lootAutoClassifyEnabled: _ac,
    lootRingSeconds: _ring,
    language: _language,
    ...rest
  } = raw;
  const notificationPrefs: NotificationPrefs = migrateNotificationPrefs(raw);
  const notificationVolume = sanitizeNotificationVolume(raw.notificationVolume);
  const inventoryAlmostFullThresholdPercent = sanitizeInventoryAlmostFullThresholdPercent(
    raw.inventoryAlmostFullThresholdPercent,
  );
  const chestAutoOpenEnabled = sanitizeChestAutoOpenPrefs(raw.chestAutoOpenEnabled);
  const liveMemory = sanitizeLiveMemoryPrefs(raw.liveMemory);
  const marketAutoScanEnabled = raw.marketAutoScanEnabled !== false;
  const marketLowValueThresholdUsd = sanitizeMarketLowValueThresholdUsd(
    raw.marketLowValueThresholdUsd,
  );
  const lootAutoClassifyEnabled = raw.lootAutoClassifyEnabled === true;
  const lootRingSeconds = sanitizeLootRingSeconds(raw.lootRingSeconds);
  const language = sanitizeLanguage(raw.language);
  return {
    ...DEFAULTS,
    ...rest,
    notificationPrefs,
    notificationVolume,
    inventoryAlmostFullThresholdPercent,
    chestAutoOpenEnabled,
    liveMemory,
    marketAutoScanEnabled,
    marketLowValueThresholdUsd,
    lootAutoClassifyEnabled,
    lootRingSeconds,
    language,
  };
}

/** Normalizes raw config JSON (migration + validation). Exported for tests. */
export function normalizeConfigFromRaw(raw: RawConfig): AppConfig {
  return normalizeConfig(raw);
}

// Expand %VAR% (Windows) and ~ in a path.
export function expandPath(p: string): string {
  let out = p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? `%${name}%`);
  if (out.startsWith("~")) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    out = join(home, out.slice(1));
  }
  return out;
}

// Search order: packaged userData, then dev locations (cwd, repo root).
function candidatePaths(): string[] {
  const paths: string[] = [];
  try {
    paths.push(join(app.getPath("userData"), "config.json"));
  } catch {
    // app not ready / non-electron context
  }
  paths.push(join(process.cwd(), "config.json"));
  paths.push(join(process.cwd(), "..", "config.json"));
  return paths;
}

export function loadConfig(): AppConfig {
  for (const p of candidatePaths()) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as RawConfig;
      return normalizeConfig(raw);
    } catch {
      // fall through to defaults on malformed config
    }
  }
  return normalizeConfig({});
}

// Persist the live config to the user-writable location (userData/config.json),
// merging over whatever is on disk. Used by runtime settings like currency.
export function saveConfig(config: AppConfig): void {
  let target: string;
  try {
    target = join(app.getPath("userData"), "config.json");
  } catch {
    target = join(process.cwd(), "config.json");
  }
  let existing: Partial<AppConfig> = {};
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, "utf-8")) as Partial<AppConfig>;
    } catch {
      existing = {};
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  const toSave = normalizeConfig({ ...existing, ...config });
  writeFileSync(target, JSON.stringify(toSave, null, 2));
}
