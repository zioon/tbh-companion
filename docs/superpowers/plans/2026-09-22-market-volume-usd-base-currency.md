# 交易页价格历史统一美元计价 + 融合导入实现计划

> **状态：已实施（2026-09-22）**，10 个 task 全部落地。实施中的补充与偏差见设计文档的
> 「实施记录」一节：`docs/superpowers/specs/2026-09-22-market-volume-usd-base-currency-design.md`。
> 本文件保留为原始实现计划与任务清单，事后的 checkbox 未逐条回填。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把交易页价格历史（`userData/market_volume_history.json`）的入库计价货币统一为 USD，展示时按图鉴 `fx` 换算到显示货币；切换显示货币不再销毁历史；导入改为「选文件 → 用户选备份币种 → 换算到 USD → 与现有数据融合」。

**Architecture:** 遵循四层架构。core 层新增基准货币常量、`mergeParsedHistory`（融合）与金额缩放纯函数；main 层 `MarketVolumeService` 在采集 / 校正 / 载入 / 落盘 / 导出 / 导入六处统一改为 USD 基准，并新增 `analyzeBackupJson` 摘要；`appState` 暂存备份路径并新增 analyze 编排；新增 1 个 IPC invoke 通道、`market:import-history` 增加参数；renderer 新增 `ImportHistoryDialog` 做币种选择。

**Tech Stack:** Electron + React + TypeScript + Vitest（`pnpm test` / `pnpm test:dom`），pnpm 包管理。

前置设计文档：`docs/superpowers/specs/2026-09-22-market-volume-usd-base-currency-design.md`

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|------|------|------|
| `app/shared/ipc.ts` | 修改 | + `ANALYZE_MARKET_VOLUME_BACKUP` 通道 + `IPC_INVOKE_CHANNELS` |
| `app/shared/types.ts` | 修改 | + `AnalyzeMarketVolumeBackupResult`；改 `ImportMarketVolumeResult`；`TbhApi` 签名 |
| `app/src/core/marketVolume.ts` | 修改 | + `MARKET_VOLUME_BASE_CURRENCY` / `mergeParsedHistory` / `rescaleMarketVolumeItems` / `rescaleVolumeStats` |
| `app/src/main/services/MarketVolumeService.ts` | 修改 | 六处 USD 化 + `analyzeBackupJson` + `displayRate()` + 出库缩放 + `onCurrencyChanged` 改 no-op |
| `app/src/main/app/appState.ts` | 修改 | 暂存 `pendingHistoryBackupPath`；+ `analyzeMarketVolumeBackup`；改 `importMarketVolumeHistory(args)` |
| `app/src/main/ipc/handlers/market.ts` | 修改 | + 1 handler；`IMPORT_MARKET_VOLUME` 透传 + 参数校验 |
| `app/src/preload/index.ts` | 修改 | + `analyzeMarketVolumeBackup()`；改 `importMarketVolumeHistory(args)` |
| `app/src/web/webTbhApi.ts` | 修改 | 两个方法同步（`desktop-only` 占位 + 签名一致） |
| `app/src/renderer/tabs/Trading.tsx` | 修改 | 两段式导入；移除 `window.confirm` |
| `app/src/renderer/components/market/ImportHistoryDialog.tsx` | 新增 | 摘要 + 币种选择 + 融合说明 |
| `app/shared/locales/{en,zh-CN,ja,ko}/market.json` | 修改 | `trading.*` 新增 / 删除文案 |
| `app/test/core/marketVolume.test.ts` | 修改 | + 融合 / 缩放用例 |
| `app/test/main/marketVolumeService.test.ts` | 修改 | + 迁移 / 切币不丢 / 采集入 USD / 融合导入 / 换算失败用例；改旧 `converted`·`currency_mismatch` 用例 |
| `app/test/ipc/channels.test.ts` | 修改 | + 新通道契约断言 |
| `docs/business-flows/06-market.md` | 修改 | §8.7.1 / §8.7.2 / §8.7.3 / §8.7.5 同步 |
| `docs/BUSINESS-FLOWS.md`、`CHANGELOG.md` | 修改 | 索引与变更记录同步 |

**术语约定（全文统一）：**
- **基准货币 / base currency** = `MARKET_VOLUME_BASE_CURRENCY` = `"USD"`，指入库计价货币。
- **显示货币 / display currency** = `config.currency`，指用户界面展示与格式化所用货币。
- `fx[ISO]` = 图鉴快照 `LookupPriceSnapshot.fx`，语义是「每 1 USD 的该币单位数」。故 USD→显示货币乘 `fx[display]`，显示货币→USD 除 `fx[display]`。
- `analyzeMarketVolumeBackup()`（appState + IPC，含对话框 + 读文件 + 摘要）与 `analyzeBackupJson(json)`（服务方法，纯解析摘要）不是同一个。
- `importMarketVolumeHistory(args)`（appState + IPC，含读文件 + 融合 + 广播）与 `importHistory(json, sourceCurrency)`（服务方法，纯数据操作）不是同一个。

