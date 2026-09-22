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
  });
});
