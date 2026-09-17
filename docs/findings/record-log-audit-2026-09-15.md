# Record Log 功能审计（2026-09-15）

**审计对象**：统一记录日志（Record Log / 游戏内「获得记录」复刻）。该功能当前尚未提交（`app/src/core/acquireLog.ts`、`app/src/core/recordLogTracker.ts`、`app/src/main/services/RecordLogService.ts`、`app/src/renderer/tabs/RecordLog.tsx` 均为 untracked；`liveMemory/{runtime,liveReader,worker}.ts`、`TrackingService.ts`、`stats.ts` 为 modified）。

**审计结论**：读取端存在 **P0 级错位缺陷**——初次全量读取之后，之后每一次增量读取读到的都是「环形区上一圈」的旧槽位内容，真正最新追加的「获得记录」行**永远不会被投递**。现场数据与该结论完全吻合，可直接解释用户报障：_「初次读取后，再新增的读取获得的都不是最新的 record 记录」_。

**修复状态**：P0 一期修复已实施并通过单测/类型检查（见 §7），现场复核项见 §7.4。

---

## 1. 数据链路（现状）

```
游戏进程 LogManager@0x20「获得记录」环形区（会话级、容量假设 2000、+0x1C 计数器）
  │
  ├─ worker: fastAcquirePollTimer（10ms）→ reader.pollAcquireTailFast()
  │     ├─ 首次成功 → initial=true，整圈全量（[pin.total, total) 从 0 起）
  │     └─ 之后    → initial=false，增量 [acquirePin.total, total)
  │     → post({type:"acquire", entries, initial})   // 不经 read() 帧，独立通道
  │
  └─ LiveMemoryService → appState.setOnAcquire → TrackingService.ingestAcquireBatch(entries, initial)
        ├─ initial 批按 (acquireTime, acquireRaw) 签名与归档去重
        └─ 唯一喂入口：recordLog.feed("acquire", now, {acquireRaw, acquireName, acquireCount, acquireColor, acquireTime})
              → RecordLogService.schedulePersist()（防抖 2s）→ userData/record_log.json {nextSeq, entries}
              → buildStats → Stats.recordLog（最新 200 条）→ IPC.STATS → Record Log tab（kind=acquire，按 seq 降序）

关键文件：
- 读取：app/src/core/liveMemory/runtime.ts:437-496（readRuntimeAcquireLogs）
- 调度：app/src/main/liveMemory/liveReader.ts:1201-1236（pollAcquireTailFast）、worker.ts:148-167
- 汇聚：app/src/main/services/TrackingService.ts:684-736
- 归档：app/src/core/recordLogTracker.ts、app/src/main/services/RecordLogService.ts
- 展示：app/src/main/stats.ts:209、app/src/renderer/tabs/RecordLog.tsx:72-75
```

---

## 2. P0：增量读取读的是「上一圈」的旧槽位（根因）

### 2.1 现场证据

取自本机运行中的实例（`%APPDATA%/tbh-companion/logs/app.log` 与 `record_log.json`，2026-09-15）：

| #   | 证据                                                                   | 数值                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | attach 全量批                                                          | `acquire poll: +2000 seq[27303..29302] initial=true`，14:07:35，交付内容按环形区顺序为 **07:23 → 14:07（本圈、真正最新）**，但**末尾 14 条是上一圈残留**：`02:32, 03:54, 04:36, 04:45, 05:23, 05:28, 05:31, 05:32, 06:21, 06:24, 06:26, 07:11, 07:12, 07:15` |
| E2  | 紧随其后的增量批（14:07:50 起共 112 条）**是 attach 批开头区域的重放** | 112 条中有 76 条签名命中 attach 批，且命中位置**单调递增**（B 位置 1,2,3,4,5,…,42）→ 顺序回放而非新增                                                                                                                                                        |
| E3  | 增量交付内容的时间戳始终落后环形区真实写入位置约一整圈                 | 增量批时间戳 07:25 → 09:01（14:07:50 → 14:19:57），而 attach 时环形区真实最新已是 **14:07**；`record_log.json` 最新一条（14:12）对应游戏内 **08:20**，落后约 2000 条 / 6~7 小时                                                                              |
| E4  | 归档追加量                                                             | 14:07:35 attach 批在归档中追加 539 条（含 `02:32/03:54/04:36` 等数小时前的旧行），这些旧行拿到**最新 seq**，在 UI（按 seq 倒序）里排到最上方                                                                                                                 |

E1 直接证明：`total`(=29303) 所声称「已提交」的尾部槽位**尚未被本圈写入**——即 `ring + 0x1C` 计数器与环形区槽位写入**不同步，计数器跑在真实写入位置前面**。
E2 证明：pin 一旦推进到 `total`，此后每次读取都会命中「同槽 = 上一圈内容」的槽位，形成恒定错位。

### 2.2 代码层原因

`app/src/core/liveMemory/runtime.ts:437-496`：

```ts
const total = readI32(reader, ringObj + BigInt(ACQUIRE_SLOT_COUNTER_OFF)); // 0x1C
if (pin.total > total) pin.total = 0;
...
const start = Math.max(0, pin.total);
const end = total;                                        // ← 把计数器当作"已提交水位"
const from = Math.max(start, end - ACQUIRE_RING_CAPACITY);
for (let k = from; k < end; k++) {
  const slot = k % ACQUIRE_RING_CAPACITY;                  // ← 槽位靠硬编码 2000 取模
  ...
  if (entryPtr == null || entryPtr === 0n) break;           // ← 只挡"槽位指针未写"
  if (!message) break;                                      // ← 只挡"消息未写完"
  entries.push({ seq: k + 1, ... });
  deliveredUpTo = k + 1;
}
if (deliveredUpTo > pin.total) pin.total = deliveredUpTo;   // ← 无条件推进 pin
```

三个缺陷叠加：

1. **把 `ring+0x1C` 当作「已提交条数」**：实测该计数器超前于真实写入位置（E1 的 14 条残留即超前量）。`end = total` 因此包含尚未写入的槽位。
2. **半写保护对「旧内容」无效**：`break` 只覆盖 `entryPtr == null` / 消息解不出；而**未被本圈覆盖的槽位里躺着上一圈的完整条目**（指针合法、字符串可解码），现有校验无法区分，于是被当成新记录投递。
3. **pin 无条件推进**：被误判的旧条目也会让 `deliveredUpTo` 前进，pin 越过真实写入位置后就再也回不去——此后每次读取都命中「同槽 = 上一圈」，形成**恒定一整圈的滞后**，且不会自愈（没有任何落后告警/回退机制）。

另：`ACQUIRE_RING_CAPACITY = 2000` 为硬编码，未与游戏实际容量/取模关系做任何校验（`liveMemoryRuntime.test.ts:2044-2170` 的 `seedAcquireRing` 只写 1~3 条、从不 wrap，无法暴露该假设错误）。

---

## 3. 次要发现

### P1 重新 attach 的 initial 批去重是「全有或全无」，会漏新行 / 重加旧行

`TrackingService.ts:691-705` 用 `(acquireTime, acquireRaw)` 作签名，而该键**不唯一**：同一游戏分钟内同文案可重复几十次（归档实测 `('07:13','获得了章节首领宝箱。(执政者莫尔卡)')` ×30、`('15:06', …)` ×30、`('18:22','通关了关卡 3-10。(4秒)')` ×26）。

- 签名已在档 → **整组跳过**：若本批中该文案出现次数多于档中记录数，多出来的**真新行被丢弃**。
- 签名已从档中被淘汰（归档 cap 10000）→ **旧行被重新追加**拿到最新 seq，UI 上排到最上方（见 E4）。
- 正确做法应按「环形区槽位 + entryPtr」或环形区序号去重，或退化为**计数式去重**（只跳过档中已有的同等数量）。

