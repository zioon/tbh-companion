# 符文减波（Rune of Brevity）解析与修正设计

**日期**: 2026-09-10
**作者**: TBH Companion
**状态**: 待评审

## 背景与动机

游戏的符文系统里有一条"减少关卡波次"的效果链（本地化键 `RuneName_WaveCountReduction` = "Rune of Brevity"，账号统计 `AccountStatName_WaveCountReduction` = "Total Wave Count Reduction"，文案模板 `AccountStat_WaveCountReduction` = "Stage Wave Count -{0}"）。玩家点满后，每个关卡的实际波次会比基础值更少。

伴侣应用里"关卡总波次"（`stats.stageWaveTotal`，即界面上的 `X / N`）**完全来自 live memory**：`readRuntimeStage` 读取游戏运行时 `StageCache → StageInfoData + 0x54`（`waveAmount`）字段，透传给 `buildStats` 与 `TrackingService`，应用自身不做任何计算（详见"现状回顾"）。

因此存在一个功能缺口：**如果游戏运行时 `waveAmount` 未内建减波，应用就会把总波次显示为未修正的基础值**，导致：

1. 悬浮窗/Live 页显示 `X / N` 时 N 偏大，进度条永远到不了 100%。
2. `TrackingService` 的 "wave-total run-end 重置" 判据（`currentWave >= stageWaveTotal`）永不触发，波次计数可能跨局累计显示。

本设计补上"符文减波"的解析与修正。

## 目标

1. 从存档的 `RuneSaveData` 解析已购买的减波符文节点，计算该账号的减波总数 `runeWaveReduction`。
2. 在 live 数据流的单一 choke point 把 `stageWaveTotal` 修正为 `max(1, rawTotal − runeWaveReduction)`，使 **显示（stats）与 run-end 重置判据同时生效**。
3. 保持既有架构：不新增 IPC channel、不改 renderer、不改 live memory 偏移读取。

**非目标**：

- 不处理 `WaveMonsterAmount`（"Rune of Annihilation"，每波怪物数），本次只做**波次数量**减少。
- 不引入游戏静态关卡表（`StageInfoData`）作为基准——见"关键决策"。
- 不新增 UI 展示减波数值（仅日志诊断）。

## 现状回顾

### 总波次的数据流（当前实现，无静态表）

```
LiveMemoryWorker (25Hz)
  → readRuntimeStage()                        [core/liveMemory/runtime.ts:43]
       ├─ StageCacheManager → StageCache → StageInfoData
       ├─ stageKey = StageInfoData + 0x30
       └─ waveTotal = StageInfoData + 0x54    (游戏运行时 waveAmount)
  → LiveMemorySnapshot.stageWaveTotal          [shared/types.ts]
  → TrackingService.ingestLiveFrame(snap)      [main/services/TrackingService.ts:709]
       ├─ this.lastLiveFrame = snap
       ├─ wave-total run-end 重置判据           [TrackingService.ts:939-949]
       │    snap.stageAlive === 0 && currentWave >= snap.stageWaveTotal
       └─ pushStats() → buildStats(this.lastLiveFrame, …)
  → buildStats()                               [main/stats.ts:43]
       ├─ stageWaveTotal = liveFrame.stageWaveTotal   [:127-128]
       └─ reportedWave = min(stageWave, stageWaveTotal)  [:136-137]
  → Stats → renderer（Overlay.tsx:113、Live.tsx:471）
```

存档侧只有 `commonSaveData.currentStageWave`（当前波），**没有总波次字段**（`docs/BUSINESS-FLOWS.md` §4.5、`docs/SAVE_FORMAT.md`）。因此应用此前"游戏给多少就显示多少"，自身从无计算。

### 符文数据现状

