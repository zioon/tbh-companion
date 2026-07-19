import type { IpcMain } from "electron";
import type { BoxTrackerSortOrder } from "../../../../shared/types";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

/**
 * P2-11: validate IPC inputs from the renderer. The renderer is not trusted
 * (a compromised renderer or a bug could pass anything), so each handler
 * guards its arguments before delegating to services. Invalid args return a
 * no-op / empty result rather than throwing, so a bad call doesn't kill the
 * IPC channel.
 */
function isPositiveFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

const VALID_SORT_ORDERS: readonly BoxTrackerSortOrder[] = ["cooldown-first", "ready-first"];

function isSortOrder(v: unknown): v is BoxTrackerSortOrder {
  return typeof v === "string" && (VALID_SORT_ORDERS as readonly string[]).includes(v);
}

/** Validate a boxIds array: must be a non-empty array of positive integers. */
function isBoxIdArray(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((id) => isPositiveFiniteInt(id));
}

export function registerChestHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.GET_CHESTS, () => services.getChests());
}

export function registerBoxTimerHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.GET_BOX_TIMERS, () => services.getBoxTimers());
  ipc.handle(IPC.MARK_BOX_DROPPED, (_e, boxId: unknown) => {
    if (!isPositiveFiniteInt(boxId)) return services.getBoxTimers();
    return services.markBoxDropped(boxId);
  });
  ipc.handle(IPC.CLEAR_BOX_TIMER, (_e, boxId: unknown) => {
    if (!isPositiveFiniteInt(boxId)) return services.getBoxTimers();
    return services.clearBoxTimer(boxId);
  });
  ipc.handle(IPC.SET_BOX_TRACKER_BOXES, (_e, boxIds: unknown) => {
    if (!isBoxIdArray(boxIds)) return services.getBoxTimers();
    return services.setBoxTrackerBoxes(boxIds);
  });
  ipc.handle(IPC.SET_BOX_TRACKER_COOLDOWN, (_e, boxId: unknown, cooldownSeconds: unknown) => {
    if (!isPositiveFiniteInt(boxId) || !isFiniteInt(cooldownSeconds) || cooldownSeconds <= 0) {
      return services.getBoxTimers();
    }
    return services.setBoxTrackerCooldown(boxId, cooldownSeconds);
  });
  ipc.handle(IPC.CLEAR_BOX_TRACKER_COOLDOWN, (_e, boxId: unknown) => {
    if (!isPositiveFiniteInt(boxId)) return services.getBoxTimers();
    return services.clearBoxTrackerCooldown(boxId);
  });
  ipc.handle(IPC.SET_BOX_TRACKER_FARM_STAGE, (_e, boxId: unknown, stageKey: unknown) => {
    if (!isPositiveFiniteInt(boxId) || !isFiniteInt(stageKey) || stageKey <= 0) {
      return services.getBoxTimers();
    }
    return services.setBoxTrackerFarmStage(boxId, stageKey);
  });
  ipc.handle(IPC.CLEAR_BOX_TRACKER_FARM_STAGE, (_e, boxId: unknown) => {
    if (!isPositiveFiniteInt(boxId)) return services.getBoxTimers();
    return services.clearBoxTrackerFarmStage(boxId);
  });
  ipc.handle(IPC.SET_BOX_TRACKER_NOTIFY, (_e, boxId: unknown, enabled: unknown) => {
    if (!isPositiveFiniteInt(boxId) || !isBoolean(enabled)) return services.getBoxTimers();
    return services.setBoxTrackerNotify(boxId, enabled);
  });
  ipc.handle(IPC.SET_BOX_TRACKER_SORT_ORDER, (_e, sortOrder: unknown) => {
    if (!isSortOrder(sortOrder)) return services.getBoxTimers();
    return services.setBoxTrackerSortOrder(sortOrder);
  });
}
