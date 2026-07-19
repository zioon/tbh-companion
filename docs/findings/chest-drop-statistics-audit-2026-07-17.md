# 开启宝箱掉落物品统计 - 子功能审计报告

- 审计日期：2026-07-17
- 审计范围：限定于"开启宝箱掉落物品统计"子功能（不含 BoxTimer 倒计时 / 窗口管理 / IPC handler 校验等附属功能，已在昨日 `chest-code-audit-2026-07-17.md` 覆盖）
- 与昨日报告关系：本次为**独立深度审计**，发现 1 个 P0、8 个 P1、5 个 P2 新问题；与昨日发现的交集已在每个条目末尾标注 `[新增]` / `[昨日已修，残留衍生问题]` / `[昨日延后]`

## 一、子功能全景图

```
liveMemory.worker (25Hz)
  └─ LiveReader.readChestDrops → LiveMemorySnapshot.chestDrops: ("common"|"rare")[]
  └─ LiveReader.readBoxOpens    → LiveMemorySnapshot.boxOpens:    BoxOpenEntry[]
        ↓ IPC.LIVE_FRAME
TrackingService.ingestLiveFrame (~25Hz, broadcast 节流 200ms)
  ├─ chestAggregator.feed(chestDrops, snap.at/1000)
  │    └─ collapseLiveChestDrops(buffer) → 静默 flush 后输出 collapsed categories
  │    └─ for cat of collapsed:
  │         chestDropTracker.recordLiveChestDrop(cat, snap.at/1000)
  │           └─ countsByKey[name]++  history.push  breakdownCache=null  historyCache=null
  │
  └─ for entry of snap.boxOpens:
       resolveBoxOpenEntry(entry) → boxKey/itemKey/name/grade
       boxOpenTracker.recordOpen(boxKey, itemKey, name, grade, count=1, snap.at/1000)
         └─ countsByKey[boxKey][itemKey]++  history.push  baseAggregateCache=null
                                ↓
stats.ts buildStats (5Hz 安全网 + 200ms live 节流)
  ├─ chestDropTracker.getStats(tracker.elapsed)
  │    ├─ breakdownCache 命中 → reuse breakdown, recompute totals
  │    ├─ historyCache  命中 → reuse visible slice
  │    └─ lastRareWallTime 反向扫描 history 末尾 O(N)
  │
  └─ boxOpenTracker.getStats(tracker.elapsed, buildBoxOpenPriceResolver())
       ├─ baseAggregateCache 命中 → reuse breakdownBase + visible history
       └─ per row: priceResolver(itemKey) → { buyOrderUnit } → buyOrderValue/hourlyValue
                                ↓ IPC.STATS broadcast (5Hz)
renderer
  ├─ Overlay.tsx
  │    └─ buildBossChestRings(chestDrops.lastDropWallTime, Date.now()/1000)
  │         → SVG rings (7min/lap, 3 颜色档)
  │    └─ "Box 5m" 文本 (距上次掉落)
  ├─ Live.tsx
  │    └─ LiveChestStatValue (commonTotal/rareTotal + commonPerHour/rarePerHour)
  │    └─ fillPrediction (用 commonPerHour/rarePerHour 预测库存满时间)
  ├─ Loot.tsx + LootBoxSection.tsx
  │    └─ breakdown 表格 (Item/Count/Drop%/Buyout/Hourly) + reclassify UI
  ├─ Chests.tsx (容量进度条，不展示掉落统计)
  ├─ ChestDropPanel.tsx (history 时间线)
  └─ LiveMemoryDiagnostics.tsx (dev 诊断：commonTotal/rareTotal/combinedTotal)
                                ↓
SessionStateService (15s 持久化 + restore-on-startup)
  ├─ chestDropTracker.captureSnapshot() → session_state.json
  ├─ boxOpenTracker.captureSnapshot()   → session_state.json
  └─ tryRestoreOnSnapshot → chestDropTracker.applySnapshot + boxOpenTracker.applySnapshot
```

## 二、P0 严重问题（必须立即修复）

### D-P0-1. `chestDrops.lastDropWallTime` 字段名与实际语义不符

