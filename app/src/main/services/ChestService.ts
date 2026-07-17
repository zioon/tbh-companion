import {
  buildChestState,
  loadBoxTypeCatalog,
  loadRuneAutoOpenCatalog,
  loadRuneBoxCapCatalog,
  parseRuneSaveData,
} from "../../core/boxes";
import type { ChestHolding, ChestState } from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { createLogger } from "../log";

const log = createLogger("chests");

/**
 * Per-category slot counts extracted from the save. The keys use the
 * auto-classify `BoxCategory` naming (`rare` = stage boss) so the
 * AutoClassifyService can compare directly against its queue.
 */
export type ChestSlotCounts = { common: number; rare: number; act: number };

export class ChestService {
  private readonly boxTypes = loadBoxTypeCatalog();
  private readonly runeCap = loadRuneBoxCapCatalog();
  private readonly runeAutoOpen = loadRuneAutoOpenCatalog();
  private lastChests: ChestState | null = null;
  /**
   * Callback fired on every successful save parse with the current per-category
   * slot counts. The AutoClassifyService uses this to reconcile its queue
   * against the actual chest inventory — pruning entries whose chest has
   * already opened (queue > slots) and logging when drops were missed
   * (queue < slots).
   */
  private onReconcile?: (slots: ChestSlotCounts) => void;

  onSave(text: string, mtime: number, chests: ChestHolding[]): void {
    this.resolveAndPush(chests, text, mtime);
  }

  getChests(): ChestState | null {
    return this.lastChests;
  }

  /**
   * Register a callback fired on every save parse with the current per-category
   * slot counts. The AutoClassifyService reconciles its queue against these
   * counts to keep the loot queue accurate.
   */
  setOnReconcile(cb: (slots: ChestSlotCounts) => void): void {
    this.onReconcile = cb;
  }

  /**
   * Effective auto-open seconds for each chest category, for the
   * AutoClassifyService's queue TTL computation. Returns null when no save
   * has been parsed yet; the caller falls back to constants in that case.
   */
  getAutoOpenSeconds(): { common: number; stageBoss: number; actBoss: number } | null {
    if (!this.lastChests) return null;
    return this.lastChests.autoOpen;
  }

  private resolveAndPush(chests: ChestHolding[], text: string, mtime: number): void {
    try {
      const purchases = parseRuneSaveData(text);
      this.lastChests = buildChestState(
        chests,
        purchases,
        mtime,
        this.boxTypes,
        this.runeCap,
        this.runeAutoOpen,
      );
      this.reconcile();
      broadcast(IPC.CHESTS, this.lastChests);
    } catch (err) {
      log.error(`resolveAndPush chests failed: ${String(err)}`);
    }
  }

  /**
   * Fire the reconcile callback with the current per-category slot counts.
   * Unlike the previous "detect chest opens" approach (which only reported
   * decreases), this passes the absolute counts so the AutoClassifyService
   * can detect both excess (queue > slots → prune) and deficit
   * (queue < slots → log). This handles every edge case: manual opens,
   * auto-opens that fired without an unclassified burst, TTL-lapped entries,
   * and chests that predate live tracking.
   */
  private reconcile(): void {
    if (!this.lastChests || !this.onReconcile) return;
    this.onReconcile({
      common: this.lastChests.common.quantity,
      // stageBoss slot maps to the "rare" auto-classify category.
      rare: this.lastChests.stageBoss.quantity,
      act: this.lastChests.actBoss.quantity,
    });
  }
}