### P2 initial 批共享 wallTime，进一步干扰「最新」的判读

`TrackingService.ts:687` `const ts = Date.now()/1000` 对整个批只取一次。initial 批最多 2000 行共用同一 wallTime，UI（`RecordLog.tsx:54-61` 显示 `fmtWall`）会把它们全部显示为同一时刻；叠加 P1 的旧行重加，用户很难判断哪条才是最新。

### P3 缺少「落后/错位」自愈与告警

读取端没有对「交付内容相对环形区真实写入位置落后」的检测（如 `total - pin.total` 差值上限、时间戳回退、seq 连续性），因此本次错位可以静默持续数小时。建议至少落一条 warn（含 `total / pin.total / 本批首末时间戳`）。

### P4 测试盲区

- `app/test/core/liveMemoryRuntime.test.ts`：只覆盖 1~3 条、不 wrap、不模拟「计数器超前于槽位写入」。
- `app/test/core/recordLog.test.ts`：只测 tracker 自身，不覆盖 `ingestAcquireBatch` 的 initial 去重与错位场景。
- 缺一条端到端（污染环形区 → poll → ingest → stats）的回归测试。

---

## 4. 修复方案（已按此实施，见 §7）

**前置动作（必须先做）**：把环形区语义钉死。建议加一个环境变量门控的 dump（复用现有 `TBH_ACQUIRE_DEBUG` 模式）：

```
TBH_ACQUIRE_DUMP=1 → 每 ~200ms 输出：
  total=<0x1C 计数器>  ringObj=0x…  bufPtr=0x…  elemBase=0x…
  每个 slot：entryPtr + message 前 24 字 + time
```

连续对比两次输出，确认：① 计数器 vs 真实写入槽位谁在前、超前多少；② 槽位里的 entryPtr 是「每槽固定结构体」还是「每次追加新分配」。这两点决定修复选型。

**修复方向（按优先级）**

1. **引入「已提交水位」而非直接用计数器**：把 `end` 限制为已确认写入的位置。最稳妥的自愈判据是**槽位变化检测**——记录每个 slot 上次读到的 `entryPtr`；当 `k >= CAPACITY` 且该 slot 的 `entryPtr` 与上一圈相同时，视为「本圈尚未覆盖」→ `break`（沿用既有 mid-write 重试策略，pin 不推进，下一轮重试），并加连续重试上限（对齐 `readRuntimeChestLog` 的 `retryConsecutive` / `MAX_CHEST_LOG_RETRIES` 模式）以防真·固定结构体导致卡死。
2. **pin 回退/校正**：为 pin 增加「已确认水位」与「本圈起点」两个字段，允许在检测到错位时把 pin 重定位到真实写入位置（而不是单向推进）。
3. **容量自校验**：从环形区对象读取真实槽位数组长度/容量替代硬编码 2000，并在启动时校验（不一致则记 warn 并采用实测值）。
4. **P1 去重改为计数式或槽位式**（见 P1），避免漏新行 / 重加旧行。
5. **可观测性**：错位/落后/回退统一记 warn（含 `total`、`pin.total`、批首末 `time`），便于后续回归。

**落地后必须同步**：`docs/BUSINESS-FLOWS.md` 第 23 章（统一记录日志）的数据流、去重规则、关键文件速查表，以及 `docs/agent/QA.md` 要求的测试补充。

---

## 5. 复现与验证清单

| 步骤                                                                           | 期望                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 游戏运行中启动 companion，观察 `app.log` 的 `acquire poll` 与 `acquire ingest` | initial 批之后，增量批的时间戳应**≥ 环形区当前最新**；不得出现「增量批是 initial 批开头区域的重放」 |
| 对比游戏内「获得记录」面板最新 5 行 与 Record tab 顶部 5 行                    | 一致（允许 ≤1 个 poll 的延迟）                                                                      |
| 校验 `record_log.json` 最新一条的 `acquireTime`                                | 与游戏内面板最新行一致，落后不得超过个位数分钟                                                      |
| 单元测试：真 wrap（写入 >2000 条）+「计数器超前写入位置」用例                  | 增量只返回新行；错位场景下不投递旧行且 pin 不前越                                                   |
| 长跑 30 分钟                                                                   | `total - pin.total` 稳定在环形区容量以内，无持续增长                                                |

---

## 6. 未决问题

1. `ring + 0x1C` 的确切语义（是否计数非 acquire 日志、是否含预分配偏移）——需 §4 的 dump 结论。
2. 追加条目是「每槽固定结构体就地覆写」还是「每次新分配」——决定槽位变化检测是否可用。
3. 环形区真实容量（是否恰为 2000）与越界取模策略。

以上三点确定后，P0 修复即可一次成型。**P0 的一期修复不依赖这三点**（见 §7），但它们的结论会决定是否还需要二期收紧。

---

## 7. 修复状态（2026-09-15 已实施）

### 7.1 改动

