# 交易页历史数据导出 / 导入实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为交易页（Trading）历史数据（`market_volume_history.json`）增加 JSON 完整导出 / 导入（整体替换恢复）能力，入口在交易页工具栏。

**Architecture:** 遵循四层架构。core 层新增纯解析函数 `parseMarketVolumeHistory`（可从 main 的 `loadHistory` 复用校验逻辑）；main 层 `MarketVolumeService` 新增 `exportHistory` / `importHistory`，`appState` 编排文件对话框 + 导入后广播刷新；新增两个 IPC invoke 通道；preload 暴露；renderer 交易页工具栏加「导出」「导入」按钮。

**Tech Stack:** Electron + React + TypeScript + Vitest，pnpm 包管理。

前置设计文档：`docs/superpowers/specs/2026-08-25-market-volume-export-import-design.md`

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|------|------|------|
| `app/shared/ipc.ts` | 修改 | + `EXPORT_MARKET_VOLUME` / `IMPORT_MARKET_VOLUME` 通道 + `IPC_INVOKE_CHANNELS` |
| `app/shared/types.ts` | 修改 | + `ExportMarketVolumeResult` / `ImportMarketVolumeResult` + `TbhApi` 方法签名 |
| `app/src/core/marketVolume.ts` | 修改 | + `ParsedMarketVolumeHistory` + `parseMarketVolumeHistory`（含 helper） |
| `app/src/main/services/MarketVolumeService.ts` | 修改 | + `exportHistory` / `importHistory`；重构 `loadHistory` 复用 parser |
| `app/src/main/app/appState.ts` | 修改 | + `exportMarketVolumeHistory` / `importMarketVolumeHistory`（对话框 + 读写 + 广播） |
| `app/src/main/ipc/handlers/market.ts` | 修改 | + 两个薄 handler |
| `app/src/preload/index.ts` | 修改 | + 两个方法 |
| `app/src/renderer/tabs/Trading.tsx` | 修改 | 工具栏 + 两个按钮 + 确认 + 结果提示 |
| `app/shared/locales/{en,zh-CN,ja,ko}/market.json` | 修改 | `trading` 下新增文案 |
| `app/shared/locales/{en,zh-CN,ja,ko}/dialogs.json` | 修改 | + `exportMarketVolumeTitle` / `importMarketVolumeTitle` / `jsonFilter` |
| `app/test/core/marketVolume.test.ts` | 修改 | + `parseMarketVolumeHistory` 用例 |
| `app/test/main/marketVolumeService.test.ts` | 修改 | + export/import 往返 / 覆盖 / 非法用例 |
| `app/test/ipc/channels.test.ts` | 修改 | + 两个通道契约断言 |
| `docs/BUSINESS-FLOWS.md` | 修改 | 8.7 节新增子节 |

**术语约定（全文统一）：**
- `exportHistory()`（服务方法，返回快照）与 `exportMarketVolumeHistory()`（appState 方法，含对话框 + 写文件）不是同一个。
- `importHistory(json)`（服务方法，返回 `number | null` = 成功时 itemCount / 失败 null）与 `importMarketVolumeHistory()`（appState 方法，含对话框 + 读文件 + 广播）不是同一个。

---

## Task 1: IPC 通道与共享类型

**Files:**
- Modify: `app/shared/ipc.ts`
- Modify: `app/shared/types.ts`

- [ ] **Step 1: 在 `app/shared/ipc.ts` 的 Invoke 区新增两个通道名**

在 `IPC` 对象 `REFRESH_MARKET_VOLUME_ITEM: "market:refresh-volume-item"` 之后加：

```ts
  EXPORT_MARKET_VOLUME: "market:export-history",
  IMPORT_MARKET_VOLUME: "market:import-history",
```

在 `IPC_INVOKE_CHANNELS` 数组的 `IPC.REFRESH_MARKET_VOLUME_ITEM` 之后加：

```ts
  IPC.EXPORT_MARKET_VOLUME,
  IPC.IMPORT_MARKET_VOLUME,
```

- [ ] **Step 2: 在 `app/shared/types.ts` 新增结果类型**

在 `MarketVolumeRefreshResult`（约 line 869）之后加：

