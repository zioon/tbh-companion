import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isPersistedSessionState,
  isLiveMemoryActive,
  isPlausibleTrackerSnapshot,
  sessionMatchesConfig,
  snapshotContinuesSession,
} from "../../core/sessionState";
import type { XpTracker } from "../../core/tracker";
import type { ChestDropTracker } from "../../core/chestDropTracker";
import type { BoxOpenTracker } from "../../core/boxOpenTracker";
import type { WishTracker } from "../../core/wishTracker";
import type {
  AppConfig,
  BoxOpenTrackerSnapshot,
  ChestDropTrackerSnapshot,
  PersistedSessionState,
  SaveSnapshot,
  SessionUiSnapshot,
  TrackerSnapshot,
  WishTrackerSnapshot,
} from "../../../shared/types";
import { expandPath } from "../config";
import { SESSION_STATE_FILE } from "./appData";
import { createLogger } from "../log";

const log = createLogger("session");
const SAVE_INTERVAL_MS = 15_000;
const STATUS_CLEAR_MS = 60_000;

export type SessionRestoreResult = "restored" | "fresh" | "discarded";

export class SessionStateService {
  private pendingTracker: TrackerSnapshot | null = null;
  private pendingChestDropTracker: ChestDropTrackerSnapshot | null = null;
  private pendingBoxOpenTracker: BoxOpenTrackerSnapshot | null = null;
  /**
   * Pending wish-tracker restore. OPTIONAL in `session_state.json` (P0-less
   * snapshots and pre-wish builds omit it) — a missing value simply skips the
   * wish restore, leaving the freshly-constructed tracker empty.
   */
  private pendingWishTracker: WishTrackerSnapshot | null = null;
  private pendingLastSaveMtime: number | null = null;
  private lastSaveMtime: number | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private statusClearTimer: NodeJS.Timeout | null = null;
  private statusOverride: string | null = null;
  private ui: SessionUiSnapshot = { miniOverlayOpen: false, boxTrackerOpen: false };
  private savePath = "";

