import { app, Menu, Tray } from "electron";

import type { AppServices } from "../app/appState";
import { trayImage } from "../iconPaths";
import { t } from "../i18n";

let tray: Tray | null = null;
let quitting = false;

export function isAppQuitting(): boolean {
  return quitting;
}

export function setAppQuitting(value = true): void {
  quitting = value;
}

function buildMenuTemplate(services: AppServices) {
  return [
    {
      label: t("tray:show"),
      click: () => {
        services.showMain();
      },
    },
    {
      label: t("tray:miniOverlay"),
      click: () => {
        services.openOverlay();
      },
    },
    {
      label: t("tray:boxTracker"),
      click: () => {
        services.openBoxTracker();
      },
    },
    { type: "separator" as const },
    {
      label: t("tray:quit"),
      click: () => {
        setAppQuitting(true);
        app.quit();
      },
    },
  ];
}

export function createTray(services: AppServices): Tray {
  if (tray && !tray.isDestroyed()) return tray;

  tray = new Tray(trayImage());
  tray.setToolTip(t("tray:tooltip"));
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(services)));
  tray.on("double-click", () => {
    services.showMain();
  });

  return tray;
}

/** Rebuild the tray menu and tooltip — called after a language change. */
export function rebuildTrayMenu(services: AppServices): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(t("tray:tooltip"));
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(services)));
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}
