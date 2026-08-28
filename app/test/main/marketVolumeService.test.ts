// MarketVolumeService 持久化测试：验证「保存 → 读取」往返、数据累积、
// 采样去抖与损坏文件的恢复。使用真实临时目录，不 mock node:fs。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LookupItem, MarketVolumeItem } from "../../shared/types";
import {
  MARKET_VOLUME_FILE,
  MarketVolumeService,
  hasVolumeData,
  type PriceHistoryResultLike,
} from "../../src/main/services/MarketVolumeService";

/** 真实 epoch 基准时间（10:00:00 UTC），避免被 60s 采样去抖误判。 */
const BASE = Date.UTC(2026, 7, 7, 10, 0, 0);

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "market-volume-"));
  file = join(dir, MARKET_VOLUME_FILE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeService(
  overrides: {
    targetHashes?: string[];
    cookie?: string;
    currency?: string;
    fetchHistory?: (
      hash: string,
      currency: string,
      cookie?: string,
    ) => Promise<PriceHistoryResultLike>;
    fetchAnchorMedian?: (hash: string, currency: string) => Promise<number | null>;
    onHistoryProgress?: (p: {
      running: boolean;
      total: number;
      done: number;
      current: string | null;
      updatedItem?: MarketVolumeItem;
      pending?: MarketVolumeItem[];
      cookieExpired?: boolean;
    }) => void;
  } = {},
) {
  const catalog: LookupItem[] = [];
  return new MarketVolumeService({
    getCatalog: () => catalog,
    getCurrency: () => overrides.currency ?? "USD",
    getCookie: () => overrides.cookie ?? "",
    getTargetHashes: () => overrides.targetHashes ?? [],
    getHistoryBatchSize: () => 10,
    getHistoryBatchDelaySec: () => 0,
    filePath: () => file,
    fetchHistory: overrides.fetchHistory,
    fetchAnchorMedian: overrides.fetchAnchorMedian,
    onHistoryProgress: overrides.onHistoryProgress,
  });
}

describe("MarketVolumeService 历史价格货币换算", () => {
  it("pricehistory 货币与显示货币不一致时，按 median 锚等比换算后入库", async () => {
    const svc = makeService({
      currency: "CNY",
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        currency: "BRL",
        points: [
          { timestamp: BASE / 1000, price: 0.5, volume: 100 },
          { timestamp: (BASE + 3600_000) / 1000, price: 1.452, volume: 46 },
        ],
      }),
      fetchAnchorMedian: async () => 1.91,
    });
    await svc.refreshHistory(BASE);
    const ph = svc.getPriceHistory()["Copper Coin"];
    // 源点 1.452（R$）应换算为锚中位价 1.91（CNY）；早期点等比放大
    expect(ph[1].price).toBeCloseTo(1.91, 6);
    expect(ph[0].price).toBeCloseTo(0.5 * (1.91 / 1.452), 6);
  });

  it("pricehistory 货币与显示货币一致时不换算", async () => {
    const svc = makeService({
      currency: "USD",
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        currency: "USD",
        points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
      }),
      fetchAnchorMedian: async () => 0.5,
    });
    await svc.refreshHistory(BASE);
    expect(svc.getPriceHistory()["Copper Coin"][0].price).toBe(0.5);
  });

  it("pricehistory 货币解析不出（null）时保持原样，不换算", async () => {
    const svc = makeService({
      currency: "CNY",
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        currency: null,
        points: [{ timestamp: BASE / 1000, price: 0.55, volume: 100 }],
      }),
      fetchAnchorMedian: async () => 1.91,
    });
    await svc.refreshHistory(BASE);
    expect(svc.getPriceHistory()["Copper Coin"][0].price).toBe(0.55);
  });
});

