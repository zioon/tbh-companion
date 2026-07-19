import { BrowserWindow } from "electron";
import { appIconImage, setWindowIcon } from "../iconPaths";
import { PRELOAD_SCRIPT } from "../paths";
import { loadRenderer } from "./loadRenderer";
import { attachCrashRecovery } from "./crashRecovery";
import { applyWindowTopmost } from "./alwaysOnTop";
import {
  BOX_TRACKER_HEIGHT,
  BOX_TRACKER_MIN_HEIGHT,
  BOX_TRACKER_MIN_WIDTH,
  BOX_TRACKER_WIDTH,
} from "./constants";
import {
  applyWindowLayout,
  attachWindowLayoutPersistence,
  type WindowLayoutApplyOptions,
} from "./windowLayout";
import type { WindowLayoutEntry } from "../../../shared/types";

const BOX_TRACKER_LAYOUT_OPTIONS: WindowLayoutApplyOptions = {
  defaults: { width: BOX_TRACKER_WIDTH, height: BOX_TRACKER_HEIGHT },
  constraints: {
    minWidth: BOX_TRACKER_MIN_WIDTH,
    minHeight: BOX_TRACKER_MIN_HEIGHT,
    requireWidth: true,
    requireHeight: true,
  },
  useContentSize: true,
};

export function createBoxTrackerWindow(
  getExisting: () => BrowserWindow | null,
  setWindow: (w: BrowserWindow | null) => void,
  startTopmost: () => boolean,
  onOpen?: () => void,
  onClose?: () => void,
  savedLayout?: WindowLayoutEntry,
  onLayoutChange?: (entry: WindowLayoutEntry) => void,
): BrowserWindow {
  const existing = getExisting();
  if (existing && !existing.isDestroyed()) {
    applyWindowTopmost(existing, startTopmost(), true);
    existing.show();
    existing.focus();
    // Do not call onOpen here: the tick is already running from the original
    // open. Calling it again would increment BoxTimerService.subscribers
    // without a matching onClose, leaking the 1Hz timer forever.
    return existing;
  }

  const topmost = startTopmost();
  const icon = appIconImage();
  const win = new BrowserWindow({
    width: BOX_TRACKER_WIDTH,
    height: BOX_TRACKER_HEIGHT,
    useContentSize: true,
    show: false,
    title: "Stage boss chest tracker",
    frame: false,
    resizable: true,
    minWidth: BOX_TRACKER_MIN_WIDTH,
    minHeight: BOX_TRACKER_MIN_HEIGHT,
    alwaysOnTop: topmost,
    backgroundColor: "#0f1117",
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      // P1-5: preload only uses contextBridge + ipcRenderer (verified: no
      // `require` / `process` / `fs` / `path` / `node:` references in
      // app/src/preload/index.ts), so the sandbox can stay enabled. This
      // shrinks the attack surface of the secondary window by denying the
      // renderer direct access to Node primitives.
      sandbox: true,
    },
  });

  applyWindowLayout(win, savedLayout, BOX_TRACKER_LAYOUT_OPTIONS);
  if (onLayoutChange) {
    attachWindowLayoutPersistence(win, BOX_TRACKER_LAYOUT_OPTIONS, onLayoutChange);
  }

  applyWindowTopmost(win, topmost, true);
  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    setWindow(null);
    onClose?.();
  });

  loadRenderer(win, "box-tracker");
  attachCrashRecovery(win, "box-tracker");
  setWindowIcon(win);
  setWindow(win);
  onOpen?.();
  return win;
}
