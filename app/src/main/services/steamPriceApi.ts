import { currencyCode, parseMoney } from "../../core/steamPrice";
import type { PriceHistoryPoint } from "../../core/marketVolume";
import type { PriceEntry } from "./priceCache";
import { getProxyDispatcher } from "./proxyResolver";
import { parseRetryAfterMs } from "./retryAfter";

const APP_ID = 3678970;
const PRICEOVERVIEW = "https://steamcommunity.com/market/priceoverview/";
const PRICEHISTORY = "https://steamcommunity.com/market/pricehistory/";

export type SteamPriceFailReason =
  | "network"
  | "http"
  | "unauthorized"
  | "no_listing"
  | "no_sell_price"
  | "parse";

export type SteamPriceFetchResult =
  | { ok: true; status: number; entry: PriceEntry }
  | {
      ok: false;
      status: number;
      reason: SteamPriceFailReason;
      entry?: PriceEntry;
      retryAfterMs?: number;
    };

export function describeSteamPriceFailure(
  result: Extract<SteamPriceFetchResult, { ok: false }>,
): string {
  switch (result.reason) {
    case "network":
      return "network error or timeout";
    case "http":
      return `HTTP ${result.status}`;
    case "unauthorized":
      return "HTTP 400 unauthorized (Cookie 失效/未登录)";
    case "no_listing":
      return "no Steam market listing (success=false)";
    case "no_sell_price":
      return "no median or lowest sell price in response";
    case "parse":
      return "unexpected pricehistory payload";
  }
}

function entryHasSellPrice(entry: PriceEntry): boolean {
  return entry.median != null || entry.lowest != null;
}

export async function fetchSteamPrice(
  name: string,
  currency: string,
): Promise<SteamPriceFetchResult> {
  const url =
    `${PRICEOVERVIEW}?appid=${APP_ID}&currency=${currencyCode(currency)}` +
    `&market_hash_name=${encodeURIComponent(name)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (TBH Companion)" },
      signal: AbortSignal.timeout(30_000),
      ...getProxyDispatcher(),
    });
  } catch {
    return { ok: false, status: 0, reason: "network" };
  }
  if (!res.ok) {
    return res.status === 429
      ? { ok: false, status: res.status, reason: "http", retryAfterMs: parseRetryAfterMs(res) }
      : { ok: false, status: res.status, reason: "http" };
  }

  const fetchedUtc = new Date().toISOString();
  const data = (await res.json()) as {
    success?: boolean;
    lowest_price?: string;
    median_price?: string;
    volume?: string;
  };
  if (!data.success) {
    return {
      ok: false,
      status: res.status,
      reason: "no_listing",
      entry: buildEntry(data, fetchedUtc),
    };
  }

  const entry = buildEntry(data, fetchedUtc);
  if (!entryHasSellPrice(entry)) {
    return { ok: false, status: res.status, reason: "no_sell_price", entry };
  }

  return { ok: true, status: res.status, entry };
}

function buildEntry(
  data: { lowest_price?: string; median_price?: string; volume?: string },
  fetchedUtc: string,
): PriceEntry {
  return {
    lowest: parseMoney(data.lowest_price),
    median: parseMoney(data.median_price),
    volume: data.volume ? Number(data.volume.replace(/[^0-9]/g, "")) : 0,
    rawLowest: data.lowest_price ?? null,
    rawMedian: data.median_price ?? null,
    fetchedUtc,
    buyOrder: null,
    rawBuyOrder: null,
  };
}

export type SteamPriceHistoryResult =
  | { ok: true; status: number; points: PriceHistoryPoint[] }
  | { ok: false; status: number; reason: SteamPriceFailReason; retryAfterMs?: number };

/** 英文月份缩写 -> 月份索引（0 起）。用于解析 pricehistory 的格式化时间字符串。 */
const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * 解析 pricehistory 第 0 列的时间戳为 epoch 秒（UTC）。
 *
 * Steam 的 `prices` 每行第 0 列可能是数字 epoch 秒，也可能是格式化时间字符串
 * 如 `"May 27 2026 01: +0"`（UTC，后缀 `+0` 表示零时区偏差）。字符串按 UTC 解析，
 * 得到的是绝对时间戳，聚合/展示时再由调用方按本地时区换算。
 *
 * @returns epoch 秒（UTC）；无法解析时返回 `NaN`。
 */
export function parsePriceHistoryTimestamp(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value !== "string") return NaN;
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):/.exec(value.trim());
  if (!m) return NaN;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  if (month === undefined) return NaN;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  return Date.UTC(year, month, day, hour) / 1000;
}

/**
 * 拉取单个物品的历史价格/成交量（Steam `/market/pricehistory`）。
 *
 * 返回 `prices: [[epochSec, "price", volume], ...]`，活跃物品节点约小时粒度。
 * Steam 会在响应正文前添加 `\n<数字>\n` 垃圾前缀，需先剥离再解析。
 *
 * @param name Steam market_hash_name。
 * @param currency 目标货币 ISO 码。
 * @param cookie 可选：用户填写的 Steam 社区 Cookie（完整 Cookie 头字符串）。
 *   Steam 的 pricehistory 未登录会返回 400 空数据，带上登录 Cookie 才能拿到
 *   真实历史成交额。为空时不带 Cookie 头（保持现状，回退到采样走势）。
 */
export async function fetchSteamPriceHistory(
  name: string,
  currency: string,
  cookie = "",
): Promise<SteamPriceHistoryResult> {
  const url =
    `${PRICEHISTORY}?appid=${APP_ID}&currency=${currencyCode(currency)}` +
    `&market_hash_name=${encodeURIComponent(name)}`;
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (TBH Companion)" };
  if (cookie) headers.Cookie = cookie;
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
      ...getProxyDispatcher(),
    });
  } catch {
    return { ok: false, status: 0, reason: "network" };
  }
  if (!res.ok) {
    // 400 = 未登录 / Cookie 失效：Steam pricehistory 在无有效登录 Cookie 时返回
    // HTTP 400 且响应体无数据节点。归类为 unauthorized，供上层识别并终止价格刷新。
    if (res.status === 400) {
      return { ok: false, status: res.status, reason: "unauthorized" };
    }
    return res.status === 429
      ? { ok: false, status: res.status, reason: "http", retryAfterMs: parseRetryAfterMs(res) }
      : { ok: false, status: res.status, reason: "http" };
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, status: res.status, reason: "network" };
  }

  // 剥离 Steam 的防爬垃圾前缀（`\n<数字>\n`），从第一个 `{` 开始解析。
  const brace = text.indexOf("{");
  const json = brace >= 0 ? text.slice(brace) : text;
  let data: {
    success?: boolean;
    prices?: Array<[number | string, string, number | string]>;
  };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return { ok: false, status: res.status, reason: "parse" };
  }

  if (!data.success || !Array.isArray(data.prices)) {
    return { ok: false, status: res.status, reason: "no_listing" };
  }

  const points: PriceHistoryPoint[] = [];
  for (const row of data.prices) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const ts = parsePriceHistoryTimestamp(row[0]);
    // pricehistory 的价格列是纯数字（如 0.461），不是本地化格式字符串；
    // 数字直接透传，避免 parseMoney 把 "0.461" 误判为 3 位千分组。
    const price = typeof row[1] === "number" ? row[1] : parseMoney(`${row[1]}`);
    const volume = Number(row[2]);
    if (!Number.isFinite(ts) || price == null || !Number.isFinite(volume) || volume <= 0) continue;
    points.push({ timestamp: ts, price, volume });
  }

  return { ok: true, status: res.status, points };
}
