# 宝箱自动分类业务逻辑规约

> 基于用户描述梳理的业务逻辑规约，用于对照检查代码实现完整性。
> 日期：2026-07-27

## 1. 核心模型

### 1.1 Slots 池
- 每个类别（common / rare / act）有独立的 slots 池
- 每个 slot 持有一个宝箱
- Save 数据提供每个类别的 slot 数量（`slots.common / rare / act`）

### 1.2 自动开箱计时（serial-queue 模型）
- 每个类别有一个共享 timer，target 队列 head
- head 到时打开后，timer 立即 retarget 新 head（新 head 的 `autoOpenAtMs` 在 drop 时预计算，不变）
- 新宝箱 drop 到非空队列时，append 到 tail：`autoOpenAtMs = prevTail.autoOpenAtMs + autoOpenSeconds`
- 新宝箱 drop 到空队列时：`autoOpenAtMs = droppedAtMs + autoOpenSeconds`
- 背包满时 timer 暂停（freeze），背包清空时 timer 继续（shift forward）

### 1.3 autoOpenSeconds 来源
- 来自 `data/rune_auto_open.json` 的 `baseSeconds`（common=300, stageBoss=600, actBoss=60）
- 减去 rune 减少值
- 首次 save 前用 `FALLBACK_AUTO_OPEN`（300/600/60）

## 2. 状态管理

### 2.1 liveSlots 初始化
- 以 save 报告的 slot 数量为基础：`liveSlots = { ...saveSlots }`
- 实时掉落在此基础上递增：`liveSlots[cat]++`
- 实时开启在此基础递减：`liveSlots[cat]--`

### 2.2 初始打开 companion（backfill）
- 场景：companion 启动时游戏已有宝箱掉落，save 报告有宝箱但 queue 为空
- 规则：给所有有宝箱的 slots 默认增加完整的自动开箱时间
- 实现：backfill N 个 queue item，每个 `autoOpenAtMs = now + N * autoOpenSeconds`（serial chain）

## 3. 实时掉落处理

### 3.1 掉落事件
- `chestDropTracker` 检测掉落，触发 `onDrop` 回调
- `handleChestDrop`：
  1. 计算宝箱 boxKey（基于 stageKey 解析 level）
  2. enqueue 到 queue（serial-queue 模型计算 `autoOpenAtMs`）
  3. `liveSlots[cat]++`（如果 liveSlots 已初始化）

## 4. 宝箱开启事件处理

### 4.1 开启事件来源
- `boxOpenTracker` 检测到 unclassified 开启 burst
- 调用 `handleUnclassifiedBatch` → `processEvent`

### 4.2 容差匹配判定
- `burstMs = burst wallTime * 1000`
- `findBurstMatch`：在 queue 中寻找 `autoOpenAtMs` 在 ±5s（`BURST_MATCH_GRACE_MS`）内的 item
  - 优先 head match
  - head 不在窗口内则全队列搜索最近的

### 4.3 容差内匹配成功
1. **减去对应 slot 数量**：`liveSlots[cat]--`（跳过已 decrement 的避免双重计数）
2. **重置该 slots 倒计时**：校准剩余同 category items 的 `autoOpenAtMs`
   - 锚点 = `burstMs + autoOpenSeconds`（新 head 的开启时间）
   - 后续 items 串联：`anchor + N * autoOpenSeconds`
   - 对应游戏行为：head 在 burstMs 打开后，timer 立即 retarget 新 head，新 head 从 burstMs 开始计时
3. **dequeue** matched item
4. **reclassify** burst items 到 matched boxKey

### 4.4 容差内无匹配（时间都没到）
1. **暂存到未分类**：加入 `pendingBursts` 数组
2. **记下时间**：`burstMs`（burst 发生时间）、`createdAtMs`（用于 TTL pruning）
3. **等待 save 对比分类**

## 5. Save 对比分类

### 5.1 触发时机
- `reconcileWithChestSlots(slots)` 在 save 解析时调用
- 流程顺序：
  1. **excess-prune**（基于新 slots）：删除 queue > slots 的 items（已开但未 dequeue 的）
  2. **classifyPendingBursts**：对比 liveSlots 与 saveSlots，分类 pending bursts 并 reset 剩余 items 的倒计时
  3. **liveSlots = slots**：用 save 值覆盖
  4. **backfill**（queue < slots）：补充缺失的 items

### 5.2 excess-prune 在前的原因
- reset 只应用于**剩余 items**，让新 head 的 autoOpenAtMs = anchorMs
- 如果 reset 在 excess-prune 之前，已开的 chest 会被算进 chain，新 head 的 autoOpenAtMs 错位为 anchorMs + N*autoOpenSec

