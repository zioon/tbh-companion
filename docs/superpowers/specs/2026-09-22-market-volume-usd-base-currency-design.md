# 交易页价格历史统一美元计价 + 融合导入设计

> 日期：2026-09-22
> 状态：**已实施**（2026-09-22），与本节描述的差异见文末「实施记录」
> 前置：`docs/superpowers/specs/2026-08-25-market-volume-export-import-design.md`（导出 / 导入首版，整体替换语义）

## 背景与问题

交易页（Trading）的价格历史（`userData/market_volume_history.json`）当前以**「入库时的显示货币」**计价：

- `saveHistory` / `exportHistory` 把当前 `config.currency` 写进顶层 `currency` 字段；
- `samples` / `historyHourly` / `priceHistory` / `liveHistory` 全部金额随显示货币变化；
- `maybeCalibrateHistory` 把 Steam `pricehistory` 的区域锁定货币校正到**显示货币**；
- `recordVolume` 用显示货币的 `median` 采样。

由此产生三个真实痛点：

| 痛点 | 现状行为 | 后果 |
|------|----------|------|
| **切币即丢历史** | `onCurrencyChanged()` → `resetVolumeData()` + 落盘 | 用户切一次显示货币，全部历史价格/成交额清零，只能靠重新拉 Steam 重建（受 pricehistory 限流，成本极高） |
| **异币备份被丢弃** | `loadHistory` 确认文件币种与显示货币不符 → `resetVolumeData()` | 换机/换币后重启，本地历史被静默丢弃 |
| **导入只有「整体替换」** | `importHistory` 直接覆盖内存数据 | 无法把多台机器 / 多次备份的历史**累积**起来；异币备份还要么自动换算（fx 可得）要么被拒（`currency_mismatch`），用户无从干预 |

## 目标

1. **统一以美元（USD）为唯一入库计价货币**：`samples` / `historyHourly` / `priceHistory` / `liveHistory` 全部以 USD 落盘，落盘 `currency` 恒为 `"USD"`。展示时按图鉴 `fx` 汇率表换算到当前显示货币。
2. **切换显示货币不再销毁历史**：`onCurrencyChanged()` 不再清账，历史在任意显示货币下持续可用。
3. **导入时由用户选择备份币种，且提供自动探测**：导入流程改为「选文件 → 展示摘要与**自动探测结果** → 用户确认/改选币种 → 换算到 USD 并**融合**」。自动探测通过「备份价格历史 × USD 价格参考」推算比例后反查 fx 表匹配币种（见 §6.1）。
4. **导入语义改为融合（merge）**：与现有历史合并去重，不再整体替换。

## 非目标（YAGNI）

- 不引入 USD 之外的第二基准货币（不做「基准货币可配置」）。
- 不改 `dist-web` 浏览器版的 Trading 页（网页版本就没有历史数据导入导出）。
- 不改 `MarketVolumeService` 之外服务的货币处理（inventory 的 `prices.<CUR>.json`、lookup 的 `pricesLocal` 保持现状）。
- 不为历史数据做汇率时间序列（历史金额一律用**当前** fx 表换算；不追溯当日汇率）。

## 核心设计

### 1. 单一计价钱：`MARKET_VOLUME_BASE_CURRENCY = "USD"`

`app/src/core/marketVolume.ts` 导出常量 `MARKET_VOLUME_BASE_CURRENCY = "USD"`，作为入库计价真源。

- **入库**：一切金额先换算成 USD 再写入内存/磁盘。
- **出库**：一切 IPC 出口（`getStats` / `getVolumeItems` / `buildPendingItems` / `buildItemForHash`）把 USD 金额 × `fx(显示货币)` 换算后返回，`currency` 字段仍为显示货币 —— **renderer 侧金额格式化的契约完全不变**。
- **fx 真源**：`MarketVolumeDeps.getFxRates()`（`appState` 注入 `lookupPrices.getSnapshot()?.fx`，`fx[ISO]` = 每 1 USD 的该币单位数）。
  - USD→显示货币：`amount × fx[display]`
  - 显示货币→USD：`amount / fx[display]`
  - `fx` 缺失或该币种不在表中：**不换算**，直接按 USD 原值返回且 `currency = "USD"`（绝不把 USD 数值标成其他币种）。

