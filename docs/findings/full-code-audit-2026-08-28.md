# 全量代码审计报告

- 审计日期：2026-08-28
- 审计范围：`app/src/core`（含 `liveMemory`）、`app/src/main`（含 `liveMemory`）、`app/src/preload`、`app/src/renderer`、`app/shared`，共 414 个 TS/TSX 文件、约 5.3 万行
- 审计方法：四层并行深度审查（core 业务逻辑 / liveMemory / main 服务与 IPC / renderer 前端）+ 关键发现源码二次复核（本报告中标注「已复核」的条目均经主线程直接读源码确认）+ 机器质量基线（typecheck / lint / 全量测试）
- 总体结论：代码库整体健康状况良好——四层均未发现确定性 P0 级崩溃或安全漏洞；定时器/监听器生命周期基本对称（仅一处 `disposeWorker` 未接线的发散，见 P2）；测试骨架完备（1550 用例全绿）。问题集中在：一处掉落统计丢失条目的 off-by-one、若干边界防御缺口（除零、浅对象正则、脏读污染持久化）与若干性能热点（context 全树重渲染、无缓存同步读盘、内存扫描预算未落实）。

## 一、质量基线（机器验证）

| 检查 | 结果 |
|------|------|
| `pnpm typecheck`（含 test tsconfig） | ✅ 0 错误 |
| `pnpm lint` | ✅ 0 错误 / 3 警告 |
| `pnpm test`（vitest） | ✅ 116 文件 / 1550 用例全部通过（69.6s） |

lint 警告明细（3 条，均可顺手清理）：
1. `app/src/main/services/TrackingService.ts:34` — `import type` 风格（`--fix` 可自动修复）
2. `app/src/renderer/lib/useLoot.ts:62` — `boxOpens` 表达式使 useMemo 依赖每次渲染变化，建议包一层 useMemo
3. `app/test/main/steamItemNameId.test.ts:8` — `import()` 类型注解位置

## 二、P0（必须立即修复）

### P0-1. 宝箱日志跨 tick settle 的 resumeFrom 差一，settle 与新增条目同 tick 时新掉落整条丢失 [已复核]

- 位置：`app/src/core/liveMemory/runtime.ts:965`
- 证据：`const resumeFrom = pin.pendingIdx != null ? lastCountBefore + 1 : lastCountBefore;`。
  上一 tick 结束时 withhold 的条目绝对下标是 `pendingIdx = count - 1`（`[runtime.ts:1040]`），且 `pin.lastCount = count`（`[runtime.ts:1046]`），即 `pendingIdx = lastCountBefore - 1`。settle 分支（969-982 行）已经按 `pendingIdx` 重读了被 hold 的条目。因此下一批「真正的新条目」应从下标 `lastCountBefore` 开始扫；此处却取了 `lastCountBefore + 1`，把下标 `lastCountBefore`（= `pendingIdx + 1`）这条**跳过**。
- 触发条件：settle 挂起期间又有新掉落到达（相邻两次读取之间连掉两个宝箱）。多 BOSS 关卡通关连掉多个宝箱、Loot burst 场景恰好命中。被跳过的条目 `lastCount` 已推进到 `count`，**永久丢失**，无任何重试兜底。这正是 2026-08-27 连续数轮修复（retry / settle / burst / fast poll / save 补偿）要消灭的「掉落统计缺 +1」类问题。
- 影响：掉落统计、BoxTimer BOSS 倒计时、auto-classify 入队可能漏掉真实掉落（rare/act 概率最高，因为 BOSS 掉落常成对出现）。
- 修复建议：改为 `const resumeFrom = pin.pendingIdx != null ? pin.pendingIdx + 1 : lastCountBefore;`（等价于 `lastCountBefore`），并补一条「settle 与新增条目同 tick」的回归测试（`test/core/liveMemoryRuntime.test.ts`）。

### P0-2. shrink 分支未清 pendingIdx/pendingCat，跨局产生幻影掉落 + 再次漏记 [已复核]