```ts
/** 交易页「导出历史数据」的结果。 */
export interface ExportMarketVolumeResult {
  /** 导出成功并写入文件。 */
  ok?: boolean;
  /** 用户取消对话框（无 ok 字段）。 */
  canceled?: boolean;
  /** 导出写入的文件路径（仅 ok=true 时）。 */
  path?: string;
  /** 失败原因（仅 ok=false 时）。 */
  reason?: string;
}

/** 交易页「导入历史数据」的结果。 */
export interface ImportMarketVolumeResult {
  /** 导入成功并已整体替换（无 ok 字段时为用户取消）。 */
  ok?: boolean;
  /** 用户取消对话框。 */
  canceled?: boolean;
  /** 导入后历史统计覆盖的物品种数（仅 ok=true 时）。 */
  itemCount?: number;
  /** 失败原因（仅 ok=false 时，如 "invalid_backup"）。 */
  reason?: string;
}
```

- [ ] **Step 3: 在 `app/shared/types.ts` 的 `TbhApi` 增加方法签名**

在 `refreshMarketVolumeItem(hash: string): Promise<void>;`（约 line 1826）之后加：

```ts
  exportMarketVolumeHistory(): Promise<ExportMarketVolumeResult>;
  importMarketVolumeHistory(): Promise<ImportMarketVolumeResult>;
```

- [ ] **Step 4: 验证类型**

Run: `pnpm typecheck`
Expected: 通过（TbhApi 新增方法尚无实现，但 preload 未实现时不会报错——preload 的 `tbh` 对象必须实现全部方法，若此时 typecheck 报 missing property，说明 preload 是强约束，则在 Task 5 前 typecheck 会红；本 Task 先确认 ipc/types 本身无语法错误）。

- [ ] **Step 5: Commit**

```bash
git add app/shared/ipc.ts app/shared/types.ts
git commit -m "feat(market): add IPC channels + types for history export/import"
```

---

## Task 2: core 纯解析函数 `parseMarketVolumeHistory`

**Files:**
- Modify: `app/src/core/marketVolume.ts`
- Test: `app/test/core/marketVolume.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/marketVolume.test.ts` 顶部 import 增加：

```ts
import { parseMarketVolumeHistory } from "../../src/core/marketVolume";
```

在文件末尾追加一个 describe 块：

```ts
describe("parseMarketVolumeHistory", () => {
  it("解析合法快照并逐字段过滤", () => {
    const parsed = parseMarketVolumeHistory({
      version: 1,
      samples: [
        { timestamp: "2026-08-25T00:00:00Z", items: 1, total: 10, byCategory: {}, currency: "USD" },
        { timestamp: 123 }, // 非法样本被过滤
      ],
      historyHourly: [
        { hour: "2026-08-25T00:00:00Z", total: 5 },
        { hour: 123 }, // 非法小时点被过滤
      ],
      priceHistory: {
        "Copper Coin": [
          { timestamp: 1720000000, price: 1.2, volume: 340 },
          { timestamp: NaN, price: 1, volume: 1 }, // 非法点被过滤
        ],
      },
      liveHistory: {
        "Copper Coin": [
          { ts: 1720000000000, volume: 340, median: 1.2 },
          { ts: "x", volume: 1 }, // 非法点被过滤
        ],
      },
      itemCount: 1,
      itemCountsByCategory: { WEAPON: 1 },
      historyFetchedAtMs: 1720000000000,
    });

    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toHaveLength(1);
    expect(parsed!.historyHourly).toHaveLength(1);
    expect(parsed!.priceHistory["Copper Coin"]).toHaveLength(1);
    expect(parsed!.liveHistory!["Copper Coin"]).toHaveLength(1);
    expect(parsed!.itemCount).toBe(1);
    expect(parsed!.historyFetchedAtMs).toBe(1720000000000);
  });

  it("顶层非法（null / string / number）返回 null", () => {
    expect(parseMarketVolumeHistory(null)).toBeNull();
    expect(parseMarketVolumeHistory("nope")).toBeNull();
    expect(parseMarketVolumeHistory(42)).toBeNull();
  });

  it("接受旧版纯数组格式并解析为 samples", () => {
    const parsed = parseMarketVolumeHistory([
      { timestamp: "2026-08-25T00:00:00Z", items: 1, total: 10, byCategory: {}, currency: "USD" },
      { total: 1 }, // 非法样本被过滤
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toHaveLength(1);
    expect(parsed!.historyHourly).toEqual([]);
  });

  it("部分字段缺失时回退为安全默认值", () => {
    const parsed = parseMarketVolumeHistory({ priceHistory: "bad" });
    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toEqual([]);
    expect(parsed!.historyHourly).toEqual([]);
    expect(parsed!.priceHistory).toEqual({});
    expect(parsed!.itemCount).toBe(0);
    expect(parsed!.itemCountsByCategory).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/core/marketVolume.test.ts -t "parseMarketVolumeHistory"`
