import { readFileSync } from "node:fs";
import {
  catalogItemKeyFromSave,
  indexById,
  normalizeGameItem,
  type GameItem,
} from "../core/gamedata";
import { buildStageBoxCatalog, isStageBoxItemKey, stageBoxIdSet } from "../core/stageBoxes";
import { resolveBundledDataPath } from "../core/bundledData";
import { createLogger } from "./log";

const log = createLogger("gameData");

export class GameDataProvider {
  private index = new Map<number, GameItem>();
  private stageBoxIds = stageBoxIdSet();
  private loaded = false;
  private gameVersion: string | null = null;

  private mergeStageBoxes(items: GameItem[]): void {
    this.stageBoxIds = stageBoxIdSet(items);
    for (const item of items) this.index.set(item.id, item);
  }

  private loadStageBoxes(): void {
    try {
      const path = resolveBundledDataPath("stage_boxes.json");
      const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
      const d = JSON.parse(raw) as { items?: unknown[] };
      if (Array.isArray(d.items)) {
        const items = d.items
          .map((row) => normalizeGameItem(row as Record<string, unknown>))
          .filter((item): item is GameItem => item != null);
        if (items.length > 0) {
          this.mergeStageBoxes(items);
          return;
        }
      }
      // P2-10: surface structural problems (missing/empty items array) instead
      // of silently falling through to the in-code catalog. The fallback still
      // runs so the app stays functional, but the operator sees why.
      log.warn("stage_boxes.json: missing or empty items array, falling back to in-code catalog");
    } catch (e) {
      // P2-10: log the actual error so a corrupt or missing stage_boxes.json is
      // diagnosable. The in-code catalog fallback keeps the app functional.
      log.warn(`stage_boxes.json load failed, using in-code catalog: ${(e as Error).message}`);
    }
    this.mergeStageBoxes(buildStageBoxCatalog().items);
  }

  /** Load gamedata.json, preferring userDataDir if provided. */
  load(userDataDir?: string): void {
    const path = resolveBundledDataPath("gamedata.json", userDataDir);
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    let parsed: { gameVersion?: string; items?: unknown[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error("gamedata.json: invalid JSON");
    }
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      throw new Error("gamedata.json: missing or empty items array");
    }

    const items = parsed.items
      .map((row) => normalizeGameItem(row as Record<string, unknown>))
      .filter((item): item is GameItem => item != null);
    if (items.length === 0) {
      throw new Error("gamedata.json: no valid item rows");
    }

    this.index = indexById(items);
    this.gameVersion = parsed.gameVersion ?? null;
    this.loaded = true;
    this.loadStageBoxes();
  }

  /** Re-read from disk. Safe to call after load(). */
  reload(userDataDir?: string): void {
    this.load(userDataDir);
  }

  get(itemKey: number): GameItem | undefined {
    return this.index.get(catalogItemKeyFromSave(itemKey));
  }

  isStageBox(itemKey: number): boolean {
    return isStageBoxItemKey(itemKey, this.stageBoxIds);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  itemCount(): number {
    return this.index.size;
  }

  /** Catalog's bundled gameVersion (e.g. "1.00.28"). null if unknown. */
  getVersion(): string | null {
    return this.gameVersion;
  }

  /** Read-only view of the catalog-id → GameItem index. Keys are catalog ids (already normalized). */
  asMap(): Map<number, GameItem> {
    return this.index;
  }
}