### 2. 采集链路改为入 USD

| 环节 | 现状 | 改为 |
|------|------|------|
| `recordVolume(hash, volume, median, currency)` | 直接存显示货币 `median` | 保留「`currency` 必须等于当前显示货币」的竞态护栏；通过后 `medianUsd = median / fx(currency)` 再存。`fx` 缺该币种 → 丢弃该次采样并 `log.debug` |
| `live` / `liveHistory` | 显示货币 `median` | USD `median`（`volume` 是件数，无币种） |
| `aggregateVolume`（采样聚合） | 金额 = volume × 显示货币 median | 金额 = volume × USD median；`MarketVolumeSample.currency` 恒为 `"USD"` |
| `maybeCalibrateHistory` | 锚取 `fetchAnchorMedian(hash, 显示货币)` | 锚取 `fetchAnchorMedian(hash, "USD")`，把 pricehistory 区域币序列校正到 USD；返回币种已 == USD 时跳过（不额外请求） |
| `historyHourly` / `itemCount(s)` | 由显示货币 priceHistory 聚合 | 由 USD priceHistory 聚合 → USD |

`maybeCalibrateHistory` 的更名建议：`calibrateHistoryToBase`（语义变更为「校正到基准货币」）。

### 3. 读取链路按 fx 换算到显示货币

新增 core 纯函数（可单测）：

```ts
/** 把 USD 金额等比缩放到显示货币（rate = fx[display]）。rate 无效时原样返回。 */
export function rescaleMarketVolumeItems(items: MarketVolumeItem[], rate: number): MarketVolumeItem[];
/** 同上，作用于 getStats 的 hourly / latest。 */
export function rescaleVolumeStats(stats: MarketVolumeStats, rate: number, currency: string): MarketVolumeStats;
```

`MarketVolumeService` 新增私有 `displayRate(): { rate: number; currency: string }`：

- `display = deps.getCurrency().toUpperCase()`；`display === "USD"` → `{ rate: 1, currency: "USD" }`；
- `fx[display]` 有效 → `{ rate: fx[display], currency: display }`；
- 否则 → `{ rate: 1, currency: "USD" }`（保守，标 USD）。

缩放点：`getStats()`、`getVolumeItems()`、`buildItemForHash()`（内部走 `aggregateItemVolume`，需单独缩放）。`buildPendingItems()` 复用 `getVolumeItems()`，自然覆盖。

`hourly` 的采样回退分支（`aggregateSamplesToTrend(this.samples)`）先聚合再按同一 `rate` 缩放。

### 4. 切换显示货币：`onCurrencyChanged()` 变为无副作用

内存中的金额已是 USD，与显示货币无关，故切币**不需要清账**：

```ts
onCurrencyChanged(): void {
  // USD 单一计价后，切币不影响入库数据，仅展示层按新币换算。
  // 保留此方法作为调用点语义锚点（appState / configPatch 在此之后广播即可）。
  log.info(`onCurrencyChanged: no-op (base currency is USD, display is ${this.deps.getCurrency()})`);
}
```

调用点（`appState.setCurrency`、`configPatch` 的 `onCurrencyChanged` deps）**保持不变**，因为它们同时负责在该分支内重新广播 `MARKET_VOLUME` / `MARKET_VOLUME_ITEMS`（切币后 `currency` 与金额都变了，必须重推）。`lookupPrices.clearLocalFields()` 与 `tracking.setCurrency` 等其它切币副作用**不动**。

### 5. 落盘 / 载入：版本 2 + 旧格式迁移

落盘 payload 增加 `version: 2`，金额为 USD，`currency: "USD"`：

```ts
interface PersistedMarketVolume {
  version?: 2;
  /** 本文件金额的计价货币；v2 起恒为 "USD"。 */
  currency?: string;
  samples: MarketVolumeSample[];   // total / byCategory 为 USD
  historyHourly: MarketVolumeHourPoint[]; // total / byCategory 为 USD
  priceHistory: Record<string, PriceHistoryPoint[]>; // price 为 USD
  liveHistory?: Record<string, LiveVolumePoint[]>;   // median 为 USD
  itemCount: number;
  itemCountsByCategory: Record<string, number>;
  historyFetchedAtMs?: number;
  lastRefreshAt?: Record<string, number>;
}
```