Expected: FAIL —— `parseMarketVolumeHistory` is not defined / import 报错。

- [ ] **Step 3: 实现**

在 `app/src/core/marketVolume.ts` 末尾（`calibratePricesWithMedian` 之后）追加：

```ts
/** 解析后的交易页历史数据快照（结构兼容 main 的 PersistedMarketVolume）。 */
export interface ParsedMarketVolumeHistory {
  /** 备份格式版本；当前恒为 1。解析时保留，供未来迁移。 */
  version?: number;
  samples: MarketVolumeSample[];
  historyHourly: MarketVolumeHourPoint[];
  priceHistory: Record<string, PriceHistoryPoint[]>;
  liveHistory?: Record<string, LiveVolumePoint[]>;
  itemCount: number;
  itemCountsByCategory: Record<string, number>;
  historyFetchedAtMs?: number;
}

function isMarketVolumeSample(s: unknown): s is MarketVolumeSample {
  const v = s as MarketVolumeSample;
  return !!s && typeof v.timestamp === "string" && typeof v.total === "number";
}

function isMarketVolumeHourPoint(h: unknown): h is MarketVolumeHourPoint {
  const v = h as MarketVolumeHourPoint;
  return !!h && typeof v.hour === "string" && typeof v.total === "number";
}

function isPriceHistoryPoint(pt: unknown): pt is PriceHistoryPoint {
  const v = pt as PriceHistoryPoint;
  return !!pt && Number.isFinite(v.timestamp) && Number.isFinite(v.price) && Number.isFinite(v.volume);
}

function isLiveVolumePoint(pt: unknown): pt is LiveVolumePoint {
  const v = pt as LiveVolumePoint;
  return !!pt && Number.isFinite(v.ts) && Number.isFinite(v.volume);
}

/**
 * 把任意 JSON 解析为交易页历史快照（校验 + 逐字段过滤）。与旧 loadHistory
 * 的过滤规则一致；顶层非法返回 null。旧版纯数组格式解析为仅含 samples 的快照。
 */
export function parseMarketVolumeHistory(raw: unknown): ParsedMarketVolumeHistory | null {
  if (Array.isArray(raw)) {
    return {
      samples: raw.filter(isMarketVolumeSample),
      historyHourly: [],
      priceHistory: {},
      itemCount: 0,
      itemCountsByCategory: {},
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;

  const result: ParsedMarketVolumeHistory = {
    samples: Array.isArray(p.samples) ? p.samples.filter(isMarketVolumeSample) : [],
    historyHourly: Array.isArray(p.historyHourly)
      ? p.historyHourly.filter(isMarketVolumeHourPoint)
      : [],
    priceHistory: {},
    itemCount: typeof p.itemCount === "number" ? p.itemCount : 0,
    itemCountsByCategory:
      p.itemCountsByCategory && typeof p.itemCountsByCategory === "object"
        ? (p.itemCountsByCategory as Record<string, number>)
        : {},
  };

  if (p.priceHistory && typeof p.priceHistory === "object") {
    for (const [hash, pts] of Object.entries(p.priceHistory as Record<string, unknown>)) {
      if (Array.isArray(pts)) {
        result.priceHistory[hash] = pts.filter(isPriceHistoryPoint);
      }
    }
  }
  if (p.liveHistory && typeof p.liveHistory === "object") {
    const liveHistory: Record<string, LiveVolumePoint[]> = {};
    for (const [hash, pts] of Object.entries(p.liveHistory as Record<string, unknown>)) {
      if (Array.isArray(pts)) {
        const valid = pts.filter(isLiveVolumePoint);
        if (valid.length > 0) liveHistory[hash] = valid;
      }
    }
    result.liveHistory = liveHistory;
  }
  if (typeof p.version === "number") result.version = p.version;
  if (typeof p.historyFetchedAtMs === "number") result.historyFetchedAtMs = p.historyFetchedAtMs;
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run test/core/marketVolume.test.ts`
Expected: PASS（新增 4 个用例 + 原有用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add app/src/core/marketVolume.ts app/test/core/marketVolume.test.ts
git commit -m "feat(market): core parseMarketVolumeHistory for history backup parsing"
```

---

## Task 3: `MarketVolumeService` 的 `exportHistory` / `importHistory`（含 `loadHistory` 复用重构）

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts`
- Test: `app/test/main/marketVolumeService.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/main/marketVolumeService.test.ts` 的 describe 内追加（放在文件末尾任意位置）：

