/** Shared notification sound catalog and kind definitions (main + renderer). */

export const NOTIFICATION_SOUND_ENTRIES = [
  { id: "soft-chime", labelKey: "sounds.softChime", file: "soft-chime.wav" },
  { id: "double-tap", labelKey: "sounds.doubleTap", file: "double-tap.wav" },
  { id: "wood-tick", labelKey: "sounds.woodTick", file: "wood-tick.wav" },
  { id: "whisper-ping", labelKey: "sounds.whisperPing", file: "whisper-ping.wav" },
  { id: "bright-pop", labelKey: "sounds.brightPop", file: "bright-pop.wav" },
  { id: "clear-bell", labelKey: "sounds.clearBell", file: "clear-bell.wav" },
  { id: "soft-ding", labelKey: "sounds.softDing", file: "soft-ding.wav" },
  { id: "quick-rise", labelKey: "sounds.quickRise", file: "quick-rise.wav" },
  { id: "game-blip", labelKey: "sounds.gameBlip", file: "game-blip.wav" },
  { id: "arcade-tone", labelKey: "sounds.arcadeTone", file: "arcade-tone.wav" },
  { id: "crystal-chime", labelKey: "sounds.crystalChime", file: "crystal-chime.wav" },
  { id: "happy-ping", labelKey: "sounds.happyPing", file: "happy-ping.wav" },
  { id: "magic-spark", labelKey: "sounds.magicSpark", file: "magic-spark.wav" },
  { id: "level-triumph", labelKey: "sounds.levelTriumph", file: "level-triumph.wav" },
  { id: "treasure-fanfare", labelKey: "sounds.treasureFanfare", file: "treasure-fanfare.wav" },
  { id: "gentle-alert", labelKey: "sounds.gentleAlert", file: "gentle-alert.wav" },
] as const;

export type NotificationSoundId = (typeof NOTIFICATION_SOUND_ENTRIES)[number]["id"] | "none";

export const NOTIFICATION_KIND_ENTRIES = [
  {
    id: "chestDrop",
    labelKey: "kinds.chestDrop.label",
    descriptionKey: "kinds.chestDrop.description",
  },
  {
    id: "chestReady",
    labelKey: "kinds.chestReady.label",
    descriptionKey: "kinds.chestReady.description",
  },
  {
    id: "heroLevelUp",
    labelKey: "kinds.heroLevelUp.label",
    descriptionKey: "kinds.heroLevelUp.description",
  },
  {
    id: "inventoryAlmostFull",
    labelKey: "kinds.inventoryAlmostFull.label",
    descriptionKey: "kinds.inventoryAlmostFull.description",
  },
] as const;

export type NotificationKindId = (typeof NOTIFICATION_KIND_ENTRIES)[number]["id"];

export interface NotificationKindPreference {
  enabled: boolean;
  sound: NotificationSoundId;
}

export type NotificationPrefs = Record<NotificationKindId, NotificationKindPreference>;

/** Legacy chestSoundVariant values (pre notificationPrefs migration). */
export type LegacyChestSoundVariant =
  | "none"
  | "soft-chime"
  | "double-tap"
  | "wood-tick"
  | "whisper-ping";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  chestDrop: { enabled: true, sound: "treasure-fanfare" },
  chestReady: { enabled: true, sound: "soft-chime" },
  heroLevelUp: { enabled: true, sound: "level-triumph" },
  inventoryAlmostFull: { enabled: true, sound: "happy-ping" },
};

/** Clamps the inventory-almost-full fill threshold to 50-100%; defaults to 90. */
export function sanitizeInventoryAlmostFullThresholdPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 90;
  return Math.min(100, Math.max(50, Math.round(value)));
}

export function notificationSoundFile(soundId: NotificationSoundId): string {
  if (soundId === "none") return "";
  const entry = NOTIFICATION_SOUND_ENTRIES.find((s) => s.id === soundId);
  return entry?.file ?? "";
}

const VALID_SOUND_IDS = new Set<NotificationSoundId>([
  "none",
  ...NOTIFICATION_SOUND_ENTRIES.map((s) => s.id),
]);

/** Clamps notification volume to an integer percent 0–100; defaults to 100. */
export function sanitizeNotificationVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function sanitizeNotificationSoundId(
  sound: string | undefined,
  fallback: NotificationSoundId,
): NotificationSoundId {
  if (sound === "none") return "none";
  if (sound !== undefined && VALID_SOUND_IDS.has(sound as NotificationSoundId)) {
    return sound as NotificationSoundId;
  }
  return fallback;
}

function sanitizeKindPreference(
  kind: NotificationKindId,
  pref: Partial<NotificationKindPreference> | undefined,
): NotificationKindPreference {
  const defaults = DEFAULT_NOTIFICATION_PREFS[kind];
  return {
    enabled: pref?.enabled ?? defaults.enabled,
    sound: sanitizeNotificationSoundId(pref?.sound, defaults.sound),
  };
}

export function sanitizeNotificationPrefs(prefs: NotificationPrefs): NotificationPrefs {
  return {
    chestDrop: sanitizeKindPreference("chestDrop", prefs.chestDrop),
    chestReady: sanitizeKindPreference("chestReady", prefs.chestReady),
    heroLevelUp: sanitizeKindPreference("heroLevelUp", prefs.heroLevelUp),
    inventoryAlmostFull: sanitizeKindPreference("inventoryAlmostFull", prefs.inventoryAlmostFull),
  };
}

export function migrateNotificationPrefs(
  raw: Partial<{
    chestSoundVariant?: LegacyChestSoundVariant;
    notificationPrefs?: NotificationPrefs;
  }>,
): NotificationPrefs {
  if (raw.notificationPrefs) {
    return sanitizeNotificationPrefs({
      ...DEFAULT_NOTIFICATION_PREFS,
      ...raw.notificationPrefs,
      chestDrop: { ...DEFAULT_NOTIFICATION_PREFS.chestDrop, ...raw.notificationPrefs.chestDrop },
      chestReady: { ...DEFAULT_NOTIFICATION_PREFS.chestReady, ...raw.notificationPrefs.chestReady },
      heroLevelUp: {
        ...DEFAULT_NOTIFICATION_PREFS.heroLevelUp,
        ...raw.notificationPrefs.heroLevelUp,
      },
      inventoryAlmostFull: {
        ...DEFAULT_NOTIFICATION_PREFS.inventoryAlmostFull,
        ...raw.notificationPrefs.inventoryAlmostFull,
      },
    });
  }

  const legacy = raw.chestSoundVariant ?? "soft-chime";
  const legacySound = sanitizeNotificationSoundId(
    legacy === "none" ? "none" : legacy,
    "soft-chime",
  );

  return sanitizeNotificationPrefs({
    ...DEFAULT_NOTIFICATION_PREFS,
    chestReady: {
      enabled: legacy !== "none",
      sound: legacy === "none" ? "soft-chime" : legacySound,
    },
  });
}
