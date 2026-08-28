import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  REQUIRED_BUNDLED_DATA_FILES,
  bundledDataCandidates,
  clearBundledJsonCache,
  readBundledJson,
  resolveBundledDataPath,
} from "../../src/core/bundledData";
import { loadBoxTypeCatalog } from "../../src/core/boxes/catalog";

type ProcessWithResources = NodeJS.Process & { resourcesPath?: string };

describe("bundledData paths", () => {
  let tempResources = "";
  let previousResourcesPath: string | undefined;

  beforeEach(() => {
    tempResources = mkdtempSync(join(tmpdir(), "tbh-resources-"));
    previousResourcesPath = (process as ProcessWithResources).resourcesPath;
  });

  afterEach(() => {
    const proc = process as ProcessWithResources;
    if (previousResourcesPath === undefined)
      (proc as { resourcesPath?: string }).resourcesPath = undefined;
    else proc.resourcesPath = previousResourcesPath;
    rmSync(tempResources, { recursive: true, force: true });
    // The read cache is keyed only by filename, but resolveBundledDataPath is
    // resourcesPath/userData sensitive — clear between tests so a resource
    // written into one test's tempResources doesn't leak into the next.
    clearBundledJsonCache();
  });

  it("lists process.resourcesPath first when packaged", () => {
    (process as ProcessWithResources).resourcesPath = tempResources;
    const candidates = bundledDataCandidates("box_types.json");
    expect(candidates[0]).toBe(join(tempResources, "data", "box_types.json"));
  });

  it("resolves from resourcesPath/data in a packaged layout", () => {
    (process as ProcessWithResources).resourcesPath = tempResources;
    const dataDir = join(tempResources, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "box_types.json"), JSON.stringify({ types: [] }));

    const resolved = resolveBundledDataPath("box_types.json");
    expect(resolved).toBe(join(dataDir, "box_types.json"));
    expect(readBundledJson<{ types: unknown[] }>("box_types.json")).toEqual({ types: [] });
  });

  it("loads every required bundled file from the repo in dev", () => {
    (process as { resourcesPath?: string }).resourcesPath = undefined;
    for (const file of REQUIRED_BUNDLED_DATA_FILES) {
      expect(() => resolveBundledDataPath(file)).not.toThrow();
      expect(readBundledJson(file)).toBeTruthy();
    }
  });

  it("throws with tried paths when a file is missing", () => {
    (process as { resourcesPath?: string }).resourcesPath = undefined;
    expect(() => resolveBundledDataPath("missing-file.json")).toThrow(/Tried:/);
  });

  it("puts userDataDir first when provided", () => {
    (process as ProcessWithResources).resourcesPath = tempResources;
    const candidates = bundledDataCandidates("gamedata.json", "/custom/userData");
    expect(candidates[0]).toBe(join("/custom/userData", "gamedata.json"));
    // resourcesPath should still be second
    expect(candidates[1]).toBe(join(tempResources, "data", "gamedata.json"));
  });

  it("omits userData entry when userDataDir is undefined", () => {
    (process as ProcessWithResources).resourcesPath = tempResources;
    const candidates = bundledDataCandidates("gamedata.json");
    expect(candidates[0]).toBe(join(tempResources, "data", "gamedata.json"));
    expect(candidates.some((c) => c.includes("userData"))).toBe(false);
  });

  it("caches reads and re-reads only after explicit invalidation", () => {
    (process as ProcessWithResources).resourcesPath = tempResources;
    const dataDir = join(tempResources, "data");
    mkdirSync(dataDir, { recursive: true });
    const target = join(dataDir, "cached_extra.json");
    writeFileSync(target, JSON.stringify({ version: 1 }));

    // First read populates the module-level cache.
    expect(readBundledJson<{ version: number }>("cached_extra.json")).toEqual({ version: 1 });

    // Overwriting the file must not change a cached read.
    writeFileSync(target, JSON.stringify({ version: 2 }));
    expect(readBundledJson<{ version: number }>("cached_extra.json")).toEqual({ version: 1 });

    // Explicit invalidation (used by catalog refresh) re-reads from disk.
    clearBundledJsonCache();
    expect(readBundledJson<{ version: number }>("cached_extra.json")).toEqual({ version: 2 });
  });
});

describe("box catalogs use packaged data resolver", () => {
  it("loadBoxTypeCatalog reads bundled box_types.json", () => {
    const catalog = loadBoxTypeCatalog();
    expect(catalog.types.length).toBeGreaterThan(0);
  });
});