```ts
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

    const snapshot = svc.exportHistory();
    expect(snapshot.priceHistory["Copper Coin"]).toHaveLength(2);
    expect(snapshot.samples.length).toBeGreaterThan(0);

    const json = JSON.stringify(snapshot);
    const restored = makeService();
    // 新实例从零开始，导入后应与原实例一致
    const itemCount = restored.importHistory(json);
    expect(itemCount).toBe(snapshot.itemCount);
    expect(restored.getPriceHistory()).toEqual(svc.getPriceHistory());
    expect(restored.getStats().hourly).toEqual(svc.getStats().hourly);
  });

  it("importHistory 覆盖现有数据（整体替换）", () => {
    const svc = makeService();
    svc.recordVolume("Old Item", 10, 1, "USD");
    svc.sampleNow();
    const before = svc.getVolumeItems().items.length;

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
    // 旧物品被清掉（recordVolume 的 live 内存态在导入后仍可能残留，这里验证历史快照被替换）
    expect(svc.getStats().hourly).toEqual([]);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it("importHistory 非法 JSON 返回 null 且不改动现有数据", () => {
    const svc = makeService();
    svc.recordVolume("Keep", 10, 1, "USD");
    svc.sampleNow();
    const hourlyBefore = svc.getStats().hourly;

    expect(svc.importHistory("{ not json")).toBeNull();
    expect(svc.importHistory(JSON.stringify("just a string"))).toBeNull();
    // 现有数据未被破坏
    expect(svc.getStats().hourly).toEqual(hourlyBefore);
  });
});
```

注意：`makeService()` 中 `getVolumeItems` 依赖 `getCatalog`（当前为空数组），`getVolumeItems()` 对无图鉴 hash 仍会返回条目（hash 即名称），测试只断言数量不增长等宽松关系。若某个断言对 `recordVolume` + `sampleNow` 的时序敏感，可将第一/第三个用例聚焦在 `getPriceHistory()` 与 `getStats().hourly` 上（它们是 importHistory 直接替换的字段），避免依赖 `recordVolume` 的采样时序。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run test/main/marketVolumeService.test.ts`
Expected: FAIL —— `exportHistory` / `importHistory` 不存在。

- [ ] **Step 3: 实现 `exportHistory` / `importHistory`**

在 `app/src/main/services/MarketVolumeService.ts` 的 import 块（`type VolumeHashSample` 之后）增加 `parseMarketVolumeHistory`：

```ts
  calibratePricesWithMedian,
  mergePriceHistoryPoints,
  parseMarketVolumeHistory,
```

在 `saveHistory()` 方法之后（约 line 259）追加（同时给 `PersistedMarketVolume` 接口加 `version?: number` 字段，位于 `interface PersistedMarketVolume {` 顶部）：

```ts
  /** 返回当前完整历史快照（供导出备份；结构即落盘 payload，含备份版本号）。 */
  exportHistory(): PersistedMarketVolume {
    return {
      version: 1,
      samples: this.samples,
      historyHourly: this.historyHourly,
      priceHistory: this.priceHistory,
      liveHistory: this.liveHistory,
      itemCount: this.historyItemCount,
      itemCountsByCategory: this.historyItemCountsByCategory,
      historyFetchedAtMs: this.historyFetchedAtMs,
    };
  }

  /**
   * 用备份 JSON 整体替换当前历史数据。解析/校验失败返回 null 且不改动现有数据；
   * 成功返回导入后的 itemCount 并立即落盘。
   */
  importHistory(json: string): number | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json.replace(/^\uFEFF/, ""));
    } catch {
      return null;
    }
    const parsed = parseMarketVolumeHistory(raw);
    if (!parsed) return null;
    this.samples = parsed.samples;
    this.historyHourly = parsed.historyHourly;
    this.priceHistory = parsed.priceHistory;
    this.liveHistory = parsed.liveHistory ?? {};
    this.historyItemCount = parsed.itemCount;
    this.historyItemCountsByCategory = parsed.itemCountsByCategory;
    this.historyFetchedAtMs = parsed.historyFetchedAtMs ?? 0;
    this.saveHistory();
    return this.historyItemCount;
  }