- 位置：`app/src/core/liveMemory/runtime.ts:927-946`
- 证据：shrink 分支只重置了 `retryFrom/retryConsecutive`（939-940 行），注释自己声明「A shrink invalidates any parked retry position」，但同为下标的 `pendingIdx/pendingCat` 未清。新一局清空日志后（count→0 走 shrink），`pendingIdx` 残留上一局旧下标。
- 影响：下一局首个条目进入时，settle 分支会按旧 `pendingIdx` 去读新数组——读到的是新局的条目则分类可能被上一局 `pendingCat` 兜底（幻影掉落、分类错误）；且叠加 P0-1 的 resumeFrom 差一，下标 `lastCountBefore`（=0 附近）的真实新掉落再次被跳过。
- 修复建议：shrink 分支在 `pin.lastCount = next` 后，一并清 `pin.pendingIdx = null; pin.pendingCat = null;`，并补「shrink 后首局新条目正确分类、无幻影」测试。

## 三、P1（应尽快修复）

### P1-1. LootRing 除零冻结渲染进程 + 圈层数无上限 [已复核]

- 位置：`app/src/renderer/components/loot/LootRing.tsx:53-58`（`buildRings`）
- 证据：`const totalLaps = Math.floor(elapsed / lapSeconds);`、`elapsed % lapSeconds`，全程无 `lapSeconds > 0` 校验。上游 `tabs/Loot.tsx:141` 直接 `setRingSeconds(cfg.lootRingSeconds)` 不做 clamp；UI 编辑端虽把值 clamp 到 [1,3600]（`LootBoxSection.tsx:301-309`），但 `config.json` 手工编辑 / 历史数据为 `0` 时，`elapsed / 0 = Infinity` → `for (let i = 0; i < totalLaps; i++)` 永不结束 → 渲染进程同步死循环、整个窗口冻结。即使 lap 合法，挂机数小时无掉落时 `totalLaps` 可达数千，1Hz ticker 每秒全量重建数千个 SVG path。
- 修复建议：`buildRings` 入口加 `if (!(lapSeconds > 0)) return [];`；对 `totalLaps` 封顶（颜色只有 3 级，最多保留最新 3-4 圈）；`Loot.tsx:141` 读取配置时同 `commitRingDraft` 一样先 clamp。

### P1-2. tracker 的 totalXp 累加与首帧基线未过可信度过滤，脏读污染持久化快照 [已复核]

- 位置：`app/src/core/tracker.ts:461-464`、`:476-478`
- 证据：`for (const h of heroes) { totalXp += h.exp; }` 对所有 hero 无 `plausibleHeroRuntimeExp` 过滤（该过滤只在持续路径 `:499` 用于 gain 计算）；`takingOver` 分支首帧 `this.prevHero.set(key, { level: h.level, exp: h.exp })` 同样不过滤。已知 live 的 HeroList 存在脏读（pending 槽位返回有效 heroKey，level 回退、exp 垃圾——代码 504-514 行的注释明确承认这种脏读真实存在），而 `currentTotalXp` 会经 `captureSnapshot()`（`:760`）写入 `session_state.json`，恢复后 UI 总 XP 持续显示错误；`healInflatedXpTotals` 只修 rate/gained，不修 `currentTotalXp`。
- 修复建议：`totalXp` 累加与首帧 `prevHero` 种子均套用 `plausibleHeroRuntimeExp`，脏读 hero 跳过（不累加、不写基线），与 `:499` 现有 guard 对齐。

### P1-3. MarketVolumeService 对 429 无退避、无重试、无熔断，与业务文档不符 [已复核]