describe("MarketVolumeService 持久化", () => {
  it("sampleNow 落盘、新实例可从磁盘读回相同的交易额统计", () => {
    // 首次采样（t0）
    const svc = makeService();
    svc.recordVolume("Copper Coin", 100, 0.5, "USD");
    svc.recordVolume("Sword (Legendary) A", 10, 2, "USD");
    const sample = svc.sampleNow(BASE);
    expect(sample).not.toBeNull();
    expect(sample!.total).toBe(100 * 0.5 + 10 * 2);

    // 文件已写入
    expect(existsSync(file)).toBe(true);

    // 新实例从磁盘读取，latest 与首次采样一致
    const reloaded = makeService();
    const stats = reloaded.getStats();
    expect(stats.latest?.total).toBe(sample!.total);
    expect(stats.latest?.timestamp).toBe(sample!.timestamp);
    expect(stats.latest?.currency).toBe("USD");
    expect(stats.currency).toBe("USD");
  });

  it("pricehistory 历史数据可持久化并在新实例读回（跨实例往返）", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [
          { timestamp: BASE / 1000, price: 0.5, volume: 100 },
          { timestamp: (BASE + 3600_000) / 1000, price: 0.6, volume: 200 },
        ],
      }),
    });
    expect(await svc.refreshHistory(BASE)).toBe(true);
    expect(svc.getStats().hourly.length).toBeGreaterThan(0);

    // 新实例从磁盘读回相同的小时走势
    const reloaded = makeService();
    expect(reloaded.getStats().hourly).toEqual(svc.getStats().hourly);
  });

  it("原始 pricehistory 点被持久化并在新实例读回（跨实例往返）", async () => {
    const points = [
      { timestamp: BASE / 1000, price: 0.5, volume: 100 },
      { timestamp: (BASE + 3600_000) / 1000, price: 0.6, volume: 200 },
    ];
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({ ok: true, status: 200, points }),
    });
    await svc.refreshHistory(BASE);
    expect(svc.getPriceHistory()["Copper Coin"]).toEqual(points);

    // 新实例从磁盘读回相同的原始点
    const reloaded = makeService();
    expect(reloaded.getPriceHistory()["Copper Coin"]).toEqual(points);
  });

  it("聚合保留全部小时桶，不按 14 天截断（全量走势）", async () => {
    // 构造跨 30 天、每天一小时的点（远超旧 336 小时上限）
    const points = Array.from({ length: 30 * 24 }, (_, i) => ({
      timestamp: (BASE - i * 3600_000) / 1000,
      price: 1,
      volume: 1,
    }));
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({ ok: true, status: 200, points }),
    });
    await svc.refreshHistory(BASE);
    expect(svc.getStats().hourly.length).toBe(30 * 24);
  });

  it("刷新成功后 historyFetchedAtMs 落盘，重启后在 60min 内不再重拉（跨实例命中缓存）", async () => {
    let fetchCount = 0;
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
        };
      },
    });
    // 首次刷新触发拉取
    expect(await svc.refreshHistory(BASE)).toBe(true);
    expect(fetchCount).toBe(1);

    // 新实例（模拟重启）从磁盘读回 historyFetchedAtMs，仍在 60min 缓存内 → 不重拉
    const reloaded = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
        };
      },
    });
    expect(await reloaded.refreshHistory(BASE + 20 * 60_000)).toBe(false);
    expect(fetchCount).toBe(1); // 未发出新请求
  });

  it("刷新失败（无数据）时不清空已有历史，且返回 false", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
      }),
    });
    expect(await svc.refreshHistory(BASE)).toBe(true);
    const before = svc.getStats().hourly;
    expect(before.length).toBeGreaterThan(0);

    // 第二次：超过 60min 缓存触发拉取，但拉不到数据（空 points）→ 不覆盖已有数据
    const svc2 = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({ ok: true, status: 200, points: [] }),
    });
    expect(await svc2.refreshHistory(BASE + 61 * 60_000)).toBe(false);
    expect(svc2.getStats().hourly).toEqual(before);
  });

  it("historyHourly 为空时回退到采样快照构建走势", () => {
    const svc = makeService();
    svc.recordVolume("Copper Coin", 100, 0.5, "USD");
    svc.sampleNow(BASE);
    const stats = svc.getStats();
    expect(stats.hourly.length).toBeGreaterThan(0);
    expect(stats.hourly[0].total).toBe(50);
    expect(stats.latest?.items).toBe(1);
  });

  it("refreshHistory 把用户 Cookie 透传给 fetchHistory", async () => {
    const received: string[] = [];
    const svc = makeService({
      cookie: "sessionid=abc; steamLoginSecure=xyz",
      targetHashes: ["Copper Coin"],
      fetchHistory: async (_hash, _currency, cookie) => {
        received.push(cookie ?? "");
        return { ok: true, status: 200, points: [] };
      },
    });
    await svc.refreshHistory(BASE);
    expect(received).toEqual(["sessionid=abc; steamLoginSecure=xyz"]);
  });

  it("refreshHistory 支持自定义 targets 覆盖默认目标集（交易页刷新用）", async () => {
    const fetched: string[] = [];
    const svc = makeService({
      targetHashes: ["Default Only"],
      fetchHistory: async (hash) => {
        fetched.push(hash);
        return { ok: true, status: 200, points: [{ timestamp: BASE / 1000, price: 1, volume: 1 }] };
      },
    });
    // 传入 targets 覆盖 getTargetHashes() 的默认集合
    await svc.refreshHistory(BASE, { targets: ["Custom A", "Custom B"] });
    expect(fetched).toEqual(["Custom A", "Custom B"]);
  });

  it("refreshHistory force=true 绕过 60min 缓存立即重拉", async () => {
    let fetchCount = 0;
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
        };
      },
    });
    // 首次刷新
    expect(await svc.refreshHistory(BASE)).toBe(true);
    expect(fetchCount).toBe(1);
    // 未过期的自动刷新被缓存拦截
    expect(await svc.refreshHistory(BASE + 10 * 60_000)).toBe(false);
    expect(fetchCount).toBe(1);
    // force=true 绕过缓存，立即重拉
    expect(await svc.refreshHistory(BASE + 11 * 60_000, { force: true })).toBe(true);
    expect(fetchCount).toBe(2);
  });

  it("采样去抖：1 分钟内重复 sampleNow 返回 null 且不落盘", () => {
    const svc = makeService();
    svc.recordVolume("Copper Coin", 100, 1, "USD");
    expect(svc.sampleNow(BASE)).not.toBeNull();
    expect(svc.sampleNow(BASE + 1_000)).toBeNull(); // 1 秒后被拦截
    expect(svc.sampleNow(BASE + 59_000)).toBeNull(); // 59s 仍被拦截
    expect(svc.sampleNow(BASE + 60_000)).not.toBeNull(); // 恰好 60s（边界含 60s）可采样
    expect(svc.sampleNow(BASE + 61_000)).toBeNull(); // 61s，距上次 1s 又被拦截
  });

  it("损坏的历史文件在加载时被清空而不抛错", () => {
    writeFileSync(file, "{not json");
    const svc = makeService();
    expect(svc.getStats().latest).toBeNull();
    expect(svc.getStats().hourly).toEqual([]);
  });

  it("hasVolumeData 仅在存在有效交易额时返回 true", () => {
    expect(hasVolumeData(null)).toBe(false);
    expect(
      hasVolumeData({ timestamp: "t", items: 0, total: 0, byCategory: {}, currency: "USD" }),
    ).toBe(false);
    expect(
      hasVolumeData({
        timestamp: "t",
        items: 1,
        total: 5,
        byCategory: { WEAPON: 5 },
        currency: "USD",
      }),
    ).toBe(true);
  });

  it("buildPendingItems 为待刷新目标生成占位卡片（total=0、points=[]，未命中图鉴回退 hash）", () => {
    const svc = makeService();
    // 空 catalog：未命中图鉴 → name 回退 hash、category 回退 OTHER
    const pending = svc.buildPendingItems(["Copper Coin", "Sword (Legendary) A", "Copper Coin"]);
    expect(pending).toHaveLength(2); // 去重
    expect(pending[0]).toEqual({
      hash: "Copper Coin",
      name: "Copper Coin",
      category: "OTHER",
      level: null,
      gearType: null,
      materialType: null,
      total: 0,
      points: [],
    });
    // 保持输入顺序（去重后）
    expect(pending[1].hash).toBe("Sword (Legendary) A");
  });

  it("buildPendingItems 复用已有 pricehistory 生成带走势的卡片而非空白占位", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A"],
      fetchHistory: async (_hash) => ({
        ok: true,
        status: 200,
        points: [
          { timestamp: BASE / 1000, price: 0.5, volume: 100 },
          { timestamp: BASE / 1000 - 3600, price: 0.4, volume: 50 },
        ],
      }),
    });
    // 先拉一次历史，让 priceHistory 有数据
    await svc.refreshHistory(BASE);

    const pending = svc.buildPendingItems(["Copper Coin", "Sword (Legendary) A"]);
    // 已有历史 → 占位卡片带总交易额与小时走势（非 total=0 / points=[]）
    expect(pending[0].total).toBeGreaterThan(0);
    expect(pending[0].points.length).toBeGreaterThan(0);
    expect(pending[1].total).toBeGreaterThan(0);
    expect(pending[1].points.length).toBeGreaterThan(0);
  });

  it("buildPendingItems 无历史数据时仍回退为空白占位", async () => {
    const svc = makeService();
    const pending = svc.buildPendingItems(["Copper Coin"]);
    expect(pending[0]).toEqual({
      hash: "Copper Coin",
      name: "Copper Coin",
      category: "OTHER",
      level: null,
      gearType: null,
      materialType: null,
      total: 0,
      points: [],
    });
  });

  it("buildPendingItems 复用 live 快照数据生成带金额的卡片（非空白占位）", () => {
    const svc = makeService();
    // 仅累积 live 快照（无 pricehistory），buildPendingItems 也应复用该数据，
    // 避免待刷新物品在刷新期间显示为空白占位。
    svc.recordVolume("Copper Coin", 100, 0.5, "USD");

    const pending = svc.buildPendingItems(["Copper Coin"]);
    expect(pending).toHaveLength(1);
    expect(pending[0].hash).toBe("Copper Coin");
    expect(pending[0].total).toBeGreaterThan(0); // 100 × 0.5 = 50
  });

  it("sortTargetsByVolume 按最近24h交易额降序、无交易额数据排最后且保持相对顺序", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A"],
      fetchHistory: async (hash) => ({
        ok: true,
        status: 200,
        points: [
          // 用「当前时间附近」的时间戳，确保落在最近 24h 窗口内被计入排序口径。
          ...(hash === "Copper Coin"
            ? [{ timestamp: Math.floor(Date.now() / 1000), price: 0.5, volume: 100 }]
            : [{ timestamp: Math.floor(Date.now() / 1000), price: 2, volume: 50 }]),
        ],
      }),
    });
    // 先拉一次历史，让 priceHistory 有交易额数据（自动路径冷启动→全量拉取）。
    await svc.refreshHistory(Date.now());

    // 目标集含一个无交易额数据的 hash（Non Listed），应排最后
    const ordered = svc.sortTargetsByVolume(["Non Listed", "Copper Coin", "Sword (Legendary) A"]);
    // 最近24h内：Copper Coin = 100*0.5 = 50；Sword = 50*2 = 100 > Copper → 降序
    expect(ordered[0]).toBe("Sword (Legendary) A");
    expect(ordered[1]).toBe("Copper Coin");
    expect(ordered[2]).toBe("Non Listed");
  });

  it("sortTargetsByVolume 无任何交易额数据时保持原顺序", () => {
    const svc = makeService();
    expect(svc.sortTargetsByVolume(["B", "A", "C"])).toEqual(["B", "A", "C"]);
  });

  it("refreshHistory 通过 onHistoryProgress 上报刷新开始(含 pending)/每个物品/结束的进度", async () => {
    const calls: {
      running: boolean;
      done: number;
      current: string | null;
      pending?: MarketVolumeItem[];
    }[] = [];
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
      }),
      onHistoryProgress: (p) =>
        calls.push({ running: p.running, done: p.done, current: p.current, pending: p.pending }),
    });
    await svc.refreshHistory(BASE);

    // 第一条：刷新开始，携带待刷新占位卡片（自动/手动刷新共用，驱动亮环），current=null
    expect(calls[0]).toMatchObject({ running: true, done: 0, current: null });
    expect(calls[0].pending).toHaveLength(2);
    // 后续：每个目标一次「开始(携带 hash)」+ 一次「完成(hash=null)」，最后一条 running=false
    expect(calls[1]).toMatchObject({ running: true, done: 0, current: "Copper Coin" });
    expect(calls[2]).toMatchObject({ running: true, done: 1, current: null });
    expect(calls[3]).toMatchObject({ running: true, done: 1, current: "Sword (Legendary) A" });
    expect(calls[4]).toMatchObject({ running: true, done: 2, current: null });
    expect(calls[calls.length - 1]).toMatchObject({ running: false, done: 2, current: null });
  });

  it("refreshHistory 每完成一个物品实时推送该物品最新卡片，并实时写入内存态", async () => {
    const seen: (MarketVolumeItem | undefined)[] = [];
    let priceHistoryHadDataDuringRefresh = false;
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [
          { timestamp: BASE / 1000, price: 0.5, volume: 100 },
          { timestamp: BASE / 1000 - 3600, price: 0.4, volume: 50 },
        ],
      }),
      onHistoryProgress: (p) => {
        seen.push(p.updatedItem);
        // 第一个物品完成时，内存 priceHistory 应已实时写入该 hash
        if (p.done === 1) {
          priceHistoryHadDataDuringRefresh = Object.keys(svc.getPriceHistory()).length > 0;
        }
      },
    });
    await svc.refreshHistory(BASE);

    // 两个物品都完成 → 各携带一次带走势的最新卡片（非空白占位）
    const completed = seen.filter((it) => it && it.points.length > 0);
    expect(completed.length).toBe(2);
    expect(completed[0]!.total).toBeGreaterThan(0);
    expect(priceHistoryHadDataDuringRefresh).toBe(true);
  });

  it("refreshHistory 每个成功物品并入后实时重算顶部走势（getStats().hourly 立即反映）", async () => {
    const seenTrendOnFirstDone: { hourlyLen: number; firstHour: number }[] = [];
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A"],
      fetchHistory: async (hash) => {
        // 第一个物品带更早的历史点（扩展走势时间范围），第二个物品稍晚
        const ts = hash === "Copper Coin" ? BASE / 1000 - 48 * 3600 : BASE / 1000 - 3600;
        return {
          ok: true,
          status: 200,
          points: [{ timestamp: ts, price: 0.5, volume: 100 }],
        };
      },
      onHistoryProgress: (p) => {
        // 第一个物品完成（done=1）时，顶部走势应已实时包含该物品的早间历史点
        if (p.done === 1 && p.current === null) {
          const stats = svc.getStats();
          seenTrendOnFirstDone.push({
            hourlyLen: stats.hourly.length,
            firstHour: stats.hourly[0]?.hour ? new Date(stats.hourly[0]!.hour).getTime() : 0,
          });
        }
      },
    });
    await svc.refreshHistory(BASE);

    // 第一个物品完成时顶部走势已重算：非空，且时间范围已延伸到 48 小时前
    expect(seenTrendOnFirstDone).toHaveLength(1);
    const { hourlyLen, firstHour } = seenTrendOnFirstDone[0]!;
    expect(hourlyLen).toBeGreaterThan(0);
    expect(firstHour).toBe((Math.floor(BASE / 1000 / 3600) - 48) * 3600 * 1000);
  });

  it("refreshHistory 检测到 400（Cookie 失效）时终止刷新并通过 cookieExpired 上报", async () => {
    const calls: {
      running: boolean;
      done: number;
      cookieExpired?: boolean;
    }[] = [];
    // 第一批第一个目标即返回 400，后续目标不应再被请求（刷新被终止）。
    const fetched: string[] = [];
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A", "Iron Ingot"],
      fetchHistory: async (hash) => {
        fetched.push(hash);
        if (hash === "Copper Coin") {
          return { ok: false, status: 400, reason: "unauthorized" };
        }
        return {
          ok: true,
          status: 200,
          points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
        };
      },
      onHistoryProgress: (p) =>
        calls.push({ running: p.running, done: p.done, cookieExpired: p.cookieExpired }),
    });
    await svc.refreshHistory(BASE);

    // 只拉取了首个目标，且刷新已被提前终止
    expect(fetched).toEqual(["Copper Coin"]);
    // 结束进度带 cookieExpired=true，running=false
    expect(calls[calls.length - 1]).toMatchObject({ running: false, cookieExpired: true });
    // 首次检测到 400 时也上报了一次 cookieExpired=true（running=true）
    expect(calls.some((c) => c.running === true && c.cookieExpired === true)).toBe(true);
    // 无任何成功数据
    expect(svc.getStats().hourly.length).toBe(0);
  });

  it("refreshHistory 收到 abortHistoryRefresh 后尽快终止整次刷新", async () => {
    const fetched: string[] = [];
    const svc = makeService({
      targetHashes: ["Copper Coin", "Sword (Legendary) A", "Iron Ingot"],
      fetchHistory: async (hash) => {
        fetched.push(hash);
        return {
          ok: true,
          status: 200,
          points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
        };
      },
      onHistoryProgress: (p) => {
        // 第一个物品完成时请求终止，后续物品不应再被拉取
        if (p.done === 1 && p.current === null) svc.abortHistoryRefresh();
      },
    });
    await svc.refreshHistory(BASE);

    // 仅在首个 items 完成后即被终止，不再继续拉取后续目标
    expect(fetched).toHaveLength(1);
  });

  it("refreshItem 手动刷新单个物品并入 priceHistory 并重算走势", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [{ timestamp: BASE / 1000 - 48 * 3600, price: 0.5, volume: 100 }],
      }),
    });
    const result = await svc.refreshItem("Copper Coin", BASE);

    expect(result.cookieExpired).toBe(false);
    expect(result.updated).toBeDefined();
    expect(result.updated!.hash).toBe("Copper Coin");
    expect(result.updated!.points.length).toBeGreaterThan(0);
    // 已并入 priceHistory 并重算顶部走势，时间范围延伸到 48 小时前
    expect(svc.getPriceHistory()["Copper Coin"]).toBeDefined();
    expect(svc.getStats().hourly.length).toBeGreaterThan(0);
    expect(svc.getStats().hourly[0]!.hour).toBe(
      new Date((Math.floor(BASE / 1000 / 3600) - 48) * 3600_000).toISOString(),
    );
  });

  it("refreshItem 遇 400 时返回 cookieExpired=true 且不改写数据", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({ ok: false, status: 400, reason: "unauthorized" }),
    });
    const result = await svc.refreshItem("Copper Coin", BASE);

    expect(result.cookieExpired).toBe(true);
    expect(result.updated).toBeUndefined();
    expect(svc.getPriceHistory()["Copper Coin"]).toBeUndefined();
  });

  it("recordVolume 累积 per-hash 活跃度采样，getVolumeItems 返回 kind=live 卡片", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE);
      const svc = makeService();
      svc.recordVolume("Copper Coin", 100, 0.5, "USD");
      // 同一轮询周期内重复采样去重（仅更新该点数值）
      svc.recordVolume("Copper Coin", 110, 0.6, "USD");
      // 越过 60s 去抖窗口后再采样 -> 新增一个采样点
      vi.setSystemTime(BASE + 70_000);
      svc.recordVolume("Copper Coin", 200, 1, "USD");
      svc.recordVolume("Sword (Legendary) A", 10, 2, "USD");

      const { items } = svc.getVolumeItems();
      const coin = items.find((i) => i.hash === "Copper Coin")!;
      expect(coin.kind).toBe("live");
      expect(coin.total).toBe(200 * 1); // 最新有效采样
      expect(coin.points).toHaveLength(2); // 去重后保留 2 个点
      const sword = items.find((i) => i.hash === "Sword (Legendary) A");
      expect(sword?.kind).toBe("live");
      expect(sword?.total).toBe(10 * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("liveHistory 随 sampleNow 持久化并在新实例读回", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE);
      const svc = makeService();
      svc.recordVolume("Copper Coin", 100, 0.5, "USD");
      svc.sampleNow(BASE);
      vi.setSystemTime(BASE + 70_000);
      svc.recordVolume("Copper Coin", 200, 1, "USD");
      // 越过 60s 采样间隔，触发新一轮采样并落盘
      svc.sampleNow(BASE + 70_000);

      const reloaded = makeService();
      const coin = reloaded.getVolumeItems().items.find((i) => i.hash === "Copper Coin")!;
      expect(coin.kind).toBe("live");
      expect(coin.points).toHaveLength(2);
      expect(coin.total).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pruneLive 清理不在目标集内的陈旧 live/liveHistory 条目并落盘", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE);
      const svc = makeService();
      svc.recordVolume("Copper Coin", 100, 0.5, "USD");
      svc.recordVolume("Sword (Legendary) A", 10, 2, "USD");

      // 裁剪到本轮目标集：只保留 Copper Coin，Sword 应被清理（模拟取消星标）
      svc.pruneLive(new Set(["Copper Coin"]));

      const { items } = svc.getVolumeItems();
      expect(items.some((i) => i.hash === "Copper Coin")).toBe(true);
      expect(items.some((i) => i.hash === "Sword (Legendary) A")).toBe(false);

      // 落盘后重启读回：Sword 不应再从磁盘恢复
      const reloaded = makeService();
      const reloadedItems = reloaded.getVolumeItems().items;
      expect(reloadedItems.some((i) => i.hash === "Sword (Legendary) A")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getVolumeItems 去重：同一 hash 同时有 pricehistory 与 liveHistory 时只保留 history 卡片", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
      }),
    });
    // 先拉取 pricehistory（写入 priceHistory）
    await svc.refreshHistory(BASE);
    // 再累积同一 hash 的活跃度采样（写入 liveHistory / live）
    svc.recordVolume("Copper Coin", 200, 1, "USD");

    const { items } = svc.getVolumeItems();
    const coins = items.filter((i) => i.hash === "Copper Coin");
    // 三路合并必须去重：同一 hash 不得重复出现（否则 React 列表 key 冲突）
    expect(coins).toHaveLength(1);
    // history 优先：保留的应是 history 口径（kind 缺省），而非 live
    expect(coins[0].kind).toBeUndefined();
  });

  it("refreshHistory 二次拉取日粒度时保留旧的小时粒度（合并更细粒度）", async () => {
    const dayStart = Date.UTC(2026, 7, 7, 0, 0, 0) / 1000; // 某天 00:00 UTC（秒）
    const hourly = Array.from({ length: 24 }, (_, i) => ({
      timestamp: dayStart + i * 3600,
      price: 1,
      volume: 1,
    }));

    // 第一次：小时粒度（24 点/天）
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({ ok: true, status: 200, points: hourly }),
    });
    await svc.refreshHistory(BASE);

    // 第二次（force 绕过缓存）：同一天变成日粒度（1 点，整天量）
    const daily = [{ timestamp: dayStart, price: 1, volume: 24 }];
    const svc2 = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({ ok: true, status: 200, points: daily }),
    });
    await svc2.refreshHistory(BASE + 31 * 60_000, { force: true });

    // 合并后应保留小时粒度（24 点），而不是被日粒度（1 点）覆盖
    const merged = svc2.getPriceHistory()["Copper Coin"];
    expect(merged).toHaveLength(24);
  });
});