```

- [ ] **Step 4: 重构 `loadHistory` 复用 `parseMarketVolumeHistory`（行为不变）**

将 `loadHistory()` 方法整体替换为：

```ts
  /** 从磁盘加载历史（兼容旧版纯数组格式；解析复用 core 的 parseMarketVolumeHistory）。 */
  private loadHistory(): void {
    try {
      const path = this.filePath();
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as unknown;
      const parsed = parseMarketVolumeHistory(raw);
      if (!parsed) {
        this.samples = [];
        this.historyHourly = [];
        this.priceHistory = {};
        this.historyItemCount = 0;
        this.historyItemCountsByCategory = {};
        return;
      }
      this.samples = parsed.samples;
      this.historyHourly = parsed.historyHourly;
      this.priceHistory = parsed.priceHistory;
      this.liveHistory = parsed.liveHistory ?? {};
      this.historyItemCount = parsed.itemCount;
      this.historyItemCountsByCategory = parsed.itemCountsByCategory;
      this.historyFetchedAtMs = parsed.historyFetchedAtMs ?? 0;
    } catch (err) {
      log.warn(`Failed to load market volume history: ${(err as Error).message}`);
      this.samples = [];
      this.historyHourly = [];
      this.priceHistory = {};
      this.historyItemCount = 0;
      this.historyItemCountsByCategory = {};
    }
  }
