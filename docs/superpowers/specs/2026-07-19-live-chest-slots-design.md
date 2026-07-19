# Live Chest Slots 实时化设计

**日期**: 2026-07-19
**作者**: TBH Companion
**状态**: 待评审

## 背景与动机

当前 chest 页 slots 数据（`BoxSlotStatus` 的 `quantity` / `capacity` / `isFull`）完全来自 save file 解析，触发频率是 save file mtime 变更（几十秒到几分钟一次）。这导致：

1. **AutoClassifyService 的 reconcile 延迟高**：宝箱被打开后，要等下次 save 写入才能校正队列，期间队列仍显示该 chest 在排队。
2. **LootQueueSlots UI 不实时**：用户手工打开 chest 后，slots 数量不会立即更新，影响开箱节奏判断。
3. **slot-parallel 模型的精度受限**：虽然每个 chest 的 `autoOpenAtMs` 是独立计时，但"宝箱实际被打开"这一事件只能通过 save reconcile 间接推断，无法精确捕获。

## 目标

将 chest slots 的 `quantity` 字段从 save-file 触发（数十秒延迟）改为 live memory 实时读取（秒级延迟，跟随 LiveMemoryService 的 5Hz 广播节流），并让 AutoClassifyService 高频消费该数据持续校正队列。

**非目标**：
- 不 live 化 `capacity`（rune 购买极低频，save 派生已足够准确）
- 不 live 化 `autoOpenSeconds`（rune 减冷却同样低频）
- 不新增 IPC channel（架构约束）

## 现状回顾

### 数据流（save 路径）

```
SaveWatcher (mtime polling, ~1s)
  → readAndDecrypt
  → InventoryService.parseFromSave → parseChests(player)  [core/inventory/parse.ts:195]
       └─ 读 PlayerSaveData.BoxData.BoxTypes[] + BoxQuantity[]
  → ChestService.onSave(text, mtime, chests)
       └─ buildChestState  [core/boxes/resolve.ts]
            ├─ quantity: 按类别聚合 ChestHolding[]
            ├─ capacity: catalog.baseCapacity + runeCapacityBonus(purchases)
            └─ isFull: quantity >= capacity
  → reconcile() → onReconcile(slots) → AutoClassifyService.reconcileWithChestSlots
  → broadcast(IPC.CHESTS, lastChests)
```

### Live memory 现状

- `LiveMemorySnapshot` 中 chest 相关字段只有 `chestDrops`（GetBoxLog 掉落事件流），**没有 slot 持有量字段**
- `LiveOffsets` 没有派生 `PlayerSaveData.BoxData` 或 chest/box manager 单例的 offset
- `readRuntimeChestLog`（runtime.ts:624）只读新增的 GetBoxLog 事件，不读当前 slot 持有量
- `il2cppScanner` 已有 `findPlayerSaveData`（识别含 `PetSaveData` / `itemSaveDatas` 字段的静态类），可作为识别 BoxData 的参考模式

## 设计

### 架构总览

```
LiveMemoryWorker (25Hz)
  └─ readRuntimeChestSlots()                     [新核心函数]
       └─ 通过 PlayerSaveData.BoxData 读 BoxTypes[] + BoxQuantity[]
       └─ 按 catalog.boxTypeIndex 聚合到 common/rare/act
  → LiveMemorySnapshot.chestSlots                [新字段]
       { common: number, rare: number, act: number, status: string }

LiveMemoryService (5Hz broadcast)
  → IPC.LIVE_MEMORY → renderer
       ├─ useLiveMemory.chestSlots               [renderer 端合并]
       └─ appState.onLiveMemory(snapshot)
            └─ AutoClassifyService.reconcileWithChestSlots(liveSlots)  [高频]

SaveWatcher (mtime 变更, 低频)
  → ChestService.onSave                          [保留]
       └─ resolveAndPush (capacity 派生 + rune 计算)
            └─ reconcileWithChestSlots(saveSlots)  [低频备份, capacity 在此更新]
```

### 数据源路径选择：PlayerSaveData.BoxData runtime offset

**决策**：通过 `PlayerSaveData.BoxData` 字段读 runtime 等价的 `BoxTypes[]` + `BoxQuantity[]`。

**理由**：
- 字段结构与 save file 一致（`BoxTypes` / `BoxQuantity` 是 ES3 序列化字段名，runtime 也用同样的类）
- 复用现有的 `findPlayerSaveData` 扫描器作为入口（已识别 `commonSaveData` 静态类 + `playerPtr`）
- v1.00.28+ 字段混淆风险低：ES3 序列化字段名必须稳定（否则 save 互操作失败），runtime 类的字段名通常也保持
- 不需要识别独立的 ChestManager 单例（混淆风险高、扫描复杂度大）