| 文件                                      | 改动                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src/core/liveMemory/runtime.ts`      | `AcquireRingPinState` 新增 `slotFingerprint` / `lastTime` / hold 记账字段；`readRuntimeAcquireLogs` 读取锚点由「计数器」改为「读取端位置 + 双重新鲜度判定」，新增 `acquireHoldReason` / `acquireFingerprint` / `acquireStampMinutes` 与 `AcquireHoldReason` 类型、`ACQUIRE_STAMP_REGRESSION_MIN=10min` / `ACQUIRE_STAMP_WRAP_MIN=20h` / `ACQUIRE_HOLD_RELEASE_MS=15s`；新增 `dumpRuntimeAcquireRing` |
| `app/src/main/liveMemory/liveReader.ts`   | `pollAcquireTailFast` 上报 hold；新增 `logAcquireHold`（节流 5s + 槽位变化立即记）与 `dumpAcquireRing`                                                                                                                                                                                                                                                                                               |
| `app/src/main/liveMemory/worker.ts`       | `TBH_ACQUIRE_DUMP=1` 时每 500ms 输出一次环形区原始 dump（stop 时同步清理定时器）                                                                                                                                                                                                                                                                                                                     |
| `app/test/core/liveMemoryRuntime.test.ts` | 新增 4 个用例（计数器超前、fresh reader 接缝、RELEASED 兜底、空闲不过期）+ 4 个 wrapped-ring 测试辅助                                                                                                                                                                                                                                                                                                |
| `docs/BUSINESS-FLOWS.md` §23              | 数据流、去重、错误处理、边界四节同步更新                                                                                                                                                                                                                                                                                                                                                             |

### 7.2 修复语义（为什么能自愈）

1. **锚点**：稳态 `from = acquirePin.total`（读取端位置），只在 pin=0 时锚定 `total - CAPACITY` 取最新窗口；单轮最多续读一圈，落后多时用连续几轮追平。
2. **停机而非投递**：命中「同槽指纹未变」或「时间戳回退（≥10min 且 <20h）」→ `break`，pin 停在被停住的索引，下一轮重试。被停住的槽位**正是下一次写入的目标**，所以游戏一追加就自然解除——这使修复自带自愈，不需要额外对齐逻辑。
3. **兜底**：同一槽位在计数器持续前进的情况下被停 >15s → `released`（交付 + `acquire hold (RELEASED)` 日志），避免模型判断错误时永久停顿；计数器静止时不过期（没有新行可交付）。

### 7.3 验证

- `test/core/liveMemoryRuntime.test.ts`：101 passed（含 4 个新用例）。
- `test/core`：63 files / 898 tests passed。
- `pnpm typecheck`：通过；改动文件 `prettier --check` / `eslint` 均干净。
- 已知既有失败（与本次改动无关）：`test/main/lookupPricePollingService.test.ts` 9/27 失败，**单独运行同样失败**，且该文件不引用 liveMemory/acquire/runtime。

### 7.4 待现场复核（需要游戏运行）

1. `app.log` 中 attach 之后的 `acquire poll` 行，其 `last="…" @HH:MM` 应**跟随游戏内面板**推进；不再出现「增量批回放 attach 批开头区域」的现象。
2. `record_log.json` 最新条目的 `acquireTime` 与游戏内「获得记录」面板最新行一致（允许 ≤1 个 poll 的延迟）。
3. `acquire hold` 行应在记录停滞时出现（stale-slot / stamp-regression），且很快被后续追加解除；不应出现持续的 `RELEASED`。
4. 长时间运行后 `total - pin.total` 允许稳定在较大值（计数器超前），只要 2 成立即视为正常。

### 7.5 二期（可选，待 §6 结论）

- 用真实容量替代硬编码 2000（从数组头读取长度并校验）。
- P1 去重改为计数式/槽位式，消除 initial 批「全有或全无」的漏新行与旧行重加。
- initial 批的 `wallTime` 逐条取值（或标注为补录），避免整批同一显示时刻。

---

## 8. 复查（2026-09-15 14:52 现场）：第二个根因

修复上线后（构建产物已确认含 `acquire hold`/`heldReason`）**没有任何 hold 触发**，且用户复报「新增的还是之前的记录」。现场数据推翻了一期判据并给出真正的机制：

| #   | 证据                                        | 说明                                                                                                                                                                                              |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5  | 同一环形区条目重读后**时间戳变了**          | 归档 seq=18077 记的是 `14:07` 的 `通关了关卡 3-10。(4秒)`；同一个槽位在 14:52 的 attach 批里又是这条，却带 `14:40`。→ 游戏**复用/改写** `entry+0x28` 指向的时间字符串对象                         |
| E6  | 我的「时间戳回退」判据因此永不成立          | `app.log` 中 0 条 `acquire hold`。且回退量常超出 `ACQUIRE_STAMP_WRAP_MIN`（20h，被当作跨天回绕放行），双重失效                                                                                    |
| E7  | 去重键 `(acquireTime, acquireRaw)` 随之失效 | 14:52:14 的 initial 全量往归档追加了 **108 条**，其中 107 条的原文早已在归档里（`longest contiguous run = 10/108`、`3-gram` 命中 51/106、`multiset` 命中 107/108）→ 旧行拿到最新 seq 堆到列表顶部 |
| E8  | 每次重启都会灌一批                          | 14:07:35 attach 追加 539 条、14:52:14 attach 追加 108 条，两次都含数小时前的旧行                                                                                                                  |

**结论**：`(时间戳, 原文)` 不能作为环形区条目的身份——**时间戳不是稳定字段**。据此改：

1. **读取端身份改为「指针 + 消息文本」**（`acquireIdentity`：`entryPtr|msgPtr|message`）——不受游戏改写时间串影响；槽位被重写时指针或文本必然变化。**「时间戳回退」判据整体删除**（不可靠，且它的跨天放行正是漏检原因）。
2. **重装 attach 的去重改为「按原文计数消费」**（`RecordLogTracker.acquireRawCount` + `TrackingService.ingestAcquireBatch` 的 budget）：跳过归档里已有的同等数量，其余保留（真实新增的重复行不丢）。原文稳定，因此 E7 类问题不再发生。
3. **区分「环形区重启」**：`pollAcquireTailFast` 返回 `ringRestarted`（worker → LiveMemoryService → appState → ingest 全链路透传），新游戏会话的 initial 批**绕过**计数去重——否则新会话开头那几行会因文本重复被误吞。
4. **容量探针**（见 §9）：不再"假设 2000"，而是实测。
5. 释放阀 15s → **5s**（新鲜度判据改为指针+文本后误判概率更低，缩短兜底延迟）。

回归：`test/core/liveMemoryRuntime.test.ts` 新增「改时间串不影响 hold」；`test/main/trackingService.test.ts` 新增「时间戳变化的重复行被跳过」与「ringRestarted 批不被吞」。

---

## 9. 环形区容量假设（2000）验证 + 「大于 2000」的影响

### 9.1 代码对 2000 的四处依赖

| 用途                   | 表达式                | 错的后果                                                                             |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| 槽位定位（**语义性**） | `slot = k % 2000`     | 读到的条目不是索引对应的那一条：内容错乱、新旧混杂、`seq` 与真实追加序号解耦         |
| 首次窗口锚点           | `from = total - 2000` | 初次全量漏最新一段、多带一段旧的                                                     |
| 单轮续读上界           | `limit = from + 2000` | 追平速度与"跳过未读"边界错误                                                         |
| 陈旧判定门槛           | `k >= 2000`           | 若 C>2000，索引 2000 对应的槽位其实还没被写过 → 可能误判为陈旧而停机（靠释放阀兜底） |

### 9.2 已有的间接证据（**弱**）

现场 stale tail 的旧内容比最新行早 5.7 游戏小时，而实测追加速率 = 256 条 / 44.6 分钟 = 5.7 条/分钟 → 一个环 ≈ 2000 条 ≈ 5.8 小时 ✓ 与 2000 相符。**但时间戳不可靠（E5），所以这只是弱证据。**

### 9.3 直接测量（已实现，运行时自动给出）

`readRuntimeAcquireLogs` 带**容量探针**：记录 0 号槽位内容最近一次"发生变化"的索引，两次变化之间正好一个环长 → `pin.capacityEstimate`；`liveReader` 在变化时输出：

```
acquire ring capacity MEASURED: N entries per slot cycle (assumed 2000 — matches | MISMATCH!)
```

连续跑满一个环（≈2000 条追加，当前速率约 6 小时）即得确定值；要立刻拿到，用 `TBH_ACQUIRE_DUMP=1` 启动——dump 里含 `buf+0x18 / buf+0x1C / ring+0x18` 长度探针与尾部 24 槽的 `entryPtr`，可用于判定真实容量与「每槽结构体是否就地覆写」。

### 9.4 如果实际容量 > 2000 会怎样

1. **槽位错位（致命）**：每过一次环漂移 `(C_game mod 2000)`，读到别人的条目 → 列表内容错乱。
2. **首窗取错**：`total - 2000` 不再等于最新 2000 条。
3. **陈旧判定误报**：`k >= 2000` 门槛失效 → 对全新槽位误判 → 5s 释放阀兜底 → 记录偶发延迟。
4. **静默丢行**：pin 仍单调推进，真正最新的行被跳过，并在每次 attach 时以旧行形式灌回列表（即用户看到的"新增的还是之前的记录"的另一种形态）。
5. 探针会直接报 `MISMATCH!`，dump 的长度探针也会暴露。

### 9.5 若容量 ≠ 2000 的修复方向

- pin 增加 `effectiveCapacity`（默认 2000），探针（或 dump 读到的数组长度）给出可信值后用它替换 `slot = k % capacity`、窗口锚点、续读上界，并记 warn。
- 若容量无法稳定测量：当前实现（**以 pin 为锚 + 指针/文本指纹守卫**）本身不依赖容量正确性，只是会多几次 hold/延迟——即容量错误不会再造成静默丢行。

### 9.6 判定：容量 = 2000（2026-09-15 15:37 dump 实测，**假设成立**）

```
acquire dump: total=29708 pin=29708 slotCounter=+0x1C ring=0x253ce535270 buf=0x253ddc59000 elemBase=0x253ddc59020
  len probes: buf+0x18=2048  buf+0x1C=0  ring+0x18=2000  (assumed capacity=2000)
  #29700 slot=1700 entry=0x253dc9e3f00 t=13:30 …
  #29707 slot=1707 entry=0x253cfef7ba0 t=13:33 …
  #29713 slot=1713 entry=0x253dc2f1d20 t=13:38 …
