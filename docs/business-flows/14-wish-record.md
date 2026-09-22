# 祈愿记录（Wish Record）

> 本文是 [`docs/BUSINESS-FLOWS.md`](../BUSINESS-FLOWS.md) 的拆分章节之一。**业务流程的单一真理源仍是主索引文件**——任何业务逻辑改动仍需先查阅本文件，落地后同步更新；本文件只是承载正文，便于按需加载。
>
> 复刻「祈愿」的产出统计链路：复用游戏「获得记录」文本行管道，按事件（offering）与件数（item）双口径计数、按品质与单品聚合，并提供会话重置与长期归档。
>
> 所有文件路径以仓库根为基准（`app/src/...`）。

> ← [主索引](../BUSINESS-FLOWS.md) · 上一章[网页版存档解析器（Web Inspector）](13-web-inspector.md) · 章节：§26 · 相关：[统一记录日志 §23.6](11-record-log.md)

---

## 26. 祈愿记录（Wish Record）业务流程

**动机（2026-09-22 新增）**：为「祈愿」提供产出统计——每次祈愿的产出文案与宝箱/掉落同源（都来自游戏「获得记录」定长平移列表，都带 `<color=#RRGGBB>` 品质色），因此祈愿记录**不新开数据源、不新增 IPC、不新增内存读取**，而是复用 acquire 文本行管道做旁路识别与聚合。

### 26.1 数据流

```
游戏进程 LogManager@0x20（「获得记录」定长平移列表）
  → worker 独立 acquire 通道（~10ms）→ post({type:"acquire", entries, initial})
      → LiveMemoryService → TrackingService.ingestAcquireBatch(entries, initial, ...)
          ├─（既有）recordLog.feed("acquire", now, {...})  → RecordLogTracker → record_log.json
          └─（新增）parseWishLine(a.message)  ← core/wishLine.ts（多语言前缀 + 结构兜底 + 排除表）
                └─ 命中 → wishTracker.feed(item, now, { raw, gameTime, bulk: initial })
                            → WishTracker（core，双计数 offering/item + 品质分布 + 单品聚合 + 滚动速率）
                            → WishRecordService.schedulePersist() 防抖 ~2s
                            → 写 userData/wish_record.json（长期累计归档，不随会话重置清空）
  → buildStats(..., wishTracker) 输出 Stats.wish
  → onStats(IPC.STATS) → useStats() → 祈愿 tab（app/src/renderer/tabs/Wish.tsx）
```

> 注：祈愿行**只在已通过 `ringSeq` 去重**的行上喂入（与 `recordLog` 完全同步），因此 initial 批重灌不会重复计数。`initial=true` 的批量回灌以 `bulk: true` 喂入——计入累计/会话/历史，但**不进滚动 1 小时窗口**。非祈愿行零副作用。详见 [`11-record-log.md §23.6`](11-record-log.md)。

### 26.2 口径与字段语义（PRD §5，不得擅改）

| 字段                            | 口径                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `offeringCount`（祈愿次数）     | **一条祈愿结果行 = 1 次**（按事件，不按物品数）                                                           |
| `itemCount`（产出物品数）       | 该行解析件数之和，**缺省 1**                                                                              |
| `itemsPerOffering`              | `itemCount / offeringCount`；分母 0 → 0（不 NaN）                                                         |
| 品质（`grade`）                 | 由 `<color=#RRGGBB>` 经 `core/acquireLog.ts` 的 `COLOR_TO_GRADE` 映射；**无法映射 → `UNKNOWN`，绝不猜测** |
| `share`（占比）                 | 分母**恒为 `itemCount`**（产出物品总数，含 UNKNOWN），非 offeringCount                                    |
| 单品聚合键（`breakdown`）       | 去标签纯物品名；排序 `count` 降序、同值 `name` 升序（P0 无 itemKey）                                      |
| `*PerHour`（会话速率）          | `count / (now - 窗口锚点)` × 3600；锚点 = `min(trackingStartedAt, firstWishWallTime)`                     |
| `*RecentPerHour`（滚动 1 小时） | 只统计 `ROLLING_HOUR_SEC=3600` 窗口内的**非 bulk** 条目；分母下限 `RECENT_MIN_WINDOW_SEC=300`             |
| `history`                       | 倒序（最新在前），上限 `HISTORY_VISIBLE=50`（内存上限 `HISTORY_LIMIT=500`）                               |

**双计数记忆点**：这是与 [`ChestDropTracker`](11-record-log.md)（每次掉落 +1）**最大结构差异**——祈愿一次可能产出多件同名物品（如 `获得了 5 个 X`），故需同时维护「次数」与「件数」两个维度。

### 26.3 品质桶

8 个桶（由低到高，UNKNOWN 置末尾）：`COMMON / UNCOMMON / RARE / LEGENDARY / IMMORTAL / ARCANA / CELESTIAL / UNKNOWN`。映射源为 `core/acquireLog.ts` 的 `COLOR_TO_GRADE`（`#D7D7D7`→COMMON、`#7CE937`→UNCOMMON、`#519FFF`→RARE、`#EBBB00`→LEGENDARY、`#E8695A`→IMMORTAL、`#FB86FF`→ARCANA、`#00F6FF`→CELESTIAL）。**无颜色 / 非物品色 → UNKNOWN**，绝不猜测。分布图与占比条为**手绘 SVG**（`WishGradeBar.tsx`），不引入任何图表库（P0 零新增依赖）。

### 26.4 关键文件

