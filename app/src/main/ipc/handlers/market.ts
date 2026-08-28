import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function registerMarketHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.PRICES_STATUS, () => services.pricesStatus());
  ipc.handle(IPC.PRICES_REFRESH, (_e, force?: boolean) => services.refreshPrices(force));
  ipc.handle(IPC.PRICES_REFRESH_ITEM, (_e, itemKey: number) => services.refreshItemPrices(itemKey));
  ipc.on(IPC.PRICES_CANCEL, () => services.cancelPrices());
  ipc.handle(IPC.SET_CURRENCY, (_e, iso: unknown) =>
    isNonEmptyString(iso) ? services.setCurrency(iso) : undefined,
  );
  ipc.handle(IPC.MARKET_AUTO_SCAN_TOGGLE, (_e, enabled: boolean) =>
    services.setMarketAutoScanEnabled(enabled),
  );
  ipc.handle(IPC.GET_MARKET_VOLUME, () => services.getMarketVolume());
  ipc.handle(IPC.GET_MARKET_VOLUME_ITEMS, () => services.getMarketVolumeItems());
  ipc.handle(IPC.REFRESH_MARKET_VOLUME_ITEMS, (_e, cardOrder: unknown) =>
    services.refreshMarketVolumeItems(isStringArray(cardOrder) ? cardOrder : undefined),
  );
  ipc.handle(IPC.REFRESH_MARKET_VOLUME_ITEM, (_e, hash: unknown) =>
    isNonEmptyString(hash) ? services.refreshMarketVolumeItem(hash) : undefined,
  );
  ipc.handle(IPC.EXPORT_MARKET_VOLUME, () => services.exportMarketVolumeHistory());
  ipc.handle(IPC.IMPORT_MARKET_VOLUME, () => services.importMarketVolumeHistory());
  ipc.on(IPC.CANCEL_MARKET_VOLUME_REFRESH, () => services.cancelHistoryRefresh());
}
