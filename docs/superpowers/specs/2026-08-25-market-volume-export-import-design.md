# 交易页历史数据导出 / 导入设计

> 日期：2026-08-25
> 状态：已确认（brainstorming 流程）

## 背景与目标

交易页（Trading）的历史交易数据（每物品 `pricehistory` 原始点、小时聚合走势、轮询采样、活跃度采样）持久化于 `userData/market_volume_history.json`。这些数据由 Steam 接口经登录 Cookie 拉取，重新获取成本高且受限流约束。本需求为这些历史数据提供 **JSON 完整备份与恢复**：

- **导出**：将当前全部交易页历史数据导出为用户自选路径的 JSON 文件（备份 / 换机迁移）。
- **导入**：从 JSON 文件**整体替换**当前交易页历史数据（恢复到备份时刻）。

数据范围**仅**限交易页历史数据（`MarketVolumeService` 管理的持久化字段）；不涉及宝箱掉落 / 开箱 / 关卡通关等其他历史数据。

## 非目标（YAGNI）

- 不做 CSV / Excel 导出。
- 不做合并式导入（仅整体替换，导入前有确认）。
- 不改动 `MarketVolumeService` 现有落盘文件 `market_volume_history.json` 的读写路径，仅在内存态与导出文件之间增补接口。

## 备份文件格式

导出的 JSON 与 `PersistedMarketVolume` 落盘结构一致（完整快照），额外增加 `version: 1` 供未来迁移：

```json
{
  "version": 1,
  "samples": [ { "timestamp": "...", "total": 123, "count": 5, "byCategory": {} } ],
  "historyHourly": [ { "hour": "2026-08-25T01:00:00", "total": 123 } ],
  "priceHistory": {
    "Copper Coin": [ { "timestamp": 1720000000, "price": 1.2, "volume": 340 } ]
  },
  "liveHistory": {
    "Copper Coin": [ { "ts": 1720000000000, "volume": 340, "median": 1.2 } ]
  },
  "itemCount": 12,
  "itemCountsByCategory": { "WEAPON": 3, "MATERIAL": 9 },
  "historyFetchedAtMs": 1720000000000
}
```

`version` 字段本次恒为 `1`；解析器忽略未知版本号但保留该字段，为未来结构迁移预留。

## 导出流程

1. 交易页工具栏点「导出」→ `window.tbh.exportMarketVolumeHistory()` → IPC `market:export-history`。
2. main handler（`main/ipc/handlers/market.ts`）：`dialog.showSaveDialog`（默认文件名 `market_volume_history_<yyyyMMdd>.json`，`filters: [{ name: JSON, extensions: ["json"] }]`，沿用 `pickSaveFile` 的对话框模式，含父窗口归属）。
3. 用户确认路径后，取 `MarketVolumeService.exportHistory()` 返回的完整 payload，`writeFileSync` 写入。
4. 返回结果：
   - 成功：`{ ok: true, path }`
   - 用户取消：`{ canceled: true }`
   - 写入失败：`{ ok: false, reason: string }`

## 导入流程（整体替换）

1. 交易页工具栏点「导入」→ `window.confirm` 确认覆盖（复用 Settings 页确认模式）→ `window.tbh.importMarketVolumeHistory()` → IPC `market:import-history`。
2. main handler：`dialog.showOpenDialog`（JSON 过滤器）→ 读文件文本 → 交给 `MarketVolumeService.importHistory(rawJson)`。
3. **校验先行**：`parseMarketVolumeHistory(raw)` 解析并逐字段过滤（见下）；失败返回 `{ ok: false, reason }`，**不触碰现有内存数据与落盘文件**。
4. 校验通过 → **整体替换**内存数据（`samples` / `historyHourly` / `priceHistory` / `liveHistory` / `historyItemCount` / `historyItemCountsByCategory` / `historyFetchedAtMs`）→ `saveHistory()` 落盘。
5. appState 导入成功后广播 `IPC.MARKET_VOLUME` + `IPC.MARKET_VOLUME_ITEMS`，交易页实时刷新。
6. 返回 `{ ok: true, itemCount }`。

## 分层改动点