```

| 证据                                                             | 结论                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ring+0x18 = 2000`                                               | 环形区对象**自己声明的容量就是 2000**，与代码假设一致 ✓                                                   |
| `buf+0x18 = 2048`                                                | `2048` 是底层数组的**分配长度**（.NET 数组按 2 的幂分配），逻辑容量仍是 2000；游戏取模用 2000 而非 2048 ✓ |
| `#29700 → slot 1700`、`#29707 → slot 1707`、`#29713 → slot 1713` | 槽位 = `k % 2000` **被实测数据直接验证** ✓                                                                |
| `total == pin`、尾部 8 槽时间戳递增（13:30→13:38）               | 无滞后、无陈旧尾部；本期 `acquire hold` 触发 0 次（没有需要拦截的错位）                                   |
| 连续槽位的 `entry` 地址互不相同且分散                            | 每次追加**新分配一个 entry 对象** → 「指针 + 消息」指纹在槽位被覆写时必然变化 ✓（指纹守卫可用）           |
| `ring+0x10` 指向的数组元素区从 `+0x20` 起                        | 与 `ACQUIRE_ELEM_BASE_REL = 0x20` 一致，元素步长 8 字节 ✓                                                 |

**结论**：`ACQUIRE_RING_CAPACITY = 2000` 对 v1.2.2 成立，§9.4 的"大于 2000"风险不适用于当前版本。已把 `ring+0x18` 做成**运行期自检**：`readRuntimeAcquireLogs` 每次读出 `declaredCapacity`，`liveReader` 一旦发现与假设不符就输出一次 `acquire capacity MISMATCH: …`，避免将来游戏改容量时又被静默错位。

环形区完整布局（实测）：

```
LogManager + 0x20 → ring 对象 { +0x10: 元素指针数组(分配 2048), +0x18: 容量 2000, +0x1C: 单调计数器 }
entry { +0x18: category 字符串, +0x20: 消息字符串, +0x28: 时间字符串(游戏会改写) }
槽位 = 计数器 % 2000；元素地址 = buf + 0x20 + slot * 8
```

---

## 10. 重启现场验证（2026-09-15 15:23）

| #   | 观测                                                                                                                        | 结论                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| V1  | `15:23:50.929 acquire poll: +2000 seq[27667..29666] initial=true ringRestarted=false`，**其后没有任何 `acquire ingest` 行** | 该日志只在真正追加了新行时打印 → 2000 条存量**一条都没进归档**（对比 14:52 那次追加 108 条旧行）→ ①「重启后旧行灌顶」已修 |
| V2  | 增量 `seq` 连续无跳号（29667→29690…），`ringRestarted=false deduped=0`                                                      | 增量逐条交付，无跳过                                                                                                      |
| V3  | 本 run **0 条 `acquire hold`**                                                                                              | 该时段不存在"读到未写入槽位"的情形（守卫无触发即无需要拦截的错位）；保持可观测即可                                        |
| V4  | `TBH_ACQUIRE_DUMP=1` 重启后 dump count = 0，但 `TBH_ACQUIRE_DEBUG=1` 的 `acquire dbg` 有输出                                | env 传到 worker 本身正常，是那次启动没带上该变量 → 改为**主进程下发策略**（dev 默认开+限量），不再依赖启动方式            |

### 10.1 去重策略再修正（避免引入新的漏行）

先落地的「按原文计数预算」有一个**新引入的数据丢失风险**：文案本身高度重复（`通关了关卡 3-9。(71秒)` 在归档里有数百条），预算会把**关掉应用期间真实漏掉的新行**一并吞掉——而那正是 attach 全量存在的意义。

改为 **`RecordLogTracker.acquireDeliveryOverlap(batchRaw)`**：归档尾部与 batch 同为环形区顺序，batch 的前缀恰好等于上一会话最后交付的那段，取「batch 前缀 == 归档尾部」的**最长连续重叠**，**第一条不匹配即停**。既去噪（V1）又不吞新行（含离线期间漏掉的）。`ringRestarted` 批仍绕过。

### 10.2 当前状态

- 已修：读取端错位守卫（指针+消息指纹）、重装存量重灌、离线漏行保护、容量探针、dump 策略下发。
- 待确认（需一次重启）：dump 的 `len probes`/`innerLen` 与 `acquire ring capacity MEASURED` → 容量的确定值；若 ≠ 2000，按 §9.5 替换模数。
- 测试：`test/core` + `test/main/trackingService.test.ts` 956 passed；`tsc` 0 错误；改动文件 prettier/eslint 干净。

---

## 12. 三次迭代后的终版去重：按环形区索引 `ringSeq`（16:40 现场驱动）

### 12.1 16:40:53 现场：交付顺序重叠对齐失效

一次 attach 的 initial 批 `+2000 … deduped=0` —— **2000 条全部重灌**。离线复现：batch 与归档尾部的理想对齐在**第 3 行**就失配（归档缺一条 `获得了普通宝箱。(电流的地狱祭司)`——上个会话漏交付的行）。「精确连续前缀 == 归档尾部」的对齐只要归档里差一行就整体崩塌 → 99.9% 重复的批被全额重灌。

### 12.2 终版方案：`ringSeq`（环形区索引）随条目持久化

| 改动                                 | 内容                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `shared/types.ts`                    | `RecordLogEntry.ringSeq?: number` —— 该行在环形区中的索引（`AcquireLogEntry.seq`，游戏会话内 1-based 单调） |
| `recordLogTracker.ts`                | `ringSeqSeen: Set<number>`（feed/evict/recompute 三处维护）+ `hasRingSeq(n)`                                |
| `TrackingService.ingestAcquireBatch` | feed 时写入 `ringSeq: a.seq`；initial 且非 ringRestarted 时按 `hasRingSeq(a.seq)` 逐条跳过                  |

为什么 `ringSeq` 是正确身份：时间串会被游戏改写（E5）、文本会逐字重复（几百条同文）、交付顺序会被漏行打断（§12.1）——唯独环形区索引在**同一游戏会话内**精确且单调。它同时满足：① 已归档 → 跳过（不重灌）；② 不在 → 补上（离线/漏行的行被恢复，而非吞掉）；③ 与时间串、文本、顺序全部无关。

### 12.3 边界

- **环形区重启（新游戏会话）**：索引从 1 重来，与旧会话的索引冲突 → `ringRestarted=true` 的批**绕过去重**（新会话的行全是新的）✓ 已全链路透传。
- **容量驱逐**：条目被挤出 10000 归档时其 ringSeq 一并移出集合 → 若该行再被交付会重新归档（正确：它已不在归档里）。
- **跨会话索引冲突**：旧会话 ringSeq 1..N 与新会话 1..M 在集合中合并；initial 批的去重对重启批已旁路，增量批本就不去重 → 无误伤。残余风险：新会话某行恰好命中旧会话同号且该行尚未交付时会被误跳（罕见、单行、自愈于下一次全量）。
- **测试隔离**：单测写真实归档，必须用高位唯一 ringSeq（`900000+`），避免污染真实去重集合。

### 12.4 验证

`test/core` + `test/main/trackingService.test.ts`：957 passed（含 ringSeq 去重/驱逐/快照重建、时间串改写免疫、ringRestarted 旁路）；DOM 284 passed；`tsc` 0；prettier/eslint 干净。

---

## 13. 终版补丁：断点续读（持久化读取位置水印）

### 13.1 ringSeq 去重的冷start盲区（19:29 现场）

```
19:29:08  acquire poll: +2000 seq[28679..30678] initial=true
19:29:08  acquire ingest: 2000 lines initial=true deduped=0   ← 又整批重灌
```

