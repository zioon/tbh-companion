# 开箱统计补齐（Box-Open Backfill）

> 本文是 [`docs/BUSINESS-FLOWS.md`](../BUSINESS-FLOWS.md) 的拆分章节之一。**业务流程的单一真理源仍是主索引文件**——任何业务逻辑改动仍需先查阅本文件，落地后同步更新；本文件只是承载正文，便于按需加载。
>
> 用「获得记录」通道对 Loot 页漏计的开箱条目做统计侧补齐的完整链路。
>
> 所有文件路径以仓库根为基准（`app/src/...`）。

> ← [主索引](../BUSINESS-FLOWS.md) · 上一竧[统一记录日志（Record Log）](11-record-log.md) · 下一竧无 · 章节：§24

---

## 24. 开箱统计补齐（Box-Open Backfill）业务流程

> 面向的问题：**Loot 页漏统计**——玩家确实开了箱、确实拿到了物品，但 Loot 页条目比实际少。本节记录用「获得记录」环形区日志对漏掉的开箱条目做**统计侧补齐**的完整链路。

### 24.1 背景与定位

开箱读取器（`readRuntimeBoxOpenLog`）追踪的是 `GetItemWithBoxOpen` 事件桶。该桶由游戏**增量写入**：先抬高列表长度，最后才提交每个槽位的 `itemKey`（字符串引用）。扫描到"写了一半"的槽位会被停住并重试（`BOX_OPEN_OVERSCAN=64`、`MAX_BOX_OPEN_LOG_RETRIES=6`），常见情况能吸收，但**一次性"全部开启"的大批量**、**偏移漂移窗口**或 **worker 重启**仍会丢条目，结果就是 Loot 页少算。

"获得记录"环形区是**同一批事件的独立通道**：游戏每发放一件物品就追加一行「获得了…」，由陪伴应用在**独立的 ~10 ms 轮询路径**（`pollAcquireTailFast`）读取，**不受开箱桶的半写状态影响**。2026-09-16 实测：两条通道时间吻合到 64 ms 以内，最近 30 条开箱结果行在 tracker 中全部存在；对同一份归档（403 行 acquire + 500 条开箱历史）做比对，91 条发放行中有 **3 条在 tracker 中完全没有对应条目**，且其中 1 条（seq 242，黑曜石碎片）前后 10 秒内 tracker 一条记录都没有——**确属漏统计，非误分类**。

定位（三条硬边界）：

1. **只补统计，不改日志**：绝不回写 `record_log.json`，记录页仍是游戏自带界面的忠实镜像。
2. **补不回来源宝箱的身份，但能定其等级**：环形区行只给出物品名 + 品质色，**不说明来自哪个箱子**，因此"是哪个箱子"只能按"最近的开箱/掉落证据"归因；但"属于哪个等级"可由**日志前后的通关记录**确定性推导（见 24.3 步骤 4.5）——catalog 的 `dropStageKeys` 在**同类别内按 level 互不重叠**，所以一个 stageKey 至多命中一个 level，**这是查表而非猜测**。两者都可疑时宁缺毋滥，绝不臆造（臆造会污染各箱的掉率统计）。
3. **单向**：与 §23 的 `recordLogFit` 方向相反——`recordLogFit` 是「日志行 → 事件桶」的展示侧拟合，`boxOpenBackfill` 是「日志行 → 统计」的补齐侧修复。两者共用同一套"最近事件 + count 占用"语义，所以对同一行的判定一致。

### 24.2 数据流