---

## Task 1: core 层 —— 基准货币常量、融合、金额缩放

**Files:**
- Modify: `app/src/core/marketVolume.ts`
- Test: `app/test/core/marketVolume.test.ts`

- [ ] **Step 1: 新增基准货币常量**

在 `VOLUME_CATEGORY_OTHER` 常量附近加：

```ts
/**
 * 交易页价格历史的入库计价货币。所有金额类字段（samples / historyHourly /
 * priceHistory / liveHistory）在内存与磁盘上统一以该货币计价，展示时按图鉴 fx
 * 汇率表换算到用户显示货币。这样切换显示货币不再需要清空历史。
 */
export const MARKET_VOLUME_BASE_CURRENCY = "USD";
```

- [ ] **Step 2: 先写失败测试（`app/test/core/marketVolume.test.ts` 追加 describe 块）**

覆盖：不同 UTC 天并集、同天保留点数更多一方、相同数据幂等、`samples` 同 `timestamp` 去重、`liveHistory` 同 `ts` 去重、`historyFetchedAtMs` 取 max、`lastRefreshAt` 每 hash 取 max、输出 `version: 2` / `currency: "USD"`。

- [ ] **Step 3: 运行测试确认失败**

```
cd app && pnpm vitest run test/core/marketVolume.test.ts
```

预期：因 `mergeParsedHistory` 未定义而失败（TS 报错 / import undefined）。

- [ ] **Step 4: 实现 `mergeParsedHistory`**

追加到 `mergePriceHistoryPoints` 之后：

```ts
/** {@link mergeParsedHistory} 的返回：融合后的快照 + 增量摘要（供 UI 提示）。 */
export interface MergedMarketVolumeHistory {
  merged: ParsedMarketVolumeHistory;
  /** 融合后 priceHistory 中「新增或有更新」的 hash 数。 */
  addedHashes: number;
  /** 融合后 samples 新增条数。 */
  addedSamples: number;
  /** 融合后 liveHistory 新增采样点数。 */
  addedLivePoints: number;
}

/**
 * 融合两份价格历史快照（导入用）。与「整体替换」不同，本函数保留双方数据：
 * - `priceHistory`：逐 hash 用 {@link mergePriceHistoryPoints}（按 UTC 天保留更细粒度，
 *   相等取 incoming）——「天」为最小融合单元，天然避免同一小时重复计数；
 * - `samples` / `liveHistory`：按时间键去重合并（同键取 incoming），升序后裁剪到
 *   各自上限（保留最新）；
 * - `historyHourly` / `itemCount` / `itemCountsByCategory` 为派生于 `priceHistory` 的
 *   字段，**不直接合并**，由调用方在融合后重算（见 MarketVolumeService）；
 * - `historyFetchedAtMs` 取 max，`lastRefreshAt` 每 hash 取 max（不倒退每日兜底）。
 *
 * 两份快照的金额必须已是同一基准货币（{@link MARKET_VOLUME_BASE_CURRENCY}），
 * 换算由调用方在此之前完成。
 */
export function mergeParsedHistory(
  existing: ParsedMarketVolumeHistory,
  incoming: ParsedMarketVolumeHistory,
  limits: { maxSamples: number; maxLivePointsPerHash: number },
): MergedMarketVolumeHistory { /* ... */ }
```

实现要点：
- `priceHistory`：并集 hash；对每个 hash `mergePriceHistoryPoints(existing[hash] ?? [], incoming[hash] ?? [])`；`addedHashes` = 融合后点数严格多于 existing 的 hash 数。
- `samples`：以 `timestamp` 为键建 `Map`，先塞 existing 再塞 incoming（后者覆盖）；按 timestamp 升序；`slice(-maxSamples)`。
- `liveHistory`：逐 hash 以 `ts` 为键建 `Map` 合并，升序，`slice(-maxLivePointsPerHash)`；某 hash 结果为空则删除该键。
- 输出 `{ ...existing, version: 2, currency: MARKET_VOLUME_BASE_CURRENCY, priceHistory, samples, liveHistory, historyFetchedAtMs: Math.max(...), lastRefreshAt: 逐 hash max }`，`historyHourly` / `itemCount` / `itemCountsByCategory` 暂用 existing 值（调用方重算覆盖）。

- [ ] **Step 5: 实现金额缩放纯函数**