原因：`ringSeq` 是今天才加的字段——**归档里的全部历史条目都没有它**，`ringSeqSeen` 在 attach 时是空的，按索引去重对旧数据无效（冷启动）。修好后需要喂满一个归档窗口才能自愈，但用户在此之前每次重启都会看到重灌。

### 13.2 方案：把"读到哪里"持久化（与归档内容无关，无冷启动）

| 环节                | 改动                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `record_log.json`   | 新增 `acquireWatermark`（读取端最后交付的环形区索引），随归档防抖落盘                                                                                  |
| `RecordLogService`  | `get/setAcquireWatermark`、load/persist/reset 三处维护；`resetStorage`（Settings 清除）一并清零                                                        |
| `TrackingService`   | `ingestAcquireBatch(..., watermark?)` → `setAcquireWatermark(watermark)`（**去重后也要推进**，跳过的行同样代表位置前移）；新增 `getAcquireWatermark()` |
| `LiveMemoryService` | `setAcquireResume(total)`：fork 后向 worker postMessage `{type:"acquireResume", total}`；也支持 spawn 后补发                                           |
| `worker.ts`         | 处理 `acquireResume` → `reader.setAcquireResume(total)`                                                                                                |
| `liveReader.ts`     | `pollAcquireTailFast` 返回 `watermark`（本批后的 pin）；`res.resumed` → 该批按普通增量（不标 initial，不走去重）                                       |
| `runtime.ts`        | pin 增 `resumeTotal/resumeApplied`；首次读取时校验并应用（见 13.3）                                                                                    |

### 13.3 续读规则（`readRuntimeAcquireLogs`，一次性）

```
counter ≥ watermark 且 counter − watermark ≤ 2000 → pin = watermark，resumed=true
      （只交付上次关机之后的新行；该批按普通增量，不走 initial 去重）
counter <  watermark                              → 环形区重启（新游戏会话）
      → restartDetected=true：rewind 到 0 全量展示，且该批旁路去重
counter − watermark > 2000                        → 离线超过一整个环，水印失效
      → 忽略水印，回到"最新窗口锚点 + ringSeq 去重"兜底
```

### 13.4 验证

`readRuntimeAcquireLogs` 新增 3 个用例：续读只交付差量（29500 → 1 条）、计数器低于水印判定重启（新会话 3 条全交付且旁路）、水印落后超过一环被忽略（全窗锚点）。合计 core+trackingService **960 passed**、DOM 284 passed、`tsc` 0、prettier/eslint 干净。

### 13.5 用户侧预期

- 重启 companion：不再出现"重读一整圈旧日志"，列表顶部直接是关机后新产生的行；
- 重启游戏（新会话）：环形区清空，新会话存量全量展示（`ringRestarted=true`）；
- companion 关闭超过约 6 小时（>2000 条追加）：被环形区覆盖的部分物理丢失（游戏只保留 2000 条），其余照常恢复；
- Settings 清除 Record log：归档与水印同时清零，回到"首次运行"语义。

### 13.6 09-16 19:11 复核：消息时序竞态（已修）

水印已落盘（`acquireWatermark: 35974` ✓），但重启后仍整窗重放，日志显示：

```
19:11:52.797  acquire poll: +2000 … initial=true            ← 首次读取
19:11:52.801  acquire resume watermark: none                ← 水印消息 4ms 后才到，且值为 none
```

两个叠加问题：① `setAcquireResume` 只存值没有推送给**已 fork** 的 worker（而 appState 在 `start()` 之后才调它）；② fork 时先发了一条 `total: null`。修复：`setAcquireResume` 立即向存活 worker 推送；fork 时仅在已有水印时补发。时序上 fork 后 ~10ms 消息即入队，而首次读取需等 attach + offset 解析（秒级），竞态窗口消除。复核后 `test/core`+trackingService 960 passed、`tsc` 0。

### 13.7 09-16 19:24 复核：水印续读生效 ✓

```
19:24:32.239  acquire poll: +2000 seq[34029..36028] initial=true   ← fork 后首次读取（仍全窗）
19:24:32.243  acquire resume watermark: 36028                       ← 水印消息 4ms 后到达
19:24:43.915  acquire poll: +2 seq[36029..36030] initial=false      ← 紧接水印的下一格
```

竞态窗口仍在（首次 poll 比水印消息早 4ms），但结局正确：initial 批次 2000 条的 seq 全部 ≤ 水印 36028，被 `ringSeq` 去重整体跳过（`dirty=false`，连 ingest 行都不打），首个真实交付批次从 `seq[36029..36030]` 开始——恰为水印 +1，此后全部 `deduped=0` 增量，无 gap 无重复。§13.6 的修复成立。

---

## 14. Settings 清理入口缺失（09-16 19:32 用户报告）——已补

用户在 Settings 找不到"清理 record log"。排查结论：**主进程早已完备，UI 层漏接**——

- `appData.ts`：`filesForClearTarget("record-log")`、paths entries「Record log」、`appState.clearAppData` 的 `reloadRecordLog → tracking.resetRecordLog()` 全部存在；
- `Settings.tsx`：`CLEAR_ACTION_TARGETS` 数组漏了 `"record-log"`（`stage-runs` 同样不在列表里）；
- i18n：四个语言的 `clearActions` 均无 `record-log` 键。

修复：`CLEAR_ACTION_TARGETS` 在 `box-timers` 与 `session` 之间补 `"record-log"`；zh-CN/en/ja/ko 四份 `settings.json` 的 `clearActions` 补 `record-log.{label,detail,confirm}`（"清除记录日志"）。入口位置：**设置 → 高级 —— 日志与缓存数据（折叠面板）→ 数据与缓存 → 清除记录日志**。清除后 `record_log.json` 删除 + 内存 tracker/水印归零，回到"首次运行"语义（§13.5）。QA：`tsc` 0、eslint 干净、locale 三件套 32 passed、四份 JSON `JSON.parse` 通过。

---

## 11. 复核：「16 点了读到的才是 12 点」不是滞后，是两个时钟

用户的复报（16:0x）来自**游戏内时钟 vs 墙钟**的混淆，读取链路本身是实时的。16:08~16:10 实测证据：

| 观测         | 数值                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 归档最新几条 | `seq=22757 wall=16:10:07 stamp=14:53`、`seq=22754 wall=16:10:07 stamp=14:52`、`seq=22753 wall=16:08:52 stamp=14:50`                                            |
| 同时刻 dump  | `total=29852 pin=29852`、`lastStamp=14:50`、`holdSlot=-`                                                                                                       |
| 结论         | 归档最新条目与环形区最新条目**是同一条**（都 14:50）→ 读取端 `pin == total`、**零滞后**                                                                        |
| 时钟关系     | 15:24 时游戏钟 = 12:54；16:08 时 = 14:50 ⇒ **每 44 分钟墙钟推进 116 游戏分钟（≈2.6 倍）**，这是游戏的会话/游玩时钟，**不是墙钟**，天然落后于墙钟（且正在追赶） |

即 `wall`（我们收到的时刻）永远是"刚刚"，`stamp` 是游戏自己的 HH:MM——两者差 1~3 小时属正常。

**让"是否最新"一眼可判**：Record Log 页的 DEV 调试行新增 `now=` 与 `age=Ns`（最新条目距今多少秒，DEV 下 1 秒一跳）。判据：

- `age` 在几秒~几十秒（游戏本身 30~60 秒才出一行）→ **数据是最新的**；
- `age` 持续按分钟增长 → 才是真的滞后，去看 `app.log` 的 `acquire hold` / `acquire poll`。