**同时写 `currency: "USD"` 是刻意为之**：旧版（v1.24.x，`version < 2` 的解析器只认 `currency`）在用户把 v2 备份导入旧版应用时，会把 `currency="USD"` 与自己的显示货币比对并走 fx 换算 —— 恰好得到正确结果，实现向下兼容。

`loadHistory` 改为「先归一化到 USD，再装载」：

1. `parseMarketVolumeHistory(raw)`（不变，纯结构校验）。
2. `resolveFileCurrency(parsed)`：`parsed.currency` 优先；缺失时 `inferMarketVolumeCurrency(parsed.samples)` 推断。返回 `{ currency: string | null; inferred: boolean }`。
3. `toBaseCurrency(parsed, fileCurrency)`：
   - `fileCurrency` 已是 USD（或文件是 v2）→ 原样；
   - `fileCurrency` 非 USD 且 fx 可得 → `rescaleParsedHistory(parsed, 1 / fx[fileCurrency])`；
   - `fileCurrency` 非 USD 但 fx 缺失 → **丢弃金额数据**（`resetVolumeData()` + warn），保持与现状一致的保守语义；
   - `fileCurrency == null` 且存在金额数据 → 丢弃金额 + warn（无法确认币种）；
   - `fileCurrency == null` 且无金额数据 → 空数据起步。
4. 装载后 `saveHistory()` 落盘 —— 一次性迁移为 v2/USD（旧 v1 文件、异币 v1 文件都在此被就地换算并升级）。

> **行为变化（预期且为本需求重点）**：v1 文件货币 ≠ 显示货币时，**不再丢弃**，而是换算到 USD 保留。例如显示货币从 CNY 切到 USD 后重启：旧文件 `currency="CNY"` 会被换算成 USD 保留，历史不再清零。

### 6. 导入：两段式「选文件 → 选币种 → 融合」

**IPC 契约**

| 通道 | 动作 | 参数 | 返回 |
|------|------|------|------|
| `market:analyze-history-backup`（**新增**） | 打开文件对话框 → 读取 → 解析 → 生成摘要，并把路径暂存于 main | 无 | `AnalyzeMarketVolumeBackupResult` |
| `market:import-history`（**改签名**） | 用暂存路径重读 → 按用户币种换算到 USD → 融合 → 落盘 → 广播 | `{ path?, sourceCurrency }` | `ImportMarketVolumeResult` |

```ts
export interface AnalyzeMarketVolumeBackupResult {
  ok?: boolean;
  canceled?: boolean;
  /** 失败原因（invalid_backup / read_failed）。 */
  reason?: string;
  /** 备份文件名（仅展示，不含完整路径，避免把用户目录泄露给 renderer 日志）。 */
  fileName?: string;
  /** 探测到的备份币种；null = 无法确认（旧格式且无采样可推断）。 */
  detectedCurrency?: string | null;
  /** 文件已是 USD 基准（version >= 2），renderer 可锁定币种选择器。 */
  baseCurrencyFile?: boolean;
  /** 摘要：物品种数、价格历史覆盖 hash 数、原始点数、时间范围（epoch 秒）。 */
  itemCount?: number;
  priceHashCount?: number;
  pricePointCount?: number;
  oldestTs?: number | null;
  newestTs?: number | null;
}

export interface ImportMarketVolumeResult {
  ok?: boolean;
  canceled?: boolean;
  /** 融合前不弹二次确认；此字段恒不返回，保留兼容性说明。 */
  itemCount?: number;
  /** 融合后的增量摘要：新增/更新的 hash 数、新增采样数、新增活跃度采样点数。 */
  mergedHashes?: number;
  mergedSamples?: number;
  mergedLivePoints?: number;
  /** 备份币种非 USD 且已换算时返回换算信息。 */
  converted?: { from: string; rate: number };
  reason?: "invalid_backup" | "no_pending_backup" | "conversion_unavailable";
}
```

**main 侧暂存路径（不用 renderer 回传路径）**