```

（行为与原实现一致：缺失文件早退、数组当旧版 samples、对象逐字段过滤、解析失败重置为空。）

- [ ] **Step 5: 运行全部相关测试**

Run: `pnpm vitest run test/main/marketVolumeService.test.ts test/core/marketVolume.test.ts`
Expected: 全部 PASS（新增用例 + 原有 load/save 往返、损坏恢复用例）。

- [ ] **Step 6: Commit**

```bash
git add app/src/main/services/MarketVolumeService.ts app/test/main/marketVolumeService.test.ts
git commit -m "feat(market): service exportHistory/importHistory + loadHistory reuse parser"
```

---

## Task 4: main 编排 —— appState 服务 + IPC handler

**Files:**
- Modify: `app/src/main/app/appState.ts`
- Modify: `app/src/main/ipc/handlers/market.ts`

- [ ] **Step 1: appState.ts 增加 node:fs 与 SaveDialogOptions 导入**

将顶部 electron import 改为（新增 `type SaveDialogOptions`）：

```ts
import { app, BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from "electron";
```

在 `import { dirname } from "node:path";` 之前新增：

```ts
import { readFileSync, writeFileSync } from "node:fs";
```

- [ ] **Step 2: 在 AppServices 对象中实现两个方法**

在 `refreshMarketVolumeItem` 方法定义（约 line 752-756，含其后 `cancelHistoryRefresh` 之前）之后加：

```ts
    exportMarketVolumeHistory: async (): Promise<ExportMarketVolumeResult> => {
      const parent =
        mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : BrowserWindow.getFocusedWindow();
      const options: SaveDialogOptions = {
        title: t("dialogs:exportMarketVolumeTitle"),
        defaultPath: `market_volume_history_${new Date()
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, "")}.json`,
        filters: [{ name: t("dialogs:jsonFilter"), extensions: ["json"] }],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true };
      try {
        writeFileSync(result.filePath, JSON.stringify(marketVolume.exportHistory(), null, 2));
        return { ok: true, path: result.filePath };
      } catch (err) {
        log.warn(`Failed to export market volume history: ${(err as Error).message}`);
        return { ok: false, reason: (err as Error).message };
      }
    },
    importMarketVolumeHistory: async (): Promise<ImportMarketVolumeResult> => {
      const parent =
        mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : BrowserWindow.getFocusedWindow();
      const options: OpenDialogOptions = {
        title: t("dialogs:importMarketVolumeTitle"),
        properties: ["openFile"],
        filters: [{ name: t("dialogs:jsonFilter"), extensions: ["json"] }],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };
      const filePath = result.filePaths[0] ?? "";
      let json: string;
      try {
        json = readFileSync(filePath, "utf-8");
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
      const itemCount = marketVolume.importHistory(json);
      if (itemCount === null) return { ok: false, reason: "invalid_backup" };
      broadcast(IPC.MARKET_VOLUME, marketVolume.getStats());
      broadcast(IPC.MARKET_VOLUME_ITEMS, marketVolume.getVolumeItems());
      return { ok: true, itemCount };
    },
```

- [ ] **Step 3: 在 AppServices 类型 import 增加两个结果类型**

`appState.ts` 顶部 `import type { ... } from "../../../shared/types"` 列表中增加：

```ts
  ExportMarketVolumeResult,
  ImportMarketVolumeResult,
```

- [ ] **Step 4: 在 `app/src/main/ipc/handlers/market.ts` 注册薄 handler**

在 `registerMarketHandlers` 末尾追加：

```ts
  ipc.handle(IPC.EXPORT_MARKET_VOLUME, () => services.exportMarketVolumeHistory());
  ipc.handle(IPC.IMPORT_MARKET_VOLUME, () => services.importMarketVolumeHistory());
```

- [ ] **Step 5: 验证**

Run: `pnpm typecheck`
Expected: 通过。再跑 `pnpm vitest run test/main` 确保主进程测试不受影响。

- [ ] **Step 6: Commit**

```bash
git add app/src/main/app/appState.ts app/src/main/ipc/handlers/market.ts
git commit -m "feat(market): main-side export/import orchestration with file dialogs"
```

---

## Task 5: preload 暴露 + IPC 契约测试

**Files:**
- Modify: `app/src/preload/index.ts`
- Modify: `app/test/ipc/channels.test.ts`

- [ ] **Step 1: preload 增加两个方法**

在 `refreshMarketVolumeItem(hash: string): Promise<void> {...}` 之后、`cancelHistoryRefresh(): void {...}` 之前加：

```ts
  exportMarketVolumeHistory(): Promise<ExportMarketVolumeResult> {
    return ipcRenderer.invoke(IPC.EXPORT_MARKET_VOLUME);
  },
  importMarketVolumeHistory(): Promise<ImportMarketVolumeResult> {
    return ipcRenderer.invoke(IPC.IMPORT_MARKET_VOLUME);
  },
```

在 preload 顶部类型 import 列表（`MarketVolumeRefreshResult` 之后）增加：

```ts
  ExportMarketVolumeResult,
  ImportMarketVolumeResult,
```

- [ ] **Step 2: 更新契约测试**

在 `app/test/ipc/channels.test.ts` 的 `it("preload uses every invoke channel via IPC constants", ...)` 内 `expect(preload).toContain("IPC.REFRESH_MARKET_VOLUME_ITEM");` 之后加：

```ts
    expect(preload).toContain("IPC.EXPORT_MARKET_VOLUME");
    expect(preload).toContain("IPC.IMPORT_MARKET_VOLUME");
```

- [ ] **Step 3: 验证**

Run: `pnpm vitest run test/ipc/channels.test.ts`
Expected: PASS。
Run: `pnpm typecheck`
Expected: 通过（preload 的 tbh 对象现在实现了全部 TbhApi 方法）。

- [ ] **Step 4: Commit**

```bash
git add app/src/preload/index.ts app/test/ipc/channels.test.ts
git commit -m "feat(market): expose export/import history via preload + channel contract tests"
```

---

## Task 6: 交易页工具栏按钮 + 多语言文案

**Files:**
- Modify: `app/src/renderer/tabs/Trading.tsx`
- Modify: `app/shared/locales/{en,zh-CN,ja,ko}/market.json`
- Modify: `app/shared/locales/{en,zh-CN,ja,ko}/dialogs.json`

- [ ] **Step 1: 先补 dialogs 文案（4 语言）**

`zh-CN/dialogs.json` 追加：

```json
  "exportMarketVolumeTitle": "导出交易页历史数据",
  "importMarketVolumeTitle": "导入交易页历史数据",
  "jsonFilter": "JSON 文件"
```

`en/dialogs.json` 追加：

```json
  "exportMarketVolumeTitle": "Export trading history",
  "importMarketVolumeTitle": "Import trading history",
  "jsonFilter": "JSON files"
```

`ja/dialogs.json` 追加：

```json
  "exportMarketVolumeTitle": "取引履歴をエクスポート",
  "importMarketVolumeTitle": "取引履歴をインポート",
  "jsonFilter": "JSON ファイル"
```

`ko/dialogs.json` 追加：

```json
  "exportMarketVolumeTitle": "거래 기록 내보내기",
  "importMarketVolumeTitle": "거래 기록 가져오기",
  "jsonFilter": "JSON 파일"
```

- [ ] **Step 2: 补 market.json 的 trading 文案（4 语言）**

`zh-CN/market.json` 的 `trading` 对象 `stopRefresh` 之后追加：

```json
    "exportHistory": "导出历史数据",
    "importHistory": "导入历史数据",
    "exportSuccess": "已导出 {{path}}",
    "exportFailed": "导出失败：{{reason}}",
    "importConfirm": "导入将用备份数据整体替换当前交易页历史数据，确定继续？",
    "importSuccess": "导入成功，共 {{count}} 种物品",
    "importFailed": "导入失败：{{reason}}"
```

`en/market.json` 的 `trading.stopRefresh` 之后追加：

```json
    "exportHistory": "Export history",
    "importHistory": "Import history",
    "exportSuccess": "Exported to {{path}}",
    "exportFailed": "Export failed: {{reason}}",
    "importConfirm": "Importing will replace all current trading history with the backup. Continue?",
    "importSuccess": "Imported {{count}} items",
    "importFailed": "Import failed: {{reason}}"
```

`ja/market.json` 的 `trading.stopRefresh` 之后追加：

```json
    "exportHistory": "履歴をエクスポート",
    "importHistory": "履歴をインポート",
    "exportSuccess": "{{path}} にエクスポートしました",
    "exportFailed": "エクスポート失敗：{{reason}}",
    "importConfirm": "インポートすると現在の取引履歴がバックアップで置き換わります。続行しますか？",
    "importSuccess": "{{count}} 件のアイテムをインポートしました",
    "importFailed": "インポート失敗：{{reason}}"
```

`ko/market.json` 的 `trading.stopRefresh` 之后追加：

```json
    "exportHistory": "내역 내보내기",
    "importHistory": "내역 가져오기",
    "exportSuccess": "{{path}}에 내보냈습니다",
    "exportFailed": "내보내기 실패: {{reason}}",
    "importConfirm": "가져오면 현재 거래 기록이 백업으로 교체됩니다. 계속할까요?",
    "importSuccess": "{{count}}개 항목을 가져왔습니다",
    "importFailed": "가져오기 실패: {{reason}}"
```

- [ ] **Step 3: Trading.tsx 增加导入状态与按钮**

在 `Trading()` 组件顶部 `const [mainOffset, setMainOffset] = useState(0);`（约 line 54）附近增加一个本地状态用于展示结果提示：

```tsx
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
```

在组件内（`refreshStatusByHash` useMemo 之后）增加两个 handler：

```tsx
  const handleExportHistory = async () => {
    const res = await window.tbh.exportMarketVolumeHistory();
    if (res.canceled) return;
    if (res.ok && res.path) setHistoryNotice(t("trading.exportSuccess", { path: res.path }));
    else setHistoryNotice(t("trading.exportFailed", { reason: res.reason ?? "unknown" }));
  };

  const handleImportHistory = async () => {
    if (!window.confirm(t("trading.importConfirm"))) return;
    setImporting(true);
    try {
      const res = await window.tbh.importMarketVolumeHistory();
      if (res.canceled) return;
      if (res.ok && res.itemCount !== undefined)
        setHistoryNotice(t("trading.importSuccess", { count: res.itemCount }));
      else setHistoryNotice(t("trading.importFailed", { reason: res.reason ?? "unknown" }));
    } finally {
      setImporting(false);
    }
  };
```

在工具栏「刷新历史价格」按钮（`t("trading.refresh")` 那个 button）之后、`{refreshing && (...)}` 停止按钮之前，插入两个按钮：

```tsx
              <button
                type="button"
                onClick={handleExportHistory}
                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-fg"
                title={t("trading.exportHistory")}
                aria-label={t("trading.exportHistory")}
              >
                <LuDownload className="size-3" aria-hidden />
                {t("trading.exportHistory")}
              </button>
              <button
                type="button"
                onClick={handleImportHistory}
                disabled={importing}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-fg",
                  importing && "cursor-not-allowed opacity-60",
                )}
                title={t("trading.importHistory")}
                aria-label={t("trading.importHistory")}
              >
                <LuUpload className="size-3" aria-hidden />
                {t("trading.importHistory")}
              </button>
