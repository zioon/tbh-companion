// Web-build end-to-end check: runs the *web* pipeline against a real save file.
//
// This exercises exactly what the browser bundle runs — WebCrypto decrypt
// (`core/es3Web`), `parseInventory`, `resolveInventory` and the in-memory catalog
// source (`src/web/dataSource`). Node 22 exposes `crypto.subtle` globally, so no
// browser shim is needed.
//
// The test is skipped when no save file is present, matching how
// `test/integration/realSave.test.ts` treats local-only fixtures.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { installWebDataSource } from "../../src/web/dataSource";
import { analyzeSaveFile } from "../../src/web/analyzeSave";
import { WEB_DATA_FILES } from "../../src/web/dataSource";

const SAVE_DIR = join(homedir(), "AppData", "LocalLow", "TesseractStudio", "TaskBarHero");
const SAVE_PATH = join(SAVE_DIR, "SaveFile_Live.es3");
const hasSave = existsSync(SAVE_PATH);

describe("web save pipeline", () => {
  it("ships the catalogs the analyzer needs", () => {
    expect(WEB_DATA_FILES).toContain("gamedata.json");
    expect(WEB_DATA_FILES).toContain("lookup_items.json");
    expect(WEB_DATA_FILES).toContain("box_types.json");
    expect(WEB_DATA_FILES).toContain("locale_strings_zh-CN.json");
    // Pets page + chest capacity cards + synthesis/offerings (#1 batch).
    expect(WEB_DATA_FILES).toContain("pets.json");
    expect(WEB_DATA_FILES).toContain("rune_box_cap.json");
    expect(WEB_DATA_FILES).toContain("rune_auto_open.json");
    expect(WEB_DATA_FILES).toContain("synthesis_model.json");
    expect(WEB_DATA_FILES).toContain("offerings.json");
  });

  it("rejects a file that is too small", async () => {
    installWebDataSource();
    await expect(analyzeSaveFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(/too small/i);
  });

  it.skipIf(!hasSave)("decrypts and resolves a real save", async () => {
    installWebDataSource();
    const bytes = readFileSync(SAVE_PATH);

    const result = await analyzeSaveFile(new Uint8Array(bytes), "zh-CN", Date.now());

    // A real save must produce a non-trivial inventory and real chest slots —
    // otherwise the pipeline silently read garbage that happened to decrypt.
    expect(result.stats.itemCount).toBeGreaterThan(10);
    expect(result.inventory.rows.length).toBeGreaterThan(10);
    expect(result.snapshot.inventoryCapacity).toBeGreaterThan(0);
    expect(result.snapshot.inventoryUsed).toBeGreaterThan(0);
    expect(result.snapshot.chests.length).toBeGreaterThan(0);

    // Localization applied: at least one row differs from its English catalog
    // name (the zh-CN catalog covers several hundred items).
    const localized = result.inventory.rows.filter((r) => /[\u4e00-\u9fff]/.test(r.name));
    expect(localized.length).toBeGreaterThan(0);

    // Rows must be internally consistent: counts are positive and the
    // location breakdown never exceeds the total.
    for (const row of result.inventory.rows) {
      expect(row.count).toBeGreaterThan(0);
      expect(row.inventoryCount + row.stashCount + row.tradingCount).toBeLessThanOrEqual(row.count);
    }

    // Pet progress resolves from the same decryption pass: the catalog is
    // fully rendered and the save's kill counts / equipped pet are reflected.
    expect(result.pets.pets.length).toBeGreaterThan(0);
    expect(result.pets.unlockKillCount).toBeGreaterThan(0);
    expect(result.pets.saveMtime).toBeGreaterThan(0);
    const equipped = result.pets.pets.filter((p) => p.equipped);
    expect(equipped.length).toBeLessThanOrEqual(1);

    // Chest slots resolve from the same pass: six capacity categories with
    // sane values, and the held total matching the save's chest holdings.
    expect(result.chests.capacity.common.base).toBeGreaterThan(0);
    expect(result.chests.saveMtime).toBeGreaterThan(0);
    const capacityTotal =
      result.chests.capacity.common.base + result.chests.capacity.common.runeBonus;
    expect(result.chests.common.capacity).toBe(capacityTotal);
    expect(result.chests.totalHeld).toBe(
      result.snapshot.chests.reduce((sum, chest) => sum + chest.quantity, 0),
    );
    for (const slot of [
      result.chests.common,
      result.chests.stageBoss,
      result.chests.actBoss,
      result.chests.plagueCommon,
      result.chests.plagueRare,
      result.chests.plagueAct,
    ]) {
      // A save can hold more than the capacity (overfull), so only bound below.
      expect(slot.quantity).toBeGreaterThanOrEqual(0);
      expect(slot.capacity).toBeGreaterThan(0);
    }
  });
});
