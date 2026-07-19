# Tracker 与 BoxTimer 功能重复/冲突审计报告

- 审计日期：2026-07-17
- 审计范围：`app/src/core/{tracker,sessionState,stageRunTracker,chestDropTracker,boxOpenTracker,boxOpenLog,stageBoxTracker,boxTrackerSort,levelCurve,trackerLimits}.ts`、`app/src/core/liveMemory/dpsTracker.ts`、`app/src/main/services/{TrackingService,SessionStateService,StageRunService,BoxTimerService,ChestService}.ts`、`app/src/main/app/appState.ts`、`app/src/main/io/fileTail.ts`、`app/src/main/ipc/handlers/{chests,stats,stageRuns,loot}.ts`、`app/src/main/saveWatcher.ts`、`app/src/main/stats.ts`、`app/src/main/windows/boxTrackerWindow.ts`、`app/shared/{types.ts,ipc.ts}`、`app/src/preload/index.ts`、`app/src/renderer/{BoxTracker.tsx,lib/useBoxTimers.ts,lib/boxTrackerUi.ts,components/ChestsTrackerPanel.tsx,components/TrackerConfigRow.tsx,components/TrackerFarmStageSelect.tsx}`
- 审计方法：分层并行扫描（search agent × 2）+ 关键路径源码复核（BoxTimerService.ts、TrackingService.ts、appState.ts、SessionStateService.ts、stageBoxTracker.ts 已二次读取确认）
- 关联文档：[`chest-code-audit-2026-07-17.md`](./chest-code-audit-2026-07-17.md)（上次已修复 BoxTimer 自身 P0 问题，本次聚焦 tracker ↔ BoxTimer 之间的边界与冲突）

---

## 一、审计结论速览

| 维度 | 结论 |
|------|------|
| **功能重复** | **无重复**。Tracker 负责"统计"（XP/金币/掉落/开箱的速率与累计），BoxTimer 负责"计时"（boss 宝箱冷却倒计时）。职责正交。 |
| **数据流重复** | **无重复**。BoxTimer 不订阅 SaveWatcher，所有数据通过 TrackingService 注入的回调单向流动。 |
| **持久化重复** | **无重复**。`session_state.json`（tracker 三件套）与 `box_timers.json`（冷却配置）独立。 |
| **功能冲突** | **存在 1 个 P0 + 2 个 P1 冲突**，详见下文。 |
| **设计正交性** | **优秀**。单向数据流 + 回调注入 + 幂等保护，是项目里少有的清晰解耦设计。 |

---

## 二、业务流程全景图

```
┌─ SaveWatcher (poll mtime) ──────────────────────────────────────┐
│  save *.es3 → readAndDecrypt → parseSnapshot → SaveSnapshot     │
└───────────────────┬─────────────────────────────────────────────┘
                    │ onSnapshot(snap)
                    ▼
┌─ TrackingService ───────────────────────────────────────────────┐
│  ├─ detectHeroLevelUps → onHeroLevelUp (NotificationService)    │
│  ├─ sessionState.tryRestoreOnSnapshot (首次快照恢复)              │
│  ├─ tracker.update(snap)                          ← save 路径    │
│  ├─ onStageKey?.(snap.stageKey) ─────────────┐                  │
│  └─ pushStats → buildStats → broadcast(STATS)│                  │
└──────────────────────────────────────────────┼──────────────────┘
                                               │
                    ┌──────────────────────────┘
                    │
┌─ LiveMemoryService (~25Hz) ──────┐           ▼
│  live frame → ingestLiveFrame    │   ┌─ BoxTimerService ──────────────────┐
│  ├─ tracker.updateLive           │   │  setCurrentStageKey(key)           │
│  ├─ dpsTracker.update            │   │   → currentStageKey 镜像            │
│  ├─ chestAggregator.feed         │   │   → atIdealStage / currentLabel    │
│  │   └─ if rare:                 │   │                                    │
│  │       onLiveStageBossDrop ────┼──►│  tryMarkDroppedFromLiveStage(sk)   │
│  │                               │   │   → resolveTrackedDropBoxIdForStage│
│  ├─ stageClears → onLiveStageClear│  │   → markDropped(boxId)             │
│  │   └─ stageRuns.recordClear    │   │   → onChestDropped (Notification)  │
│  └─ boxOpens → boxOpenTracker    │   │                                    │
└──────────────────────────────────┘   │  1Hz tickTimer (引用计数)           │
                                       │   → buildState → broadcast(BOX_TIMERS)│
                                       │   → 检测冷却→就绪 → onChestReady    │
                                       │                                    │
                                       │  持久化: userData/box_timers.json   │
                                       └────────────────────────────────────┘
```

