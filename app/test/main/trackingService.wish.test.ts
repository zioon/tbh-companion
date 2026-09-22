// TrackingService × 祈愿记录 集成测试（T03）。
//
// 验证：
//   - acquire 文本行中的祈愿行被识别并喂入 wishTracker（Stats.wish 可见）。
//   - 非祈愿行零副作用（不污染祈愿统计）。
//   - 多语言前缀识别（zh / en / ja / ko）。
//   - 双计数：多件行 offering +1、item += 件数。
//   - initial=true 批量回灌 → bulk（计入累计/历史，不进滚动窗）。
//   - 去重：同一 seq 的 initial 重投不重复计数。
//   - reset() / clearSession() / onLiveMemoryToggled() / onSavePathChanged()
//     同步清空祈愿会话（累计在 reset 后仍保留，除非 clearSession）。
//   - getStats().wish 在各边界下形状稳定（不 NaN / 8 桶 / readerRequired）。
//
// 复用 trackingService.test.ts 的 mock 结构（saveWatcher / broadcast / log /
// historyLog 全 mock，避免触碰真实 I/O）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SaveSnapshot } from "../../shared/types";
import { DEFAULT_NOTIFICATION_PREFS } from "../../shared/notificationCatalog";

vi.mock("../../src/main/saveWatcher", () => ({
  SaveWatcher: class {
    constructor(opts: { onSnapshot: (snap: SaveSnapshot) => void }) {
      onSnapshot = opts.onSnapshot;
    }
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../../src/main/services/broadcast", () => ({
  broadcast: vi.fn(),
}));

vi.mock("../../src/main/log", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../src/main/historyLog", () => ({
  makeHistoryLogger: vi.fn(),
}));

// T05：`WishRecordService` 会读写 `userData/wish_record.json`（测试环境下
// `app.getPath("userData")` 回退到 cwd）——若让它真实落盘/加载，跨测试运行
// 会把上一轮的累计灌进新建的 wishTracker，污染断言。本测试的契约是「全 I/O
// mock」，故把长期归档服务替换为空实现（load/schedulePersist/flush/resetStorage
// 全部 no-op），聚焦 T03 的转发与聚合语义；归档本身由单元测试覆盖。
vi.mock("../../src/main/services/WishRecordService", () => ({
  WishRecordService: class {
    constructor() {}
    load = vi.fn();
    schedulePersist = vi.fn();
    flush = vi.fn();
    resetStorage = vi.fn();
  },
}));

import { TrackingService } from "../../src/main/services/TrackingService";

const baseConfig = {
  savePath: "C:/game/save.es3",
  es3Password: "x",
  pollIntervalSeconds: 5,
  rollingWindowMinutes: 5,
  topmost: { main: true, overlay: true, boxTracker: true },
  logHistoryCsv: false,
  currency: "USD",
  notificationsEnabled: true,
  notifyOnUpdateAvailable: true,
  notificationVolume: 100,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
  inventoryAlmostFullThresholdPercent: 90,
  chestAutoOpenEnabled: { common: false, stageBoss: false },
  marketAutoScanEnabled: true,
  marketLowValueThresholdUsd: 0.05,
  lootAutoClassifyEnabled: false,
  lootRingSeconds: { common: 300, stage: 420, plagueCommon: 300, plagueRare: 420, plagueAct: 3600 },
  liveMemory: { enabled: false, consentAccepted: false },
  lookupPricePolling: { enabled: false, intervalMinutes: 10, thresholdUsd: 1.0, watchedHashes: [] },
  marketHistoryBatchSize: 10,
  marketHistoryBatchDelaySec: 120,
  marketHistoryCoverageThreshold: 0.95,
  language: "auto" as const,
};

let onSnapshot: ((snap: SaveSnapshot) => void) | undefined;

