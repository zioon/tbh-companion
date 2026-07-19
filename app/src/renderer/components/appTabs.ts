// Tab identifiers + visibility, kept out of AppTabBar.tsx so that file only
// exports its component (react-refresh/only-export-components).
//
// Tab labels are looked up via i18next under the `tabs` namespace keyed by the
// tab id (e.g. `tabs:live`). The English source strings live in
// `shared/locales/en/tabs.json`.

export type TabId =
  | "live"
  | "inventory"
  | "chests"
  | "loot"
  | "pets"
  | "lookup"
  | "market"
  | "settings"
  | "about"
  | "debug";

const TAB_IDS: TabId[] = [
  "live",
  "inventory",
  "chests",
  "loot",
  "pets",
  "lookup",
  "market",
  "settings",
  "about",
];

// The live-memory diagnostics tab ships only in dev builds, not the production bar.
const DEV_TAB_IDS: TabId[] = ["debug"];

/** Visible tab ids for the given build mode — dev-only tabs appear only when `isDev`. */
export function getVisibleTabs(isDev: boolean): TabId[] {
  return isDev ? [...TAB_IDS, ...DEV_TAB_IDS] : TAB_IDS;
}
