import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

export function registerLootHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.LOOT_RESET_BOX, (_e, boxKey: string) => services.resetLootBox(boxKey));
  ipc.handle(IPC.LOOT_RESET_ALL, () => services.resetLootAll());
  ipc.handle(
    IPC.LOOT_RECLASSIFY_ITEM,
    (_e, itemKey: number, fromBoxKey: string, toBoxKey: string) =>
      services.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey),
  );
}
