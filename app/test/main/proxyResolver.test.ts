import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// electron-log/main pulls in electron's app — stub it so log.ts can load.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/tbh-test", isPackaged: false },
}));

// execSync is mocked per-test via child_process spy.
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

import { execSync } from "node:child_process";
import {
  getProxyDispatcher,
  parseWindowsProxyString,
  readWindowsSystemProxy,
  refreshProxyCache,
  resolveProxyUrl,
} from "../../src/main/services/proxyResolver";

const execSyncMock = vi.mocked(execSync);

const PROXY_ENV_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_VARS) delete process.env[key];
}

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const REG_OUTPUT_ENABLED = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    127.0.0.1:7890",
  "    ProxyOverride    REG_SZ    <local>",
  "",
].join("\r\n");

const REG_OUTPUT_DISABLED = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    ProxyEnable    REG_DWORD    0x0",
  "    ProxyServer    REG_SZ    127.0.0.1:7890",
  "",
].join("\r\n");

const REG_OUTPUT_PER_PROTOCOL = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    http=127.0.0.1:7888;https=127.0.0.1:7890;socks=127.0.0.1:1080",
  "",
].join("\r\n");

describe("parseWindowsProxyString", () => {
  it("normalizes bare host:port to http://", () => {
    expect(parseWindowsProxyString("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });

  it("passes through http(s):// URLs unchanged", () => {
    expect(parseWindowsProxyString("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(parseWindowsProxyString("https://proxy.local:8080")).toBe("https://proxy.local:8080");
  });

  it("prefers https entry from per-protocol format", () => {
    expect(parseWindowsProxyString("http=127.0.0.1:7888;https=127.0.0.1:7890")).toBe(
      "http://127.0.0.1:7890",
    );
  });

  it("falls back to http entry when no https", () => {
    expect(parseWindowsProxyString("http=127.0.0.1:7888")).toBe("http://127.0.0.1:7888");
  });

  it("returns null for socks-only config", () => {
    expect(parseWindowsProxyString("socks=127.0.0.1:1080")).toBeNull();
  });

  it("returns null for empty or whitespace", () => {
    expect(parseWindowsProxyString("")).toBeNull();
    expect(parseWindowsProxyString("   ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseWindowsProxyString("  127.0.0.1:7890  ")).toBe("http://127.0.0.1:7890");
  });
});

describe("readWindowsSystemProxy", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns disabled on non-Windows", () => {
    setPlatform("linux");
    const result = readWindowsSystemProxy();
    expect(result).toEqual({ enabled: false, url: null });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("parses enabled proxy from reg output", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_ENABLED);
    const result = readWindowsSystemProxy();
    expect(result).toEqual({ enabled: true, url: "http://127.0.0.1:7890" });
  });

  it("parses per-protocol proxy (prefers https)", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_PER_PROTOCOL);
    const result = readWindowsSystemProxy();
    expect(result).toEqual({ enabled: true, url: "http://127.0.0.1:7890" });
  });

  it("reports disabled when ProxyEnable is 0x0", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_DISABLED);
    const result = readWindowsSystemProxy();
    expect(result.enabled).toBe(false);
  });

  it("returns disabled when reg query throws", () => {
    setPlatform("win32");
    execSyncMock.mockImplementation(() => {
      throw new Error("reg not found");
    });
    const result = readWindowsSystemProxy();
    expect(result).toEqual({ enabled: false, url: null });
  });
});

describe("resolveProxyUrl / getProxyDispatcher", () => {
  beforeEach(() => {
    clearProxyEnv();
    refreshProxyCache();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    clearProxyEnv();
    refreshProxyCache();
    vi.clearAllMocks();
  });

  it("prefers HTTPS_PROXY env over Windows registry", () => {
    setPlatform("win32");
    process.env.HTTPS_PROXY = "http://env-proxy:9000";
    execSyncMock.mockReturnValue(REG_OUTPUT_ENABLED);
    expect(resolveProxyUrl()).toBe("http://env-proxy:9000");
    // Registry should not be consulted when env var is set.
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to Windows registry when env unset", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_ENABLED);
    expect(resolveProxyUrl()).toBe("http://127.0.0.1:7890");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when registry proxy disabled", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_DISABLED);
    expect(resolveProxyUrl()).toBeNull();
  });

  it("caches the resolved URL across calls", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_ENABLED);
    resolveProxyUrl();
    resolveProxyUrl();
    resolveProxyUrl();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("refreshProxyCache forces re-read", () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue(REG_OUTPUT_ENABLED);
    resolveProxyUrl();
    refreshProxyCache();
    resolveProxyUrl();
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("getProxyDispatcher returns {} when no proxy configured", () => {
    setPlatform("linux");
    expect(getProxyDispatcher()).toEqual({});
  });

  it("getProxyDispatcher returns a dispatcher when proxy is set", () => {
    setPlatform("linux");
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const dispatcher = getProxyDispatcher();
    expect(dispatcher.dispatcher).toBeDefined();
    expect(typeof dispatcher.dispatcher).toBe("object");
  });

  it("getProxyDispatcher caches the dispatcher instance", () => {
    setPlatform("linux");
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const first = getProxyDispatcher();
    const second = getProxyDispatcher();
    expect(second.dispatcher).toBe(first.dispatcher);
  });
});
