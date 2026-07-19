import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

export function registerCatalogHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.GET_CATALOG_STATUS, () => services.getCatalogStatus());
  ipc.handle(IPC.CATALOG_REFRESH, () => services.refreshCatalog());
  ipc.handle(IPC.GET_LOCALE_DATA, () => services.getLocaleData());
}