- 位置：
  - 定义：[chestDropTracker.ts:398-414](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L398-L414)
  - 类型：[shared/types.ts:79](file:///d:/Project/TBH/tbh-companion/app/shared/types.ts#L79) — `lastDropWallTime: number | null` 注释 "Epoch seconds of the most recent chest drop"
  - 消费：[Overlay.tsx:67, 187-197](file:///d:/Project/TBH/tbh-companion/app/src/renderer/Overlay.tsx#L187-L197) — 显示 "Box 5m"
- 事实：
  - 内部变量名是 `lastRareWallTime`（line 398），循环 `if (history[i].category === "rare")` 只匹配 rare
  - 字段返回名是 `lastDropWallTime`，类型注释写 "most recent chest drop"（任意类型）
  - Overlay 消费时显示 "Box 5m"，文案暗示"距上次任意宝箱掉落"
- 实际行为：玩家只掉 common 不掉 rare 时，`lastDropWallTime` 永远是 null → Overlay 永远不显示 "Box 5m" → rings 不绘制 → 玩家误以为"掉落检测坏了"
- 复现场景：早期游戏 / 闲置阶段长时间只有 common 掉落
- 修复方案（任选）：
  - **方案 A（推荐）**：实现真正的"任意掉落"语义。修改循环条件去掉 `category === "rare"` 过滤，返回 `history[history.length-1].wallTime`（最新一条）。字段名/Overlay 文案不变。代价：rings 7 分钟一圈的语义需要重新审视（common 掉落频率高，rings 永远在 lap 0）
  - **方案 B**：保留 rare-only 语义，但显式重命名。`lastDropWallTime` → `lastRareDropWallTime`，Overlay 文案 "Box 5m" → "Stage boss: 5m"。语义对齐，但破坏 IPC 契约（renderer 需同步改）
  - **方案 C**：新增 `lastAnyDropWallTime` 与 `lastRareDropWallTime` 两个字段，Overlay rings 用 rare，"Box 5m" 文本用 any
- **优先级理由**：字段名误导导致 UI 长时间显示空状态，是用户可感知的功能 bug
- **状态**：`[新增]`

## 三、P1 中等问题（尽快修复）

### D-P1-1. `recordLogDrop` 是死代码

- 位置：[chestDropTracker.ts:327-349](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L327-L349)
- 事实：
  - grep 全 `app/src` 主进程代码，`recordLogDrop` 调用点 = 0
  - 仅 `app/test/core/chestDropTracker.test.ts` 与 `app/test/main/{stats,sessionStateService}.test.ts` 共 5+ 处调用
  - 主进程生产路径只走 `recordLiveChestDrop`（TrackingService.ts:442）
- 影响：
  - 23 行核心逻辑 + `resolveStageBoxDrop`（含 catalog 索引）+ `canonicalTrackerBoxIdFromIndex` 等维护负担
  - 测试与生产路径脱节：5 个 test case 覆盖 recordLogDrop，但实际生产用 recordLiveChestDrop（仅 3 个 test case 覆盖）
  - 误导后续维护者以为 save 路径会调 recordLogDrop
- 修复：
  - 若 save 路径计划保留：补一个 `watcher.onSnapshot` → 解析 Player.log ItemKey → `recordLogDrop` 的实际调用
  - 若 save 路径已废弃：删除 recordLogDrop + 相关测试 + resolveStageBoxDrop（如未被外部用），或仅保留 export 但加 `@deprecated` 注释
- **状态**：`[新增]`

### D-P1-2. `ChestDropTracker.applySnapshot` 后 `lastRareWallTime` 来自截断历史，误导 Overlay

- 位置：[chestDropTracker.ts:419-449](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L419-L449)
- 事实：
  - `captureSnapshot` 仅持久化 `countsByKey / namesByKey / categoriesByKey / history`
  - `lastRareWallTime` 在 getStats 时从 history 末尾反向扫描计算（line 398-404）
  - applySnapshot 后 history 截断到 500 条（昨日 P1-8 修复），但 history 末尾的 rare 可能是几小时前的
  - getStats 反向扫描会找到这条"几小时前"的 rare，返回 `lastRareWallTime = 数小时前`
- 影响：app 重启后 Overlay 显示 "Box 3h12m"，rings 全部满圈（red），误导玩家以为有 stage boss 掉落刚发生
- 修复：在 `captureSnapshot` 持久化 `lastRareWallTime` 字段（在 recordLiveChestDrop 时增量维护），applySnapshot 时直接恢复
- **状态**：`[昨日 P1-8 残留衍生问题]`

### D-P1-3. `BoxOpenTracker.recordOpen` 未校验 `count` 参数

- 位置：[boxOpenTracker.ts:69-92](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L69-L92)
- 事实：
  - 签名 `count: number`，无 `count > 0` 守卫
  - 若 caller 传 0/负数：
    - line 83 `itemMap.set(key, (current ?? 0) + count)` → 计数变 0 或负
    - line 87 `history.push({ count })` → history 含 0/负数项
    - getStats 中 `if (count <= 0) continue`（line 186）跳过，但 `totalOpens += count`（line 190）已累加 → totalOpens 与 breakdown 不一致
- 实际影响：TrackingService.ts:497 固定传 1，生产无问题。但 API 契约不清晰，未来扩展易踩坑
- 修复：开头加 `if (!Number.isFinite(count) || count <= 0) return;`
- **状态**：`[新增]`

### D-P1-4. `reclassifyItem` 跨 boxKey 后 history 顺序不变式破坏

- 位置：[boxOpenTracker.ts:260-264](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L260-L264)
- 事实：
  ```ts
  for (const h of this.history) {
    if (h.boxKey === fromBoxKey && h.itemKey === itemKey) {
      h.boxKey = toBoxKey;  // 仅改 boxKey，不改 wallTime
    }
  }
  ```
  - history 整体不再按 wallTime 严格升序：toBoxKey 现在含一组来自 fromBoxKey 的 history，其 wallTime 可能早于 toBoxKey 已有项
- 影响：
  - `getBaseAggregates` line 197 `allBoxHistory.slice(-HISTORY_VISIBLE).reverse()` 假设 history 按 wallTime 升序
  - 乱序后 slice(-N) 取的不是"最新 N 条"，而是"末尾 N 条"（可能含旧 fromBox 项）
  - `lastOpenWallTime = visible[0].wallTime`（line 198）取的不是真正最新
- 修复：
  - 选项 A：reclassify 后对 toBoxKey 的 history 按 wallTime 排序
  - 选项 B：在 `getBaseAggregates` 内对 `allBoxHistory` 排序后再 slice
  - 选项 C（推荐）：保持 history 整体按 wallTime 升序不变式，reclassify 后用 `this.history.sort((a, b) => a.wallTime - b.wallTime)`（O(N log N) 但 reclassify 是低频用户操作）
- **状态**：`[新增]`

### D-P1-5. `BoxOpenTracker.getStats` 静默丢弃非标准 boxKey

- 位置：[boxOpenTracker.ts:101-102](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L101-L102)
- 事实：
  ```ts
  const category = categoryFromBoxKey(boxKey);
  if (category == null) continue;  // 静默跳过
  ```
  - `categoryFromBoxKey` 只识别 `common/rare/act/unclassified`，其他返回 null
  - 任何 recordOpen 收到非标准 boxKey（如未来新增 boxType、手动注入、schema drift）的记录都被静默丢弃
- 影响：数据"消失"无日志，难以排查
- 修复：
  - 选项 A：recordOpen 时校验 boxKey，非标准则归入 `UNCLASSIFIED_BOX_KEY`
  - 选项 B：getStats 在 null category 时 `log.warn` 一次（去重避免刷屏）
- **状态**：`[新增]`

### D-P1-6. `LiveChestDropAggregator.feed` 时钟回拨未处理

- 位置：[chestDropTracker.ts:239-268](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L239-L268)
- 事实：
  - 判断 `at - this.lastFeedAt > this.burstGapSec` 触发 flush
  - 若 `at < this.lastFeedAt`（系统时间被回拨 / NTP 校时 / 手动改时钟），`at - lastFeedAt` 为负
  - 负数不 `> 0.5`，因此不 flush，buffer 持续累积
- 影响：
  - buffer 无限增长（每 tick 增加输入但不 flush）
  - 内存泄漏 + 后续 flush 一次性 collapse 大量历史数据 → 一次性记录大量伪掉落
- 实际触发概率：低（NTP 校时罕见，但系统休眠唤醒后可能发生）
- 修复：
  ```ts
  if (this.lastFeedAt != null && at < this.lastFeedAt) {
    // Clock moved backward: flush pending buffer with old timestamp, then reset.
    flushed = collapseLiveChestDrops(this.buffer);
    this.buffer = [];
    this.lastFeedAt = null;
  }
  ```
- **状态**：`[新增]`

### D-P1-7. `ChestDropCategory` 类型散落多处字面量

- 位置：
  - [chestDropTracker.ts:13](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L13) `export type ChestDropCategory = "common" | "rare"`
  - [shared/types.ts:59, 67, 91](file:///d:/Project/TBH/tbh-companion/app/shared/types.ts#L59) `"common" | "rare"` 字面量重复 3 次
  - [shared/types.ts:1097](file:///d:/Project/TBH/tbh-companion/app/shared/types.ts#L1097) LiveMemorySnapshot.chestDrops 字面量
- 影响：
  - 未来若新增 `act` 类别（理论可能），需同步改 4 处
  - 与 `BoxCategory`（已统一到 shared）不一致
- 修复：在 shared/types.ts 提升 `export type ChestDropCategory = "common" | "rare"`，所有引用改为 import
- **状态**：`[昨日 P2-1 部分残留]`

### D-P1-8. `applySnapshot` 不校验数值类型

- 位置：
  - [chestDropTracker.ts:428-449](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L428-L449)
  - [boxOpenTracker.ts:283-309](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L283-L309)
- 事实：
  - `Object.entries(data.countsByKey)` 后 `new Map(entries)` 直接接受 any value
  - 若 snapshot 文件被手动编辑或 schema drift 导致 `count: "abc"`、`wallTime: "2026-07-17"`：
    - 后续 `(current ?? 0) + count` → string concat → NaN 传播
    - history.push 后所有 arithmetic 污染
  - JSON.parse 不区分 number/string（"60" 是 string，60 是 number）
- 影响：corrupt snapshot 让整个 tracker 状态损坏，UI 显示 NaN/Infinity
- 修复：filter 时加 `Number.isFinite(Number(value))`，无效值丢弃 + log.warn
- **状态**：`[新增]`

## 四、P2 低优先级问题（技术债）

### D-P2-1. `collapseLiveChestDrops` 输出顺序不稳定

- 位置：[chestDropTracker.ts:149-166](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L149-L166)
- 事实：`for (const [cat, n] of counts)` 按 Map 插入顺序遍历，input 顺序由 reader tick 决定
- 影响：相同 input 不同顺序可能产生不同 kept 顺序（但 recordLiveChestDrop 按 key 写入不同桶，breakdown 顺序由 count 决定，最终 UI 稳定）
- 修复（可选）：对 kept 排序为 `["common", "rare"]` 固定顺序
- **状态**：`[新增]`

### D-P2-2. `recordLiveChestDrop` 返回值恒为 true

- 位置：[chestDropTracker.ts:309-325](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L309-L325)
- 事实：
  - 签名 `: boolean`，永远 `return true`
  - TrackingService.ts:442 用 `if (this.chestDropTracker.recordLiveChestDrop(...))` 判断——但永远不会 false
- 影响：API 契约误导，调用方写了永远不会触发的分支
- 修复：改 `: void`，或实现真正的失败条件（如 category 非法）
- **状态**：`[新增]`

### D-P2-3. `BoxOpenStats.lastOpenWallTime` 依赖 history 顺序不变式

- 位置：[boxOpenTracker.ts:198](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L198)
- 事实：`visible[0].wallTime` 假设 visible 已按 wallTime 升序 + reverse
- 影响：若 history 顺序被破坏（见 D-P1-4），lastOpenWallTime 取错
- 修复：`Math.max(...visible.map(h => h.wallTime))`，或保持 history 排序不变式
- **状态**：`[D-P1-4 的衍生]`

### D-P2-4. `ChestDropTracker.getStats` 缓存命中仍重算 totals

- 位置：[chestDropTracker.ts:378-383](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts#L378-L383)
- 事实：cache 命中时仍 for-loop 遍历 breakdown 累加 commonTotal/rareTotal
- 影响：5Hz × breakdown 长度（通常 < 10），性能影响可忽略
- 修复（可选）：把 totals 也缓存到 breakdownCache 同级字段
- **状态**：`[新增]`

### D-P2-5. `BoxOpenTracker.getStats` 未缓存 priceResolver 结果

- 位置：[boxOpenTracker.ts:108-128](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L108-L128)
- 事实：
  - 每个 breakdown row 调用 `priceResolver(itemKey)`
  - inventory hit 时 O(1)，但 unpriced items 每次 5Hz 都走 lookupPriceSnapshot 路径（4 步：catalogItemKeyFromSave + gameDataLookup.get + marketHashName + snapshot.prices[hash]）
  - 5Hz × N unpriced items × 20 boxKey → ~2000 次/秒
- 影响：现代 CPU 可忽略，但 1000+ unpriced items 时 CPU 占用可见
- 修复（可选）：baseAggregateCache 中缓存 `(itemKey, priceInfo)`，inventory/lookupPrice 更新时 invalidate
- **状态**：`[新增]`

## 五、代码质量审计

### 5.1 分层

- **现状**：core 层 `chestDropTracker.ts` 通过 `import { loadStageBoxCatalogFile } from "./stageBoxTracker"` 间接依赖 `bundledData.ts` 的 `node:fs.readFileSync`
- **判定**：CORE.md 已明文允许此例外（`bundledData.ts` 是唯一 sanctioned exception，side-effect-free），非新问题
- **改进机会**：将 catalog 作为构造函数参数注入到 `ChestDropTracker`，单元测试时可直接传 mock catalog，无需 fs。但增加 caller 复杂度，需权衡

### 5.2 命名一致性

| 问题 | 位置 | 说明 |
|------|------|------|
| `lastDropWallTime` 实际是 `lastRareDropWallTime` | chestDropTracker.ts:414 | 见 D-P0-1 |
| `recordLiveChestDrop(): boolean` 恒 true | chestDropTracker.ts:309 | 见 D-P2-2 |
| `LIVE_CHEST_KEY` 合成值（900910/900920）与 ItemKey prefix 范围（910000+/920000+）不同 | chestDropTracker.ts:19-22 | 设计正确（避免冲突），但缺单测验证 |

### 5.3 类型契约

- `ChestDropStats.lastDropWallTime: number | null` 注释写 "most recent chest drop"（任意类型）——与实现不符（见 D-P0-1）
- `BoxOpenStats.history: BoxOpenHistoryEntry[]` 注释 "Most recent N (visible window)"，未说明是否按时间排序——实际依赖不变式（见 D-P1-4 / D-P2-3）
- `ChestDropTrackerSnapshot` 与 `BoxOpenTrackerSnapshot` 结构不对称：前者 history 是顶级字段，后者也是，但 countsByKey 结构不同（前者 flat，后者 nested）

### 5.4 错误处理

- `recordLiveChestDrop` / `recordOpen` 不抛异常，正常路径无问题
- `applySnapshot` 无类型校验（见 D-P1-8）
- `SessionStateService.tryRestoreOnSnapshot` 已 try/catch + finally（昨日 P0-5 已修）
- `LiveChestDropAggregator.feed` 不校验 `at` 类型/范围（见 D-P1-6）

### 5.5 测试覆盖缺口

| 缺口 | 位置 | 优先级 |
|------|------|--------|
| `collapseLiveChestDrops` 函数本身无直接单测（仅通过 LiveChestDropAggregator 间接覆盖） | chestDropTracker.ts:149 | 中 |
| `recordLiveChestDrop` + `recordLogDrop` 混合一致性未测（生产仅用前者，但测试混用） | chestDropTracker.ts | 中 |
| `getStats(elapsedSeconds <= 0)` 边界未测 | chestDropTracker.ts:394 | 中 |
| `BoxOpenTracker.recordOpen(count <= 0)` 边界未测 | boxOpenTracker.ts:69 | 中 |
| `BoxOpenTracker.reclassifyItem` 跨 boxKey 后 history 顺序未测 | boxOpenTracker.ts:233 | 高（与 D-P1-4 关联） |
| `BoxOpenTracker.getStats` 非 standard boxKey 静默丢弃未测 | boxOpenTracker.ts:101 | 中 |
| `LiveChestDropAggregator.feed(at < lastFeedAt)` 时钟回拨未测 | chestDropTracker.ts:239 | 中 |
| `applySnapshot` 含 corrupt value（count 为 string/null）未测 | 两个 tracker | 低 |

## 六、性能瓶颈审计

### 6.1 已优化项（昨日已修，本次复核）

| 优化点 | 状态 | 复核结论 |
|--------|------|----------|
| catalog 索引化 + 缓存 | ✅ | `getStageBoxCatalogIndex` 懒加载 + byId/canonicalByLevel 双索引，O(1) 查找 |
| `breakdownCache` / `historyCache` | ✅ | 5Hz 调用命中缓存，避免重复分配 |
| `baseAggregateCache` (BoxOpenTracker) | ✅ | state-mutating 方法显式置 null，getStats 复用 |
| `inventoryByItemKey` Map 索引 | ✅ | `setInventorySnapshot` 重建，`buildBoxOpenPriceResolver` O(1) |
| `applySnapshot` history 截断到 HISTORY_LIMIT | ✅ | 防止 corrupt snapshot 导致内存膨胀 |

### 6.2 残留瓶颈（优化机会，非阻塞）

| 瓶颈 | 位置 | 频率 | 影响 | 修复成本 |
|------|------|------|------|----------|
| `lastRareWallTime` 反向扫描 history | chestDropTracker.ts:398-404 | 5Hz × 最坏 500 = 2500 次/秒 | 现代 CPU 可忽略，但累积时可能命中 cache miss path | 低（增量维护 + 缓存） |
| `BoxOpenTracker.getStats` 重复调用 priceResolver | boxOpenTracker.ts:108-128 | 5Hz × N items × 20 boxKey | 1000+ unpriced items 时 CPU 占用可见 | 中（缓存 + invalidation） |
| `buildStats` 5Hz 重建所有 BoxOpenStats 数组 | stats.ts:140 | 5Hz | breakdown 每次新建数组 | 中（lastResult 缓存） |
| `ChestDropTracker.getStats` cache 命中仍重算 totals | chestDropTracker.ts:378-383 | 5Hz × breakdown < 10 | 可忽略 | 低 |
| `LootBoxSection` 大列表无虚拟化 | LootBoxSection.tsx:171-180 | 渲染时 | 1000+ items DOM 节点爆炸 | 高（引入 react-virtuoso） |
| `Overlay` rings 数组每次渲染重建 | Overlay.tsx:84 | 1Hz | 0-3 元素，可忽略 | 不修复 |
| `IPC.STATS` 序列化整个 Stats | broadcast | 5Hz | ~5KB × 5 = 25KB/s | 不修复 |
| `reclassifyItem` 全 history 遍历 | boxOpenTracker.ts:260-264 | 用户操作频率 | 单次 O(N)，可忽略 | 不修复 |

### 6.3 性能结论

- 当前生产规模（< 100 boxKeys、< 1000 breakdown rows、5Hz 广播）性能完全可接受
- 残留瓶颈全部为"未来规模扩张时的优化机会"，非"现在的 bug"
- 唯一值得短期投入的是 `BoxOpenTracker.getStats` 的 priceResolver 缓存（D-P2-5），但优先级低于 P0/P1 bug 修复

## 七、整改方案

### 第一阶段（P0 + P1 关键 bug，立即）

| ID | 任务 | 影响文件 | 预计代码行 |
|----|------|----------|------------|
| D-P0-1 | 实现 `lastDropWallTime` 真正语义（推荐方案 A：任意掉落） | chestDropTracker.ts, Overlay.tsx | ~10 |
| D-P1-2 | captureSnapshot 持久化 `lastRareWallTime`，applySnapshot 直接恢复 | chestDropTracker.ts, shared/types.ts | ~15 |
| D-P1-3 | `recordOpen` 加 count > 0 守卫 | boxOpenTracker.ts | ~3 |
| D-P1-4 | `reclassifyItem` 后保持 history 排序不变式 | boxOpenTracker.ts | ~5 |
| D-P1-6 | `LiveChestDropAggregator.feed` 处理时钟回拨 | chestDropTracker.ts | ~8 |
| D-P1-8 | `applySnapshot` 加 Number.isFinite 校验 | 两个 tracker | ~20 |

### 第二阶段（P1 代码质量，下个迭代）

| ID | 任务 | 影响文件 | 备注 |
|----|------|----------|------|
| D-P1-1 | 决定 `recordLogDrop` 命运：删除 / 重新接入 save 路径 | chestDropTracker.ts + 测试 | 需 product 决策：save 路径是否仍要支持 |
| D-P1-5 | `BoxOpenTracker.getStats` 非 standard boxKey 归入 unclassified 或 warn | boxOpenTracker.ts | ~5 行 |
| D-P1-7 | 提升 `ChestDropCategory` 到 shared/types.ts | shared/types.ts + 4 处引用 | 类型重构 |
| 测试缺口 | 补 D-P1-3/4/6/8 的回归测试 | test/core/*.test.ts | ~80 行 |

### 第三阶段（P2 技术债，长期）

| ID | 任务 | 备注 |
|----|------|------|
| D-P2-1 | `collapseLiveChestDrops` 输出排序稳定化 | 可选 |
| D-P2-2 | `recordLiveChestDrop` 返回类型改 void | API 契约清理 |
| D-P2-3 | `lastOpenWallTime` 用 Math.max 防御乱序 | 与 D-P1-4 联动 |
| D-P2-4 | `getStats` totals 缓存 | 微优化 |
| D-P2-5 | `BoxOpenTracker` priceResolver 结果缓存 | 中等优化，规模大时再修 |
| LootBoxSection 虚拟化 | 引入 react-virtuoso | 新增依赖，独立 PR |

## 八、总体评价

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构分层 | A- | core 层无 Electron/React，tracker 纯函数化优秀；唯一耦合是 catalog fs 读取（已 sanctioned） |
| 业务流程 | B+ | 端到端链路清晰，aggregator 跨 tick 缓冲设计精巧 |
| 逻辑正确性 | B | 1 个 P0 字段语义误导 + 4 个 P1 边界 bug（count/reclassify/clock-skew/snapshot 类型） |
| 代码规范 | B | 类型散落（ChestDropCategory）、死代码（recordLogDrop）、API 契约不清晰（boolean 恒 true） |
| 性能 | A- | 昨日优化已显著改善，残留瓶颈均为未来规模扩张时的优化机会，非当前阻塞 |
| 测试覆盖 | B- | aggregator 覆盖优秀，但 recordOpen 边界 / reclassify 后顺序 / applySnapshot corrupt value 等关键场景缺测 |
| 数据完整性 | B | snapshot 缺类型校验是主要风险点 |

**核心建议**：
1. **优先修 D-P0-1**：字段语义与 UI 文案对齐，消除用户可感知的"功能失效"错觉
2. **同步修 D-P1-2/3/4/6/8**：均为边界 bug，修复成本低、回归风险小
3. **决策 D-P1-1**：`recordLogDrop` 死代码处理需 product 决策（save 路径去留）
4. **测试补强**：D-P1-3/4/6/8 修复时同步补单测，防止回归

## 九、与昨日报告的关系

| 本次发现 | 昨日报告对应项 | 关系 |
|----------|----------------|------|
| D-P0-1 lastDropWallTime 语义不符 | 昨日 P0-7（rings 负 elapsed） | 不同问题：昨日修了"显示崩"，本次发现"字段名误导" |
| D-P1-1 recordLogDrop 死代码 | 昨日未涉及 | 新发现 |
| D-P1-2 applySnapshot 后 lastRareWallTime 误导 | 昨日 P1-8（applySnapshot 截断 history） | 衍生：截断修复后暴露的时间戳误导 |
| D-P1-3 recordOpen count 未校验 | 昨日 P2-6（reclassifyItem from===to） | 同类边界缺口，昨日未覆盖 |
| D-P1-4 reclassifyItem history 顺序 | 昨日未涉及 | 新发现 |
| D-P1-5 getStats 静默丢弃非标准 boxKey | 昨日未涉及 | 新发现 |
| D-P1-6 aggregator 时钟回拨 | 昨日未涉及 | 新发现 |
| D-P1-7 ChestDropCategory 散落 | 昨日 P2-1（BoxCategory 统一） | 残留：BoxCategory 已统一，ChestDropCategory 未跟上 |
| D-P1-8 applySnapshot 无类型校验 | 昨日 P0-5（tryRestoreOnSnapshot finally） | 衍生：try/catch 修了"出错不挂"，但 corrupt value 未防 |
| D-P2-5 priceResolver 缓存 | 昨日 P1-7（boxOpenTracker baseAggregateCache） | 衍生：base 缓存了，price 仍每次重算 |

本次审计独立于昨日，发现 14 个新问题（1 P0 + 8 P1 + 5 P2），其中 5 个是昨日修复后的衍生问题（说明昨日修复引入了新的边界考虑点），9 个是昨日未覆盖的新角度。