`appState` 持有 `let pendingHistoryBackupPath: string | null`。`analyzeMarketVolumeBackup()` 成功后写入；`importMarketVolumeHistory({ sourceCurrency })` 读它并校验非空（空 → `{ ok:false, reason:"no_pending_backup" }`），导入结束后清空。这样 renderer 无需（也无法）传任意路径给 main 读文件，避免引入新的任意文件读取面。

**导入流程**

1. 交易页点「导入历史数据」→ `window.tbh.analyzeMarketVolumeBackup()`。
2. main：`dialog.showOpenDialog`（JSON）→ `readFileSync` → `parseMarketVolumeHistory` → `resolveFileCurrency` → 组摘要 → 暂存路径 → 返回。
3. renderer 打开 `ImportHistoryDialog`（新组件）展示：
   - 文件名、物品种数、价格历史 hash 数 / 点数、时间范围（本地时区）；
   - **「备份币种」下拉**（`STEAM_CURRENCIES`）：第一项为 **`auto`「自动探测」**（默认选中，副标题显示探测到的币种与依据）；其下为 41 个具体币种供覆盖。`baseCurrencyFile === true`（备份已是 v2/USD）→ 锁定为 USD 且提示「该备份已统一以美元存储」；`detectedCurrency === null` 时「自动探测」项标注「未能识别，请手动选择」。
   - 说明文案：「导入将与此前的历史数据**融合**（按时间合并、不覆盖），不会清空现有数据」；
   - 按钮「融合导入」/「取消」。
4. 点「融合导入」→ `window.tbh.importMarketVolumeHistory({ sourceCurrency })`。
5. main：重读暂存路径 → 解析 → 解析来源币种 `resolvedCurrency`：
   - `sourceCurrency === "auto"` → 重跑 **§6.1 自动探测**（analyze 阶段已算过一次，这里重算以保证数据一致）；探测失败 → `{ ok:false, reason:"conversion_unavailable" }`；
   - 否则用用户显式选定的 ISO。
6. 换算到 USD：`resolvedCurrency === "USD"` → 原样；否则 `rate = 1 / fx[resolvedCurrency]` + `rescaleParsedHistory`；fx 缺该币种 → 回退 `computeConversionRate`（用现有 USD `priceHistory` 与备份共同 hash / 时间最接近的一对点求价格比）；仍拿不到 → `{ ok:false, reason:"conversion_unavailable" }`，**不改动现有数据**。
7. 融合：`mergeParsedHistory(existing, incoming)`（core 纯函数）→ 装载 → 重算派生字段 → `saveHistory()`（v2/USD）→ 广播 `MARKET_VOLUME` + `MARKET_VOLUME_ITEMS`。
8. 返回增量摘要；renderer 提示条显示 `trading.importMerged`（可带换算信息）。

### 7. 融合语义（`mergeParsedHistory`）

```ts
export function mergeParsedHistory(
  existing: ParsedMarketVolumeHistory,
  incoming: ParsedMarketVolumeHistory,
): { merged: ParsedMarketVolumeHistory; addedHashes: number; addedSamples: number; addedLivePoints: number };
```

| 字段 | 融合规则 | 理由 |
|------|----------|------|
| `priceHistory[hash]` | `mergePriceHistoryPoints(existing, incoming)`（已有函数：按 UTC 天分组，**保留点数更多的一方**，相等取新） | 「天」为最小融合单元，天然避免同一小时的**重复计数**；不同天取并集 → 累积历史 |
| `samples` | 按 `timestamp` 建 Map 合并（同 timestamp 取 incoming），升序，裁剪到 `MAX_SAMPLES=1200`（保留最新） | 采样是「当时刻的 24h 滚动值」，同刻去重、异刻并集 |
| `liveHistory[hash]` | 按 `ts` 建 Map 合并，升序，裁剪到 `MAX_LIVE_POINTS_PER_HASH=2000`（保留最新） | 同上 |
| `historyHourly` | **不合并**，导入后由合并结果调 `aggregateHistoryToHourly` 重算；重算为空则保留 existing | 派生于 `priceHistory`，避免双源不一致 |
| `itemCount` / `itemCountsByCategory` | 同上（由重算得到） | 派生 |
| `historyFetchedAtMs` | `max(existing, incoming)` | 保持 1 小时缓存去抖语义 |
| `lastRefreshAt[hash]` | 每 hash 取 `max` | 「每日全量兜底」不倒退 |