### 5.3 对比逻辑
- 对比 `liveSlots`（旧值，实时跟踪）与 `saveSlots`（新 save 值）
- `liveSlots[cat] > saveSlots[cat]` → 该 category 有 chest 被打开（live 比 save 多，因为 drop 时 ++ 但 open 没有匹配到 slot 来 --）

### 5.4 分类规则
1. **单一 slot 减少 + 单一 pending burst**：
   - 分类 burst 到该 category（reclassify items）
   - 重置该 slots 倒计时（anchor = `burstMs + autoOpenSec`，即新 head 的 autoOpenAtMs）
2. **多个 slots 减少（兜底）**：
   - burst 留在未分类（不 reclassify）
   - 重置所有 slots 倒计时（anchor = 最早 burst 的 `burstMs + per-cat autoOpenSec`）
3. **无 slot 减少**：
   - pending bursts 保留（等待 TTL pruning）

### 5.5 后续处理
- `liveSlots` 更新为 save 值
- backfill：`queueCount < slotCount` → 补充缺失的 items（初始打开 companion 场景）

## 6. 背包满暂停

### 6.1 暂停检测
- `updateInventoryPauseState`：`used >= capacity` → 暂停
- 记录 `inventoryFullSinceMs`
- `effectiveNow` 返回 `inventoryFullSinceMs`（冻结）
- tick 跳过 decrement 和 prune

### 6.2 恢复
- 背包不满时：`shiftQueueTimes(pausedMs)`
  - 非已 decrement 的 items 的 `autoOpenAtMs / expiresAtMs += pausedMs`
- 清除 `inventoryFullSinceMs`

## 7. 队列时间计算

### 7.1 nextAutoOpenInMs（下一个开启时间）
- `= head.autoOpenAtMs - now`
- clamp 到 0

### 7.2 lastAutoOpenInMs（队列清空时间）
- `= tail.autoOpenAtMs - now`
- tail.autoOpenAtMs 已在 enqueue/recompute/shift 时正确维护（serial chain）
- 不使用公式 `headRemain + (depth-1)*singleSec*1000`，因为队列可能混合不同 autoOpenSeconds

## 8. drift 校准

### 8.1 触发条件
- `maybeRecalibrateQueue`：检测 `autoOpenSeconds` 变化（rune 购买等）
- 超过 1% 相对变化 + 1s 绝对变化 → `recomputeQueueAutoOpenAtMs`

### 8.2 处理
- 重新计算所有 items 的 `autoOpenAtMs`
- 重置 `slotDecrementedItems` WeakSet

## 9. Pending Burst TTL

- `PENDING_BURST_TTL_MS = 300_000`（5 分钟）
- `pruneExpiredPendingBursts`：删除超过 TTL 的 pending bursts
- 被 prune 的 bursts 留在未分类，等待手动处理

## 10. 容差校准（每次容差内匹配）

- 每次容差范围内的宝箱开启，对 slots 的倒计时进行校准
- 校准锚点 = `burstMs + autoOpenSeconds`（新 head 的开启时间）
- 后续 items 重新串联
- 避免计时误差沿队列尾部累积

---

## 11. 代码实现对照检查

对照 [AutoClassifyService.ts](../../app/src/main/services/AutoClassifyService.ts) 逐项检查：

### 11.1 实现完整的部分

| 规约条目 | 代码位置 | 状态 |
|---------|---------|------|
| 2.1 liveSlots 以 save 为基础 | `reconcileWithChestSlots`: `this.liveSlots = { ...slots }` | ✅ |
| 2.1 实时掉落递增 | `handleChestDrop`: `this.liveSlots[cat]++` | ✅ |
| 2.2 初始 backfill | `reconcileWithChestSlots`: deficit → `enqueue` backfill | ✅ |
| 3.1 掉落 enqueue + liveSlots++ | `handleChestDrop` | ✅ |
| 4.2 容差判定 ±15s | `findBurstMatch` + `BURST_MATCH_GRACE_MS` | ✅ |
| 4.3 容差内匹配：减 slot | `processEvent`: `liveSlots[cat]--` + WeakSet 防双重 | ✅ |
| 4.3 容差内匹配：dequeue | `processEvent`: `this.queue.filter` | ✅ |
| 4.3 容差内匹配：reclassify | `processEvent`: `reclassifyItem` | ✅ |
| 4.3 容差内匹配：校准倒计时 | `processEvent`: `resetSlotTimersForCategory(cat, burstMs + autoOpenSec)` | ✅ |
| 4.4 容差内无匹配：暂存 | `processEvent`: `pendingBursts.push` | ✅ |
| 4.4 记下时间 | `PendingBurst.burstMs / createdAtMs` | ✅ |
| 5.2 Save 对比逻辑 | `classifyPendingBursts`: `liveSlots[cat] > saveSlots[cat]` | ✅ |
| 5.3 单一减少：分类 + 重置 | `classifyPendingBursts`: reclassify + `resetSlotTimersForCategory` | ✅ |
| 5.3 多减少：兜底 + 重置所有 | `classifyPendingBursts`: ambiguous 分支 | ✅ |
| 5.4 excess-prune | `reconcileWithChestSlots`: `queueCount > slotCount` → prune | ✅ |
| 6.1 背包满暂停 | `updateInventoryPauseState` + `effectiveNow` | ✅ |
| 6.2 恢复 shift | `shiftQueueTimes(pausedMs)` | ✅ |
| 7.1 nextAutoOpenInMs | `getQueueSnapshot`: `head.autoOpenAtMs - now` | ✅ |
| 7.2 lastAutoOpenInMs | `getQueueSnapshot`: `tail.autoOpenAtMs - now` | ✅ |
| 8. drift 校准 | `maybeRecalibrateQueue` + `recomputeQueueAutoOpenAtMs` | ✅ |
| 9. Pending Burst TTL | `pruneExpiredPendingBursts` (300s) | ✅ |
| 10. 容差校准 | `processEvent` 中的 `resetSlotTimersForCategory` 调用 | ✅ |

