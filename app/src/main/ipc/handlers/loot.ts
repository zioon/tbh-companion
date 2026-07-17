import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";
import type { ClassifyPromptResolvePayload } from "../../../../shared/types";

/**
 * P2-11: validate IPC inputs from the renderer. The renderer is not trusted
 * (a compromised renderer or a bug could pass anything), so each handler
 * guards its arguments before delegating to services. Invalid args return a
 * no-op / empty result rather than throwing, so a bad call doesn't kill the
 * IPC channel.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isBoxCategory(v: unknown): v is "common" | "rare" | "act" {
  return v === "common" || v === "rare" || v === "act";
}

function isClassifyResolvePayload(v: unknown): v is ClassifyPromptResolvePayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<ClassifyPromptResolvePayload>;
  return (
    typeof p.promptId === "number" &&
    Array.isArray(p.itemKeys) &&
    p.itemKeys.every((k) => typeof k === "number") &&
    isBoxCategory(p.category)
  );
}

export function registerLootHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.LOOT_RESET_BOX, (_e, boxKey: unknown) => {
    if (!isNonEmptyString(boxKey)) return;
    return services.resetLootBox(boxKey);
  });
  ipc.handle(IPC.LOOT_RESET_ALL, () => services.resetLootAll());
  ipc.handle(
    IPC.LOOT_RECLASSIFY_ITEM,
    (_e, itemKey: unknown, fromBoxKey: unknown, toBoxKey: unknown) => {
      if (
        !isPositiveFiniteInt(itemKey) ||
        !isNonEmptyString(fromBoxKey) ||
        !isNonEmptyString(toBoxKey)
      ) {
        return;
      }
      return services.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey);
    },
  );
  ipc.handle(IPC.LOOT_AUTO_CLASSIFY_TOGGLE, (_e, enabled: unknown) => {
    if (typeof enabled !== "boolean") return;
    return services.setLootAutoClassifyEnabled(enabled);
  });
  ipc.handle(IPC.LOOT_AUTO_CLASSIFY_STATE, () => services.getAutoClassifyState());
  ipc.on(IPC.LOOT_PROMPT_RESOLVE, (_e, payload: unknown) => {
    if (!isClassifyResolvePayload(payload)) return;
    services.resolveClassifyPrompt(payload);
  });
}