`version` / `currency` 输出恒为 `2` / `"USD"`。

**幂等性**：把同一份备份连续导入两次，`priceHistory`（按天取一侧）、`samples`/`liveHistory`（同键去重）均不翻倍 —— 需要专门单测覆盖。

**已知取舍**：同一 UTC 天内若 existing 有 24 个小时点、incoming 有 12 个小时点，`mergePriceHistoryPoints` 取 24 点那一侧 —— incoming 独有的那些小时点会被丢弃。对「同一溯源的分支备份」这是可接受的（两点集高度重叠）；在文档中显式记录该边界。

### 8. 导出

`exportHistory()` 输出 `version: 2` + `currency: "USD"` + USD 金额。文件名与对话框行为不变。语义变化：导出文件**不再**随显示货币变化，跨机 / 跨币种导入可无损融合。

### 9. UI 与文案

| 组件 | 改动 |
|------|------|
| `app/src/renderer/tabs/Trading.tsx` | 「导入历史数据」按钮改为先调 `analyzeMarketVolumeBackup()`，成功则打开 `ImportHistoryDialog`；移除 `window.confirm(trading.importConfirm)` |
| `app/src/renderer/components/market/ImportHistoryDialog.tsx`（**新增**） | 摘要 + 币种 `Select` + 融合说明 + 「融合导入」/「取消」；沿用项目既有 modal 组件（`Dialog`/`Modal`，实现时以现有组件为准） |
| `app/shared/locales/{en,zh-CN,ja,ko}/market.json` | 新增 `trading.importTitle` / `importMergeNotice` / `importSourceCurrency` / `importCurrencyUnknown` / `importCurrencyLocked` / `importMerged` / `importMergedConverted` / `importNoPending` / `importConversionUnavailable` / `importSummaryItems` / `importSummaryPoints` / `importSummaryRange`；删除 `importConfirm` / `importConverted` / `importCurrencyMismatch`（无引用后） |

原有 `trading.importSuccess` 可复用为「融合导入成功」或直接由 `importMerged` 取代（实现时二选一，避免死文案）。

## 分层改动点

| 层 | 文件 | 改动 |
|----|------|------|
| shared | `app/shared/ipc.ts` | + `ANALYZE_MARKET_VOLUME_BACKUP`，加入 `IPC_INVOKE_CHANNELS` |
| shared | `app/shared/types.ts` | + `AnalyzeMarketVolumeBackupResult`；改 `ImportMarketVolumeResult`（`converted` 变对象、+ `merged*`、+ 新 `reason`）；`TbhApi` 改 `importMarketVolumeHistory` 签名 + 加 `analyzeMarketVolumeBackup` |
| core | `app/src/core/marketVolume.ts` | + `MARKET_VOLUME_BASE_CURRENCY`；+ `mergeParsedHistory`；+ `rescaleMarketVolumeItems` / `rescaleVolumeStats`；`rescaleParsedHistory` 复用不变 |
| main | `app/src/main/services/MarketVolumeService.ts` | 采集 / 校正 / 载入 / 落盘 / 导出 / 导入全部改为 USD 基准；+ `analyzeBackupJson`（摘要）；`onCurrencyChanged` 改 no-op；`displayRate()` + 出库缩放 |
| main | `app/src/main/app/appState.ts` | + `pendingHistoryBackupPath`；+ `analyzeMarketVolumeBackup`；改 `importMarketVolumeHistory(args)`；切币分支保留广播 |
| main | `app/src/main/ipc/handlers/market.ts` | + 1 个 handler；`IMPORT_MARKET_VOLUME` 透传参数（含 `isNonEmptyString` 校验） |
| preload | `app/src/preload/index.ts` | + `analyzeMarketVolumeBackup()`；改 `importMarketVolumeHistory(args)` |
| renderer | `app/src/renderer/tabs/Trading.tsx` + 新 `ImportHistoryDialog.tsx` | 两段式导入 + 币种选择 |
| web | `app/src/web/webTbhApi.ts` | `analyzeMarketVolumeBackup` 返回 `{ ok:false, error:"desktop-only" }`；`importMarketVolumeHistory` 签名同步 |

## 错误处理