**唯一剩余疑问（需用户确认）**：游戏内「获得记录」面板此刻显示的是 `14:5x`（与我们读到的 `entry+0x28` 一致）还是 `16:0x`（墙钟）？若面板显示墙钟，说明面板渲染的不是 `+0x28` 这个字符串（另有字段或运行时计算），那么 `acquireTime` 的取值需要另找来源——但记录**内容**仍是实时最新的，只是展示时间不同。

---

## 15. 游戏清空环形区后读取失联（09-16 20:1x 用户报告）——已修

用户报告："游戏 record 清除后，程序缓存也清除了，然后游戏新产生的 record 程序没有反应"。用户在 Settings 点了两次新补的"清除记录日志"（19:55:31 / 19:55:57），随后游戏进入新周目，companion 不再读取任何新记录。

### 15.1 现场证据（app.log + lm32 dump）

- 19:55:31 / 19:55:57 两次 `Cache cleared (record-log)`；首次清除后 ingest 正常（total 6→18）；
- 19:56 游戏重开新周目：`LogManager unavailable`（模块重载）、chest log 344→1；
- 关键 DBG 行：环形区 **fill（+0x18）= 4 → 24 重计**，而 **counter（+0x1C）= 36165 → 36185 跨清空延续、不回落**；新条目落在 slot 0..7，而 worker 按旧公式读 slot 173+ 全为 null → 静默空 poll。

### 15.2 根因：+0x18 的语义不是容量，slot 基址假设失效

- 旧假设：`ring+0x18` = 容量（此前填满时恰等于 2000，被误当作容量验证通过）；实测它是**会话内填充数** fill = min(会话内条数, 2000)，游戏清空环形区（新周目/新会话）时 fill 归零重计，**counter 不复位**。
- 因此新会话条目的真实 slot = `(k − base) % 2000`，其中 base = 会话起点 counter 值 = `counter − fill`；旧代码用 `slot = k % 2000`（仅 base=0 的会话正确）。清空后 base ≈ 36161 ≠ 0，pin 停在旧位置、待读槽位全部读空 → "没有反应"。
- 旧重启检测（`counter < watermark` / `pin.total > total`）对"counter 不回落的清空"完全探测不到。

### 15.3 修复（runtime.ts）：fill 驱动的 session base 校准 + 重锚

- `AcquireRingPinState` 新增 `sessionBase` / `sessionBasePending`；回落分支（旧 `pin.total > total`）同时清空二者。
- 每次 poll 由 fill 推导 `newBase = total − fillCount`（fill < 2000 时精确）：
  - `newBase === sessionBase` → 健康，清 pending；
  - `pending === newBase` → **两连读确认**（防 counter/fill 非原子更新在 append 瞬间产生的 ±1 瞬态抖动被误判为 wipe）→ 采纳新 base；
  - 否则记 pending 等下一读。
- 采纳后若 `pin.total < newBase`（pin 落在新会话起点之前，含 resume 水印早于清空的情形）：`pin.total = newBase`、`slotIdentity` 清空、`lastTime`/`holdSlot`/`holdActiveMs` 复位，返回 `reanchoredBase`，`liveReader` 打日志 `acquire ring re-anchored: session base=N (ring wiped mid-process; fill=X counter=Y)`。
- **刻意不用 restartDetected 语义**：ringSeq（counter）跨清空唯一，普通增量交付即可平滑追加到现有列表，无需 UI 重灌、无需去重旁路。
- slot 映射改为 `slot = ((k − slotBase) % 2000 + 2000) % 2000`，`slotBase = pin.sessionBase ?? 0`；initial 窗口锚定同样尊重 sessionBase。
- `declaredCapacity` 双语义按值区分：`fillRaw ≥ 2000` → 容量（未来版本容量变更仍会触发 MISMATCH 告警）；`< 2000` → fillCount。

### 15.4 QA 与顺带修复的测试 flaky

- 新增 3 用例：① wipe 重锚（两连读后交付新会话条目、`reanchoredBase` 正确、`restartDetected=false`、随后增量正常）；② resume 水印进已清空环（先 0 条，下一读跳进 base 交付）；③ 健康会话校准不动 pin。
- `tsc` 0、eslint 0、prettier 通过、`liveMemoryRuntime` + `trackingService` **164 passed**。
- 顺带修复一个**既有 flaky**（prettier 重跑 QA 时暴露）：`trackingService.test.ts` 四个 ingest 用例的 seq 用 `900x00 + Date.now()%1000`（1/1000 撞率），而测试会把条目持久化进**共享** `app/record_log.json`（vitest 下 RecordLogService 走 `process.cwd()` fallback），遗留 seq（本次撞上 900394/900395）被 initial 去重直接跳过 → 首次 ingest 计数为 0。修复：唯一空间扩为 `900x00000 + Date.now()%1000000`，与遗留范围零交集；失败用例 5 连跑全过。

### 15.5 预期行为说明（非缺陷）

- 修复需**重启 companion** 生效。
- 用户点"清除记录日志"清掉的是 companion 的 `record_log.json`；游戏旧周目在清除之前的记录窗口（以及游戏自身清空环形区前的条目）无法回补——游戏侧已经清空，读不回来。属预期：从当前游戏会话起点（或新周目起点）开始正常收集。
- 清理入口位置回顾：设置 → 高级 —— 日志与缓存数据 → 数据与缓存 → 清除记录日志（§14）。

---

## 16. sessionBase 持久化 + 记录页分类拟合（09-16 深夜）——已完成

### 16.1 sessionBase 持久化链（§15.3 的收尾）

§15.3 修复后 `sessionBase` 只存在于 runtime 内存；进程重启后 pin 从持久化水印恢复，但 `pin.sessionBase` 为空 → slot 退化为 `k % 2000`。若上次会话 base ≠ 0（游戏清空过环形区、或 counter 已跨 2000），恢复后的首批读取全部落错槽位。本次把 base 接入完整持久化链：

- **runtime → poll 结果**：poll 返回的每批结果带 `sessionBase`（当前采纳值，未校准前为 null）；
- **liveReader → worker**：`postMessage` 透传；resume 应答 `setAcquireResume(total, sessionBase)` 双参数；
- **LiveMemoryService → appState**：`ingestAcquireBatch` 第 5 参、appState 启动时 `setAcquireResume(tracking.getAcquireWatermark(), tracking.getAcquireSessionBase())`；
- **TrackingService → RecordLogService**：`setAcquireWatermark(watermark, sessionBase)`，`acquireSessionBase` 随 `record_log.json` 持久化（`>= 0` 校验），`resetStorage` 清空。

饱和环数学注记：resume 门（`total ≥ rt && total − rt ≤ 2000`）在饱和环（base = counter − 2000）中通过的水印必然 `rt ≥ base`，因此恢复的 base 直接使 `slot = (k − base) % 2000` 映射正确，无需额外校准轮。测试 3 重写为自洽场景：水位 38156 + pin.sessionBase = 36161，断言恢复后交付 `msg 38156..38161`（非 fallback 旧槽位）。`liveMemoryRuntime` 112 passed。

### 16.2 记录页分类列 + 三桶时间拟合

需求："在记录页增加分类列，不限于记录类别，并且跟三个桶获得的数据进行拟合，拟合成功的按游戏方式进行染色（宝箱、品质），并且都要可以筛选。"

**拟合算法**（`app/src/core/recordLogFit.ts`，纯函数 `fitAcquireSources`，窗口 `FIT_WINDOW_SEC = 8`）——五遍扫描，逐级降置信：