- 位置：`app/src/main/services/MarketVolumeService.ts:556-608`
- 证据：`fetchSteamPriceHistory` 对 429 返回 `{ ok:false, status:429, retryAfterMs }`，但 `refreshHistory` 失败分支只 `log.warn` 后 `done++`，随即固定 `waitOrAbort(1500ms)` 拉下一个 hash——既不按 `retryAfterMs` 等待，也不重试该 hash，更没有 `SteamMarketProvider`/`LookupPricePollingService` 已有的「连续 429 熔断」（前者连续 3 次 429 中止、每目标最多重试 2 次）。与 `docs/BUSINESS-FLOWS.md`「429 依 retryAfterMs 后退避重试」的描述不符。`this.lastRefreshAt[hash] = now` 只防同日兜底重试，不防同一次刷新周期内的持续撞限。
- 影响：配额耗尽时整批剩余物品以 1.5s/个的节奏持续撞 429，刷新被拖长并浪费限流预算（批间 120s 默认要等整批结束才生效）。
- 修复建议：引入连续 429 熔断（如连续 3 次中止整批并保留已完成数据），429 时至少等待 `retryAfterMs`（经 `waitOrAbort` 可中断）再继续；同步修正 BUSINESS-FLOWS.md 8.7.2 描述。

### P1-4. saveConfig 写盘无异常隔离，失败阻断下游副作用与广播 [已复核]

- 位置：`app/src/main/config.ts:474-476`
- 证据：`mkdirSync` + `writeFileSync` 无 try/catch（`app.getPath`/现有文件读取有）。调用点：`appState.ts:559`（`setCurrency` 中先 `saveConfig` 后 `inventory.setCurrency`）、`ipc/configPatch.ts:52`（先 `saveConfig` 后 topmost/广播/重推库存）。磁盘只读/磁盘满时 `saveConfig` 抛错 → 货币切换只做了一半（config 内存态已改、库存计价未换）或整条 SAVE_CONFIG 链路的副作用被跳过，且 IPC 直接 reject。
- 修复建议：参照 `BoxTimerService.persist` 与 `SessionStateService.persist`，给写盘包 try/catch + `warn`，写盘失败不影响内存态与下游广播。

### P1-5. applyConfigPatch 对 null patch 抛错且半途状态 [已复核]

- 位置：`app/src/main/ipc/configPatch.ts:58` + `ipc/handlers/config.ts:7`
- 证据：`ipc.handle(SAVE_CONFIG, (_e, patch) => services.saveConfigPatch(patch))` 无校验；`applyConfigPatch` 中 `{...prev, ...patch}` 对 null 安全，但第 52 行 `deps.saveConfig(next)` 已执行写盘后，第 58 行 `Object.keys(patch)` 在 `patch` 为 null 时抛 `TypeError`——内存/磁盘已改、后续副作用未完成。
- 修复建议：handler 或函数入口校验 `patch` 为普通对象（`typeof patch === "object" && patch !== null`），非法直接返回当前 config。

### P1-6. SET_CURRENCY 等 IPC 参数无类型校验 [已复核 main 侧 + 子代理报告]

- 位置：`app/src/main/ipc/handlers/market.ts:10`（→ `SteamMarketProvider.setCurrency` 的 `currency.toUpperCase()`）
- 证据：renderer 传入非 string（null/数字）会抛 `TypeError` 使 handler reject。同类缺校验：`market.ts:16-21`（`refreshMarketVolumeItems(cardOrder)` 只 `filter(Boolean)` 不验元素类型、`refreshMarketVolumeItem(hash)` 不验类型）、`lookup.ts:12`（`hash?.trim()` 先于类型检查）、`log.ts:8-10`（`logRendererError` 直接解 `payload.source/stack`）。
- 修复建议：仿照 `chests.ts:13-35` 的 `isNonEmptyString` 守卫风格，各 handler 入口统一校验类型/非空，非法即返回空结果。

### P1-7. 背包槽位容量解析仍是浅对象正则，嵌套对象即静默错算 [已复核]

- 位置：`app/src/core/inventory/parse.ts:70-86`
- 证据：`SLOT_OBJECT_RE = /\{[^{}]*\}/g`，注释自称「Assumes each slot entry is a shallow JSON object」；同文件 `:98-127` 已为 `itemSaveDatas` 写了 `splitTopLevelObjects` 处理嵌套括号（v1.00.28 字段插入曾让整页背包空白——本文件已吸取过教训，但容量路径没跟上）。一旦游戏在槽位对象内新增嵌套子对象（如附魔数据），`capacity/used` 会漏算/错切分，静默显示错误的容量与已满判断。
- 修复建议：`parseSlotCapacity` 复用 `splitTopLevelObjects` 切分槽位对象后逐对象提取 `IsUnlock/ItemUniqueId`。

