import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { WishCoinOverrides } from "../../../../shared/types";
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
  // 祈愿页「物品手工分类对应硬币」：读 / 写用户绑定。
  // 写入口只接受数组；非法条目由 config 层的 sanitize 逐条丢弃（不抛错）。
  ipc.handle(IPC.GET_WISH_COIN_OVERRIDES, () => services.getWishCoinOverrides());
  ipc.handle(IPC.SET_WISH_COIN_OVERRIDES, (_e, overrides: unknown) =>
    services.setWishCoinOverrides(Array.isArray(overrides) ? (overrides as WishCoinOverrides) : []),
  );
}
