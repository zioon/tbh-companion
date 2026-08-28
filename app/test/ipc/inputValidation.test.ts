import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc";
import { registerMarketHandlers } from "../../src/main/ipc/handlers/market";
import { registerLookupHandlers } from "../../src/main/ipc/handlers/lookup";
import { registerLogHandlers } from "../../src/main/ipc/handlers/log";

/** Minimal ipcMain double recording handle()/on() callbacks. */
function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn as never),
    on: () => {},
  };
}

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    pricesStatus: vi.fn(),
    refreshPrices: vi.fn(),
    refreshItemPrices: vi.fn(),
    cancelPrices: vi.fn(),
    setCurrency: vi.fn(),
    setMarketAutoScanEnabled: vi.fn(),
    getMarketVolume: vi.fn(),
    getMarketVolumeItems: vi.fn(),
    refreshMarketVolumeItems: vi.fn(),
    refreshMarketVolumeItem: vi.fn(),
    exportMarketVolumeHistory: vi.fn(),
    importMarketVolumeHistory: vi.fn(),
    cancelHistoryRefresh: vi.fn(),
    getLookupCatalog: vi.fn(),
    getLookupSources: vi.fn(),
    getLookupSynthesisModel: vi.fn(),
    getOfferings: vi.fn(),
    getLookupPrices: vi.fn(),
    getLookupPricePollStatus: vi.fn(),
    pollLookupPrices: vi.fn(),
    clearDiagnosticLogs: vi.fn(),
    logRendererError: vi.fn(),
    ...overrides,
  };
}

describe("market/volume handler input validation", () => {
  it("SET_CURRENCY ignores non-string input without throwing", () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerMarketHandlers(ipc as never, services as never);
    const result = ipc.handlers.get(IPC.SET_CURRENCY)!(null, 12345);
    expect(result).toBeUndefined();
    expect(services.setCurrency).not.toHaveBeenCalled();
  });

  it("REFRESH_MARKET_VOLUME_ITEM ignores a non-string hash", () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerMarketHandlers(ipc as never, services as never);
    const result = ipc.handlers.get(IPC.REFRESH_MARKET_VOLUME_ITEM)!(null, { evil: true });
    expect(result).toBeUndefined();
    expect(services.refreshMarketVolumeItem).not.toHaveBeenCalled();
  });

  it("REFRESH_MARKET_VOLUME_ITEMS falls back to default (undefined) for a non-string array", () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerMarketHandlers(ipc as never, services as never);
    ipc.handlers.get(IPC.REFRESH_MARKET_VOLUME_ITEMS)!(null, ["good-hash", 42, null]);
    expect(services.refreshMarketVolumeItems).toHaveBeenCalledWith(undefined);
  });

  it("LOOKUP_PRICES_POLL tolerates a missing hash", () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerLookupHandlers(ipc as never, services as never);
    ipc.handlers.get(IPC.LOOKUP_PRICES_POLL)!(null, undefined);
    expect(services.pollLookupPrices).toHaveBeenCalledWith(undefined);
  });

  it("LOG_RENDERER_ERROR ignores a non-object payload", () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerLogHandlers(ipc as never, services as never);
    const result = ipc.handlers.get(IPC.LOG_RENDERER_ERROR)!(null, "garbage");
    expect(result).toBeUndefined();
    expect(services.logRendererError).not.toHaveBeenCalled();
  });
});