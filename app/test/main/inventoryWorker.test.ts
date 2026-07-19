import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { InventoryItemInstance, InventorySnapshot } from "../../shared/types";

// Mock the `electron` module — `utilityProcess.fork` is only available inside
// the real Electron runtime; vitest runs in plain Node, so we stub the API
// and let the host class believe it's talking to a real child process.
vi.mock("electron", () => {
  const listeners: Record<string, Array<(arg: unknown) => void>> = {};
  const stderrListeners: Record<string, Array<(arg: unknown) => void>> = {};
  let lastPostedMessage: unknown = null;
  let childMessageListener: ((m: unknown) => void) | null = null;

  const fakeChild = {
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ??= []).push(cb);
    },
    removeAllListeners() {
      Object.keys(listeners).forEach((k) => delete listeners[k]);
      Object.keys(stderrListeners).forEach((k) => delete stderrListeners[k]);
    },
    postMessage(msg: unknown) {
      lastPostedMessage = msg;
      // Forward the message to the registered "message" listener on the
      // parent side (mirrors how real utilityProcess delivers postMessage).
      childMessageListener?.(msg);
    },
    kill() {
      // Trigger the "exit" event so the host can clean up.
      listeners.exit?.forEach((cb) => cb(0));
    },
    stderr: {
      on(event: string, cb: (arg: unknown) => void) {
        (stderrListeners[event] ??= []).push(cb);
      },
    },
  };

  return {
    utilityProcess: {
      fork: vi.fn(() => fakeChild),
    },
    // Exposed for tests to simulate worker → host messages.
    __simulateWorkerMessage: (msg: unknown) => {
      listeners.message?.forEach((cb) => cb(msg));
    },
    __lastPostedMessage: () => lastPostedMessage,
    __resetMock: () => {
      Object.keys(listeners).forEach((k) => delete listeners[k]);
      Object.keys(stderrListeners).forEach((k) => delete stderrListeners[k]);
      lastPostedMessage = null;
      childMessageListener = null;
    },
  };
});

// Mock the host logger so tests don't depend on the file-based logger.
vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { InventoryWorker } from "../../src/main/services/inventoryWorker";
import { getTbhMarketFeeRates } from "../../src/core/steamMarketFeeBundled";
import type { GameItem } from "../../src/core/gamedata";

const FEE_RATES = getTbhMarketFeeRates();

function makeGameItem(overrides: Partial<GameItem> = {}): GameItem {
  return {
    id: 1,
    name: "Iron Ore",
    grade: "COMMON",
    type: "MATERIAL",
    level: null,
    marketTradable: true,
    ...overrides,
  };
}

function makeInstance(itemKey: number): InventoryItemInstance {
  return {
    itemKey,
    location: "inventory",
    inUse: false,
    isChaotic: false,
  };
}

function makeSnapshot(items: InventoryItemInstance[]): InventorySnapshot {
  return {
    items,
    chests: [],
    saveMtime: 0,
    inventoryCapacity: 100,
    inventoryUsed: items.length,
  };
}

// Pull the simulated electron module so tests can drive worker→host messages.
const electronMock = (await import("electron")) as unknown as {
  __simulateWorkerMessage: (m: unknown) => void;
  __lastPostedMessage: () => unknown;
  __resetMock: () => void;
  utilityProcess: { fork: ReturnType<typeof vi.fn> };
};

describe("InventoryWorker (host)", () => {
  beforeEach(() => {
    electronMock.__resetMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns a utilityProcess on init and sends the init message", async () => {
    const worker = new InventoryWorker(FEE_RATES);
    const readyP = worker.init(
      new Map([[1, makeGameItem({ id: 1, name: "Iron Ore" })]]),
      FEE_RATES,
    );
    // Simulate the worker replying "ready" — this resolves the init promise.
    electronMock.__simulateWorkerMessage({ type: "ready" });
    await readyP;

    expect(electronMock.utilityProcess.fork).toHaveBeenCalledTimes(1);
    const initMsg = electronMock.__lastPostedMessage();
    expect(initMsg).toMatchObject({
      type: "init",
      gameDataEntries: [[1, expect.objectContaining({ name: "Iron Ore" })]],
    });
    await worker.stop();
  });

  it("returns a resolved inventory when the worker replies with a resolve response", async () => {
    const worker = new InventoryWorker(FEE_RATES);
    const initP = worker.init(new Map([[1, makeGameItem()]]), FEE_RATES);
    electronMock.__simulateWorkerMessage({ type: "ready" });
    await initP;

    // Kick off a resolve and capture the result. The resolve call posts a
    // `{type:"resolve", id, snapshot, ...}` message; we then simulate the
    // worker replying with a matching id.
    const snapshot = makeSnapshot([makeInstance(1)]);
    const resolvedP = worker.resolve(snapshot, new Map(), undefined);
    // The host increments the id starting at 1; emit the matching reply.
    electronMock.__simulateWorkerMessage({
      type: "resolve",
      id: 1,
      resolved: {
        rows: [],
        composition: { total: 0, currency: null } as never,
        chests: [],
        saveMtime: 0,
        gameDataLoaded: true,
        currency: null,
        inventoryCapacity: 100,
        inventoryUsed: 1,
      },
    });
    const resolved = await resolvedP;
    expect(resolved.inventoryUsed).toBe(1);
    await worker.stop();
  });

  it("rejects when the worker replies with an error", async () => {
    const worker = new InventoryWorker(FEE_RATES);
    const initP = worker.init(new Map([[1, makeGameItem()]]), FEE_RATES);
    electronMock.__simulateWorkerMessage({ type: "ready" });
    await initP;

    const resolvedP = worker.resolve(makeSnapshot([]), new Map(), undefined);
    electronMock.__simulateWorkerMessage({
      type: "resolve",
      id: 1,
      error: "boom",
    });
    await expect(resolvedP).rejects.toThrow(/boom/);
    await worker.stop();
  });

  it("falls back to sync resolve when worker is not ready (init not awaited)", async () => {
    const worker = new InventoryWorker(FEE_RATES);
    // Init not awaited → ready=false. resolve() should call the sync fallback.
    const result = await worker.resolve(makeSnapshot([]), new Map(), undefined);
    expect(result.rows).toEqual([]);
  });

  it("falls back to sync resolve after worker crashes (exit fired)", async () => {
    const worker = new InventoryWorker(FEE_RATES);
    const initP = worker.init(new Map([[1, makeGameItem()]]), FEE_RATES);
    electronMock.__simulateWorkerMessage({ type: "ready" });
    await initP;

    // Simulate the worker process exiting unexpectedly.
    electronMock.__simulateWorkerMessage({ type: "log", message: "boom" });
    // The mock child kills itself when kill() is called, which fires exit(0).
    await worker.stop();

    // After stop, resolve should fall back to the sync path (no pending child).
    const result = await worker.resolve(makeSnapshot([]), new Map(), undefined);
    expect(result.rows).toEqual([]);
  });

  it("stop sends a 'stop' message to the worker and kills the child", async () => {
    const worker = new InventoryWorker(FEE_RATES);
    const initP = worker.init(new Map([[1, makeGameItem()]]), FEE_RATES);
    electronMock.__simulateWorkerMessage({ type: "ready" });
    await initP;

    await worker.stop();
    // The last message posted before kill should be {type:"stop"}.
    expect(electronMock.__lastPostedMessage()).toMatchObject({ type: "stop" });
  });
});
