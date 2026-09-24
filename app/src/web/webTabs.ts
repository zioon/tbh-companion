// Web shell: the section identifiers, in nav order.
//
// Kept in its own module so the shell and the panels can share the union
// without a runtime import cycle (the shell imports the panels as values).

export const WEB_TAB_IDS = ["home", "inventory", "chests", "pets", "lookup", "trading"] as const;

export type WebTabId = (typeof WEB_TAB_IDS)[number];