  load(config: AppConfig): SessionUiSnapshot {
    this.savePath = expandPath(config.savePath);
    this.pendingTracker = null;
    this.pendingChestDropTracker = null;
    this.pendingBoxOpenTracker = null;
    this.pendingWishTracker = null;
    this.pendingLastSaveMtime = null;
    this.lastSaveMtime = null;

    const path = this.filePath();
    if (!existsSync(path)) return { ...this.ui };

    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (!isPersistedSessionState(raw)) {
        log.warn("Ignoring invalid session_state.json");
        return { ...this.ui };
      }

      this.ui = {
        miniOverlayOpen: raw.ui.miniOverlayOpen,
        boxTrackerOpen: raw.ui.boxTrackerOpen,
      };

      if (!sessionMatchesConfig(raw, this.savePath, config)) {
        log.info("Session snapshot ignored (save path or tracking settings changed)");
        return { ...this.ui };
      }

      this.pendingTracker = raw.tracker;
      this.pendingChestDropTracker = raw.chestDropTracker ?? null;
      this.pendingBoxOpenTracker = raw.boxOpenTracker ?? null;
      this.pendingWishTracker = raw.wishTracker ?? null;
      this.pendingLastSaveMtime = raw.lastSaveMtime;
      this.lastSaveMtime = raw.lastSaveMtime;
      log.info("Session snapshot loaded; waiting for save read to restore");
      return { ...this.ui };
    } catch (err) {
      log.warn(`Could not read session snapshot: ${(err as Error).message}`);
      return { ...this.ui };
    }
  }

  startAutosave(
    getContext: () => {
      tracker: XpTracker;
      chestDropTracker: ChestDropTracker;
      boxOpenTracker: BoxOpenTracker;
      wishTracker: WishTracker;
      lastSnap: SaveSnapshot | null;
      config: AppConfig;
    },
  ): void {
    this.stopAutosave();
    this.saveTimer = setInterval(() => {
      const ctx = getContext();
      this.persist(
        ctx.tracker,
        ctx.chestDropTracker,
        ctx.boxOpenTracker,
        ctx.lastSnap,
        ctx.config,
        ctx.wishTracker,
      );
    }, SAVE_INTERVAL_MS);
  }

  stopAutosave(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
  }

  /** Apply pending tracker restore on the first save snapshot (or discard if stale). */
  tryRestoreOnSnapshot(
    tracker: XpTracker,
    chestDropTracker: ChestDropTracker,
    boxOpenTracker: BoxOpenTracker,
    snap: SaveSnapshot,
    wishTracker: WishTracker | null = null,
  ): SessionRestoreResult {
    if (!this.pendingTracker || this.pendingLastSaveMtime === null) {
      this.lastSaveMtime = snap.saveMtime;
      return "fresh";
    }

    if (!snapshotContinuesSession(this.pendingLastSaveMtime, snap)) {
      log.info(
        `Session discarded (save mtime ${snap.saveMtime} < snapshot ${this.pendingLastSaveMtime})`,
      );
      this.pendingTracker = null;
      this.pendingChestDropTracker = null;
      this.pendingBoxOpenTracker = null;
      this.pendingWishTracker = null;
      this.pendingLastSaveMtime = null;
      this.lastSaveMtime = snap.saveMtime;
      this.setStatusOverride("New session");
      this.deleteFile();
      return "discarded";
    }

    if (!isPlausibleTrackerSnapshot(this.pendingTracker)) {
      log.info("Session discarded (implausible tracker totals — likely live/save baseline mix)");
      this.pendingTracker = null;
      this.pendingChestDropTracker = null;
      this.pendingBoxOpenTracker = null;
      this.pendingWishTracker = null;
      this.pendingLastSaveMtime = null;
      this.lastSaveMtime = snap.saveMtime;
      this.setStatusOverride("New session");
      this.deleteFile();
      return "discarded";
    }

    // Apply tracker + chest + boxOpen restore. If any applySnapshot throws
    // (schema drift, corrupt snapshot), we still clear pending so the next
    // snapshot doesn't retry the same bad payload in an error loop.
    try {
      tracker.applySnapshot(this.pendingTracker);
      // Re-anchor the restored gold baseline to the fresh save before the next
      // tracker.update() counts its diff: a game update that migrates the
      // balance would otherwise surface as a huge bogus "gold earned".
      // (pendingLastSaveMtime is nulled in the finally below, so read it here.)
      const persistedLastMtime = this.pendingLastSaveMtime;
      const reconcile = tracker.reconcileGoldBaseline(
        snap.gold,
        snap.saveMtime,
        persistedLastMtime,
      );
      if (reconcile === "rebased") {
        log.info(
          "Session gold baseline re-anchored to save (implausible jump — game update or balance migration)",
        );
      } else if (reconcile === "counted") {
        log.info("Session gold bridged across restart (plausible offline gain counted)");
      }
      if (this.pendingChestDropTracker) {
        chestDropTracker.applySnapshot(this.pendingChestDropTracker);
      }
      if (this.pendingBoxOpenTracker) {
        boxOpenTracker.applySnapshot(this.pendingBoxOpenTracker);
      }
      // Wish restore is independent of chest/box restores: an absent snapshot
      // (older build) just leaves the fresh tracker empty — never an error.
      if (wishTracker && this.pendingWishTracker) {
        wishTracker.applySnapshot(this.pendingWishTracker);
      }
      log.info("Session stats restored from snapshot");
      return "restored";
    } catch (err) {
      log.warn(`Session restore failed, discarding snapshot: ${(err as Error).message}`);
      this.deleteFile();
      return "discarded";
    } finally {
      this.pendingTracker = null;
      this.pendingChestDropTracker = null;
      this.pendingBoxOpenTracker = null;
      this.pendingWishTracker = null;
      this.pendingLastSaveMtime = null;
      this.lastSaveMtime = snap.saveMtime;
    }
  }

  persist(
    tracker: XpTracker,
    chestDropTracker: ChestDropTracker,
    boxOpenTracker: BoxOpenTracker,
    lastSnap: SaveSnapshot | null,
    config: AppConfig,
    wishTracker: WishTracker | null = null,
  ): void {
    const mtime = lastSnap?.saveMtime ?? this.lastSaveMtime;
    if (mtime === null && !tracker.isInitialized && this.pendingTracker === null) return;

    this.savePath = expandPath(config.savePath);
    const storedMtime = mtime ?? 0;
    if (mtime !== null) this.lastSaveMtime = mtime;

    const payload: PersistedSessionState = {
      version: 1,
      savePath: this.savePath,
      lastSaveMtime: storedMtime,
      rollingWindowMinutes: config.rollingWindowMinutes,
      liveMemoryEnabled: isLiveMemoryActive(config),
      tracker: tracker.captureSnapshot(),
      chestDropTracker: chestDropTracker.captureSnapshot(),
      boxOpenTracker: boxOpenTracker.captureSnapshot(),
      // Omitted (undefined) when no wish tracker is wired — the JSON field is
      // optional, so older consumers keep parsing the file.
      wishTracker: wishTracker?.captureSnapshot(),
      ui: { ...this.ui },
    };

    try {
      const path = this.filePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(payload, null, 2));
    } catch (err) {
      log.warn(`Session persist failed: ${(err as Error).message}`);
    }
  }

  clearSession(
    tracker: XpTracker,
    chestDropTracker: ChestDropTracker,
    boxOpenTracker: BoxOpenTracker,
    config: AppConfig,
    wishTracker: WishTracker | null = null,
  ): void {
    this.pendingTracker = null;
    this.pendingChestDropTracker = null;
    this.pendingBoxOpenTracker = null;
    this.pendingWishTracker = null;
    this.pendingLastSaveMtime = null;
    this.lastSaveMtime = null;
    this.statusOverride = null;
    this.clearStatusTimer();
    tracker.reset();
    chestDropTracker.reset();
    boxOpenTracker.resetAll();
    wishTracker?.reset();
    this.persist(tracker, chestDropTracker, boxOpenTracker, null, config, wishTracker);
  }

  invalidatePending(): void {
    this.pendingTracker = null;
    this.pendingChestDropTracker = null;
    this.pendingBoxOpenTracker = null;
    this.pendingWishTracker = null;
    this.pendingLastSaveMtime = null;
  }

  setMiniOverlayOpen(open: boolean): void {
    if (this.ui.miniOverlayOpen === open) return;
    this.ui.miniOverlayOpen = open;
  }

  setBoxTrackerOpen(open: boolean): void {
    if (this.ui.boxTrackerOpen === open) return;
    this.ui.boxTrackerOpen = open;
  }

  getUiSnapshot(): SessionUiSnapshot {
    return { ...this.ui };
  }

  getStatusOverride(): string | null {
    return this.statusOverride;
  }

  notifyNewSession(): void {
    this.setStatusOverride("New session");
  }

  flush(
    tracker: XpTracker,
    chestDropTracker: ChestDropTracker,
    boxOpenTracker: BoxOpenTracker,
    lastSnap: SaveSnapshot | null,
    config: AppConfig,
    wishTracker: WishTracker | null = null,
  ): void {
    this.persist(tracker, chestDropTracker, boxOpenTracker, lastSnap, config, wishTracker);
  }

  onTrackerReset(
    tracker: XpTracker,
    chestDropTracker: ChestDropTracker,
    boxOpenTracker: BoxOpenTracker,
    config: AppConfig,
    lastSnap: SaveSnapshot | null,
    wishTracker: WishTracker | null = null,
  ): void {
    this.pendingTracker = null;
    this.pendingChestDropTracker = null;
    this.pendingBoxOpenTracker = null;
    this.pendingWishTracker = null;
    this.pendingLastSaveMtime = null;
    this.statusOverride = null;
    this.clearStatusTimer();
    if (lastSnap) {
      this.lastSaveMtime = lastSnap.saveMtime;
    }
    this.persist(tracker, chestDropTracker, boxOpenTracker, lastSnap, config, wishTracker);
  }

  onFileDeleted(): void {
    this.pendingTracker = null;
    this.pendingChestDropTracker = null;
    this.pendingBoxOpenTracker = null;
    this.pendingWishTracker = null;
    this.pendingLastSaveMtime = null;
    this.lastSaveMtime = null;
    this.statusOverride = null;
    this.clearStatusTimer();
  }

  private setStatusOverride(message: string): void {
    this.statusOverride = message;
    this.clearStatusTimer();
    this.statusClearTimer = setTimeout(() => {
      this.statusOverride = null;
      this.statusClearTimer = null;
    }, STATUS_CLEAR_MS);
  }

  private clearStatusTimer(): void {
    if (this.statusClearTimer) clearTimeout(this.statusClearTimer);
    this.statusClearTimer = null;
  }

  private filePath(): string {
    try {
      return join(app.getPath("userData"), SESSION_STATE_FILE);
    } catch {
      return join(process.cwd(), SESSION_STATE_FILE);
    }
  }

  private deleteFile(): void {
    const path = this.filePath();
    if (!existsSync(path)) return;
    try {
      unlinkSync(path);
    } catch (err) {
      log.warn(`Could not delete session snapshot: ${(err as Error).message}`);
    }
  }
}
