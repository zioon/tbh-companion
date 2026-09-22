# 统一记录日志（Record Log）

> 本文是 [`docs/BUSINESS-FLOWS.md`](../BUSINESS-FLOWS.md) 的拆分章节之一。**业务流程的单一真理源仍是主索引文件**——任何业务逻辑改动仍需先查阅本文件，落地后同步更新；本文件只是承载正文，便于按需加载。
>
> 复刻游戏内「获得记录」界面的完整链路：环形区 / 定长列表读取模型、去重、归档与调试字段语义。
>
> 所有文件路径以仓库根为基准（`app/src/...`）。

> ← [主索引](../BUSINESS-FLOWS.md) · 上一竧[Notification / Update / Pet](10-notification-update-pet.md) · 下一竧[开箱统计补齐（Box-Open Backfill）](12-box-open-backfill.md) · 章节：§23

---

## 23. 统一记录日志（Record Log）业务流程

**动机（2026-09 更新）**：记录页从"三类桶事件的统一聚合"演进为**游戏内「获得记录」界面的完全复刻**——数据只来自 `LogManager@0x20` 会话级环形区（游戏自带"获得记录"时间线），不再掺入由掉落/开箱/通关事件桶合成的记录。桶读取（GetBox/BoxOpenLog/StageClearLog）仍各自服务既有聚合（chestDrops/boxOpens/stageRuns/Loot），但**不再进入 recordLog**。`record_log.json` 承担跨会话长期归档。

**数据源核查结论**：磁盘上无任何持久化的掉落/开箱/通关记录文件（存档 `PlayerSaveData` 无 record 字段、`Player.log` 仅异常栈回溯、游戏 Data 目录无日志文件），"游戏自带记录"本体即内存 `LogManager`。因此记录页 = 实时读取"获得记录"环形区并归档。

### 23.1 数据流

```
游戏进程 LogManager@0x20（获得记录环形区：会话级、容量 ~2000、单调 total 计数）
  → worker 独立"获得记录"通道（~10ms，不经过 snapshot / read() 帧）
      ├─ 初次全量：attach 后首次成功读取拉取环形区最新窗口（total-2000 → total，initial=true）
      ├─ 定期增量：从 acquirePin.total（读取端自己的位置）向前读，**不再以环形区计数器为锚**
      └─ 陈旧槽位守卫：命中「同槽指纹未变 / 游戏内时间戳回退」→ 停在真实写入位置、pin 不推进（下一轮重试）
      → post({type:"acquire", entries, initial}) → LiveMemoryService → TrackingService.ingestAcquireBatch(entries)
          └─ 唯一喂入口：feed("acquire", now, {acquireRaw, acquireName, acquireCount, acquireColor, acquireTime})
      ↘ RecordLogTracker（core，递增 seq + 容量裁剪）
          → RecordLogService.schedulePersist() 防抖 ~2s
          → 写 userData/record_log.json  {nextSeq, entries}
  → buildStats 输出 Stats.recordLog（最新窗口 200 条 + total + byKind）
  → onStats(IPC.STATS) → StatsContext → RecordLog tab（倒序、复刻游戏「获得记录」界面）
```

> 注：`获得记录` 由 worker 的**独立高频轮询**（`fastAcquirePollTimer` → `pollAcquireTailFast`，~10ms）直接 post 给 main，**不经过 snapshot / `read()` 帧**——不受 stage 为 null、name-scan 等 `read()` 提前返回影响，不堆积、不丢失。获取模型为**初次全量 + 定期增量**：attach 后首次成功读取把环形区最新窗口作为 `initial` 批下发，之后每轮从 `acquirePin.total`（读取端位置）向前续读。**读取位置只由读取端自身推进，绝不以环形区计数器 `ring+0x1C` 为锚**——该计数器实测会跑到槽位实际写入之前（2026-09-15 现场：attach 全量窗口尾部仍留着上一圈的条目，时间戳落后 6~7 小时），以它为锚会让后续每次增量读到「同槽 = 上一圈」的旧条目，真正最新行永不投递（记录页恒定滞后一整圈）。UI 侧只渲染 `kind === "acquire"` 条目（兼容旧版 record_log.json 里遗留的 drop/open/clear 历史数据），每条显示游戏内时间 + 原始消息（`<color=#RRGGBB>` 保持品质色渲染），完全复刻游戏内「获得记录」界面。

### 23.2 关键文件

| 职责                 | 路径                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一记录器（纯逻辑） | `app/src/core/recordLogTracker.ts`（`RecordLogTracker`：`feed/getStats/snapshot/applySnapshot`）                                                                                                                      |
| 持久化载体           | `app/src/main/services/RecordLogService.ts`（load-once / 防抖 persist / stop flush）                                                                                                                                  |
| 事件接入             | `app/src/main/services/TrackingService.ts`（`ingestAcquireBatch`——记录日志**唯一喂入口**；`resetRecordLog()`）                                                                                                        |
| "获得记录"环形区读取 | `app/src/core/liveMemory/runtime.ts`(`readRuntimeAcquireLogs`) + `app/src/main/liveMemory/liveReader.ts`(`pollAcquireTailFast` 初次全量+增量) + `app/src/main/liveMemory/worker.ts`(`fastAcquirePollTimer` 直接 post) |
| 富文本→结构化解析    | `app/src/core/acquireLog.ts`（`parseAcquireMessage`：提取名称/数量/品质色/种类）                                                                                                                                      |
| 统计输出             | `app/src/main/stats.ts`（`buildStats` 增参 `recordLogTracker`，输出 `Stats.recordLog`）                                                                                                                               |
| 文件注册/清除        | `app/src/main/services/appData.ts`（`RECORD_LOG_FILE`＝`record_log.json`；入 paths 清单与 `all-except-config`）                                                                                                       |
| UI                   | `app/src/renderer/tabs/RecordLog.tsx`（新 tab id = `log`）                                                                                                                                                            |

### 23.3 持久化与去重