### 11.2 发现的问题

#### 问题 A：`classifyPendingBursts` 中 `resetSlotTimersForCategory` 的 anchor 语义可能导致 tick 误 decrement

**现象：**

`resetSlotTimersForCategory` 的实现是 `head.autoOpenAtMs = anchorMs`，但两个调用方的 anchor 语义不同：

| 调用方 | anchor | head.autoOpenAtMs | 语义 |
|--------|--------|-------------------|------|
| `processEvent` | `burstMs + autoOpenSec` | 未来时间（新 head 的开启时间） | 语义B：head 从 anchor 开始计时 |
| `classifyPendingBursts` | `burstMs` | 已过去（head 已打开） | 语义A：head 在 anchor 时已打开 |

`classifyPendingBursts` 的设计意图是：head.autoOpenAtMs = burstMs（已打开），后续 items 从 `burstMs + autoOpenSec` 开始，head 会被 `reconcileWithChestSlots` 的 excess-prune 删除。最终效果与 processEvent 一致。

**风险：**

如果 `burstMs` 距离 `now` 很久（pending burst 是几分钟前暂存的），后续 items 的 `autoOpenAtMs` 也可能已过期：

```
假设：burstMs = now - 5min, autoOpenSec = 60s (act)
reset 后：
  head.autoOpenAtMs  = burstMs            (5min 前，已过期)
  item[1].autoOpenAtMs = burstMs + 60s    (4min 前，已过期)
  item[2].autoOpenAtMs = burstMs + 120s   (3min 前，已过期)
```

excess-prune 只删除 `excess` 个 items（通常 1 个，即 head）。剩余 items 的 `autoOpenAtMs` 已过期，tick 会 `liveSlots[cat]--`，但 `liveSlots` 已经被设为 `saveSlots`，导致 `liveSlots < saveSlots`，不一致。

**影响：** liveSlots 计数偏低，UI 显示的 slot 数量比实际少。

**建议修复：** `classifyPendingBursts` 中的 `resetSlotTimersForCategory` 调用应改用 `burstMs + autoOpenSec` 作为 anchor（与 `processEvent` 一致），让新 head 从 `burstMs + autoOpenSec` 开始计时。excess-prune 仍然会删除多余的 item（queue > slots），但删除的是排序后在最前面的已过期 item，不会影响剩余 items 的计时。

#### 问题 B：ambiguous 分支同样有 anchor 问题

`classifyPendingBursts` 的多 slot 减少分支调用 `resetSlotTimersForCategory(cat, earliestBurstMs)`，与问题 A 相同的 anchor 语义问题。如果 `earliestBurstMs` 距离 `now` 很久，后续 items 的 `autoOpenAtMs` 也可能已过期，导致 tick 误 decrement。

**影响：** 同问题 A。

**建议修复：** 同问题 A，改用 `earliestBurstMs + autoOpenSec` 作为 anchor。

#### 问题 C：`resetSlotTimersForCategory` 函数名语义模糊

同一个函数被两个不同语义的调用方使用：
- `processEvent`：anchor = 新 head 的 autoOpenAtMs
- `classifyPendingBursts`：anchor = 已打开的 chest 的时间（head 会被 excess-prune 删除）

函数注释说 "head opens at anchorMs (it already opened)"，但 `processEvent` 的调用不符合这个语义。

**建议：** 统一为语义B（anchor = 新 head 的 autoOpenAtMs），`classifyPendingBursts` 调用时传 `burstMs + autoOpenSec`。这样函数语义清晰，且避免问题 A/B。