function snap(level: number, mtime = 100, heroExp = 100): SaveSnapshot {
  return {
    heroes: [{ key: "101", level, exp: heroExp, unlocked: true }],
    totalHeroExp: heroExp,
    playTime: 0,
    saveMtime: mtime,
    stageKey: 3205,
    stageWave: 1,
    maxStage: 0,
    gold: 0,
  };
}

/**
 * 唯一 ring 序号，避免与共享 record_log.json 的持久化去重集冲突。
 * 基数带 `Date.now()`（与既有 trackingService.test.ts 同理）：`initial=true`
 * 批次会按 ring 序号对持久化归档去重，跨测试运行若序号固定，第二轮起会被
 * 误判为「已归档」而整批跳过。
 */
let seqCursor = 950000000 + (Date.now() % 10000000);
function nextSeq(): number {
  seqCursor += 1;
  return seqCursor;
}

/** 一条祈愿结果行（带品质色）。 */
function wishLine(
  seq: number,
  name: string,
  color = "#519FFF",
  time = "12:00",
): {
  seq: number;
  time: string;
  message: string;
} {
  return { seq, time, message: `祈愿结果：获得了<color=${color}>${name}</color>。` };
}

describe("TrackingService wish ingestion", () => {
  beforeEach(() => {
    onSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("Stats.wish is present and empty by default", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const wish = svc.getStats().wish;
    expect(wish.offeringCountTotal).toBe(0);
    expect(wish.itemCountTotal).toBe(0);
    expect(wish.itemsPerOffering).toBe(0);
    expect(wish.readerRequired).toBe(true);
    expect(wish.gradeDistribution).toHaveLength(8);
    expect(wish.history).toEqual([]);
    svc.stop();
  });

  it("recognizes a zh-CN wish line and feeds the wish tracker", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const tag = `祈愿证物${Date.now()}`;
    svc.ingestAcquireBatch([wishLine(nextSeq(), tag)]);

    const wish = svc.getStats().wish;
    expect(wish.offeringCountTotal).toBe(1);
    expect(wish.itemCountTotal).toBe(1);
    const row = wish.breakdown.find((r) => r.name === tag);
    expect(row).toBeDefined();
    expect(row?.grade).toBe("RARE"); // #519FFF → RARE
    expect(wish.history[0].name).toBe(tag);
    svc.stop();
  });

  it("recognizes multi-language wish-line prefixes (en / ja / ko)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const stamp = `${Date.now()}`;
    const en = `Offering result: obtained <color=#EBBB00>En${stamp}</color>.`;
    const ja = `祈願結果：獲得<color=#E8695A>Ja${stamp}</color>。`;
    const ko = `기원 결과: 획득 <color=#FB86FF>Ko${stamp}</color>.`;
    svc.ingestAcquireBatch([
      { seq: nextSeq(), time: "12:01", message: en },
      { seq: nextSeq(), time: "12:02", message: ja },
      { seq: nextSeq(), time: "12:03", message: ko },
    ]);

    const wish = svc.getStats().wish;
    expect(wish.offeringCountTotal).toBe(3);
    expect(wish.itemCountTotal).toBe(3);
    const names = wish.breakdown.map((r) => r.name);
    expect(names).toContain(`En${stamp}`);
    expect(names).toContain(`Ja${stamp}`);
    expect(names).toContain(`Ko${stamp}`);
    svc.stop();
  });

  it("sums item counts within one wish line (double counting)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const tag = `批量祈愿物${Date.now()}`;
    svc.ingestAcquireBatch([
      {
        seq: nextSeq(),
        time: "12:10",
        message: `祈愿结果：获得了<color=#D7D7D7>${tag}</color> x5。`,
      },
    ]);

    const wish = svc.getStats().wish;
    // offering = 1（事件），item = 5（件数）。
    expect(wish.offeringCountTotal).toBe(1);
    expect(wish.itemCountTotal).toBe(5);
    expect(wish.itemsPerOffering).toBe(5);
    svc.stop();
  });

  it("ignores non-wish acquire lines (zero cross-contamination)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const before = svc.getStats().wish.itemCountTotal;
    const stamp = `${Date.now()}`;
    svc.ingestAcquireBatch([
      // 普通获得行（无祈愿前缀 / 无冒号）——不得计入祈愿。
      { seq: nextSeq(), time: "12:20", message: `获得了<color=#D7D7D7>普通物品${stamp}</color>。` },
      // 制作结果行（排除表）——不得计入祈愿。
      {
        seq: nextSeq(),
        time: "12:21",
        message: `制作结果：获得了<color=#EBBB00>合成物${stamp}</color>。`,
      },
      // 合成结果行（排除表）。
      {
        seq: nextSeq(),
        time: "12:22",
        message: `合成结果：获得了<color=#519FFF>产物${stamp}</color>。`,
      },
      // 金币行（无物品标签）。
      { seq: nextSeq(), time: "12:23", message: `获得金币 ${stamp}` },
    ]);

    const after = svc.getStats().wish;
    expect(after.itemCountTotal).toBe(before);
    expect(after.offeringCountTotal).toBe(0);
    svc.stop();
  });

  it("counts initial=true bulk lines in totals/history but not in the rolling window", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const stamp = `${Date.now()}`;
    const backlog = [
      {
        seq: nextSeq(),
        time: "10:00",
        message: `祈愿结果：获得了<color=#D7D7D7>存量${stamp}</color>。`,
      },
      {
        seq: nextSeq(),
        time: "10:01",
        message: `祈愿结果：获得了<color=#D7D7D7>存量${stamp}</color>。`,
      },
      {
        seq: nextSeq(),
        time: "10:02",
        message: `祈愿结果：获得了<color=#D7D7D7>存量${stamp}</color>。`,
      },
    ];
    svc.ingestAcquireBatch(backlog, true);

    const wish = svc.getStats().wish;
    expect(wish.offeringCountTotal).toBe(3);
    // bulk → 不进滚动窗。
    expect(wish.offeringRecentPerHour).toBe(0);
    expect(wish.itemRecentPerHour).toBe(0);
    // 但历史里标了 bulk。
    expect(wish.history.every((h) => h.bulk === true)).toBe(true);
    svc.stop();
  });

  it("does not re-count a re-attached initial backlog (ring-seq dedupe)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const stamp = `${Date.now()}`;
    const backlog = [
      {
        seq: nextSeq(),
        time: "11:00",
        message: `祈愿结果：获得了<color=#EBBB00>去重${stamp}</color>。`,
      },
    ];
    svc.ingestAcquireBatch(backlog, true);
    const first = svc.getStats().wish.offeringCountTotal;

    // 同一 game session 重连 → 相同 ring 序号必须被去重。
    svc.ingestAcquireBatch(backlog, true);
    expect(svc.getStats().wish.offeringCountTotal).toBe(first);
    svc.stop();
  });

  it("reset() keeps cumulative wish totals while zeroing the session delta", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    svc.ingestAcquireBatch([wishLine(nextSeq(), `充值前${Date.now()}`)]);
    const before = svc.getStats().wish;
    expect(before.offeringCountTotal).toBe(1);
    expect(before.offeringCountSession).toBe(1);

    svc.reset();

    const after = svc.getStats().wish;
    expect(after.offeringCountTotal).toBe(1); // 累计保留
    expect(after.offeringCountSession).toBe(0); // 会话归零
    svc.stop();
  });

  it("clearSession() zeroes the wish session delta but keeps the cumulative", () => {
    // 注意：WishTracker.reset() 是**会话重置**（PRD §5.6 不变量 5）——*Session
    // 归零、累计不变；P1 长期归档由 wish_record.json 承载。这与 ChestDropTracker
    // 的 reset()（整体清空）不同，是祈愿记录刻意的双口径设计。
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    svc.ingestAcquireBatch([wishLine(nextSeq(), `清空前${Date.now()}`)]);
    expect(svc.getStats().wish.offeringCountTotal).toBe(1);
    expect(svc.getStats().wish.offeringCountSession).toBe(1);

    svc.clearSession();

    const after = svc.getStats().wish;
    expect(after.offeringCountTotal).toBe(1); // 累计不变
    expect(after.itemCountTotal).toBe(1);
    expect(after.offeringCountSession).toBe(0); // 会话归零
    svc.stop();
  });

  it("onLiveMemoryToggled() zeroes the wish session delta but keeps the cumulative", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    svc.ingestAcquireBatch([wishLine(nextSeq(), `切换前${Date.now()}`)]);
    expect(svc.getStats().wish.offeringCountTotal).toBe(1);

    svc.onLiveMemoryToggled();

    const after = svc.getStats().wish;
    expect(after.offeringCountTotal).toBe(1); // 累计不变
    expect(after.offeringCountSession).toBe(0); // 会话归零
    svc.stop();
  });

  it("onSavePathChanged() zeroes the wish session delta but keeps the cumulative", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    svc.ingestAcquireBatch([wishLine(nextSeq(), `改路径前${Date.now()}`)]);
    expect(svc.getStats().wish.offeringCountTotal).toBe(1);

    svc.onSavePathChanged();

    const after = svc.getStats().wish;
    expect(after.offeringCountTotal).toBe(1); // 累计不变
    expect(after.offeringCountSession).toBe(0); // 会话归零
    svc.stop();
  });

  it("grade is mapped from the color tag; unmappable color → UNKNOWN (never guessed)", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const stamp = `${Date.now()}`;
    svc.ingestAcquireBatch([
      {
        seq: nextSeq(),
        time: "13:00",
        message: `祈愿结果：获得了<color=#E8695A>不朽${stamp}</color>。`,
      },
      // 无颜色标签 → 无名称来源则丢；此例有名称但无品质色 → UNKNOWN。
      { seq: nextSeq(), time: "13:01", message: `祈愿结果：获得 无彩${stamp}。` },
    ]);

    const wish = svc.getStats().wish;
    const immortal = wish.breakdown.find((r) => r.name === `不朽${stamp}`);
    expect(immortal?.grade).toBe("IMMORTAL"); // #E8695A → IMMORTAL
    const unknown = wish.breakdown.find((r) => r.name === `无彩${stamp}`);
    expect(unknown?.grade).toBe("UNKNOWN");
    svc.stop();
  });

  it("getWishTracker() exposes the tracker; its snapshot round-trips through getStats", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    svc.ingestAcquireBatch([wishLine(nextSeq(), `快照${Date.now()}`)]);
    const snap0 = svc.getWishTracker().captureSnapshot();
    expect(snap0.offeringCount).toBe(1);

    // getStats().wish 与 tracker 输出一致（同一实例）。
    expect(svc.getStats().wish.offeringCountTotal).toBe(1);
    svc.stop();
  });

  it("Stats.wish gradeDistribution always sums to itemCountTotal", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const stamp = `${Date.now()}`;
    svc.ingestAcquireBatch([
      {
        seq: nextSeq(),
        time: "14:00",
        message: `祈愿结果：获得了<color=#7CE937>A${stamp}</color> x2。`,
      },
      {
        seq: nextSeq(),
        time: "14:01",
        message: `祈愿结果：获得了<color=#00F6FF>B${stamp}</color>。`,
      },
    ]);

    const wish = svc.getStats().wish;
    const sum = wish.gradeDistribution.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(wish.itemCountTotal);
    expect(wish.itemCountTotal).toBe(3);
    svc.stop();
  });

  it("stats are not NaN when no wish lines have been seen", () => {
    const svc = new TrackingService(vi.fn());
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 100));

    const wish = svc.getStats().wish;
    for (const v of [
      wish.itemsPerOffering,
      wish.offeringPerHour,
      wish.itemPerHour,
      wish.offeringRecentPerHour,
      wish.itemRecentPerHour,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    svc.stop();
  });
});