```
[游戏] GetItemWithBoxOpen 桶 ──25Hz 帧──> liveReader ──> ingestLiveFrame
                                                              │
                                                              └─> boxOpenTracker.recordOpen()  ← 主通道（会丢）

[游戏] "获得记录" 环形区 ──~10ms 轮询──> ingestAcquireBatch ──> recordLog（只归档，不改）
                                                              │        ├─ 「获得了…」发放行
                                                              │        └─ 「通关了关卡 X-Y」通关行  ← 等级证据
                    1Hz tick ──> runBoxOpenBackfill() ─────────┘
                                        │
                                        ├─ 输入 A：recordLog.getStats().entries（窗口内的 acquire 行）
                                        ├─ 输入 B：boxOpenTracker.fitHistory()
                                        ├─ 输入 C：chestDropTracker.fitHistory()（GetBox 掉落，作兜底证据）
                                        ├─ 输入 D：stageClearHistory（已解析 stageKey 的通关记录，提供难度基准）
                                        ├─ 输入 E：boxRoutes（按类别的 dropStageKeys 表，来自 boxTimers catalog + stageBoxTracker）
                                        │
                                        └─ core/boxOpenBackfill.backfillOpensFromLog()
                                                  │  candidates（tracker 里没有的行）
                                                  ├─ resolveBackfillItem()：物品名(+色值) → itemKey + grade
                                                  └─ boxOpenTracker.recordOpen()  ← 补齐通道
                                                            │
                                                            └─> sessionState.flush() + pushStats()
```

### 24.3 匹配规则（`app/src/core/boxOpenBackfill.ts`，六步）

1. **排除非发放行**（结构性判据，不用物品名黑名单）：非 `acquire` 种类、`bulk` 重放行（其 `wallTime` 是摄入时刻，时间匹配无意义）、不以「获得了」开头、「通关了」开头、命中 `宝箱|Chest`（箱子**掉落**提示，其内容是后续独立的行）、名称为空、`wallTime` 非有限值。**故意不按名字排除材料/货币**——同一个后缀既出现在真实战利品上也会误伤（早期版本用 `锭$` 之类的名单，实测会静默丢弃真发放行，正是本功能要修的 bug）。通关行另有 `isClearLine` 判据（`acquireRaw` 以「通关了」开头）单独收集，**它们绝不是发放行**：其 `acquireName` 是整句（如 `通关了关卡 3-5。(4秒)`），若误入候选会被记成 `count: 1` 的幽灵掉落。
2. **已记录判定**：窗口（`BACKFILL_WINDOW_SEC=8`）内存在同名且仍有未认领数量的 tracker 条目 → 计入 `alreadyTracked` 并**按 `count` 扣减**（一条 `×3` 覆盖 3 个数量，三行各扣 1），语义与记录页一致。
3. **兄弟归因**：仍在窗口内的最近 tracker 条目**借用其 `boxKey`**。这里**故意不要求"仍有余额"**——同一次开箱丢一条时，幸存的兄弟条目已被步骤 2 各自的行认领完，但它们仍是关于"哪个箱子产出了这件物品"的唯一证据；加余额限制会让它们永远无法被借用，恰好丢掉本功能要找回的信息（这是初版实现的 bug，已修）。**若兄弟的 `boxKey` 已带 level（`rare:65`），该 level 即权威，步骤 4.5 不再插手**。
4. **兜底归因**：回退到最近的 GetBox 掉落类别（`chestDropTracker`）。此路径只给出**类别、无 level**。
4.5. **等级推导（仅当有类别、无 level 时）**：用行前后的**通关记录**把 `${category}` 升级为 `${category}:${level}`。两条证据按优先级：
   - **已解析通关记录**（`stageClearHistory`，`ClearFitEvent`，上限 200 条，含完整 stageKey/difficulty）——窗口内按时间距离由近到远逐个试。
   - **环形区自己的通关行**——用 `STAGE_LABEL_RE = /关卡\s*(\d+)-(\d+)/` 抽 `act-stage` 标签，再**借用难度**（`difficultyRef`）合成为 stageKey：`difficulty*1000 + act*100 + stage`（瘟疫区 act 21–24 用 6 位编码 `(difficulty*100 + act)*100 + stage`）。同一份「注册 3-5」标签在不同难度下解得不同 stageKey，所以难度必须来自真实通关记录，**不允许默认值**；拿不到难度就直接放弃（返回 null），绝不猜。
   - **关键**：`stageKey → level` 靠 `levelForStage(category, stageKey, routes)` 遍历 `dropStageKeys` 查表，**只有命中才返回**。因此"离得更近但无 route"的通关行不会阻塞搜索，会继续试更远的一条（初版在第一个语法合法的 stageKey 处就 return，导致有效证据被无效证据挡住，已修）。`stageKey` 合法性由 `isUsableStageKey`（正有限数）把关。
   - **瘟疫类别（`plagueCommon`/`plagueRare`/`plagueAct`）刻意不在 `boxRoutes` 里**（同 catalog 无 tracker routes），故永远保持 category-only。