| Pass | 来源 | 匹配策略 | 备注 |
| ---- | ---- | -------- | ---- |
| 0 | 通关 | 记录文本 "通关了" 前缀直识 | `stageKey` 从文本提取（如 `3-10`），零推断 |
| 1 | 开箱 | `itemName === acquireName` 精确匹配最近的未占用开箱事件 | 名称命中即占用（`remaining--`），置信最高 |
| 2 | 宝箱 | 最近的未占用 GetBox 事件（名称门 `/宝箱\|[Cc]hest/` 防盗占） | 记录 `chestCategory` |
| 3 | 开箱 | 名称失配时按时间窗口回退（`nearestWithin` 二分 + 前向扫描） | |
| 4 | 通关 | 时间窗口回退 | 依赖 TrackingService 内存 `stageClearHistory`（上限 200，与 ingest 同 tick 的 `clearWallTime`；不持久化，可见窗口不会早于重启） |

- **count 占用**：一条记录消耗候选的 count（×3 的行依次消耗三个候选、耗尽即不拟合）；bulk 行（`bulk: true`，feed 时的 initial 批量）永不拟合——其 `wallTime` 是 ingest 时刻而非事件时刻，参与拟合必系统性错配。
- **数据装配**：`chestDropTracker.fitHistory()` / `boxOpenTracker.fitHistory()` 整窗拷贝（非 50 条可见切片）→ `stats.buildStats` 第 15 参 `stageClearHistory` → `RecordLogStats.sources: Record<String(seq), RecordLogSourceFit>`（JSON 友好键控）。
- **渲染**（`RecordLog.tsx`）：拟合成功的行左边框 2px 着色 + 徽章（`${color}1f` 半透明底）——宝箱按类别色（common 灰白 / rare 蓝 / act 粉紫 / plague 绿系双色）、开箱按 grade 色、通关金色 `#dfc149`；徽章文案 `宝箱 · 普通` / `开箱 · XX` / `通关 · 3-10`。筛选 chips 两组：分类（含 plague 归组）与品质（acquireColor 优先、开箱 grade 色兜底），仅列当前窗口存在的项；筛选后空态独立文案。i18n 四语言补 `filteredEmpty/filterAll/filterCategory/filterQuality/fitChest*/fitOpen/fitClear/fitNone`。
- **QA**：`recordLogFit` 12 用例（前缀直识/名称匹配/名称胜过更近事件/count 占用 ×3/最近匹配/防盗占/占用消耗/双回退/窗口边界/bulk 跳过）+ `recordLog` 13 = 25 passed；`tsc` 0；eslint（13 文件）0；prettier 全过（stats.ts / recordLogFit.ts / recordLogFit.test.ts 为本轮修复）。

### 16.3 既有失败基线确认（非本次引入）

全量套件 `1808 passed / 9 failed`，唯一失败文件 `test/main/lookupPricePollingService.test.ts`（9 × 5000ms timeout，涉及 steamPrice mock）。已用干净 HEAD 基线复跑：**同样 9 failed | 18 passed**——既有问题，与 record-log 链路改动无关，留待单独排查。

### 16.4 记录页视觉打磨（09-16 23:0x 用户截图反馈）——已完成

用户以运行截图为基准要求逐项对齐。对比定位四处不足并修复（`RecordLog.tsx` + 四语言 `recordlog.json`）：

1. **品质 chips 显示原始色码**（如 `#D7D7D7`）→ 不可读。改为**图鉴目录反查**：行内物品名（`acquireName`）→ `TbhContext.lookupCatalog` 的 `name`/`sourceName` 双键 → `grade` → `gradeLabel(grade, t)` 本地化品质名（"传奇"/"Legendary"）；开箱拟合行直接用 `fit.grade`；同色多 grade 取最多行数者；无法反查的色回退色码原文（不丢信息）。**chips 排序改为品质等级序**（COMMON→COSMIC，未知排最后），取代随机出现序。筛选值仍为色值，状态语义不变。
2. **行 hover 过亮不可读**：`hover:bg-muted`（#8b93a7 全亮）→ `hover:bg-card`（对齐 InventoryTable 的行 hover 惯例）。
3. **徽章风格不统一**：宝箱系紧凑 `·`（"宝箱·首领"）vs 开箱/通关代码拼 ` · ` + 全大写 grade key（"开箱 · IMMORTAL"）。新增 i18n 键 `sep`（zh `·` / en ` · ` / ja `・` / ko `·`），开箱徽章改用本地化品质名 → zh `开箱·传奇`、en `Open · Legendary`，与宝箱系一致。
4. **激活 chip 隐性 bug**：`text-foreground` 是无效类（主题 token 为 `--color-fg`，从未生效）→ `text-bg`（深底色作文字，浅药丸+深字，可读）。

QA：tsc 0、eslint 0、prettier 全过、recordLog/recordLogFit/acquireLog 三套件通过、四语言 recordlog.json 键集一致（18 键）。

### 16.5 筛选语义收紧：品质只留真品质，获得拆分英雄/合成（09-16 23:3x 用户需求）——已完成

用户需求："去掉筛选的非品质选项。分类中获得拆分成，英雄（英雄阵亡和升级等跟英雄相关的）和合成（消耗了什么获得了什么）。"

**数据实证**（userData record_log.json，344 行 acquire）：每行都带 `acquireColor`，且色值与行形态强相关——通关行 #A69255/#FF8700、宝箱行 #0070C0/#A4A4A4/#FF0000、英雄行（"牧师被击败了。(木乃伊)"×56）#7030A5、灵魂石 #00F6FF；物品行色（#D7D7D7/#519FFF/#7CE937/#EBBB00/#FB86FF/#E8695A）才对应真品质。合成族实测三种文案：`消耗X品级,获得Y品级`（半角逗号）、`制作结果：获得 X`、`祈愿结果：获得 X`。

改动（全部渲染端，RecordLog.tsx + 四语言 recordlog.json）：

1. **品质 chips 只保留可反查到品质等级的色**：`qualityChips` 过滤 `grade === null` 的色——通关/宝箱/英雄色因名称（关卡 3-9/关卡宝箱/牧师）不在图鉴目录而无 grade，自动出局；灵魂石 - 折磨在目录中（CELESTIAL）保留。过滤逻辑复用 §16.4 的目录反查，无新增数据依赖。选中色被移出 chips 时自动重置为未选中（`activeQuality` 派生值），避免筛选项消失后无法取消。
2. **分类 chips：获得 → 英雄 + 合成**：`CatFilter` 增 `hero`/`synth`；`deriveRow` 对未拟合行按文本特征分类——`SYNTH_RE = /消耗.*获得|^制作结果|^祈愿结果/`，`HERO_RE = /被击败|阵亡|升级|复活|觉醒|英雄/`；剩余未匹配行仍归 `none`（"获得"chip，chips 仅在窗口内存在时渲染）。分类只影响筛选，不加徽章/染色（徽章语义仍是三桶拟合）；已拟合行不做文本覆盖。chips 点色：英雄用游戏英雄行紫 #7030A5，合成用中性灰 #8b93a7。
3. i18n 增 `fitHero`/`fitSynth` 四语言 + intro 补充说明（现 20 键）。

QA：tsc 0、eslint 0、prettier 过、recordLog/recordLogFit/acquireLog 通过、四语言键集一致（20 键）。实测归档色↔形态关联与目录反查结果见临时分析脚本（.tmp-shapes*.mjs，未入库）。

### 16.6 记录页嵌入实时页 + 归档翻页（09-16 23:5x 用户需求）——已完成

用户需求："取消实时页的宝箱历史和管卡通关历史，英雄块与物品栏填充预估一行。然后将整个记录页挪到实时页最下面。并给记录加上翻页功能，可以看200条之前的记录。"

**布局重组**（`Live.tsx`）：