| 场景 | 行为 |
|------|------|
| analyze：对话框取消 | `{ canceled: true }`，静默 |
| analyze：读文件失败 / 非 JSON / 结构非法 | `{ ok:false, reason:"invalid_backup" \| "read_failed" }` |
| import：无暂存路径（未先 analyze） | `{ ok:false, reason:"no_pending_backup" }` |
| import：用户选定的币种无 fx 且无法用价格推算 | `{ ok:false, reason:"conversion_unavailable" }`，**现有数据不变** |
| 载入：旧文件币种非 USD 且 fx 不可得 | 丢弃金额 + warn（与现状一致的保守兜底） |
| 载入：旧文件币种无法确认但存在金额 | 丢弃金额 + warn |
| fx 表整体不可得（快照未就绪） | 出库按 USD 原值 + `currency:"USD"` 展示；采集侧 USD 换算跳过该次采样 |

## 测试覆盖

**`app/test/core/marketVolume.test.ts`**
- `mergeParsedHistory`：不同天并集 / 同天保留更细粒度 / 相同数据幂等不翻倍 / `samples` 同 timestamp 去重 / `liveHistory` 同 ts 去重 / 派生字段由重算给出。
- `rescaleMarketVolumeItems` / `rescaleVolumeStats`：金额缩放、`rate` 无效时原样、`currency` 字段更新。

**`app/test/main/marketVolumeService.test.ts`**
- **迁移**：v1 `currency:"CNY"` 文件 + fx 含 CNY → 载入后金额为 `原值 / fx.CNY`，落盘 `version:2` / `currency:"USD"`（**不再丢弃**）。
- **迁移兜底**：v1 异币文件且 fx 缺失 → 金额被丢弃（行为与现状一致，作为回归护栏）。
- **切币不丢**：`recordVolume` + `sampleNow` 后 `onCurrencyChanged()` → `getStats()` 仍非空，`currency` 为新币，金额 ≈ USD × fx(新币)。
- **采集入 USD**：显示货币 CNY 时 `recordVolume` 的 `live` median 落在 USD 量级。
- **融合导入**：两份覆盖不同时间范围的备份融合后 `hourly` 为并集、`itemCount` 增加；连续导入同一备份两次结果不变（幂等）。
- **币种换算**：`analyze` 探测到 CNY、用户选 CNY → `converted: { from:"CNY", rate }`；用户选 USD → 不换算。
- **换算不可得**：fx 空且无共同 hash → `{ ok:false, reason:"conversion_unavailable" }` 且现有数据不变。
- **无暂存路径**：直接 `importHistory` → `{ ok:false, reason:"no_pending_backup" }`。

**`app/test/ipc/channels.test.ts`**
- + `IPC.ANALYZE_MARKET_VOLUME_BACKUP` 契约断言。

**渲染层**（`pnpm test:dom`，如已有 Trading 相关组件测试则同步）
- `ImportHistoryDialog`：默认币种取探测值；`detectedCurrency === null` 时显示手动选择提示；`baseCurrencyFile` 时选择器禁用。

## 文档同步（强制，与本 PR 同批）

- `docs/business-flows/06-market.md`
  - §8.7.2「持久化结构（含货币标记）」→ 改为「持久化结构（USD 单一计价）」；
  - §8.7.3「多货币同步政策」整节重写为「USD 基准货币政策」：入库换算、出库换算、切币不再清账、载入迁移、导入换算；
  - §8.7.5「历史数据导出 / 导入」→ 改为两段式 analyze + import 融合流程，更新错误处理与关键文件速查；
  - §8.7.1 中 `maybeCalibrateHistory` 的锚货币说明改为 USD。
- `docs/BUSINESS-FLOWS.md`：检查 §18 跨服务数据流总览 / §20 关键文件路径速查中涉及 `market_volume_history.json` 与 `currency` 的表述并同步。
- `CHANGELOG.md`：作为用户可见行为变更（切币不再丢历史、导入融合）记一条。

## 关键文件路径速查