### P1-8. computeInventoryComposition 标榜纯函数却原地改写入参 [已复核]

- 位置：`app/src/core/inventory/composition.ts:28-43`（`clearRowPricing`）与 `:57-59`（调用），文件头注释称「pure, safe to call from the renderer」
- 证据：`clearRowPricing(row)` 把 `row.priceRaw/unitPrice/value/buyOrderValue` 等全部置 null，直接修改传入 `rows` 数组内的对象。renderer 对过滤子集复用该函数重新聚合时，会清空这些 row 的定价字段，破坏后续价格显示。对「pure、可安全复用」的契约是隐性破坏。
- 修复建议：不原地清字段，改为聚合时忽略未定价字段（不修改 row），或返回新对象。

### P1-9. TbhProvider 单一 context 耦合交易量刷新进度，刷新期间驱动全树重渲染 [已复核]

- 位置：`app/src/renderer/context/TbhProvider.tsx:72-94`（订阅与多次 setState）、`:122-141`（value 未拆分）
- 证据：`onMarketVolumeRefreshProgress` 每次 push 会连续 2-3 次 setState；交易量历史刷新期间**每完成一个物品就 push 一次**（几十~几百次）。这些状态全部塞进单一 `value`，而 `useInventory()/useTbhContext()` 等只取 `currency` 的消费者也订阅整个 value——`LootBoxSection`（Loot 页每 box 一节，`React.memo` 挡不住 context 变化）在后台刷新时会被反复无谓重渲染，即使当前 tab 与交易页无关。
- 修复建议：把 `marketVolumeProgress/marketVolumePending/setMarketVolumePending` 移出 context，改为 `useSyncExternalStore` 模块单例（与 `usePrices.ts`/`useLookupPrices.ts` 同模式），只让 Trading 页订阅；或拆独立 context 并给 `LootBoxSection` 提供细粒度 selector（如单独导出 `useInventoryCurrency()`）。

### P1-10. 索引缺失的既有堆积：InventoryService.disposeWorker 从未被调用

- 位置：`app/src/main/services/InventoryService.ts:162-164`；对照 `main/index.ts:66-73`（before-quit）与 `appState.ts:471-480`（stopTracking）
- 证据：`disposeWorker()` 注释「Called on app shutdown」，但 before-quit 只调 `stopUpdates/flushSession/destroyTray`，`stopTracking` 只停 tracking/boxTimers/lookup/catalog/liveMemory，均未调用它（资源生命周期对照表中唯一不对称项）。
- 影响：utility process 靠 Electron 主进程退出统一回收，退出前 pending 请求可能被丢弃（无持久副作用）。
- 修复建议：`before-quit` 显式 `void inventory.disposeWorker()`（幂等）。

## 四、P2（建议修复，按主题归类）

### 性能

