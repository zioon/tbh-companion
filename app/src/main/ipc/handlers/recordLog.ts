import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

export function registerRecordLogHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.GET_RECORD_LOG_PAGE, (_e, page: number, pageSize?: number) =>
    services.getRecordLogPage(page, pageSize ?? 200),
  );
}
