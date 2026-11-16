// Resolve an HTTP/HTTPS proxy for Steam market fetches.
//
// undici's fetch (used by main) ignores the OS system proxy — it only reads
// HTTPS_PROXY/HTTP_PROXY env vars. Most Windows users (Clash/V2Ray/SS) set the
// proxy at the system level via the registry, never as env vars, so Steam
// price refreshes fail with "network error or timeout" even though the browser
// can reach steamcommunity.com fine.
//
// This module bridges that gap: resolve a proxy URL from env first, then fall
// back to the Windows Internet Settings registry key, and hand undici a
// ProxyAgent. Results are cached for the process lifetime; call
// refreshProxyCache() after settings change.

import { Dispatcher, getGlobalDispatcher, ProxyAgent } from "undici";
import { execSync } from "node:child_process";
import { createLogger } from "../log";

const log = createLogger("proxy");

export interface DispatcherInit {
  dispatcher?: unknown;
}

// Steam 的社区市场 WAF 按请求头指纹判定客户端：只要同时带上
// accept-encoding / accept-language / sec-fetch-mode 就固定返回 429，响应体是
// "null"，看上去与「真实限流」完全一样（实测 2026-11-16：三者全带 429，
// 只带其中一两个仍 429，全部去掉才 200；换 curl 不带这些头同样 200）。
// undici 的 fetch 会无条件注入这三个头，于是每一轮价格刷新在第一个物品就被
// 判成限流、触发熔断。这里在 dispatch 层剔除，调用方仍可继续用 fetch。
const STEAM_FINGERPRINT_HEADERS = new Set(["accept-encoding", "accept-language", "sec-fetch-mode"]);

function stripFingerprintHeaders(
  headers: Dispatcher.DispatchOptions["headers"],
): Dispatcher.DispatchOptions["headers"] {
  if (!headers) return headers;
  if (Array.isArray(headers)) {
    return headers.filter(([name]) => !STEAM_FINGERPRINT_HEADERS.has(String(name).toLowerCase()));
  }
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (STEAM_FINGERPRINT_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Forwarding dispatcher that drops the browser-like header fingerprint. */
class SteamSafeDispatcher extends Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly ownsInner: boolean,
  ) {
    super();
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.inner.dispatch(
      { ...options, headers: stripFingerprintHeaders(options.headers) },
      handler,
    );
  }

  close(): Promise<void> {
    return this.ownsInner ? this.inner.close() : Promise.resolve();
  }

  destroy(): Promise<void> {
    return this.ownsInner ? this.inner.destroy() : Promise.resolve();
  }
}

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

let cachedProxyUrl: string | null | undefined;
let cachedDispatcher: DispatcherInit | undefined;

/** Normalize a bare "host:port" to a full http:// URL. Pass through http(s)://. */
function normalizeProxyUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/**
 * Parse Windows ProxyServer registry value into a usable proxy URL.
 *
 * Registry formats observed:
 *   - "127.0.0.1:7890"                          (single proxy for all protocols)
 *   - "http=127.0.0.1:7890;https=127.0.0.1:7890" (per-protocol)
 *   - "socks=127.0.0.1:1080"                    (SOCKS only — not usable by undici)
 *
 * Returns the first usable http/https proxy URL, or null when none is suitable.
 */
export function parseWindowsProxyString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes("=")) {
    const parts = trimmed
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const proto of ["https", "http"]) {
      const part = parts.find((p) => p.toLowerCase().startsWith(proto + "="));
      if (part) {
        const url = part.slice(proto.length + 1).trim();
        if (url) return normalizeProxyUrl(url);
      }
    }
    return null;
  }

  return normalizeProxyUrl(trimmed);
}

/**
 * Read the Windows system proxy from the registry (one reg query for the whole
 * Internet Settings key). Returns { enabled, url }. Non-Windows or any failure
 * yields { enabled: false, url: null }.
 */
export function readWindowsSystemProxy(): { enabled: boolean; url: string | null } {
  if (process.platform !== "win32") return { enabled: false, url: null };
  try {
    const out = execSync(`reg query "${REG_KEY}"`, {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
    const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
    const url = m ? parseWindowsProxyString(m[1]) : null;
    return { enabled, url };
  } catch {
    return { enabled: false, url: null };
  }
}

/**
 * Resolve the active proxy URL.
 * Priority: HTTPS_PROXY/HTTP_PROXY env > Windows registry system proxy.
 */
export function resolveProxyUrl(): string | null {
  if (cachedProxyUrl !== undefined) return cachedProxyUrl;

  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (envProxy) {
    cachedProxyUrl = envProxy;
    return envProxy;
  }

  const sys = readWindowsSystemProxy();
  if (sys.enabled && sys.url) {
    log.info(`Using Windows system proxy: ${sys.url}`);
    cachedProxyUrl = sys.url;
    return sys.url;
  }

  cachedProxyUrl = null;
  return null;
}

/** Force re-read on next resolveProxyUrl() / getProxyDispatcher() call. */
export function refreshProxyCache(): void {
  cachedProxyUrl = undefined;
  // Release the previous ProxyAgent's connection pool before discarding the
  // reference — undici keeps persistent connections alive until close().
  const dispatcher = cachedDispatcher?.dispatcher as { close?: () => void } | undefined;
  if (dispatcher && typeof dispatcher.close === "function") {
    try {
      dispatcher.close();
    } catch {
      // already closed
    }
  }
  cachedDispatcher = undefined;
}

/**
 * Build a fetch dispatcher from env or Windows system proxy.
 * Falls back to the global dispatcher when no proxy is configured.
 */
export function getProxyDispatcher(): DispatcherInit {
  if (cachedDispatcher) return cachedDispatcher;
  const proxy = resolveProxyUrl();
  if (!proxy) {
    // Wrapping the global dispatcher keeps direct (non-proxy) fetches free of
    // the fingerprint headers too; it must not be closed on refresh.
    cachedDispatcher = { dispatcher: new SteamSafeDispatcher(getGlobalDispatcher(), false) };
    return cachedDispatcher;
  }
  try {
    cachedDispatcher = { dispatcher: new SteamSafeDispatcher(new ProxyAgent(proxy), true) };
  } catch (err) {
    log.warn(`Failed to create ProxyAgent for ${proxy}: ${(err as Error).message}`);
    cachedDispatcher = { dispatcher: new SteamSafeDispatcher(getGlobalDispatcher(), false) };
  }
  return cachedDispatcher;
}