- 存档符文购买记录由 `core/boxes/runes.ts` 的 `parseRuneSaveData(text)` 解析为 `RunePurchase[]`（`{ runeKey, level }`）。
- 现有的符文效果建模只有两类（`data/rune_box_cap.json` 宝箱容量、`data/rune_auto_open.json` 自动开箱时长），**均不含减波**。
- 减波符文节点来自游戏 `sharedassets0.assets` 内嵌的 `RuneInfoData` / `RuneLevelInfoData` TextAsset（提取方式同现有符文数据，见 `docs/DATA-UPDATE.md` §3.3）。实测结果：
  - `RuneInfoData`：3 个节点 `1171` / `1242` / `1301`，`NameKey = RuneName_WaveCountReduction`，`MaxLevel = 1`。
  - `RuneLevelInfoData`：每个节点 `Level = 1`、`STATTYPE = WaveCountReduction`、`Value = 1`。
  - 即：每个节点减 1 波，全部点满共 **−3 波**。

## 关键决策

### 决策 1：修正口径 = live 值基准（方案 B）

**选择**：`有效总波次 = 运行时 waveAmount − runeWaveReduction`。

**背景**：游戏运行时 `waveAmount` 是否已内建减波，无法从代码静态确定（需游戏内验证）。两个候选口径：

- **A（静态表基准）**：`StageInfoData.WaveAmount − runeWaveReduction`。无论游戏是否内建都正确，但需要把一张应用从未使用过、且需随游戏版本维护的关卡基础波次表引入仓库，偏离"live 唯一真理源"架构。
- **B（live 值基准）**：`运行时 waveAmount − runeWaveReduction`。与现有架构一致、零新增数据表、改动最小；风险是若游戏已内建减波则重复扣减。

**选择理由**：应用现有实现全程依赖 live memory，B 与之一致且最小侵入。重复扣减风险通过**诊断 warn**（见"诊断"）暴露，便于事后发现并切换到 A，而不必现在就引入并长期维护一张静态表。

### 决策 2：修正落点 = `TrackingService.ingestLiveFrame` 单点

**选择**：在 live 帧进入 TrackingService 的地方修正一次，写入 `lastLiveFrame`。

**理由**：`stageWaveTotal` 的两个消费者——`buildStats`（读 `lastLiveFrame`）与 run-end 重置判据（同一函数内读 `snap`）——都会自动拿到修正后的值，无第二处遗漏风险。备选方案（各消费点分别修正、或在 live reader 层修正）分别存在"将来新增消费者易漏"与"让 live 读取器依赖存档符文状态、破坏分层"的问题。

## 设计

### 1. 数据层

**新增 `data/rune_wave.json`**（结构与 `rune_auto_open.json` 对齐）：

```json
{
  "runeLabel": "Rune of Brevity",
  "reductionPerLevel": { "1171": 1, "1242": 1, "1301": 1 },
  "note": "WaveCountReduction (Rune of Brevity) rune nodes from game RuneInfoData/RuneLevelInfoData. Three nodes (1171/1242/1301), MaxLevel 1 each, Value 1 = -1 stage wave per level."
}
```

**`app/src/core/boxes/catalog.ts`** 新增接口与 loader（对齐 `RuneAutoOpenCatalog`）：

```typescript
export interface RuneWaveCatalog {
  runeLabel: string;
  /** 每级减少的波数，键为符文节点 RuneKey 字符串。 */
  reductionPerLevel: Record<string, number>;
  note?: string;
}

export function loadRuneWaveCatalog(): RuneWaveCatalog {
  return readBundledJson<RuneWaveCatalog>("rune_wave.json");
}
```

**`app/src/core/boxes/runes.ts`** 新增纯函数（同 `runeAutoOpenReductionSeconds` 风格）：

```typescript
/** 已购买减波符文带来的关卡总波次减少量（累加各节点 level × perLevel）。 */
export function runeWaveCountReduction(
  purchases: RunePurchase[],
  catalog: { reductionPerLevel: Record<string, number> },
): number {
  let reduction = 0;
  for (const p of purchases) {
    const perLevel = catalog.reductionPerLevel[String(p.runeKey)];
    if (perLevel === undefined) continue;
    reduction += p.level * perLevel;
  }
  return reduction;
}
```

**导出与打包清单**：

- `app/src/core/boxes/index.ts`：导出 `loadRuneWaveCatalog`、`runeWaveCountReduction`、`type RuneWaveCatalog`。
- `app/src/core/bundledData.ts`：把 `rune_wave.json` 加入 `REQUIRED_BUNDLED_DATA_FILES` 与 `QA_GATE_BUNDLED_DATA_FILES`（后者防 CI/打包漏文件）。