**不选 ChestManager 单例扫描的原因**：
- project_memory 中提到的 BoxQueue/RewardQueue 类名匹配策略在代码中零实现，从未落地
- 类名可能被混淆（参考 BoxOpenLog 的 `bfne/bfnf/bfng` 教训）
- 即使识别成功，runtime 状态可能包含正在打开的 chest 进度等额外字段，与 save 路径语义不一致，导致两条路径的 quantity 字段定义漂移

### 1. LiveOffsets 扩展

在 `LiveOffsets.player` 中新增 `boxData` 字段 offset：

```typescript
// app/src/core/liveMemory/offsets.ts
player: {
  commonSaveData: number;
  currency: number;
  heroSaveDatas: number;
  petSaveDatas: number;
  itemSaveDatas: number;
  aggregates: number;
  /** PlayerSaveData.BoxData — BoxData 实例字段 offset。0 = 未派生。 */
  boxData: number;
};

// 新增 BoxData struct offsets
boxData: {
  /** BoxData.BoxTypes — List<int> 或 int[] 的字段 offset。0 = 未派生。 */
  boxTypes: number;
  /** BoxData.BoxQuantity — List<int> 或 int[] 的字段 offset。0 = 未派生。 */
  boxQuantity: number;
};
```

**派生方式**：在 `il2cppScanner.findPlayerSaveData` 中扩展，识别到 player 对象后额外尝试读 `BoxData` 字段：
- 优先按字段名 `BoxData` 查 `instanceClassFields`
- 失败则结构签名 fallback：在 player 对象上扫描 0x10-0x80 范围内指向"含两个 List<int> 字段的对象"的指针

`findBoxDataFields`：在 BoxData 对象上识别 `BoxTypes` 和 `BoxQuantity`：
- 优先按字段名匹配（`BoxTypes` / `BoxQuantity`）
- 失败则结构签名 fallback：找两个连续的 `List<int>` 字段，size 合理（1-20，chest 类别数有限）

### 2. readRuntimeChestSlots 核心函数

在 `app/src/core/liveMemory/runtime.ts` 新增：

```typescript
export interface ReadChestSlotsResult {
  /** Per-category slot quantity. null = unavailable this tick. */
  slots: { common: number; rare: number; act: number } | null;
  /** Diagnostics: why slots is null. */
  status: string;
}

export function readRuntimeChestSlots(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  boxTypeCatalog: ReadonlyMap<number, BoxCategory>,
  playerPtrOverride?: bigint | null,
): ReadChestSlotsResult {
  // 1. 校验 offset
  if (o.player.boxData === 0) return { slots: null, status: "player.boxData offset = 0" };
  if (o.boxData.boxTypes === 0 || o.boxData.boxQuantity === 0) {
    return { slots: null, status: "boxData struct offsets not derived" };
  }

  // 2. 读 playerPtr（复用 readRuntimeInventory 的同款逻辑）
  const playerPtr = playerPtrOverride ?? readStaticFieldPtr(...);
  if (playerPtr == null) return { slots: null, status: "PlayerSaveData unreadable" };

  // 3. 读 BoxData 对象指针
  const boxDataPtr = readPtr(reader, playerPtr + BigInt(o.player.boxData));
  if (boxDataPtr == null) return { slots: null, status: "BoxData pointer null" };

  // 4. 读 BoxTypes[] 和 BoxQuantity[]（List<int> 或 int[]，统一处理）
  const types = readIntArray(reader, boxDataPtr, o.boxData.boxTypes, o.container);
  const quantities = readIntArray(reader, boxDataPtr, o.boxData.boxQuantity, o.container);
  if (types == null || quantities == null) {
    return { slots: null, status: "BoxTypes/BoxQuantity array unreadable" };
  }
  if (types.length !== quantities.length) {
    return { slots: null, status: `length mismatch: types=${types.length} qty=${quantities.length}` };
  }

  // 5. 按 catalog.boxTypeIndex 聚合到 common/rare/act
  const slots = { common: 0, rare: 0, act: 0 };
  for (let i = 0; i < types.length; i++) {
    const category = boxTypeCatalog.get(types[i]!);
    if (category == null || category === "unclassified") continue;
    slots[category] += quantities[i]!;
  }
  return { slots, status: "" };
}
```