5. **无证据**：计 `unattributed`，按 `unclassified` 记录（或以 `allowUnclassified: false` 降级为只报告）。**绝不猜等级。**

**幂等**：补齐后再跑一次，步骤 2 会命中（因为已按相同 `count` 记录、且用日志原名记录以保证字符串完全一致），候选为空——无需额外的"已补齐"账本。

### 24.4 触发时机与节流（`TrackingService`）

- **触发点**：`start()` 建立的 **1 Hz tickTimer**，而非 live 帧——这样即使 `read()` 停顿（主菜单/城镇）也照样执行，且天然低频。
- **节流**：`BACKFILL_INTERVAL_MS=10_000`。
- **成熟期（关键）**：`BACKFILL_GRACE_SEC=20`。开箱读取器会停放半写槽位并重试，**可能比环形区行晚几百毫秒才提交**。没有这个等待期，每个箱子都会被记两次（读取器补记一次 + 补齐一次）。20 秒是读取器实际所需的两百倍余量，而补齐只修统计、不是实时链路，等待没有代价。
- **可判定窗口**：只处理 `wallTime` 落在 `[最老开箱记录 - 8s, now - 20s]` 之间的日志行。早于下界 = 开箱历史可能已被裁掉（不可判定），晚于上界 = 读取器还没来得及（不可判定）。**不可判定 ≠ 丢失**，跳过它们正是"历史被裁剪"不被误读成一串丢失的关键。
- **无开箱记录时直接返回**：tracker 一条都没有 → 没有任何归因证据（live 内存关闭 / 还没开过箱），此时动手会把所有零散发放行变成 `unclassified` 噪音。

### 24.5 物品名 → itemKey / 品质

`TrackingService.resolveBackfillItem(name, color)`：

- 走 `lookupVariantIndex`（`name → grade → id`）。**单变体材料**（名字只对应一个目录行）直接取该行，无需色值。
- **多变体装备**（同名 10 个 id）用日志行的 `<color=#RRGGBB>` 解析等级，映射表在 `core/acquireLog.ts` 的 `gradeFromAcquireColor`。
- 色值未测到时**回退基础变体**而非猜等级（猜错会选错 id，把物品归错箱子）。
- **名字不在目录里 → 返回 null，整行跳过**。这条过滤天然把英雄（"牧师"）、关卡、宝箱提示挡在战利品统计之外——它们根本没有目录行。2026-09-16 实测：91 条发放行全部命中目录，0 条被这条规则丢掉（即它只是安全网，不误伤）。

**色值→品质映射**（2026-09-16 实测，每种颜色由 ≥3 条"名字唯一对应一个目录行"的发放行确认；**未测到的一律不填**）：

| 色值                                    | 品质                     | 备注                                                                         |
| --------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `#D7D7D7`                               | COMMON                   |                                                                              |
| `#7CE937`                               | UNCOMMON                 |                                                                              |
| `#519FFF`                               | RARE                     |                                                                              |
| `#EBBB00`                               | LEGENDARY                |                                                                              |
| `#E8695A`                               | IMMORTAL                 |                                                                              |
| `#FB86FF`                               | ARCANA                   |                                                                              |
| `#00F6FF`                               | CELESTIAL                | 灵魂石系列                                                                   |
| — 未映射 —                              | BEYOND / DIVINE / COSMIC | 样本中从未出现，不臆造                                                       |
| `#A4A4A4` `#0070C0` `#A69255` `#7030A5` | **null**                 | 宝箱提示/通关/英雄的专用色，**必须**保持"未知"，否则宝箱提示会被当成真战利品 |

### 24.6 目录名索引的三种拼写