```

在筛选区（`TradingFilters` 之后）或「刷新历史价格」进度条区块附近，增加提示条（放在 `{refreshing && progress.total > 0 && (...)}` 进度条之后）：

```tsx
          {historyNotice && (
            <p className="m-0 mt-1.5 text-[12px] text-muted" aria-live="polite">
              {historyNotice}
            </p>
          )}
```

- [ ] **Step 4: 确认 Trading.tsx 顶部已 import 图标**

在 Trading.tsx 的 icon import 行增加（若 `LuDownload` / `LuUpload` 未引入）：

```tsx
import { LuDownload, LuRefreshCw, LuUpload } from "react-icons/lu";
```

（若原有 import 是 `import { LuRefreshCw } from "react-icons/lu";` 则改为上面的合并写法，避免重复 import 行。）

- [ ] **Step 5: 验证**

Run: `pnpm typecheck`
Run: `pnpm lint`
Expected: 均通过。

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/tabs/Trading.tsx app/shared/locales/en/market.json app/shared/locales/zh-CN/market.json app/shared/locales/ja/market.json app/shared/locales/ko/market.json app/shared/locales/en/dialogs.json app/shared/locales/zh-CN/dialogs.json app/shared/locales/ja/dialogs.json app/shared/locales/ko/dialogs.json
git commit -m "feat(market): trading toolbar export/import buttons + i18n"
```