- **文件**：`record_log.json`＝`{nextSeq, entries: RecordLogEntry[]}`。
- **写入**：事件批量后防抖 ~2s；`TrackingService.stop()` 强制 `flush()`。`<2s` 尾部窗在崩溃时丢失（可接受，不产生重复）。
- **容量**：内存与文件均裁剪至 10000 条（`capacity`），展示窗口取最新 200 条（`recentWindow`）。
- **去重**：唯一消费点是 `ingestAcquireBatch`，靠 `acquirePin.total`（**读取端自己的位置**）单调向前增量；`readRuntimeAcquireLogs` 只在条目被确认「本圈已写入」时才推进 pin（槽位指针/消息 mid-write、同槽指纹未变三类情况一律**停机重试**，不投递、不推进），因此环形区条目不重读、不重复投递；崩溃重启后 `nextSeq` 从磁盘续增、`applySnapshot` 按 `seq` 合并（重复 seq 被覆盖）→ 无重复。
- **断点续读（2026-09-15 终版：持久化读取位置水印）**：`record_log.json` 额外持久化 `acquireWatermark`（读取端最后交付的环形区索引）。链路：worker 每批带 `watermark` → `ingestAcquireBatch` → `RecordLogService.setAcquireWatermark`（随归档防抖落盘）；下次启动 `appState` 从 `tracking.getAcquireWatermark()` 取回，经 `LiveMemoryService.setAcquireResume` → worker `{type:"acquireResume"}` → `pin.resumeTotal`。首次读取时 `readRuntimeAcquireLogs` 校验：计数器 ≥ 水印且差距 ≤ 一个环 → **从水印续读**（`resumed=true`，该批按普通增量处理、不走 initial 去重）→ 重启后只交付"上次关机之后"的新行，**存量重灌从机制上不再发生**；计数器 < 水印 → 环形区重启（新游戏会话）→ `restartDetected=true` 旁路去重并全量展示；计数器比水印多出一个环以上 → 离线太久、水印失效 → 回退到全窗锚点 + ringSeq 去重。`ringSeq` 去重保留作为无水印场景（首次运行/水印失效）的兜底——注意它对旧归档（无 ringSeq 字段的历史条目）是冷启动无效的，这正是水印不可省的原因。
- **重新 attach 存量去重（2026-09-15 终版：按环形区索引 `ringSeq`）**：`initial` 批（重新 attach 后的会话存量）**不再用 `(acquireTime, acquireRaw)`**——环形区的 `[HH:MM]` 时间串是游戏可复用/改写的对象（同一条未重写的条目 45 分钟后重读时间戳会变，实测 14:07 → 14:40），该键不稳定；也**不用"交付顺序重叠/按原文计数"**——文案高度重复且归档偶有漏行，16:40:53 的一次重启中精确前缀对齐在第 3 行就失配，整批 2000 条被重灌（`deduped=0`）。现改为：`RecordLogEntry` 新增 `ringSeq`（环形区索引，即 `AcquireLogEntry.seq`，随条目持久化），`RecordLogTracker.ringSeqSeen` 维护已归档索引集合，initial 批按 `hasRingSeq(a.seq)` 逐条判定——**与时间串、文本、顺序全部无关**；索引不在集合里 = 上个会话漏掉的行 → 现在补上（恢复而非吞掉）。**环形区重启（新游戏会话）的 initial 批绕过该去重**（索引从 1 重来会与旧会话冲突）：`pollAcquireTailFast` 返回 `ringRestarted=true` 全链路透传。每次 ingest 日志带 `deduped=N`。测试用例必须使用高位唯一索引（如 `900000+`），避免污染真实归档的去重集合。
- **生命周期**：**不随"重置会话"清空**（长期保留）；仅 Settings → Data 清除的 `record-log` / `all-except-config` 会删文件并同步 `TrackingService.resetRecordLog()` 清内存。

### 23.4 错误处理

- **英雄事件行不得被源码拟合认领（`fitAcquireSources`，`core/recordLogFit.ts`，2026-09-21 修复）**：游戏自带的"获得记录"里除奖励行外还有**英雄事件行**（如 `牧师被击败了。(木乃伊)`，游戏固定染紫 `#7030A5`）。此类行**不是任何事件的奖励**，但 Pass 4 的「clear by nearest time」兜底会按时间就近把它认领给 `source: "clear"` → 记录页把它显示成金色 +「通关」徽章（用户现场报告："日志归档错误"）。
  - **为何必然误判**：英雄阵亡与其后的通关行**几乎同时写入**。2026-09-21 线上实测（v1.2.4 Boss 关）：`牧师被击败了。(木乃伊)` wallTime `1789990881.34` vs `通关了关卡 3-9。(73秒)` `1789990881.967`，相距仅 **0.627 s**，远在 `FIT_WINDOW_SEC=8` 窗口内。Pass 0 挡不住它——该行不以 `通关了` 开头。
  - **修复**：新增前置门 `isHeroNotice`——**命中紫色 tint（`#7030A5`）或模板文案（`被击败`/`阵亡`/`复活`/`升级`/`觉醒`）即整行排除，不经任何 Pass**（不只是 Pass 4：阵亡既不是开箱、不是宝箱、也不是通关奖励）。门在 `fitables` 上一次性过滤为 `fittable`，四个 Pass 全部改用它。
  - **为何必须在 fit 层排除（而非只在渲染层）**：渲染层 `RecordLog.tsx` 的 `deriveRow` 是**以「无 fit」为前提**去跑文本规则的（`HERO_RE` → `hero` 桶 → 紫色 `HERO_COLOR`）。只要 fit 存在，`fit.source === "clear"` 分支就直接覆盖掉文本分类 —— 英雄行永远拿不到正确的 hero 归类。故排除必须发生在 fit 层，让该行以"未拟合"身份回流到渲染层的文本规则。
  - **两个信号都保留的理由**：颜色判据在 zh 客户端已足够，文本判据用于兜底旧归档行（`acquireColor` 缺失）或将来 locale 改色；`#7030A5` 本身在 `acquireLog.ts` 的 `COLOR_TO_GRADE` 白名单外（见 §23 品质色说明），不会被误读成物品品质。
  - **回归测试**：`app/test/core/recordLogFit.test.ts` 新增 5 例——真实归档数据对（英雄行 + 紧邻通关行）、仅紫色无文案、仅文案无颜色（4 种模板）、「紧邻通关行仍正常拟合」、以及「普通奖励行不受影响」。**反向验证**：临时移除该门后 4 例立即失败，报错正是 `expected { source: 'clear', stageKey: 309 } to be undefined`，与该 bug 的现场表现一致。
- 读文件失败/损坏 → `RecordLogService.load()` 记 warn，从空态继续。
- 写盘失败（只读/满盘）→ `persist()` 记 warn，不回滚内存，下次调度再试。
- `record_log.json` 被 Settings 删除 → `clearAppData(record-log)` 删除文件后 `tracking.resetRecordLog()` 清内存态。
- 通关条目被跳过（漏记）有两道门，均会输出诊断日志，避免静默丢记录：
  1. **`fallbackStageKey === 0`**：当帧 `snap.stageKey`/`lastLiveStage.stageKey`/`lastSnap.stageKey` 都为空 → 整段跳过（`log.warn("clear skipped: ...")`）。回退链已含 `lastLiveStage.stageKey`（用最后存活关卡补难度，`resolveClearedStageKey` 仅取其 difficulty，不造成 off-by-one 归因）。
  2. **`valid === false`**：通关条目的 act/stage 在 mid-write 读成不可读 → 首次读到（新条）时以 `valid=false` 报给调用方丢弃，输出 `log.info("clear invalid: dropped ...")`。