**`readIntArray` 辅助函数**：处理 `List<int>`（`_items` 数组 + `_size`）和 `int[]`（直接数组）两种情况。先按 List 路径读，若 `listPtr` 的 klass 不是 List 则按 int[] 直接读。

**`boxTypeCatalog` 参数**：复用 `core/boxes/catalog.ts` 的 `loadBoxTypeCatalog()`，返回 `Map<number, BoxCategory>`。LiveMemoryService 在初始化时构造一次并传入 worker。

### 3. LiveMemorySnapshot 扩展

```typescript
// app/shared/types.ts
export interface LiveChestSlots {
  common: number;
  rare: number;
  act: number;
}

export interface LiveMemorySnapshot {
  // ... 现有字段 ...

  /**
   * Live chest slot 持有数量（每类当前 chest 数）。从 PlayerSaveData.BoxData
   * runtime 读取，5Hz 广播。`null` = live 不可用，renderer 回退到
   * useChests 的 save 路径 quantity。
   */
  chestSlots: LiveChestSlots | null;
  /** Diagnostics: why chestSlots is null this tick. Dev-only. */
  chestSlotsStatus?: string;
}
```

### 4. LiveMemoryService 集成

在 LiveMemoryService 的 worker 消息处理中扩展，把 `readRuntimeChestSlots` 的结果合并到 snapshot。具体集成点在 worker 进程的 snapshot 构造代码（参考现有 `readRuntimeInventory` / `readRuntimePets` 的调用模式）。

**worker 端构造 snapshot 时新增调用**：
```typescript
const chestSlotsResult = readRuntimeChestSlots(reader, gaBase, gaSize, o, boxTypeCatalog, playerPtr);
snapshot.chestSlots = chestSlotsResult.slots;
if (chestSlotsResult.slots == null) snapshot.chestSlotsStatus = chestSlotsResult.status;
```

**性能**：单次读 ~2 次指针解引用 + 2 个小数组（typically 3-7 个 chest 类型）扫一遍，远小于现有 inventory/pets 读路径的成本。25Hz tick 下 CPU 开销可忽略。

### 5. AutoClassifyService 高频 reconcile 集成

在 `appState.ts` 中，新增 live memory snapshot 接收回调：

```typescript
// 现有：chests.setOnReconcile((slots) => autoClassifyRef.reconcileWithChestSlots(slots));
// 新增：live snapshot 到达时也 reconcile
tracking.setOnLiveChestSlots((slots) => autoClassifyRef.reconcileWithChestSlots(slots));
```

`TrackingService.setOnLiveChestSlots` 在每次 `onLiveMemory` snapshot 到达且 `snapshot.chestSlots != null` 时调用。

**`reconcileWithChestSlots` 内部新增变化检测，避免日志爆炸**：

```typescript
// AutoClassifyService 新增字段
private lastSlotCounts: { common: number; rare: number; act: number } | null = null;

reconcileWithChestSlots(slots: { common: number; rare: number; act: number }): void {
  if (!this.enabled) return;

  // 变化检测：仅在某类 slot 数变化时打日志
  const changed = this.lastSlotCounts == null
    || this.lastSlotCounts.common !== slots.common
    || this.lastSlotCounts.rare !== slots.rare
    || this.lastSlotCounts.act !== slots.act;
  this.lastSlotCounts = { ...slots };

  // ... 现有 prune 逻辑（不变）...

  if (prunedTotal > 0 && changed) {
    log.info(`reconcile: total pruned ${prunedTotal} item(s) across categories`);
  }
}
```

**save 路径 reconcile 保留**：ChestService 的 `setOnReconcile` 不变，仍每次 save parse 时调用。save 路径主要更新 `capacity` / `autoOpenSeconds`（通过 `ChestState` 广播），reconcile 是附带行为。

### 6. Renderer 端合并

在 `LootQueueSlots.tsx` 中，优先用 live slots 的 quantity，capacity 仍来自 `useChests`：

```typescript
// useLoot.ts 新增 live chest slots 状态
const liveChestSlots = useLiveMemory()?.chestSlots ?? null;

// Loot.tsx 传入
<LootQueueSlots
  queue={autoClassifyState}
  chests={chests}            // save 路径（capacity 权威）
  liveChestSlots={liveChestSlots}  // live 路径（quantity 优先）
  dropsPerHour={dropsPerHour}
/>

// LootQueueSlots.tsx 内部
const quantity = liveChestSlots?.[row.queueCategory] ?? slot?.quantity ?? 0;
```

