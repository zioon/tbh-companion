# 宝箱掉落-开箱自动归类设计

- 日期: 2026-07-17
- 状态: 设计待审阅
- 作者: pair (user + assistant)
- 关联: [chest-code-audit-2026-07-17.md](../../findings/chest-code-audit-2026-07-17.md), [loot-audit-2026-07-17.md](../../findings/loot-audit-2026-07-17.md)

## 1. 背景与目标

### 1.1 问题

当前宝箱链路有两条独立追踪:

- `chestDropTracker`: 记录"宝箱掉落事件" (boss 死亡掉出宝箱本身), 只有 `category` (common/rare), 无物品
- `boxOpenTracker`: 记录"宝箱被打开后产出什么物品", 从 `BoxOpenLog` 读 `boxType` + `level`

两条链路完全独立. 当 `BoxOpenLog` 的 `boxType` / `level` 字段读不出来 (v1.00.28 字段混淆 / 偏移未推导 / 读到 0) 时, 物品被记到 `unclassified` 分区, 玩家需手动在 Loot 页用 "Assign to" UI 重分类. 战斗中频繁手动操作体验差.

### 1.2 目标

1. **自动归类**: 开关开启后, `chestDrop` 事件入队, 后续 `boxOpen` 事件按 FIFO 队列匹配, 自动把物品 `reclassifyItem` 到对应 `boxKey`
2. **失败兜底弹窗**: 自动归类失败 (队列空 / 短时间多宝箱歧义) 时弹窗, 让用户一键选 `category` (Common / Stage Boss / Act Boss), `level` 由 `stageKey` 推断
3. **手动模式**: 开关关闭时退回现有行为 (物品进 unclassified, 玩家在 Loot 页手动 Assign), 不破坏现状
4. **动态 TTL**: 队列项 TTL 基于符文减免后的实际 auto-open 冷却时长, 不硬编码

### 1.3 非目标

- 不点击游戏窗口, 不注入任何输入 (严守 AGENTS.md 只读约束)
- 不持久化队列 (session 级内存, 重启清空)
- 不修改 `chestDropTracker` / `boxOpenTracker` 已有 API (向后兼容)
- 不处理历史残留 `unclassified` 物品 (用户可在 Loot 页手动 Assign)

## 2. 现状评估 (已就绪的基础设施)