- **`ChestDropTracker.getStats` 每 200ms 两次全量扫 history**（`chestDropTracker.ts:531-567`）：`lastRareDropWallTime` 逆序扫描 + rolling 1h 逐条扫描，5Hz 广播每次 ~1000 次遍历；`BoxOpenTracker` 已有 `baseAggregateCache` 同类缓存，此处只缓存了 breakdown/history。建议 drop 时增量维护最后稀有掉落时间戳与移动窗口计数。
- **auto-classify 入队 O(N²)**（`boxOpenAutoClassify.ts:135-162`）：`findSameCategoryTail` 全队列扫描 + `insertSorted` 线性插入，长期挂机队列数百项时每 drop 一次全量扫/搬移。建议维护 per-category 尾指针 + 二分插入。
- **bundled 目录同步读盘无缓存**（`stageBoxTracker.ts:34-36`、`boxes/catalog.ts:48-58`、`pets/catalog.ts:33-35`）：`readBundledJson` 每次 `readFileSync+JSON.parse`；`canonicalTrackerBoxId` 默认参数内两次 `catalog.items.find`。`chestDropTracker` 自己已为 stage_boxes 建索引规避同一热点，boxes/pets 未跟进。建议 core 内惰性缓存不可变目录 + 预建 byId 索引。
- **bufferPool「分配归零」目标未达成**（`winProcess.ts:661-693` + `bufferPool.ts`）：`readBytes` 成功读返回 buffer 后不归还，扫描路径每 4MiB 块 `allocUnsafe` 全新外部 buffer 交给 GC，池只在失败读时复用——`PERFORMANCE-LIVEMEMORY-SCAN-PLAN.md` 声称的 7.5M alloc/s → ~0 未实现。建议实现 `releaseBuffer` 并在扫描路径 finally 归还，或删除该池并修正文档。
- **200MB 扫描上限仅有计划、无代码强约束**（`winProcess.ts:624,787-848`）：`readableRegions` 只限区域数（5000）不限字节；`resolveClassByName` miss 时全地址空间扫描（Pass 1 `scanBytes` 兜底 + Pass 2 全区域），`collectClassEntries` 同样无字节上限。不建议在 `readableRegions`/`scanBytes*` 引入累计字节预算（如 200MiB 即中止），并把区域数上限改为「区域数 + 累计字节」双上限。
- **fast chest poll 实际间隔 2ms 且每次含双 dict 遍历**（`worker.ts:32`、`runtime.ts:718-784`）：`FAST_CHEST_POLL_MS = 2` 与 `docs/BUSINESS-FLOWS.md`「~5ms」不符；每次 poll 经 `resolveLogManager → isLiveLogManager`（dict 结构验证 + `dictLookupIntKey`）+ `getBoxLogList`（第二次 dict 遍历），约 500Hz 持续 ReadProcessMemory。建议对齐文档（5ms）并缓存 liveness 验证结果。
- **`pendingChestDrops` 存在无界累积窗口**（`liveReader.ts:1039,1056-1063,1321`）：`consumePendingChestDrops` 只在 read 走到唯一成功点执行；read 的两个提前退出点（`!stage`、name-scan 期跳过 read）与 fast poll 仍在 push。建议加容量上限（如 >5000 丢弃最旧）或在提前退出分支也 drain。
- **存档解密/大 JSON 解析在主线程同步 + 忙等重试**（`io/saveFile.ts:8-23`、`saveWatcher.ts:62-63`）：`readBytesShared` 用 `Atomics.wait` 忙等 4×50ms 重试；save 层解析未像 inventory 那样下沉 worker。建议分片 `setImmediate` 或下沉 worker，忙等改为仅一次重试。
- **proxyResolver 用 execSync 首次阻塞主线程达 2s**（`proxyResolver.ts:74-89`）。建议启动期预热或改异步 `execFile`。
- **steamItemNameId 每解析一个新 nameid 就全量同步写盘**（`steamItemNameId.ts:45-49,109-110`），且 `userCache` 无上限。建议节流/异步合并写 + 上限。
- **长列表全量渲染**：`tabs/Lookup.tsx:181-187`（~5885 个 ItemCard）、`tabs/Trading.tsx:393-404`（ItemVolumeCard 各含迷你 SVG）、`InventoryTable` 行已用 `content-visibility:auto`（亮点）。建议给 Lookup/Trading 行容器同样加 `content-visibility:auto` + `contain-intrinsic-size`，确有必要再上虚拟化。
- **`MarketVolumeService.getStats` 每次调用打 info 日志**（`MarketVolumeService.ts:684-686`），长期膨胀 app.log。建议降 debug。

### 逻辑与健壮性