### 调用方向（单向）

| 起点 | 终点 | 通道 | 用途 |
|------|------|------|------|
| TrackingService | BoxTimerService | `onStageKey` 回调 | save 路径更新 currentStageKey |
| TrackingService | BoxTimerService | `onLiveStageBossDrop` 回调 | live 路径触发 markDropped |
| BoxTimerService | NotificationService | `onChestReady`/`onChestDropped` 回调 | 系统/桌面通知 |
| BoxTimerService | Renderer | `IPC.BOX_TIMERS` 广播 | UI 状态推送 |
| Renderer | BoxTimerService | `window.tbh.markBoxDropped` 等 IPC | 用户操作写回 |

**关键性质**：BoxTimerService **从不**反向调用 TrackingService，无循环依赖。

---

## 三、职责边界明细

### Tracker（TrackingService + core/tracker.ts + 各 Tracker 类）

| 子系统 | 文件 | 职责 |
|--------|------|------|
| XP/金币速率 | `core/tracker.ts` (`XpTracker`) | save/live 双路径速率统计、滚动窗口、会话累计、跨级 XP 桥接 |
| 速率阈值 | `core/trackerLimits.ts` | 物理合理性校验（防脏读、防基线混淆） |
| 会话状态 | `core/sessionState.ts` | 恢复合理性、mtime 连续性校验 |
| Stage 通关历史 | `core/stageRunTracker.ts` | durable 的 stage clear 记录（跨 session 不丢） |
| 宝箱掉落计数 | `core/chestDropTracker.ts` | common/rare 计数 + 50 条历史 + burst 去重 |
| 开箱结果 | `core/boxOpenTracker.ts` | 按 (boxKey, itemKey) 统计 + 价格估值 |
| DPS | `core/liveMemory/dpsTracker.ts` | 5s 滚动 DPS + 60s KPM + wave 检测 |
| 编排 | `main/services/TrackingService.ts` | 装配上述 tracker，处理 save/live 双路径，节流广播 |
| 持久化 | `main/services/SessionStateService.ts` | `session_state.json` 15s autosave + 恢复 |
| Stage 通关服务 | `main/services/StageRunService.ts` | `stage_run_history.json` 独立持久化 |

### BoxTimer（BoxTimerService + core/stageBoxTracker 等）

| 子系统 | 文件 | 职责 |
|--------|------|------|
| 目录与路由 | `core/stageBoxTracker.ts` | 加载 `stage_boxes.json`、ItemKey→boxId、stageKey→boxId 反查 |
| 通用 GameItem 列表 | `core/stageBoxes.ts` | inventory tab 排除 loot chest 用 |
| 行排序 | `core/boxTrackerSort.ts` | cooldown-first / ready-first |
| 冷却服务 | `main/services/BoxTimerService.ts` | 1Hz tick、setter、ready 通知、持久化 |
| 窗口 | `main/windows/boxTrackerWindow.ts` | frameless always-on-top 专用窗口 |
| 渲染 | `renderer/BoxTracker.tsx` 等 | 专用窗口 + 主窗口 Chests 标签页 |

### 边界小结

- **统计 vs 计时**：Tracker 回答"掉了几次/速率多少"，BoxTimer 回答"还有多久冷却结束"。同一次 rare 事件被两者并行处理，**互补不冲突**。
- **持久化文件**：`session_state.json`（可被 reset）/ `box_timers.json`（跨 session durable）/ `stage_run_history.json`（durable）三份独立。
- **数据上游**：BoxTimer 不订阅 SaveWatcher，所有数据通过 TrackingService 注入的回调单向流动。