`lookupVariantIndex` 现在为每个物品索引三种名字（`rebuildVariantIndex()`，由 `setLookupCatalog` / `setGameDataLookup` / `setLocaleCatalog` 三者共同触发）：

1. `item.name` — 本地化显示名（应用语言跟随游戏语言时命中）；
2. `item.sourceName` — 英文原名（跨语言稳定）；
3. `localeCatalog.items[id]` — **游戏语言下的名字**，也就是「获得了…」行里真正的字符串（应用 UI 语言与游戏语言不同时靠它命中）。

同 (name, grade) 先到先得，结果不依赖目录加载顺序。gamedata 只为 lookup 缺行的基础 id 补位（lookup 仍是首选来源）。

### 24.7 错误处理与降级

| 情况                                    | 处理                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `recordLog` 为空 / 无 acquire 行        | 直接返回（无输入）                                                                           |
| `boxOpenTracker.fitHistory()` 为空      | 直接返回（无归因证据，避免噪音）——见 24.4                                                    |
| 可判定窗口为空（`newestAt < oldestAt`） | 直接返回                                                                                     |
| 候选物品名不在目录                      | 跳过，计入 `unresolved`；**不影响统计正确性**                                                |
| 色值未测到（多变体）                    | 回退基础变体，`grade` 取该变体等级                                                           |
| **未接线 `boxRoutes`**                  | 步骤 4.5 整体跳过（`boxRoutes == null`）→ 保持 category-only，**不会**发明 level              |
| **通关行无可用难度基准**                | `difficulty <= 0` 直接返回 null → 保持 category-only。标签本身不带难度，猜难度等于猜等级     |
| **通关行的 stageKey 无 route 命中**     | 继续试下一个候选（更远的通关记录/行）；全不中则保持 category-only，**不回退到"随便取一个"**   |
| 无归因证据（步骤 5）                    | 以 `unclassified` 记录 → 进入 AutoClassify 队列（§14），用户本来就会复核；**不污染按箱掉率** |
| 补齐后写盘 / 推流失败                   | 与既有 `sessionState.flush()` / `pushStats()` 同路径，无新增失败模式                         |

**可观测性**：每次有实际补齐时输出 `box-open backfill: recorded N missing opens (scanned=… tracked=… excluded=… unattributed=… unresolved=… levelled=…)`——`levelled` 是**本次补齐中带 level 的条目数**（`levelFromBoxKey(boxKey) != null`），直接反映步骤 4.5 的命中率；即使没补齐，只要 `unattributed`/`unresolved` 非 0 也输出一行（该数字突然变大 = 两条通道漂移/时钟偏斜/读取器停摆，正是本功能要暴露的信号）。`levelled` 长期为 0 则应先查 `boxRoutes` 是否接上（见 24.9）。

### 24.8 边界与注意