**fallback 行为**：
- `liveChestSlots == null`（live 不可用）→ 用 save 的 `slot.quantity`
- `liveChestSlots != null`（live 可用）→ 用 live 的数值，capacity 仍来自 save

### 7. offset 派生与自愈

**bundled offset 表**：在 `app/src/core/liveMemory/offsets.ts` 的版本化表中，给已知游戏版本（v1.00.21 / .23 / .27 / .28）填入实测的 `player.boxData` + `boxData.boxTypes` + `boxData.boxQuantity`。

**runtime 自愈**：扩展 `findPlayerSaveData` 在识别 player 对象后，附带尝试派生 `boxData` offset：
1. 按字段名 `BoxData` 在 `instanceClassFields` 中查找
2. 失败则扫描 player 对象 0x10-0x80 范围内的指针，找到指向"含两个连续 List<int> 字段"的对象
3. 验证：两个 List 的 size 相等且在 1-20 范围内

**BoxData 内部字段派生**：
1. 按字段名 `BoxTypes` / `BoxQuantity` 查找
2. 失败则结构签名 fallback：找两个连续的 List<int> 字段，验证 size 相等且元素数 ≤ 20

### 8. 测试策略

#### Core 层（pure unit tests）

- `readRuntimeChestSlots`：mock MemoryReader，覆盖：
  - offset 未派生（`player.boxData = 0`）→ 返回 null + status
  - playerPtr null → 返回 null + status
  - BoxData 指针 null → 返回 null + status
  - BoxTypes/BoxQuantity 长度不匹配 → 返回 null + status
  - 正常路径：3 个 chest 类型映射到 common/rare/act，quantity 正确聚合
  - 未知 boxType（不在 catalog）→ 跳过，不影响其他类别
  - List<int> vs int[] 两种容器路径

- `il2cppScanner.findBoxDataOffsets`（新函数）：
  - 命名匹配路径
  - 结构签名 fallback 路径
  - 验证失败（size 不匹配 / 超过 MAX）→ 返回 null

#### Main 层（service tests）

- `AutoClassifyService` 高频 reconcile：
  - 连续两次相同 slots → 不重复打日志（lastSlotCounts 抑制）
  - slots 减少 → 剪枝对应数量的 queue 项
  - slots 增加 → 不剪枝，仅更新 lastSlotCounts
  - slots == null（live 不可用）→ 不调用 reconcile，queue 不变

- `TrackingService.onLiveMemory`：
  - snapshot.chestSlots != null → 调用 onLiveChestSlots
  - snapshot.chestSlots == null → 不调用 onLiveChestSlots
  - 不影响其他 live 字段处理

#### Renderer 层（component tests）

- `LootQueueSlots` 合并行为：
  - liveChestSlots != null → 显示 live quantity
  - liveChestSlots == null → 显示 save quantity
  - capacity 始终来自 save
  - isFull 用 live quantity vs save capacity 计算

#### 集成测试

- 启动 live memory worker → chestSlots 在 5Hz snapshot 中可见
- offset 未派生时 → chestSlots = null + status，renderer 回退到 save

### 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| BoxData runtime offset 在新版本漂移 | 自愈扫描器 + 结构签名 fallback；offset = 0 时安全回退到 save 路径 |
| BoxTypes/BoxQuantity 字段被混淆 | ES3 序列化字段名必须稳定（save 互操作约束），混淆风险低；fallback 用结构签名 |
| 高频 reconcile 日志爆炸 | lastSlotCounts 变化检测，仅数值变化时打日志 |
| live 与 save quantity 短暂不一致（race） | 容忍：reconcile 是幂等的，最终一致；UI 显示优先 live |
| worker 进程内存增长 | readRuntimeChestSlots 不持有任何状态，纯函数；无缓存 |
| catalog 未加载时 boxType 映射失败 | boxTypeCatalog.get 返回 undefined → 跳过该项，slots 全为 0；不影响其他路径 |

### 10. 实现顺序

按依赖顺序分阶段实现，每阶段独立可测：

1. **Phase 1 - Core 层基础**（无外部依赖）
   - 扩展 `LiveOffsets` 类型加 `player.boxData` + `boxData` struct
   - 实现 `readRuntimeChestSlots` 函数 + `readIntArray` 辅助
   - 单元测试覆盖所有分支

2. **Phase 2 - Scanner 扩展**（依赖 Phase 1）
   - 扩展 `findPlayerSaveData` 派生 `boxData` offset
   - 新增 `findBoxDataFields` 函数
   - 单元测试覆盖命名匹配和结构签名 fallback