| 层 | 改动 |
|----|------|
| `app/shared/ipc.ts` | 新增 `EXPORT_MARKET_VOLUME = "market:export-history"`、`IMPORT_MARKET_VOLUME = "market:import-history"`，加入 `IPC_INVOKE_CHANNELS` |
| `app/shared/types.ts` | 新增 `ExportMarketVolumeResult`、`ImportMarketVolumeResult` 类型；`TbhApi` 增加 `exportMarketVolumeHistory()` / `importMarketVolumeHistory()` 方法签名 |
| `app/src/core/marketVolume.ts` | 新增 `ParsedMarketVolumeHistory` 接口（core 层定义，结构兼容 main 的 `PersistedMarketVolume`）与纯函数 `parseMarketVolumeHistory(raw: unknown): ParsedMarketVolumeHistory | null`（含合法性与逐字段过滤；从 `MarketVolumeService.loadHistory` 抽出校验逻辑，`loadHistory` 与 `importHistory` 复用）。注意：`PersistedMarketVolume` 是 main 层类型，core 不得引用；core 用自有 `PriceHistoryPoint` / `LiveVolumePoint` 与 shared 的 `MarketVolumeSample` / `MarketVolumeHourPoint` 组成返回类型 |
| `app/src/main/services/MarketVolumeService.ts` | `exportHistory()` 返回 `PersistedMarketVolume` 快照；`importHistory(json: string)` 调 `parseMarketVolumeHistory` → 整体替换 → `saveHistory()` |
| `app/src/main/ipc/handlers/market.ts` | 注册两个 handler（含 `dialog.showSaveDialog` / `dialog.showOpenDialog`） |
| `app/src/main/app/appState.ts` | AppServices 注入 `exportMarketVolumeHistory` / `importMarketVolumeHistory`；导入成功后广播 `MARKET_VOLUME` + `MARKET_VOLUME_ITEMS` |
| `app/src/preload/index.ts` | 暴露 `exportMarketVolumeHistory()` / `importMarketVolumeHistory()` |
| `app/src/renderer/tabs/Trading.tsx` | 工具栏（刷新按钮旁）增加「导出」「导入」按钮，沿用现有小按钮样式；导入前 `window.confirm`；失败用提示展示原因 |
| `app/shared/locales/{en,zh-CN,ja,ko}/market.json` | `trading` 下新增 `exportHistory` / `importHistory` / `importConfirm` / `exportFailed` / `importFailed` / `exportSuccess` 等文案 |
| `app/test/ipc/channels.test.ts` | 新增两个通道的契约断言 |

## 核心校验逻辑（`parseMarketVolumeHistory`）

- 顶层必须是对象；`version` 存在时不做硬性版本拒绝（本次仅 `1`）。
- `samples` / `historyHourly`：数组，元素过滤（沿用 `loadHistory` 现有过滤规则：时间戳 / 数值字段类型校验）。
- `priceHistory` / `liveHistory`：对象，逐 hash 过滤数组元素（沿用现有 `loadHistory` 过滤规则）。
- `itemCount` / `historyFetchedAtMs`：number 才采纳。
- `itemCountsByCategory`：对象直接采纳。
- 返回解析后的 `ParsedMarketVolumeHistory`（core 层类型，字段结构与 main 的 `PersistedMarketVolume` 一致，`MarketVolumeService.importHistory` 直接映射到内存字段）；顶层非法返回 `null`。

## 错误处理

| 场景 | 行为 |
|------|------|
| 导出对话框取消 | 返回 `{ canceled: true }`，静默 |
| 导出写入失败（权限 / 路径） | 返回 `{ ok: false, reason }`，交易页提示导出失败 |
| 导入对话框取消 | 返回 `{ canceled: true }`，静默 |
| 导入文件非 JSON / 结构非法 | `parseMarketVolumeHistory` 返回 null → `{ ok: false, reason }`，现有数据不受影响 |
| 导入确认被用户取消 | 不发起 IPC |

## 测试覆盖

- `app/test/core/marketVolume.test.ts`（或新文件）：`parseMarketVolumeHistory` 对合法快照 / 顶层非法 / 部分字段缺失 / 旧版纯数组格式 的解析与过滤结果。
- `app/test/main/marketVolumeService.test.ts`：
  - export 快照 → import 到新实例后 `getStats` / `getVolumeItems` 与导出前一致（往返一致性）。
  - import 合法 JSON 覆盖现有数据（旧数据被替换）。
  - import 非法 JSON 返回失败且现有数据不变。
- `app/test/ipc/channels.test.ts`：新通道契约。

## 文档同步

- `docs/BUSINESS-FLOWS.md` 8.7 节（市场交易额 / 交易页数据流）新增「历史数据导出 / 导入」子节，含数据流、错误处理路径、关键文件路径速查表。

## 关键文件路径速查

| 文件 | 角色 |
|------|------|
| `app/src/main/services/MarketVolumeService.ts` | 历史数据持有者；`exportHistory` / `importHistory` |
| `app/src/core/marketVolume.ts` | `parseMarketVolumeHistory` 纯校验 |
| `app/src/main/ipc/handlers/market.ts` | 文件对话框 + IPC 入口 |
| `app/src/main/app/appState.ts` | 服务编排 + 导入后广播 |
| `app/src/preload/index.ts` | contextBridge 暴露 |
| `app/src/renderer/tabs/Trading.tsx` | 工具栏按钮 |
| `app/shared/ipc.ts` / `app/shared/types.ts` | 通道名与类型契约 |
| `userData/market_volume_history.json` | 落盘文件（导入后覆盖） |