| 职责                       | 路径                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 祈愿行识别（纯逻辑）       | `app/src/core/wishLine.ts`（`isWishLine` / `parseWishLine` / `WishLineItem`）                                                                  |
| 祈愿聚合器（纯逻辑）       | `app/src/core/wishTracker.ts`（`WishTracker`：`feed/getStats/reset/captureSnapshot/applySnapshot`）                                            |
| 事件接入与转发             | `app/src/main/services/TrackingService.ts`（`ingestAcquireBatch` 内旁路识别；`getWishTracker()`；`resetWishRecord()`）                         |
| stats 输出                 | `app/src/main/stats.ts`（`buildStats` 增参 `wishTracker`，输出 `Stats.wish`；空态常量 `EMPTY_WISH`）                                           |
| 会话快照（随会话）         | `app/src/main/services/SessionStateService.ts`（`persistSnapshot`/`applySnapshot` 增 `wishTracker` 字段，`wishTracker?: WishTrackerSnapshot`） |
| 长期归档（P1-1，不随会话） | `app/src/main/services/WishRecordService.ts`（load-once / 防抖 ~2s persist / stop flush）                                                      |
| 文件注册/清除              | `app/src/main/services/appData.ts`（`WISH_RECORD_FILE`＝`wish_record.json`；入 paths 清单、`wish-record` 清除目标与 `all-except-config`）      |
| 清除目标接线               | `app/src/main/app/appState.ts`（`clearAppData` → `tracking.resetWishRecord()`）                                                                |
| 共享类型                   | `app/shared/types.ts`（`WishGrade`/`WishGradeRow`/`WishBreakdownRow`/`WishHistoryEntry`/`WishStats`/`WishTrackerSnapshot`；`Stats.wish`）      |
| UI                         | `app/src/renderer/tabs/Wish.tsx` + `components/wish/*` + `lib/useWish.ts`（tab id = `wish`，`appTabs.ts` / `App.tsx`）                         |
| i18n                       | `app/shared/locales/{zh-CN,en,ja,ko}/wish.json`（命名空间 `wish`；`tabs.json` 增 `wish` 标签）                                                 |

### 26.5 会话语义（关键，与掉落的差异）

- **`WishTracker.reset()` = 会话重置**：`*Session` 归零、**累计不变**、`sessionWishStart` 重置为现在。这是与 `ChestDropTracker.reset()`（**整表清空**累计 + 历史）**根本不同**的语义——祈愿的累计口径是长期展示值，重置会话只应把「本会话增量」清零。
- **接线点**：`TrackingService` 在所有既有 `chestDropTracker.reset()` 的四处（`reset` / `clearSession` / `onSavePathChanged` / `onLiveMemoryToggled`）同步调用 `wishTracker.reset()`。四次调用后，祈愿**累计不变、`*Session` 归零**。
- **`wish_record.json`（P1-1 长期归档）不随会话重置清空**（PRD §2.5 / §5.2）。设置页清除 `wish-record` / `all-except-config` 时删除该文件并 `tracking.resetWishRecord()` 丢弃内存归档标记（不清当前会话的 stats 展示值——清归档 ≠ 清会话）。
- **reset 复用既有 IPC**：renderer 的「重置会话」按钮走既有 `window.tbh.reset()`（`IPC.RESET`），不新增 IPC 通道。

### 26.6 错误处理

- **非祈愿行零误报**：识别采用「多语言前缀白名单 + 严格结构兜底 + 排除表」，宁可漏不可错。测试 `app/test/core/wishLine.test.ts` 以真实文案对 + 反例断言零误报。
- **件数解析**：`parseAcquireMessage` 的 `COUNT_RE` 要求数字在行尾；祈愿行常以 `。` 收尾，故 `wishLine.ts` 内先剥尾部标点再提取件数（`extractCount`），缺省 1。
- **品质不可映射** → `UNKNOWN`（绝不猜测）；分布/占比的 UNKNOWN 桶与其他桶一视同仁计入分母。
- **持久化失败**：`WishRecordService.load()` 读文件失败/损坏 → 记 warn，从空态继续；`persist()` 写盘失败（只读/满盘）→ 记 warn，不回滚内存，下次防抖调度再试。
- **损坏快照容错**：`WishTracker.applySnapshot` 对无效字段（负数/NaN/缺字段）做防御性清洗，不抛错；`itemCount` 以持久化值为准（不重新从 `countsByName` 求和，避免展示口径跳变）。
- **删除文件后内存态**：`clearAppData(wish-record)` 删除文件后 `tracking.resetWishRecord()` 停止后续落盘。

### 26.7 边界与注意

- **不新增 IPC、不改 preload**：祈愿数据只走既有 `IPC.STATS` / `IPC.RESET`。`app/shared/ipc.ts`、`registerIpc.ts`、preload、`test/ipc/channels.test.ts` **均不改动**。
- **`core/` 纯净**：`core/wishLine.ts` / `core/wishTracker.ts` 不依赖 electron / `node:fs` / `fetch` / React。
- **零新增 npm 依赖**：品质分布图为手绘 SVG。
- **与 recordLog 的一致性**：两者消费同一条 acquire 管道、共享 `ringSeq` 去重；祈愿只是**旁路**（不改动 recordLog 的喂入与归档语义）。
- **速率窗口锚点持久化**：`WishTrackerSnapshot.sessionWishStart` 使 restore 后 perHour 窗口起点正确（counts 不截断、history 截断）。