| 能力 | 位置 | 状态 |
|---|---|---|
| 实际 auto-open 秒数 | [ChestState.autoOpen](../../../app/shared/types.ts#L672) `{common, stageBoss, actBoss}` | ✅ 已 broadcast |
| 计算 | [runes.ts:76 `effectiveAutoOpenSeconds`](../../../app/src/core/boxes/runes.ts#L76) | ✅ |
| stage → boxId 推断 | [stageBoxTracker.ts:99 `resolveTrackedDropBoxIdForStage`](../../../app/src/core/stageBoxTracker.ts#L99) | ✅ |
| boxType+level → boxKey | [boxOpenLog.ts:27 `resolveBoxKey`](../../../app/src/core/boxOpenLog.ts#L27) | ✅ |
| 重分类 | [boxOpenTracker.ts:235 `reclassifyItem`](../../../app/src/core/boxOpenTracker.ts#L235) | ✅ |
| level 推断 (UI) | [LootBoxSection.tsx:62 `useChestLevelDefaults`](../../../app/src/renderer/components/loot/LootBoxSection.tsx#L62) | ✅ (需抽到 core 复用) |
| chestDrop 事件 | `chestDropTracker.recordLogDrop` / `recordLiveChestDrop` 内部, 无外部订阅 API | ❌ 需新增订阅接口 |
| boxOpen unclassified 事件 | `boxOpenTracker.recordOpen` 内部, 无外部订阅 API | ❌ 需新增订阅接口 |

## 3. 架构设计

遵循 [AGENTS.md](../../../AGENTS.md) 四层架构, 新增模块分布如下:

```
shared/         ipc.ts                          新增 3 个 IPC 通道常量
                types.ts                         新增 ClassifyPromptPayload / AutoClassifyConfig

core/           boxOpenAutoClassify.ts           新增: AutoClassifyQueue + groupBoxOpenEvents 纯函数
                boxOpenTracker.ts                扩展: onUnclassified callback hook
                chestDropTracker.ts              扩展: onDrop callback hook
                stageBoxTracker.ts               扩展: 抽 useChestLevelDefaults 推断逻辑到 core

main/           services/AutoClassifyService.ts  新增: 编排 service
                services/TrackingService.ts      注入 AutoClassifyService (订阅 + 触发 reclassify)
                services/ChestService.ts         暴露 getAutoOpenSeconds() getter
                appState.ts                      生命周期绑定
                ipc/registerIpc.ts               注册 3 个新通道
                ipc/handlers/loot.ts             toggle handler

preload/        index.ts                         暴露 window.tbh.loot.autoClassifyEnabled / onClassifyPrompt

renderer/       components/loot/ClassifyPromptDialog.tsx  新增: 弹窗组件
                components/loot/LootBoxSection.tsx        复用 useChestLevelDefaults
                tabs/Loot.tsx                            顶部 toggle 开关
                context/TbhProvider.tsx                  监听 LOOT_PROMPT_CLASSIFY 显示弹窗
                lib/useLoot.ts                           toggleAutoClassify / resolvePrompt
```

### 3.1 数据流

```
[chestDrop 事件]
  chestDropTracker.recordLogDrop(itemKey, wallTime)
    └─ onDrop callback → AutoClassifyService.handleChestDrop
          ├─ resolveStageBoxDrop(itemKey) → boxId
          ├─ resolveBoxKey(boxType, level) → boxKey (或 fallback: stage → boxId → boxKey)
          ├─ TTL = max(autoOpen[category] × 2, 60) + 30
          └─ queue.enqueue({ boxKey, droppedAtMs, stageKey, expiresAtMs })

[boxOpen 事件]
  boxOpenTracker.recordOpen(boxKey, itemKey, ...)
    └─ 若 boxKey === "unclassified":
        onUnclassified callback → AutoClassifyService.handleUnclassifiedBatch
          ├─ groupBoxOpenEvents(entries, gapMs=2000) → 开箱事件数组
          └─ 每个事件:
               ├─ queue.dequeue() → 队首项 { boxKey }
               │   ├─ 命中: boxOpenTracker.reclassifyItem("unclassified", itemKey, matchedBoxKey)
               │   └─ 队列空: broadcast LOOT_PROMPT_CLASSIFY { itemKeys, defaultBoxKey? }
               │                 → renderer 弹窗 → 用户选 category
               │                 → LOOT_PROMPT_RESOLVE { category, itemKeys }
               │                 → AutoClassifyService.resolvePrompt
               │                   ├─ level = inferLevelFromStage(currentStageKey)
               │                   ├─ boxKey = `${category}:${level}` (或仅 category)
               │                   └─ boxOpenTracker.reclassifyItem("unclassified", itemKey, boxKey)

[开关切换]
  Loot.tsx toggle → LOOT_AUTO_CLASSIFY_TOGGLE
    └─ AutoClassifyService.setEnabled(bool)
          ├─ false: queue.clear() + 关闭订阅
          └─ true: 重新订阅 + 接受后续事件 (不回填历史)
```

### 3.2 模块边界

#### `core/boxOpenAutoClassify.ts` (纯函数, 可单测)

```typescript
// 队列项
interface QueueItem {
  boxKey: string;        // "common" / "rare:3" / "act:2" 等
  droppedAtMs: number;
  stageKey: number;
  expiresAtMs: number;
}

// 入队参数
interface EnqueueInput {
  boxKey: string;
  droppedAtMs: number;
  stageKey: number;
  autoOpenSeconds: number;  // 该 category 的实际 auto-open 秒数
}

// 计算动态 TTL
export function computeTtlMs(autoOpenSeconds: number): number;

// 队列 (不可变操作, 返回新数组)
export function enqueue(queue: QueueItem[], input: EnqueueInput): QueueItem[];
export function dequeue(queue: QueueItem[], nowMs: number): { queue: QueueItem[]; item: QueueItem | null };
export function pruneExpired(queue: QueueItem[], nowMs: number): QueueItem[];

// BoxOpen 事件聚合
interface BoxOpenEntryLike { itemKey: number; wallTime: number; }
interface BoxOpenEvent { itemKeys: number[]; startMs: number; endMs: number; }

export function groupBoxOpenEvents(
  entries: BoxOpenEntryLike[],
  gapMs?: number,  // default 2000
): BoxOpenEvent[];
```

**为什么放 core**: 队列操作和事件聚合是纯函数, 无 Electron/React 依赖, 可 Vitest 覆盖 FIFO/TTL/聚合边界. 符合 [docs/agent/layers/CORE.md](../../agent/layers/CORE.md) "Pure domain logic".

#### `core/boxOpenTracker.ts` 扩展 (向后兼容)

```typescript
// 新增可选回调 (构造或 setter 注入)
export interface BoxOpenTrackerCallbacks {
  onUnclassified?: (entries: readonly BoxOpenHistoryEntry[]) => void;
}

// 在 recordOpen 内部, 若 boxKey === UNCLASSIFIED_BOX_KEY 且 callbacks.onUnclassified 已设置:
//   累积本次 recordOpen 调用涉及的所有 entry (含同 tick 多次 recordOpen), 用 microtask flush
//   聚合后回调, 避免高频调用
```

注: 不修改 `recordOpen` 签名, 老调用方不受影响.

#### `core/chestDropTracker.ts` 扩展 (向后兼容)

```typescript
export interface ChestDropTrackerCallbacks {
  onDrop?: (event: { category: ChestDropCategory; wallTime: number; itemKey?: number; stageKey?: number }) => void;
}

// 在 recordLogDrop / recordLiveChestDrop 内部触发 onDrop
```

#### `core/stageBoxTracker.ts` 扩展

抽取 `useChestLevelDefaults` 的核心推断逻辑:

```typescript
// 输入: catalog (BoxTimerCatalogEntry[]) + currentStageKey
// 输出: { level: number | null } 或 null (无可用 catalog)
export function inferLevelFromStage(
  catalog: ReadonlyArray<{ level: number; farmStageOptions: number[] }>,
  currentStageKey: number,
): number | null;
```

renderer 的 `useChestLevelDefaults` 改为薄封装调用此函数.

#### `main/services/AutoClassifyService.ts` (编排)

```typescript
export class AutoClassifyService {
  constructor(deps: {
    chestDropTracker: ChestDropTracker;
    boxOpenTracker: BoxOpenTracker;
    chestService: { getAutoOpenSeconds(): ChestState['autoOpen'] };
    stageBoxCatalog: () => ReadonlyArray<BoxTimerCatalogEntry>;
    getCurrentStageKey: () => number | null;
    broadcast: (channel: string, payload: unknown) => void;
  });

  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;

  // 由 TrackingService 在 chestDrop 事件触发时调用 (或通过 callback 自动触发)
  handleChestDrop(event: ChestDropEvent): void;

  // 由 TrackingService 在 boxOpen unclassified 批次触发时调用
  handleUnclassifiedBatch(entries: readonly BoxOpenHistoryEntry[]): void;

  // renderer 弹窗回传
  resolvePrompt(payload: { category: BoxCategory; itemKeys: number[] }): void;

  // 1Hz tick (与 BoxTimerService 同模式, 引用计数)
  startTick(): void;
  stopTick(): void;
}
```

**生命周期**: `appState.ts` 在 startTracking 时构造, stopTracking 时 dispose (clear 队列 + 解除订阅). 开关状态从 config 读取并持久化 (config 新字段 `lootAutoClassifyEnabled: boolean`, 默认 false).

#### 弹窗触发策略

`AutoClassifyService` 内部维护 "pending prompt" 状态:
- 触发 `LOOT_PROMPT_CLASSIFY` 时记录 pending = { itemKeys, defaultBoxKey? }
- 用户回传 `LOOT_PROMPT_RESOLVE` 后清空 pending
- pending 期间若有新 unclassified 批次, **累积到 pending.itemKeys** 不重复弹窗 (避免战斗中弹窗轰炸)
- pending 超时 (60s) 未回传, 自动清空 pending 并把 itemKeys 留在 unclassified (用户后续可在 Loot 页处理)

#### `renderer/components/loot/ClassifyPromptDialog.tsx`

- 模态 Dialog (复用 [design-system](../../agent/layers/DESIGN-SYSTEM.md) 现有 Dialog 组件)
- 三大按钮: Common / Stage Boss / Act Boss (带图标 + 颜色)
- 显示待归类物品数量 + 物品名列表 (前 5 个 + "等 N 件")
- 关闭按钮: 关闭弹窗, 物品留 unclassified, 提示"可在 Loot 页 Assign to 调整 level"
- 不显示 level 选择 (用户答 Q4: 只选 category, 需改 level 去 Loot 页)

#### `renderer/tabs/Loot.tsx` 顶部 toggle

- 复用现有 Switch 组件 (与 Live.tsx autoOpenEnabled toggle 一致)
- Label: "Auto-classify loot"
- Tooltip: "When on, dropped chests are queued and matched to opened loot automatically. Off: manual assign only."
- 默认 off

## 4. IPC 设计

[shared/ipc.ts](../../../app/shared/ipc.ts) 新增:

```typescript
// main → renderer: 触发弹窗
LOOT_PROMPT_CLASSIFY: "loot:prompt:classify",
// renderer → main: 弹窗回传
LOOT_PROMPT_RESOLVE: "loot:prompt:resolve",
// renderer → main: 切换开关
LOOT_AUTO_CLASSIFY_TOGGLE: "loot:auto-classify:toggle",
```

Payload 类型 ([shared/types.ts](../../../app/shared/types.ts) 新增):

```typescript
export interface ClassifyPromptPayload {
  itemKeys: number[];
  defaultCategory?: BoxCategory;  // 若队列有项但匹配失败, 给出建议
  promptId: number;               // 自增 id, 用于 resolve 时关联
}

export interface ClassifyPromptResolvePayload {
  promptId: number;
  category: BoxCategory;  // "common" | "rare" | "act"
  itemKeys: number[];
}
```

[main/ipc/registerIpc.ts](../../../app/src/main/ipc/registerIpc.ts) 注册 handler, [preload/index.ts](../../../app/src/preload/index.ts) 暴露:

```typescript
window.tbh.loot = {
  ...existing,
  toggleAutoClassify: (enabled: boolean) => ipcRenderer.send(IPC.LOOT_AUTO_CLASSIFY_TOGGLE, enabled),
  onClassifyPrompt: (cb: (payload: ClassifyPromptPayload) => void) => ...,
  resolveClassifyPrompt: (payload: ClassifyPromptResolvePayload) => ipcRenderer.send(IPC.LOOT_PROMPT_RESOLVE, payload),
};
```

## 5. 关键算法

### 5.1 动态 TTL

```
TTL(category) = max(autoOpen[category] × 2, 60) + 30
```

- `× 2`: 玩家掉宝箱后可能等一个完整 auto-open 周期; 队列项可能在周期任意时刻入队, 留 2 倍余量
- `+ 30s`: BoxOpenLog 读取延迟 + burst 聚合窗口
- `min 60s`: 防止符文把 autoOpen 减到 0 后队列项瞬间过期

举例:

| Category | autoOpen (s) | TTL (s) |
|---|---|---|
| common 满级减免 | 0 | 90 |
| common 无符文 | 300 | 630 |
| stage boss 无符文 | 600 | 1230 |
| act boss 无符文 | 60 | 150 |

### 5.2 BoxOpen 事件聚合

```
groupBoxOpenEvents(entries, gapMs=2000):
  按 wallTime 升序排序
  从首条开始累积
  若下一条 wallTime - 当前事件 endMs > gapMs, 闭包, 开始新事件
  返回 BoxOpenEvent[]
```

阈值 2000ms 基于观察: 同一宝箱开出的多物品 BoxOpenLog entry 几乎同帧追加 (reader ~25Hz, 间隔 <40ms); 不同宝箱的 auto-open 至少间隔 60s. 2s gap 足够区分.

### 5.3 FIFO 匹配

```
handleUnclassifiedBatch(entries):
  events = groupBoxOpenEvents(entries)
  for event in events:
    if queue is empty:
      broadcast LOOT_PROMPT_CLASSIFY { itemKeys: event.itemKeys, promptId: nextId() }
      pending.itemKeys.push(...event.itemKeys)
    else:
      item = queue.dequeue(now)
      for itemKey in event.itemKeys:
        boxOpenTracker.reclassifyItem("unclassified", itemKey, item.boxKey)
```

注意: 即使队列项 boxKey 与"实际开箱宝箱"不符 (如玩家掉 rare:3 但实际开的是 common), 仍按 FIFO 匹配. 这是已知折衷, 用户可在 Loot 页事后修正. 不做"boxKey 一致性校验"因为 boxOpen 的 boxType 本来就读不出来 (否则不会进 unclassified).

### 5.4 stage → level 推断 (弹窗 resolve 时)

```
inferLevelFromStage(catalog, stageKey):
  # 复用 resolveTrackedDropBoxIdForStage 内部逻辑
  matchingEntries = catalog.filter(e => e.farmStageOptions.includes(stageKey))
  if matchingEntries.length > 0:
    return max(matchingEntries.map(e => e.level))  # 取最高 level
  # fallback: catalog 最低 level
  if catalog.length > 0:
    return min(catalog.map(e => e.level))
  return null  # catalog 为空, boxKey 仅 category
```

与 [LootBoxSection.tsx:62 useChestLevelDefaults](../../../app/src/renderer/components/loot/LootBoxSection.tsx#L62) 现有策略一致.

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| `chestDrop` 时 `autoOpen` 值未就绪 (ChestService 未广播过) | TTL 用 fallback 常量 (common=630, rare=1230, act=150) |
| `chestDrop` 时 `stageKey` 读不到 | boxKey 仅 category (如 "rare"), 不带 level; 队列项仍入队 |
| `boxOpen` 事件聚合后所有 itemKey 都已在 boxOpenTracker 中存在 | 仍触发 reclassify, 依赖 boxOpenTracker.reclassifyItem 自身的幂等性 |
| `LOOT_PROMPT_RESOLVE` 的 promptId 与 pending 不符 | 忽略 + log warn |
| pending 超时 (60s) | 清空 pending, itemKeys 留 unclassified, log info |
| 用户在弹窗期间关闭弹窗 (按 Esc) | 视为 resolve 失败, 物品留 unclassified |
| `reclassifyItem` 抛错 (from===to / boxKey 不合法) | log error, 不影响其他 itemKey |

## 7. 测试策略

### 7.1 core 单测 (Vitest, 必须覆盖)

[boxOpenAutoClassify.test.ts](../../../app/test/core/boxOpenAutoClassify.test.ts) 新增:

- `computeTtlMs`: 边界值 (0 / 300 / 600 / 大数)
- `enqueue` / `dequeue` / `pruneExpired`: FIFO 顺序, TTL 过期, 空队列
- `groupBoxOpenEvents`: 单事件 / 多事件 / 跨 gap 分裂 / 空输入 / 单条输入

[stageBoxTracker.test.ts](../../../app/test/core/stageBoxTracker.test.ts) 新增:

- `inferLevelFromStage`: 命中 farmStageOptions 取最高 / 未命中取最低 / catalog 空返回 null

[boxOpenTracker.test.ts](../../../app/test/core/boxOpenTracker.test.ts) 扩展:

- `onUnclassified` 回调在 boxKey="unclassified" 时触发, batch 聚合
- 非 unclassified boxKey 不触发回调

[chestDropTracker.test.ts](../../../app/test/core/chestDropTracker.test.ts) 扩展:

- `onDrop` 回调在 recordLogDrop / recordLiveChestDrop 时触发

### 7.2 main 集成测 (Vitest, 关键路径)

[autoClassifyService.test.ts](../../../app/test/main/autoClassifyService.test.ts) 新增:

- 开关关闭: 不订阅, 事件不触发任何动作
- 开关开启 + chestDrop + boxOpen: 队列匹配 + reclassifyItem 调用
- 开关开启 + chestDrop + TTL 过期 + boxOpen: 队列空, 触发 prompt
- 开关开启 + 多 chestDrop + 多 boxOpen 事件: FIFO 顺序匹配
- prompt resolve: category 回传 → reclassifyItem 调用
- prompt 超时: 60s 后 pending 清空, 物品留 unclassified
- pending 累积: 多次 unclassified 批次合并到同一 pending

### 7.3 renderer 组件测 (Vitest + DOM)

[ClassifyPromptDialog.test.tsx](../../../app/test/renderer-component/ClassifyPromptDialog.test.tsx) 新增:

- 三按钮渲染
- 点击按钮回调 category
- 关闭按钮回调
- 物品列表渲染 (前 5 + 折叠)

### 7.4 IPC 测 (必跑)

[channels.test.ts](../../../app/test/ipc/channels.test.ts) 扩展:

- 3 个新通道常量存在 + preload 暴露

### 7.5 手动 QA

- 开关开启 → 游戏内掉宝箱 → 等 auto-open → 检查 Loot 页物品归到正确 boxKey 分区
- 开关开启 → 立即开箱 (队列空) → 弹窗出现 → 选 category → 物品归类
- 开关关闭 → 物品进 unclassified, 无弹窗
- 切换开关时无报错
- 长时间运行 (30min+) 队列不内存泄漏

## 8. 配置与持久化

### 8.1 config.json 新字段

[main/config.ts](../../../app/src/main/config.ts) 新增:

```typescript
interface AppConfig {
  // ...existing
  lootAutoClassifyEnabled: boolean;  // 默认 false
}
```

`normalizeConfigFromRaw` 加 sanitize (非布尔值强制转 bool).

### 8.2 不持久化的状态

- 队列 (`AutoClassifyQueue`): session 级内存, 重启清空
- pending prompt: session 级, 重启清空
- 弹窗开关状态: 持久化到 config (用户期望重启后保持偏好)

## 9. 兼容性

- `boxOpenTracker.reclassifyItem` 已有 `from===to` no-op 守卫 (P2-6 修复), 自动调用安全
- `chestDropTracker` / `boxOpenTracker` 现有 API 不变, 新增 callback 为可选
- 默认开关 off, 用户体验与现状一致
- loot-audit N2 (boxKey 校验) 不在本次范围, 但 `AutoClassifyService` 生成的 boxKey 全部来自 catalog/`resolveBoxKey`, 不会引入非法 boxKey

## 10. 风险与折衷

| 风险 | 缓解 |
|---|---|
| FIFO 顺序错配 (玩家不按掉落顺序开箱) | 已知折衷, 用户可在 Loot 页事后修正; 弹窗只选 category 降低了错配后果 |
| 队列 TTL 不准 (符文升级后旧队列项仍用旧 TTL) | TTL 在入队时计算, 符文升级后新入队项用新值; 旧项按旧 TTL 过期, 影响有限 |
| 战斗中弹窗轰炸 | pending 累积策略: pending 期间不重复弹, 60s 超时自动关 |
| AutoClassifyService 与 BoxTimerService 都用 1Hz tick | 引用计数模式可共用, 但本服务只在 enabled 时 startTick, 默认 off 不耗资源 |
| `onUnclassified` 回调在 `boxOpenTracker.recordOpen` 内部调用, 高频触发 | 用 microtask flush 聚合同 tick 多次 recordOpen, 避免高频回调 |

## 11. 范围外 (Out of Scope)

- 修复 loot-audit N1 (useMemo 失效)、N2 (boxKey 校验) 等遗留问题
- 持久化队列跨 session
- 处理历史 unclassified 残留 (用户已可手动 Assign)
- 弹窗内 level 选择 (用户明确选 Q4: 只选 category)
- 复杂匹配策略 (读槽位状态、时间窗+唯一性等)

## 12. 实施顺序 (供 writing-plans 参考)

1. core 层纯函数 + 单测 (`boxOpenAutoClassify.ts`, `stageBoxTracker.inferLevelFromStage`)
2. core 层 callback 扩展 (`boxOpenTracker.onUnclassified`, `chestDropTracker.onDrop`)
3. shared 层 IPC + 类型
4. main 层 `AutoClassifyService` + 集成测
5. main 层 IPC handler + config 扩展
6. preload 暴露
7. renderer 弹窗组件 + Loot toggle + TbhProvider 监听
8. 端到端手测
