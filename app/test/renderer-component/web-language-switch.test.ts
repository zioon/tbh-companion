// Regression guard for `fix(web): re-resolve the loaded inventory when the
// language changes` (17588b6).
//
// The web shim localises inventory rows once, at *load* time. A post-load UI
// language switch must therefore re-run the analyzer over the retained save, and
// a *cleared* save must not be resurrected by a later switch.
//
// Runs in jsdom so `window` / `navigator` / `localStorage` / `File` are real.
// `crypto` is stubbed with Node's WebCrypto because jsdom has no SubtleCrypto
// (the shim decrypts via `core/es3Web`). The real-save cases skip when no local
// save is present, matching `test/web/savePipeline.test.ts`.

import { existsSync, readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedInventory } from "../../shared/types";

const SAVE_PATH = join(
  homedir(),
  "AppData",
  "LocalLow",
  "TesseractStudio",
  "TaskBarHero",
  "SaveFile_Live.es3",
);
const hasSave = existsSync(SAVE_PATH);

/** Fresh shim module state (config / runtime / retained save) per test. */
async function installShim() {
  vi.resetModules();
  const dataSource = await import("../../src/web/dataSource");
  dataSource.installWebDataSource();
  const api = await import("../../src/web/webTbhApi");
  api.installWebTbhApi();
  return api;
}

/** The real save, wrapped in the `File` the drop handler would hand the shim. */
function realSave(): File {
  const bytes = readFileSync(SAVE_PATH);
  return new File([bytes], "SaveFile_Live.es3", { lastModified: Date.now() });
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web shim: language change re-resolves the loaded inventory", () => {
  it.skipIf(!hasSave)(
    "re-localizes the loaded rows when the language changes",
    async () => {
      const api = await installShim();
      const inv1 = await api.loadWebSaveFile(realSave());
      expect(inv1).not.toBeNull();
      const namesEn = new Map(inv1!.rows.map((row) => [row.itemKey, row.name]));

      const pushes: ResolvedInventory[] = [];
      window.tbh.onInventory((value) => pushes.push(value));

      const cfg = await window.tbh.saveConfig({ language: "zh-CN" });
      expect(cfg.resolvedLanguage).toBe("zh-CN");

      const inv2 = await window.tbh.getInventory();
      expect(inv2).not.toBeNull();
      // Re-analyzed: a fresh object, and subscribers were notified again.
      expect(inv2).not.toBe(inv1);
      expect(pushes.length).toBeGreaterThan(0);

      // …and the rows actually follow the new language for at least one item.
      expect(inv2!.rows.some((row) => /[\u4e00-\u9fff]/.test(row.name))).toBe(true);
      const relocalized = inv2!.rows.some(
        (row) => namesEn.has(row.itemKey) && namesEn.get(row.itemKey) !== row.name,
      );
      expect(relocalized).toBe(true);
    },
    30000,
  );

  it.skipIf(!hasSave)(
    "does not resurrect a cleared save on a later language change",
    async () => {
      const api = await installShim();
      await api.loadWebSaveFile(realSave());
      api.clearWebSave();
      expect(await window.tbh.getInventory()).toBeNull();

      const pushes: ResolvedInventory[] = [];
      window.tbh.onInventory((value) => pushes.push(value));

      // Switch to a *different* language, so it is the `lastSave === null` guard
      // — not the language-equality short-circuit — that skips re-analysis.
      await window.tbh.saveConfig({ language: "zh-CN" });

      expect(await window.tbh.getInventory()).toBeNull();
      expect(pushes.length).toBe(0);
    },
    30000,
  );

  it.skipIf(!hasSave)(
    "does not re-analyze for a non-language patch",
    async () => {
      const api = await installShim();
      await api.loadWebSaveFile(realSave());
      const before = await window.tbh.getInventory();

      const pushes: ResolvedInventory[] = [];
      window.tbh.onInventory((value) => pushes.push(value));

      await window.tbh.saveConfig({ currency: "EUR" });

      // Strict identity: the same inventory object was kept (no re-analysis).
      expect(await window.tbh.getInventory()).toBe(before);
      expect(pushes.length).toBe(0);
    },
    30000,
  );

  it("resolves (does not throw) when switching language with no save loaded", async () => {
    await installShim();
    await expect(window.tbh.saveConfig({ language: "ja" })).resolves.toBeDefined();
    expect(await window.tbh.getInventory()).toBeNull();
  });

  it("persists the config without the derived resolvedLanguage", async () => {
    const api = await installShim();
    await window.tbh.saveConfig({ language: "zh-CN" });

    const raw = localStorage.getItem("tbh-web-config");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect("resolvedLanguage" in parsed).toBe(false);
    expect(parsed.language).toBe("zh-CN");

    // restoreWebConfig recomputes the derived field instead of trusting disk.
    expect(() => api.restoreWebConfig()).not.toThrow();
    expect((await window.tbh.getConfig()).resolvedLanguage).toBe("zh-CN");
  });
});