```ts
/**
 * 把「基准货币（USD）」的成交额卡片缩放到显示货币（rate = fx[display]）。
 * 缩放 `total` 与每个走势点的 `price` / `total`；`rate` 无效（非有限 / <= 0）时
 * 原样返回浅拷贝，避免把 USD 数值按错误比例放大。
 */
export function rescaleMarketVolumeItems(
  items: readonly MarketVolumeItem[],
  rate: number,
): MarketVolumeItem[];

/**
 * 同上，作用于 {@link MarketVolumeStats} 的 `latest`（含 byCategory）与 `hourly`
 * （含 byCategory），并把 `currency` 设为 `currency` 参数（显示货币）。
 */
export function rescaleVolumeStats(
  stats: MarketVolumeStats,
  rate: number,
  currency: string,
): MarketVolumeStats;
```

- [ ] **Step 6: 跑测试至全绿**

```
cd app && pnpm vitest run test/core/marketVolume.test.ts
```

- [ ] **Step 7: 提交**

```bash
git add app/src/core/marketVolume.ts app/test/core/marketVolume.test.ts
git commit -m "feat(marketVolume): add usd base currency constant, history merge and amount rescale helpers"
```

---

## Task 2: main —— 采集与历史校正改为 USD 基准

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts`

- [ ] **Step 1: 引入常量与出库缩放辅助**

`import` 里加入 `MARKET_VOLUME_BASE_CURRENCY`、`rescaleMarketVolumeItems`、`rescaleVolumeStats`。新增私有方法：

```ts
/**
 * 出库换算比例：基准货币（USD）→ 显示货币。`fx[display]` 有效时返回该值；
 * 显示货币即 USD 时返回 1；fx 缺失（快照未就绪）或该币种不在表中时返回 1 且
 * 标记 `currency: "USD"`——宁可标 USD 也不把 USD 数值标成其他币种。
 */