1. 移除 `ChestDropPanel`（宝箱历史）与 `StageRunPanel`（通关历史）及其 import；`useStageRuns` 调用与 `chestInactiveMessage` 派生量随之删除（`chestStatsInactive`/`chestRateTip` 仍被顶部 StatCard 使用，保留）。
2. 英雄等级面板与物品栏填充预估合并为一个 `LiveMatchedPair`（左英雄右填充）。
3. `!liveActive` 时的 XP 历史（`LiveHistoryPanel`）改为独立全宽 section（原与英雄面板配对，英雄挪走后失去右侧邻居）。
4. `<RecordLog />` 嵌入页面底部（footer status 之前）。
5. "log" tab 移除：`appTabs.ts` 的 `TabId` union 与 `TAB_IDS`、`App.tsx` 的 lazy import 与渲染分支。`tabs:log` 的 i18n 标签键保留（无害）。

**记录面板嵌入化**（`RecordLog.tsx`）：`TabPage` 壳 → `PanelSection boxed`（title/intro/筛选/列表/分页全保留）；列表限高 `max-h-[420px]` 内部滚动（原依赖 tab 容器高度）；组件仍在 `tabs/RecordLog.tsx`（仅 Live.tsx 引用），文件未迁移以缩小 diff。

**归档翻页**（新增 IPC 链）：

- `RecordLogTracker.getPage(page, pageSize)`：与 `getStats()` 同序列（全 kind，按 seq 正序存储）切 200 条/页 newest-first 返回；page 0 ≡ getStats 窗口。**分页单位与 stats 窗口一致**（切全 kind 再由渲染端 filter acquire），保证页边界不重不漏。
- `TrackingService.getRecordLogPage(page, pageSize)`：tracker 切片 + `fitAcquireSources`（chestDrop/boxOpen `fitHistory()` + `stageClearHistory` + `FIT_WINDOW_SEC`）按页算 sources——徽章/筛选语义与实时推送完全一致；老页事件桶可能已滚动（fit 缺席 = 无徽章，降级可接受）。
- 类型/通道：`shared/types.ts` 增 `RecordLogPage { entries, total, sources }` + `TbhApi.getRecordLogPage`；`shared/ipc.ts` 增 `GET_RECORD_LOG_PAGE`（含 `IPC_INVOKE_CHANNELS`）；新 handler `handlers/recordLog.ts`（pageSize 默认 200）+ `registerIpc` 注册；preload 暴露；`appState.getAppServices` 加 accessor。
- 渲染端翻页状态：page 0 = 实时 stats 窗口（随 5Hz 推送自动更新），page ≥ 1 = IPC 静态快照（fetch 期间旧内容保持、loading 指示在页码旁）；UI = 上一页/下一页/回到最新 + `第 X / Y 页`（Y = ceil(total/200)，归档容量 10000 → 最多 50 页）；筛选状态跨页保留（`activeQuality` 兜底逻辑不变）；`totalPages > 1` 才渲染分页栏。
- i18n：recordlog.json 四语言各增 5 键（`pageNewer`/`pageOlder`/`pageLatest`/`pageOf`/`pageLoading`），现 25 键。

QA：tsc 0（格式化后复验 0）、eslint 0 error（4 个 json-ignore warning 为既有噪音）、prettier 全绿（eslint fix + prettier 经 `.tmp-lint-all.mjs` 脚本封装，绕 PowerShell 钩子误拦）、locale 四语言键集一致（25 键）、vitest 全量仅 `lookupPricePollingService` 9 failed（§16.3 已确认的既有失败，与本改动无关）。渲染端 `sources` 改为 useMemo（react-hooks/exhaustive-deps）。

**插曲**：TrackingService.ts 曾短暂出现 971 行孤立 `*/`（注释闭合错位，tsc/eslint/prettier 三方先后报 parse error 与成功交替）——未复现成因（疑似外部进程/缓存视图不一致），prettier 格式化后状态稳定，三轮 tsc + eslint 复验全绿。若再现请优先核对 971-976 行区域。

### 16.7 分类再拆分：祈愿 / 制作 / 改造（09-17 01:4x 用户需求）——已完成

用户需求："记录分类增加祈愿、制作和改造（装饰、雕刻、铭文、移除）。"

**规则改造**（`RecordLog.tsx` 渲染端文本分类，仅未拟合行）：原 `SYNTH_RE = /消耗.*获得|^制作结果|^祈愿结果/` 三合一拆为四条 + 顺序判定：

1. `WISH_RE = /^祈愿结果/` → 祈愿（wish）
2. `CRAFT_RE = /^制作结果/` → 制作（craft）
3. `REFORGE_RE = /装饰|雕刻|铭文|铭刻|移除/` → 改造（reforge）
4. `SYNTH_RE = /消耗.*获得/`（收窄为品级升移模板）→ 合成（synth）
5. `HERO_RE` → 英雄；其余 → none

改造关键词含"铭刻"：真实归档样本 `已用传说铭文卷轴对次元手套进行铭刻。` 虽被"铭文卷轴"的"铭文"覆盖，但为未来"对X进行铭刻"表述兜底。装饰/雕刻暂无归档样本，前瞻规则就位。改造族归入该类的行包括改造材料获得行（如"获得了传说铭文卷轴。"）——按用户意图，材料与操作同属改造语境。

**chips**：`CatFilter` 增 `wish`/`craft`/`reforge`（顺序：宝箱系 → open → clear → hero → wish → craft → reforge → synth → none）；点色避开既有色板——wish `#c78fe8`（浅紫罗兰）、craft `#d99a5b`（铜棕）、reforge `#5fb8a8`（青绿）。分类仍只影响筛选，不加徽章/染色。

**真实归档验证**（592 行 acquire，含新采集数据）：wish 2（祈愿结果：获得 神秘手套/精英弓）、craft 2（制作结果：获得 次元箭/次元头盔）、reforge 3（传说铭文卷轴获得/移除铭文效果/铭刻操作）、synth 15（消耗X品级,获得Y品级）、hero 101、none 469（多为已拟合行）。验证脚本 `.tmp-cat-verify.mjs`（未入库）。

i18n：recordlog.json 四语言各增 `fitWish`/`fitCraft`/`fitReforge` 3 键（zh 祈愿/制作/改造，en Wish/Craft/Reforge，ja 祈願/製作/改造，ko 소원/제작/개조），intro 更新为五分类（现 28 键）。

**环境插曲**：QA 首轮 tsc 报 `Accordion.tsx` 无法解析 `@base-ui/react/accordion`——与本次改动无关；实测 `node_modules/@base-ui/react` 包声明了 `./accordion` export 但磁盘内容缺失（包损坏，与此前 eslint `@babel/core` 缺失同源，疑似会话间被外部工具损坏）。`pnpm install --frozen-lockfile` 后台修复中被沙箱 wmic.exe 黑名单拦截中断，但主体链接已完成——`@base-ui/react/accordion` 与 `@babel/core` 均恢复。后续 vitest 又暴露同批损坏的第三处：`@rollup/rollup-win32-x64-msvc` 目录只剩 `.node` 二进制、缺 package.json（旁有 `_tmp_33796_68` 残留目录，印证安装中断于解压中途）——Node 解析包必须读到 package.json 才能定位 main，故报 MODULE_NOT_FOUND。手工补写该 package.json（name/version 4.62.2/os/cpu/main）后恢复。

QA（复验闭环）：locale 四语言键集一致（28 键）；tsc RC=0 全绿；prettier 16 文件 fmt-ok；eslint 0 errors / 4 warnings（仅 recordlog.json 不在 lint 覆盖范围，正常——`@babel/core` 恢复后 eslint 环境亦复原）；vitest 相关套件 6 files / 68 tests 全过（i18n factory + main i18n + localeCatalog + language + boxOpenLog + stageRunService，2.33s）。分类规则无专属单测（RecordLog.tsx 渲染端文本规则为历史现状），由真实归档脚本验证兜底（见上）。