- **绝不回写 `record_log.json`**。§23.4 曾提到"记录页不再接收桶事件（backfill 已移除）"——那次移除的是**记录页 feeder**；本节是**统计侧补齐**，两者不同，勿混淆。
- **等级推导是查表，不是猜测**：合法性完全建立在"catalog 的 `dropStageKeys` 在同一类别内按 level 互不重叠"这一事实上（`data/stage_boxes.json` 实测）。若将来 catalog 出现跨 level 重叠的 `dropStageKeys`，`levelForStage` 取**最高 level**，而"取哪个"就成了启发式——届时必须重新评估该步骤，而不是沿用。**类别必须先校验**（`categoryOfBoxKey` 只接受 `BASE_CATEGORIES` 成员）：`unclassified` 没有冒号，若直接按"无 level 的 key"处理会被步骤 4.5 升级成 `common:65`，等于把一条"无证据"行伪造成带 level 行。
- **补齐条目的箱 id 是记账 id，不是战利品**：`runReResolveNames` 的归一化器**必须**在最前面放行 `isBoxItemKey` 命中（910xxx/915xxx/920xxx/925xxx/930xxx/935xxx），否则 locale 切换时若 loot 目录没有该 id，补齐出的带 level 行会被静默删除（该分支只放行"区间外的 BOX id"，正是它让这个隐患长期不可见）。
- 补齐条目的 `wallTime` 取**日志行的摄入时刻**（与 tracker 同为陪伴应用时钟，实测相差 ~64 ms），因此排序/时间窗与既有条目可比。
- 开箱历史上限 `HISTORY_LIMIT=500`；一旦被裁剪，早于"最老开箱记录 - 8s"的日志行就退出可判定窗口（24.4）。这是**主动放弃**，不是漏补。
- `unclassified` 条目会触发 `BoxOpenTracker` 的 `onUnclassified` → AutoClassify 队列（§14）。若某次批量补齐产生大量 `unclassified`，说明归因证据整体缺失（例如读取器长时间停摆），应看 `app.log` 的 `box-open backfill:` 行定位。
- 补齐只会**增加**条目，不会改写或重分类既有条目；用户手动重分类（`reclassifyItem`）的结果不受影响。步骤 4.5 只改**正在恢复的那一条**，**不会**回头给已存在的 category-only 兄弟条目补 level。
- **误报风险已实测量化（2026-09-16，403 行 acquire + 500 条开箱历史）**：99 条发放行中，**96 条在 1 秒内**就有开箱记录、**98 条在 8 秒内**，只有 1 条（seq 242 黑曜石碎片，最近开箱在 75.2 秒外）落在窗口外。也就是说"刷关掉落的零散材料被误当成开箱产物"在这份真实数据里**基本不存在**——本游戏几乎所有「获得了…」行本来就是开箱产物。因此**没有额外加"必须有邻近开箱才考虑该行"的门槛**：唯一那条真实漏统计恰好在 75 秒外，加 60 秒门槛会把它挡掉（得不偿失）。若将来出现误报（表现为 `unclassified` 突然增多），首选手段是把 `allowUnclassified` 设为 `false` 降级为只报告，或加一道更宽的"活动门"（而非收紧 8 秒归因窗口——那会先伤到兄弟归因）。
- **启动首轮的判定范围**：`oldestAt` 取自恢复的开箱历史中最老的一条，所以首轮会用**恢复的历史**去判定归档里所有落在窗口内的日志行。历史被裁到 500 条时，早于"最老开箱"的行自动退出判定（见 24.4），不会误判成丢失。
- 幂等依赖"用日志原名记录"。若将来改为记录目录名，必须同步确认与 `acquireName` 完全一致，否则每次补齐都会重复一条。

### 24.9 关键文件

| 职责                                           | 路径                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 补齐核心（纯函数，可单测）                     | `app/src/core/boxOpenBackfill.ts`                                                                                                                      |
| boxKey / 箱 id 判据（`isBoxItemKey`）          | `app/src/core/boxOpenLog.ts`                                                                                                                           |
| 色值→品质                                      | `app/src/core/acquireLog.ts`（`gradeFromAcquireColor`）                                                                                                |
| 编排（1Hz 触发、节流、成熟期、目录解析、落库） | `app/src/main/services/TrackingService.ts`（`runBoxOpenBackfill` / `resolveBackfillItem` / `rebuildVariantIndex` / `setBoxRoutes`）                    |
| **等级路线表接线**（RARE 取 boxTimers catalog；COMMON/ACT 取独立表） | `app/src/main/app/appState.ts`（`buildBackfillBoxRoutes()`）+ `app/src/core/stageBoxTracker.ts`（`loadCommonChestTrackerRoutes` / `loadActBossTrackerRoutes`） |
| 补齐落点                                       | `app/src/core/boxOpenTracker.ts`                                                                                                                       |
| 兜底证据（GetBox 掉落）                        | `app/src/core/chestDropTracker.ts`                                                                                                                     |
| 日志源                                         | `app/src/core/recordLogTracker.ts` + `app/src/main/services/RecordLogService.ts`                                                                       |
| 单测                                           | `app/test/core/boxOpenBackfill.test.ts`（32）、`app/test/core/acquireLog.test.ts`、`app/test/main/trackingService.test.ts`（"box-open backfill" 8 例） |