private displayRate(): { rate: number; currency: string } {
  const display = this.deps.getCurrency().toUpperCase();
  if (display === MARKET_VOLUME_BASE_CURRENCY) return { rate: 1, currency: display };
  const fx = this.deps.getFxRates?.() ?? {};
  const r = fx[display];
  if (typeof r === "number" && Number.isFinite(r) && r > 0) return { rate: r, currency: display };
  log.warn(`displayRate: fx missing for ${display}; falling back to USD display`);
  return { rate: 1, currency: MARKET_VOLUME_BASE_CURRENCY };
}
```

- [ ] **Step 2: `recordVolume` 入 USD**

保留现有「`currency` 与显示货币不符则丢弃」的竞态护栏（它防的是「cycle 跨切币窗口」，与基准货币无关），护栏通过后加换算：

```ts
    // 采样 median 以显示货币计价；入库统一为基准货币（USD）。
    const fx = this.deps.getFxRates?.() ?? {};
    const rate = currency.toUpperCase() === MARKET_VOLUME_BASE_CURRENCY
      ? 1
      : fx[currency.toUpperCase()];
    if (!(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) {
      log.debug(`recordVolume: drop sample for ${hash} (no fx rate for ${currency})`);
      return;
    }
    const medianUsd = median == null ? null : median / rate;
    this.live.set(hash, { volume, median: medianUsd });
    // ... liveHistory 累积同样用 medianUsd
```

- [ ] **Step 3: `buildSample` / `aggregateVolume` 用基准货币**

`buildSample` 里 `aggregateVolume(itemsByHash, this.live, MARKET_VOLUME_BASE_CURRENCY, ...)`。

- [ ] **Step 4: `maybeCalibrateHistory` 改名 `calibrateHistoryToBase` 并把锚改为 USD**

- 币种比较基准由 `this.deps.getCurrency()` 改为 `MARKET_VOLUME_BASE_CURRENCY`；
- `fetchMedian(hash, MARKET_VOLUME_BASE_CURRENCY)`；
- 日志里的目标货币同步改为常量值。

- [ ] **Step 5: `refreshItem` / `refreshHistory` 内的调用同步改名**

两处 `await this.maybeCalibrateHistory(...)` → `await this.calibrateHistoryToBase(...)`。

- [ ] **Step 6: 验证采集链路单测**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

预期：现有用例（未断言币种的部分）应通过；若有用例断言 `live.median` 为显示货币量级，在本 task 内按 USD 量级修正。

- [ ] **Step 7: 提交**

```bash
git add app/src/main/services/MarketVolumeService.ts
git commit -m "feat(marketVolume): record polling samples and price history in usd base currency"
```

---

## Task 3: main —— 出库按 fx 换算到显示货币

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts`
- Test: `app/test/main/marketVolumeService.test.ts`

- [ ] **Step 1: 先写失败测试**

新增用例（`makeService` 注入 `getCurrency: () => "CNY"`、`getFxRates: () => ({ USD: 1, CNY: 7 })`）：

- **采集入 USD**：`recordVolume(hash, 100, 7, "CNY")` 后，内部 `live` 的 `median` ≈ 1（USD）；`getVolumeItems().items[0].total` ≈ 700（CNY 展示）。
- **出库换算**：`getStats().latest.total` 为 USD 值 × 7；`getStats().currency === "CNY"`。
- **fx 缺失**：`getFxRates: () => ({})`、`getCurrency: () => "CNY"` → 金额为 USD 原值且 `currency === "USD"`。

- [ ] **Step 2: 运行确认失败**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 3: 在四个出口接入缩放**

- `getStats()`：先算 USD 的 `latest` / `hourly`（含采样回退分支 `aggregateSamplesToTrend`），最后 `return rescaleVolumeStats({ latest, hourly, itemCount, itemCountsByCategory, currency: MARKET_VOLUME_BASE_CURRENCY }, rate, currency)`；
- `getVolumeItems()`：`return { items: rescaleMarketVolumeItems(merged, rate), currency }`；
- `buildItemForHash()`：对 `aggregateItemVolume` 结果套 `rescaleMarketVolumeItems(agg, rate)`（同样对空白兜底卡片套一次，`total: 0` 缩放无损）；
- `buildPendingItems()`：走 `getVolumeItems()`，自动覆盖——确认无绕开该方法的路径。

- [ ] **Step 4: 跑测试至全绿**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add app/src/main/services/MarketVolumeService.ts app/test/main/marketVolumeService.test.ts
git commit -m "feat(marketVolume): convert stored usd amounts to the display currency on read"
```

---

## Task 4: main —— 切币不再清账

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts`
- Test: `app/test/main/marketVolumeService.test.ts`

- [ ] **Step 1: 先写失败测试**

- `recordVolume(hash, 100, 1, "USD")` + `sampleNow()` 后调 `onCurrencyChanged()`，断言 `getStats().latest` 非 null 且 `hourly` 非空（**旧行为会被清空**）。
- 切币后 `getStats().currency` 为新币。

- [ ] **Step 2: 运行确认失败**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 3: 把 `onCurrencyChanged` 改为无副作用**

```ts
  /**
   * 显示货币变更钩子。金额已统一以 {@link MARKET_VOLUME_BASE_CURRENCY} 入库，
   * 与显示货币无关，故**不再清账**——调用方（appState / configPatch）只需在调用
   * 后重新广播 `MARKET_VOLUME` / `MARKET_VOLUME_ITEMS`，展示层会按新的 fx 重新换算。
   * 保留该方法作为切币语义的锚点与日志位。
   */
  onCurrencyChanged(): void {
    log.info(
      `onCurrencyChanged: no-op (base currency is ${MARKET_VOLUME_BASE_CURRENCY}, ` +
        `display is ${this.deps.getCurrency()})`,
    );
  }
```

- [ ] **Step 4: 跑测试至全绿**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add app/src/main/services/MarketVolumeService.ts app/test/main/marketVolumeService.test.ts
git commit -m "fix(marketVolume): keep history when the display currency changes"
```

---

## Task 5: main —— 载入迁移旧文件到 USD（version 2）

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts`
- Test: `app/test/main/marketVolumeService.test.ts`

- [ ] **Step 1: 先写失败测试**

- **CNY v1 文件迁移**：写入 `{ currency: "CNY", samples: [{ timestamp, total: 700, currency: "CNY" }] }`，服务以 `getCurrency: () => "USD"` + `fx = { USD: 1, CNY: 7 }` 构造 → `getStats().latest.total` ≈ 100（USD），且落盘文件含 `version: 2` / `currency: "USD"`。
- **旧格式推断迁移**：无顶层 `currency`，`samples[].currency` 全为 `"CNY"` → 同样换算并落盘 v2。
- **fx 缺失兜底**：`fx = { USD: 1 }` → 金额被丢弃（`getStats().hourly` 为空），与现状一致的回归护栏。
- **已是 USD 的 v2 文件**：原值保留、不被二次换算。

- [ ] **Step 2: 运行确认失败**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 3: 重写 `confirmFileCurrency` 为 `resolveFileCurrency` + 新增 `toBaseCurrency`**

```ts
  /** 解析历史文件的计价货币：顶层 `currency` 优先，缺失时从 samples 推断。 */
  private resolveFileCurrency(parsed: ParsedMarketVolumeHistory): {
    currency: string | null;
    inferred: boolean;
  };

  /**
   * 把已解析快照的金额归一化到基准货币（USD）。
   * - 已是基准货币 → 原样返回；
   * - 非基准货币且 `fx[该币]` 有效 → `rescaleParsedHistory(parsed, 1 / fx[该币])`；
   * - 币种不可知或 fx 不可得 → 返回 null（调用方丢弃金额并 warn，保持保守语义）。
   */
  private toBaseCurrency(
    parsed: ParsedMarketVolumeHistory,
  ): { data: ParsedMarketVolumeHistory; convertedFrom: string | null } | null;
```

- [ ] **Step 4: 改写 `loadHistory`**

流程：`parse` → `resolveFileCurrency` → `toBaseCurrency` → 命中则装载（`samples` / `historyHourly` / `priceHistory` / `liveHistory` / 计数 / `historyFetchedAtMs` / `lastRefreshAt`）+ `saveHistory()` 落盘迁移为 v2；`toBaseCurrency` 返回 null 且有金额数据 → `resetVolumeData()` + warn（不再因「与显示货币不符」而丢弃）。

- [ ] **Step 5: `saveHistory` / `exportHistory` 写 `version: 2` + `currency: MARKET_VOLUME_BASE_CURRENCY`**

`PersistedMarketVolume` 的 `version` 类型注释改为 `2`，`currency` 注释改为「本文件金额的计价货币；v2 起恒为 USD」。保留写 `currency: "USD"` 是刻意为之：旧版应用（只认 `currency`）读 v2 备份时会走 fx 换算，得到正确结果。

- [ ] **Step 6: 跑测试至全绿**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 7: 提交**

```bash
git add app/src/main/services/MarketVolumeService.ts app/test/main/marketVolumeService.test.ts
git commit -m "feat(marketVolume): migrate persisted history to usd base currency (v2)"
```

---

## Task 6: main —— 导入融合 + 备份摘要

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts`
- Test: `app/test/main/marketVolumeService.test.ts`

- [ ] **Step 1: 先写失败测试**

- **融合导入**：现有历史覆盖 hash A（第 1 天），导入覆盖 hash B（第 2 天）的备份 → 融合后 `getStats().itemCount === 2`，`hourly` 含两天。
- **幂等**：同一备份连续导入两次 → `getVolumeItems().items` 的 `total` 与 `hourly` 长度不变。
- **币种换算**：备份 `currency: "CNY"` + 用户 `sourceCurrency: "CNY"` + `fx = { USD: 1, CNY: 7 }` → 返回 `converted: { from: "CNY", rate: 1/7 }`，落盘金额为 USD。
- **转换不可得**：备份 `currency: "XYZ"`、fx 空且无共同 hash → `{ ok:false, reason:"conversion_unavailable" }`，且现有数据不变。
- **摘要**：`analyzeBackupJson` 返回的 `itemCount` / `priceHashCount` / `pricePointCount` / `oldestTs` / `newestTs` 正确。

- [ ] **Step 2: 运行确认失败**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 3: 新增 `analyzeBackupJson`**

```ts
  /**
   * 解析备份 JSON 并生成导入前摘要（供 UI 展示与币种选择）。
   * 纯解析，不改动内存态与磁盘。失败返回 `{ ok:false, reason:"invalid_backup" }`。
   */
  analyzeBackupJson(json: string): {
    ok: true;
    detectedCurrency: string | null;
    baseCurrencyFile: boolean;
    itemCount: number;
    priceHashCount: number;
    pricePointCount: number;
    oldestTs: number | null;
    newestTs: number | null;
  } | { ok: false; reason: "invalid_backup" };
```

`baseCurrencyFile = parsed.version != null && parsed.version >= 2`；`pricePointCount` 为全部 hash 点数之和；时间范围取 `priceHistory` 全部 `timestamp` 的 min / max。

- [ ] **Step 4: 改写 `importHistory(json, sourceCurrency)`**

签名与返回：

```ts
  importHistory(
    json: string,
    sourceCurrency: string,
  ):
    | { ok: true; itemCount: number; mergedHashes: number; mergedSamples: number; mergedLivePoints: number; converted?: { from: string; rate: number } }
    | { ok: false; reason: "invalid_backup" | "conversion_unavailable" }
```

流程：
1. `JSON.parse` + `parseMarketVolumeHistory` → 失败 `invalid_backup`；
2. 归一化：`src = sourceCurrency.toUpperCase()`；`src === USD` → 原样；否则 `rate = 1 / fx[src]`；fx 不可得则回退 `computeConversionRate({ from: src, to: USD, fx, backupPriceHistory, currentPriceHistory: this.priceHistory })`；仍为 null → `conversion_unavailable`（**不改动现有数据**）；
3. `mergeParsedHistory({ samples: this.samples, historyHourly: this.historyHourly, priceHistory: this.priceHistory, liveHistory: this.liveHistory, itemCount: this.historyItemCount, itemCountsByCategory: this.historyItemCountsByCategory, historyFetchedAtMs: this.historyFetchedAtMs, lastRefreshAt: this.lastRefreshAt }, merged)`, limits 用 `MAX_SAMPLES` / `MAX_LIVE_POINTS_PER_HASH`；
4. 装载 `merged` → `recomputeHistoryTrend()`（重算 `historyHourly` / `itemCount` / `itemCountsByCategory`；重算为空则保留融合值）→ `saveHistory()`；
5. 返回增量摘要与 `converted`。

> 注意：`incoming` 侧的「现有快照」由内部字段拼出，不要直接把 `this` 传进 core（core 不得依赖 main 类型）。

- [ ] **Step 5: 跑测试至全绿**

```
cd app && pnpm vitest run test/main/marketVolumeService.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add app/src/main/services/MarketVolumeService.ts app/test/main/marketVolumeService.test.ts
git commit -m "feat(marketVolume): merge imported backups into existing history with currency conversion"
```

---

## Task 7: IPC 契约与 appState 编排

**Files:**
- Modify: `app/shared/ipc.ts`、`app/shared/types.ts`、`app/src/main/ipc/handlers/market.ts`、`app/src/main/app/appState.ts`、`app/src/preload/index.ts`、`app/src/web/webTbhApi.ts`
- Test: `app/test/ipc/channels.test.ts`

- [ ] **Step 1: `app/shared/ipc.ts` 新增通道**

在 `IMPORT_MARKET_VOLUME` 之后加 `ANALYZE_MARKET_VOLUME_BACKUP: "market:analyze-history-backup"`，并加入 `IPC_INVOKE_CHANNELS`。

- [ ] **Step 2: `app/shared/types.ts` 改契约**

- + `AnalyzeMarketVolumeBackupResult`（字段见设计文档 §6）；
- `ImportMarketVolumeResult`：`converted` 改为 `{ from: string; rate: number }`；+ `mergedHashes` / `mergedSamples` / `mergedLivePoints`；`reason` 增加 `"no_pending_backup" | "conversion_unavailable"`；删除已无意义的「整体替换」措辞注释；
- `TbhApi`：+ `analyzeMarketVolumeBackup(): Promise<AnalyzeMarketVolumeBackupResult>`；`importMarketVolumeHistory(args: { sourceCurrency: string }): Promise<ImportMarketVolumeResult>`。

- [ ] **Step 3: `app/src/main/ipc/handlers/market.ts`**

```ts
  ipc.handle(IPC.ANALYZE_MARKET_VOLUME_BACKUP, () => services.analyzeMarketVolumeBackup());
  ipc.handle(IPC.IMPORT_MARKET_VOLUME, (_e, args: unknown) => {
    const sourceCurrency =
      args && typeof args === "object" && isNonEmptyString((args as { sourceCurrency?: unknown }).sourceCurrency)
        ? (args as { sourceCurrency: string }).sourceCurrency
        : undefined;
    return sourceCurrency === undefined
      ? Promise.resolve({ ok: false, reason: "invalid_backup" })
      : services.importMarketVolumeHistory({ sourceCurrency });
  });
```

- [ ] **Step 4: `app/src/main/app/appState.ts`**

- 模块作用域或 `createAppState` 闭包内加 `let pendingHistoryBackupPath: string | null = null`；
- + `analyzeMarketVolumeBackup()`：`dialog.showOpenDialog`（复用现有 `dialogs:importMarketVolumeTitle` / `jsonFilter`）→ 读文件 → `marketVolume.analyzeBackupJson(json)` → 成功后 `pendingHistoryBackupPath = path` → 返回摘要（**不返回完整路径**，只给 `fileName`）；
- 改 `importMarketVolumeHistory({ sourceCurrency })`：`pendingHistoryBackupPath` 为空 → `{ ok:false, reason:"no_pending_backup" }`；否则读文件 → `marketVolume.importHistory(json, sourceCurrency)` → 成功后广播 `MARKET_VOLUME` + `MARKET_VOLUME_ITEMS` → 清空暂存 → 返回结果；
- 切币分支（`setCurrency` 内 `marketVolume.onCurrencyChanged()` 与 `configPatch` 的 `onCurrencyChanged` deps）**保留调用与广播**，仅把注释从「清账」改为「重广播（换算后数据）」；
- `AppServices` 类型加 `analyzeMarketVolumeBackup`。

- [ ] **Step 5: `app/src/preload/index.ts` 与 `app/src/web/webTbhApi.ts`**

- preload：`analyzeMarketVolumeBackup()` → `ipcRenderer.invoke(IPC.ANALYZE_MARKET_VOLUME_BACKUP)`；`importMarketVolumeHistory(args)` 透传参数；
- web：`analyzeMarketVolumeBackup: () => Promise.resolve({ ok: false, error: "desktop-only" })`（与既有 `exportMarketVolumeHistory` 占位风格一致）；`importMarketVolumeHistory: (args) => Promise.resolve({ ok: false, error: "desktop-only" })`（签名保持一致）。

- [ ] **Step 6: `app/test/ipc/channels.test.ts` 加断言**

+ `IPC.ANALYZE_MARKET_VOLUME_BACKUP` 存在且在 `IPC_INVOKE_CHANNELS` 中。

- [ ] **Step 7: 跑测试与类型检查**

```
cd app && pnpm vitest run test/ipc/channels.test.ts && pnpm typecheck
```

- [ ] **Step 8: 提交**

```bash
git add app/shared/ipc.ts app/shared/types.ts app/src/main/ipc/handlers/market.ts app/src/main/app/appState.ts app/src/preload/index.ts app/src/web/webTbhApi.ts app/test/ipc/channels.test.ts
git commit -m "feat(ipc): expose market history backup analysis and parameterized import"
```

---

## Task 8: renderer —— 两段式导入 + 币种选择

**Files:**
- Modify: `app/src/renderer/tabs/Trading.tsx`
- Create: `app/src/renderer/components/market/ImportHistoryDialog.tsx`
- Modify: `app/shared/locales/{en,zh-CN,ja,ko}/market.json`

- [ ] **Step 1: 新增 `ImportHistoryDialog.tsx`**

参考 `app/src/renderer/components/loot/ClassifyPromptDialog.tsx` 与设计系统 `design-system/primitives/Dialog/Dialog.tsx` 的现有用法。Props：

```tsx
interface ImportHistoryDialogProps {
  /** analyze 返回的摘要（ok=true 才会渲染本组件）。 */
  summary: AnalyzeMarketVolumeBackupResult;
  /** 用户确认时回传其选择的备份币种 ISO。 */
  onConfirm: (sourceCurrency: string) => void;
  onCancel: () => void;
  busy?: boolean;
}
```

内容：
- 摘要行：`fileName`、`itemCount`、`priceHashCount` / `pricePointCount`、时间范围（`oldestTs`/`newestTs` 转本地时间；为 null 时显示占位）；
- **备份币种** `Select`：`options = STEAM_CURRENCIES.map(c => ({ value: c.iso, label: `${c.iso} - ${c.label}` }))`；默认值 `summary.detectedCurrency ?? "USD"`；`baseCurrencyFile === true` → `disabled` + `trading.importCurrencyLocked` 提示；`detectedCurrency == null` → 附 `trading.importCurrencyUnknown` 提示；
- 融合说明 `trading.importMergeNotice`；
- 按钮：取消 / 融合导入（`busy` 时禁用）。

- [ ] **Step 2: 改 `Trading.tsx` 导入流程**

- 新 state：`const [importSummary, setImportSummary] = useState<AnalyzeMarketVolumeBackupResult | null>(null)`；
- `handleImportHistory()`：调 `window.tbh.analyzeMarketVolumeBackup()`；`canceled` → 静默；`ok` → `setImportSummary(res)`；失败 → `setHistoryNotice(t("trading.importFailed", { reason: res.reason ?? "unknown" }))`；
- `handleConfirmImport(sourceCurrency)`：`setImporting(true)` → `window.tbh.importMarketVolumeHistory({ sourceCurrency })` → 成功提示（`converted` 有值时用 `trading.importMergedConverted`，否则 `trading.importMerged`，带 `count: itemCount`）→ 失败按 `reason` 分派提示（`no_pending_backup` → `trading.importNoPending`，`conversion_unavailable` → `trading.importConversionUnavailable`，其余 `trading.importFailed`）→ 关闭对话框；
- 移除 `window.confirm(t("trading.importConfirm"))`。

- [ ] **Step 3: 文案（4 语言）**

`app/shared/locales/{en,zh-CN,ja,ko}/market.json` 的 `trading` 下新增：

- `importTitle`、`importMergeNotice`、`importSourceCurrency`、`importCurrencyUnknown`、`importCurrencyLocked`、`importMerged`、`importMergedConverted`、`importNoPending`、`importConversionUnavailable`、`importSummaryItems`、`importSummaryPoints`、`importSummaryRange`、`importConfirmButton`、`cancel`（若已有通用取消文案则复用）；
- 删除已无引用的 `importConfirm` / `importConverted` / `importCurrencyMismatch`（确认全仓无引用后再删）。

zh-CN 示例值：
- `importMergeNotice`: `"导入将与此前的历史数据融合（按时间合并、不覆盖），不会清空现有数据。"`
- `importMerged`: `"融合导入成功，当前共 {{count}} 种物品"`
- `importMergedConverted`: `"融合导入成功（已从 {{from}} 换算为美元），当前共 {{count}} 种物品"`
- `importCurrencyLocked`: `"该备份已统一以美元存储，无需选择币种。"`
- `importCurrencyUnknown`: `"无法自动识别备份币种，请手动选择。"`
- `importConversionUnavailable`: `"导入失败：缺少该币种的汇率，无法换算为美元。"`

- [ ] **Step 4: 类型检查 + DOM 测试 + lint/format**

```
cd app && pnpm typecheck && pnpm test:dom
```

- [ ] **Step 5: 提交**

```bash
git add app/src/renderer/tabs/Trading.tsx app/src/renderer/components/market/ImportHistoryDialog.tsx app/shared/locales
git commit -m "feat(trading): two-step history import with backup currency selection and merge"
```

---

## Task 9: 文档与变更记录同步（强制）

**Files:**
- Modify: `docs/business-flows/06-market.md`、`docs/BUSINESS-FLOWS.md`、`CHANGELOG.md`

- [ ] **Step 1: `docs/business-flows/06-market.md`**

- §8.7.1：`maybeCalibrateHistory` → `calibrateHistoryToBase`，锚货币说明改为基准货币 USD；
- §8.7.2「持久化结构（含货币标记）」→「持久化结构（USD 单一计价，version 2）」，说明各金额字段均为 USD、`currency` 恒为 `"USD"`（含向下兼容理由）、`onCurrencyChanged` 改为 no-op、`recordVolume` 入 USD 换算、`getStats`/`getVolumeItems` 出库缩放与 fx 缺失兜底；
- §8.7.3「多货币同步政策」整节重写为「USD 基准货币政策」：入库换算表、出库换算表、切币不清账、载入迁移规则（含 fx 缺失丢弃兜底）、导入换算与错误路径；
- §8.7.5「历史数据导出 / 导入」→「历史数据导出 / 融合导入」：两段式 analyze + import 流程、`pendingHistoryBackupPath` 暂存与 `no_pending_backup`、融合规则表（含「同 UTC 天取更细粒度」的已知取舍）、错误处理表、更新关键文件速查表。

- [ ] **Step 2: `docs/BUSINESS-FLOWS.md`**

检查 §18 跨服务数据流总览与 §20 关键文件路径速查中涉及 `market_volume_history.json` / `currency` 的表述并同步。

- [ ] **Step 3: `CHANGELOG.md`**

新增条目（用户可见行为变更）：价格历史统一以美元存储；切换显示货币不再清空历史；历史数据导入改为「选择备份币种 + 融合」。

- [ ] **Step 4: 提交**

```bash
git add docs/business-flows/06-market.md docs/BUSINESS-FLOWS.md CHANGELOG.md
git commit -m "docs(market): document the usd base currency model and merge import"
```

---

## Task 10: 全量验证

- [ ] **Step 1: 分项跑 QA（本机 `pnpm qa` 因 wmic 受限不可用，见 `docs/agent/WINDOWS.md`）**

```
cd app && pnpm typecheck
cd app && pnpm lint
cd app && pnpm format:check
cd app && pnpm test
cd app && pnpm test:dom
cd app && pnpm build
```

- [ ] **Step 2: 人工冒烟（`pnpm qa:dev` 或 `pnpm dev`）**

1. 显示货币设为 CNY，拉起轮询与历史刷新，确认 Market / 交易页有数据；
2. 设置里切到 USD → 交易页历史**仍在**（旧行为会清零），金额量级 ≈ 原值 ÷ 7；
3. 切回 CNY → 历史仍在，金额还原（允许 fx 带来的浮点级偏差）；
4. 导出历史 → 检查文件含 `"version": 2` 且 `"currency": "USD"`；
5. 导出一份 CNY 时期的旧备份（或手工把导出文件的 `currency` 改成 `"CNY"`、金额乘 7）→ 导入 → 对话框显示探测币种 `CNY` → 确认融合 → 提示「已从 CNY 换算为美元」，卡片金额与融合前一致；
6. 同一个备份再导入一次 → 金额与图表**不翻倍**。

- [ ] **Step 3: 记录内存/磁盘影响**

对比改动前后 `market_volume_history.json` 体积（格式未变，仅金额单位变化，体积应基本一致）。

- [ ] **Step 4: 终检清单**

- [ ] `pnpm typecheck` / `lint` / `format:check` / `test` / `test:dom` / `build` 全绿；
- [ ] `docs/business-flows/06-market.md` 与 `docs/BUSINESS-FLOWS.md` 已同步；
- [ ] `CHANGELOG.md` 已记；
- [ ] 无残留 `importConfirm` / `importConverted` / `importCurrencyMismatch` 引用；
- [ ] 人工冒烟第 1–6 步全部通过。
