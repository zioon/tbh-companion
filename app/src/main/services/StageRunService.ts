import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StageRunTracker } from "../../core/stageRunTracker";
import { stageName } from "../../core/stages";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../core/localeCatalog";
import type { StageRunHistoryEntry, StageRunStats, StageRunTrackerSnapshot } from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { STAGE_RUN_FILE } from "./appData";
import { createLogger } from "../log";

const log = createLogger("stageRuns");

/**
 * Durable stage-clear-history storage, independent of `session_state.json`
 * (see `core/stageRunTracker.ts` for why). Mirrors `BoxTimerService`'s simple
 * load-once / persist-on-change pattern — writes are rare (one per stage
 * clear), so synchronous `writeFileSync` on each change is fine.
 */
export class StageRunService {
  private readonly tracker = new StageRunTracker();
  /**
   * LocaleCatalog used for stage name localization in getStats. Set once at
   * construction (defaults to emptyLocaleCatalog) and swapped via
   * {@link setLocaleCatalog} when the user changes language. Kept as a field
   * (not threaded through every call) so getStats stays parameterless — same
   * pattern as TrackingService / BoxTimerService.
   */
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();

  constructor(initialCatalog: LocaleCatalog = emptyLocaleCatalog()) {
    this.localeCatalog = initialCatalog;
    this.load();
  }

  /** Record a live stage clear (duration + XP/gold gained since the previous recorded clear). */
  recordClear(stageKey: number, clearTimeSec: number, xpGained: number, goldGained: number): void {
    this.tracker.recordClear(stageKey, clearTimeSec, xpGained, goldGained);
    this.persist();
    this.push();
  }

  getStats(): StageRunStats {
    const raw = this.tracker.getStats();
    // Recompute stageName on every call so a language switch via
    // setLocaleCatalog is reflected without re-recording history. The
    // persisted snapshot may also carry a stale (or absent, pre-v1.19.x)
    // stageName, so we can't trust a stored value either.
    return {
      ...raw,
      history: raw.history.map((entry) => withStageName(entry, this.localeCatalog)),
    };
  }

  /**
   * Swap the LocaleCatalog used for stage name localization. Called by
   * appState when the user changes language. Callers should re-emit state
   * via push() afterwards so the renderer sees the renamed entries.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
  }

  /** Clear in-memory history after stage_run_history.json was deleted from Settings. */
  resetStorage(): void {
    this.tracker.applySnapshot({ history: [] });
    this.push();
  }

  push(): void {
    broadcast(IPC.STAGE_RUNS, this.getStats());
  }

  private persistPath(): string {
    try {
      return join(app.getPath("userData"), STAGE_RUN_FILE);
    } catch {
      return join(process.cwd(), STAGE_RUN_FILE);
    }
  }

  private load(): void {
    const path = this.persistPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as StageRunTrackerSnapshot;
      this.tracker.applySnapshot(raw);
    } catch (err) {
      log.warn(`Could not read stage_run_history.json: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    try {
      const path = this.persistPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(this.tracker.captureSnapshot(), null, 2));
    } catch (err) {
      log.warn(`Stage run persist failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Attach a localized `stageName` to a history entry. Always recomputes from
 * `stageKey + catalog` (never trusts a stored `stageName`) so a language
 * switch via {@link StageRunService.setLocaleCatalog} is reflected on the
 * next `getStats()` call without re-recording history.
 */
function withStageName(
  entry: StageRunHistoryEntry,
  catalog: LocaleCatalog,
): StageRunHistoryEntry {
  return { ...entry, stageName: stageName(entry.stageKey, catalog) };
}
