import { BrowserWindow } from "electron";

import { IPC } from "../../../shared/ipc";
import type { NotificationSoundPayload } from "../../../shared/types";

/**
 * High-frequency channels that drive React re-renders. These are skipped for
 * hidden windows so a backgrounded main window (mini mode) doesn't accumulate
 * heap from 25 Hz snapshot processing it will never display.
 */
const HIGH_FREQ_CHANNELS = new Set<string>([
  IPC.LIVE_MEMORY,
  IPC.STATS,
]);

/** Send a channel payload to every live, visible renderer window. */
export function broadcast(channel: string, payload: unknown): void {
  const isHighFreq = HIGH_FREQ_CHANNELS.has(channel);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    // Skip hidden windows for high-frequency channels — the main window is
    // only hidden (not destroyed) when in mini mode, and receiving 25 Hz
    // snapshots there causes unbounded renderer heap growth.
    if (isHighFreq && !win.isVisible()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Frame disposed between the isDestroyed check and send — safe to ignore
    }
  }
}

function isAuxiliaryRenderer(win: BrowserWindow): boolean {
  try {
    const hash = new URL(win.webContents.getURL()).hash;
    return hash === "#overlay" || hash === "#box-tracker";
  } catch {
    return false;
  }
}

/** Play alert audio in one renderer (main companion window when available). */
export function sendNotificationSound(payload: NotificationSoundPayload): void {
  const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const target = live.find((w) => !isAuxiliaryRenderer(w)) ?? live[0];
  target?.webContents.send(IPC.PLAY_NOTIFICATION_SOUND, payload);
}