describe("MarketVolumeService 历史数据导出 / 导入", () => {
  it("exportHistory 返回完整快照，importHistory 到新实例后一致（往返）", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [
          { timestamp: BASE / 1000, price: 0.5, volume: 100 },
          { timestamp: (BASE + 3600_000) / 1000, price: 0.6, volume: 200 },
        ],
      }),
    });
    await svc.refreshHistory(BASE);
    svc.recordVolume("Copper Coin", 300, 0.5, "USD");
    svc.sampleNow(BASE);

    const snapshot = svc.exportHistory();
    expect(snapshot.priceHistory["Copper Coin"]).toHaveLength(2);
    expect(snapshot.samples.length).toBeGreaterThan(0);

    const json = JSON.stringify(snapshot);
    const restored = makeService();
    const itemCount = restored.importHistory(json);
    expect(itemCount).toBe(snapshot.itemCount);
    expect(restored.getPriceHistory()).toEqual(svc.getPriceHistory());
    expect(restored.getStats().hourly).toEqual(svc.getStats().hourly);
  });

  it("importHistory 覆盖现有数据（整体替换）", () => {
    const svc = makeService();
    svc.recordVolume("Old Item", 10, 1, "USD");
    svc.sampleNow(BASE);

    const itemCount = svc.importHistory(
      JSON.stringify({
        samples: [],
        historyHourly: [],
        priceHistory: { "New Item": [{ timestamp: BASE / 1000, price: 1, volume: 5 }] },
        itemCount: 1,
        itemCountsByCategory: {},
        historyFetchedAtMs: BASE,
      }),
    );
    expect(itemCount).toBe(1);
    expect(svc.getPriceHistory()).toEqual({
      "New Item": [{ timestamp: BASE / 1000, price: 1, volume: 5 }],
    });
    expect(svc.getStats().hourly).toEqual([]);
  });

  it("importHistory 非法 JSON 返回 null 且不改动现有数据", async () => {
    const svc = makeService({
      targetHashes: ["Copper Coin"],
      fetchHistory: async () => ({
        ok: true,
        status: 200,
        points: [{ timestamp: BASE / 1000, price: 0.5, volume: 100 }],
      }),
    });
    await svc.refreshHistory(BASE);
    const before = svc.getPriceHistory();
    const hourlyBefore = svc.getStats().hourly;

    expect(svc.importHistory("{ not json")).toBeNull();
    expect(svc.importHistory(JSON.stringify("just a string"))).toBeNull();
    expect(svc.getPriceHistory()).toEqual(before);
    expect(svc.getStats().hourly).toEqual(hourlyBefore);
  });
});

