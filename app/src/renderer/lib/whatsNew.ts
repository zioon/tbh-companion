import { DISCORD_URL } from "./externalLinks";

export interface WhatsNewAction {
  labelKey: string;
  href: string;
}

export interface WhatsNewEntry {
  version: string;
  /** i18n key under whatsNew namespace, e.g. "versions.1.17.0.title". */
  titleKey: string;
  /** i18n key under whatsNew namespace returning an array, e.g. "versions.1.17.0.bullets". */
  bulletsKey: string;
  action?: WhatsNewAction;
}

export const WHATS_NEW_STORAGE_KEY = "tbh.whatsNew.lastSeenVersion";

const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
  {
    version: "1.17.0",
    titleKey: "versions.1.17.0.title",
    bulletsKey: "versions.1.17.0.bullets",
  },
  {
    version: "1.16.0",
    titleKey: "versions.1.16.0.title",
    bulletsKey: "versions.1.16.0.bullets",
  },
  {
    version: "1.15.0",
    titleKey: "versions.1.15.0.title",
    bulletsKey: "versions.1.15.0.bullets",
  },
  {
    version: "1.13.0",
    titleKey: "versions.1.13.0.title",
    bulletsKey: "versions.1.13.0.bullets",
    action: {
      labelKey: "versions.1.13.0.actionLabel",
      href: DISCORD_URL,
    },
  },
];

export function whatsNewForVersion(version: string | undefined): WhatsNewEntry | null {
  if (!version) return null;
  const normalized = version.replace(/^v/, "").replace(/-dev$/, "");
  return WHATS_NEW_ENTRIES.find((entry) => entry.version === normalized) ?? null;
}

export function readLastSeenWhatsNewVersion(): string | null {
  try {
    return window.localStorage.getItem(WHATS_NEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function markWhatsNewSeen(version: string): void {
  try {
    window.localStorage.setItem(WHATS_NEW_STORAGE_KEY, version);
  } catch {
    // Ignore storage failures; dismissal should still close for this session.
  }
}