- **`parseMoney` 末尾恰 3 位小数歧义**（`steamPrice.ts:215-227`）：`"0.123"` 会解析成 123。当前货币集自洽（无 3 位小数货币），但该隐藏不变式无断言，建议加显式说明或断言。
- **`boxSlotState` 把容量钳到 ≥1**（`boxes/capacity.ts:26-35`）：未解锁类别容量 0 会被显示为 1。建议保留 `max(0, capacity)`，除零/异常路径单独兜底。
- **`Market.tsx:19-26` fmtAge 未防 NaN**：非法 ISO → `Date.parse` NaN → 显示「NaN days」。建议入口加 `Number.isFinite` 守卫。
- **`Trading.tsx:225-237` / `ItemPriceRefreshButton.tsx:36-46` 卸载后 setState**：`await` 完成后组件可能已卸载。建议 `mounted` guard。
- **`MarketVolumeSection.tsx:431-444` 松手读渲染闭包旧 `offset`**：`onOffsetCommit(offset)` 用旧 prop，可能把窗口提交到旧区间。建议提交 `pendingOffsetRef.current`。
- **列表 key 附 index 反模式**（`Live.tsx:539`、`ChestDropPanel.tsx:54`、`StageRunPanel.tsx:74/101`、`LootRecentDrops.tsx:44`、`LookupPriceChangeLog.tsx:96`）：同时间戳多记录时排序后节点易错位。建议换真正唯一字段。
- **`BoxOpenTracker.totalOpens` 命名误导**（`boxOpenTracker.ts:341`）：实际是物品总件数而非开箱次数，却作 `dropPct` 分母。建议改名 `totalItems` 或另维护开箱事件计数。
- **`stderr` 64KB 滑动窗口按 UTF-16 码元计且单 chunk 可超限**（`LiveMemoryService.ts:135-146`）：中文按 1 计、`length > 1` 保留条件使单个 ≥64KB chunk 不被截断。建议改 `Buffer.byteLength(text,'utf8')` 并按字节裁剪。
- **unsupported 状态下每 10s 重复模块枚举**（`worker.ts:128-140` → `liveReader.ts:587-622`）：extractor budget 已耗尽短路后仍每 10s 触发 `refreshGameContext → p.listModules()`，沙箱下每次落到 PowerShell `execFileSync`（100-300ms）。建议 extractor 确认短路时跳过重复枚举。
- **`saveWatcher.ts:70-77` inventory 解析失败静默**：只 `log.error`，不触发 onError/状态位，与主解析路径错误可见性不对称，排障困难。建议纳入状态上报。
- **`priceCache.persistPriceCache` 无 try/catch**（`priceCache.ts:83-87`）：经 `SteamMarketProvider.pruneCache`（同步调用）传导使 `refreshPrices` 的 IPC reject。建议与其它 persist 一致加 try/catch。
- **死代码**：`renderer/context/StatsContext.tsx`、`PriceContext.tsx`、`lib/useLiveMemory.ts` 的 `useLiveMemoryField` 全仓无人引用（`Root.tsx` 只挂 `TbhProvider`）；若未来误挂载将与 `useStats`/`usePrices` 模块单例形成同频道双订阅（含双音效）。建议删除或标注废弃。
- **重复订阅同频道**：`usePrices.ts:41-57` 与 `TbhProvider.tsx:95-111` 均挂 `onPricesProgress` 且结束时各自拉一次 `pricesStatus()`（一次刷新结束双 IPC 请求）；`useLookupPricePolling.ts:34` 与 `useWatchedHashes.ts:57` 双挂 `onLookupPricePollStatus`。建议收敛为每频道单一订阅源。
- **`groupBoxOpenEvents` 循环内重复除法**（`boxOpenAutoClassify.ts:258`）：`gapMs/1000` 提到循环外（整洁性问题）。
- **`BackToTop.tsx:36` scroll 监听未标 `{ passive: true }`**：滚动性能轻微可优化。

### 澄清项（审计中与任务前提的对账）

