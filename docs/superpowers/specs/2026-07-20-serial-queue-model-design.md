# 自动归类队列：串行计时模型重构设计

- 日期: 2026-07-20
- 状态: 设计待审阅
- 作者: pair (user + assistant)
- 关联:
  - [2026-07-17-box-auto-classify-design.md](2026-07-17-box-auto-classify-design.md)（初版设计）
  - [2026-07-19-live-chest-slots-design.md](2026-07-19-live-chest-slots-design.md)（实时槽位）
  - [app/src/core/boxOpenAutoClassify.ts](../../../app/src/core/boxOpenAutoClassify.ts)（待重构）
  - [app/src/main/services/AutoClassifyService.ts](../../../app/src/main/services/AutoClassifyService.ts)（待重构）

## 1. 背景与动机

### 1.1 当前实现的核心错误假设

`boxOpenAutoClassify.ts` 与 `AutoClassifyService.ts` 当前基于 **slot-parallel 模型** 实现：

> "游戏运行每个 chest slot 一个独立的自动开启计时器。当 chest 掉落时占用下一个空闲 slot，其计时器立即启动（`autoOpenAtMs = droppedAtMs + autoOpenSeconds * 1000`）。"
> —— [boxOpenAutoClassify.ts:6-13 注释](../../../app/src/core/boxOpenAutoClassify.ts#L6-L13)

该假设是**错误的**。真实游戏机制是：

- **每个类别只有一个共享计时器**，串行开启队列头部宝箱
- 计时器到点后开启 head，立即重启开启下一个 head（队列非空时）
- 新掉落的宝箱入队尾，其开启时刻 = **当前队尾的 `autoOpenAtMs` + `autoOpenSeconds`**，而不是 `droppedAtMs + autoOpenSeconds`
- Slot 池满时游戏限流，不会触发新 drop（玩家侧无需处理"无 slot 可放"）
- 手动开启 head 不影响其它 slot 的计时器（用户确认）

### 1.2 错误假设导致的实际影响

由于 `autoOpenAtMs` 计算公式错误，队列长度 > 1 时：

| 影响项 | 表现 |
|---|---|
| UI "opensIn" (head 倒计时) | 队列空时正确；队列非空时 head 倒计时仍正确（head 公式恰好对） |
| UI "clearsIn" (tail 全清倒计时) | **严重偏小**。3 个 common@t=0/100/200，autoOpen=300s：真实 900s，代码显示 500s |
| `liveSlots` 实时调整 | `tick()` 遍历整个队列检测 `autoOpenAtMs <= now`，tail 项的 `autoOpenAtMs` 被低估 → tail 提前触发 `liveSlots[cat]--`，导致 `liveSlots` 偏小 |
| TTL 覆盖范围 | `2 × autoOpen + 30s` 仅覆盖队列深度 ≤ 2 的情况；串行模型下队尾第 N 项的真实开启时刻 = N × autoOpen，TTL 不足以覆盖深度较大的队列 |
| 队列排序 | `insertSorted` 按 `autoOpenAtMs` 升序，串行模型下 `autoOpenAtMs` 单调递增（接尾计算），排序仍正确；但当前公式可能导致非单调 |

### 1.3 重构目标

1. 修正 `autoOpenAtMs` 计算公式为**接尾模型**（serial queue with per-category shared timer）
2. 简化 `tick()` 为**只检查 head**，避免 tail 项提前触发 `liveSlots--`
3. 调整 TTL 公式，使其在串行模型下覆盖队尾真实开启时刻 + grace
4. 修正 `LootQueueSlots` 中 `clearsIn` 的语义（队尾全清时刻）使其准确
5. 重写所有受影响的单元测试与集成测试
6. 更新 `project_memory.md` 中关于 slot-parallel 模型的错误记录

### 1.4 非目标

- 不改变队列 FIFO 匹配语义（`dequeue` 行为不变）
- 不改变 `reconcileWithChestSlots` 的修剪策略（按 `autoOpenAtMs` 升序修剪 excess，串行模型下仍正确）
- 不改变 prompt 弹窗逻辑
- 不持久化队列跨 session
- 不引入新 IPC channel
- 不修改 `chestDropTracker` / `boxOpenTracker` 已有 API

## 2. 真实游戏机制（用户确认）

### 2.1 计时器模型

每个类别（common / rare / act）维护**一个共享计时器**：

```
类别队列状态: [head, ..., tail]
计时器目标: head.autoOpenAtMs

事件流:
  drop → 入队尾
         若队列为空（即新 head）: autoOpenAtMs = droppedAtMs + autoOpenSeconds
         若队列非空（接尾）:      autoOpenAtMs = tail.autoOpenAtMs + autoOpenSeconds
         计时器到点 → 开启 head → 出队
         若新 head 存在: 计时器继续运行至新 head.autoOpenAtMs（值不变，原已预设）
         若队列空: 计时器停止
  手动开启 head → 出队
         新 head 的 autoOpenAtMs **不变**（计时器继续运行向原预设目标）
         若队列空: 计时器停止
```

### 2.2 关键不变量

1. **`autoOpenAtMs` 一旦计算就不变**：入队时确定，后续不重新计算（无论 head 出队还是手动开启）
2. **队列按 `autoOpenAtMs` 严格升序**：接尾计算保证 `tail.autoOpenAtMs = prevTail.autoOpenAtMs + autoOpenSeconds`，单调递增
3. **head 是唯一被计时器关注的项**：只有 head 的 `autoOpenAtMs <= now` 才意味着"宝箱被自动开启"
4. **slot 池满 → 游戏 limit drop**：companion 不需要处理"无 slot 可放"的情况
5. **手动开启不影响其它 slot**：手动开 head 后，新 head 的 `autoOpenAtMs` 保持原值

### 2.3 与 slot-parallel 模型的对比

| 维度 | slot-parallel（错误） | serial queue（真实） |
|---|---|---|
| 计时器数量 | 每宝箱 1 个 | 每类别 1 个 |
| tail `autoOpenAtMs` | `droppedAtMs + autoOpen` | `prevTail.autoOpenAtMs + autoOpen` |
| tail 真实开启时刻 | `droppedAtMs + autoOpen` | `head.droppedAtMs + N × autoOpen`（N 为队列深度） |
| 手动开 head 后 | N/A | 新 head `autoOpenAtMs` 不变 |
| TTL 覆盖范围 | `2 × autoOpen` 足够 | 需覆盖 `N × autoOpen`（N 队列深度） |

## 3. 当前代码缺陷详细分析

### 3.1 `enqueue` 公式错误

[boxOpenAutoClassify.ts:86-99](../../../app/src/core/boxOpenAutoClassify.ts#L86-L99):

```typescript
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  const autoOpenAtMs = input.droppedAtMs + input.autoOpenSeconds * 1000;  // ❌ 错误
  const expiresAtMs = autoOpenAtMs + ttlMs;
  // ...
}
```

**修正**：

```typescript
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  const prevTail = queue.length > 0 ? queue[queue.length - 1] : null;
  const autoOpenAtMs = prevTail
    ? prevTail.autoOpenAtMs + input.autoOpenSeconds * 1000  // ✅ 接尾
    : input.droppedAtMs + input.autoOpenSeconds * 1000;     // ✅ 队列空时锚定到 drop
  const expiresAtMs = autoOpenAtMs + ttlMs;
  // ...
}
```

### 3.2 TTL 公式不足以覆盖队尾

[boxOpenAutoClassify.ts:34-36](../../../app/src/core/boxOpenAutoClassify.ts#L34-L36):

```typescript
export function computeTtlMs(autoOpenSeconds: number): number {
  return Math.max(autoOpenSeconds * 2 * 1000, MIN_TTL_MS) + TTL_BUFFER_MS;
}
```

`2 × autoOpen` 隐含假设"队列最多 2 项"。串行模型下，队尾第 N 项的真实开启时刻 = `head.droppedAtMs + N × autoOpen`（最坏情况），TTL 应该覆盖到 `autoOpenAtMs + grace`。

**修正思路**：TTL 不再依赖队列深度（无法预知），改为固定的 `autoOpen + grace`。因为 `expiresAtMs = autoOpenAtMs + ttlMs`，而 `autoOpenAtMs` 已经包含排队等待时间，所以 `ttlMs = max(autoOpen × 1000, MIN_TTL_MS) + TTL_BUFFER_MS` 即可：

```typescript
export function computeTtlMs(autoOpenSeconds: number): number {
  // TTL 锚定到 autoOpenAtMs（已包含排队等待），只需覆盖一次 autoOpen 周期 + grace
  return Math.max(autoOpenSeconds * 1000, MIN_TTL_MS) + TTL_BUFFER_MS;
}
```

注：去掉 `× 2`。原 `× 2` 是因为 slot-parallel 模型下 TTL 锚定到 `droppedAtMs`，需要覆盖"已等待一个周期才入队"的最坏情况；串行模型下 TTL 锚定到 `autoOpenAtMs`（真实开启时刻），不需要 2 倍余量。

### 3.3 `tick()` 遍历整个队列导致 tail 提前扣 `liveSlots`

[AutoClassifyService.ts:333-344](../../../app/src/main/services/AutoClassifyService.ts#L333-L344):

```typescript
if (this.liveSlots) {
  for (const item of this.queue) {
    if (item.autoOpenAtMs > now) continue;
    if (this.autoOpenedItems.has(item)) continue;
    // ... liveSlots[cat]--
    this.autoOpenedItems.add(item);
  }
}
```

串行模型下，只有 head 的 `autoOpenAtMs <= now` 意味着"宝箱被自动开启"。tail 的 `autoOpenAtMs` 是预设未来时刻，不应在 tick 中触发 `liveSlots--`。

由于当前 `enqueue` 公式错误，tail 的 `autoOpenAtMs` 被低估（如 3 个 common@t=0/100/200，autoOpen=300s：tail@500s 而非真实 900s），导致 tail 在真实开启时刻之前就被 tick 标记为 auto-opened，`liveSlots` 偏小。

**修正**：只检查 head：

```typescript
if (this.liveSlots && this.queue.length > 0) {
  const head = this.queue[0];
  if (head && head.autoOpenAtMs <= now && !this.autoOpenedItems.has(head)) {
    const cat = categoryFromBoxKey(head.boxKey);
    if (cat && cat !== "unclassified" && this.liveSlots[cat] > 0) {
      this.liveSlots[cat]--;
    }
    this.autoOpenedItems.add(head);
  }
}
```

### 3.4 `dequeue` 的"跳过过期项"语义需要复核

[boxOpenAutoClassify.ts:139-152](../../../app/src/core/boxOpenAutoClassify.ts#L139-L152):

```typescript
export function dequeue(queue: QueueItem[], nowMs: number): { queue: QueueItem[]; item: QueueItem | null } {
  const remaining = [...queue];
  while (remaining.length > 0) {
    const head = remaining.shift()!;
    if (head.expiresAtMs > nowMs) {
      return { queue: remaining, item: head };
    }
    // Expired head: drop it and continue
  }
  return { queue: [], item: null };
}
```

串行模型下，head 过期意味着该宝箱的真实 auto-open 时刻已过 + grace 仍未匹配到 unclassified burst（可能游戏已正确归类，或 burst 丢失）。直接跳过是合理的，但跳过后**新 head 的 `autoOpenAtMs` 不变**——这与"手动开启 head 后新 head 不变"一致，符合串行模型。✓ 此处无需修改。

### 3.5 测试断言基于错误公式

[test/autoClassifyService.test.ts:551-590](../../../app/test/main/autoClassifyService.test.ts#L551-L590) "sorted by autoOpenInMs ascending" 用例：

```typescript
chestDropTracker.recordLiveChestDrop("rare", 1.0);
chestDropTracker.recordLiveChestDrop("common", 2.0);
chestDropTracker.recordLiveChestDrop("act", 3.0);
// 断言: [act:1 (63000), common:5 (302000), rare:5 (601000)]
```

slot-parallel 下：每项独立 `droppedAtMs + autoOpen × 1000`。
串行模型下：第 2 项 = 第 1 项 `autoOpenAtMs + autoOpen × 1000`，第 3 项 = 第 2 项 + autoOpen × 1000。

具体值取决于入队顺序与类别切换。串行模型按**同类别接尾**，跨类别不接尾（每类别独立计时器）。所以：
- rare@1s 入队（队列空）→ rare.autoOpenAtMs = 1000 + 600×1000 = 601000
- common@2s 入队（common 队列空，跨类别独立）→ common.autoOpenAtMs = 2000 + 300×1000 = 302000
- act@3s 入队（act 队列空）→ act.autoOpenAtMs = 3000 + 60×1000 = 63000

**跨类别独立计时器场景下，slot-parallel 与 serial 的计算结果恰好一致**（因为每个类别的队列深度都是 1）。该测试用例不暴露 bug。

但若同类别连掉多个，差异立现：

```typescript
chestDropTracker.recordLiveChestDrop("common", 1.0);  // autoOpenAtMs = 301000
chestDropTracker.recordLiveChestDrop("common", 2.0);  // serial: 301000 + 300000 = 601000; parallel: 302000
```

测试需补此类用例。

### 3.6 `LootQueueSlots.clearsIn` 语义复核

[LootQueueSlots.tsx:131](../../../app/src/renderer/components/loot/LootQueueSlots.tsx#L131):

```typescript
const clearsInMs = lastAutoOpenInMs;  // tail 的剩余时间
```

`lastAutoOpenInMs` 来自 `getQueueSnapshot()` 的 `byCategory[cat].lastAutoOpenInMs`：

[AutoClassifyService.ts:151](../../../app/src/main/services/AutoClassifyService.ts#L151):

```typescript
lastAutoOpenInMs = Math.max(0, items[items.length - 1]!.autoOpenAtMs - now);
```

串行模型下，tail 的 `autoOpenAtMs` 是该类别队列最后一个宝箱的真实开启时刻，`clearsInMs = tail.autoOpenAtMs - now` 语义正确。✓ 修正 `enqueue` 公式后此处自动正确。

## 4. 重构设计

### 4.1 数据模型（不变）

`QueueItem` 字段保持不变，但 `autoOpenAtMs` 的计算方式改变：

```typescript
interface QueueItem {
  boxKey: string;
  droppedAtMs: number;
  stageKey: number;
  expiresAtMs: number;       // = autoOpenAtMs + ttlMs
  autoOpenSeconds: number;
  autoOpenAtMs: number;      // 串行模型: 队列空时 = droppedAtMs + autoOpen×1000
                             //           队列非空时 = prevTail.autoOpenAtMs + autoOpen×1000
}
```

### 4.2 `enqueue` 接尾计算

```typescript
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[] {
  const ttlMs = computeTtlMs(input.autoOpenSeconds);
  // 接尾模型：每类别一个共享计时器，新项的 autoOpenAtMs 接在同类队尾之后
  const sameCategoryTail = findSameCategoryTail(queue, input.boxKey);
  const autoOpenAtMs = sameCategoryTail
    ? sameCategoryTail.autoOpenAtMs + input.autoOpenSeconds * 1000
    : input.droppedAtMs + input.autoOpenSeconds * 1000;
  const expiresAtMs = autoOpenAtMs + ttlMs;
  const item: QueueItem = { /* ... */ };
  return insertSorted(queue, item);
}

function findSameCategoryTail(queue: QueueItem[], boxKey: string): QueueItem | null {
  const cat = categoryFromBoxKey(boxKey);
  if (!cat) return null;
  // 队列按 autoOpenAtMs 升序，但跨类别混合。需要找同类别的最后一项（按 autoOpenAtMs 最大）
  let tail: QueueItem | null = null;
  for (const item of queue) {
    if (categoryFromBoxKey(item.boxKey) === cat) {
      if (!tail || item.autoOpenAtMs > tail.autoOpenAtMs) tail = item;
    }
  }
  return tail;
}
```

**关键点**：
- 跨类别独立计时器，所以接尾只在同类别内进行
- 队列整体仍按 `autoOpenAtMs` 升序排列（`insertSorted`），但同类别项的 `autoOpenAtMs` 严格递增

### 4.3 `computeTtlMs` 去掉 2 倍系数

```typescript
export function computeTtlMs(autoOpenSeconds: number): number {
  // 串行模型：TTL 锚定到 autoOpenAtMs（已包含排队等待），只需覆盖一次 autoOpen 周期 + grace
  // MIN_TTL_MS 防止 rune 把 autoOpen 减到 0 后立即过期
  return Math.max(autoOpenSeconds * 1000, MIN_TTL_MS) + TTL_BUFFER_MS;
}
```

### 4.4 `tick()` 只检查 head

```typescript
tick(): void {
  if (!this.enabled) return;
  const now = Date.now();
  // 串行模型：只有 head 的 autoOpenAtMs <= now 意味着"宝箱被自动开启"
  // tail 的 autoOpenAtMs 是预设未来时刻，不应触发 liveSlots--
  if (this.liveSlots && this.queue.length > 0) {
    const head = this.queue[0]!;
    if (head.autoOpenAtMs <= now && !this.autoOpenedItems.has(head)) {
      const cat = categoryFromBoxKey(head.boxKey);
      if (cat && cat !== "unclassified" && this.liveSlots[cat] > 0) {
        this.liveSlots[cat]--;
      }
      this.autoOpenedItems.add(head);
    }
  }
  // pruneExpired 仍遍历整个队列（移除过期项），但不修改 liveSlots
  const before = this.queue.length;
  this.queue = pruneExpired(this.queue, now);
  if (this.queue.length < before) {
    log.info(`pruned ${before - this.queue.length} expired queue items`);
  }
  // prompt 超时不变
  if (this.pending && now - this.pending.createdAtMs > PROMPT_TIMEOUT_MS) {
    // ...
  }
}
```

### 4.5 `processEvent` 不变

`processEvent` 在 unclassified burst 到达时调用 `dequeue` 弹出 head。串行模型下，弹出 head 后新 head 的 `autoOpenAtMs` 不变（继续运行向原预设目标），与"手动开启 head 后新 head 不变"一致。`liveSlots[cat]--` 仍由 `processEvent` 在 `dequeue` 成功后执行（若项不在 `autoOpenedItems` 中）。✓ 无需修改。

### 4.6 `reconcileWithChestSlots` 修剪策略不变

[AutoClassifyService.ts:282-289](../../../app/src/main/services/AutoClassifyService.ts#L282-L289) 按 `autoOpenAtMs` 升序修剪 excess。串行模型下：
- `autoOpenAtMs` 严格单调递增（同类别接尾计算）
- 跨类别混合时仍按 `autoOpenAtMs` 排序
- 修剪最早 `autoOpenAtMs` 的 excess 项 = 修剪最早应开启的项 = 正确

✓ 无需修改。

### 4.7 `getQueueSnapshot` 不变

`byCategory[cat].nextAutoOpenInMs` = 该类别 head 的剩余时间，`lastAutoOpenInMs` = 该类别 tail 的剩余时间。串行模型下两者都基于正确的 `autoOpenAtMs`，语义正确。✓ 无需修改。

### 4.8 `WeakSet autoOpenedItems` 不变

`autoOpenedItems` 用于防止 tick 与 processEvent 双扣 `liveSlots`。串行模型下仍需要：
- tick 检测 head auto-opened → 扣 liveSlots + 入 WeakSet
- 后续 processEvent 收到 unclassified burst → dequeue 该项 → 已在 WeakSet → 跳过 liveSlots 扣减

✓ 无需修改。

## 5. 影响范围

### 5.1 必须修改的文件

| 文件 | 修改内容 |
|---|---|
| [app/src/core/boxOpenAutoClassify.ts](../../../app/src/core/boxOpenAutoClassify.ts) | `enqueue` 接尾计算；`computeTtlMs` 去 2×；新增 `findSameCategoryTail` 辅助；更新文件头注释 |
| [app/src/main/services/AutoClassifyService.ts](../../../app/src/main/services/AutoClassifyService.ts) | `tick()` 改为只检查 head；更新类头注释 |
| [app/test/core/boxOpenAutoClassify.test.ts](../../../app/test/core/boxOpenAutoClassify.test.ts) | 新增串行模型测试用例（同类别连掉、跨类别独立计时器） |
| [app/test/main/autoClassifyService.test.ts](../../../app/test/main/autoClassifyService.test.ts) | 修正受影响用例的断言值；新增 tick 只检 head 的测试 |

### 5.2 必须更新的文档

| 文件 | 更新内容 |
|---|---|
| 本设计文档（新增） | 串行模型规范 |
| [docs/superpowers/plans/2026-07-20-serial-queue-model.md](../plans/2026-07-20-serial-queue-model.md)（新增） | 实施计划 |
| `project_memory.md` | 修正"slot-parallel model"相关条目为"serial queue model" |

### 5.3 不需要修改的文件

| 文件 | 原因 |
|---|---|
| [app/src/renderer/components/loot/LootQueueSlots.tsx](../../../app/src/renderer/components/loot/LootQueueSlots.tsx) | 修正 `enqueue` 后 `clearsIn` 自动正确 |
| [app/src/main/services/ChestService.ts](../../../app/src/main/services/ChestService.ts) | `reconcile` 回调签名不变 |
| [app/src/main/services/TrackingService.ts](../../../app/src/main/services/TrackingService.ts) | tracker 回调接线不变 |
| [app/src/main/app/appState.ts](../../../app/src/main/app/appState.ts) | 装配不变（仅可能补全 fallback `getAutoClassifyState` 的字段） |
| [app/src/main/ipc/handlers/loot.ts](../../../app/src/main/ipc/handlers/loot.ts) | IPC 不变 |
| [app/shared/types.ts](../../../app/shared/types.ts) | `QueueItem` 字段不变 |
| [app/src/core/boxOpenLog.ts](../../../app/src/core/boxOpenLog.ts) | `categoryFromBoxKey` 不变 |
| [app/src/core/stageBoxTracker.ts](../../../app/src/core/stageBoxTracker.ts) | `inferLevelFromStage` 不变 |

### 5.4 顺带修复（类型契约缺口）

[appState.ts:632-642](../../../app/src/main/app/appState.ts#L632-L642) 的 `getAutoClassifyState` fallback 对象缺 `lastAutoOpenInMs` 和 `liveSlots` 字段，补齐：

```typescript
getAutoClassifyState: () =>
  autoClassify?.getQueueSnapshot() ?? {
    enabled: false,
    totalQueued: 0,
    byCategory: [
      { category: "common", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
      { category: "rare", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
      { category: "act", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    ],
    items: [],
    liveSlots: null,
  },
```

## 6. 核心算法示例

### 6.1 同类别连掉（serial 接尾）

```
autoOpenSeconds.common = 300s
drop common@t=1s  → 队列空 → autoOpenAtMs = 1000 + 300000 = 301000
drop common@t=2s  → 同类队尾存在 → autoOpenAtMs = 301000 + 300000 = 601000
drop common@t=3s  → 同类队尾存在 → autoOpenAtMs = 601000 + 300000 = 901000

队列（按 autoOpenAtMs 升序）:
  [common@301000, common@601000, common@901000]

now=10000ms 时:
  opensIn (head) = 301000 - 10000 = 291000ms (~4.85min)
  clearsIn (tail) = 901000 - 10000 = 891000ms (~14.85min)
```

slot-parallel 模型下三者分别为 301000/302000/303000，clearsIn 仅 ~4.88min，严重偏小。

### 6.2 跨类别独立计时器

```
autoOpenSeconds.common = 300s, autoOpenSeconds.rare = 600s
drop rare@t=1s   → rare 队列空 → rare.autoOpenAtMs = 1000 + 600000 = 601000
drop common@t=2s → common 队列空 → common.autoOpenAtMs = 2000 + 300000 = 302000
drop common@t=3s → common 队尾存在 → common.autoOpenAtMs = 302000 + 300000 = 602000

队列（按 autoOpenAtMs 升序）:
  [common@302000, common@602000, rare@601000]
```

注：`601000 < 602000`，所以 rare 排在第二个 common 之前。这是 `insertSorted` 的正常行为，head 是最早 autoOpenAtMs 的项。

### 6.3 手动开启 head 后新 head 不变

```
队列: [common@302000, common@602000, rare@601000]
now=305000ms（head 已到 autoOpenAtMs）
手动开启 head（unclassified burst 到达 processEvent）:
  dequeue 弹出 common@302000
  reclassifyItem(unclassified, itemKey, "common:5")
  liveSlots.common-- (若不在 autoOpenedItems)
  剩余队列: [common@602000, rare@601000] → 重新按 autoOpenAtMs 排序 → [rare@601000, common@602000]

新 head = rare@601000，其 autoOpenAtMs = 601000 不变（不重新计算）
```

### 6.4 `reconcileWithChestSlots` 修剪

```
队列: [common@302000, common@602000, common@901000]
save 显示 common slots = 1（已开启 2 个）
excess = 3 - 1 = 2
按 autoOpenAtMs 升序修剪前 2 项 → 剩余 [common@901000]
```

串行模型下此修剪策略正确：最早 autoOpenAtMs 的项应该最早开启，若 slots 显示已开启则它们应该已出队，未出队说明 burst 丢失或已正确归类，修剪是合理兜底。

## 7. 测试策略

### 7.1 core 单元测试（[boxOpenAutoClassify.test.ts](../../../app/test/core/boxOpenAutoClassify.test.ts)）

新增以下用例：

1. **`enqueue` 接尾计算 - 同类别连掉**
   - drop common@1s → autoOpenAtMs = 301000
   - drop common@2s → autoOpenAtMs = 601000（接尾）
   - drop common@3s → autoOpenAtMs = 901000（接尾）
   - 断言队列长度 3，`autoOpenAtMs` 严格递增 301000/601000/901000

2. **`enqueue` 跨类别独立计时器**
   - drop rare@1s → autoOpenAtMs = 601000
   - drop common@2s → autoOpenAtMs = 302000（common 队列空，不接 rare 的尾）
   - drop common@3s → autoOpenAtMs = 602000（接 common 队尾）
   - 断言三个 `autoOpenAtMs`：302000, 601000, 602000

3. **`computeTtlMs` 新公式**
   - autoOpen=0 → ttlMs = max(0, 60000) + 30000 = 90000
   - autoOpen=60 → ttlMs = 60000 + 30000 = 90000
   - autoOpen=300 → ttlMs = 300000 + 30000 = 330000
   - autoOpen=600 → ttlMs = 600000 + 30000 = 630000

4. **`expiresAtMs = autoOpenAtMs + ttlMs` 在接尾场景下的覆盖**
   - drop common@1s (autoOpen=300s) → expiresAtMs = 301000 + 330000 = 631000
   - drop common@2s → expiresAtMs = 601000 + 330000 = 931000
   - drop common@3s → expiresAtMs = 901000 + 330000 = 1231000
   - 断言所有项的 expiresAtMs > autoOpenAtMs，TTL 覆盖到开启后 330s

5. **`dequeue` 串行模型下弹出 head 后剩余项 autoOpenAtMs 不变**
   - 队列 [A@301000, B@601000]
   - dequeue 弹出 A → 剩余 [B@601000]
   - 断言 B.autoOpenAtMs === 601000（不重新计算）

### 7.2 main 集成测试（[autoClassifyService.test.ts](../../../app/test/main/autoClassifyService.test.ts)）

修正受影响用例：

1. **"dequeues the soonest-opening chest first across categories"** ([test:205-228](../../../app/test/main/autoClassifyService.test.ts#L205-L228))
   - rare@1s（autoOpen=600s）→ 601000
   - common@1s（autoOpen=300s）→ 301000
   - 跨类别独立计时器，common 的 autoOpenAtMs 仍 = 301000 < rare 的 601000
   - head 是 common，unclassified burst 匹配 common
   - 断言不变（此用例恰好不暴露 bug）

2. **"groups queued drops by category with head countdown"** ([test:479-501](../../../app/test/main/autoClassifyService.test.ts#L479-L501))
   - drop rare@1s → autoOpenAtMs = 601000
   - drop rare@2s → 串行模型接尾 → autoOpenAtMs = 601000 + 600000 = 1201000
   - head（droppedAtMs=1000）的 nextAutoOpenInMs = 601000 - 10000 = 591000 ✓ 不变
   - tail（droppedAtMs=2000）的 lastAutoOpenInMs = 1201000 - 10000 = 1191000（原断言没检查此项，可补）

3. **"exposes per-item view via items field, sorted by autoOpenInMs ascending"** ([test:551-590](../../../app/test/main/autoClassifyService.test.ts#L551-L590))
   - drop rare@1s → 601000
   - drop common@2s → 302000（common 队列空）
   - drop act@3s → 63000（act 队列空）
   - 排序：act@63000, common@302000, rare@601000
   - 断言不变（跨类别独立计时器场景下与 slot-parallel 一致）

新增用例：

4. **同类别连掉的 autoOpenAtMs 严格递增**
   - drop common@1s → autoOpenAtMs = 1000 + 300000 = 301000（队列空，锚定 droppedAtMs）
   - drop common@2s → autoOpenAtMs = 301000 + 300000 = 601000（接尾）
   - drop common@3s → autoOpenAtMs = 601000 + 300000 = 901000（接尾）
   - 断言队列 `autoOpenAtMs` 严格递增 [301000, 601000, 901000]

5. **`tick` 只检查 head，tail 项不触发 `liveSlots--`**
   - liveSlots 初始化 common=2
   - drop common@1s → liveSlots.common = 3
   - drop common@2s → liveSlots.common = 4（接尾 autoOpenAtMs = 601000）
   - now=302000ms（head@301000 已过，tail@601000 未到）
   - tick → liveSlots.common = 3（仅 head 扣减）
   - now=602000ms（tail@601000 已过）
   - tick → liveSlots.common = 2（tail 扣减，因 tail 此时是 head）

6. **`clearsIn` 在串行模型下的准确性**
   - drop common@1s, common@2s, common@3s
   - now=10000ms
   - head autoOpenInMs = 301000 - 10000 = 291000
   - tail autoOpenInMs (clearsIn) = 901000 - 10000 = 891000
   - 断言 LootQueueSlots 渲染的 clearsIn ≈ 14.85min

### 7.3 手动 QA

1. 开启自动归类 → 游戏内连掉 3 个 common → 检查 Loot 页 `clearsIn` 显示约 15min（autoOpen=300s）而非 5min
2. 开启自动归类 → 等 head 自动开启 → 检查 `liveSlots.common` 仅减 1（而非减 N）
3. 开启自动归类 → 手动开 head → 检查新 head 的 `opensIn` 保持原值（不重置）

## 8. 兼容性

### 8.1 向后兼容

- `QueueItem` 字段不变，序列化兼容（虽然队列不持久化）
- IPC payload 不变（`AutoClassifyStatePayload` 字段不变）
- 配置 `lootAutoClassifyEnabled` 不变
- 用户侧无感知：开关状态、弹窗行为、Loot 页 UI 都不变，仅"倒计时显示更准确"

### 8.2 与 `reconcileWithChestSlots` 的兼容

串行模型下 `autoOpenAtMs` 严格单调递增，`reconcile` 按 `autoOpenAtMs` 升序修剪 excess 仍然正确。无兼容性问题。

### 8.3 与 `WeakSet autoOpenedItems` 的兼容

`autoOpenedItems` 用于 tick/processEvent 双扣防护。重构后 tick 只检查 head，但 head 仍可能先被 tick 标记（autoOpenAtMs 到点）然后被 processEvent dequeue（unclassified burst 到达），所以 WeakSet 仍需要。无兼容性问题。

## 9. 风险与折衷

| 风险 | 缓解 |
|---|---|
| 接尾计算依赖"同类别"判定，`categoryFromBoxKey` 返回 null 时无法接尾 | `findSameCategoryTail` 返回 null 时回退到 `droppedAtMs + autoOpen`（与原 slot-parallel 行为一致），仅影响 unclassified 类别（实践中不会入队） |
| `findSameCategoryTail` 是 O(N) 遍历，队列深度大时性能下降 | 队列深度受 slot 容量限制（common/rare ≤ 6, act ≤ 2），最坏 12 项，O(12) 可忽略 |
| TTL 去掉 2× 后，若 rune 突然升级导致 autoOpen 减少，旧队列项的 TTL 可能不足 | TTL 在入队时计算，rune 升级后新入队项用新 TTL；旧项按旧 TTL 过期，最坏情况是项提前过期被 prune，`reconcile` 会兜底修剪 |
| `tick` 只检查 head，若 head 项的 unclassified burst 丢失（游戏已正确归类），head 会卡在队列中直到 TTL 过期 | TTL 公式 `autoOpen + 30s buffer` 保证 head 在 autoOpen 后 30s 过期，`reconcile` 也会在下次 save 解析时修剪（queue > slots） |
| 跨类别计时器独立，但 `insertSorted` 按全局 `autoOpenAtMs` 排序，head 是全局最早 autoOpenAtMs 的项 | 这是期望行为：unclassified burst 匹配的是"下一个被自动开启的宝箱"，而下一个被开启的就是全局 autoOpenAtMs 最小的 head |

## 10. 范围外（Out of Scope）

- 处理 `FALLBACK_AUTO_OPEN` 与真实 rune 减成不一致问题（首条 save 解析前的精度问题，单独处理）
- 处理 `groupBoxOpenEvents` 2s gap 阈值在手动连开场景下的歧义（成本高，收益低）
- 持久化队列跨 session
- 修改 IPC channel 或 payload 类型
- 修改 `chestDropTracker` / `boxOpenTracker` API

## 11. 实施顺序（供 writing-plans 参考）

1. **core 层重构**：`boxOpenAutoClassify.ts`
   - 修改 `computeTtlMs`（去 2×）
   - 新增 `findSameCategoryTail` 辅助
   - 修改 `enqueue`（接尾计算）
   - 更新文件头注释（slot-parallel → serial queue）
   - 更新 `boxOpenAutoClassify.test.ts` 单元测试

2. **main 层重构**：`AutoClassifyService.ts`
   - 修改 `tick()`（只检查 head）
   - 更新类头注释
   - 更新 `autoClassifyService.test.ts` 集成测试

3. **顺带修复**：`appState.ts` 补全 `getAutoClassifyState` fallback 字段

4. **文档更新**：
   - 本设计文档（已写）
   - 实施计划文档 `docs/superpowers/plans/2026-07-20-serial-queue-model.md`
   - `project_memory.md` 修正 slot-parallel 错误描述

5. **QA 验证**：
   - `pnpm test` 全绿
   - `pnpm typecheck` 无新错误
   - `pnpm lint` 无新警告
   - 手动 QA：连掉 3 个 common → 检查 `clearsIn` 显示约 15min

## 12. 验收标准

- [ ] `boxOpenAutoClassify.test.ts` 新增 5+ 个串行模型测试用例全部通过
- [ ] `autoClassifyService.test.ts` 修正后所有用例通过（包括新增的 tick 只检 head 用例）
- [ ] `pnpm test` 全绿
- [ ] `pnpm typecheck` 无新错误
- [ ] `pnpm lint` 无新警告
- [ ] `project_memory.md` 中 slot-parallel 描述已修正为 serial queue
- [ ] 手动 QA：连掉 3 个 common，`clearsIn` 显示约 15min（autoOpen=300s 时）
- [ ] 手动 QA：head 自动开启后 `liveSlots` 仅减 1