| 文件 | 角色 |
|------|------|
| `app/src/core/marketVolume.ts` | 基准货币常量、`mergeParsedHistory`、金额缩放纯函数 |
| `app/src/main/services/MarketVolumeService.ts` | USD 化核心：采集 / 校正 / 载入迁移 / 落盘 / 导出 / 导入 / 融合 |
| `app/src/main/app/appState.ts` | 暂存备份路径、analyze / import 编排、切币广播 |
| `app/src/main/ipc/handlers/market.ts` | IPC 入口（含参数校验） |
| `app/src/preload/index.ts` | contextBridge 暴露 |
| `app/src/renderer/tabs/Trading.tsx`、`app/src/renderer/components/market/ImportHistoryDialog.tsx` | 两段式导入 UI + 币种选择 |
| `app/shared/locales/*/market.json` | 4 语言文案 |
| `userData/market_volume_history.json` | 落盘文件（v2 / USD） |

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| USD 化后历史金额与用户此前看到的显示货币数字在**当前 fx** 下略有偏差（原值是「当日显示货币价」，现改为「当时 USD 价 × 今日 fx」） | 属预期行为；文档与 CHANGELOG 明示 |
| 载入迁移写盘失败（磁盘满 / 权限） | `saveHistory` 已有 try/catch + warn；内存态仍为 USD，下次启动重试 |
| 旧版应用读 v2 文件 | 已通过同时写 `currency:"USD"` 兼容（旧解析器走 fx 换算） |
| 融合误合并（用户期望替换） | `ImportHistoryDialog` 明确文案「融合、不覆盖」；如需替换可先手动清空 `market_volume_history.json` 再导入（文档说明） |
| 回滚 | 变更集中在 `MarketVolumeService` + `core/marketVolume.ts`；文件格式向后兼容读取，回滚版本会把 v2 文件按 `currency:"USD"` 处理（显示货币非 USD 时换算，行为正确） |

## 实施记录（2026-09-22）

全部按本规格落地。实施中的补充与偏差：

| 项 | 补充 / 偏差 | 理由 |
|----|------------|------|
| 载入补算走势 | `loadHistory` 装载后若 `historyHourly` 为空且 `priceHistory` 非空，调一次 `recomputeHistoryTrend()` | 走势是 `priceHistory` 的派生物；只带原始点的备份/残缺文件不应留下「有价格历史却无走势」的不一致态 |
| 融合的派生字段占位 | `mergeParsedHistory` 的 `historyHourly` / `itemCount` / `itemCountsByCategory` 优先取 existing 的**非空**值，existing 为空时取 incoming | 否则仅带 `historyHourly` 的备份在重算不出结果时会整段丢失 |
| 探测阈值显式化 | `CURRENCY_DETECT_MIN_SAMPLES = 3`、`CURRENCY_DETECT_TOLERANCE = 0.15` 作为 core 导出常量 | 便于调参与测试；`runnerUp` 用于提示 NOK/SEK 这类量级接近币种的歧义 |
| v2 文件的显式币种覆盖 | `resolveImportCurrency` 对用户显式选择的 ISO 一律采信（即便文件是 v2） | 用户覆盖应为权威；UI 已对 `baseCurrencyFile` 锁定选择器，正常路径不会走到 |
| 暂存路径一次性消费 | `importHistory` 成功后才清空 `pendingHistoryBackupPath` | 避免重复导入同一文件；失败保留以便重试 |
| 新增渲染层测试 | `app/test/renderer-component/ImportHistoryDialog.test.tsx`（5 例：摘要 + auto 回传 / 未识别提示 / 判定依据 / v2 锁定 / busy 禁用） | 原计划只写「如已有组件测试则同步」，实际补了覆盖 |
| 附带修正 | 交易页导入前的 `window.confirm` 移除，改为在 `ImportHistoryDialog` 内确认 | 两段式流程下重复确认是多余摩擦 |

**验证结果（2026-09-22，本机）**：`tsc`（app + test 两份配置）✅；`eslint .` ✅；`prettier --check .` ✅；`vitest run` **130 文件通过 / 1 文件失败（9 例超时，全在 `lookupPricePollingService.test.ts`）**——该文件需真实访问 `steamcommunity.com`，本机不可达（既有环境问题，与本次改动无关，CI 上为绿）；`vitest run --config vitest.dom.config.ts` **52 文件 / 289 例全绿**；`electron-vite build` ✅；`build-flow-viz.mjs`（20 flows / 23 services）与 `--check` ✅；`sync-agent-docs.mjs --check` ✅。