- 「30 分钟缓存」实为两套：`MarketVolumeService.HISTORY_REFRESH_MS = 60 分钟`（去抖，与其 `historyFetchedAtMs` 落盘一致，跨重启有效✓）；`LookupPriceService.REFRESH_INTERVAL_MS = 30 分钟`。文档与代码口径一致，仅外界表述混用。
- `MarketVolumeService` 无 `lastSuccessfulCycleAtMs` 字段（任务前提中标名），近似字段为 `lastSampleAtMs`（采样去抖，未持久化，仅影响重启后首次采样提前通过）。
- Steam 匿名 400 → `unauthorized` → 整批终止 + `cookieExpired` 上报：✓ 与文档一致。
- `BoxTimerService.startTick/stopTick` 对称 ✓（`boxTrackerWindow.ts:41-48` existing 分支不再重复 `onOpen`，subscribers 用 `Math.max(0,…)` 兜底，历史泄漏已修复）。

## 五、liveMemory 防护机制有效性评估

| 防护 | 结论 |
|------|------|
| critical 预算（MAX=3，按 version+build+revision 键控） | ✅ 闭环，`.attempts.json` 计数对称 |
| enrichment 预算（MAX=1）+ `enrichmentAlreadyAttempted` | ✅ 闭环，首次后不再 30s 重跑 extractor |
| `_criticalRvasValidated`（liveness 判断） | ✅ 闭环，失败不置位、由事件信号驱动重试 |
| Path 1（box-open 事件）/ 1.5（cache pollution 60s streak）/ 2 / 3 | ✅ 基本闭环；Path 1.6 有残余风险：StageManager null→非 null 每次重置 critical 预算，若某版本 `findStageManager` 结构性永久失败，每次进关触发一次 ~9s extractor（非紧死循环，P2 风险） |
| 读状态机 retry/force-skip | ✅ 闭环（force-skip 需 4 tick 收敛，无碍） |
| 读状态机跨 tick settle | ❌ **未闭环**：P0-1 resume 差一 + P0-2 shrink 不清 pending |
| bufferPool | ❌ 成功读不归还，优化目标未达成 |
| 200MB 扫描预算 | ❌ 未实现（仅区域数上限） |
| stderr 64KB 滑动窗口 | ⚠️ 基本闭环，字节口径有偏差 |
| fast poll / CHEST_BURST 开关 | ✅ 开关条件正确（attached+supported）；开销与文档不符（2ms vs 5ms） |

## 六、测试覆盖缺口（建议随修复补进）

1. `liveMemoryRuntime.test.ts`：settle 与新增条目同 tick（P0-1）；shrink 后新局首条目无幻影（P0-2）
2. `tracker.test.ts`：喂入 `exp > 1e12` 脏 hero 后 `currentTotalXp` 与 `captureSnapshot()` 不越界（P1-2）
3. `inventory.test.ts`：`inventorySaveDatas` 槽位内嵌 `{...}` 时 capacity/used 正确（P1-7）
4. `composition` 契约测试：调用后传入 row 定价字段保持不变（P1-8）
5. `steamPrice.test.ts`：`"0.123"`/`"1.234"` 末尾恰 3 位小数反例（P2）
6. `chestDropTracker.test.ts`：`getStats` 缓存一致性与失效（P2）
7. `configPatch`/IPC 测试：null patch、非 string currency 不抛错（P1-5/P1-6）
8. `LootRing` 渲染测试：`lapSeconds=0` 返回空环不冻结（P1-1）

## 七、建议修复顺序

1. **第一批（数据正确性）**：P0-1、P0-2 → 直接修复 + 补测试，回验 1550 用例全绿。
2. **第二批（崩溃/脏数据防线）**：P1-1（除零）、P1-2（totalXp 过滤）、P1-3（429 熔断）、P1-4/P1-5（config 错误隔离）、P1-6（IPC 校验）。
3. **第三批（静默错算）**：P1-7（槽位解析）、P1-8（composition 纯函数化）、P1-10（disposeWorker）。
4. **第四批（性能热点）**：P1-9（context 拆分）、bundled 目录缓存、getStats 增量缓存、扫描预算落实、长列表 content-visibility。
5. **收尾**：死代码清理、命名修正、日志降噪、lint 3 警告清零。