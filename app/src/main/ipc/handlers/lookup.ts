import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function registerLookupHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.GET_LOOKUP_CATALOG, () => services.getLookupCatalog());
  ipc.handle(IPC.GET_LOOKUP_SOURCES, () => services.getLookupSources());
  ipc.handle(IPC.GET_LOOKUP_SYNTHESIS_MODEL, () => services.getLookupSynthesisModel());
  ipc.handle(IPC.GET_OFFERINGS, () => services.getOfferings());
  ipc.handle(IPC.GET_LOOKUP_PRICES, () => services.getLookupPrices());
  ipc.handle(IPC.GET_LOOKUP_PRICES_POLL_STATUS, () => services.getLookupPricePollStatus());
  ipc.handle(IPC.LOOKUP_PRICES_POLL, (_e, hash: unknown) =>
    services.pollLookupPrices(isNonEmptyString(hash) ? hash : undefined),
  );
}
