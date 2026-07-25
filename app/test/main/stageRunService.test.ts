import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../src/main/services/broadcast", () => ({
  broadcast: vi.fn(),
}));

let userDataDir = "";

describe("StageRunService", () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "tbh-stage-runs-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  async function loadService(initialCatalog?: LocaleCatalog) {
    const { StageRunService } = await import("../../src/main/services/StageRunService");
    return new StageRunService(initialCatalog);
  }

  it("starts with no history on first run", async () => {
    const svc = await loadService();
    expect(svc.getStats().history).toEqual([]);
  });

  it("records a clear and reports it via getStats", async () => {
    const svc = await loadService();
    svc.recordClear(2305, 85, 400, 12_000);

    const stats = svc.getStats();
    expect(stats.history).toHaveLength(1);
    expect(stats.history[0]).toMatchObject({
      stageKey: 2305,
      clearTimeSec: 85,
      xpGained: 400,
      goldGained: 12_000,
    });
  });

  it("persists history to disk and reloads it on next construction", async () => {
    const first = await loadService();
    first.recordClear(2305, 85, 400, 12_000);
    first.recordClear(2305, 63, 500, 15_000);

    const raw = JSON.parse(readFileSync(join(userDataDir, "stage_run_history.json"), "utf-8"));
    expect(raw.history).toHaveLength(2);

    vi.resetModules();
    const second = await loadService();
    expect(second.getStats().history).toHaveLength(2);
    expect(second.getStats().history[0]).toMatchObject({ clearTimeSec: 63, xpGained: 500 });
  });

  it("resetStorage clears in-memory history", async () => {
    const svc = await loadService();
    svc.recordClear(2305, 85, 400, 12_000);
    svc.resetStorage();
    expect(svc.getStats().history).toEqual([]);
  });
});

describe("StageRunService with LocaleCatalog", () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "tbh-stage-runs-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  async function loadService(initialCatalog?: LocaleCatalog) {
    const { StageRunService } = await import("../../src/main/services/StageRunService");
    return new StageRunService(initialCatalog);
  }

  it("has setLocaleCatalog method", async () => {
    const svc = await loadService();
    expect(typeof svc.setLocaleCatalog).toBe("function");
  });

  it("defaults to emptyLocaleCatalog when no catalog is provided", async () => {
    const svc = await loadService();
    svc.recordClear(2305, 85, 400, 12_000);

    const stats = svc.getStats();
    expect(stats.history).toHaveLength(1);
    // No catalog → English fallback. 2305 = difficulty 2 (Nightmare), act 3, stage 5.
    expect(stats.history[0].stageName).toBe("Nightmare 3-5");
  });

  it("uses catalog to localize stageName in entries", async () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "1305": "牧场" },
    };
    const svc = await loadService(catalog);
    svc.recordClear(2305, 85, 400, 12_000);

    const stats = svc.getStats();
    expect(stats.history).toHaveLength(1);
    expect(stats.history[0].stageName).toBe("牧场");
  });

  it("setLocaleCatalog swaps the catalog used by getStats", async () => {
    const svc = await loadService();
    svc.recordClear(2305, 85, 400, 12_000);

    // Initially empty catalog → English fallback.
    expect(svc.getStats().history[0].stageName).toBe("Nightmare 3-5");

    // Swap to a catalog that localizes stage 1305 → "牧场".
    const zhCatalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "1305": "牧场" },
    };
    svc.setLocaleCatalog(zhCatalog);

    // getStats recomputes stageName from the current catalog, so the swap is
    // reflected without re-recording the clear.
    expect(svc.getStats().history[0].stageName).toBe("牧场");
  });

  it("does not persist stageName to disk (recomputed from stageKey on load)", async () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "1305": "牧场" },
    };
    const first = await loadService(catalog);
    first.recordClear(2305, 85, 400, 12_000);

    const raw = JSON.parse(readFileSync(join(userDataDir, "stage_run_history.json"), "utf-8"));
    // The persisted snapshot should NOT carry stageName — getStats recomputes
    // it on every call, so storing it would only invite staleness on language
    // switch.
    expect(raw.history[0].stageName).toBeUndefined();

    // Reloading without a catalog still yields a stageName (English fallback),
    // proving stageName is derived from stageKey + active catalog at read time.
    vi.resetModules();
    const second = await loadService();
    expect(second.getStats().history[0].stageName).toBe("Nightmare 3-5");
  });
});
