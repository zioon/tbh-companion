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

export class ChestService {
  private readonly boxTypes = loadBoxTypeCatalog();
  private readonly runeCap = loadRuneBoxCapCatalog();
  private readonly runeAutoOpen = loadRuneAutoOpenCatalog();
  private lastChests: ChestState | null = null;

  onSave(text: string, mtime: number, chests: ChestHolding[]): void {
    this.resolveAndPush(chests, text, mtime);
  }

  getChests(): ChestState | null {
    return this.lastChests;
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
      broadcast(IPC.CHESTS, this.lastChests);
    } catch (err) {
      log.error(`resolveAndPush chests failed: ${String(err)}`);
    }
  }
}
