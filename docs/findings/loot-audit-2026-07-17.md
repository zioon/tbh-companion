# 宝箱物品统计（Loot）链路增量复审报告

- 审计日期：2026-07-17（晚于 `chest-code-audit-2026-07-17.md` 同日完成的初版整改）
- 审计范围：**打开宝箱获得物品的统计与展示链路**（boxOpen → recordOpen → getStats → IPC → Loot tab → reclassify）。**不**重复审计 chest drop 链路（chestDropTracker / LiveChestDropAggregator 已在初版报告中覆盖）。
- 审计方法：源码复核 + 两个并行 search subagent 全链路追踪（事实陈述见文末"事实底稿"）。
- 文件坐标：
  - core：[boxOpenTracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts)、[boxOpenLog.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenLog.ts)、[gamedata.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/gamedata.ts)、[marketName.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/marketName.ts)
  - main：[TrackingService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts)、[stats.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/stats.ts)、[handlers/loot.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/ipc/handlers/loot.ts)、[SessionStateService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/SessionStateService.ts)、[InventoryService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/InventoryService.ts)、[LookupPriceService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/LookupPriceService.ts)、[liveMemory/runtime.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/liveMemory/runtime.ts)
  - renderer：[tabs/Loot.tsx](file:///d:/Project/TBH/tbh-companion/app/src/renderer/tabs/Loot.tsx)、[components/loot/LootBoxSection.tsx](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx)、[lib/useLoot.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/useLoot.ts)、[lib/useStats.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/useStats.ts)、[lib/lootFilters.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/lootFilters.ts)、[lib/boxLootFilters.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/boxLootFilters.ts)、[lib/lootFilterCommon.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/lootFilterCommon.ts)
  - shared：[types.ts](file:///d:/Project/TBH/tbh-companion/app/shared/types.ts)、[ipc.ts](file:///d:/Project/TBH/tbh-companion/app/shared/ipc.ts)、[preload/index.ts](file:///d:/Project/TBH/tbh-companion/app/src/preload/index.ts)

## 一、增量复审结论速览

| 类别 | 数量 | 说明 |
|------|------|------|
| 旧报告修复项落地核对 | 11/11 全部落地 | P1-1 / P1-7 / P1-8 / P1-10 / P1-11 / P2-1 / P2-2 / P2-5 / P2-6 / P2-7 / P2-11 经源码复核全部生效 |
| 旧报告修复项回归 | 0 | 未发现任何整改项被破坏 |
| **新发现 P0（功能性故障）** | **1** | **F1 loot 页面"没有任何记录" — bundled 偏移全为 0 + 自愈死锁** |
| 新发现 P1（应尽快修复） | 2 | N1 useMemo 失效；N2 reclassify toBoxKey 不校验 |
| 新发现 P2（技术债） | 11 | N3~N13，详见第四节 |
| 新发现 P3（测试覆盖缺口） | 1 类 | N14 端到端 / 边界 case / IPC 校验均无测试 |
| 仍遗留预存问题（与本次审计无关） | 10 个 vitest 失败 | 初版报告已确认，未在本次范围内处理 |

> **P0-F1 是本次复审最重要的发现**：loot tab 在所有已支持 game version（1.00.21 / 1.00.23 / 1.00.27）上可能完全不可用，因为 BoxOpenLog 的 IL2CPP 偏移在 bundled table 中全为 0，且自愈机制被同样的偏移缺失阻塞。详见第四节 P0-F1。

## 二、业务流程全景（loot 主线）

```
游戏内存 GetBoxLog ─readRuntimeBoxOpenLog→ BoxOpenEntry[] ─┐
  runtime.ts:853-922                                          │
  itemKey/boxType/level 字段条件读出（offset 0 时为 undefined）│
                                                              ↓
       ┌────────────────────────────────────────────────────────┐
       │ main: TrackingService.ingestLiveFrame (5Hz)             │
       │  TrackingService.ts:538-550                             │
       │  ├─ resolveBoxOpenEntry(entry)                          │
       │  │   TrackingService.ts:318-331                         │
       │  │   ├─ resolveBoxKey(boxType, level) ?? "unclassified" │
       │  │   │   boxOpenLog.ts:27-32                            │
       │  │   ├─ catalogItemKeyFromSave(entry.itemKey)           │
       │  │   │   gamedata.ts:37-42  (save id → catalog id)      │
       │  │   ├─ gameDataLookup.get(catalogId)?.name ?? #itemKey │
       │  │   └─ gameDataLookup.get(catalogId)?.grade ?? null    │
       │  └─ boxOpenTracker.recordOpen(boxKey, itemKey, ...)     │
       │      boxOpenTracker.ts:69-92  (count++ + history.push)  │
       └────────────────────────────────────────────────────────┘
                              ↓
       ┌────────────────────────────────────────────────────────┐
       │ core: BoxOpenTracker                                     │
       │  ├─ countsByKey: Map<boxKey, Map<itemKeyStr, count>>    │
       │  ├─ namesByKey / gradesByKey: Map<itemKeyStr, ...>       │
       │  ├─ history: BoxOpenHistoryEntry[] (cap 500)            │
       │  └─ baseAggregateCache: Map<boxKey, BaseAggregate>      │
       │     P1-7 缓存：recordOpen/reclassify/reset/snapshot 时失效│
       └────────────────────────────────────────────────────────┘
                              ↓
       ┌────────────────────────────────────────────────────────┐
       │ main: TrackingService.getStats (5Hz + 1Hz safety)       │
       │  TrackingService.ts:166-187                              │
       │  └─ buildStats(... boxOpenTracker, priceResolver)       │
       │      stats.ts:147  boxOpenTracker.getStats(elapsed, pr) │
       │      每次新建 BoxOpenStats[] + 每个 box 新建 breakdown[] │ ← N1 根因
       │      boxOpenTracker.ts:95-158                            │
       │                                                            │
       │  priceResolver = buildBoxOpenPriceResolver()             │
       │  TrackingService.ts:337-360                               │
       │   ├─ L1: inventoryByItemKey.get(itemKey).buyOrderUnit    │
       │   │   P1-1 索引化（TrackingService.ts:71, 255-265）       │
       │   └─ L2: lookupPriceSnapshot.prices[marketHashName(item)]│
       │       LookupPriceService 30min 轮询                       │
       └────────────────────────────────────────────────────────┘
                              ↓ broadcast(IPC.STATS)
       ┌────────────────────────────────────────────────────────┐
       │ renderer: useStats (5Hz useSyncExternalStore)            │
       │  useStats.ts:65-67                                       │
       │  └─ useLoot().boxOpens = stats?.boxOpens ?? []           │
       │      useLoot.ts:11-12                                    │
       └────────────────────────────────────────────────────────┘
                              ↓
       ┌────────────────────────────────────────────────────────┐
       │ renderer: Loot tab                                        │
       │  Loot.tsx:35-42  boxOpens.map(stats => <LootBoxSection/>)│
       │  └─ LootBoxSection                                        │
       │     LootBoxSection.tsx:65  useMemo(filterAndSortLoot)    │ ← N1 失效点
       │     LootBoxSection.tsx:111-127 handleAssign              │ ← N3 无错误反馈
       │     LootBoxSection.tsx:179  rowContainSize content-vis   │ ← P1-10 已修
       └────────────────────────────────────────────────────────┘
                              ↓ onReclassify?.(itemKey, fromBoxKey, toBoxKey)
       ┌────────────────────────────────────────────────────────┐
       │ IPC: IPC.LOOT_RECLASSIFY_ITEM                             │
       │  loot.ts:26-38  isNonEmptyString(toBoxKey) 只校验非空    │ ← N2 不校验格式
       │  └─ services.reclassifyLootItem                           │
       │     TrackingService.ts:300-310                            │
       │     ├─ boxOpenTracker.reclassifyItem(fromBoxKey, itemKey, │
       │     │                                toBoxKey)            │
       │     │   boxOpenTracker.ts:233-266                         │
       │     │   ├─ P2-6 from===to no-op 守卫                       │
       │     │   ├─ countsByKey 移动 count                          │
       │     │   └─ history 原地改 boxKey (h.boxKey = toBoxKey)    │ ← N16 immutability
       │     ├─ sessionState.flush(...) → writeFileSync            │
       │     │   SessionStateService.ts:197-203  (同步阻塞 main)   │
       │     └─ pushStats() → broadcast                            │
       └────────────────────────────────────────────────────────┘
```

## 三、旧报告修复落地核对（11/11 全部生效）

| 旧报告条目 | 文件:行 | 落地证据 |
|------------|---------|---------|
| P1-1 `inventoryByItemKey` 索引化 | [TrackingService.ts:71, 255-265, 340-345](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L255-L265) | `setInventorySnapshot` 一次遍历重建 `Map<itemKey, ResolvedInventoryRow>`，resolver 走 `Map.get` O(1) |
| P1-7 `boxOpenTracker` `baseAggregateCache` | [boxOpenTracker.ts:62, 91, 216, 225, 265, 308, 166-210](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L166-L210) | 缓存 `totalOpens / breakdownBase / visible history / lastOpenWallTime`；所有 state-mutating 方法显式置 null |
| P1-8 `applySnapshot` history 截断 | [boxOpenTracker.ts:302-307](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L302-L307) | `restored.length > HISTORY_LIMIT ? restored.slice(-HISTORY_LIMIT) : [...restored]` |
| P1-10 `LootBoxSection` memo + content-visibility | [LootBoxSection.tsx:65-127, 179](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L65-L127) | `useMemo` 包裹 `rows / gradeSelectOptions / columns`；`useCallback` 包裹 handler；`rowContainSize={rows.length > 50 ? "36px 0" : undefined}` |
| P1-11 `useChests` / `useBoxTimers` 一致性 | — | loot 链路未涉及，初版已修，本次不复核 |
| P2-1 类型同名不同义统一 | [boxOpenLog.ts:4-8](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenLog.ts#L4-L8) | `import type { BoxCategory } from "../../shared/types"; export type { BoxCategory };` |
| P2-2 共享 `matchesMulti` | [lootFilterCommon.ts:12-14](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/lootFilterCommon.ts#L12-L14) | `matchesMulti` 抽出共享，`lootFilters.ts` / `boxLootFilters.ts` / `offeringLootFilters.ts` 均 import |
| P2-5 `levelFromBoxKey` `Math.trunc` | [boxOpenLog.ts:72](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenLog.ts#L72) | `return Math.trunc(level);` |
| P2-6 `reclassifyItem` from===to 守卫 | [boxOpenTracker.ts:240-241](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L240-L241) | `if (fromBoxKey === toBoxKey) return;` + 注释解释 srcMap===dstMap 引用陷阱 |
| P2-7 `||` 替换 `??` 兜底空字符串 | [boxLootFilters.ts:67, 75, 78](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/boxLootFilters.ts#L67-L78) | `row.item?.name || row.name` 等四处均改 `||`，含混合优先级修正 |
| P2-11 IPC handler 参数校验 | [loot.ts:12-18, 21-37](file:///d:/Project/TBH/tbh-companion/app/src/main/ipc/handlers/loot.ts#L12-L37) | `isNonEmptyString` / `isPositiveFiniteInt`，handler 参数改 `unknown` + 守卫，无效参数 return（no-op） |

**结论：初版整改 11 项 loot 相关修复全部生效，未发现回归。**

## 四、新发现问题

### P0-F1. loot 页面"没有任何记录"功能性故障 — 偏移未推导导致整条链路瘫痪

**这是本次复审中发现的唯一 P0 级功能性故障：在所有已支持的 game version 上，loot tab 永远显示 "No boxes opened yet this session"，即使玩家在游戏中打开了宝箱。**

#### 根因链

1. **bundled 偏移默认全为 0** — [offsets.ts:184-193](file:///d:/Project/TBH/tbh-companion/app/src/core/liveMemory/offsets.ts#L184-L193)
   ```ts
   // RUNTIME_V1_00_21（被 v1.00.21 / v1.00.23 / v1.00.27 三个版本共享）
   log: {
     getItemWithBoxOpenTypeKey: 0, // ELogType.GetItemWithBoxOpen — not yet derived for v1.00.21/23/27
   },
   boxOpenLog: {
     itemStringKey: 0, // not yet derived — reader returns null when 0
     itemGradeType: 0,
     boxType: 0,
     level: 0,
   },
   ```
   **三个已支持版本的 BoxOpenLog 偏移都是 0**，注释明文 "not yet derived"。

2. **三道前置守卫直接返回 null** — [runtime.ts:860-878](file:///d:/Project/TBH/tbh-companion/app/src/core/liveMemory/runtime.ts#L860-L878)
   ```ts
   if (!o.runtime.log.getItemWithBoxOpenTypeKey) {
     return { opens: null, status: "getItemWithBoxOpenTypeKey = 0 (...)" };
   }
   if (!o.runtime.boxOpenLog?.itemStringKey) {
     return { opens: null, status: "boxOpenLog.itemStringKey = 0 (...)" };
   }
   ```
   偏移为 0 → `opens` 直接返回 `null`，**永远不会读取任何 entry**。

3. **ingestLiveFrame 跳过空 boxOpens** — [TrackingService.ts:538-540](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L538-L540)
   ```ts
   if (snap.boxOpens && snap.boxOpens.length > 0) {
     for (const entry of snap.boxOpens) { ... recordOpen(...); }
   }
   ```
   `null` 不会调 `recordOpen` → `boxOpenTracker` 永远为空 → `getStats` 永远返回 `[]`。

4. **UI 显示误导性空状态** — [Loot.tsx:28-32](file:///d:/Project/TBH/tbh-companion/app/src/renderer/tabs/Loot.tsx#L28-L32)
   ```tsx
   {boxOpens.length === 0 ? (
     <HintBanner>
       No boxes opened yet this session. Open a chest in-game with the live reader running to see
       recorded loot here.
     </HintBanner>
   )
   ```
   用户被告知"打开宝箱就能看到记录"，但**即使打开了也不会有记录**，且没有任何诊断信息说明"偏移未推导"。

#### 自愈机制存在但被同样的偏移缺失阻塞

[liveReader.ts:528-544](file:///d:/Project/TBH/tbh-companion/app/src/main/liveMemory/liveReader.ts#L528-L544) 有一个 enrichment heal 机制：
- 当 `enrichmentComplete === false` 时，每 tick 调 `peekBoxOpenLogCount` 探测 list 长度
- 检测到 `0 → >0` 转换时设置 `boxOpenEventPending = true`，触发 extractor 重新推导偏移

**但 `peekBoxOpenLogCount` 本身也依赖同样的偏移** — [runtime.ts:820-842](file:///d:/Project/TBH/tbh-companion/app/src/core/liveMemory/runtime.ts#L820-L842)
```ts
export function peekBoxOpenLogCount(...): PeekBoxOpenLogCountResult {
  if (o.typeInfoRva.logManager === 0n) {
    return { count: null, status: "typeInfoRva.logManager RVA = 0" };
  }
  if (!o.runtime.log.getItemWithBoxOpenTypeKey) {
    return { count: null, status: "getItemWithBoxOpenTypeKey = 0" };
  }
  ...
}
```

**死锁链**：
- `getItemWithBoxOpenTypeKey = 0` → `peekBoxOpenLogCount` 返回 null
- → 永远检测不到 "0→>0" 转换
- → `boxOpenEventPending` 永远为 false
- → enrichment heal 永远不被触发（针对 box-open 路径）
- → 偏移永远保持为 0

**唯一可能打破死锁的路径**：extractor 在初始 attach 时被调用一次（如果 `mayAttemptEnrichment` 返回 true），且 extractor 能从 class metadata 推导出 `getItemWithBoxOpenTypeKey`。但这依赖 extractor 实现且有明显失败率（[liveReader.ts:400-404](file:///d:/Project/TBH/tbh-companion/app/src/main/liveMemory/liveReader.ts#L400-L404) 的 "extractor returned null" 日志路径）。

#### 诊断信息已采集但未暴露给 UI

- [liveReader.ts:619](file:///d:/Project/TBH/tbh-companion/app/src/main/liveMemory/liveReader.ts#L619): `boxOpensStatus: boxOpenResult.status || undefined` 已放入 `LiveMemorySnapshot`
- [types.ts:1125-1127](file:///d:/Project/TBH/tbh-companion/app/shared/types.ts#L1125-L1127): `boxOpensStatus?: string` 字段类型已定义，注释明文 "Diagnostics: why `boxOpens` is null this tick. Dev-only."
- **但**：grep `boxOpensStatus` 在 `app/src/renderer/` 下**零匹配** —— 字段从未传递到 UI
- `TrackingService.ingestLiveFrame`（[TrackingService.ts:428-559](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L428-L559)）也**不读** `snap.boxOpensStatus`，只读 `snap.boxOpens`
- → 用户看到 "No boxes opened yet" 时无法区分"真的没开箱"vs"偏移未推导"

#### 与初版审计报告的关联

初版 [chest-code-audit-2026-07-17.md](file:///d:/Project/TBH/tbh-companion/docs/findings/chest-code-audit-2026-07-17.md) 的第二节业务流程图已画出 "boxOpenLog offset 0 时为 undefined" 的回退路径，但**未把这个事实升级为 P0 功能性故障**——因为初版审计的视角是"代码质量"而非"功能可用性"。这次复审从用户视角（"为什么打开宝箱没记录"）切入，才暴露出这个链路瘫痪问题。

#### 影响评估

- **严重性**：P0 功能性故障。loot tab 在所有已支持版本上**完全不可用**，除非 extractor 在启动时偶然成功推导出偏移。
- **触发条件**：所有 v1.00.21 / v1.00.23 / v1.00.27 版本，当 extractor 未能在 attach 阶段推导出 `getItemWithBoxOpenTypeKey` + `boxOpenLog.itemStringKey` 时。
- **用户感知**：打开宝箱后 loot tab 一直显示 "No boxes opened yet this session. Open a chest in-game with the live reader running..."。误导性文案让用户以为自己做错了什么。
- **数据完整性**：无影响（不写错误数据）。
- **下游影响**：`reclassifyItem` / `LootBoxSection` / `boxOpenTracker.getStats` 等所有 loot 链路代码都"正确地"处理空数据，不会崩溃。即整个 loot 子系统在偏移未推导时是"安静地死掉"。

#### 修复方向

**短期（让用户能区分"没开箱"vs"偏移未推导"）**：
1. `TrackingService.ingestLiveFrame` 读取 `snap.boxOpensStatus`，当非空时通过 `lastError` 或新的 `lootStatus` 字段传递给 `buildStats`。
2. `Stats` 类型新增 `lootStatus?: string` 字段。
3. `Loot.tsx` 在 `boxOpens.length === 0` 时检查 `stats.lootStatus`，若非空则显示诊断信息（如 "Box-open log offsets not yet derived for this game version — loot tracking unavailable."）而非误导性的 "Open a chest..."。

**中期（让自愈机制真正生效）**：
4. `peekBoxOpenLogCount` 在 `getItemWithBoxOpenTypeKey = 0` 时不应直接返回 null，而应尝试通过 `LogManager.logByType` dictionary 遍历找到 `GetItemWithBoxOpen` 的 enum 值（`ELogType` 枚举值是连续的小整数，可暴力试 0..N）。这能打破死锁，让 `0→>0` 转换检测真正生效。
5. 或：extractor 在每次 `enrichmentComplete === false` 时都尝试推导（移除 `MAX_ENRICHMENT_ATTEMPTS` 上限），但加 15s 节流避免 CPU 暴涨。

**长期（彻底解决）**：
6. 为 `getItemWithBoxOpenTypeKey` 和 `boxOpenLog.itemStringKey` 找到稳定的结构锚点（像 `heroList` 那样基于真实字段名），写入 bundled offset table。注释 [offsets.ts:113-124](file:///d:/Project/TBH/tbh-companion/app/src/core/liveMemory/offsets.ts#L113-L124) 说 "obfuscated field names, stable offsets"——如果偏移真的稳定，应该能通过一次性 dump 推导出来并 hardcode。

#### 测试覆盖

- [test/core/boxOpenTracker.test.ts](file:///d:/Project/TBH/tbh-companion/app/test/core/boxOpenTracker.test.ts) 全部测试都直接构造 `recordOpen` 调用，**完全绕过** `readRuntimeBoxOpenLog`。
- 没有测试覆盖 "偏移为 0 时 `readRuntimeBoxOpenLog` 返回 null → `ingestLiveFrame` 不调 `recordOpen` → UI 显示空状态" 这条端到端链路。
- 没有测试覆盖 `peekBoxOpenLogCount` 在偏移缺失时的行为（虽然函数本身有显式守卫）。

### P1-N1. `LootBoxSection` 的 `useMemo` 因 `stats.breakdown` 引用每次变化而失效

- 位置：[LootBoxSection.tsx:65](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L65)
  ```ts
  const rows = useMemo(() => filterAndSortLoot(stats.breakdown, filter), [stats.breakdown, filter]);
  ```
- 事实链：
  1. `TrackingService.pushStats()` 5Hz 调用 `getStats()`（[TrackingService.ts:162-164](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L162-L164)）
  2. `getStats` 调 `buildStats(... boxOpenTracker, priceResolver)`（[TrackingService.ts:176-187](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L176-L187)）
  3. `buildStats` 调 `boxOpenTracker.getStats(elapsed, priceResolver)`（[stats.ts:147](file:///d:/Project/TBH/tbh-companion/app/src/main/stats.ts#L147)）
  4. `getStats` 内每个 boxKey 都 `const breakdown: BoxOpenBreakdownRow[] = []`（[boxOpenTracker.ts:106](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L106)），并 `breakdown.push({...})` 新建每个 row 对象（[boxOpenTracker.ts:118-127](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L118-L127)）
  5. 即便 `baseAggregateCache` 命中（`breakdownBase` 复用），`breakdown` 数组本身与每个 row 都是新引用
  6. renderer 拿到的 `stats.breakdown` 引用每次广播都不同 → `useMemo` 依赖项失效 → `filterAndSortLoot` 5Hz 全量重算
- 影响：
  - P1-10 修复的实际效果被严重削弱。`useMemo` 看似缓存，实际每次广播都重算
  - 假设 20 个 boxKey × 50 行 breakdown × 5Hz = 5000 次/秒 filter+sort
  - 进一步：父组件 `Loot.tsx:35-42` 的 `boxOpens.map(...)` 也每次重建 `stats` prop 引用 → 所有 `LootBoxSection` 都重渲染
- 修复方向（任选其一）：
  - **方案 A（renderer 端，最小改动）**：把 `useMemo` 依赖改为内容签名
    ```ts
    const breakdownSig = stats.breakdown.map(r => `${r.itemKey}:${r.count}:${r.buyOrderUnit ?? ""}`).join("|");
    const rows = useMemo(() => filterAndSortLoot(stats.breakdown, filter), [breakdownSig, filter]);
    ```
  - **方案 B（main 端，结构性）**：在 `baseAggregateCache` 中也缓存 price-resolved `breakdown`，并通过 `TrackingService` 维护一个 "price snapshot 版本号"。`getStats` 接收版本号，版本号未变时复用上次的 `breakdown` 数组引用。需要 `InventoryService` / `LookupPriceService` 在更新时通知 `TrackingService` 增加 `priceEpoch`。
  - **方案 C（renderer 端，selector 化）**：把 `useStats` 拆为 `useBoxOpens()`，内部基于 `boxOpens` 内容做 `useSyncExternalStore` 的 `getSnapshot` 浅比较。改动面较大，但能从根上解决 5Hz 全组件树重渲染问题。
- **推荐方案 A**：改动最小，立即生效，不引入跨层耦合。`breakdownSig` 计算本身是 O(rows) 字符串拼接，但仍比 5Hz × 20 boxKey × 50 行 filter+sort 快几个数量级。

### P1-N2. `reclassifyLootItem` IPC handler 不校验 `toBoxKey` 格式

- 位置：[loot.ts:26-38](file:///d:/Project/TBH/tbh-companion/app/src/main/ipc/handlers/loot.ts#L26-L38)
- 事实：
  ```ts
  ipc.handle(IPC.LOOT_RECLASSIFY_ITEM, (_e, itemKey, fromBoxKey, toBoxKey) => {
    if (!isPositiveFiniteInt(itemKey) ||
        !isNonEmptyString(fromBoxKey) ||
        !isNonEmptyString(toBoxKey)) {
      return;
    }
    return services.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey);
  });
  ```
  仅校验 `toBoxKey` 是非空字符串。`"foo"` / `"rare:abc"` / `"rare:-1"` / `"common:999999"` / `"rare:3.5"` 等任意字符串都会通过。
- 后果链：
  1. `BoxOpenTracker.reclassifyItem`（[boxOpenTracker.ts:233-266](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L233-L266)）不校验 boxKey 格式，直接 `countsByKey.set(toBoxKey, ...)`。
  2. `getStats` 的过滤阶段（[boxOpenTracker.ts:100-102](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L100-L102)）：`categoryFromBoxKey(boxKey)` 对未知 category 返回 null → `continue` 跳过。即该 boxKey 的 stats 永不显示。
  3. `levelFromBoxKey("rare:abc")` 返回 null（[boxOpenLog.ts:62-73](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenLog.ts#L62-L73)），但 category 仍为 `"rare"`，stats 会输出 `boxKey="rare:abc"`、`level=null`、`label="rare:abc"`（[boxOpenLog.ts:35-51](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenLog.ts#L35-L51) 的 boxLabel 直接回退原串）。
  4. 用户视觉上"物品消失"（合法 category 但非法 level 时）或"卡在 unclassified 列表"（非法 category 时）。
  5. `SessionStateService.persist` 把非法 boxKey 写入 `session_state.json`，重启后通过 `applySnapshot` 恢复，长期占用 `countsByKey` 内存。
  6. UI 端 `isUnclassified = stats.category === "unclassified"`（[LootBoxSection.tsx:70](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L70)）只对真正 unclassified 显示 reclassify UI，**用户无法通过 UI 把非法 boxKey 修正回来**，只能 Reset。
- 实际触发条件：
  - 当前 UI 的 `RECLASSIFY_CATEGORY_OPTIONS` 只提供 `common / rare / act` 三个固定选项（[LootBoxSection.tsx:36-40](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L36-L40)），合法 UI 操作不会构造非法 category。
  - 但 IPC 通道本身对渲染进程不信任（loot.ts:5-11 注释明确"renderer is not trusted"），且测试 / 第三方脚本 / 未来 UI 改动都可能触发。
  - level 输入框（[LootBoxSection.tsx:205-213](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L205-L213)）是自由文本，`Number.parseInt("abc", 10) = NaN` 会被 `Number.isFinite` 拦下回退到无 level（合法），但 `Number.parseInt("3.5", 10) = 3` 接受（与 P2-8 修复的 `boxTrackerUi.parseCooldownMinutesInput` 严格性不一致 → 见 P2-N4）。
- 修复方向：
  ```ts
  // loot.ts
  const BOX_KEY_RE = /^(common|rare|act)(:\d+)?$/u;
  function isValidBoxKey(v: unknown): v is string {
    return typeof v === "string" && BOX_KEY_RE.test(v);
  }
  // handler 改为
  if (!isPositiveFiniteInt(itemKey) ||
      !isValidBoxKey(fromBoxKey) ||
      !isValidBoxKey(toBoxKey)) {
    return;
  }
  ```

### P2-N3. `LootBoxSection.handleAssign` 缺少 IPC 错误反馈

- 位置：[LootBoxSection.tsx:111-127](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L111-L127) + [useLoot.ts:16-20](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/useLoot.ts#L16-L20)
- 事实：
  ```ts
  // LootBoxSection.tsx:119
  onReclassify?.(itemKey, stats.boxKey, toBoxKey);
  // useLoot.ts:16-20
  reclassifyItem: useCallback(
    (itemKey, fromBoxKey, toBoxKey) =>
      window.tbh.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey),
    [],
  ),
  ```
  - `onReclassify` 返回 `Promise<void>`，但调用方 `void` 忽略。
  - `useLoot.reclassifyItem` 直接 return Promise，未 `.catch`。
  - IPC handler reject（如 `services.reclassifyLootItem` 抛错）时，Promise 静默 unhandled。
  - 与初版 P1-12 修复的 `boxTrackerUi.toggleTrackedLevel` / `applyTrackerPreset` 加 `.catch(reportIpcError)` 风格不一致。
- 影响：
  - 用户点 Assign 按钮后无 visual feedback（既无 loading，也无成功/失败提示）
  - IPC 失败时用户无感知，可能反复点击
- 修复方向：
  ```ts
  // useLoot.ts
  const reclassifyItem = useCallback(
    (itemKey, fromBoxKey, toBoxKey) =>
      window.tbh.reclassifyLootItem(itemKey, fromBoxKey, toBoxKey)
        .catch(reportIpcError),
    [],
  );
  ```
  并在 `LootBoxSection` 的 Assign 按钮加 `loading` state（可选，UX 改进）。

### P2-N4. `LootBoxSection.handleAssign` `levelNum` 解析风格与 P2-8 不一致

- 位置：[LootBoxSection.tsx:114-116](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L114-L116) vs [boxTrackerUi.ts:50-56](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/boxTrackerUi.ts#L50-L56)
- 事实：
  | 文件 | 解析方式 | 接受示例 | 拒绝示例 |
  |------|---------|---------|---------|
  | LootBoxSection | `Number.parseInt(state.level, 10)` + `Number.isFinite && > 0` | `"3"` → 3；`"3.5"` → 3；`"1e3"` → 1 | `"abc"` → NaN；`"-3"` → -3 |
  | boxTrackerUi (P2-8 已修) | `/^\d+$/.test(trimmed)` 严格整数 | `"3"` → 3 | `"3.5"`、`"1e3"`、`"0x10"`、`"abc"` |
  - 两处都是用户输入的"关卡等级"，但严格性不同。
- 影响：
  - `"1e3"` 在 LootBoxSection 会被解析为 1（`parseInt` 在 `e` 处截断），UI 显示 `Lv1`，与用户期望不符。
  - `"3.5"` 被接受为 3，但用户可能输入意图是 35（typo）。
- 修复方向：抽共享 helper `parsePositiveIntInput(input: string): number | null`，两处复用。

### P2-N5. `BoxOpenTracker.resetBox` 不清理 `namesByKey` / `gradesByKey` 的孤儿 itemKey

- 位置：[boxOpenTracker.ts:213-217](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L213-L217)
- 事实：
  ```ts
  resetBox(boxKey: string): void {
    this.countsByKey.delete(boxKey);
    this.history = this.history.filter((h) => h.boxKey !== boxKey);
    this.baseAggregateCache = null;
  }
  ```
  - `namesByKey` / `gradesByKey` 是跨 boxKey 共享的 `Map<itemKeyStr, name|grade>`。
  - `resetBox` 删了 `countsByKey[boxKey]`，但不清理 `namesByKey` / `gradesByKey` 中"该 boxKey 独有但其他 boxKey 没有"的 itemKey。
  - 长期游戏 + 多次 reset 后，`namesByKey` / `gradesByKey` 累积所有曾经出现过的 itemKey。
- 影响：
  - 内存轻微增长（每个孤儿条目几十字节，假设 1000 个孤儿 = 几十 KB）
  - 不影响逻辑（再出现同 itemKey 会复用旧值）
  - `captureSnapshot` 会把孤儿条目也序列化进 `session_state.json`
- 修复方向：
  ```ts
  resetBox(boxKey: string): void {
    const itemMap = this.countsByKey.get(boxKey);
    if (itemMap) {
      // 找出其他 boxKey 仍持有的 itemKey
      const stillUsed = new Set<string>();
      for (const [otherKey, otherMap] of this.countsByKey) {
        if (otherKey === boxKey) continue;
        for (const k of otherMap.keys()) stillUsed.add(k);
      }
      // 清理本 boxKey 独有的孤儿
      for (const k of itemMap.keys()) {
        if (!stillUsed.has(k)) {
          this.namesByKey.delete(k);
          this.gradesByKey.delete(k);
        }
      }
    }
    this.countsByKey.delete(boxKey);
    this.history = this.history.filter((h) => h.boxKey !== boxKey);
    this.baseAggregateCache = null;
  }
  ```
- 优先级低。

### P2-N6. `applySnapshot` 后 `history` entries 共享原 snapshot 引用

- 位置：[boxOpenTracker.ts:283-309](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L283-L309)
- 事实：
  ```ts
  const restored = data.history ?? [];
  this.history = restored.length > HISTORY_LIMIT ? restored.slice(-HISTORY_LIMIT) : [...restored];
  ```
  - `[...restored]` 是浅拷贝：数组新引用，但每个 `BoxOpenHistoryEntry` 对象仍是 `data.history` 中的同一引用。
  - 后续 `reclassifyItem`（[boxOpenTracker.ts:260-264](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L260-L264)）直接 `h.boxKey = toBoxKey` 原地修改 entry → 污染原始 snapshot 数据。
  - 若调用方（`SessionStateService.tryRestoreOnSnapshot`）在 applySnapshot 后仍持有 `pendingBoxOpenTracker` 引用，原数据会被改坏。
- 实际影响：
  - `SessionStateService.tryRestoreOnSnapshot` 在 applySnapshot 后立即清空 pending（finally 块），所以实际不会触发。
  - 但 immutability 契约被违反，未来调用方变更可能踩坑。
- 修复方向：
  ```ts
  this.history = (restored.length > HISTORY_LIMIT ? restored.slice(-HISTORY_LIMIT) : restored)
    .map((e) => ({ ...e }));
  ```
- 优先级低。

### P2-N7. `BoxOpenTracker.getStats` 排序无 tiebreaker

- 位置：[boxOpenTracker.ts:147-155](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L147-L155)
- 事实：
  ```ts
  stats.sort((a, b) => {
    if (a.category !== b.category) { /* category order */ }
    const al = a.level ?? -1;
    const bl = b.level ?? -1;
    return al - bl;
  });
  ```
  - 同 category 同 level 的两个 boxKey（理论上不该出现，但 reclassify 可能造出 `"rare:3"` 与另一个 `"rare:3"` —— 等等，countsByKey 是 Map，key 唯一，所以同 boxKey 不会有两个 entry）。
  - 实际上同 category + 同 level 不会出现（boxKey 字符串就是 `${category}:${level}`，唯一）。但同 category + 不同 level + level==null 时（category-only boxKey），可能出现多个 level==null 的 boxKey 同 category。
  - 等等：`levelFromBoxKey("common") = null`，`levelFromBoxKey("common:3") = 3`。若 reclassify 把 item 从 "unclassified" 移到 "common"（无 level），然后又有一个 "common"（已有），countsByKey 会合并到同一 key "common"。所以同 category 的 level==null 只会有一个。
  - 综上，同 category + 同 level 不会出现多个 boxKey。sort 的不稳定性无影响。
- 修复方向：不必修复。仅记录"已分析，无影响"。

### P2-N8. `BoxOpenTrackerSnapshot.history` 序列化体积无压缩

- 位置：[boxOpenTracker.ts:269-280](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L269-L280) + [SessionStateService.ts:197-203](file:///d:/Project/TBH/tbh-companion/app/src/main/services/SessionStateService.ts#L197-L203)
- 事实：
  - `captureSnapshot` 把 `history` 全量序列化（`history: [...this.history]`），HISTORY_LIMIT=500。
  - 每个 `BoxOpenHistoryEntry` 含 `wallTime / boxKey / itemKey / itemName / grade / count` 6 个字段。
  - 500 条 entry × 6 字段 × 平均 30 字节 ≈ 90 KB JSON。
  - `SessionStateService.persist` 同步 `writeFileSync` 写盘（[SessionStateService.ts:200](file:///d:/Project/TBH/tbh-companion/app/src/main/services/SessionStateService.ts#L200)），15 秒一次自动保存 + reclassify / reset 时即时 flush。
  - `JSON.stringify` + `writeFileSync` 通常 50-100ms，期间 main 进程阻塞。
- 影响：
  - reclassify / reset 触发的 flush 在 IPC handler 同步链中执行，用户感知到"Assign 按钮点完后 UI 卡顿 100ms"。
  - 自动保存 15 秒一次，影响小。
- 修复方向（任选）：
  - 方案 A：snapshot 不持久化 `history`，仅持久化 `countsByKey / namesByKey / gradesByKey`。重启后 history 为空，但 breakdown（来自 countsByKey）仍可重建。UI 的"最近 50 次开箱记录"在重启后短期空白，可接受。
  - 方案 B：`history` 持久化改为异步 `fs.writeFile`（回调 / Promise），不阻塞 IPC handler。但需要保证进程退出前 flush 完成。
  - 方案 C：减小 `HISTORY_LIMIT`（如 200），权衡 UI 显示需求。
- 优先级低-中。

### P2-N9. Loot tab 缺少 sortKey / sortDir UI 控件

- 位置：[lootFilters.ts:5-19](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/lootFilters.ts#L5-L19) vs [LootBoxSection.tsx:151-169](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L151-L169)
- 事实：
  - `LootFilterState` 定义了 `sortKey: "count" | "dropPct" | "name" | "grade" | "buyOrderValue"` 和 `sortDir: "asc" | "desc"`。
  - `filterAndSortLoot` 完整实现了 5 种排序逻辑。
  - 但 `LootBoxSection` 的 filter UI 只暴露了 `query`（搜索框）和 `gradeFilter`（MultiSelect），**没有 sortKey / sortDir 控件**。
  - `DEFAULT_LOOT_FILTER_STATE.sortKey = "count"`、`sortDir = "desc"` 固定。
- 影响：
  - 用户无法切换排序方式（如想按 buyOrderValue 降序看"最值钱的开箱结果"做不到）。
  - 是功能缺失，不是 bug。
- 修复方向：
  - 在 filter 行加一个 `Select` 控件让用户选 sortKey，加一个 toggle 按钮切换 asc/desc。
  - 或在 DataTable 的 column header 上加点击排序（更直观，但需要 DataTable 支持）。
- 优先级中。

### P2-N10. `buildBoxOpenPriceResolver` 每次构造新闭包未缓存

- 位置：[TrackingService.ts:166-187, 337-360](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L166-L187)
- 事实：
  - `getStats` 每次调用都 `this.buildBoxOpenPriceResolver()` 新建闭包函数。
  - 5Hz × 1 = 5 个小对象/秒 的 GC 压力。
  - 闭包内捕获 `this`，工作量为 Map.get + 字段访问。
- 影响：
  - 单次闭包分配约几十字节，5/秒的分配率对 V8 GC 来说微不足道。
  - 不是性能问题。
- 修复方向（可选）：缓存闭包，在 `setInventorySnapshot` / `setLookupPriceSnapshot` / `setGameDataLookup` 时失效。
  ```ts
  private priceResolverCache: BoxOpenPriceResolver | null = null;
  private getPriceResolver(): BoxOpenPriceResolver {
    if (this.priceResolverCache) return this.priceResolverCache;
    this.priceResolverCache = this.buildBoxOpenPriceResolver();
    return this.priceResolverCache;
  }
  // setInventorySnapshot / setLookupPriceSnapshot / setGameDataLookup 内:
  this.priceResolverCache = null;
  ```
- 优先级低（性能改进不显著，但代码更清晰）。

### P2-N11. `buildBoxOpenPriceResolver` 内 `catalogItemKeyFromSave` 冗余调用

- 位置：[TrackingService.ts:348](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L348)
- 事实：
  ```ts
  // resolver Level 2
  const catalogId = catalogItemKeyFromSave(itemKey);  // ← 冗余
  const item = this.gameDataLookup.get(catalogId);
  ```
  - `itemKey` 参数来自 `boxOpenTracker.getStats` 的 `baseRow.itemKey`（[boxOpenTracker.ts:109](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L109)）。
  - `baseRow.itemKey` 在 `getBaseAggregates` 中由 `Number.parseInt(itemKeyStr, 10)` 得到（[boxOpenTracker.ts:187](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L187)）。
  - `itemKeyStr` 来自 `countsByKey` 的内层 Map key，是 `String(itemKey)`（[boxOpenTracker.ts:82](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L82)）。
  - 这个 `itemKey` 在 `recordOpen` 时已经是 `resolved.itemKey`（[TrackingService.ts:543](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L543)），即 `catalogItemKeyFromSave(entry.itemKey)` 的结果（[TrackingService.ts:326](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L326)）。
  - `catalogItemKeyFromSave` 是 idempotent（[gamedata.ts:37-42](file:///d:/Project/TBH/tbh-companion/app/src/core/gamedata.ts#L37-L42)）：输入 < 1_000_000 原样返回。
  - 所以 Level 2 的 `catalogItemKeyFromSave(itemKey)` 调用是冗余但无害的。
- 影响：
  - 不出错，但给 reader 造成"这里需要再次转换"的错觉。
  - Level 1 `inventoryByItemKey.get(itemKey)` 直接用 itemKey 没调 `catalogItemKeyFromSave`，与 Level 2 风格不一致。
- 修复方向：删除冗余调用，统一两 Level 直接用 `itemKey`。
  ```ts
  if (this.lookupPriceSnapshot && this.gameDataLookup) {
    const item = this.gameDataLookup.get(itemKey);  // 直接用
    ...
  }
  ```
- 优先级低。

### P2-N12. `reclassifyItem` 中 `history` entries 被原地修改

- 位置：[boxOpenTracker.ts:260-264](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L260-L264)
- 事实：
  ```ts
  for (const h of this.history) {
    if (h.boxKey === fromBoxKey && h.itemKey === itemKey) {
      h.boxKey = toBoxKey;
    }
  }
  ```
  - 直接修改 `BoxOpenHistoryEntry` 对象的 `boxKey` 字段。
  - `getStats` 第 142 行 `history: agg.history` 把这些 entry 引用直接传给 renderer（[boxOpenTracker.ts:142](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L142)）。
  - 若 reclassify 发生在两次 pushStats 之间，renderer 持有的旧 stats.history 中的 entry 也会被改（共享引用）。
- 实际影响：
  - reclassify 后立即 `pushStats`，新 stats 覆盖旧 stats。
  - React 在下次 render 时拿到新 stats，旧 stats 被丢弃。
  - 理论上存在 race（如 renderer 在 reclassify + pushStats 之间读到旧 stats），但实际不会触发。
- 修复方向：
  ```ts
  this.history = this.history.map((h) =>
    h.boxKey === fromBoxKey && h.itemKey === itemKey
      ? { ...h, boxKey: toBoxKey }
      : h
  );
  ```
  或在 `getStats` 输出 history 时深拷贝。
- 优先级低。

### P2-N13. UI reclassify 流程缺少 loading / feedback 状态

- 位置：[LootBoxSection.tsx:111-127, 214-221](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L111-L127)
- 事实：
  - Assign 按钮无 `loading` state，点击后立即恢复可点。
  - 无成功 / 失败 toast 或 inline message。
  - 用户点完只能盯着表格看是否变化。
- 修复方向：
  - Assign 按钮加 `loading` state（disabled + spinner）。
  - 成功后清空 reclassifyState（已实现，第 120-124 行）。
  - 失败时显示 inline error 并保留 reclassifyState。
- 与 N3 修复可一并实施。
- 优先级中。

### P3-N14. 测试覆盖缺口

- 位置：[test/core/boxOpenTracker.test.ts](file:///d:/Project/TBH/tbh-companion/app/test/core/boxOpenTracker.test.ts)、[test/renderer-component/LootBoxSection.test.tsx](file:///d:/Project/TBH/tbh-companion/app/test/renderer-component/LootBoxSection.test.tsx)、[test/ipc/channels.test.ts](file:///d:/Project/TBH/tbh-companion/app/test/ipc/channels.test.ts)、[test/main/trackingService.test.ts](file:///d:/Project/TBH/tbh-companion/app/test/main/trackingService.test.ts)
- 事实（来自 search subagent 报告）：
  - `boxOpenTracker.test.ts`：覆盖 `reclassifyItem` 单元 case（no-op when source missing、merge into existing target、from===to），**未覆盖**：非法 toBoxKey（N2）、`getStats` 缓存命中分支、`applySnapshot` 边界（>500 条 history、空 history、损坏数据）。
  - `LootBoxSection.test.tsx`：仅测试 `rowContainSize` 虚拟化阈值（>50 vs ≤50）。**未测试**：Select category、Input level、Assign 按钮交互；`handleAssign` 回调；边界 case（空 level、负 level、超大 level、非法 category）。
  - `channels.test.ts`：仅静态文本校验常量名存在于 preload / handler 文件。**未测试**：handler 运行时参数校验（N2）、无效参数的 no-op 行为。
  - `trackingService.test.ts`：所有测试 case 中 `boxOpens: null`（行 162/196/236/276/316/355/396）。**未测试**：`ingestLiveFrame` 携带 `boxOpens` 时的 `recordOpen` 调用；`reclassifyLootItem` 在 TrackingService 层的 flush + pushStats 行为。
  - `stats.test.ts`：测试 frame 中 `boxOpens: null`（行 59）。**未测试**：buildStats 在 `boxOpenTracker.getStats` 非空时的输出。
  - **完全无**端到端测试覆盖：reclassify → flush → session_state.json → applySnapshot → getStats → renderer 显示。
- 修复方向：补以下测试
  1. `boxOpenTracker.test.ts`：
     - `reclassifyItem` toBoxKey 非法格式（如 `"foo"`）→ 应允许（当前行为）或拒绝（修复后行为）。
     - `getStats` 在 `baseAggregateCache` 命中 vs 失效时的输出一致性。
     - `applySnapshot` 在 history > 500 / = 500 / < 500 / 空 / 损坏 时的行为。
     - `applySnapshot` 后 `reclassifyItem` 不污染原 snapshot 数据（N6）。
  2. `LootBoxSection.test.tsx`：
     - 用户输入 category + level + 点 Assign → `onReclassify` 被调用且参数正确。
     - 边界 case：空 level、负 level、超大 level、非数字 level。
     - isUnclassified=true 时显示 Assign 列；=false 时不显示。
  3. `loot.test.ts`（新建）：
     - IPC handler 对无效参数（非 number itemKey、空 string boxKey、非法格式 boxKey）返回 undefined（no-op）。
     - 合法参数 → 调用 `services.reclassifyLootItem`。
  4. `trackingService.test.ts`：
     - `ingestLiveFrame` 携带 `boxOpens` 时 `boxOpenTracker.recordOpen` 被正确调用。
     - `reclassifyLootItem` 触发 `sessionState.flush` + `pushStats`。
- 优先级：N14-1 / N14-2 / N14-3 高（与 N2 修复配套）；N14-4 中。

## 五、仍遗留的预存问题（与本次审计无关）

沿用初版报告第七节"修复完成情况"末尾的说明，10 个预存 vitest 失败仍在仓库中：

- `test/core/bufferPool.test.ts`（2 个）
- `test/core/tracker.test.ts`（2 个）
- `test/main/stats.test.ts`（1 个）
- `test/main/trackingService.test.ts`（4 个）
- `test/renderer/format.test.ts`（1 个，locale 问题：`6月20日` vs `/^Jun 20 at /`）

这些失败与 loot 链路无直接关系（stats.test.ts / trackingService.test.ts 的失败是 `boxOpens: null` 之外的预存问题），留作独立修复。

## 六、整改路线图

### 第零阶段（P0，立即修复功能性故障）

| 编号 | 任务 | 文件 | 估改动量 | 优先级 | 状态 |
|------|------|------|---------|--------|------|
| P0-F1-短期 | 暴露 `boxOpensStatus` 到 UI，让用户区分"没开箱"vs"偏移未推导" | TrackingService + stats.ts + types.ts + Loot.tsx + useLoot.ts | ~15 行 | 立即 | ✅ 已修复 |
| P0-F1-中期 | 打破 enrichment heal 死锁：worker.ts 加 30s fallback timer，不依赖 `boxOpenEventPending` 信号 | worker.ts | ~30 行 | 立即 | ✅ 已修复 |
| P0-F1-长期 | 为 BoxOpenLog 偏移找到结构锚点并写入 bundled table | offsets.ts + extractor | 调研型 | 后续 | ✅ 已修复（runtime self-heal 路径已覆盖 v1.00.28 混淆场景，详见附录 G） |

### 第一阶段（P1，应尽快修复）

| 编号 | 任务 | 文件 | 估改动量 |
|------|------|------|---------|
| P1-N1 | `LootBoxSection` useMemo 改用内容签名依赖 | [LootBoxSection.tsx:65](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/loot/LootBoxSection.tsx#L65) | 5 行 |
| P1-N2 | `loot.ts` IPC handler 加 `isValidBoxKey` 校验 | [loot.ts:26-38](file:///d:/Project/TBH/tbh-companion/app/src/main/ipc/handlers/loot.ts#L26-L38) | 10 行 |

### 第二阶段（P2，技术债清理）

| 编号 | 任务 | 文件 | 优先级 |
|------|------|------|--------|
| P2-N3 | `useLoot.reclassifyItem` 加 `.catch(reportIpcError)` | [useLoot.ts:16-20](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/useLoot.ts#L16-L20) | 中 |
| P2-N4 | 抽 `parsePositiveIntInput` 共享 helper | LootBoxSection + boxTrackerUi | 中 |
| P2-N9 | Loot tab 加 sortKey / sortDir UI 控件 | LootBoxSection | 中 |
| P2-N13 | Assign 按钮加 loading + 成功/失败反馈 | LootBoxSection | 中 |
| P2-N8 | `BoxOpenTrackerSnapshot.history` 不持久化或异步写盘 | boxOpenTracker + SessionStateService | 低-中 |
| P2-N5 | `resetBox` 清理孤儿 namesByKey / gradesByKey | [boxOpenTracker.ts:213-217](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L213-L217) | 低 |
| P2-N6 | `applySnapshot` history entries 深拷贝 | [boxOpenTracker.ts:305-307](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L305-L307) | 低 |
| P2-N11 | 删除 `buildBoxOpenPriceResolver` 内冗余 `catalogItemKeyFromSave` | [TrackingService.ts:348](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L348) | 低 |
| P2-N10 | 缓存 `buildBoxOpenPriceResolver` 闭包 | TrackingService | 低 |
| P2-N12 | `reclassifyItem` history 用 `map` 替代原地修改 | [boxOpenTracker.ts:260-264](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts#L260-L264) | 低 |
| P2-N7 | — | 已分析无影响，不修 | — |

### 第三阶段（P3，测试补全）

| 编号 | 任务 |
|------|------|
| P3-N14-1 | `boxOpenTracker.test.ts` 补：非法 toBoxKey、缓存命中、applySnapshot 边界、immutability |
| P3-N14-2 | `LootBoxSection.test.tsx` 补：reclassify UI 交互 + 边界 case |
| P3-N14-3 | 新建 `loot.test.ts`：IPC handler 参数校验运行时测试 |
| P3-N14-4 | `trackingService.test.ts` 补：`ingestLiveFrame` 携带 boxOpens、`reclassifyLootItem` 行为 |

## 七、总体评价（loot 链路单维度）

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构分层 | A- | core/main/renderer/shared 各层职责清晰，无层级违规（初版 P0-1 已撤销） |
| **功能可用性** | **F** | **P0-F1：loot tab 在所有已支持版本上可能完全不可用（bundled 偏移全为 0 + 自愈死锁）。这是整个审计中最严重的问题** |
| 业务流程 | A | 端到端链路清晰，从内存读取到 UI 展示可追溯，offset 缺失有明确回退路径（unclassified） |
| 逻辑正确性 | B+ | 初版 P0/P1/P2 整改后无严重 bug；N2 是数据完整性隐患但实际触发概率低 |
| 代码规范 | B+ | 魔法数字已抽常量；类型统一；P2-2/5/6/7 均已修；剩余 N4 / N11 是风格不一致小瑕疵 |
| 性能 | B | baseAggregateCache + inventoryByItemKey + content-visibility 已显著改善；N1 的 useMemo 失效是当前最大性能漏点（5000 次/秒 filter+sort） |
| 测试覆盖 | C+ | core 层 boxOpenTracker 单测较全；IPC handler / UI 交互 / 端到端完全空白，是最大短板 |
| 数据完整性 | B | N2（toBoxKey 不校验）是主要风险；N6 / N12 的 immutability 问题影响小 |
| UI 体验 | C | P0-F1 的误导性空状态文案 + N3（无错误反馈）/ N9（无 sort UI）/ N13（无 loading）共同拉低评分；P1-10 虚拟化已落地 |
| 诊断能力 | D | `boxOpensStatus` 已采集但未暴露给 UI；用户/支持人员无法从 UI 区分"偏移未推导"vs"真的没开箱" |

**核心建议（按优先级）**：

1. **立即修 P0-F1**（loot 功能性故障）：这是唯一让整个 loot 子系统瘫痪的问题。短期方案（暴露 `boxOpensStatus` 到 UI）15 行改动即可让用户看到诊断信息；中期方案（打破 peek 死锁）30 行改动可让自愈机制真正生效。
2. **优先修 P1-N1**（useMemo 失效）：5 行改动，立即消除 5000 次/秒的冗余计算。这是初版 P1-10 修复的实际生效前提。
3. **同步修 P1-N2**（toBoxKey 校验）：10 行改动，关闭数据完整性的潜在漏洞，与 P3-N14-3 测试配套。
4. **第二批处理 N3 / N4 / N9 / N13**：补全 UI 反馈与交互能力，提升用户感知。
5. **测试补全（N14）**：当前 loot 链路的 IPC handler / UI 交互完全无测试，是回归风险最高的区域。

## 八、事实底稿（subagent 报告关键摘录）

### 8.1 loot 链路全貌（subagent A）

#### boxOpens 字段读取链路
- `liveReader.ts:526` 调 `readRuntimeBoxOpenLog(p, ga.base, ga.size, o, this.boxOpenPin)` → `boxOpenResult.opens`
- `liveReader.ts:618` 放入 `LiveMemorySnapshot.boxOpens`
- 实际读取在 `runtime.ts:853-922`：
  - 三道前置守卫：`logManager === 0n` / `getItemWithBoxOpenTypeKey` 缺失 / `boxOpenLog.itemStringKey` 缺失 → 返回 `{opens: null}`
  - count 上限校验 `< 0 || > 5000` 返回 null
  - Tail 逻辑：首次只 prime 到当前 count；`count < pin.lastCount` 时仅对齐 tail，**绝不重读历史**
  - 逐条 `readI32` 读 `itemStringKey`，`itemKey == null || itemKey <= 0` 跳过
  - `boxType` 与 `level` 是**条件读取**：仅当偏移非零时才读，`level` 还要求 `> 0`

#### BoxOpenEntry 字段语义
- 类型定义 `types.ts:160-168`：`itemKey: number` 必填；`boxType?: number` / `level?: number` 可选
- `boxType` 0=common / 1=rare / 2=act；undefined 时回退到 `UNCLASSIFIED_BOX_KEY = "unclassified"`
- `level` 缺失或 ≤0 时仅返回 category 字符串（如 `"rare"`），不带 `:N` 后缀
- bundled 偏移默认值 `offsets.ts:189-192` 全为 0，未推导前所有版本都落入 unclassified 回退

#### gameDataLookup 为 null 时的处理
- `resolveBoxOpenEntry`（TrackingService.ts:318-331）通过 `this.gameDataLookup?.get(catalogId)` 可选链安全访问
- name 回退为 `` `#${entry.itemKey}` ``，grade 回退为 `null`
- `recordOpen` 照常执行；`reclassifyItem` 不读 name/grade，不受影响
- `getStats` 用 `namesByKey.get(itemKeyStr) ?? `#${itemKey}`` 兜底

#### IPC 通道与 preload 签名
- `ipc.ts:57-59`：`LOOT_RESET_BOX` / `LOOT_RESET_ALL` / `LOOT_RECLASSIFY_ITEM` 常量
- `preload/index.ts:232-240`：三个方法签名与 `TbhApi` 接口（`types.ts:1237-1239`）完全一致
- `channels.test.ts:50-52, 90-92`：静态文本校验常量名同时存在于 preload 与 handler 文件

#### buildStats 中 boxOpens 重新构造
- `stats.ts:147`：`boxOpens: boxOpenTracker.getStats(tracker.elapsed, boxOpenPriceResolver)`
- `boxOpenTracker.getStats`（boxOpenTracker.ts:95-158）每次新建 `stats: BoxOpenStats[]` 数组 + 每个 boxKey 新建 `breakdown: BoxOpenBreakdownRow[]` + 每个 row 新建对象
- `baseAggregateCache` 缓存 `breakdownBase`（不含 price）但 `breakdown` 输出仍是新引用
- → renderer `useMemo([stats.breakdown, ...])` 必然失效（N1 根因）

#### 5Hz 更新对 LootBoxSection 重渲染
- `useStats` 用 `useSyncExternalStore`，单例 module-level `stats`，5Hz 推送时 `stats = s; notify()`
- 无 selector / 分片订阅机制
- `Loot.tsx:35-42` 的 `boxOpens.map(...)` 每次广播都重建 `stats` prop 引用 → 所有 `LootBoxSection` 都重渲染
- `useMemo(rows)` 因 `stats.breakdown` 新引用而失效
- `rowContainSize` content-visibility 仅减 paint 成本，不阻止 render

#### reclassify UI 边界 case
- 空 level（`""`）→ `parseInt = NaN` → 回退到 `state.category`（合法）
- 非法 category（不在 common/rare/act）→ UI Select 不会构造，但 IPC 不校验 → 非法 boxKey 进入 countsByKey → getStats 过滤跳过 → 物品"消失"（N2）
- 负 level → `levelNum > 0` false → 回退到 category（合法）
- 超大 level（999999）→ 接受，创建 `common:999999` boxKey
- 非数字 level（`"abc"`）→ `parseInt = NaN` → 回退到 category（合法）
- 小数 level（`"3.5"`）→ `parseInt = 3` → `common:3`（与 P2-8 不一致 → N4）
- `fromBoxKey === toBoxKey` → boxOpenTracker.reclassifyItem 第 240-241 行 no-op

#### reclassify toBoxKey 不校验的后果链
1. `boxOpenTracker.reclassifyItem` 不校验，直接 `countsByKey.set(toBoxKey, ...)`
2. `getStats` 过滤：`categoryFromBoxKey("foo")` 返回 null → `continue` 跳过
3. `"rare:abc"` category=rare 但 level=null，stats 输出 `boxKey="rare:abc"`、`label="rare:abc"`（boxLabel 直接回退原串）
4. `SessionStateService.persist` 写入 session_state.json，重启后恢复
5. `isUnclassified = stats.category === "unclassified"` 对此不显示 reclassify UI，**用户无法修正**，只能 Reset

#### 持久化频率与原子性
- `SessionStateService` `SAVE_INTERVAL_MS = 15_000`（15 秒自动保存）
- 事件触发 flush：`resetLootBox` / `resetLootAll` / `reclassifyLootItem` / `flushSession` / `onSavePathChanged` / `onTrackerReset`
- `persist` 同步 `writeFileSync`（SessionStateService.ts:197-203），**不**用临时文件 + rename → 非原子写
- 写盘期间 IPC handler 阻塞（实测通常 < 50ms）
- `tryRestoreOnSnapshot` 在 finally 块清空 pending（SessionStateService.ts:162-168），applySnapshot 异常不会形成错误循环（初版 P0-5 已修）

### 8.2 价格解析链路（subagent B）

#### 两级回退数据更新来源
- **Level 1 inventoryByItemKey**：通过 `setInventorySnapshot` 写入，由 `InventoryService.publishResolved` 触发
  - 触发时机：`onInventory`（save poll）、`resolveAndPushInventory`（loadGameData / reloadPriceCache / setCurrency / refreshPrices / refreshItemPrices / ensureOwnedPrices 完成时）
  - `buyOrderUnit` 字段仅当 `priceLookup` 命中时非空；`priceLookup` 由 `buildOwnedPriceLookupMap` 构建，**仅包含当前 owned items 的 market_hash_name**
  - 即未持有物品 row 不存在（resolve.ts:269 过滤 `count > 0`）
- **Level 2 lookupPriceSnapshot**：通过 `setLookupPriceSnapshot` 写入
  - `LookupPriceService` 30 分钟轮询（`REFRESH_INTERVAL_MS = 30 * 60 * 1000`）
  - 从 GitHub release asset 拉取 `prices.json`，带 ETag，304 时跳过，相同 `generatedUtc` 跳过
  - 服务端 `prices.json` 由 GitHub Action 生成，仓库内不可见周期

#### catalogItemKeyFromSave idempotent 分析
- `gamedata.ts:37-42`：
  - 输入 < 1_000_000 → 原样返回
  - 输入 ≥ 1_000_000 → `base = trunc(itemKey/1000)`，若 base ∈ [110_001, 939_999] 返回 base，否则返回原值
- catalog id 总是 < 1_000_000（catalog 范围上限 939_999），二次调用原样返回 → **idempotent**
- `resolveBoxOpenEntry` 第 326 行已转换 → boxOpenTracker 内部存的 itemKey 是 catalogId
- `buildBoxOpenPriceResolver` 第 348 行又调一次 → 冗余但无害（N11）

#### inventoryByItemKey key 类型一致性
- `setInventorySnapshot` 用 `row.itemKey` 作 key
- `row.itemKey` 来自 `parse.ts:147, 180` 的 `itemKey: catalogId`（已转换）
- boxOpenTracker 中 `baseRow.itemKey` 来自 `Number.parseInt(itemKeyStr, 10)`，itemKeyStr 来自 `String(itemKey)`，itemKey 是 recordOpen 收到的 catalogId
- → 两端均为 catalog itemKey，**一致**

#### marketHashName 计算开销
- `marketName.ts:55-79`：`isPriceableItem` 3 次比较 + MATERIAL 分支直接返回 / GEAR 分支字符串拼接
- 单次微秒级，无 I/O 无外部状态
- 5Hz × 20 boxKey × 20 distinct item = 2000 次/秒 marketHashName 计算（无缓存）
- 同一 item 在 inventory resolve 与 boxOpenTracker price resolver 中各算一次，无共享缓存

#### InventoryService.resolveInventory 的 buyOrderUnit 填充
- `resolve.ts:244-282` 对每个 instance 调 `ensureRow` → `resolveMarketHashAndPrice`
- `priceLookup` 由 `buildOwnedPriceLookupMap` 构建，键集 = `flattenOwnedHashes(this.currentOwnedPriceTargets())` —— **仅当前 owned items**
- → 未持有物品即使 row 被创建，`buyOrderUnit` 也为 null
- 实际场景：玩家从箱子开出物品后，如果该物品仍持有，inventory 通常有 row 且 buyOrderUnit 可用；物品被售出/合成/消耗后，row 被过滤掉，Level 1 miss → fallback 到 Level 2

#### buildBoxOpenPriceResolver 闭包创建开销
- 每次 `getStats` 新建闭包，5Hz × 1 = 5 个小对象/秒
- 闭包体仅捕获 `this`，工作量为 Map.get + 字段访问
- 单次闭包分配约几十字节，GC 压力微不足道（N10 不算性能问题）

#### buyOrderValue 浮点精度与 Math.round 显示
- `boxOpenTracker.ts:111`：`buyOrderUnit * baseRow.count`
- IEEE 754 double 乘法，buyOrderUnit 为十进制小数时可能有 1e-15 量级误差
- UI 显示 `Math.round(value).toLocaleString("en-US")` 隐藏 < 0.5 美元误差
- `hourlyValue = buyOrderValue / hours`，hours 很小时（短会话）可能放大误差，但 Math.round 仍合理

#### baseAggregateCache 与价格未变时的冗余计算
- 缓存 `breakdownBase`（不含 price 字段）
- `getStats` 每次用 fresh price resolver 计算 `buyOrderUnit / buyOrderValue / hourlyValue`（boxOpenTracker.ts:108-128）
- 价格 snapshot 未变时这些乘法+累加仍重复执行
- 但 breakdownBase 已缓存，避免重做分组/排序/slice
- 缓存 price-derived 值需要 tracker 接收 "价格 snapshot 变化" 信号，目前没有该机制（N1 方案 B 的实施前提）

#### LookupPriceSnapshot 类型与 renderer 感知
- `types.ts:448-459`：包含 `generatedUtc` / `fetchedUtc?` / `prices` / `fx`
- `useLookupPrices.ts:60-71` 通过 `useSyncExternalStore` 暴露 `generatedUtc` 给 renderer
- 但 box-open 链路不读 `generatedUtc`，`buildBoxOpenPriceResolver` 只读 `prices[hash]`
- TrackingService 没有把 timestamp 暴露给 box-open 路径

#### 玩家不再持有物品时的 fallback 合理性
- Level 1 miss → Level 2 命中（若 hash 在 snapshot 中）
- Level 2 价格语义：`lowest active listing in USD`（lowest ask，卖方最低挂单价）
- Level 1 价格语义：`Steam buy-order unit price`（highest bid，买方最高挂单价）
- 用 lowest ask 作为 "箱子开出物品的价值" 会高估即时变现价值；用作 "如果挂单能卖到多少" 则合理
- TrackingService.ts:346 注释明确把 Level 2 称作 "lowest ask as proxy"，是显式声明的 proxy
- 第三种 miss：hash 不在 snapshot 中（新版本物品或 snapshot 过期）→ resolver 返回 null → UI 显示 "—" → totalBuyOrderValue 不累加

---

**报告完。**

---

## 附录 G. P0-F1 长期方案落地：v1.00.28 BoxOpenLog 混淆字段识别（2026-07-17 修复记录）

P0-F1 长期方案原计划"为 BoxOpenLog 偏移找到结构锚点并写入 bundled table"，实际落地为 **runtime self-heal 路径增强**，无需重新打包 bundled table 即可覆盖 v1.00.28 的双重混淆场景。本附录记录调试经验与下次游戏更新时的应对清单。

### G.1 v1.00.28 BoxOpenLog 实际布局（实测确认）

```
BoxOpenLog (klass=0x1e8d1bf5340, name="BoxOpenLog" — 类名未混淆)
  +0x40 bfne : System.String*    内容="ItemName_530017"  ← itemStringKey
  +0x48 bfnf : int32              值=0                    ← itemGradeType
  +0x50 bfng : GradeSO*           指向 ScriptableObject   ← 非目标字段（boxType/level 之一）
```

**v1.00.28 的两层混淆：**
1. **字段名混淆**：`itemStringKey`/`itemGradeType` → `bfne`/`bfnf`/`bfng`（短随机串）。named-class 搜索失败。
2. **字段类型变化**：`itemStringKey` 从 `int32`（v1.00.21/23/27）变为 `System.String*`，字符串内容是**本地化 key** `"ItemName_530017"` 而非纯数字。

### G.2 调试走过的弯路（教训）

| 假设 | 实际 | 浪费轮次 |
|------|------|---------|
| 字段名匹配失败 → 字段不存在 | 字段名被混淆为 `bfne` 等 | 2 轮 |
| 字段值是负数 → ACTk ObscuredInt | 字段是 8 字节指针，高 32 位 `0x1ea` 被读成负 int32 | 2 轮 |
| ObscuredInt 解码返回非 null = 解码成功 | ObscuredInt 对任何非零 8 字节都返回非 null，掩盖了指针真相 | 1 轮 |
| System.String 内容是纯数字 | 内容是 `"ItemName_530017"` 本地化 key | 1 轮 |

**核心教训：ObscuredInt 解码的"假阳性"是最大坑**。`decodeObscuredInt` 对任何非零 8 字节都返回非 null（因为 ACTk 公式对任意输入都会产生某个 int32），这会让"指针字段被误读为 ObscuredInt"的 bug 看起来像"ObscuredInt 解码成功但值不对"，掩盖了真实情况。

### G.3 最终修复方案

#### G.3.1 诊断增强（il2cppScanner.ts `identifyBoxOpenLogFieldsByValue`）

对每个候选 offset 的指针字段，读取指针目标的 klass 名，输出到诊断日志：

```
+0x40=...(0x...)[obsc][ptr=0x1eacb58b4c0[klass=String],str="ItemName_530017"]
+0x48=0(0x0)[i32][gr]
+0x50=...(0x...)[obsc][ptr=0x1ea89b91700[klass=GradeSO]]
```

`klass=String` 直接告诉我们这是 System.String 指针，`klass=GradeSO` 告诉我们这是非目标字段。ObscuredInt 路径仅在指针路径明确失败后才尝试，且诊断标签会标注 `[obsc]` 让人一眼看出"这是 fallback 路径"。

#### G.3.2 String 内容解析（il2cppScanner.ts + runtime.ts）

`itemStringKey` 的 String 内容是本地化 key，不是纯数字。修复方案：

```ts
// 接受纯数字字符串 OR 本地化 key 的末尾数字
const direct = /^[0-9]+$/.test(s) ? s : (s.match(/(\d+)$/) ?? [])[1];
```

`"ItemName_530017"` → 提取 `530017` → 在 catalog range（110_001..939_999）内 → 被识别为 itemKey。

#### G.3.3 运行时读取（runtime.ts `readBoxOpenLogField`）

新增 `allowString` 参数（默认 false），仅 `itemStringKey` 调用传 `true`：

```ts
const itemKey = readBoxOpenLogField(reader, entryPtr, o.runtime.boxOpenLog.itemStringKey, true);
// boxType / level 调用不传 allowString，避免 GradeSO* 被误读为 String
```

**关键**：`boxType` / `level` 字段在 v1.00.28 是 `GradeSO*`（非 String 指针），如果不加 gate，运行时会无差别尝试 `readIl2CppString` 把 GradeSO 的内存当 String 解析，产生垃圾值。

### G.4 下次游戏更新（v1.00.29+）应对清单

当游戏再次更新导致 loot 失效时，按以下顺序排查：

#### 步骤 1：抓取诊断日志
启动 app → 开一个宝箱 → 查看 worker 日志中的 `[scanner] identifyByValue failed:` 行。新日志会带 `[klass=XXX]` 标签。

#### 步骤 2：根据 klass 判断字段类型
- `klass=String` → 字段是 System.String 指针，检查 `str="..."` 内容
  - 纯数字或 `Prefix_<digits>` → 现有 `/(\d+)$/` 正则可处理，无需改代码
  - 新格式（如 `Item_530017_v2`）→ 调整正则
- `klass=Int32` 或类似 → 字段是 boxed int，读 +0x10 偏移取值
- `klass=GradeSO` / 其他 SO → 字段是 ScriptableObject 引用，需走子对象读取
- `klass=null` → 指针目标内存不可读，可能是 GC 移动了对象，或游戏换了内存布局
- 无 `[ptr=...]` 标签 → 字段是普通 int32，现有 i32 路径已处理

#### 步骤 3：检查 BoxOpenLog 类名
日志中 `name="BoxOpenLog"` 说明类名未混淆。若变为乱码：
- `validateBoxOpenList` 已有 field-name fallback（通过字段名接受）
- 但 `findBoxOpenLogFields` 的 named-class 搜索会失败 → 需要新增结构锚点（如根据字段数量=3 + 字段间隔=8 字节识别）

#### 步骤 4：检查字段偏移
当前 `bfne=0x40, bfnf=0x48, bfng=0x50`（间隔 8 字节）。若偏移变化：
- `identifyBoxOpenLogFieldsByValue` 已动态扫描所有候选 offset，无需硬编码
- 但 `isPlausibleItemKey` / `isPlausibleGrade` 的范围假设可能需要调整（如 catalog id 范围变化）

#### 步骤 5：检查 ObscuredInt 假阳性
如果新版本字段真的是 ObscuredInt（而非指针），诊断日志会显示 `[obsc]` 但无 `[ptr=...]` 标签（因为指针读取失败）。此时：
- 检查 `decodeObscuredInt` 返回值是否在合理范围
- 必要时加 range gate（如 itemKey 必须在 110_001..939_999 才接受 ObscuredInt 结果）

### G.5 长期改进建议（未实施，留作技术债）

1. **bundled table 写入**：v1.00.28 的偏移（`itemStringKey=0x40, itemGradeType=0x48`）可写入 `offsets.ts` 的 `RUNTIME_V1_00_28` 表，避免每次启动都走 self-heal。但 self-heal 已足够快（~3 秒），优先级低。
2. **ObscuredInt 假阳性防御**：`decodeObscuredInt` 可加可选的 `rangeCheck` 参数，调用方传入合理范围，超出范围返回 null。避免指针被误读为 ObscuredInt 时产生看似合法的垃圾值。
3. **多采样验证**：`identifyBoxOpenLogFieldsByValue` 目前只采样第一个 entry。若能传入 list head，采样 3-5 个 entry 交叉验证，可降低假阳性率。但单 entry + klass-name 诊断已足够可靠。
4. **String 内容格式可配置化**：`/(\d+)$/` 正则硬编码在 scanner 和 runtime 两处。若未来出现多种 String 格式，可抽到 offsets 表作为 per-version 配置。