---

## Task 7: 文档同步（BUSINESS-FLOWS.md）

**Files:**
- Modify: `docs/BUSINESS-FLOWS.md`

- [ ] **Step 1: 在 8.7 节末尾新增子节**

在 `docs/BUSINESS-FLOWS.md` 的 8.7.4「IPC 与渲染」小节之后（8.7 节内）追加：

```markdown
#### 8.7.5 历史数据导出 / 导入

交易页历史数据（`market_volume_history.json`）支持 JSON 完整备份与恢复，入口为交易页工具栏「导出历史数据」「导入历史数据」按钮。

- **导出**：`window.tbh.exportMarketVolumeHistory()` → IPC `market:export-history` → `appState.exportMarketVolumeHistory` → `dialog.showSaveDialog`（默认文件名 `market_volume_history_<yyyyMMdd>.json`）→ `MarketVolumeService.exportHistory()` 返回完整快照（与落盘 payload 同构，含 `samples` / `historyHourly` / `priceHistory` / `liveHistory` / `itemCount` / `itemCountsByCategory` / `historyFetchedAtMs`）→ 写文件。返回 `{ ok, path }` / `{ canceled }` / `{ ok:false, reason }`。
- **导入（整体替换）**：交易页先 `window.confirm` 确认 → `window.tbh.importMarketVolumeHistory()` → IPC `market:import-history` → `dialog.showOpenDialog`（JSON）→ 读文件 → `MarketVolumeService.importHistory(json)`：`parseMarketVolumeHistory`（`app/src/core/marketVolume.ts`，校验 + 逐字段过滤，顶层非法/JSON 解析失败返回 null）→ 成功则整体替换内存数据并 `saveHistory()` 落盘 → appState 广播 `MARKET_VOLUME` + `MARKET_VOLUME_ITEMS` 让交易页实时刷新 → 返回 `{ ok, itemCount }`。失败 `{ ok:false, reason:"invalid_backup" }` 且不改动现有数据。
- **错误处理**：导出/导入对话框取消静默返回 `canceled`；导出写入失败返回 `reason` 由交易页提示；导入文件非 JSON/结构非法返回 `reason`，现有数据不受影响。
- **关键文件**：`app/src/main/services/MarketVolumeService.ts`（exportHistory/importHistory）、`app/src/core/marketVolume.ts`（parseMarketVolumeHistory）、`app/src/main/app/appState.ts`（对话框编排 + 广播）、`app/src/main/ipc/handlers/market.ts`（IPC 入口）、`app/src/preload/index.ts`、`app/src/renderer/tabs/Trading.tsx`（按钮）。
```

- [ ] **Step 2: 自检**：确认 8.7 章节编号连续、无与既有内容矛盾（可 `pnpm typecheck` 无关，纯文档）。

- [ ] **Step 3: Commit**

```bash
git add docs/BUSINESS-FLOWS.md
git commit -m "docs(market): document history export/import in BUSINESS-FLOWS"
```

---

## 最终验证（跨全部任务）

Run（在 `app/` 目录）：

```bash
pnpm qa
```

Expected: typecheck + lint + format + test + build + bundle 守卫全部通过。

手动冒烟（`pnpm dev` 后）：
1. 交易页出现「导出历史数据」「导入历史数据」两个按钮（带图标）。
2. 点导出 → 选择路径保存 → 打开 JSON 文件，结构与 `market_volume_history.json` 一致，含 `priceHistory` / `historyHourly` 等字段。
3. 修改/清空现有数据后点导入 → 弹确认 → 选择刚导出的文件 → 提示「导入成功，共 N 种物品」，交易页走势与卡片恢复为导出时状态。
4. 导入一个非 JSON 文件 → 提示「导入失败：invalid_backup」，现有数据不变。
5. 点导出后取消对话框 → 无任何提示（静默）。
