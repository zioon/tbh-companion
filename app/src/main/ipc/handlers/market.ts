import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

export function registerMarketHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.PRICES_STATUS, () => services.pricesStatus());
  ipc.handle(IPC.PRICES_REFRESH, (_e, force?: boolean) => services.refreshPrices(force));
  ipc.handle(IPC.PRICES_REFRESH_ITEM, (_e, itemKey: number) => services.refreshItemPrices(itemKey));
  ipc.on(IPC.PRICES_CANCEL, () => services.cancelPrices());
  ipc.handle(IPC.SET_CURRENCY, (_e, iso: string) => services.setCurrency(iso));
  ipc.handle(IPC.MARKET_AUTO_SCAN_TOGGLE, (_e, enabled: boolean) =>
    services.setMarketAutoScanEnabled(enabled),
  );
  ipc.handle(IPC.GET_MARKET_VOLUME, () => services.getMarketVolume());
  ipc.handle(IPC.GET_MARKET_VOLUME_ITEMS, () => services.getMarketVolumeItems());
  ipc.handle(IPC.REFRESH_MARKET_VOLUME_ITEMS, (_e, cardOrder?: string[]) =>
    services.refreshMarketVolumeItems(cardOrder),
  );
  ipc.handle(IPC.REFRESH_MARKET_VOLUME_ITEM, (_e, hash: string) =>
    services.refreshMarketVolumeItem(hash),
  );
  ipc.on(IPC.CANCEL_MARKET_VOLUME_REFRESH, () => services.cancelHistoryRefresh());
}