---

## 四、P0 严重冲突（影响功能正确性）

### P0-1. `BoxTimer.currentStageKey` 在 live-memory 模式下严重滞后

- **位置**：
  - [appState.ts:88](file:///d:/Project/TBH/tbh-companion/app/src/main/app/appState.ts#L88) `(stageKey) => boxTimers.setCurrentStageKey(stageKey)` 作为 `onStageKey` 注入
  - [TrackingService.ts:568](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L568) `this.onStageKey?.(snap.stageKey)` 只在 save 快照到达时调用
  - [TrackingService.ts:426](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L426) live 路径 `tracker.updateLive({ ... }, snap.at / 1000, stage)` 携带 stageKey，但**不传给 BoxTimer**
- **事实**：
  - BoxTimer 的 `currentStageKey` 只通过 save 路径的 `onStageKey` 回调更新
  - live-memory 模式下，save 写盘间隔通常是几秒到几分钟（游戏周期性持久化）
  - BoxTimer 内部用 `currentStageKey` 计算 `atIdealStage`（[BoxTimerService.ts:391](file:///d:/Project/TBH/tbh-companion/app/src/main/services/BoxTimerService.ts#L391)）
  - BoxTracker.tsx 用 `state.currentStageKey` 显示"当前关卡"标签（[BoxTracker.tsx:91](file:///d:/Project/TBH/tbh-companion/app/src/renderer/BoxTracker.tsx#L91)）
- **后果**：
  1. **UI 显示错误**：玩家已切到关卡 B，但 BoxTracker 窗口仍显示关卡 A，且 A 的 farm-stage 仍被高亮
  2. **数据源不一致**：同一次 rare 掉落事件，`tryMarkDroppedFromLiveStage` 用 live 的 stageKey 反查 boxId（正确），但 `setCurrentStageKey` 用 save 的 stageKey 更新高亮（滞后）→ 玩家看到"已掉落关卡 B 的箱子"但"当前关卡显示 A"
  3. 与 tracker 设计原则背离：tracker 用 `LIVE_TAKEOVER_SEC=5` 让 live 路径在活跃时独占数据，但 BoxTimer 没有 same 机制
- **修复方案**：在 `TrackingService.ingestLiveFrame` 中，当 live 帧携带 stageKey 时也调用 `onStageKey`：
  ```ts
  // TrackingService.ingestLiveFrame 内，updateLive 之前或之后
  if (snap.stageKey != null && snap.stageKey > 0) {
    this.onStageKey?.(snap.stageKey);
  }
  ```
  - 风险评估：`BoxTimerService.setCurrentStageKey` 已做相同值短路（`if (this.currentStageKey === key) return`），25Hz 调用无副作用
  - 一致性：save 路径仍会调用 `onStageKey`（live 不活跃时 save 是唯一数据源），无双重计数风险

---

## 五、P1 中等冲突（影响一致性）

### P1-1. Tracker 重置路径不通知 BoxTimer

- **位置**：
  - [TrackingService.ts:201-216](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L201-L216) `reset()`
  - [TrackingService.ts:365-384](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L365-L384) `onSavePathChanged()`
  - [TrackingService.ts:390-410](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L390-L410) `onLiveMemoryToggled()`
- **事实**：三个重置路径都重置 `tracker / chestDropTracker / chestAggregator / boxOpenTracker / dpsTracker`，但**不调用**任何 BoxTimer 接口
- **后果**：
  1. **切换 save 路径后**：`BoxTimer.currentStageKey` 保留上一个 save 的值，atIdealStage 错误高亮，直到下一个 save 快照到达（可能数秒到数分钟）
  2. **用户 reset stats 后**：`ChestDropTracker` 计数清零，但 `BoxTimer` 冷却继续 → UI 显示"0 次掉落" + "3 分钟后冷却结束"的不一致状态（Chests tab 与 BoxTracker 窗口之间）
  3. **切换 live-memory 后**：tracker 全部重置，但 BoxTimer 的 `currentStageKey` 仍是旧值
- **修复方案**：在三个重置路径中调用 `BoxTimerService.setCurrentStageKey(0)` 清空 currentStageKey：
  ```ts
  // 方案 A：在 TrackingService 中新增 onTrackerReset 回调，由 appState 注入 boxTimers.setCurrentStageKey(0)
  // 方案 B：直接在 appState 的 reset/savePath/liveMemory IPC handler 中调用 boxTimers.setCurrentStageKey(0)
  ```
  - 选 A 还是 B：选 A 更符合"通过回调解耦"的现有架构
  - 注意：**不重置** `timers` / `enabledBoxIds` / `cooldownSecondsByBoxId` —— 这些是跨 session durable 的配置，不应被 reset 影响
- **影响范围**：仅清空 `currentStageKey`，不改冷却状态，与 BoxTimer 的"durable across sessions"设计一致

### P1-2. `tryMarkDroppedFromLog` 是死代码

- **位置**：
  - [BoxTimerService.ts:141-156](file:///d:/Project/TBH/tbh-companion/app/src/main/services/BoxTimerService.ts#L141-L156) `tryMarkDroppedFromLog(itemKey: number): boolean`
  - [fileTail.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/io/fileTail.ts) `readFileTailUtf8` 工具函数
- **事实**（已通过全仓库 grep 确认）：
  - `tryMarkDroppedFromLog` 在生产代码中**无任何调用方**（仅 BoxTimerService.ts 自身定义 + 测试引用）
  - `readFileTailUtf8` 在生产代码中**无任何 import**（仅 fileTail.ts 自身定义）
  - 不存在 Player.log tailer 服务
- **影响**：
  1. 维护负担：未来 Player.log tailer 接入时，开发者会误以为该方法已接线
  2. 代码膨胀：保留未使用的接口与配套工具函数
  3. 测试覆盖：现有测试调用 `tryMarkDroppedFromLog` 验证其行为，但实际生产路径是 `tryMarkDroppedFromLiveStage`
- **修复方案**（任选其一）：
  - **方案 A（推荐）**：删除 `tryMarkDroppedFromLog` + `fileTail.ts` + 相关测试。如果未来需要 Player.log 路径，重新设计时再添加。
  - **方案 B**：在 `tryMarkDroppedFromLog` 上方加 JSDoc 明确标注"未接线，预留接口，待 Player.log tailer 接入"，并删除 `fileTail.ts`（确实无人用）。
- **建议**：方案 A。死代码应该删除而不是注释保留，符合 AGENTS.md 的"避免向后兼容 hack"原则。

### P1-3. `SessionStateService` 与 `BoxTimerService` 持久化恢复路径不一致

- **位置**：
  - [SessionStateService.ts:108-169](file:///d:/Project/TBH/tbh-companion/app/src/main/services/SessionStateService.ts#L108-L169) `tryRestoreOnSnapshot` 在首次 save 快照到达时恢复，有 mtime 合理性校验
  - [BoxTimerService.ts:482-528](file:///d:/Project/TBH/tbh-companion/app/src/main/services/BoxTimerService.ts#L482-L528) `load()` 在构造时直接读取，无 mtime 校验
- **事实**：
  - SessionStateService 恢复 tracker 快照时会校验 `snapshotContinuesSession`（mtime 不回滚）和 `isPlausibleTrackerSnapshot`（数值合理性），三态返回 restored/fresh/discarded
  - BoxTimerService 在构造时直接 `load()`，`timers` / `enabledBoxIds` / 配置项都无条件应用，仅 `seedWasOnCooldown` 重新计算就绪状态
  - 两者**没有共享恢复时机**：BoxTimer 在 app 启动时立即恢复，SessionStateService 在首次 save 快照到达时恢复
- **后果**：
  1. 如果 `box_timers.json` 中的 `droppedAtMs` 是几小时前的旧值，恢复后会立即触发"刚就绪"通知（如果 `wasOnCooldown` 在 `seedWasOnCooldown` 中被正确设为 false，则不会触发；但如果 cooldown 已过期且 `notifyWhenReady=true`，`seedWasOnCooldown` 设为 false，`buildState` 不会触发 `onChestReady` —— 因为 `prevOnCooldown === false`）
  2. 缺少显式边界说明：开发者需要阅读 `seedWasOnCooldown` 才能理解为什么不会误触发通知
- **修复方案**：
  - 不需要改变恢复时机（BoxTimer 跨 session durable 是设计意图）
  - 在 `BoxTimerService.seedWasOnCooldown` 上方补充注释，明确"此处设为 false 表示已过期，不会触发 onChestReady，因为 buildState 只在 prev=true→active=false 时触发"
  - 在 `load()` 上方补充注释，明确"BoxTimer 恢复不依赖 save 快照，与 SessionStateService 的恢复路径解耦"

---

## 六、P2 设计改进建议

### P2-1. 双 1Hz tickTimer 资源未共享

- **位置**：[TrackingService.ts:130-135](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L130-L135) + [BoxTimerService.ts:111-122](file:///d:/Project/TBH/tbh-companion/app/src/main/services/BoxTimerService.ts#L111-L122)
- **事实**：两个独立 1Hz 定时器分别广播 `IPC.STATS` 和 `IPC.BOX_TIMERS`
- **影响**：不是 bug，但每秒两次 setInterval 回调可以合并
- **建议**：**不修改**。两者生命周期不同（BoxTimer.tickTimer 受 subscribers 引用计数控制，仅在 BoxTracker 窗口打开时运行；TrackingService.tickTimer 在 tracking 启动后常驻），合并会引入耦合。当前设计正确。

### P2-2. `clearAppData` 部分清理不彻底

- **位置**：[appState.ts:292-318](file:///d:/Project/TBH/tbh-companion/app/src/main/app/appState.ts#L292-L318)
- **事实**：
  - `target="session"` 只重置 tracker，不重置 `BoxTimer.currentStageKey`
  - `target="box-timers"` 只重置 BoxTimer，不影响 tracker
  - `target="all-except-config"` 同时重置两者
- **建议**：保持现状。`target="session"` 的语义是"清除会话统计"，不应影响冷却配置；`target="box-timers"` 的语义是"清除冷却配置"，不应影响统计。两者独立清理是正确设计。

### P2-3. `setCurrentStageKey` 静默吞掉相同值

- **位置**：[BoxTimerService.ts:105-109](file:///d:/Project/TBH/tbh-companion/app/src/main/services/BoxTimerService.ts#L105-L109)
- **事实**：`if (this.currentStageKey === key) return;` 相同值不触发 push
- **影响**：通常没问题，但 P1-1 修复后需要"强制清零"的入口
- **建议**：保持现状。P1-1 的修复方案通过传入 `0` 即可触发 push（因为初始值通常是上一次的 stageKey，0 不等）。

### P2-4. 缺少架构文档

- **事实**：BoxTimer 与 tracker 的解耦设计是优秀的（单向数据流、回调注入、幂等保护），但 `docs/ARCHITECTURE.md` 中没有专门的章节说明两者的边界
- **建议**：本报告作为 findings 文档存档，未来可在 `docs/ARCHITECTURE.md` 中补充"Tracker ↔ BoxTimer 边界"小节

---

## 七、非问题（设计正确，记录备查）

### N-1. `chestAggregator.flushPendingChestDrops` 与 `ingestLiveFrame` 双路径触发 BoxTimer

- **位置**：[TrackingService.ts:187-199](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L187-L199) + [TrackingService.ts:469-481](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts#L469-L481)
- **事实**：同一次 rare 掉落事件可能通过两条路径触发 `onLiveStageBossDrop`：
  1. `ingestLiveFrame` 的 `feed` 循环中 collapsed 出 `rare`
  2. `flushPendingChestDrops`（在 `getStats` 调用前）flush 出残留的 `rare`
- **结论**：**不是 bug**。`BoxTimerService.isBoxOnCooldown` 在 `tryMarkDroppedFromLiveStage` 内部保证幂等，第二次调用直接 `return true` 不重复触发 `markDropped`。设计正确。

### N-2. `tryMarkDroppedFromLiveStage` 多候选 route 的选择策略

- **位置**：[stageBoxTracker.ts:99-119](file:///d:/Project/TBH/tbh-companion/app/src/core/stageBoxTracker.ts#L99-L119) `resolveTrackedDropBoxIdForStage`
- **事实**：多个 route 的 `dropStageKeys` 可能包含同一个 `stageKey`，选择策略：
  1. 优先匹配 farm-stage override（用户自定义的 farm 关卡）
  2. 否则取 level 最高的（同 level 取 boxId 最大）
- **结论**：**合理**。优先 farm override 尊重用户意图，level 最高默认取最稀有的箱子。

### N-3. BoxTimer 不订阅 SaveWatcher

- **事实**：BoxTimer 不直接订阅 save 变化，所有数据通过 TrackingService 回调
- **结论**：**优秀设计**。松耦合，便于测试，BoxTimer 可独立实例化（如测试中）。

### N-4. BoxTimer 跨 session 持久化冷却

- **事实**：`box_timers.json` 在 app 启动时无条件恢复，`timers` / `enabledBoxIds` / `cooldownSecondsByBoxId` 等都跨 session 保留
- **结论**：**设计意图**。冷却倒计时不应该因为 app 重启而丢失，与 `stage_run_history.json` 同属 durable 持久化路径。

---

## 八、实施报告

### 已实施修复

#### P0-1 修复：live 路径补充 `onStageKey` 回调

- **文件**：`app/src/main/services/TrackingService.ts`
- **改动**：在 `ingestLiveFrame` 中，当 live 帧携带有效 stageKey 时调用 `onStageKey?.(snap.stageKey)`
- **验证**：
  - `BoxTimerService.setCurrentStageKey` 已做相同值短路，25Hz 调用无副作用
  - save 路径仍会调用 `onStageKey`，无双重计数风险
  - live 帧到达时 BoxTimer 的 `currentStageKey` 与玩家实际所在关卡一致

#### P1-1 修复：tracker 重置路径通知 BoxTimer 清空 currentStageKey

- **文件**：`app/src/main/services/TrackingService.ts`、`app/src/main/app/appState.ts`
- **改动**：
  - TrackingService 构造函数新增 `onTrackerReset?: () => void` 回调
  - 在 `reset()` / `onSavePathChanged()` / `onLiveMemoryToggled()` 三个重置路径中调用 `onTrackerReset?.()`
  - appState 注入 `() => boxTimers.setCurrentStageKey(0)` 作为 `onTrackerReset`
- **边界**：仅清空 `currentStageKey`，**不重置** `timers` / `enabledBoxIds` / `cooldownSecondsByBoxId` —— 这些是 durable 配置
- **验证**：切换 save 路径后 BoxTracker 窗口的"当前关卡"立即显示为"—"，直到下一个 save/live 快照到达

#### P1-2 修复：删除 `tryMarkDroppedFromLog` 死代码

- **文件**：`app/src/main/services/BoxTimerService.ts`、`app/src/main/io/fileTail.ts`、相关测试
- **改动**：
  - 删除 `BoxTimerService.tryMarkDroppedFromLog` 方法
  - 删除 `app/src/main/io/fileTail.ts`（无引用）
  - 删除/调整调用 `tryMarkDroppedFromLog` 的测试用例
- **验证**：`pnpm typecheck` + `pnpm test` 通过

#### P1-3 修复：补充 `seedWasOnCooldown` / `load` 注释

- **文件**：`app/src/main/services/BoxTimerService.ts`
- **改动**：在 `seedWasOnCooldown` 上方补充注释，明确"此处设为 false 表示已过期，不会触发 onChestReady"；在 `load` 上方补充注释，明确"BoxTimer 恢复不依赖 save 快照，与 SessionStateService 解耦"

### 验证

- `pnpm typecheck`：通过（exit code 0）
- `pnpm test`：**794 个测试全部通过**（86 个测试文件，0 失败），含 `boxTimerService.test.ts`（已移除 3 个 Player.log 路径测试用例）
- `pnpm lint`：本次改动的 4 个文件（TrackingService.ts、BoxTimerService.ts、appState.ts、boxTimerService.test.ts）lint 全部通过。仓库整体有 12 个预存 lint 错误（`useLiveMemory.ts`、`Live.tsx`、`steamItemNameId.test.ts`），与本次改动无关。

### 未实施（P2 建议保留现状）

- P2-1（双 tickTimer）：保持现状，生命周期不同不应合并
- P2-2（clearAppData 部分清理）：保持现状，独立清理是正确设计
- P2-3（setCurrentStageKey 静默短路）：保持现状，P1-1 修复后通过传 0 触发 push
- P2-4（架构文档）：本报告已存档于 `docs/findings/`，未来可在 `docs/ARCHITECTURE.md` 补充

---

## 九、附录：完整文件清单

### Core 层（tracker 子系统）

- [tracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/tracker.ts) — XpTracker 核心类
- [trackerLimits.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/trackerLimits.ts) — 合理性阈值
- [sessionState.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/sessionState.ts) — 恢复合理性校验
- [stageRunTracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/stageRunTracker.ts) — stage clear 历史
- [chestDropTracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/chestDropTracker.ts) — 掉落计数
- [boxOpenTracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenTracker.ts) — 开箱结果
- [boxOpenLog.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/boxOpenLog.ts) — boxKey 解析
- [stageBoxTracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/stageBoxTracker.ts) — BoxTimer 目录/路由
- [stageBoxes.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/stageBoxes.ts) — 通用 stage box 列表
- [boxTrackerSort.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/boxTrackerSort.ts) — 行排序
- [levelCurve.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/levelCurve.ts) — 升级曲线
- [liveMemory/dpsTracker.ts](file:///d:/Project/TBH/tbh-companion/app/src/core/liveMemory/dpsTracker.ts) — DPS 追踪

### Main 层

- [services/TrackingService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/TrackingService.ts) — tracker 编排中心
- [services/SessionStateService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/SessionStateService.ts) — 会话状态持久化
- [services/StageRunService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/StageRunService.ts) — stage clear 服务
- [services/BoxTimerService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/BoxTimerService.ts) — 冷却倒计时服务
- [services/ChestService.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/services/ChestService.ts) — 玩家持有宝箱
- [app/appState.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/app/appState.ts) — 服务接线层
- [stats.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/stats.ts) — Stats payload 组装
- [saveWatcher.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/saveWatcher.ts) — save 文件轮询
- [windows/boxTrackerWindow.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/windows/boxTrackerWindow.ts) — 专用窗口工厂
- [ipc/handlers/{chests,stats,stageRuns,loot}.ts](file:///d:/Project/TBH/tbh-companion/app/src/main/ipc/handlers) — IPC handler

### Renderer / Preload / Shared

- [preload/index.ts](file:///d:/Project/TBH/tbh-companion/app/src/preload/index.ts) — contextBridge
- [renderer/BoxTracker.tsx](file:///d:/Project/TBH/tbh-companion/app/src/renderer/BoxTracker.tsx) — 专用窗口 UI
- [renderer/lib/useBoxTimers.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/useBoxTimers.ts) — 订阅 Hook
- [renderer/lib/boxTrackerUi.ts](file:///d:/Project/TBH/tbh-companion/app/src/renderer/lib/boxTrackerUi.ts) — 渲染层工具
- [renderer/components/ChestsTrackerPanel.tsx](file:///d:/Project/TBH/tbh-companion/app/src/renderer/components/ChestsTrackerPanel.tsx) — 主窗口配置面板
- [shared/types.ts](file:///d:/Project/TBH/tbh-companion/app/shared/types.ts) — 类型定义
- [shared/ipc.ts](file:///d:/Project/TBH/tbh-companion/app/shared/ipc.ts) — IPC 通道名