describe("MarketVolumeService 刷新排序：主区优先 + 每天全量兜底", () => {
  // targets: [A(星标), B(高交易额), C(中交易额)]；覆盖率阈值 0.6。
  // 窗口成交额：A=10, B=100, C=50，总 160；B 单独覆盖 62.5% ≥ 0.6 → 主区 = A+B。
  const A = "star low";
  const B = "high volume";
  const C = "mid volume";
  const targets = [A, B, C];
  const watched = [A];
  const coverageThreshold = 0.6;

  function makeRecordingService(recorder: string[]) {
    return new MarketVolumeService({
      getCatalog: () => [],
      getCurrency: () => "USD",
      getCookie: () => "",
      getTargetHashes: () => targets,
      getWatchedHashes: () => watched,
      getCoverageThreshold: () => coverageThreshold,
      getSnapshotPriceUsd: () => 0,
      getHistoryBatchSize: () => 10,
      getHistoryBatchDelaySec: () => 0,
      filePath: () => file,
      fetchHistory: async (hash) => {
        recorder.push(hash);
        return {
          ok: true,
          status: 200,
          currency: "USD",
          points: [{ timestamp: BASE / 1000, price: 1, volume: hash === B ? 100 : hash === C ? 50 : 10 }],
        };
      },
    });
  }

  it("首次刷新（冷启动）全部目标都拉取，且星标优先", async () => {
    const recorder: string[] = [];
    const svc = makeRecordingService(recorder);
    await svc.refreshHistory(BASE);
    // 星标 A 最前；B/C 首次无数据，均需拉取
    expect(recorder).toEqual([A, B, C]);
  }, 15000);

  it("同一天再次自动刷新：主区(A+B)重刷，长尾C 当日已刷则跳过（每天全量一遍）", async () => {
    const recorder: string[] = [];
    const svc = makeRecordingService(recorder);
    await svc.refreshHistory(BASE);
    expect(recorder).toEqual([A, B, C]);
    recorder.length = 0;

    // 同一天 61 分钟后再次自动刷新：已跳过 1h 缓存，主区重刷、长尾 C 当日已刷被跳过。
    await svc.refreshHistory(BASE + 61 * 60_000);
    expect(recorder).toEqual([A, B]);
  }, 20000);

  it("跨天自动刷新：长尾 C 被重新纳入（已过一天）", async () => {
    const recorder: string[] = [];
    const svc = makeRecordingService(recorder);
    await svc.refreshHistory(BASE);
    recorder.length = 0;
    // 跨天：+25 小时（超过 1h 缓存，且进入新的一天）
    await svc.refreshHistory(BASE + 25 * 3600_000);
    // 主区 A+B 必拉，长尾 C 跨天后重新纳入 → 三者都拉
    expect(recorder).toEqual([A, B, C]);
  }, 20000);
});