3. **Phase 3 - Snapshot 集成**（依赖 Phase 1-2）
   - 扩展 `LiveMemorySnapshot` 类型加 `chestSlots` + `chestSlotsStatus`
   - LiveMemoryService worker 调用 `readRuntimeChestSlots` 填充 snapshot
   - 集成测试：offset 已派生时 chestSlots 非 null

4. **Phase 4 - AutoClassify 高频 reconcile**（依赖 Phase 3）
   - `AutoClassifyService.reconcileWithChestSlots` 加 lastSlotCounts 变化检测
   - `TrackingService` 新增 `setOnLiveChestSlots` 回调
   - `appState` 连接 live snapshot → reconcile
   - 单元测试覆盖高频场景

5. **Phase 5 - Renderer 合并**（依赖 Phase 3-4）
   - `useLoot` 暴露 `liveChestSlots`
   - `LootQueueSlots` 合并 live quantity + save capacity
   - 组件测试覆盖 fallback 行为

6. **Phase 6 - Offset 表填充与端到端验证**
   - 在 bundled offset 表中填入实测值（需要游戏运行时调试）
   - 端到端验证：开箱后 5 秒内 slots 数量更新
   - 验证 AutoClassify queue 在 slots 减少后 5 秒内剪枝

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 数据源路径 | PlayerSaveData.BoxData runtime offset | 字段稳定（ES3 序列化约束）、复用现有 player scan、混淆风险低 |
| capacity 来源 | 保留 save 派生 | rune 购买极低频，save 已正确；避免 runtime 重复实现 rune 计算 |
| Live 失败回退 | 跳过本次 reconcile | save 路径会独立触发，不需要重复；queue 保持原状态直到下次有效 live 或 save |
| IPC channel | 扩展 LiveMemorySnapshot | 架构约束禁止新增 channel；chestSlots 自然属于 live memory 数据流 |
| Renderer 合并策略 | live quantity + save capacity | 各取所长：live 秒级更新 quantity，save 提供 capacity 上下文 |
| 高频 reconcile 日志 | lastSlotCounts 变化检测 | 避免 5Hz 日志爆炸，参考 BoxQueue status log 抑制策略 |

## 验收标准

1. **功能正确性**：
   - offset 已派生时，`LiveMemorySnapshot.chestSlots` 在每个 5Hz snapshot 中非 null
   - 数值与 save file 解析的 quantity 一致（同一时刻对比，允许短暂 race）
   - offset 未派生时，`chestSlots` 为 null，renderer 回退到 save 路径，UI 不报错

2. **AutoClassify 行为**：
   - live slots 减少时，5 秒内 AutoClassify queue 剪枝对应数量的 excess 项
   - live slots 不变时，不重复打 reconcile 日志
   - live 不可用时，queue 保持 save 路径的低频 reconcile 行为

3. **性能**：
   - worker tick 增加 < 1ms（readRuntimeChestSlots 单次成本）
   - 无内存泄漏（纯函数，无状态）

4. **测试覆盖**：
   - Core 层 `readRuntimeChestSlots` 单元测试 100% 分支覆盖
   - Scanner `findBoxDataFields` 单元测试覆盖命名 + 结构签名路径
   - AutoClassifyService 高频 reconcile 测试覆盖变化检测
   - Renderer 合并测试覆盖 live/save fallback

5. **回归**：
   - `pnpm typecheck` 0 errors
   - `pnpm lint` 0 errors（允许 pre-existing warnings）
   - `pnpm test` 无新失败
   - `pnpm test:dom` 无新失败

## 参考文件

- 现状调研：本对话上一轮的 chest slots 数据来源调研
- Save 路径：`app/src/main/services/ChestService.ts`、`app/src/core/boxes/resolve.ts`、`app/src/core/inventory/parse.ts:195`
- Live memory 基础设施：`app/src/core/liveMemory/offsets.ts`、`app/src/core/liveMemory/runtime.ts`、`app/src/core/liveMemory/il2cppScanner.ts`、`app/src/main/services/LiveMemoryService.ts`
- AutoClassify 集成：`app/src/main/services/AutoClassifyService.ts`、`app/src/main/app/appState.ts:214`
- Renderer：`app/src/renderer/components/loot/LootQueueSlots.tsx`、`app/src/renderer/lib/useLoot.ts`、`app/src/renderer/lib/useChests.ts`
- 架构约束：`AGENTS.md` 四层架构、`project_memory.md` Hard Constraints