- **overscan 回读 + 指纹去重（`readRuntimeStageClears`，`runtime.ts`）**：每次除新增 `[lastCount, count)` 外，还回读最近 `STAGE_CLEAR_OVERSCAN=4` 个已扫描槽位。半截条目一旦在下一 tick 提交完整，即可被回读补记（此前 `lastCount` 直接越过后即永久丢失）；已交付槽位用 (act, stage, clearTimeSec) 指纹去重（FIFO，`STAGE_CLEAR_FINGERPRINT_CAP=32`），避免重复记账。回读永不越过 `tailBase`（prime 时的日志起点 / shrink 后的新起点），故 attach 存量日志与重置后的旧槽位不会被误补。
- **开箱 overscan + 索引级去重（`readRuntimeBoxOpenLog`，`runtime.ts`）**：回读窗口（`BOX_OPEN_OVERSCAN=64`，**必须 ≥ 一次批量规模**）解决批量开箱漏记——游戏会**先把 BoxOpenLog 的 count 预留、再逐条落定 itemKey**；批量靠后的条目在我们扫到时仍在 mid-write → 被 park / force-skip，而 `MAX_BOX_OPEN_LOG_RETRIES=6` 给它提交等待。若回读窗口过小，force-skip 的条会在 itemKey 补齐前被推进的尾指针推出窗口→**按批量规模成比例漏**（开 20 漏 ~2）；宽窗口保证它在从 log 消失前持续可回读补记。去重按**槽位索引**（`deliveredIndices`），不按物品值（两个箱子可开同一物品）。回读受 `tailBase` 门控，不触碰 attach 存量与重置后数据。
- **掉落 overscan + 索引级去重（`readRuntimeChestLog`，`runtime.ts`）**：同样补上回读窗口（`CHEST_OVERSCAN=4`）——被 `MAX_CHEST_LOG_RETRIES=3` 强制跳过的掉落槽位，等其 monsterType 提交后由回读补记。掉落去重同样按**槽位索引**（`deliveredIndices`），因为连掉的两个宝箱可能是同类（按类别去重会误并）。实现上**与跨 tick settle 共存**：有新掉落要 settle 的那一拍不启用 overscan（避免重读被 hold 的条目）；且仅在"最新解码的是日志最后一格新掉落"时才 hold 它做 settle——若最后一格是强制跳过的或最新是 overscan 补回的，则不 hold，避免把已交付的记录重复结算。
- **统一入口 + 公共尾推进（`readRuntimeAllLogs` + `scanLogBucket`，`runtime.ts`）**：三条日志读取在中层合并为一个入口 `readRuntimeAllLogs(reader, ga, o, pins)`——一次 resolve LogManager 后，把三个 ELogType 桶（掉落/开箱/通关）各走一遍统一尾推进器 `scanLogBucket`，返回单一 `UnifiedLogsResult`（`{chestDrops, boxOpens, stageClears, statusByKind, debugByKind}`），三个下游（`liveReader.read()` 组帧 → `TrackingService.ingestLiveFrame`）从中各取所需。开箱与通关共用 `scanLogBucket` 的推进骨架（prime/shrink/overscan/park+force-skip/去重/lastCount）；掉落因**跨 tick settle** 语义特殊保留独立解码，但在统一入口内一并读取。`LiveMemorySnapshot` 的三字段结构与可空语义保持**不变**，故 `TrackingService` 零改动。
- **记录日志唯一喂入口（`TrackingService.ingestAcquireBatch`）**：记录页（"记录" tab）不再接收任何桶事件（`ingestRecordLogs` 及 backfill 已移除）。`ingestAcquireBatch(entries, initial)` 是 `recordLog` 的唯一喂入口：每条"获得记录"条目 feed 为 `acquire` 记录（`acquireRaw`＝剥标签原文、`acquireName/count/color`＝结构化解析、`acquireTime`＝游戏内 [HH:MM]）。`initial` 批（会话存量）先按签名跳过已归档条目（见 23.3「重新 attach 存量去重」），批内合法重复保留。**feed 后立即按 `LIVE_BROADCAST_INTERVAL_MS`（200ms）节流 `pushStats`**——获得记录通道独立于 snapshot/`read()` 帧，若只依赖 live 帧推送，主菜单/村庄（stage null）期间新记录不会刷新到 UI。UI 只渲染 `kind === "acquire"`（兼容旧版 record_log.json 遗留的 drop/open/clear 历史数据），每条显示游戏内时间 + 原始消息（`<color=#RRGGBB>` 保持品质色），完全复刻游戏「获得记录」界面。
- **"获得记录"解码（`readRuntimeAcquireLogs`，`runtime.ts`）**：游戏自带"获得记录"界面数据源为 `LogManager@0x20` 的**会话级环形区**（容量约 2000，单调 total 计数，重启即清空；内存中完整、不被分桶覆盖）。worker 的独立轮询（`fastAcquirePollTimer` → `pollAcquireTailFast`，~10ms）按 `acquirePin.total` 增量读取并**直接 post 给 main**（`{type:"acquire", entries, initial}`），**不经过 snapshot / `read()` 帧**（stage 为 null、name-scan 等 `read()` 提前返回不影响其下发，也不堆积、不丢失）。获取模型为**初次全量 + 定期增量**：attach 后首次成功读取以 `initial=true` 下发整个会话存量，之后每轮只读新增条目。**mid-write 防漏**：游戏追加条目时"先写 slot 指针、再提交字符串"，worker 读到未提交条目（`message` 解码为空或 slot 指针未写）时**停在失败条目、不推进 `pin.total`**（此前为 continue + 无条件推进，导致"打开箱子后新记录永久丢失"），下一轮 poll 重读该尾段；环形区按序追加，未提交条目必为最新一条。
- **detach/re-attach 续读（2026-09-15 新增）**：`detach()` **不再重置** `acquirePin`/`acquireInitialDone`/`lastAcquireTotal`——同一游戏会话内的 detach→re-attach（游戏卡顿/进程句柄抖动触发的 worker 重连）会**继续按 pin 增量读**，不再把整个环形区存量重新作为 `initial` 批下发（此前每次 re-attach 都重新全量，旧记录以新 seq 重新排到记录页顶部，表现为"打开箱子后新增的不是最新的"）。真正的**新游戏会话**由环形区计数器重启识别：`readRuntimeAcquireLogs` 检测 `total < pin.total` 时把 pin 回退到 0 并清空槽位指纹/末段时间戳重新全量，`pollAcquireTailFast` 检测 `res.total < lastAcquireTotal` 时重置 `acquireInitialDone` 使该批标记为 `initial`（companion 重启后仍会初次全量展示存量）。
- **陈旧槽位守卫（2026-09-15 修复：记录页恒定滞后一整圈）**：实测环形区计数器 `ring+0x1C` **跑在槽位实际写入之前**——attach 全量窗口 `[total-2000, total)` 的尾部仍持有**上一圈**条目（同一槽位 2000 次追加前的内容，游戏内时间戳落后 6~7 小时），此前的半写保护只挡 `entryPtr == null` / 消息解不出，**挡不住这种"完整可解码的旧条目"**：它被当作新记录投递且 pin 无条件推进，导致此后每次增量都命中「同槽 = 上一圈」内容、真正最新行永不投递（现场证据：`app.log` 的 attach 批尾部出现 02:32/03:54/…/07:15，紧随其后的增量批是 attach 批开头区域的顺序回放；`record_log.json` 最新条目时间戳落后真实最新约 2000 条 / 6~7 小时）。修复（`readRuntimeAcquireLogs` + `acquireHoldReason`）：
  1.  **读取锚点改为读取端位置**：稳态下 `from = acquirePin.total`，只在 pin 为 0（真正首次读取）时才锚定 `total - CAPACITY` 取最新窗口；单轮最多续读一整圈（`limit = from + CAPACITY`），落后多时用连续几轮（10ms/轮）追平，而不是把 pin 一步跳过未读条目。
  2.  **陈旧判定改用「指针 + 消息」指纹**（`acquireIdentity` = `entryPtr|msgPtr|message`）：同槽指纹与上一圈读到的完全相同 → 该槽未被本圈覆盖 → **break**（不投递、不推进 pin，下一轮重试）。被停住的槽位正是下一次写入的目标，因此游戏一追加就自然解除，无需额外自愈逻辑。**指纹里故意不含时间串**：实测（2026-09-15）游戏会复用/改写 `entry+0x28` 指向的时间字符串对象，同一条未重写的条目 45 分钟后重读时间戳会变（14:07 → 14:40），所以「时间戳回退」判据**已整体删除**（它既是漏检原因，也会在跨天回绕时误判）。
  3.  **释放阀（`ACQUIRE_HOLD_RELEASE_MS=5s`）**：若同一槽位在**计数器持续前进**（= 游戏确实在产出行）的情况下被停住超过 5 s，说明新鲜度模型不成立 → 直接交付并输出 `acquire hold (RELEASED)` 日志（响亮兜底，避免永久停顿）；计数器静止（游戏空闲）时 hold 永不过期——此时本来也没有新行可交付。
  4.  **容量探针（不再"假设 2000"）**：记录 0 号槽位内容最近一次变化的索引，两次变化之间正好一个环长 → `pin.capacityEstimate`；`liveReader` 在变化时输出 `acquire ring capacity MEASURED: N entries per slot cycle (assumed 2000 — matches|MISMATCH!)`。
  5.  **可观测**：`liveReader.logAcquireHold`（节流 5 s / 槽位变化立即记）输出 `acquire hold: seq=… reason=stale-slot|released total=… pin=…`；环形区 dump **由主进程按策略下发**（不再依赖环境变量是否传到 worker——实测 `TBH_ACQUIRE_DUMP=1` 重启后一条 dump 都没有）：`LiveMemoryService.start()` fork 后 postMessage `{type:"acquireDump", enabled, maxDumps, windowSize}`，未打包（dev）构建默认开启且限量（200 条 dump × 8 槽位，只在环形区"动过"或每 10 s 基线时落盘），`TBH_ACQUIRE_DUMP=1` 全量窗口（24 槽位、不限量）、`=0` 关闭；启动日志会打 `acquire dump policy: enabled=… (TBH_ACQUIRE_DUMP=…, packaged=…)` 便于核对。`dumpRuntimeAcquireRing` 输出计数器、ring/buf/elemBase、长度探针（`buf+0x18`/`buf+0x1C`/`ring+0x18`、内层数组指针与 `innerLen`）与尾部槽位的 entryPtr + 时间戳 + 消息，相邻两次 dump 即可确认计数器超前量、槽位指针是否随覆写变化、以及真实容量。
  6.  **写入头扫描 + 锚定仲裁（2026-09-19：让程序自己找到"最新日志"的真实位置）**：环形区计数器 `+0x1C` 实测会**领先槽位实际写入最多一整圈**（2026-09-18/19 现场：`total=4935 pin=4935 base=-`，即读取器已到计数器边缘，但该位置的槽位内容时间戳落后墙钟 8~15 h；缺口随积压消费而收窄，内容与标签同步前进、零 hold、零重复）。因此「计数器边缘」**不是**"最新内容"的可靠参照。新增两条机制：
      - **`scanAcquireHead(reader, elemBase, slots)`（全环写入头扫描）**：遍历槽位——扫描范围**取 backing array 的声明长度**（`buf + 0x18`，.NET 数组头；线上 2048）并下限到假定容量、上限 `ACQUIRE_SCAN_MAX=8192`——**不再假定 2000**（2026-09-20 用户报告环可能约 5000 槽：改为"测量而非假定"）。按游戏内 `[HH:MM]` 时间戳在**环形分钟钟面**上取最新者（同分钟取槽号较大者——顺序写入 PASS 内槽号递增）→ 返回 `{slot, stampMin, stamp, decoded}`。这是唯一不信任计数器的位置参照。dump 每次扫描并输出 `head: slot=… stamp=… lag=…min decoded=… swept=… capacity=… (pin maps to slot …)`，让"最新内容在哪、落后多少、扫了多大范围"一眼可见。
      - **容量自适应（2026-09-20）**：若扫出的写入头**位于假定容量（2000）之外**，即为"环模数比假定的大"的实证 → `pin.ringCapacity` 采纳实测跨度、`slotIdentity` 重建为新尺寸、slot 数学（映射 / `from` / `limit` / 探针 / 锚定）全部按新容量重映射，并输出 `acquire ring capacity MEASURED-BY-SWEEP: … slot math remapped to N slots`。旧行为永远按 2000 取模——模数若真错，读取会系统性错位且无从发现。
      - **挂载时纠偏（2026-09-20）**：初次全量批（`start === 0`）原本完全不设防（其存量合法地是数小时前的时间戳），现在额外做一次**偏差检查 + 仲裁**：批次最新时间戳偏离墙钟 > 180 min 立即扫描裁决——锚错则**丢弃整批并重锚定**（先把 pin 推到批次末尾再锚定，确保 `slot(pin) == head`，下一次写入即投递最新内容）、环滞后则仅报告。启动瞬间即给出判定，不必等稳态批次。
      - **`arbitrateAcquireAnchor`（锚定仲裁）**：stamp 护栏怀疑异常时不再盲目"判损坏 + 丢弃"，而是先做一次全环扫描裁决：
        - head **相对墙钟新鲜**（≤ `ACQUIRE_STAMP_WALL_TOL_MIN=180` min；游戏时间戳与墙钟 1:1）**且**与正在投递的内容相差 ≥ `ACQUIRE_HEAD_NEWER_MIN=30` min → **读取器锚错了**（映射漂移）→ `anchorPinToHead`：`sessionBase = (pin.total - headSlot) mod 2000`（**pin 的标签空间不动**，只移动映射；避免回退标签导致重复归档），`recoverAcquireMapping` 重建全部槽位指纹并**清空 head 槽的指纹**（让最新那条被投递而非被 hold 挡住），每会话最多 `ACQUIRE_RECOVERY_MAX=3` 次，超限后 `mappingSuspect`（放行 + 响亮告警，避免死锁数据流）。
        - head **自身就旧** → **读取器已在最新内容上、是环形区自己落后游戏**（游戏侧积压/欠写）→ **不恢复**，投递照旧（把忠实读取当损坏丢弃才是真错误），输出 `ringLagMin`/`headSlot` 并由 liveReader 打 `acquire ring lag: newest ring content is N min behind the wall clock … the GAME has not written newer records`（60 s 节流），同时设 `headRecheckAt = now + ACQUIRE_HEAD_RECHECK_MS(10 min)` 抑制重复全环扫描（一次扫描 = 2000 槽读，10 ms poll 下不可每批做）。
      - **配套修复（2026-09-19/20，测试实测暴露）**：①`acquireHoldReason` 的 `sameAsPreviousPass` 原要求 `k >= ACQUIRE_RING_CAPACITY` 才允许 hold——重锚定/容量自适应后 pin 标签空间与容量都可能变化，该绝对索引门控会在整趟读取中**静默禁用 hold**，让读取器直接走进未重写的旧槽（表现为反复重锚定）；门控与 `slotIdentity != null` 判定重复（指纹只在投递时写入，且单趟读取绝不重复访问同一槽：`limit ≤ from + capacity`），故整体删除。②`recoverAcquireMapping` 清空 head 指纹的边界曾硬写 `ACQUIRE_RING_CAPACITY`，容量 > 2000 时清空被跳过 → 最新条目被 hold 挡住永不下发；改为按 `slotIdentity.length` 判定。③重锚定路径**保留 pin 位置**（只移动映射），回退 pin 会重新进入已消费槽并被 hold 挡住。
      - 已知残余盲区（可接受，注释明示）：< 30 game-min 的小幅漂移会被偏移跟踪吸收而漏检（危害限于页面小幅滞后 + 短窗重复）；游戏时钟与墙钟合法漂移 > 3 h 且持续产记录的场景未观测到。
  7.  **base 采纳探针（2026-09-19）**：`counter - fill` 推导出的 base 候选此前**两 poll 确认后静默采纳**（`pin.total >= newBase` 时无任何日志——adoption 的观测盲区）。现在候选即使通过两 poll 确认，还必须赢下 **live-edge 新鲜度探针**才允许移动映射：`probeBaseCandidate` 比较 `slot(total-1-oldBase)` 与 `slot(total-1-newBase)` 两个槽位的内容——incumbent 槽位为空（= ring 被 wipe 清空，live-verified 2026-09-16）→ 采纳；候选槽位为空 / 双空 / 任一 stamp 不可解码 → 保守拒绝（清除 pending，等下一次两 poll 重新提议）；双方可读 → **stamp 离墙钟更近者胜**（游戏时间戳与墙钟 1:1），平局保 incumbent。**与 incumbent 等价的候选**（`(newBase - effectiveBase) mod capacity === 0`，典型是 base-0 会话的候选 0 对上 null 回退——同一映射）**不移动映射，直接落定、不探针、不报拒绝**（2026-09-19 线上实测：否则每 60 s 刷一条 `session base candidate REJECTED` 噪音）。映射移动型采纳/拒绝分别经 `baseAdopted` / `baseRejected`（liveReader 60 s 节流）落日志，消除盲区；附带收益：attach 到「已 wipe 且重新打满」ring 的 17 h 边界场景（原注释标记不可覆盖）也能经探针正确标定。
  8.  **写入头参照 + 上一圈保护（2026-09-20，修「重启后 2 条正确、之后全是旧记录」）**：`pin.headRefSlot` / `pin.headRefStampMin` 记录最后一次全环扫描找到的**最新内容**所在槽位与 stamp（`noteHeadRef`，稳态仲裁与 attach 时仲裁两处写入；`headRefStampMin` 距墙钟 ≤ `ACQUIRE_STAMP_WALL_TOL_MIN` 才视为可用）。`acquireParkedOnHead`（写入顺序上 head 本身或后一格）/ `acquireNearHead`（后 `ACQUIRE_HEAD_WINDOW=32` 格内）据此判定「读取器就在写入头旁边」。

      **线上诊断（09:53 重启后 dump 行）**：`head: slot=1999 stamp=09:53 lag=0min … (pin maps to slot 0)`、后续 `(pin maps to slot 6/8/14…)` —— **写入头在槽 1999 且 stamp 等于墙钟（新鲜），而 pin 在槽 0/4/6/8… 走，那里是上一圈的 `@15:xx` 旧行**。完整链条：① restart → attach 时仲裁重锚定（#1）→ 投出 1 条正确的 `@09:53`；② pin 移到下一写入格，该格仍是上一圈旧行 → stamp 护栏判「错锚定」→ 重锚定（#2）；③ 游戏 append 一条正确记录后被投出，紧接着又撞上旧行 → 重锚定（#3）；④ **40 秒内烧完 3 次 recovery 预算** → `SUSPECT` → 旧策略「deliver UNVERIFIED」开始每次 2 条把 `@15:12` 起的旧行当最新投出；⑤ **关键**：`limit = min(total, from + cap)` 把单次读取跨度**卡在计数器上**，每次只能前进 1-2 条，所以读取器**永远走不回写入头**——一整个旧圈（~2000 条）按每 poll 2 条要十几个小时。这就是用户看到的「重启后拿到 2 条正确日志，然后又错了」。

      **修复**：新增**独立的「上一圈」守卫**，位于 hold 检查之后、stamp 护栏之前：`acquireNearHead` 为真（写入顺序上在 head 之后 `ACQUIRE_HEAD_WINDOW=32` 格内、且 head 参照仍新鲜）**且**该行 stamp 距墙钟 > `ACQUIRE_STAMP_WALL_TOL_MIN` ⇒ `heldReason="stale-lap"` 停住，等游戏覆写该格（那一刻该行 stamp 就是新鲜的，等待自然解除）。

      **为什么必须独立于 stamp 护栏**：本修复第一版写进了「recovery 预算耗尽」分支，结果**只挡住了一次** —— 那次 poll 本身又通过 `pin.headRecheckAt` 把护栏重扫抑制了 10 分钟，于是**下一次 poll 整个仲裁 `if` 被跳过、直接投递了 28 条上一圈旧行**（2026-09-20 10:07:43 线上实测）。守卫不能依赖任何会被自己关闭的计时器。**释放阀**同步收紧：`acquireHoldReason` 在 `parkedOnHead`（head 本身/后一格）为真时把 `holdActiveMs` 归零、永不释放（释放阀的前提「计数器前进 ⟹ 新鲜度模型错」在停放位置不成立，释放只会吐出上一圈旧行）。**自愈**：停放/上一圈等待期间不投递 ⇒ stamp 护栏不会运行，故 `followHeadIfDue()`（由 `pin.headParkRecheckAt` 独立计时器驱动——**不能**复用 `headRecheckAt`，后者抑制护栏重扫，共用会静音护栏一整个周期）到期时做一次全环扫描，head 已在别处则重锚定并投出。远离写入头时保留原「deliver UNVERIFIED」逃生路径，避免未知映射把数据流永久卡死。

      **另一个必须记住的实现陷阱**：`followHeadIfDue` 里 `noteHeadRef` **会覆盖** `pin.headRefSlot`，所以「head 是否移动」的判断必须在调用它**之前**取出，否则永远比不出差异、自愈永不触发（第一版即如此，被既有用例当场抓住）。

      **为何所有判据都比较「与墙钟」而不是「与 head stamp」**：`[HH:MM]` 不含日期，昨天 15:12 在字符串上"大于"今天 09:53，`circDistMin` 无法区分「18 小时前」与「6 小时后」。曾据此写「stamp 落后 head 即跳过旧圈」的判据并**已废弃**（会把比 head 更新的正常条目一起跳过，当场打挂 5 个既有用例）。「这一行是不是当前时刻的」是这些 stamp 唯一能无歧义回答的问题。

      **未决**：`[HH:MM]` 与本地墙钟存在约 +6.5h 的稳定偏移（09:30 墙钟 ↔ `@16:00`），且随墙钟同步增长；08:57:13 曾出现恰好等于墙钟的 `@08:57`。**仍需对比游戏内「获得记录」面板最新一条的时间戳**才能判定是「companion 忠实但时间字段语义不同」还是「读错了时间字段」——本修复不依赖该结论。9. **【根因｜数组不是环形缓冲区，是「向下平移的定长列表」】**（2026-09-20，`scripts/dump-acquire-ring.ts` 两次整圈 dump 相隔 45 秒对比，**决定性证据**）：

      ```
      dump1 slot0=16:11 通关72秒   dump2 slot0=16:11 关卡宝箱   ← 正是 dump1 的 slot1
      dump1 slot1=16:11 关卡宝箱   dump2 slot1=16:13 普通宝箱
      dump1 slot2=16:13 普通宝箱   dump2 slot2=16:13 通关73秒
      dump1 slot3=16:13 通关73秒   dump2 slot3=16:14 通关72秒
      ```

      **`dump2[N] == dump1[N+1]`**：每次 append 后整个数组**整体向下平移一格**，新记录落在末尾（index 1999）。1680 个已提交槽中 **1515 个在 45 秒内改变了内容** —— 环形缓冲区只会变 3~4 个槽。旁证：写入头**永远**在槽 1999（`head: slot=1999 stamp=<墙钟>`）、`fill` 恒为 2000、counter 单增而 head 槽不变。

      **这解释了此前所有互相矛盾的现象**：
      - `slot = (k - sessionBase) % cap` 这个映射**在模型层面就是错的**（环形假设），所以读取器必然反复「错锚定」→ 重锚定 → 烧预算 → 灌旧数据或死等；`counter - fill` 推 base 也随之无意义（实测 `(4492-2000)%2000=492`，而 head 恒在 1999）。
      - 09-19 记的「环自身滞后 8h」不是滞后：那只是列表最旧的一端，head 一直是当前时刻（`lag=0`）。
      - 「拿到 2 条正确然后全错」：刚重锚定到 head 时读到的正是最新一条；随后 pin 前进一格就落到列表最旧的那端（数组另一端），于是要么灌旧数据、要么按「上一圈保护」死等 —— 而游戏**永远不会**如环形模型预期那样绕回来覆盖它。
      - `limit = min(total, from + cap)` 让每次只能前进 1~2 条，与游戏产出同步，所以卡住后**不可能自愈**。

      **已落地的读取模型（2026-09-20 重写 `readRuntimeAcquireLogs`）**：把数组当**按时间升序、最新在末尾**的定长列表。
      - **最新下标**：优先用列表长度 `fill`（`ring + 0x18`）⇒ `fill - 1`；该字段不可用时退回全数组 stamp 扫描（`scanAcquireHead`）。两种方法在线上互相印证（`fill=93` 时扫描同样给出 slot 92）。
      - **投递**：从最新下标**往回**逐格读取，收集「身份未投递」的条目，遇首个已投递身份即停（列表只在末尾增长，故首次重复即边界），再 `reverse()` 成时间升序投出。
      - **去重**：`pin.delivered: Map<identity, seq>`（容量 `ACQUIRE_DELIVERED_MAX=4096`，FIFO 淘汰）。**这是关键**：平移会改变条目下标但不改变身份，所以「按身份」去重天然跨平移成立，而「按下标」记账在平移下必然失效。
      - **`seq` 语义变更**：不再是「槽号」，而是**投递序号**（`pin.deliveredSeq` 单调递增）。因为下标每 append 都会平移，用它当 id 会让下游把同一条当成新条目。下游（record log / trackingService）用 seq 做 `initial` 批去重，语义仍然成立。
      - **边界/回绕**：pin 不再有「下一格」概念，也就没有回绕；末尾之后没有可读内容时当轮返回空批。
      - **`counter` 唯一剩余用途**：resume watermark 与「新游戏会话」判定（counter < resumeTotal ⇒ 重启 ⇒ 清空身份集合、按首次全量同步）。
      - **扫描预算**：首次/恢复同步为 `ACQUIRE_LIST_MAX=2000`（整表）；稳态为 `ACQUIRE_LIST_CATCHUP_MAX=256`（实际只需读 1~2 格就撞到边界）。
      - **已删除**：会话 base 标定、槽位取模映射、hold/释放阀、stamp 护栏、锚定仲裁、容量探针 —— 这些机制全部只为绕过错误的环形模型而存在。

      **线上端到端验证（2026-09-20 11:24，游戏恰为新会话）**：`scripts/dump-acquire-ring.ts --read` → `read#1: entries=93 newestIndex=92 fill=93 counter=93 seq=[1..93]`，首条 `11:07`、**末条 `11:24` = 当前墙钟**；紧接着 `read#2: entries=0`（身份边界守住、零重复）。同一时刻 `committed entries=735` 而 `fill=93`，印证「定长数组 + 长度计数，尾部残留上一会话内容」。

      **容量语义更正（2026-09-21，调试页现场反证）**：`ring+0x18` 是**定长数组的声明长度**（2048，.NET 按 2 的幂分配），**不是"游戏写入到哪里的填充计数"、也不会在新游戏会话归零**；`ACQUIRE_RING_CAPACITY=2000` 是列表满表后的**最大保留条数**。`runtime fill` 恒等于当前已提交条数（列表未满时 = counter；满表后 = 2000/2048）。早期注释里"fill 是会话内追加计数、新会话归零、base = counter - fill"的读法**已被现场推翻**（counter 36181 / fill 2048 只是"满表 + 会话级列表"）。调试页现有的两个 label（`列表长度 fill（+0x18）` = `snap.fill`、`数组声明长度` = `readI32(bufPtr + 0x18)`）**实际读的是同一字段的两次读取**，易被误读为不一致，后续应改为「已提交条数」与「底层数组容量（声明长度）」。

      **调试页（`LiveMemoryDiagnostics` → `AcquireRingViewer`）字段语义速查**：`计数器（+0x1C）` = 游戏侧单调投递计数（跨会话累计，**不是已提交条数**）；`列表长度 fill（+0x18）` = 当前已提交条数；`最新条目下标` = `fill - 1`；`已投递身份数` = worker 本次 attach 内已投递的**身份集合**大小（容量 `ACQUIRE_DELIVERED_MAX=4096`，FIFO 淘汰；**不落盘**，companion 重启或游戏开新会话（`pin.delivered.clear()`）后归零并重新全量投递）；`写入头` = 全表 stamp 扫描出的最接近墙钟的槽位（`滞后 N 分` = 它与墙钟的环形分钟距离）；`墙钟（比较基准）` = 扫描时刻的本地分钟数。

      已知未决：`+0x1C` 的 counter 与列表平移同步但槽位不自增的确切机制，以及列表满后的搬移策略（实测声明长度 2048、满时长度 2000）—— 需要更长时间序列确认。
      **测试已按列表模型重写**（`app/test/core/liveMemoryRuntime.test.ts` 的 `describe("readRuntimeAcquireLogs (shifting list)")`，12 例，替换掉原先 34 个环形模型用例）：首次全量按时间升序投出且 `seq` 从 1 起、**append 后只投递新增那一条（平移不得导致下方行被重投 —— 旧模型正是在这里重放历史）**、连续 6 次 append 每条恰好一次且不重复、满表 append 触发淘汰后仍正确、watermark 恢复只投新增尾部、watermark 高于 counter 判为新会话并做全量首同步、长度字段不可用时退回 stamp 扫描、**最新一条处于半写状态时跳过、提交后补投且只投一次**、全空数组返回空批不抛错、身份集合被清空后重新全量同步。测试夹具 `appendLine` 按真实语义实现平移（满表时整体下移一格、最旧一条被挤出）。

      `app/test/main/trackingService.test.ts` 覆盖「时间戳变化的重复行被跳过」与「ringRestarted 批不被吞」。

      **实现与游戏行为一致性核验（2026-09-21，对运行中的 v1.2.4 实测）**：用户报告「没问题了」后，对列表模型逐条做了线上复核，结论为**一致**，证据如下（`scripts/dump-acquire-ring.ts` + `%APPDATA%/tbh-companion/record_log.json`）。

      | 待核验的假设                                        | 实测证据                                                                                                                                                                                                                       | 结论                                  |
      | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
      | 「最新条目在下标 `fill-1`」                         | 满表会话 `fill=2000` → `newestIndex=1999`；另一会话 `fill=93` → `newestIndex=92`（两者均由 `scanAcquireHead` 独立扫描互相印证）                                                                                                | ✅ 一致                               |
      | 「下标顺序 = 时间顺序（0 最旧 → 末尾最新）」        | dump 全表 2000 行：slot0 `11:09` 递增至 slot1999 `02:35`；`head` 扫描独立给出 `slot=1999 stamp=02:35`                                                                                                                          | ✅ 一致                               |
      | 「写入头恒在列表末尾、游戏不会绕回覆写它」          | 间隔 45 s 两次 dump：`counter=2046` 完全不变、`head slot=1999`，`lag` 由 0→1 min；而 `record_log.json` 同期仍在持续增长                                                                                                        | ✅ 一致（列表未满 → 无淘汰 → 无平移） |
      | 「`fill` 是已提交条数、`buf+0x18` 是数组声明长度」  | `fill=2000` / `arrayLen=2048`（同一时刻），符合「容量 2000、数组按 2 的幂分配 2048」                                                                                                                                           | ✅ 一致                               |
      | 「`+0x1C` counter 不是已提交条数」                  | `counter=2046` 而 `fill=2000`（仅多 46），远小于既往观测的跨会话累计值（记录归档中可见 `ringSeq` 曾达 4585）                                                                                                                   | ✅ 一致（跨会话累计，非提交水位）     |
      | 「stamp 与墙钟 1:1（护栏阈值 180 min 有充足余量）」 | 归档 2269 条 acquire 的 `acquireTime` 对 `wallTime` 分钟差：**median = 0**，除两处历史异常外**全部为 0**（`00:00`/`01:00`/`12:00`/`13:00`… 各小时 mean 恒为 0.0）；稳态尾部 20 条 lag 全为 0                                   | ✅ 一致（wall-offset 判据成立）       |
      | 「`ringSeq` 单调、重置即新游戏会话」                | 归档全程仅 2 次回退，且成对出现在 `seq=242→245`（`4585→1`、`3→1`，同一秒 `11:07:47`）——正是中途重新 attach 触发的一次全量重投；此后 2270 条**零不连续**（仅 09-20 那次已知的重复投递对）                                       | ✅ 一致                               |
      | 「身份去重跨平移成立」                              | `--read` 连读两次：`read#1 entries=2000 newestIndex=1999`、`read#2 entries=0`（边界守住、零重复）                                                                                                                              | ✅ 一致                               |
      | 「旧环形模型的具体错法」                            | 归档 `seq=1..14`（09-20 10:07 事件）：`wallTime` 全部挤在同一秒 `10:07:43`，而 `acquireTime` 是 `10:07 → 15:34 → 15:36 → … → 15:42` 的**上一圈残留**——旧模型把列表最旧的一端当成"最新"整批灌出，与 §23.4 第 9 条的诊断完全吻合 | ✅ 已修复                             |

      两点**未决/残留**（均不影响正确性，记录备查）：
      - 归档 `seq=242..247` 出现 6 条投递（`rs=1,2,3` 各两次）——是**重新 attach 的全量重投**与 `ringSeq` 去重的已知交互：全量批带 `ringRestarted=true` 时 `ringSeqSeen` 被判为新会话而旁路去重（见 23.3）。仅重复 3 条、其后 2270 条零重复，属可接受噪声；若将来要收紧，可只在 `counter` 真正回退时置 `ringRestarted`。
      - 归档 `seq=3+` 的 `acquireTime` 为 `15:34~15:42`、`wallTime` 为 `10:07:43`：这是 09-20 旧构建残留，**新构建下未再出现**（10:00 一小时 mean lag 的 `-250.5` 全部来自这批历史数据，`11:00` 之后各小时 mean 恒为 0）。

