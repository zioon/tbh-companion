// Durable storage for the unified record log, independent of `session_state.json`
// so it survives session resets and the in-memory LogManager bucket wipeout.
// Mirrors StageRunService's load-once / persist-on-change pattern, but debounces
// writes (~2s) because record-log events can arrive in bursts (chest farming).
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecordLogTracker } from "../../core/recordLogTracker";
import type { RecordLogTrackerSnapshot } from "../../../shared/types";
import { RECORD_LOG_FILE } from "./appData";
import { createLogger } from "../log";

const log = createLogger("recordLog");

export class RecordLogService {
  private readonly flushMs: number;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /**
   * The acquire ring's last-delivered index, persisted with the archive and
   * handed back to the reader on the next start: a companion restart then
   * resumes the ring incrementally instead of replaying the whole window.
   */
  private acquireWatermark: number | null = null;

  constructor(
    private readonly tracker: RecordLogTracker,
    flushMs = 2000,
  ) {
    this.flushMs = flushMs;
    this.load();
  }

  /** Read `record_log.json` once at startup and merge into the tracker. */
  load(): void {
    const path = this.persistPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as RecordLogTrackerSnapshot;
      this.tracker.applySnapshot(raw);
      if (typeof raw.acquireWatermark === "number" && raw.acquireWatermark > 0) {
        this.acquireWatermark = raw.acquireWatermark;
      }
    } catch (err) {
      log.warn(`Could not read ${RECORD_LOG_FILE}: ${(err as Error).message}`);
    }
  }

  /** The persisted acquire-list read position (null = no resume info yet). */
  getAcquireWatermark(): number | null {
    return this.acquireWatermark;
  }

  /**
   * Advance the persisted read position (called with every acquire batch).
   */
  setAcquireWatermark(total: number): void {
    if (this.acquireWatermark === total) return;
    this.acquireWatermark = total;
    this.schedulePersist();
  }

  /** Debounced write-after-change. Safe to call on every new event. */
  schedulePersist(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Force any pending change to disk (called on stop/exit). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.persist();
  }

  /** Drop in-memory history after `record_log.json` was deleted from Settings. */
  resetStorage(): void {
    this.tracker.reset();
    this.acquireWatermark = null;
  }

  private persistPath(): string {
    try {
      return join(app.getPath("userData"), RECORD_LOG_FILE);
    } catch {
      return join(process.cwd(), RECORD_LOG_FILE);
    }
  }

  private persist(): void {
    try {
      const path = this.persistPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          {
            ...this.tracker.snapshot(),
            acquireWatermark: this.acquireWatermark,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      log.warn(`Record log persist failed: ${(err as Error).message}`);
    }
  }
}