### 2. 计算与传递（不新增 IPC）

**ChestService 复用已解析的 purchases**：`ChestService.resolveAndPush` 每次存档解析已调用 `parseRuneSaveData(text)`（[ChestService.ts:117](file:///d:/Project/TBH/tbh-companion/app/src/main/services/ChestService.ts#L117)）。为避免第三次 `JSON.parse` 整个存档，新增一个只读 getter，缓存最近一次解析结果：

```typescript
private lastRunePurchases: RunePurchase[] = [];

getRunePurchases(): RunePurchase[] {
  return this.lastRunePurchases;
}

// resolveAndPush 内：
const purchases = parseRuneSaveData(text);
this.lastRunePurchases = purchases;
```

**appState 接线**：在既有存档解析回调（[appState.ts:254-259](file:///d:/Project/TBH/tbh-companion/app/src/main/app/appState.ts#L254-L259)）里，`chests.onSave(...)` 之后计算并下推：

```typescript
(text, mtime) => {
  const inv = inventory.parseFromSave(text, mtime);
  chests.onSave(text, mtime, inv.chests);
  pets.onSave(text, mtime);
  tracking.setRuneWaveReduction(
    runeWaveCountReduction(chests.getRunePurchases(), loadRuneWaveCatalog()),
  );
  return inv;
},
```

> 说明：`tracking` 通过闭包在回调被调用时（运行时）已存在，无初始化顺序问题。`loadRuneWaveCatalog()` 走 `readBundledJson` 的内置缓存，仅首次读盘。

**TrackingService 新增状态与 setter**：

```typescript
/** 账号减波符文带来的关卡总波次减少量（由存档符文购买计算，0 = 无）。 */
private runeWaveReduction = 0;

setRuneWaveReduction(n: number): void {
  const next = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  if (next === this.runeWaveReduction) return;
  log.info(`rune wave reduction: ${this.runeWaveReduction} → ${next}`);
  this.runeWaveReduction = next;
}
```

### 3. 单点修正：`ingestLiveFrame`

在 `ingestLiveFrame` 开头、`connected` 校验之后，把传入帧的 `stageWaveTotal` 修正后再落库。**不修改调用方对象**，仅在需要时替换为副本：

```typescript
ingestLiveFrame(snap: LiveMemorySnapshot): void {
  if (!snap.connected) return;

  // 符文减波修正：只影响 stageWaveTotal（总波次），不影响 stageWave/其它字段。
  // 单点修正，使 buildStats（读 lastLiveFrame）与下方 run-end 重置判据
  // （读 snap）自动一致。
  if (this.runeWaveReduction > 0 && snap.stageWaveTotal != null && snap.stageWaveTotal > 0) {
    const raw = snap.stageWaveTotal;
    const effective = raw - this.runeWaveReduction;
    if (effective < 1) {
      // 触发钳制：raw ≤ 减波数。可能是"游戏已内建减波导致重复扣"的信号。
      this.warnClampedWaveTotal(raw, this.runeWaveReduction);
      snap = { ...snap, stageWaveTotal: 1 };
    } else {
      snap = { ...snap, stageWaveTotal: effective };
    }
  }

  this.lastLiveFrame = snap;
  // ……以下逻辑全部使用修正后的 snap（含 run-end 重置判据）
}
```

修正后，`buildStats` 的 `stageWaveTotal`、`reportedWave` 钳制、以及 `TrackingService` 的 `currentWave >= snap.stageWaveTotal` 判据全部基于有效总波次，无需再改 `stats.ts` 或 renderer。

### 4. 边界与不变量

| 情形 | 行为 |
|------|------|
| `runeWaveReduction === 0` | 完全透传原帧，行为与现状**逐字节一致**（不创建副本） |
| `stageWaveTotal == null` 或 `<= 0` | 不修正（沿用现有 "live total 不可用则 total=0" 语义） |
| `raw − reduction < 1` | 钳制为 `1`，并打节流 warn（见"诊断"） |
| 帧 `connected === false` | 提前 return，不修正 |
| live 开关切换（`onLiveMemoryToggled`） | **保留** `runeWaveReduction`（它是存档属性，与 live 无关） |
| 首次存档解析前 | `runeWaveReduction = 0`，不修正（现有行为） |
| 符文卸载/存档回滚 | 下次存档解析重新计算并 setter 更新（含降到 0） |

**不变量**：修正只改变 `stageWaveTotal`；`stageWave`、`stageKey`、`stageAlive`、heroes、DPS、宝箱等字段一字不动。`stageWave === 0` 的漂移兜底、`StaleWaveGuard`、`DpsTracker` 估计链路均不受影响。

### 5. 诊断

- **setter 变更日志**：`log.info("rune wave reduction: 0 → 3")`（仅数值变化时，低频）。
- **钳制 warn（保留，用户已确认）**：当 `raw ≤ runeWaveReduction` 触发 `max(1, …)` 时，`log.warn` 一条，包含 `rawWaveTotal`、`runeWaveReduction`。按 `(stageKey, raw, reduction)` 去重并加时间节流（参考 `liveReader` 的 `lastWaveDebugAt` 节流模式），避免 25Hz 刷屏。该 warn 是发现"游戏其实已内建减波导致重复扣"的主要信号。
- 不新增面向用户的 UI，不写入 `LiveMemoryDiagnostics`。

### 6. 测试策略

**Core（`test/core/boxes.test.ts`）**：

- `runeWaveCountReduction`：
  - 空 purchases → 0；
  - 单节点 level 1 → 1；三节点全买 → 3；
  - 未知 runeKey → 跳过不影响；
  - level > 1 的假设场景 → `level × perLevel` 累加正确；
  - 负数/非法 level 的防御（沿用 `parseRuneSaveData` 已过滤 level ≤ 0）。

**Main（`test/main/trackingService.test.ts`）**：

- `setRuneWaveReduction`：值变化触发日志、相同值不重复触发、非法值归 0。
- `ingestLiveFrame`：
  - `reduction = 0` → `lastLiveFrame.stageWaveTotal` 与输入一致；
  - `reduction = 3`、`total = 31` → 28；且 `stats` 输出 28；
  - `total = 2`、`reduction = 3` → 钳制为 1；
  - `total = null` → 不修正；
  - run-end 重置判据使用修正后的 total（构造 `currentWave = 28`、`alive = 0`、`reduction = 3` 时触发重置）；
  - 输入帧对象**未被就地修改**（`snap.stageWaveTotal` 保持原值）。

**Main（`test/main/chestService.test.ts`）**：

- `getRunePurchases()` 在 `onSave` 后返回最近一次解析结果。

**打包清单（`test/core/bundledData.test.ts`）**：

- 该测试会加载 `REQUIRED_BUNDLED_DATA_FILES` 里的每个文件；把 `rune_wave.json` 注册进去即自动获得"文件存在且可解析"的覆盖（`docs/agent/layers/DATA.md` 约定）。

**回归**：现有 `test/core/boxes.test.ts` / `test/main/stats.test.ts` / `test/main/trackingService.test.ts` 全部保持绿；`stageWaveTotal` 相关既有断言在 `runeWaveReduction = 0` 下不变。

### 7. 文档同步（AGENTS.md 强制）

- `docs/BUSINESS-FLOWS.md`：
  - §4.6（`buildStats`）与 §12（stage-run / run-end 重置）补充 `stageWaveTotal` 的符文减波修正说明与数据流。
  - 在符文相关章节登记 `rune_wave.json` 与 `runeWaveCountReduction`。
- `docs/DATA-UPDATE.md` §1 / §3.3：把 `rune_wave.json` 纳入符文数据刷新清单（来源 `RuneInfoData` / `RuneLevelInfoData` 的 `WaveCountReduction` 节点）。
- `docs/agent/generated/bundled-data-catalog.md`：改动 `REQUIRED_BUNDLED_DATA_FILES` 后执行 `pnpm run sync:agent-docs`（`scripts/sync-agent-docs.mjs`）重生成，**不要手工编辑**。

### 8. 实现顺序

1. **Phase 1 — Core 数据层**：`data/rune_wave.json` + `RuneWaveCatalog`/`loadRuneWaveCatalog` + `runeWaveCountReduction` + `bundledData.ts` + `index.ts` 导出；`test/core/boxes.test.ts`。
2. **Phase 2 — 计算与传递**：`ChestService.getRunePurchases()`；`TrackingService.setRuneWaveReduction`；appState 接线。
3. **Phase 3 — 单点修正**：`ingestLiveFrame` 修正 + 钳制 warn；main 层测试。
4. **Phase 4 — 文档同步**：BUSINESS-FLOWS / DATA-UPDATE / generated 清单。
5. **Phase 5 — 验证**：`pnpm qa`（typecheck + lint + format + test + build + bundle 守卫）。

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 修正口径 | live 值基准（B） | 与现有"live 唯一真理源"架构一致、零新增静态表、改动最小；重复扣风险由 warn 暴露 |
| 修正落点 | `TrackingService.ingestLiveFrame` 单点 | 显示与 run-end 判据两个消费者自动一致；避免多点遗漏与分层破坏 |
| 减波数据源 | 新增 `data/rune_wave.json` | 与现有 `rune_box_cap.json`/`rune_auto_open.json` 一致；来源为游戏符文表，随版本刷新 |
| 避免重复解析存档 | 复用 `ChestService.getRunePurchases()` | 存档每轮已解析两次以上，新增 getter 而非第三次 `JSON.parse` |
| 钳制与告警 | `max(1, …)` + 节流 warn | 保证 UI 不出现 ≤ 0 的 total；warn 作为"游戏已内建减波"的探测信号 |
| live 切换 | 保留 `runeWaveReduction` | 存档属性，与 live 会话无关 |

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 游戏运行时 `waveAmount` 已内建减波 → 重复扣减 | 钳制 warn 暴露；确认后可切换到静态表基准（方案 A） |
| 游戏新增 `WaveCountReduction` 节点 / 版本调整 | 数据源与脚本在 `docs/DATA-UPDATE.md` 登记，刷新 `rune_wave.json` 即可 |
| 存档解析失败导致 purchases 为空 | getter 返回上次结果或空数组 → `runeWaveReduction` 保持/归 0，安全退化 |
| 存档回滚 / 卸载符文 | 每次存档解析重算并 setter 更新（可降到 0） |
| 25Hz 下日志刷屏 | 钳制 warn 按 `(stageKey, raw, reduction)` 去重 + 时间节流；setter 仅在数值变化时记录 |

## 验收标准

1. **功能**：
   - 已购减波符文时，悬浮窗/Live 页的 `X / N` 中 N 为 `运行时 waveAmount − 减波数`（钳制下不低于 1）。
   - `currentWave` 达到有效总波次且 `stageAlive === 0` 时，run-end 重置与现状同样触发（在减波场景下不再"永远差几波"）。
   - 未购减波符文（`runeWaveReduction === 0`）时，所有输出与现状完全一致。
2. **正确性**：`runeWaveCountReduction` 对 3 个节点给出 0/1…3；非法值归 0。
3. **回归**：
   - `pnpm typecheck` 0 errors；
   - `pnpm lint` 0 errors（允许既有 warning）；
   - `pnpm test` / `pnpm test:dom` 无新失败；
   - `pnpm build` 成功且 `rune_wave.json` 进入 `dist/data`（bundle 守卫通过）。
4. **文档**：BUSINESS-FLOWS.md、DATA-UPDATE.md、generated 清单已同步。

## 参考文件

- 现状：`app/src/core/liveMemory/runtime.ts:43`、`app/src/main/stats.ts:43`、`app/src/main/services/TrackingService.ts:709`、`app/src/renderer/Overlay.tsx:113`、`app/src/renderer/tabs/Live.tsx:471`
- 符文建模：`app/src/core/boxes/runes.ts`、`app/src/core/boxes/catalog.ts`、`app/src/core/boxes/index.ts`、`data/rune_box_cap.json`、`data/rune_auto_open.json`
- 存档解析接线：`app/src/main/services/ChestService.ts:115`、`app/src/main/app/appState.ts:252`
- 打包清单：`app/src/core/bundledData.ts`
- 数据来源：`docs/DATA-UPDATE.md` §1/§3.3（`RuneInfoData` / `RuneLevelInfoData`）
- 架构约束：`AGENTS.md` 四层架构