### 23.5 边界与注意

- **排序规律**：列表按记录**读取/归档顺序（`seq` 降序）**展示，最新在最上。游戏内时间（`acquireTime`，`[HH:MM]`）**不参与排序**——它不含日期，跨会话/跨天时无法区分先后；只有 `seq`（全局递增的归档序号，worker 按环形区读取顺序 feed）能唯一确定先后。展示窗口取最新 200 条（`recentWindow`）。
- 复用现有 `onStats` 流推送（未新增 IPC channel）；未改动 `onLiveMemory` 语义。
- "获得记录"环形区**会话级**（重启清空）：`attach` 晚于游戏启动时，attach 时**仍留在环形区（最近 ~2000 条）内的会话记录**由初次全量批以 acquire 记录补全展示；已被环形区覆盖/越界的更早记录读不到（由 record_log.json 的跨会话归档承接）。以此为定位，不做跨重启的连续读取。
- 掉落/开箱/通关的事件桶读取与既有聚合（`chestDrops`/`boxOpens`/`stageRuns`/Loot）完全不受影响——它们只是**不再进入 recordLog**；本日志为独立于事件桶的"获得记录"归档。
- **环形区计数器的信任边界（2026-09-15）**：`ring+0x1C` 只能当作"游戏已经计过数的条目上界"，**不能当作"槽位已提交"的水位**——实测它领先槽位写入（见 23.4「陈旧槽位守卫」）。`total - pin.total` 长期偏大是**正常现象**，不代表滞后；判断"记录是否最新"要看**交付条目的游戏内时间戳是否跟随游戏内面板推进**，而不是看计数器差值。若记录页再次出现"新增的不是最新"，先看 `app.log` 的 `acquire hold` 与 `acquire poll` 行（前者说明守卫在拦、后者给出实际交付的 seq/时间戳区间），必要时以 `TBH_ACQUIRE_DUMP=1` 抓环形区原始 dump 定位（审计报告与现场证据见 `docs/findings/record-log-audit-2026-09-15.md`）。
- **环形区时间戳不可作为身份（2026-09-15）**：`entry+0x28` 的 `[HH:MM]` 字符串对象会被游戏**复用/改写**——同一条未重写的环形区条目隔一段时间重读，时间戳会变成"最近"的值。因此：① 展示时间仅供参考，**不要用它做排序或去重**（排序用 `seq`，去重按原文计数，见 23.3）；② 任何"时间戳回退/跳变 = 陈旧"的判据都不可靠，陈旧判定只能用「指针 + 消息文本」指纹。
- **"是否最新"看 `wall`，不看游戏时钟（2026-09-15）**：记录页每条显示两列时间——左列 `wall`（companion 收到该行的真实时刻，含日期）与右列游戏内 `[HH:MM]`。游戏内时钟是会话/游玩时钟，**不是墙钟**，实测每 44 分钟墙钟只推进 116 游戏分钟（≈2.6 倍速度），因此它天然落后墙钟 1~3 小时（15:24 时游戏钟 12:54，16:08 时 14:50）。判断记录是否实时：**看左列 `wall` / DEV 调试行的 `age=Ns`**（最新条目距今多少秒，正常为几秒~几十秒，因为游戏本身 30~60 秒才出一行）；`age` 按分钟持续增长才是真滞后。DEV 调试行格式：`dbg: total=… shown=… topSeq=… topAcq=… topWall=hh:mm:ss now=hh:mm:ss age=Ns`。
- **环形区容量：2000，已实测确认（2026-09-15 dump）**：`ACQUIRE_RING_CAPACITY=2000` 与环形区对象自己的容量字段 `ring+0x18` 一致；`buf+0x18=2048` 只是底层数组的分配长度（.NET 按 2 的幂分配），游戏取模用的是 2000——dump 中 `#29700 → slot 1700`、`#29713 → slot 1713` 直接验证了 `槽位 = 计数器 % 2000`。同一份 dump 还确认：每次追加会**新分配一个 entry 对象**（相邻索引的 entry 地址互不相同且分散），所以「指针 + 消息」指纹在槽位被覆写时必然变化，陈旧槽位守卫可用。为防将来游戏改容量，读取端每次都会读出 `declaredCapacity`（`ring+0x18`），一旦与假设不符，`liveReader` 输出一次 `acquire capacity MISMATCH: ring declares N but the reader assumes 2000 …`；容量探针（同槽两次内容变化的索引步长）继续在后台给出 `acquire ring capacity MEASURED: N …`。
