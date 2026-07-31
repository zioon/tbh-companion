# TBH Companion 业务流程总览

> 本文档是 TBH Companion 的项目级业务流程单一真理源。任何针对项目逻辑（save 解析、tracker 速率计算、live memory 读取、inventory/lookup/market、boxTimer、autoClassify、notification、session 持久化等）的代码改动，**必须先查阅本文档对应章节**，理解现有流程后再动手；改动落地后**必须同步更新本文档**（详见 `AGENTS.md` 的 Conventions 节）。
>
> 本文档关注"业务流程"（数据如何流动、服务如何协作），架构分层与 IPC 边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，save 解密细节见 [`SAVE_FORMAT.md`](./SAVE_FORMAT.md)，agent 行为规范见 [`docs/agent/`](./agent/README.md)。
>
> 所有文件路径以仓库根为基准（`app/src/...`）。

---

## 0. 项目目标与四层架构

TBH Companion 是 idle game **TBH: Task Bar Hero** 的桌面伴侣应用。它**只读**地观察游戏状态：

- 读取本地加密 save 文件 `SaveFile_Live.es3`（ES3 + AES-128-CBC），展示 XP/hour、gold/hour、per-hero 速率、session 历史、库存估值。
- 可选附加到游戏进程内存（`TaskBarHero.exe`），以 ~25 Hz 读取实时数据：当前关卡、波次、英雄状态、怪物 HP、宝箱掉落、开箱结果、关卡完成。
- 通过 Steam Market 拉取物品价格，估算库存 buyout 价值与开箱 loot 估值。
- **绝不修改 save**、**绝不向游戏注入输入**、**绝不与游戏服务器通讯**。

### 四层架构

| 层 | 路径 | 规则 |
|----|------|------|
| **shared** | `app/shared/` | `types.ts` + `ipc.ts`（IPC 通道名）+ `notificationCatalog.ts`。无运行时逻辑。 |
| **core** | `app/src/core/` | 纯领域逻辑。**无** `electron`、**无** `node:fs`、**无** `fetch`、**无** React。Vitest 单测覆盖。 |
| **main** | `app/src/main/` | 文件 I/O、网络、窗口、IPC。通过 `app/appState.ts` 和 `ipc/` 编排 core。 |
| **preload** | `app/src/preload/` | 仅 `contextBridge`；通道名从 `shared/ipc.ts` 引入。 |
| **renderer** | `app/src/renderer/` | React UI 通过 `window.tbh` 访问 IPC。过滤/排序在 `renderer/lib/` 或 `core/` 纯函数。 |

### 三个窗口（共享同一 bundle）

- **主窗口** `#main` — 可调整大小的 tabbed 界面（Live / Inventory / Market / Chests / Pets / Lookup / Loot / Settings / About）。
- **Mini overlay** `/overlay` — 无边框、置顶、可拖动、紧凑；tab bar 的 "Mini" 按钮切换。
- **Box tracker** `/box-tracker` — 无边框置顶的宝箱冷却倒计时专用窗口。

### 数据流总览

```
[游戏写 SaveFile_Live.es3] ─── mtime 变化 ───► SaveWatcher.tick (poll)
                                                  │
                       ┌──────────────────────────┴───────────────────────────┐
                       ▼                                                       ▼
              readAndDecrypt + parseSnapshot                            parseInventory
              → SaveSnapshot                                              → InventorySnapshot
                       │                                                       │
                       ▼                                                       ▼
            TrackingService.onSnapshot                              InventoryService.onInventory
              ├─ detectHeroLevelUps ─► NotificationService           ├─ resolveAndPushInventory
              ├─ sessionState.tryRestoreOnSnapshot (首次)             │   └─ inventoryWorker (utility process)
              ├─ tracker.update(snap) ─► XpTracker                    ├─ checkAlmostFull ─► NotificationService
              ├─ onStageKey ─► BoxTimerService.setCurrentStageKey     └─ broadcast(IPC.INVENTORY)
              ├─ parseInventorySnapshot:
              │     ├─ inventory.parseFromSave
              │     ├─ chests.onSave ─► ChestService ─► AutoClassify.reconcile
              │     └─ pets.onSave  ─► PetService
              └─ pushStats ─► broadcast(IPC.STATS)

[Live Memory Worker ~25 Hz] ─── LiveMemorySnapshot ───► TrackingService.ingestLiveFrame
                                                          ├─ tracker.updateLive ─► XpTracker (live 路径)
                                                          ├─ dpsTracker.update
                                                          ├─ chestAggregator.feed ─► chestDropTracker.recordLiveChestDrop
                                                          │     └─ onDrop ─► AutoClassify.handleChestDrop
                                                          ├─ onLiveStageBossDrop ─► BoxTimer.tryMarkDroppedFromLiveStage
                                                          │     └─ markDropped ─► onChestDropped ─► NotificationService
                                                          ├─ onLiveStageClear ─► StageRunService.recordClear
                                                          ├─ boxOpenTracker.recordOpen (per entry)
                                                          │     └─ onUnclassified (microtask) ─► AutoClassify.handleUnclassifiedBatch
                                                          └─ pushStats (节流 200ms) ─► broadcast(IPC.STATS)

[TrackingService 1 Hz tick]    autoClassify.tick + stale-frame guard + pushStats
[SessionStateService 15 s]     autosave ─► userData/session_state.json
[BoxTimerService 1 Hz tick]    buildState ─► onChestReady ─► NotificationService + broadcast(IPC.BOX_TIMERS)
[UpdateService 30 s 后台]      autoUpdater.checkForUpdates ─► showUpdateAvailable
[CatalogRefreshService 启动]   extractCatalog + extractLocales ─► reloadLocaleCatalog
```

---

## 1. 启动流程

入口：`app/src/main/index.ts`。

### 1.1 时序

1. **顶层副作用导入**：`./appIdentity`（注册 app 名称）、`./logInit`（日志 transport）。
2. **Asset 协议注册**：`registerAssetProtocolScheme()` 在模块加载时调用。
3. **单实例锁**：`acquireSingleInstanceLock()`（`app/app/singleInstance.ts`）。未拿到锁则 `app.quit()`；拿到锁后注册 `second-instance` 事件 → 聚焦主窗口。
4. **外部链接拦截**：`app.on("web-contents-created")` → `attachExternalLinkHandlers`（`app/app/lifecycle.ts`），把 http/https 链接转给系统浏览器。
5. **`app.whenReady()` 触发主流程**：
   - `registerAssetProtocolHandler()` 注册协议实际 handler。
   - `initMainI18n(loadConfig())` 初始化主进程 i18n。
   - `startTracking()` 装配所有服务并启动 watcher（详见 1.3）。
   - `getAppServices()` 取得对外 API 聚合对象。
   - `registerIpc(services)` 注册全部 IPC handler。
   - `services.startUpdates()` 启动更新检查（30s 延迟后台检查）。
   - `createTray(services)` 创建托盘。
   - `restoreSessionWindows(sessionUi)` 根据 `session_state.json` 的 UI 标记决定打开主窗口还是 mini overlay + box tracker 窗口。
6. **`before-quit`**：`setAppQuitting(true)` → `services.stopUpdates()` → `services.flushSession()` → `destroyTray()`。
7. **`window-all-closed`**：若 `isAppQuitting()`，调 `stopTracking()` 后退出（非 macOS）。

### 1.2 appState 装配（`app/src/main/app/appState.ts`）

模块级单例按顺序构造（构造时即执行）：

| 顺序 | 服务 | 关键依赖 |
|------|------|----------|
| 1 | `SessionStateService` | 无 |
| 2 | `InventoryService` | 无 |
| 3 | `ChestService` | 构造时加载 `boxType`/`runeCap`/`runeAutoOpen` 三份 catalog |
| 4 | `PetService` | 构造时加载 `petCatalog` |
| 5 | `BoxTimerService` | 构造时加载 `stageBox` catalog + tracker routes，调 `load()` 读 `box_timers.json`，调 `seedWasOnCooldown()` |
| 6 | `StageRunService` | 构造时 `load()` 读 `stage_run_history.json` |
| 7 | `LookupService` / `LookupPriceService` | 无 |
| 8 | `LookupPricePollingService` | 依赖 `lookupPrices`、`inventory.getOwnedPriceHashes`、`config.currency`、共享 `nameIdService`、`broadcast` |
| 9 | `LiveMemoryService` | 构造后 `setOnGameVersionChanged` 钩子接 `catalogRefresh.onGameVersionChanged` |
| 10 | `CatalogRefreshService` | 依赖 `inventory.getGameData()`、`liveMemory`、`resolveUserDataDir()`、`broadcast`、`config.gameInstallDir` |
| 11 | `NotificationService` | `getConfig`、`focusMainWindow`、`t`（i18n） |
| 12 | `UpdateService` | `getConfig`、`onUpdateAvailable: (v) => notifications.showUpdateAvailable(v)` |

构造后立即装配跨服务回调：

- `boxTimers.setOnChestReady(payload => notifications.showChestReady(payload))`
- `boxTimers.setOnChestDropped(payload => notifications.showChestDrop(payload))`
- `inventory.setOnAlmostFull(payload => notifications.showInventoryAlmostFull(payload), () => threshold)`
- `liveMemory.setOnGameVersionChanged(() => catalogRefresh.onGameVersionChanged())`

### 1.3 TrackingService 构造与 startTracking()

`TrackingService` 构造参数是 8 个回调（按顺序）：

1. `onInventory: (snap) => inventory.onInventory(snap)` — SaveWatcher 的 onInventory 入口
2. `parseInventorySnapshot: (text, mtime) => { const inv = inventory.parseFromSave(text, mtime); chests.onSave(text, mtime, inv.chests); pets.onSave(text, mtime); return inv; }` — 解析 inventory 同时驱动 ChestService 和 PetService
3. `onStageKey: (stageKey) => boxTimers.setCurrentStageKey(stageKey)` — save 解析到新 stageKey 时同步给 BoxTimerService
4. `sessionState` — 用于 restore/autosave/flush
5. `onHeroLevelUp: (events) => notifications.showHeroLevelUp(events)`
6. `onLiveStageBossDrop: (stageKey) => boxTimers.tryMarkDroppedFromLiveStage(stageKey)`
7. `onLiveStageClear: (stageKey, clearTimeSec, xpGained, goldGained) => stageRuns.recordClear(...)`
8. `onLiveChestSlots` — 当前已不路由到 AutoClassify（保留接口签名）

`startTracking()` 流程：

1. `config = loadConfig()` 重新加载配置。
2. 初始化 `InventoryService` 市场参数：`initMarket(config.currency)`、`setAutoScanEnabled`、`setLowValueThresholdUsd`、`loadGameData(resolveUserDataDir())`。
3. `lookupPrices.start()` 启动 lookup 价格快照（先 `loadFromDisk()`，再 `refresh()`，然后 30 分钟轮询）。
4. `lookupPricePolling.setConfig(config.lookupPricePolling)` 应用轮询配置。
5. 若 `config.liveMemory.enabled && config.liveMemory.consentAccepted`，调 `liveMemory.start()`，并 `setOnSnapshot(snap => tracking.ingestLiveFrame(snap))` 把 ~25 Hz live 帧注入 TrackingService。
6. `sessionState.load(config)` 读 `session_state.json`，返回 UI 快照（mini overlay / box tracker 是否打开）。pending tracker 数据保留等待首次 save 解析时 restore。
7. `tracking.start(config)` 装配 `XpTracker` / `ChestDropTracker` / `LiveChestDropAggregator` / `BoxOpenTracker` / `DpsTracker`，启动 SaveWatcher 和 1Hz tickTimer，启动 `sessionState.startAutosave`。
8. 注入 catalog：`setGameDataLookup`、`setLookupCatalog`（同时注入 inventory）、`setInventorySnapshot`、`setLookupPriceSnapshot`、`lookupPrices.setOnSnapshotUpdated` 双订阅。
9. `autoClassify = new AutoClassifyService({...})`：依赖 `tracking.getChestDropTracker/getBoxOpenTracker`、`chests`、`boxTimers.getState().catalog`、act/common routes、`tracking.getCurrentStageKey()`、`getInventoryStatus`。
10. `chests.setOnReconcile(slots => autoClassifyRef.reconcileWithChestSlots(slots))` — 每次 save 解析都触发 AutoClassify reconcile。
11. `autoClassify.setEnabled(config.lootAutoClassifyEnabled)`、`tracking.setAutoClassifyService(autoClassify)`。
12. `reloadLocaleCatalog()`：基于 `config.language` 解析语言 → 加载 `LocaleCatalog`（bundled JSON + 游戏提取的 locale_strings 合并）→ 注入到 `tracking / inventory / boxTimers / stageRuns / liveMemory / lookup` 六个服务。
13. `inventory.resolveAndPushInventory()` — 用新 catalog 重推一次库存。
14. 异步触发 catalogRefresh（若 stale）：成功后再次 `reloadLocaleCatalog()` + 重推 stats/boxTimers/stageRuns/inventory。
15. 返回 `ui` 给 `index.ts`，由 `restoreSessionWindows(ui)` 决定窗口打开方式。

### 1.4 stopTracking()

`before-quit` 触发 `services.flushSession()` 后；`window-all-closed` 内调 `stopTracking()`：

- `tracking.flushSession()` 落盘一次。
- `tracking.stop()` 停 watcher / tickTimer / autosave。
- `autoClassify?.setEnabled(false)` + 置 null。
- `boxTimers.stopTick()`、`lookupPrices.stop()`、`lookupPricePolling.stop()`、`liveMemory.stop()`。

---

## 2. 配置加载与 configPatch

### 2.1 config.json 加载（`app/src/main/config.ts`）

- **搜索路径**：`app.getPath("userData")/config.json` → `process.cwd()/config.json` → `process.cwd()/../config.json`。
- **默认值**（`DEFAULTS`）：savePath 默认 `%USERPROFILE%/AppData/LocalLow/TesseractStudio/TaskbarHero/SaveFile_Live.es3`；es3Password 默认 `DEFAULT_PASSWORD = "emuMqG3bLYJ938ZDCfieWJ"`（`app/src/core/es3.ts`）；pollIntervalSeconds=5；rollingWindowMinutes=5；topmost 三窗口默认 true；notificationsEnabled/notifyOnUpdateAvailable 默认 true；marketAutoScanEnabled 默认 true；marketLowValueThresholdUsd=0.05；lootAutoClassifyEnabled 默认 false；language="auto"。
- **normalizeConfig**：用一组 `sanitize*` 函数清洗每个字段。关键清洗：
  - `sanitizeTopmost` 兼容旧 `startTopmost`（单布尔）迁移到 `topmost: { main, overlay, boxTracker }`。
  - `migrateNotificationPrefs`（`app/shared/notificationCatalog.ts`）兼容旧 `chestSoundVariant` → `notificationPrefs`。
  - `sanitizeLookupPricePollingPrefs`：intervalMinutes 限 [5,60]、thresholdUsd ≥0、watchedHashes 去重 ≤100 项。
  - `sanitizeLanguage`：接受 "auto" / "game" / `APP_LANGUAGES` 任意项。
- **saveConfig**：合并 existing + 新 config，再 normalize 后写 `userData/config.json`。

### 2.2 configPatch（`app/src/main/ipc/configPatch.ts`）

`applyConfigPatch(deps, patch: Partial<AppConfig>)` 流程：

1. 检测三类 needs：`needsWatcher`（savePath/pollIntervalSeconds/es3Password 变了）、`needsTracker`（rollingWindowMinutes 变了）、`csvToggled`（logHistoryCsv 变了）。
2. `next = normalizeConfigFromRaw({...prev, ...patch})` → `setConfig(next)` → `saveConfig(next)`。
3. 若 savePath 变了 → `onSavePathChange()`（实为 `tracking.onSavePathChanged()`：清 lastSnap、重置所有 tracker、`sessionState.notifyNewSession()`）。
4. currency 变了 → `market.setCurrency` + `resolveAndPushInventory` + `ensureOwnedPrices(true)`。
5. `needsTracker` → 重建 `XpTracker`（保留 logHistoryCsv hook）；否则仅 csvToggled 时切换 hook。
6. `needsWatcher` → `restartWatcher()`。
7. liveMemory 变了 → `setLiveMemoryEnabled(nextActive)`；若 prevActive ≠ nextActive → `onLiveMemoryToggled()`（重置所有 tracker，避免 live/save 基线混合污染）。
8. marketAutoScanEnabled / marketLowValueThresholdUsd 变了 → 同步给 InventoryService。
9. language 变了 → `onLanguageChanged(newLanguage)` → `changeLanguage` + `reloadLocaleCatalog` + `boxTimers.push()` + `stageRuns.push()` + `rebuildTrayMenu`。
10. lookupPricePolling 变了 → `onLookupPricePollingChanged(next.lookupPricePolling)`。
11. `setAlwaysOnTop(next.topmost)` 应用到三个窗口。
12. `pushStats()` + `resolveAndPushInventory()` 强制重推一次。

返回 `{...next}`。

---

## 3. Save 解密与解析

### 3.1 SaveWatcher 轮询（`app/src/main/saveWatcher.ts`）

**构造参数** `SaveWatcherOptions`：`path`、`password`、`pollMs`、`onSnapshot`、`onError`、`onInventory?`、`parseInventorySnapshot?`。

**`start()`**：立即 `tick()` 一次，然后 `setInterval(tick, pollMs)`。

**`tick()`** 流程：

1. `statSync(path).mtimeMs` 取 mtime；失败（文件不存在）→ `onError("Save file not found: ...")` 返回。
2. mtime 等于 `lastMtimeMs` → 直接返回（未变化）。
3. `readAndDecrypt(path, password)` → `{ text, mtime }`。失败抛 `SaveReadError`。
4. 成功：`lastMtimeMs = mtimeMs`，`parseSnapshot(text, mtime)` → `SaveSnapshot` → `onSnapshot(snap)`。
5. 若 `onInventory` 提供：调用 `parseInventorySnapshot ?? parseInventory` 解析 inventory → `onInventory(inv)`；解析失败仅 `log.error`，不影响主流程。
6. **错误处理**：捕获到 `SaveReadError` 或其它异常时**不更新 `lastMtimeMs`** → 下次 tick 会重试。这是处理 mid-write sharing violation 的关键设计：游戏写文件时部分块未刷盘 → AES 块大小校验失败 → 抛错 → 不前进 mtime → 下次 poll 重试。

首次成功读取时 `log.info("First save read OK (stage ${snap.stageKey})")`。

### 3.2 readAndDecrypt（`app/src/main/io/saveFile.ts`）

`readAndDecrypt(path, password=DEFAULT_PASSWORD) → { text, mtime }`：

1. `existsSync(path)` 检查；不存在 → `SaveReadError("Save file not found")`。
2. `mtime = statSync(path).mtimeMs / 1000`（秒级 epoch）。
3. `readBytesShared(path)`：4 次重试，每次失败 `sleepSync(50ms)`（用 `Atomics.wait` 阻塞）。处理 Windows 文件被占用场景。4 次都失败 → `SaveReadError("Could not read save file: ...")`。
4. `es3.decryptToText(raw, password)` → UTF-8 文本；失败包装成 `SaveReadError`。
5. 返回 `{ text, mtime }`。

### 3.3 ES3 解密（`app/src/core/es3.ts`）

文件布局：`[16-byte IV/salt][AES-CBC ciphertext]`。Key 派生：`PBKDF2-HMAC-SHA1(password, salt=IV, iterations=100, dklen=16)`。Cipher：AES-128-CBC + PKCS7 padding。明文：UTF-8 JSON。

`decrypt(data: Buffer, password=DEFAULT_PASSWORD) → Buffer`：

1. `data.length <= 16` → `Es3Error("File is too small")`。
2. `iv = data[0:16]`，`ciphertext = data[16:]`。
3. `ciphertext.length % 16 !== 0` → `Es3Error("Ciphertext length is not a multiple of AES block size (save may be mid-write)")` — mid-write 检测关键。
4. `key = pbkdf2Sync(password, iv, 100, 16, "sha1")`。
5. `createDecipheriv("aes-128-cbc", key, iv)` + `setAutoPadding(false)`（手动剥 PKCS7）。
6. 检查最后一个字节 `pad`，必须 1..16 且 ≤ padded.length，且末尾 pad 字节全等于 pad → 否则 `Es3Error(WRONG_PASSWORD)`。
7. 返回 `padded.subarray(0, padded.length - pad)`。

### 3.4 parseSnapshot（`app/src/core/save/snapshot.ts`）

`parseSnapshot(decryptedText, saveMtime=0) → SaveSnapshot`：

1. `root = JSON.parse(decryptedText)`。
2. `player = unwrapEs3Entry(root.PlayerSaveData)` — ES3 顶层每个 key 是 `{__type, value}` 包装，`value` 经常是 JSON 字符串需二次 parse。`unwrapEs3Entry` 自动处理：若 value 是 string 且 trim 后以 `{` 或 `[` 开头则 try `JSON.parse`，失败保留原值。
3. `PlayerSaveData` 缺失 → `SaveReadError("PlayerSaveData missing or malformed")`。
4. **heroes**：遍历 `player.heroSaveDatas[]`，提取 `heroKey`（转 string）、`HeroLevel`（truncate）、`HeroExp`、`IsUnLock`；累加 `totalHeroExp`。
5. **gold**：遍历 `player.currenySaveDatas[]`，找 `Key === 100001`（GOLD_KEY）的 `Quantity`。
6. **commonSaveData**：提取 `playTime`、`currentStageKey`（truncate）、`currentStageWave`、`maxCompletedStage`。
7. 返回 `SaveSnapshot`：`{ heroes, totalHeroExp, playTime, saveMtime, stageKey, stageWave, maxStage, gold }`。

**注意**：`SaveSnapshot` 不直接包含 chest slots / items / pets。这些在 `InventoryService.parseFromSave` 与 `PetService.onSave` 中独立解析（基于同一 `decryptedText`）。

### 3.5 SaveSnapshot 字段含义（`app/shared/types.ts`）

| 字段 | 类型 | 含义 |
|------|------|------|
| `heroes` | `HeroSnapshot[]` | 每个英雄的 key/level/exp/unlocked |
| `totalHeroExp` | number | 所有英雄 exp 之和（用于会话级 XP 增量） |
| `playTime` | number | 游戏内 playTime |
| `saveMtime` | number | save 文件 mtime（epoch 秒）— 用作所有速率计算的时间基准 |
| `stageKey` | number | 当前关卡 4 位编码（难度×1000+act×100+stage） |
| `stageWave` | number | 当前 wave |
| `maxStage` | number | 历史最高已完成关卡 |
| `gold` | number | 当前金币 |

---

## 4. Tracker 双路径业务流程

`TrackingService`（`app/src/main/services/TrackingService.ts`）持有：
- `XpTracker`（XP/金币会话与速率）
- `ChestDropTracker` + `LiveChestDropAggregator`（宝箱掉落计数）
- `BoxOpenTracker`（宝箱开启结果）
- `DpsTracker`（伤害/击杀）
- `SaveWatcher`
- 1Hz `tickTimer` + ~5Hz live broadcast 节流

### 4.1 XpTracker 双路径所有权模型（`app/src/core/tracker.ts`）

`LIVE_TAKEOVER_SEC = 5`：live 路径在 5 秒内有过帧 → "live owning"，save 路径不再处理该指标（XP 和 gold 各自独立判断）。live 帧停 5 秒 → save 路径接管，并执行 "handover"：重置基线到 save 值，不计增益（避免基线混合导致 totals 爆炸）。

#### 4.1.1 update(snap: SaveSnapshot) — save 路径

1. `now = Date.now()/1000`，`mtime = snap.saveMtime || now`，`heroes = snap.heroes`。
2. **首次初始化**：每个 hero 写入 `prevHero`（level+exp），创建 `RateMeter(rollingWindow)` 并 `init(mtime)`；`prevGold = snap.gold`；初始化 `samples`、`goldSamples`、`firstMtime`、`lastChangeMtime` 等；返回 0。
3. **判定 live 是否 driving**：`goldLiveDriving = lastLiveGoldSec !== null && now - lastLiveGoldSec < 5`；`xpLiveDriving` 同理。
4. **Gold save 路径**（`!goldLiveDriving`）：
   - 若 `goldLiveOwning` 为 true（之前是 live 接管）→ handover：`goldLiveOwning = false`，`prevGold = snap.gold`（不计 gain）。
   - 否则 `updateGold(snap.gold, mtime)`：仅计正向 delta（金币会被消耗，所以负 delta 忽略），累加到 `goldGained`，更新 `goldSamples`，重算 `goldRollingRateValue` 与 `goldSessionRateValue`。
5. **XP save 路径**（`!xpLiveDriving`）：
   - 若 `xpLiveOwning` → handover：`xpLiveOwning = false`，`currentTotalXp = snap.totalHeroExp`，每个 hero 重置 `prevHero`（不计 gain）。
   - 否则遍历 heroes，对每个 hero 调用 `heroDeltaGain(prev, level, exp)`（见 4.4），累加 gain；更新 `prevHero`；`meter.add(heroGain, mtime)`。
   - 若 `gain > 0`：累加 `cumulativeGained`，更新 `samples`、`lastGainMtime`、`lastChangeMtime`，`prune(mtime)`，`recomputeRates()`；push HistoryEntry（cap 500）；触发 `onHistory` 回调。
6. 返回 gain。

#### 4.1.2 updateLive(data, wallTimeSec, stage?) — live 路径

`data: { gold, heroes }`，~25 Hz 调用。`!initialized` 时直接 return（必须先有 save 解析）。

- **Gold live**：
  - takingOver = `!goldLiveOwning`；`goldLiveOwning = true`；`lastLiveGoldSec = wallTimeSec`。
  - gain = takingOver ? 0 : `max(0, gold - prevGold)`；`prevGold = gold`。
  - takingOver 时 `liveGold.restore(goldGained, [[wallTime, goldGained]], wallTime, 0, 0)`（基线重置）；否则 `liveGold.applyGain(wallTime, gain)`。
  - 同步 `goldGained = liveGold.sessionTotal`，刷新 `liveGold.refresh(wallTime, rollingWindow)` → 同步 `goldRollingRateValue`、`goldSessionRateValue`、`goldSamples`、`goldFirstMtime`。
- **XP live**：
  - takingOver 时：`seedTotal = isPlausibleCumulativeXp(cumulativeGained, elapsed) ? cumulativeGained : 0`；`liveXp.restore(...)`；`cumulativeGained = seedTotal`；`prevHero.clear()`；每个 hero 写入 `prevHero`；现有 `heroMeters` 调 `meter.reanchor(wallTimeSec)` 重置时间基准（避免 save mtime 与 live wallTime 混用导致 session 速率看起来比 hero 速率高）。
  - 持续路径：对每个 hero：
    - `plausibleHeroRuntimeExp(h.exp)` 校验（≤1e12）。
    - **level-drop guard**：`prev.level > h.level` → 跳过（dirty read，不计数不前进基线）。
    - **same-level dip guard**：`prev.level === h.level && h.exp < prev.exp` → 跳过计数但 `meter.refreshRolling`。
    - `heroDeltaGain(prev, level, exp)` 计算 gain。
    - `plausibleLiveHeroGain(heroGain)` 校验（≤1e7/tick）。
    - 通过则 `gainSum += heroGain`，`meter.add(heroGain, wallTime)`；否则只 `meter.refreshRolling`。
  - `gain = plausibleLiveHeroGain(gainSum) ? gainSum : 0`。
  - `gain > 0` → `liveXp.applyGain`，更新 `lastGainMtime`/`lastChangeMtime`。
  - `currentTotalXp = sum(hero.exp)`，`syncXpFromLiveMeter(wallTime)`：同步 `cumulativeGained`、`rollingRateValue`、`sessionRateValue`、`samples`、`firstMtime`，刷新所有 heroMeters，`healInflatedXpTotals(wallTime)`（自愈）。
  - `gain > 0` → push HistoryEntry。

### 4.2 滚动窗口与速率计算

- **RateMeter**（save 路径，per-hero）：`samples: [mtime, gained][]`。`add` 时 push 样本并 `refreshRolling(mtime)`：弹出窗口外的样本（窗口 = `rollingWindow` 秒），`rolling = (gained - g0) / (mtime - t0) * 3600`。
- **LiveSessionMeter**（live 路径，session 级）：`sessionTotal` + `samples` + `firstAnchor` + `rolling` + `sessionRate`。`refresh` 类似 RateMeter 但用 wallTime。
- **sessionRate**（getter）：用真实会话总时长 `(now - sessionStart)`，而非"首次到末次 XP 增益时长"，避免挂机后 sessionRate 卡在高位不衰减。
- **rollingRate**：滚动窗口内的速率。
- **goldRate** / **goldSessionRate**：gold 的对应版本。

### 4.3 trackerLimits（`app/src/core/trackerLimits.ts`）

- `MAX_PLAUSIBLE_XP_RATE = 5e10`（XP/hour 上限）。
- `MAX_PLAUSIBLE_CUMULATIVE_XP = 1e10`（session XP 总量上限）。
- `isPlausibleXpRate(rate)`：finite、≥0、< MAX_PLAUSIBLE_XP_RATE。
- `isPlausibleCumulativeXp(total, elapsedSec)`：finite、≥0、< MAX_PLAUSIBLE_CUMULATIVE_XP；若 elapsed>0 则隐含速率也必须 < MAX_PLAUSIBLE_XP_RATE。

### 4.4 跨级 XP 桥接（`heroDeltaGain`，`app/src/core/tracker.ts:118`）

```
heroDeltaGain(prev, curLevel, curExp) → number
```

- `prev === undefined` → 0。
- **Level-up reset**：`curExp < prev.exp` → 直接返回 `curExp`（英雄升级时把上一级 XP 银行化并重置 within-level 计数器，新 curExp 就是 reset 后的 gain）。
- **Level curve 路径**（`prev.level > 0 && curLevel > 0`）：调用 `perHeroGain(prev.level, prev.exp, curLevel, curExp)`（`app/src/core/levelCurve.ts`）。
  - 同级：`exp1 - exp0`（cap 状态返回 0，避免 phantom XP）。
  - 升级：`xpThroughLevelUp(lv0, exp0, lv1, exp1)` = `(curve[lv0] - exp0) + Σ curve[intermediate] + exp1`（最终级若超 cap 则不加 exp1）。
  - curve 是 hardcoded level→total XP 表（levels 1-100）。
- **Fallback**（level 未知）：`max(0, curExp - prev.exp)`。

### 4.5 healInflatedXpTotals（自愈）

`syncXpFromLiveMeter` 末尾调用。检查 `cumulativeGained`、`sessionRateValue`、`rollingRateValue`、所有 `heroMeters.gained` 是否通过 `isPlausibleCumulativeXp` / `isPlausibleXpRate`。未通过则用 rollingRate 推算 healedTotal，重置 liveXp 与越界的 heroMeters。

### 4.6 buildStats（`app/src/main/stats.ts`）

`buildStats(tracker, chestDropTracker, boxOpenTracker, dpsTracker, lastSnap, lastError, statusOverride, liveFrame, boxOpenPriceResolver, lootStatus, catalog) → Stats`

**live-preferred / save-fallback blend 策略**：

- `liveXp = liveFrame?.connected === true && tracker.xpLiveActive()` — live 帧已连接且 5 秒内有数据。
- **heroes**：liveHeroes 为 true → 用 `liveFrame.heroes` 构造 `HeroRate[]`（含 `heroLevelEstimate` 计算 `xpToNextLevel` 和 `timeToLevelSec`）；否则用 `lastSnap?.heroes ?? tracker.heroes`，过滤 `unlocked || exp > 0`。
- **stageKey**：live 优先（`liveFrame.stageKey`），否则 `lastSnap.stageKey ?? 0`。
- **stageWave**：live `stageWave` → `dpsTracker.currentWave`（实时推断）→ `lastSnap.stageWave`（兜底）。
- **status**：`statusOverride` > `lastError` > `secondsSinceGain > 120 ? "No XP gained for Xs..."` > `"Tracking"`。
- **secondsSinceRead**：`nowSeconds() - lastSnap.saveMtime`（save 内容年龄，非 poll 间隔）。
- 其它字段：rollingRate、sessionRate、goldRate、cumulativeGained、goldGained、elapsed、secondsSinceGain、stageName（用 catalog 本地化）、history（visible 50 条，每条带 stageName）、chestDrops、boxOpens、dps、mapDamage、mapMobsKilled、sessionDamage、sessionMobsKilled、aliveMonsters、hpSum、hpMaxSum。

### 4.7 blend.ts 纯函数（`app/src/core/liveMemory/blend.ts`）

```ts
export function pickPreferLive<T>(live: T | null | undefined, save: T): T {
  return live ?? save;
}
export function blendStage(live, save) {
  return {
    stageKey: pickPreferLive(live?.stageKey, save.stageKey),
    stageWave: pickPreferLive(live?.stageWave, save.stageWave),
  };
}
```

`stats.ts` 没有直接调 `blendStage` —— 它把 blend 逻辑内联了，因为 stageWave 有第三级 fallback（dpsTracker.currentWave），无法用纯 `pickPreferLive` 表达。`blend.ts` 是给其他消费者（如 `TrackingService.rebuildStatsAfterSave`）使用的单一真理源。

### 4.8 detectHeroLevelUps（`app/src/core/heroes/detectLevelUps.ts`）

```
detectHeroLevelUps(prev: HeroSnapshot[], next: HeroSnapshot[]) → HeroLevelUpEvent[]
```

`prev.length === 0` → `[]`（首次解析不触发）。否则用 `prevByKey = Map(prev.map(h => [h.key, h.level]))`，遍历 next 找 `hero.level > previousLevel` 的英雄，返回 `{ key, previousLevel, newLevel }[]`。

### 4.9 TrackingService 1Hz tickTimer

- `autoClassify?.tick()`（无论是否 broadcast 都跑，保证 prompt 超时与队列 prune 准确）。
- **stale-frame guard**：若 `lastLiveFrame` 超过 5000ms 未更新 → 清空 `lastLiveFrame` 和 `lastLiveStage`，避免 worker 崩溃后 stage/DPS 卡死。
- **节流**：若距上次 live broadcast < 200ms（`LIVE_BROADCAST_INTERVAL_MS`）→ 跳过 pushStats；否则 `pushStats()`。

---

## 5. LiveMemory 业务流程

### 5.1 启动条件

`appState.ts`：

```ts
if (config.liveMemory.enabled && config.liveMemory.consentAccepted) liveMemory.start();
liveMemory.setOnSnapshot((snap) => tracking.ingestLiveFrame(snap));
```

三个前置条件：
1. `config.liveMemory.enabled` — 用户在 Settings 勾选开启 Live Memory。
2. `config.liveMemory.consentAccepted` — 用户确认"我知道这会读取游戏进程内存"同意弹窗。
3. **进程检测延后到 worker 内部** — `LiveMemoryService.start()` 不主动检测游戏进程；它只 fork worker，由 worker 的 `loop()` 在 `reader.attach()` 内通过 `WinProcess.findByNames(["TaskBarHero.exe", "TaskbarHero.exe"])` 寻找游戏。游戏未启动时 worker 进入 1500ms 重试轮询（`POLL_DETACHED_MS`）。

`LiveMemoryService.start()` 是幂等的（`if (this.child) return`），重复调用不会 fork 多个 worker。

### 5.2 utilityProcess worker 启动与消息协议

#### 5.2.1 fork 流程（`app/src/main/services/LiveMemoryService.ts:69-92`）

```ts
const workerPath = join(__dirname, "liveMemoryWorker.js");
this.child = utilityProcess.fork(workerPath, [], {
  serviceName: "tbh-live-memory",
  stdio: "pipe",
  env: { ...process.env, [LIVE_MEMORY_USER_DATA_ENV]: resolveUserDataDir() },
});
```

- electron-vite 把 `worker.ts` 编译到 `out/main/liveMemoryWorker.js`，与 main bundle 同目录。
- `stdio: "pipe"` — 主进程接管 worker 的 stdout/stderr；stderr 被截到 64KB 滑动窗口（`STDERR_MAX_BYTES`），便于崩溃诊断而不是无限增长。
- `LIVE_MEMORY_USER_DATA_ENV`（"TBH_USER_DATA"）— worker 通过它定位 offset cache 目录。

#### 5.2.2 消息协议

主→worker：纯字符串 `"stop"`。

worker→主：3 种 typed object：

```ts
type WorkerMessage =
  | { type: "snapshot"; snapshot: LiveMemorySnapshot }
  | { type: "status"; status: LiveMemoryStatus }
  | { type: "log"; message: string };
```

主进程接收端：
- **`snapshot`** — 后处理（注入本地化英雄名 `localizeHeroes`）→ 缓存为 `lastSnapshot` → 节流 200ms 广播给 renderer（`IPC.LIVE_MEMORY`）→ **不节流**地调用 `snapshotCb`（即 `tracking.ingestLiveFrame`）。tracker 拿到全 25Hz 数据用于精确采样，UI 只刷 5Hz。
- **`status`** — 缓存为 `lastStatus` → 立即广播给 renderer（`IPC.LIVE_MEMORY_STATUS`）→ 若 `gameVersion` 变化，触发 `onGameVersionChanged` 回调（被 `CatalogRefreshService` 接住）。
- **`log`** — 转发到 main logger。

`worker.ts` 的 `postStatusIfChanged`：序列化 `LiveMemoryStatus` 为 JSON 字符串作为 fingerprint，仅当 fingerprint 与上次不同才发 `status` 消息。把 25Hz 的状态噪声降到事件驱动。

### 5.3 worker 初始化流程

入口 `worker.ts:42-53`（顶层执行）→ `loop()`（`worker.ts:202-250`）。

#### 5.3.1 进程附加（`LiveMemoryReader.attach()`，`app/src/main/liveMemory/liveReader.ts:442-465`）

1. 若已 attached，直接调 `healOffsets()` 并返回。
2. 否则 `detach()` 清理上一次状态。
3. `WinProcess.findByNames(["TaskBarHero.exe", "TaskbarHero.exe"])`：
   - 先用 `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` 列所有进程，按名字匹配。
   - 若匹配为空，fallback `findViaPowerShell`。
   - 多实例（多个匹配）时按"沙箱状态一致"挑选（见 5.10）。
4. `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)` — 只读权限，不要求管理员。
5. `refreshGameContext()`：
   - `detectGameVersion(proc)` — 找 `taskbarhero.exe` 模块的 path，读同目录 `Version.txt`，正则 `^\d+\.\d+\.\d+$` 校验。失败时保留之前的 gameVersion。
   - `gameAssembly(proc)` — 在模块列表里找 `gameassembly.dll`，取其 `baseAddress` 和 `size`。
6. 进入 `setScanning(true)`（触发 `onScanningChange` → worker 发 status）→ `resolveOffsets` → `applyResolvedOffsets` → `setScanning(false)`。

#### 5.3.2 ga base 解析

`ga = { base: bigint; size: number }`，来自 `WinProcess.listModules()` 找到的 `gameassembly.dll`。整个 IL2CPP 元数据扫描都限制在 `[ga.base, ga.base+ga.size)` 范围内，避免扫描整个地址空间（30-60s vs 几秒）。

如果 `listModules()` 返回空（沙箱拦截），三级 fallback（见 5.10）。三级都失败时 `ga=null` → `resolveOffsets` 在 `if (ga && version && cacheDir)` 处短路 → reader 处于 `attached=true, supported=false` 的"降级"状态。

#### 5.3.3 offsets 解析优先级与回退链路

`LiveMemoryReader.resolveOffsets()`（`liveReader.ts:566-807`）：

**Step 1 — Bundled 表**（`liveReader.ts:590-599`）：
- `offsetsForVersionMeta(version)` 返回 `{ table, fallback }`。
- 精确命中：`fallback=false`，`source="bundled"`。
- 同 major.minor 邻近版本命中：`fallback=true`，table 上贴 `_fallbackFromVersion: <bestVersion>`，`source="bundled"`。
- 都不命中：`base=null`，准备走纯 extractor 路径。

**Step 2 — Disk cache**（`liveReader.ts:612-635`）：
- `loadCachedOffsets(cacheDir, version, EXTRACTOR_REVISION)`：
  - 文件不存在/JSON 解析失败/version 不匹配 → 返回 null。
  - envelope 的 `extractorRevision < EXTRACTOR_REVISION` → 返回 null（强制重跑，避免旧 bug 的缓存留存）。
  - 兼容两种磁盘格式：envelope `{ gameVersion, extractorRevision, offsets }` 与 legacy 裸 `LiveOffsets`。
- 当 cache 比 bundled 更完整（或等完整但 cache 是 extractor-validated 的）→ 用 cache，`source="cache"`。保留 `_fallbackFromVersion` 标记。

**Step 3 — Complete short-circuit**（`liveReader.ts:637-657`）：
- `isOffsetTableComplete(base)` 为 true 且无强制重跑信号 → 直接返回 base，跳过 extractor。
- 两个强制重跑信号：`forceExtractForCatalogDump`（`TBH_DUMP_CATALOG_CANDIDATES=1`，仅诊断）和 `forceReextract`（cache pollution 检测到，见 5.9）。

**Step 4 — Extractor 决策**（`liveReader.ts:670-801`）：
- 计算两个布尔：
  - `forceCriticalPath = isFallbackTable && isCriticalStaleOnBaseline(base)` — 同版本 fallback 且 critical RVAs 还在 baseline 状态。
  - `useCriticalBudget = !isSupported || forceCriticalPath` — 决定消耗哪个预算。
- `mayExtract = forceReextract || forceExtractForCatalogDump || (useCriticalBudget ? mayAttemptExtraction : mayAttemptEnrichment)`。
- 预算耗尽 → 不跑 extractor，记录日志，返回 base。
- 允许跑 → 记录一次尝试 → `extractOffsets(proc, ga, version, log, !useCriticalBudget, base)`：
  - `enrichmentOnly=!useCriticalBudget` — critical 模式跑全部锚点；enrichment 模式只跑 LogManager / BoxOpenLog / MonsterSpawnManager / PlayerSaveData。
  - 任意 critical 锚点失败（StageManager / StageCacheManager）→ 返回 null。
  - CurrencyManager 失败不再致命（v1.00.28 重构后无法推导）。
- derived 非 null → `mergeOffsets(baseForMerge, derived.offsets)`：
  - 同版本 base：base 非零字段被信任，derived 填空。
  - fallback base（`_fallbackFromVersion` 存在）：**derived-wins** — derived 非零字段覆盖 base。保证 fallback 表的 stale RVAs 能被 extractor 重新推导覆盖。
  - cache-pollution 强制模式下，先手动把 base 的 `getItemWithBoxOpenTypeKey` 和 `boxOpenLog.{itemStringKey, itemGradeType, gradeSO, gradeSOGrade, boxType, level}` 清零再 merge，让 derived 填空。
- 合并结果写 `_extractorRev = EXTRACTOR_REVISION`，`saveCachedOffsets` 原子写入磁盘。
- **Rev 13 新增**：若 `useCriticalBudget=true` 且 derived 的 `stageManager` + `stageCacheManager` RVA 都非零，再写 `_criticalRvasValidated = true`。失败 / null 返回 / enrichment-only 模式都不写此字段 → `isCriticalStaleOnBaseline` 仍返回 true，等 Path 1.6 触发重试。
- `source = base ? "merged" : "extracted"`。

**Step 5 — Degraded fallback**（`liveReader.ts:802-806`）：
- 全部失败 → 返回 `{ table: base, source, classIndex: null }`，base 可能仍为 null（完全降级到 save-only）。

### 5.4 防死循环机制

#### 5.4.1 四种"标记字段"

| 字段 | 位置 | 作用 |
|------|------|------|
| `EXTRACTOR_REVISION` | `offsetExtractor.ts` 常量 = 13 | 提取器策略版本；bump 后所有旧 cache 自动失效。Rev 13 引入 `_criticalRvasValidated`、LogManager name-scan fallback、cache-pollution 检测器扩展、`findBoxDataFields` 结构化派生、StageManager-availability transition（Path 1.6） |
| `_extractorRev` | `LiveOffsets._extractorRev?` | 单表上的标记：本次表的产出 revision。envelope 里也存一份 `extractorRevision`。**Rev 13 起 `isCriticalStaleOnBaseline` 不再读它**（旧的 `_extractorRev`-based 检查有死锁：extractor 跑过一次即使是失败也会设此标记 → 永远不重试）。仍用于 `enrichmentAlreadyAttempted` 判断（决定 Path 2 是否重置 enrichment 预算） |
| `_fallbackFromVersion` | `LiveOffsets._fallbackFromVersion?` | provenance 标记：当前表是同 major.minor 邻居 fallback 而来；`mergeOffsets` 保留它跨 cache |
| `_criticalRvasValidated` | `LiveOffsets._criticalRvasValidated?`（Rev 13 新增） | **liveness 标记**：extractor 在 critical 模式下成功派生（或确认）了 `stageManager` + `stageCacheManager` RVAs。仅当 `useCriticalBudget=true` 且两个 RVA 都非零时设为 true。`isCriticalStaleOnBaseline` 用此字段替代 `_extractorRev` 判断 baseline 是否可信。失败/未跑过 critical 路径都不设 → reader 会重试，但重试由 `consumeSmTransition`（Path 1.6）触发，不是 30s 定时器，避免无限循环 |

#### 5.4.2 两个独立预算（`offsetHealing.ts`）

- **critical budget** (`MAX_EXTRACTION_ATTEMPTS=3`) — gating `extractOffsets(enrichmentOnly=false)`。
- **enrichment budget** (`MAX_ENRICHMENT_ATTEMPTS=1`) — gating `extractOffsets(enrichmentOnly=true)`。
- 每个预算按 `(gameVersion, appBuild, extractorRevision)` 三元组键控。任一维度变化（新版本/新构建/新 extractor revision）→ 预算自动重置为 0。

#### 5.4.3 `isCriticalStaleOnBaseline`（`liveReader.ts:163-173`）

判断当前 offset 表是不是"还在 baseline 状态的 fallback 表"（即 extractor 尚未成功派生 fresh critical RVAs）：
1. `_fallbackFromVersion` 必须存在（同 major.minor 邻居 fallback 而来）。
2. `_criticalRvasValidated` 必须为 falsy（Rev 13 用此字段替代旧的 `_extractorRev` 检查）。
3. 当前表的 `stageManager` / `stageCacheManager` RVA 必须与 bundled fallback 表的 RVA 完全相等。

三个条件同时满足 → extractor 还没机会（或上次失败）重新推导 critical RVAs，baseline RVA 仍是 fallback 来的 stale 值。一旦 extractor 在 critical 模式下成功派生（`useCriticalBudget=true` 且两个 RVA 都非零），`_criticalRvasValidated` 写入 cache，此函数返回 false。

**关键修复**：旧的 `_extractorRev`-based 检查有死锁——extractor 跑一次（即使是 StageManager 未实例化导致的失败 / null 返回）也会写 `_extractorRev` → 此函数返回 false 永远不重试 → critical budget 永不重置 → RVAs 永久卡在 stale baseline。`_criticalRvasValidated` 仅在**成功**派生时才设，失败不设 → reader 会重试；但重试由 `consumeSmTransition`（Path 1.6，事件驱动）触发，不是 30s 定时器，避免无限循环。

#### 5.4.4 `enrichmentAlreadyAttempted`（`liveReader.ts:345-347`）

`return this.offsets?._extractorRev != null;` — 当前表上是否有 extractor 跑过的痕迹。

#### 5.4.5 worker maybeHealEnrichment 5 条路径

| 路径 | 触发条件 | 是否重置预算 | 是否受预算 cap | 防死循环依据 |
|------|----------|--------------|------------------|----------------|
| **Path 1** box-open event | `consumeBoxOpenEvent()` 返回 true（0→>0 转换） | 是（`resetEnrichmentBudget`） | 否 | 一次性 flag，被 consume 后清零，不会重复触发 |
| **Path 1.5** cache pollution | `needsForcedReextract === true` | 是（同时重置 critical + enrichment，见 5.8.3） | 否（绕过 cap） | `forceExtractorNextHeal` 是 one-shot，extractor 跑完即清零 |
| **Path 1.6** StageManager transition（Rev 13 新增） | `consumeSmTransition()` 返回 true（玩家进入关卡，StageManager 单例从无到有） | **是（仅重置 critical 预算，不动 enrichment）** | 否 | `smTransitionPending` 是一次性 flag，consume 后清零；玩家进关卡的 transition 是离散事件不会重复触发 |
| **Path 2** enrichment fallback timer | `!enrichmentComplete` && 30s 到期 | **仅当 `!enrichmentAlreadyAttempted` 时重置 enrichment** | 是 | 一旦 extractor 跑过（`_extractorRev` 存在），不再重置预算；预算耗尽 → `resolveOffsets` 短路 → `healOffsets` 几毫秒返回 |
| **Path 3** critical-stale-on-fallback timer | `isCriticalStaleOnFallback` && 30s 到期 | **否（Rev 13 起 critical 预算不在此重置，仅 Path 1.6 重置）** | 是 | Rev 13 前 `healOffsets` 内会无条件 `resetCriticalExtractionBudget()` → 每 30s 跑一次 ~9s extractor 的无限循环；Rev 13 改为 Path 3 只让 extractor 跑完初始 3 次尝试，真正的恢复信号由 Path 1.6（玩家进入关卡）提供 |

**关键死循环场景与防御**：

- **场景 A**：v1.01.02 玩家在主菜单 attach → StageManager 单例未实例化 → extractor 3 次 critical 失败 → 预算耗尽 → 永远 stuck 在 stale baseline。
  - **Rev 13 防御**：critical 预算耗尽后 Path 3 变成廉价 no-op（`resolveOffsets` 短路几毫秒返回），不会无限重试。当玩家进入关卡 → StageManager 单例从无到有 → `read()` 内 `smWasAvailable` 翻转 → 设置 `smTransitionPending` → 下一 tick `maybeHealEnrichment` Path 1.6 调 `consumeSmTransition()` → 重置 critical 预算 → 立即 `healOffsets()` → extractor 在 critical 模式下成功派生 fresh stageManager/stageCacheManager RVAs → `_criticalRvasValidated=true` → `isCriticalStaleOnBaseline` 返回 false → Path 3 停止。这是 Rev 13 的核心修复。
- **场景 B**：v1.01.02 BoxOpenLog 字段名混淆（bfpc/bfpd/bfpe）→ `identifyBoxOpenLogFieldsByValue` value-based scanner 需要识别字段。
  - **已修复**：v1.01.02 的 `itemStringKey` 是 `System.String` 指针（非裸 int32），其低 32 位可能为正值（如 `0x57509000`），旧代码仅在 `v < 0` 时尝试 pointer→String 路径，导致正值指针被误判为 plain i32 → `isPlausibleItemKey` 返回 false → `bestItemKeyOffset` 永远为 0 → 识别失败。修复后条件扩展为 `v == null || v < 0 || (!isPlausibleItemKey(v) && !isPlausibleGrade(v))`，正值非 plausible 的 i32 也尝试 pointer→String→number 路径。
  - **防御**：若 extractor 仍验证失败（如玩家未开过箱、LogManager dict 无 BoxOpen 桶），Path 2 检查 `enrichmentAlreadyAttempted`，若为 true 不重置预算。`mayAttemptEnrichment` 返回 false → `resolveOffsets` 短路 → `healOffsets` 几毫秒返回。用户看不到"scanning"闪烁。
- **场景 C**：cache pollution（baseline `getItemWithBoxOpenTypeKey` 值被错误信任）。
  - **防御**：Path 1.5 一次性 flag → extractor 跑一次 → flag 清零。即使 extractor 没修好，也不会重复触发，直到下一次 60s 失败 streak 重新检测。
- **场景 D**（Rev 13 新增）：游戏小版本更新后，fallback 表的 LogManager TypeInfo RVA 失效（指向错误 class），25Hz 读取持续返回 "LogManager singleton unresolved"。
  - **防御**：cache-pollution 检测器（5.8.3）正则扩展为 `/LogManager singleton unresolved|dict lookup failed|list not walkable/i`，60s 持续失败 → Path 1.5 触发。同时 `read()` 内首次检测到此 status → 设置 `logManagerNameScanPending` → worker 调 `runLogManagerNameScan()`（5.8.4）按类名直接定位 LogManager 单例，绕过 stale RVA。两条 fallback 互补：name-scan 立即恢复日志读取，cache-pollution 异步让 extractor 重新派生 RVA 写入 cache。

### 5.5 worker 25Hz 轮询

`worker.ts:202-250` 的 `loop()`：

```
schedule(POLL_ATTACHED_MS=40ms 或 POLL_DETACHED_MS=1500ms)
↓
loop():
  if (!reader.attached) reader.attach(); postStatusIfChanged()
  else:
    maybeHealUnsupported()      // 10s 周期，仅当 !supported
    maybeHealEnrichment()       // 30s 周期或事件驱动，仅当 supported
    if (attached && supported):
      if (runPendingNameScans()): skip read this tick  // 30-60s name scan 不阻塞 25Hz
      else: snap = reader.read(); post({type:"snapshot", snapshot: snap})
  schedule(next)
```

#### 5.5.1 每 tick 读取的字段（`LiveMemoryReader.read()`，`liveReader.ts:866-1033`）

| 字段 | 函数 | 频率 | Pin 状态 |
|------|------|------|----------|
| StageManager 单例 | `resolveStageManager` (`runtime.ts:515`) | 25Hz | `smPin` — 缓存指针 + 每次重新 `isLiveStageManager` 验证 |
| Stage | `readRuntimeStage` (`runtime.ts:40`) | 25Hz | 复用 smPin；读 `StageCacheManager → StageCache → StageInfoData` |
| Monster HP | `readRuntimeMonsterHp` (`runtime.ts:1718`) | 25Hz | `monsterPin` — 缓存 MonsterSpawnManager 指针 + cachedHpOffsets |
| Heroes | `readRuntimeHeroes` (`runtime.ts:473`) | 25Hz | 复用 smPin；读 `StageManager.HeroList → Unit.cache → HeroRuntime` |
| Chest drops | `readRuntimeChestLog` (`runtime.ts:721`) | 25Hz | `chestPin` — 缓存 LogManager 指针 + tail 位置 + primed 标志；entry 读取带 `CHEST_LOG_SAMPLES=3` 重试（防 boss 死亡/stage transition 时的 mid-write race 静默丢条目）。LogManager liveness 校验为 dict 结构校验（`logByType` 指针非 null + count > 0 且 < 1000 + entries array 非空）——比"dict 指针非 null"严格（防止非 LogManager 对象误通过），比"GetBox bucket 可 walk"宽松（避免战斗中 bucket 暂时不可读时 LogManager 被误判失效） |
| Box opens | `readRuntimeBoxOpenLog` (`runtime.ts:1006`) | 25Hz | `boxOpenPin` — 同 chest pin 结构 |
| Box-open event 探测 | `peekBoxOpenLogCount` (`runtime.ts:973`) | 25Hz（仅当 enrichment 未完成） | 复用 boxOpenPin 但不动 tail |
| Inventory | `readRuntimeInventory` (`runtime.ts:1229`) | 0.5Hz（每 50 tick） | `cachedInventory` — tick 间复用 |
| Pets | `readRuntimePets` (`runtime.ts:1360`) | 0.5Hz | `cachedPets` |
| Chest slots | `readRuntimeChestSlots` (`chestSlots.ts:91`) | 25Hz | 无 pin（廉价） |
| Combat gold | `readRuntimeCombatGold` (`runtime.ts:210`) | 25Hz | `combatGoldPin` — 缓存 list/arr/entryIndex |
| Wallet gold | `readRuntimeGold` (`runtime.ts:144`) | 25Hz（仅当 combat gold 返回 null） | `goldPin` — 缓存 entry pointer |
| Stage clears | `readRuntimeStageClears` (`runtime.ts:856`) | 25Hz | `stageClearPin`；entry 读取带 `STAGE_CLEAR_LOG_SAMPLES=3` 重试（防 stage clear 时的 mid-write race 静默丢条目，保留 `valid=false` 语义处理持续损坏的条目） |

低频字段（inventory/pets）的原因：库存最多 100k 条目、宠物最多 500 条，25Hz 全读会爆 V8 GC。50 tick 缓存（~2s）够用因为这些字段只在 save 事件变化。

### 5.6 snapshot 帧从 worker 传回主进程 + bufferPool

```
worker.read() → LiveMemorySnapshot 对象
  ↓ parentPort.postMessage({type:"snapshot", snapshot: snap})
  ↓ structured clone 序列化跨进程
  ↓ LiveMemoryService.on("message") 反序列化为新对象
  ↓ localizeHeroes(snap) — 就地修改（safe，因为是新反序列化的对象）
  ↓ lastSnapshot = snap
  ↓ broadcast(IPC.LIVE_MEMORY, snap) — 200ms 节流，发送给 renderer
  ↓ snapshotCb(snap) — 不节流，调用 tracking.ingestLiveFrame
```

`BufferPool`（`winProcess.ts:8`）是 `WinProcess.readBytes` 内的 per-process buffer 池：
- 25Hz tick × 多次 readBytes × 每次 `Buffer.alloc` 会产生百万级零填充分配/秒，淹没 V8 GC。
- `bufPool.acquire(size)` 优先复用之前 `release` 的同尺寸 buffer；用 `allocUnsafe`（不零填充）。
- 失败的 read（`ReadProcessMemory` 返回 false 或 0 字节）→ `release(buf)` 归还。
- 短读（部分字节）→ 也 `release` 并返回 null，避免 subarray 越界。
- 成功返回的 buffer 不归还（caller 可能持有），池主要帮助扫描器（4MiB chunk 反复读同尺寸）而非 25Hz 小读取。

### 5.7 TrackingService.ingestLiveFrame 处理流程

`TrackingService.ts:688-845`。按调用顺序：

1. `!snap.connected` 直接 return。
2. `lastLiveFrame = snap`。
3. `tracker.updateLive({ gold: snap.gold, heroes: snap.heroes }, snap.at / 1000, stage)` — 喂 XpTracker。
4. **stageEventBaseline 初始化**：若 null，用 `tracker.cumulativeGained` 和 `tracker.currentGold` seed。
5. **DPS / monster tracking**：若 `snap.monsterHp != null`，检测 **stage 切换**（`stageKey` 变化，含首次 live frame）→ `dpsTracker.beginMap()`；随后 `dpsTracker.update(monsterHp, deadMonsterCount, timestamp)`。**注意**：stage 内 wave 推进（1→2→3...）**不**触发 `beginMap()` —— 早期实现把 `stageWave` 变化也视为地图切换，导致 `_wavesCleared` 每波重置为 0、`currentWave` 永远卡在 1（"波次识别卡住" bug）。per-map 计数（`mapDamage`/`mapMobsKilled`）在 stage 内跨波累计，符合"当前地图总量"语义。
6. **live chest drops**：检测 `snap.chestLogDebug.count < lastCountBefore` → warn（log 缩小是重复记录的特征）。`chestAggregator.feed(snap.chestDrops ?? [], chestAt)` 返回 collapsed categories，对每个 category 调用 `chestDropTracker.recordLiveChestDrop(category, chestAt)` → 成功且 category="rare" → `onLiveStageBossDrop?.(stageKey)` → `boxTimers.tryMarkDroppedFromLiveStage`。
7. `onLiveChestSlots?.(snap.chestSlots)` — 当前不路由到 AutoClassify（保留接口）。
8. **stage clears**：若 `snap.stageClears.length > 0`：
   - `dpsTracker.beginMap()`（关卡完成也重置 per-map 计数）。
   - `fallbackStageKey = snap.stageKey ?? lastSnap?.stageKey ?? 0`。
   - 过滤 `clears = snap.stageClears.filter(c => c.valid)`。
   - 若 `stageEventBaseline` 非 null：`totalXpGained = xp - baseline.xp`，`totalGoldGained = gold - baseline.gold`；按 n 分配，最后一个用余数；`resolveClearedStageKey(clears[i].act, clears[i].stage, fallbackStageKey)` 恢复难度（stageKey 已前进到下一关，所以用 clear 自己的 act/stage 而非当前 stageKey） → `onLiveStageClear?.(clearedStageKey, clearTimeSec, xpGained, goldGained)`。
   - 更新 `stageEventBaseline = { xp, gold }`。
9. **box opens**：对每个 `snap.boxOpens` 调用 `resolveBoxOpenEntry(entry)` 解析 boxKey/itemKey/name/grade → `boxOpenTracker.recordOpen(...)`。
10. **节流 broadcast**：若 `Date.now() - lastLiveBroadcastMs >= 200` → `pushStats()`。

### 5.8 offset healing 机制

#### 5.8.1 三个周期

| 周期 | 常量 | 路径 | 调用条件 |
|------|------|------|----------|
| 10s | `HEAL_UNSUPPORTED_MS` | `maybeHealUnsupported` (`worker.ts:89-101`) | `attached && !supported` |
| 30s | `HEAL_ENRICHMENT_FALLBACK_MS` | `maybeHealEnrichment` Path 2/3 (`worker.ts:136-200`) | `attached && supported && (!enrichmentComplete \|\| isCriticalStaleOnFallback)` |
| 即时 | event-driven | `maybeHealEnrichment` Path 1 / 1.5 / 1.6 | box-open event / cache pollution / StageManager transition |

#### 5.8.2 critical path vs enrichment path

`healOffsets()`（`liveReader.ts:555-586`，**Rev 13 起不再在内部重置 critical 预算**）：

1. `refreshGameContext()` — 重新读 Version.txt 和 GA base。
2. `resolveOffsets(proc, appBuild)`：
   - 决定 `useCriticalBudget = !isSupported || forceCriticalPath`。
   - critical 模式：`extractOffsets(enrichmentOnly=false)`，跑全部锚点；任一 critical 失败返回 null。
   - enrichment 模式：`extractOffsets(enrichmentOnly=true)`，只跑 LogManager/BoxOpenLog/MonsterSpawnManager/PlayerSaveData；critical 字段保留 base 值。
3. `applyResolvedOffsets` — 更新 `supported` / `offsetSource` / `offsets`。
4. 日志：从 unsupported 翻到 supported 时记 "offsets now supported"；仍 unsupported 时列 critical missing；仍 stale-on-baseline 时记 "still on stale baseline RVAs"（提示恢复需等 Path 1.6）。

**critical 预算重置点已迁移**：旧版（Rev ≤12）`healOffsets()` 内 `if (isCriticalStaleOnFallback) resetCriticalExtractionBudget()` 会每 30s 重置一次，导致 extractor 在 StageManager 未实例化时无限重跑（每次 ~9s）。Rev 13 起此 reset 仅在 `consumeSmTransition()`（Path 1.6 触发）和 `detectCachePollution()`（Path 1.5 触发）内执行，二者都是事件驱动而非定时驱动。

#### 5.8.3 cache pollution 检测与自愈（`liveReader.ts:1224-1295`）

**检测条件**（任一满足即可，用同一个 60s 计时器 `dictFailSince`；正则 `isDictLookupFail` 在 Rev 13 扩展）：

```typescript
const isDictLookupFail = (s: string) =>
  /LogManager singleton unresolved|dict lookup failed|list not walkable/i.test(s);
```

- **boxOpen dict-fail**：`readRuntimeBoxOpenLog.opens == null` 且 `boxOpenResult.status` 匹配 `isDictLookupFail`。表示 `getItemWithBoxOpenTypeKey` / `boxOpenLog.itemStringKey` 是未验证的 baseline 副本。
- **chest drops dict-fail**：`readRuntimeChestDrops.drops == null` 且 `chestResult.status` 匹配 `isDictLookupFail`。表示 `logManager` TypeInfo RVA 本身对当前 build 无效，或 `runtime.log.logByType` 是污染值。
- **LogManager singleton unresolved**（Rev 13 新增）：fallback 表的 `logManager` RVA 指向错误 class → 静态块扫描找不到 LogManager 实例。这是 v1.01.02 fallback from v1.01.01 的典型签名（同 major.minor 邻居版本 LogManager RVA 偶尔会偏移到无关 class）。
- 当 boxOpen 和 chest drops **同时** dict-fail 时，LogManager 本身就是问题所在 —— `_criticalRvasValidated` 因上次 extractor 跑过（即使失败）而不被信任校验，cache-pollution 路径是唯一剩余的触发器。

**触发流程**：
1. 首次检测到任一 dict-fail → 记录 `dictFailSince = Date.now()`，本 tick 不动作。
2. 持续 60s（`BOX_OPEN_FAIL_HEAL_MS`）→ 设置 `forceExtractorNextHeal = true` + **同时 `resetCriticalExtractionBudget()` + `resetEnrichmentBudget()`**（Rev 13 新增 critical 重置，因为污染的 cache 也可能让 critical 路径的尝试次数耗尽）。
3. worker 下一 tick 的 `maybeHealEnrichment` Path 1.5 检测到 `needsForcedReextract` → 立即 `healOffsets()`。
4. `resolveOffsets` 内 `forceReextract` 为 true → 绕过 `isOffsetTableComplete` 短路 + 绕过预算 cap。
5. extractor 跑前手动清零 base 的 `getItemWithBoxOpenTypeKey` 和 `boxOpenLog.*` 字段，让 derived 重新填充。`logManager` TypeInfo RVA **不清零**：fallback 场景下 `mergeOffsets` 的 `derivedWins` 规则会让 extractor 派生的新值覆盖 baseline；若 extractor 派生不出（如 StageManager 未实例化），保留 baseline 不降级。
6. extractor 跑完（成功或失败）→ `forceExtractorNextHeal = false` + `dictFailSince = null`。
7. 成功：merged 表覆盖磁盘 cache，下次启动加载干净 cache。失败：用户看到 status-failure 日志，可手动删 cache 目录（`%APPDATA%\tbh-companion\live-memory-offsets\`）。

#### 5.8.4 LogManager name-scan fallback（Rev 13 新增，`liveReader.ts:1444-1490`）

当 `readRuntimeChestLog` / `readRuntimeStageClears` / `readRuntimeBoxOpenLog` 返回 `status` 含 "LogManager singleton unresolved" 时，说明 fallback 表的 `logManager` TypeInfo RVA 对当前 build 无效（静态块扫描走到了错误 class，找不到 LogManager 实例）。`read()` 在首次检测到此 status 时设置 `logManagerNameScanPending` flag（仅触发一次，避免重复扫描）。

worker 下一 tick 在 `runPendingNameScans()` 中检测到 flag，调用 `runLogManagerNameScan(p, ga, o)`：

```
resolveClassByName(p, ga, "LogManager")  // 类名不被混淆
  ↓ 找到 TypeInfo → 静态块扫描第一个 plausible 实例
  ↓ singletonFromClass(p, typeInfo, ga)  // 读 s_Instance 字段
  ↓ isLiveLogManager(p, inst, o)         // 校验 logByType Dictionary 可读 + GetBox bucket 存在
  ↓ 校验通过 → pin 到 chestPin / stageClearPin / boxOpenPin 三个 pin 的 .ptr
```

**与 cache-pollution 的关系**：name-scan 是**即时**恢复路径（一发现就 pin 实例，绕过 stale RVA），cache-pollution 是**异步**根因修复（60s 后让 extractor 重新派生 RVA 写入 cache）。两者互补：name-scan 让日志读取在 25Hz 内立即恢复，cache-pollution 保证下次启动加载到正确的 cache。name-scan 失败不重试（class 找不到或 singleton 字段无法解析属于真正的"LogManager 类未实例化"场景，等 extractor 通过 Path 1.6 派生新 RVA）。

**关键文件路径**：
- `app/src/main/liveMemory/liveReader.ts` — `runLogManagerNameScan()` 实现
- `app/src/main/liveMemory/winProcess.ts` — `resolveClassByName` / `singletonFromClass`
- `app/src/core/liveMemory/runtime.ts` — `isLiveLogManager` 校验函数（Rev 13 新导出）

#### 5.8.5 BoxData 字段结构化派生（Rev 13 新增，`il2cppScanner.ts:findBoxDataFields`）

旧版依赖 BoxData 类的字段名（`BoxTypes` / `BoxQuantity`）匹配偏移，但游戏偶尔混淆这两个字段名（如 v1.00.28），导致 `player.boxTypes` / `player.boxQuantity` 始终为 0，宝箱实时功能在新版本上失效。

Rev 13 引入 `findBoxDataFields(ctx, obj)`，**不依赖字段名**，纯结构特征派生：

```
BoxData 实例 +0x10..INSTANCE_SCAN_MAX，每 8 字节扫一次
  ↓ 找出所有指向 List<int> 的字段（List 指针 plausible + _items 数组 plausible + _size ∈ [1, MAX_BOX_DATA_LIST_COUNT=256]）
  ↓ 在候选 List<int> 字段中找两个 count 相等的
  ↓ 返回 { boxTypes: <第一个 offset>, boxQuantity: <第二个 offset> }
```

**调用时机**：在 `findPlayerSaveData` 内，当 `BoxData` 字段命名匹配成功（`boxData` offset 已知）且 BoxData 实例可达时调用。派生结果写入 `PlayerAnchor.boxTypes` / `PlayerAnchor.boxQuantity`，再由 extractor 落到 `LiveOffsets.boxData.boxTypes` / `LiveOffsets.boxData.boxQuantity`，最后由 `offsetCompleteness.ENRICHMENT_FIELDS` 标记为 enrichment 字段。

**与 save 数据的交叉校准**：`readRuntimeChestSlots` 读取宝箱槽位时，会与 save 解析的 `InventorySnapshot.chests.slots` 数量交叉验证。当 BoxData 派生偏移错误时，chestSlots 读出的 boxTypes 数组长度 ≠ save 的 chests 数量 → 触发 cache-pollution 检测器的间接路径（dict lookup 失败签名），让 extractor 重新派生。

**关键文件路径**：
- `app/src/core/liveMemory/il2cppScanner.ts` — `findBoxDataFields` / `PlayerAnchor` 接口
- `app/src/core/liveMemory/offsetCompleteness.ts` — `ENRICHMENT_FIELDS` 包含 `boxData.boxTypes` / `boxData.boxQuantity`
- `app/src/core/liveMemory/offsets.ts` — `LiveOffsets.boxData` 类型定义
- `app/src/core/liveMemory/chestSlots.ts` — `readRuntimeChestSlots` 使用派生偏移读取

#### 5.8.6 StageManager-availability transition（Path 1.6，Rev 13 新增）

**死锁根因**：v1.01.02 fallback from v1.01.01 场景下，玩家在主菜单 attach → StageManager 单例未实例化 → extractor critical 模式必失败 → 3 次后 critical budget 耗尽。旧版（Rev ≤12）每 30s 重置 critical budget 导致无限 ~9s extractor 跑（占满 CPU）；Rev 12 引入预算 cap 后又出现"预算永不重置 → 永远 stuck"。

**Path 1.6 数据流**：

```
玩家在主菜单 → read() 内 resolveStageManager 返回 null → smWasAvailable=false
   ↓
玩家进入关卡 → resolveStageManager 返回非 null 实例 → smWasAvailable=true → smTransitionPending=true
   ↓
worker 下一 tick maybeHealEnrichment()
   ↓ consumeSmTransition() 检测 smTransitionPending
   ↓ true → resetCriticalExtractionBudget()（仅 critical，不动 enrichment）
   ↓ healOffsets() 立即触发
   ↓ resolveOffsets 走 critical path（!isSupported || forceCriticalPath）
   ↓ extractOffsets(enrichmentOnly=false) → StageManager 单例已实例化 → 成功派生 fresh RVAs
   ↓ mergeOffsets(derived-wins) → stale baseline RVAs 被覆盖
   ↓ _criticalRvasValidated=true → isCriticalStaleOnBaseline 返回 false
   ↓ Path 3 不再触发，恢复完成
```

**防死循环依据**：`smTransitionPending` 是一次性 flag，consume 后立即清零（`consumeSmTransition()` 第一行就 reset）；玩家进关卡的 transition 是离散事件不会重复触发（除非玩家反复进出关卡，但每次进入都是合法的恢复机会）。

**为什么不用 30s 定时器**：StageManager 单例是否实例化取决于玩家行为（在主菜单 vs 在关卡），与时间无关。30s 定时器要么过频（玩家一直在主菜单，每 30s 跑一次 9s 浪费 CPU），要么过慢（玩家进入关卡后还要等下次 30s tick 才恢复）。事件驱动的 Path 1.6 在玩家进入关卡的**下一 tick（40ms 内）**就触发恢复，延迟最低。

**关键文件路径**：
- `app/src/main/liveMemory/liveReader.ts:461-468` — `consumeSmTransition()` 实现
- `app/src/main/liveMemory/liveReader.ts:261-274` — `smWasAvailable` / `smTransitionPending` 字段
- `app/src/main/liveMemory/worker.ts:179-189` — Path 1.6 worker 端入口

### 5.9 沙箱（Sandboxie-Plus）下的三条模块枚举 fallback

`WinProcess.listModules()`（`winProcess.ts:479-508`）的三级链：

#### Path 1: ToolHelp（`listModulesViaToolhelp`，`winProcess.ts:510-532`）
- `CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)`。
- `Module32FirstW` / `Module32NextW` 遍历。
- **Sandboxie-Plus 拦截**：即使 companion 与 game 都在同一个沙箱内，CreateToolhelp32Snapshot 也可能返回空快照。

#### Path 2: PSAPI（`listModulesViaPsapi`，`winProcess.ts:544-577`）
- `EnumProcessModulesEx(handle, null, 0, &needed, LIST_MODULES_ALL)` 询问所需 buffer 大小。
- 分配 buffer → 第二次调用填充 HMODULE 数组。
- 对每个 HMODULE：`GetModuleFileNameExW` 拿路径 + `GetModuleInformation` 拿 base/size。
- **优点**：直接在已 opened 的 handle 上调用，不创建 snapshot，沙箱通常不拦截。
- **缺点**：返回的是 HMODULE 数组（8 字节指针），需要二次调用拿名字和尺寸 —— 比 ToolHelp 慢但可靠。

#### Path 3: PowerShell（`listModulesViaPowerShell`，`winprocess.ts:579-621`）
- `Get-Process -Id <pid>` → `$p.Modules | Select ModuleName, FileName, BaseAddress, ModuleMemorySize | ConvertTo-Json`。
- **最慢**：fork 子进程 + PowerShell 启动开销 ~100-300ms。
- 仅在前两条都返回空时触发，并通过 `winProcessLogger` 记录原因。

**多实例沙箱隔离**（`winProcess.ts:330-390`）：

当 ToolHelp 返回多个 TBH 进程时（host + sandboxed）：
1. `isCurrentProcessInSandbox()` — 自检：`process.env.sandbox` 或 `GetModuleHandleW("sbiedll.dll")`。
2. 对每个候选 TBH 进程：`isProcessInSandbox(pid)` — OpenProcess + EnumProcessModulesEx 找 `sbiedll.dll`。
3. `selectProcessBySandbox(candidates, companionInSandbox)`：优先选 sandbox 状态一致的候选；同状态多个时取最高 PID；全部不一致时退化为最高 PID（永不返回 null）。
4. 单候选 fast path 跳过沙箱探测（省 OpenProcess + EnumProcessModulesEx 开销）。

### 5.10 进程分离 / 重连 / 退出时的清理流程

#### 5.10.1 游戏退出（reader 仍 attached）
- `LiveMemoryReader.read()` 开头检查 `p.isAlive()`（`GetExitCodeProcess` 返回非 `STILL_ACTIVE=259`）。
- 失活 → `this.detach()` → 返回 null。
- worker 下一 tick `loop()` 看到 `!reader.attached` → `reader.attach()` → `WinProcess.findByNames` 找不到游戏 → `attach` 返回 false → worker 切到 `POLL_DETACHED_MS=1500ms` 重试。

#### 5.10.2 worker 崩溃
- `LiveMemoryService.ts:150-165` 的 `child.on("exit")` 触发：
  - stderr 拼接（最多 64KB）写入 log。
  - 构造 `running:false, attached:false, supported:false, note:"live reader stopped unexpectedly"` status 广播给 renderer。
  - 清空 `lastSnapshot`。
  - `this.child = null`。
- **不自动重启** —— `LiveMemoryService` 没有 restart 逻辑。用户需要重新 toggle Live Memory 开关或重启 companion。

#### 5.10.3 用户关闭 Live Memory（`LiveMemoryService.stop()`）
1. `child.removeAllListeners()` — 防止 exit/message 事件触发后续广播。
2. `child.postMessage("stop")` — 通知 worker 进入优雅关闭。
3. `child.kill()`。
4. `this.child = null`、`lastSnapshot = null`。
5. 构造 terminal status（`running:false`）广播给 renderer。

worker 端（`worker.ts:252-269`）：
- 收到 `"stop"` → `clearTimeout(timer)` 停止调度。
- `reader.detach()` 关闭 game handle。
- `process.exit(0)` — 显式退出 utilityProcess 释放 native FFI 资源。

#### 5.10.4 `LiveMemoryReader.detach()`
- `proc.close()` — `CloseHandle` 关闭游戏进程 handle。
- 所有指针/状态字段重置为初始值。
- 所有 pin state 重新构造（`makeGoldPinState()` 等）。
- 缓存字段清零：`cachedInventory/cachedPets/boxTypeCatalogMap/boxOpenCountPrev/boxOpenEventPending`。
- cache-pollution 检测器重置：`dictFailSince=null, forceExtractorNextHeal=false`。
- 名字扫描状态重置：`monsterNameScanAttempted/playerNameScanAttempted/...`。
- `offsets/offsetSource/gameVersion/gameInstallDir` 也清空，重新 attach 时从 bundled/cache 重新解析。

### 5.11 LiveMemoryDiagnostics tab

`app/src/renderer/tabs/LiveMemoryDiagnostics.tsx` 是 dev-only tab。`liveReaderState(status, status?.running)`（`status.ts:17-26`）的 5 态映射：

```
!enabled                          → "off"
!status || !running || !attached  → "connecting"
status.scanning                   → "scanning"
!status.supported                 → "degraded"
else                              → "attached"
```

`LiveMemoryStatus` 关键字段：`running / attached / pid / gameVersion / supported / note / scanning / offsetHealth`。`offsetHealth` 包含 `complete / missing / source / extractionAttempts / fallbackFromVersion`。

---

## 6. Inventory 业务流程

### 6.1 parseInventory（`app/src/core/inventory/parse.ts`）

`parseInventory(decryptedText, saveMtime = 0, isMaterialItemKey?) → InventorySnapshot`：

1. `JSON.parse(decryptedText)` 得到 root，从 `root.PlayerSaveData` 取出 `value`（字符串形式优先）。
2. **物品实例解析**（两条路径）：
   - `parseItemsFromPlayerString(playerStr)`：当 `PlayerSaveData.value` 是 JSON 字符串时，用正则切出 `equippedItemIds`、`inventorySaveDatas`、`stashSaveDatas`、`tradingStashSaveDatas`、`itemSaveDatas` 数组，再通过 `ITEM_TRIPLE_RE`（`"ItemKey":n,"UniqueId":n,"IsChaotic":b`）匹配出每个 item 实例。
   - `parseItemsFromPlayerObject(player)`：当 value 已是对象时，直接遍历 `player.itemSaveDatas` 数组。
3. **catalog id 归一化**：`trackSaveItemKey(rawItemKey, ...)` 调用 `catalogItemKeyFromSave(rawItemKey)`（`app/src/core/gamedata.ts`）：
   - 6 位数以下直接返回。
   - 7 位数以上按 `Math.trunc(itemKey / 1000)` 取前缀，落在 `[110001, 939999]` 区间则用前缀。
   - `isMarketPipelineSaveItemKey`（结尾 `900`）单独标记为 pipeline-only，不计入可分配物品。
4. **location 推断**：`resolveLocation(uniqueId, equipped, inventory, stash, trading)` 返回 `"equipped" | "inventory" | "stash" | "trading" | "unknown"`。
5. **chests 解析**：`parseChests(player)` 从 `player.BoxData.BoxTypes` + `BoxData.BoxQuantity` 配对生成 `ChestHolding[]`。
6. **材料堆叠**：若 `isMaterialItemKey` 注入，则 `parseAggregateEntries(player)` 从 `player.aggregateSaveDatas` 按 `aggregateSubKeyToItemKey` 映射回 catalog id，再通过 `materialStacksFromAggregates` 过滤出材料，得到 `Map<itemKey, stackQty>`。
7. **背包容量**：`parseSlotCapacity(arrText)` 遍历 `inventorySaveDatas` 的扁平对象数组，`IsUnlock=true` 计入 `capacity`，`ItemUniqueId !== 0` 计入 `used`。

返回 `InventorySnapshot`：`{ items, chests, saveMtime, materialStacks?, inventoryCapacity, inventoryUsed, marketPipelineOnlyCatalogKeys? }`。

### 6.2 inventory core 各子模块职责

均位于 `app/src/core/inventory/`：

- **aggregates.ts**：`parseAggregateEntries(player)` 提取 `{ type, subKey, value }` 三元组；`aggregateSubKeyToItemKey(type, subKey)` SubKey → ItemKey 映射；`materialStacksFromAggregates(entries, isMaterialItemKey)` 过滤出材料。
- **composition.ts**：`computeInventoryComposition(rows, feeRates)` 聚合 `InventoryComposition`（计数维度 + 价格维度 + 手续费）；每行的 `value` 字段在此设置。
- **location.ts**：`unassignedCount(row)`、`rowMatchesLocation(row, filter)`、`rowMatchesAnyLocation(rows, filter)` 用于 UI 位置过滤。
- **buyOrder.ts**：`instantSellValue(ownedCount, levels)` 把 `ownedCount` 件物品按 `BuyOrderLevel[]` 从高到低价吃单，返回 `{ value, coveredCount }`。
- **ownedPriceTargets.ts**：`ownedPriceTargetForItem(item)` 单个 GameItem → `OwnedPriceTarget | null`；`ownedPriceTargets(snapshot, lookup, excludeItemKey?)` 遍历派生目标去重；`flattenOwnedHashes(targets)` 摊平为 `string[]` 供价格缓存裁剪使用。
- **predictFillTime.ts**：`predictFillTime(input)` 根据 `inventoryCapacity / inventoryUsed` + 多个 `ChestFillSource` 预测多久后背包满。每个 chest type 是串行队列，开箱速率 = `3600 / autoOpenSecondsPerChest`。
- **columnPrefs.ts**：UI 表格列可见性配置归一化。

### 6.3 InventoryService.resolveAndPushInventory

文件：`app/src/main/services/InventoryService.ts`。

`onInventory(snap)`（被 appState 通过 TrackingService 回调注入）：

1. 缓存 `lastInventoryRaw = snap`。
2. 调用 `resolveAndPushInventory()`。
3. 若 `autoScanEnabled`，调用 `ensureOwnedPrices()`（异步刷新 Steam 价格）。
4. `checkAlmostFull(snap)`：当 `used / capacity >= threshold` 且为上升沿时，触发 `onAlmostFull` 回调（appState 注册为 `notifications.showInventoryAlmostFull`）。

`resolveAndPushInventory()` 流程：

1. 若 `lastInventoryRaw` 或 `market` 为空，直接返回。
2. `buildOwnedPriceLookupMap()`：从 `currentOwnedPriceTargets()` 派生 hash 列表，从 `market.get(hash)` 拿 `PriceEntry`，构造 `Map<hash, InventoryPriceInfo>`（只装 owned hashes，避免把整张 cache 推给 worker）。
3. `collectExcludedItemKeys()`：把所有 stage box itemKey 收集为 `number[]`。
4. 若 `worker.isReady()`：
   - `worker.resolve(snapshot, priceLookupMap, excludeItemKeys)` 异步返回 `ResolvedInventory`。
   - 成功 → `publishResolved(resolved)`；失败（crash / 5s 超时）→ 走 sync fallback `resolveAndPublishSync`。
5. 否则直接 `resolveAndPublishSync`（启动期/worker 崩溃后）。

`publishResolved(resolved)`：

1. 注入 currency 到 `resolved.currency` 和 `resolved.composition.currency`。
2. **locale 后处理**：遍历 `resolved.rows`，用 `getMergedGameItem(row.itemKey)` 重新解析 row.name（worker 不能在运行时切 catalog，所以英文/占位名在主进程替换成本地化名）。
3. 缓存 `lastInventory = resolved`。
4. `broadcast(IPC.INVENTORY, resolved)` 推送给所有 renderer。
5. `onInventoryUpdated?.(resolved)` 回调（appState 注册为 `tracking.setInventorySnapshot`）。

**关键不变量**：Steam Market 调用与 `lookupPriceSnapshot.prices[hash]` 查询都用英文 hash，不能用本地化名（`marketHashName` 在 `app/src/core/marketName.ts` 中通过 `sourceName` 字段保留英文来源）。

### 6.4 inventoryWorker（utility process）

文件：
- `app/src/main/services/inventoryWorker.ts`：host 端 wrapper（`InventoryWorker` 类）。
- `app/src/main/services/inventoryWorkerEntry.ts`：worker 进程入口（被 `utilityProcess.fork` 加载）。
- `app/src/main/services/inventoryWorkerProtocol.ts`：纯协议处理器（`handleInit` / `handleResolve`），无 Electron 依赖，可单测。

**为什么用 worker**：解析 10 万件 items 的 map/filter/price-lookup 会阻塞 main thread，影响 IPC + 窗口管理。

**生命周期**：
- `init(gameDataLookup, feeRates)`：首次调用 `utilityProcess.fork`；已有 child 时只 postMessage 一条 `init`（不重新 fork），用于 gameData reload 或 fee rates 变更。
- `resolve(snapshot, priceLookup, excludeItemKeys?)`：未 ready → 直接返回 `resolveSync(...)` 的 Promise；否则分配 `id = nextId++`，存入 `pending: Map<id, ...>`，5s 超时自动 reject；postMessage `{type:"resolve", id, snapshot, priceLookupEntries, excludeItemKeys}`。
- `stop()`：发送 `stop`、`child.kill()`、reject 所有 pending、清空状态。

**消息协议**：
- Inbound（host → worker）：`init`、`resolve`、`stop`。
- Outbound（worker → host）：`ready`、`resolve`、`log`。

**fallback 保证**：worker 崩溃/超时/启动期都不会让 UI 失去 inventory 更新——`resolveAndPushInventory` 在 catch 里调 `resolveAndPublishSync`，sync 路径调用 `worker.resolveSync`（直接调 `resolveInventory`，与异步路径同一函数）。

### 6.5 priceCache 更新策略

文件：`app/src/main/services/priceCache.ts` + `steamMarketProvider.ts`。

#### 持久化结构
- `PriceEntry`：`{ lowest, median, volume, rawLowest, rawMedian, fetchedUtc, buyOrder, rawBuyOrder, buyOrderQuantity?, buyOrderLevels?, buyOrderFetched?, buyOrderCheckUtc? }`。
- `PriceCache`：`{ currency, fetchedUtc, prices: Record<hash, PriceEntry> }`。
- 文件路径：`app.getPath("userData")/prices.<CUR>.json`。`priceCacheSeedPath` 在 app bundle 旁边找 seed 文件，作为冷启动 fallback。

#### TTL 与新鲜度
- `FRESH_TTL_MS = 24h`。
- `isFresh(name, now)`：要求 entry 有 sell price 或 buy order；sell 端 `now - fetchedUtc < 24h`；buy 端 `now - buyOrderCheckUtc < 24h`。
- `pendingTargets(targets, force, now)`：force=true 全返；否则只返非 fresh 的。

#### 持久化时机
- 每次 `market.refresh()` 完成后 `persistPriceCache(cache)`。
- 流式持久化：`fetchAllTargets` 中每 `PERSIST_EVERY_PRICED = 5` 个新价格落盘一次（防长任务中断丢失进度）。
- `pruneCache(ownedHashes)`：删除 cache 中不在 owned 集合的 hash，落盘。

#### Steam API 限流处理
- `DEFAULT_DELAY_MS = 3000`（20 req/min）。
- `MAX_DELAY_MS = 60000`；退避乘子 2。
- `MAX_RETRIES_PER_TARGET = 2`。
- `MAX_CONSECUTIVE_RATE_LIMITS = 3`：跨 target 连续 3 次 429 触发 circuit breaker。
- `Retry-After` header 优先于指数退避：`waitMs = Math.max(retryAfterMs, backoffMs)`。
- `cancel()`：设 `cancelled = true`，`sleepUntil` 每 100ms 检查取消标志。
- 网络错误 fallback：若 `response.reason === "network"` 且 cache 中已有该 hash 的 market data，则刷新时间戳让其变 fresh。

### 6.6 背包满检测与 fillPrediction

- **容量数据来源**：`parseInventory` 中的 `parseSlotCapacity(arrText)`。
- **几乎满通知**：`InventoryService.checkAlmostFull(snap)`：`thresholdRatio = getAlmostFullThresholdPercent() / 100`（来自 `config.inventoryAlmostFullThresholdPercent`，默认 90）；`isAbove = used / capacity >= thresholdRatio`；**上升沿触发**：仅在 `wasAboveAlmostFullThreshold === false → true` 时调 `onAlmostFull`。
- **fillPrediction**：`predictFillTime`（见 6.2）由调用方（ChestService / BoxTimerService）组装 `ChestFillSource[]` 后调用。

---

## 7. Lookup 业务流程

### 7.1 数据源（`app/src/main/services/LookupService.ts`）

构造时一次性加载四个 bundled JSON（通过 `app/src/core/lookup/catalog.ts` 的 loader）：

- `lookup_items.json` → `LookupItem[]`：每个可获取物品的 stats、来源图、合成路径等。
- `lookup_sources.json` → `LookupSources`：box/stage/drop source graph。
- `synthesis_model.json` → `SynthesisModel`：合成配方、grade 权重、bucket 池。
- `offerings.json` → `OfferingsModel`：硬币献祭掉落表。

`LookupService.getCatalog()` 返回 `LookupItem[]`，并在 `localeCatalog` 非空时通过 `gameItemName(item, localeCatalog)` 本地化 name，同时把原始英文名存到 `item.sourceName`（关键：保证 `marketHashName` 仍派生英文 hash）。

### 7.2 box / item / offering 查询（`app/src/core/lookup/`）

- **offerings.ts**：`offeringForCoin(model, coinKey)`、`offeringSourcesForItem(model, itemKey)` 按 `poolPct` 降序。
- **synthesis.ts**：`pathsToItem(item, model)` 返回所有合成路径含 `pGrade / pLevel / itemPoolPct / chance`；`simulate(...)` 给定参数下所有可能产物的概率分布。
- **boxDisplay.ts**：UI 展示用纯函数（`boxCategoryLabel`、`boxDropViaLabel`、`summarizeSpawnPcts` 等）。
- **classRestriction.ts**：`classForGearType(gearType)` 武器 gearType → 英雄职业（Knight/Ranger/Sorcerer/Priest/Hunter/Slayer）；`LOOKUP_CLASS_ORDER` 6 个职业的固定展示顺序。

### 7.3 LookupPriceService vs LookupPricePollingService

#### LookupPriceService（CI 快照客户端，`app/src/main/services/LookupPriceService.ts`）

- **数据来源**：GitHub release `https://github.com/lucasfevi/tbh-companion/releases/download/lookup-prices/prices.json`（CI 每 6 小时构建一次）。
- **职责**：拉取 CI 快照、缓存、广播；**从不调用 Steam**。
- **缓存路径**：`app.getPath("userData")/lookup_prices.json`。
- **启动**：`start()` 先 `loadFromDisk()`，再 `refresh()`，然后 `setInterval(refresh, 30 * 60 * 1000)`（30 分钟轮询）。
- **ETag**：缓存 `etag`，下次请求带 `If-None-Match`，304 时跳过。
- **校验**：`isLookupPriceSnapshot(value)` 检查 `schemaVersion === 1`、`generatedUtc`、`prices`、`fx` 字段。
- **持久化策略**：磁盘上 `lookup_prices.json` 只存 CI 纯净数据；内存中可保留 `pricesLocal/medianLocal/buyOrderLocal/localCurrency`（polling 写入），下次 CI 刷新时通过 `mergeLocalFields` 保留。
- **`replaceSnapshot(snapshot)`**：供 polling service 调用——只在内存替换 + 广播，**不落盘**（保持 CI 快照纯净）。

#### LookupPricePollingService（本地轮询，`app/src/main/services/LookupPricePollingService.ts`）

- **数据来源**：直接调 Steam `priceoverview` + `itemordershistogram`。
- **职责**：本地周期性刷新"已拥有且估值达阈值"或"用户收藏"的物品，merge 进内存 snapshot。
- **抓取三档价格**：`pricesLocal[hash]`（最低出售价）、`medianLocal[hash]`（最近成交价中位数）、`buyOrderLocal[hash]`（最高收购价）。
- **配置**（`LookupPricePollingPrefs`）：`enabled`、`intervalMinutes`（5-60，默认 10）、`thresholdUsd`（默认 1.0）、`watchedHashes`（用户收藏）。
- **目标选择**（`app/src/core/lookupPrice/polling.ts` 的 `selectPollingTargets`）：watched 无条件入选；owned + priceable 全部入选，threshold 仅用于排序优先级；上限 `maxTargets = 50`；排序：watched → 高价值 owned → 常规 owned。
- **cycle 流程**：互斥锁 `cycleRunning`；串行遍历 targets，调 `fetchOne(hash, targetCurrency)`；任一子调用 429 → `consecutiveRateLimits++`；达 `MAX_CONSECUTIVE_RATE_LIMITS = 3` 中止本轮（`aborted: true`）；每个 item 后 `sleep(FETCH_DELAY_MS = 3000)`；priced > 0 时 `mergeUpdatesIntoSnapshot` 调 `lookupPrices.replaceSnapshot` 广播。
- **单 hash 手动刷新**（`pollSingleHash`）：UI 点"立即刷新此物品"按钮时调，不走 selectPollingTargets。

### 7.4 lookupPrice 的 sweep 流程（CI 端）

`app/src/core/lookupPrice/sweep.ts` 的 `sweepListedPrices` 是 CI 构建端的纯函数：

- **优先级**：`refreshOrder(hashes, prior, now, minAgeMs)` = missing hashes first + stale priced hashes oldest-first（`minRefreshAgeMs = 12h` 默认）。
- **限流**：`baseDelayMs = 1500`、`maxDelayMs = 30000`、`maxConsecutiveRateLimits = 6`（CI 比 client 宽松）。
- **熔断**：连续 6 次 429 中止 sweep，保留已抓数据，下次 CI run 从 `prior` 续抓。
- **assembleSnapshot**（`assemble.ts`）：调 `sweepListedPrices` → `fetchFxWithFallback` → `buildSnapshot` 产出最终 `LookupPriceSnapshot`。

### 7.5 snapshot 持久化路径与失效策略

- **CI 端**：`lookup-prices` GitHub Action 跑 `assembleSnapshot`，发布到 release tag `lookup-prices` 的 `prices.json` asset。
- **客户端缓存**：`userData/lookup_prices.json`。
- **失效策略**：ETag 304 → 跳过；`generatedUtc` 相同 → 跳过；校验失败 → 保留旧快照，log warn；30 分钟轮询保证及时性；用户在 Settings 清除 app data 时 → 删 `lookup_prices.json`。
- **本地 polling 数据**：只在内存，不落盘；CI 快照刷新时通过 `mergeLocalFields` 保留 `pricesLocal/medianLocal/buyOrderLocal/localCurrency`。

### 7.6 Watched hashes（用户收藏）存储与轮询

- 存储：`config.lookupPricePolling.watchedHashes: string[]`（`config.json` 持久化）。
- `sanitizePollingConfig(cfg)`：去重、去空、trim。
- `setConfig(cfg)`：仅 `enabled` toggle 或 `intervalMinutes` 变化时重启定时器；`thresholdUsd` / `watchedHashes` 变化不重启。
- 轮询：`selectPollingTargets` 把 `watchedHashes` 放在 targets 最前（无论是否拥有、是否有价格），优先抓取。

---

## 8. Market 业务流程

### 8.1 Steam Market price 请求链路

#### marketHashName 构造（`app/src/core/marketName.ts`）
- `marketHashName(item)`：材料直接用 `sourceName ?? name`；gear 用 `gearMarketHash(name, grade, "A")` = `"<name> (<Grade>) A"`（仅 A 变体，B-E 不探查）；占位符 `ItemName_<id>` → null。
- `isPriceableItem(type, grade, marketTradable)`：material 总是 priceable；gear 仅 Legendary+ priceable。

#### priceoverview 请求（`app/src/main/services/steamPriceApi.ts`）
`fetchSteamPrice(name, currency)`：
- URL：`https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=<code>&market_hash_name=<encoded>`
- `currencyCode(iso)` 把 ISO 代码转 Steam 数字 id（`app/src/core/steamPrice.ts` 的 `STEAM_CURRENCIES` 表，覆盖 41 种货币）。
- headers: `User-Agent: Mozilla/5.0 (TBH Companion)`。
- `AbortSignal.timeout(30_000)` 30s 超时。
- `getProxyDispatcher()` 注入代理。
- 返回 `SteamPriceFetchResult`：`ok: true` → `{ entry: PriceEntry }`；`ok: false` → `{ reason, status, retryAfterMs? }`。
- `parseMoney(text)` 解析 Steam 本地化价格字符串（"$0.04"、"R$ 0,17"、"1.234,56 zl"）。
- 429 → `reason: "http"` + `retryAfterMs: parseRetryAfterMs(res)`。

#### price cache 写入
- `SteamMarketProvider.priceOneHash(name, counters, opts)` 调 `fetchSteamPrice`，成功时 `cache.prices[name] = entry`，再调 `attachBuyOrder`。
- 每 5 个新价格 `persistPriceCache`。
- cycle 结束 `cache.fetchedUtc = new Date().toISOString()` + `persistPriceCache`。

### 8.2 steamMarketFee 计算

文件：`app/src/core/steamMarketFee.ts`（纯函数）+ `app/src/core/steamMarketFeeBundled.ts`（main/core 专用，读 bundled `data/steam_market_fee.json`）。

- `SteamMarketFeeRates = { steamFeePercent, publisherFeePercent, minFeeMajor }`。
- TBH 的 `publisherFeePercent` 通常为 0。
- `sellerFees(sellerAmount, rates)`：卖家到手金额 → 总手续费。
- `buyerPriceFromSellerAmount(sellerAmount, rates)` = `sellerAmount + sellerFees(...)`。
- `sellerProceedsFromBuyerPrice(buyerPrice, rates)`：**逆向**，二分搜索（48 次迭代，精度 0.01）——因为 Steam 按 seller amount floor 费用，不能直接除法。
- `aggregateSellerProceeds(lines, rates)`：多行累加 `{ grossTotal, netTotal, feeTotal }`。

### 8.3 steamBuyOrderApi（买单价，`app/src/main/services/steamBuyOrderApi.ts`）

`fetchSteamBuyOrder(itemNameId, marketHashName, currency)`：
- URL：`https://steamcommunity.com/market/itemordershistogram?norender=1&country=US&language=english&currency=<code>&item_nameid=<id>&two_factor=0`
- headers: `User-Agent` + `Referer: https://steamcommunity.com/market/listings/<appId>/<hash>`（Steam 反爬要求 Referer）。
- 30s 超时 + 代理。
- `parseBuyOrderLevels(data)`：优先用 `buy_order_table`，回退到 `buy_order_graph`（cumulative 数组 diff 出每档 quantity）。
- `buyOrderQuantity` = 最高价的 quantity。

### 8.4 steamItemNameId（item_nameid 查询，`app/src/main/services/steamItemNameId.ts`）

`item_nameid` 是 Steam 内部 ID（不是 market_hash_name），histogram 接口必需。Steam 不提供直接 API，只能从 listing HTML 抓。

`SteamItemNameIdService`：
- **两层缓存**：`bundled: Record<hash, nameId>`（CI 预生成）+ `userCache`（`userData/steam_item_nameids.json`，运行时新解析的写入）。
- `getSync(hash)`：先查 userCache，再查 bundled。
- `resolve(hash)`：缓存命中直接返回；否则 fetch listing HTML，正则 `Market_LoadOrderSpread\(\s*(\d+)` 抓 nameId；429 → `{ ok: false, status: 429, retryAfterMs }`；其他失败不写缓存。
- **单例**：`getSteamItemNameIdService()` 全局共享，避免 `SteamMarketProvider` 和 `LookupPricePollingService` 重复抓 nameid。

### 8.5 proxyResolver（代理配置，`app/src/main/services/proxyResolver.ts`）

undici 的 `fetch` 不读 Windows 系统代理（只读 `HTTPS_PROXY`/`HTTP_PROXY` env），中国用户多用 Clash/V2Ray/SS 设系统代理。本模块桥接 registry → undici `ProxyAgent`。

- `resolveProxyUrl()`：优先级 `HTTPS_PROXY/HTTP_PROXY env` > `Windows registry system proxy`；结果缓存。
- `readWindowsSystemProxy()`：`reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"`，解析 `ProxyEnable` 和 `ProxyServer`。
- `parseWindowsProxyString(raw)`：处理三种格式（单代理、分协议、SOCKS only）。
- `getProxyDispatcher()`：返回 `{ dispatcher: ProxyAgent }` 或 `{}`（无代理时）；缓存 `cachedDispatcher`。
- `refreshProxyCache()`：清缓存 + 关闭旧 ProxyAgent 连接池。Settings 改代理后调用。

### 8.6 retryAfter（429 限流处理，`app/src/main/services/retryAfter.ts`）

`parseRetryAfterMs(res)`：解析 `Retry-After` header
- 整数秒：`seconds * 1000`，cap 5 分钟。
- HTTP-date（RFC 7231）：`dateMs - Date.now()`，cap 5 分钟；负值返回 undefined。
- 缺失/不可解析 → undefined。
- `MAX_RETRY_AFTER_MS = 5 * 60 * 1000`：防 Steam 异常值 stall 整个 refresh。

**消费方**：`steamPriceApi.fetchSteamPrice`、`steamBuyOrderApi.fetchSteamBuyOrder`、`steamItemNameId.resolve`。`SteamMarketProvider.priceOneHash` / `attachBuyOrder` 把 `retryAfterMs` 透传到 `fetchAllTargets`，与指数退避取较大值。

---

## 9. Catalog Refresh 业务流程

文件：`app/src/main/catalogRefreshService.ts`。

### 9.1 启动时机

`CatalogRefreshService` 在 `appState.ts` 顶部构造。**自动触发**：启动时若 `localeData` 为空（首次运行）或 `status.stale`（catalog 版本 ≠ 游戏版本），自动 refresh。**手动触发**：IPC `CATALOG_REFRESH` → `catalogRefresh.refresh()` → 成功后 `reloadLocaleCatalog()` + `inventory.reloadGameData(...)` + `inventory.setLookupCatalog(...)`。**gameVersion 变化触发**：`liveMemory.setOnGameVersionChanged(() => catalogRefresh.onGameVersionChanged())` — 仅广播 `CATALOG_STATUS`（让 UI 显示 stale banner），**不自动 refresh**（避免游戏运行中读 asset 文件冲突）。

### 9.2 resolveAssetPaths 扫描游戏目录

`resolveGameInstallDir(configGameInstallDir)`：优先级
1. `config.gameInstallDir`（用户 Settings 设置）。
2. `TBH_GAME_INSTALL_DATA_DIR` env（dev/test override）。
3. `DEFAULT_GAME_INSTALL = "D:\SteamLibrary\steamapps\common\TaskbarHero\TaskBarHero_Data"`。
4. null。

`resolveAssetPaths(installDir)`：
- `sharedassets0` = `<installDir>/sharedassets0.assets`：物品 CSV（ItemInfoData TextAsset）。
- `sharedBundle` = `<installDir>/StreamingAssets/aa/StandaloneWindows64/localization-assets-shared_assets_all.bundle`：SharedTableData（hash → key 映射）。
- `enBundle` = `<installDir>/StreamingAssets/aa/StandaloneWindows64/localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle`：英文字符串表。
- `localeBundles`：动态扫描 `localization-string-tables-*_assets_all*.bundle`，用 `parseLocaleBundleFilename(filename)` 解析 BCP-47 code，normalize 到 app 语言代码。

### 9.3 catalogExtractor 从 Unity bundle 提取的数据

文件：`app/src/core/unityAssets/catalogExtractor.ts`。

`extractCatalog({ sharedassets0, sharedBundle, enBundle }) → ExtractedCatalog`：

#### 步骤 1：构造 nameMap（`loadNameMap`）
1. `parseBundle(sharedBundle)` → `parseSerializedFile` → 找 classID=114 (MonoBehaviour) 对象 → 取 raw bytes → `scanMarkerEntries(raw)` 得到 `[{ keyId, hash, str }]`（shared 表的 hash → key 映射）。
2. 同样处理 `enBundle` → 英文 hash → string 映射。
3. 以 hash 为 linker，匹配 shared 的 key（仅 `ItemName_` 前缀）与 en 的 value，得到 `Map<ItemName_xxx, EnglishName>`。

#### 步骤 2：读 CSV（`loadCsvText`）
1. `sharedassets0` 可能是 raw SerializedFile 或 UnityFS bundle（按 magic bytes `UnityFS` 检测）。
2. `parseSerializedFile(sfData)` → 找 classID=49 (TextAsset) 对象 → `parseTextAssetRaw(raw)` 拿 name + script。
3. 找 name 为 `"ItemInfoData"` 的 TextAsset，返回其 script（CSV 文本）。

#### 步骤 3：解析 CSV
- 去除 BOM，按行 split，header 含 `ItemKey, NameKey, GRADE, ITEMTYPE, Level, IsCanExchangeMarketable` 等列。
- 每行：`ItemKey` 非数字 skip；`NameKey` 以 `ItemName_` 开头从 nameMap 查找；字面量直接用；空则 `#${itemKey}` 占位。
- **NameKey-only entries**：nameMap 中存在但 CSV 没有的，追加为 `{ id, name, grade: "", type: "", level: null, marketTradable: false }`。

### 9.4 localeExtractor 提取 16 种语言 labels

文件：`app/src/core/unityAssets/localeExtractor.ts`。

`extractLocales({ sharedBundle, locales: Record<code, Buffer> }) → ExtractedLocales | null`：
- `scanLocaleEntries(bundleBuffer)`：扫描所有 MonoBehaviour（locale bundle 含多个 StringTables：items/stats/grades/gearTypes/UI 等），append-only 聚合所有 entries。
- sharedBundle 提供 `hash → key`，每个 locale bundle 提供 `hash → translated string`。
- 用 hash join 得到 `Record<lang, Record<key, translated>>`。
- 单个 locale 失败返回空 map（不抛错）。

### 9.5 提取结果写入 + IPC 推送

`CatalogRefreshService.refresh()` 完整流程：

1. `resolveGameInstallDir(getGameInstallDir())` → null 抛错。
2. `resolveAssetPaths(installDir)` → 检查三个核心文件存在。
3. `readFileSync` 三个核心 buffer。
4. `extractCatalog({ sharedassets0, sharedBundle, enBundle })` → `{ items, stats, gameVersion }`。
5. `gameVersion = liveMemory.getStatus()?.gameVersion ?? extracted.gameVersion`（优先用运行中游戏的版本）。
6. 写 `userData/gamedata.json` = `{ gameVersion, items: extracted.items }`。
7. `gameData.reload(userDataDir)`：GameDataProvider 重新加载。
8. **locale 提取**（best-effort）：
   - 读所有 localeBuffers。
   - `extractLocales({ sharedBundle, locales: localeBuffers })`。
   - 成功 → 写 `userData/locale.json` + 更新 `cachedLocale` + 日志 per-language entry count。
   - 失败 → per-locale 诊断日志。
9. `lastRefreshMs = Date.now()`、`lastError = null`。
10. `broadcastStatus()` → `broadcast(IPC.CATALOG_STATUS, getStatus())`。
11. 返回 `CatalogRefreshResult = { ok: true, gameVersion, itemCount, resolvedNames }`。

**`reloadLocaleCatalog()`**（`appState.ts`）在 refresh 成功后被调用：把 `catalogRefresh.getLocaleData()` 合并到 base LocaleCatalog，然后 fan-out 到所有服务：`tracking.setLocaleCatalog`、`inventory.setLocaleCatalog`、`boxTimers.setLocaleCatalog`、`stageRuns.setLocaleCatalog`、`liveMemory.setLocaleCatalog`、`lookup.setLocaleCatalog`。

---

## 10. Session 持久化（`app/src/main/services/SessionStateService.ts`）

### 10.1 状态字段

- `pendingTracker / pendingChestDropTracker / pendingBoxOpenTracker / pendingLastSaveMtime`：从 `session_state.json` 读出但尚未应用到 tracker 实例的快照。
- `lastSaveMtime`：最近一次 save 的 mtime（秒）。
- `saveTimer`：15s autosave interval。
- `statusOverride`：临时状态文本（"New session" 等），60s 后自动清除。
- `ui: { miniOverlayOpen, boxTrackerOpen }`。

### 10.2 load(config) → SessionUiSnapshot

1. `savePath = expandPath(config.savePath)`。
2. 清空 pending。
3. `path = userData/session_state.json`。
4. 文件不存在 → 返回默认 ui。
5. `raw = JSON.parse(readFileSync)` → `isPersistedSessionState(raw)` 校验（version===1、字段类型正确）。无效 → warn + 返回默认。
6. 读出 `ui` 字段。
7. `sessionMatchesConfig(raw, savePath, config)` 校验：`savePath` 一致、`rollingWindowMinutes` 一致、`liveMemoryEnabled` 一致当前 `isLiveMemoryActive(config)`。不匹配 → info + 返回 ui（不 restore）。
8. pending 字段填充，`lastSaveMtime = raw.lastSaveMtime`。
9. 返回 ui。

### 10.3 startAutosave / 15s 流程

`saveTimer = setInterval(() => persist(ctx.tracker, ctx.chestDropTracker, ctx.boxOpenTracker, ctx.lastSnap, ctx.config), 15000)`

`persist` 流程：
1. `mtime = lastSnap?.saveMtime ?? lastSaveMtime`。
2. 若 `mtime === null && !tracker.isInitialized && pendingTracker === null` → 直接 return（无可持久化内容）。
3. `savePath = expandPath(config.savePath)`。
4. 构造 `PersistedSessionState` payload（含 `version: 1`、`savePath`、`lastSaveMtime`、`rollingWindowMinutes`、`liveMemoryEnabled`、`tracker: tracker.captureSnapshot()`、`chestDropTracker`、`boxOpenTracker`、`ui`）。
5. `mkdirSync(dirname, { recursive: true })` + `writeFileSync(path, JSON.stringify(payload, null, 2))`。
6. 失败仅 warn。

### 10.4 tryRestoreOnSnapshot（首次 save 解析时调用）

`tryRestoreOnSnapshot(tracker, chestDropTracker, boxOpenTracker, snap) → "restored" | "fresh" | "discarded"`：

1. `!pendingTracker || pendingLastSaveMtime === null` → `lastSaveMtime = snap.saveMtime`，返回 `"fresh"`。
2. **mtime 连续性校验**：`snapshotContinuesSession(pendingLastSaveMtime, snap)` = `snap.saveMtime >= pendingLastSaveMtime`。失败 → 清空 pending、`lastSaveMtime = snap.saveMtime`、`setStatusOverride("New session")`、`deleteFile()`、返回 `"discarded"`（save 被回滚或替换）。
3. **数值合理性校验**：`isPlausibleTrackerSnapshot(pendingTracker)`（`app/src/core/sessionState.ts:35`）— 校验 cumulativeGained、sessionRateValue、rollingRateValue、所有 heroMeters.gained 与 rolling 都通过 plausibility 检查。失败 → 同上清理 + 返回 `"discarded"`（防止 live/save baseline 混合污染的快照被恢复）。
4. **应用 snapshot**：try 块中调用 `tracker.applySnapshot(pendingTracker)` + `chestDropTracker.applySnapshot(pendingChestDropTracker)` + `boxOpenTracker.applySnapshot(pendingBoxOpenTracker)`。任一抛错（schema drift / 腐败）→ warn + `deleteFile()` + 返回 `"discarded"`。
5. finally 块清空 pending + 更新 `lastSaveMtime = snap.saveMtime`。
6. 成功返回 `"restored"`。

`applySnapshot` 内部还会调用 `liveXp.restore` / `liveGold.restore` / `healInflatedXpTotals`，并强制 `xpLiveOwning = goldLiveOwning = false`（恢复的 session 从 save 路径开始）。

### 10.5 clearSession

`clearSession(tracker, chestDropTracker, boxOpenTracker, config)`：
- 清空所有 pending。
- `tracker.reset()`、`chestDropTracker.reset()`、`boxOpenTracker.resetAll()`。
- `persist(tracker, chestDropTracker, boxOpenTracker, null, config)` — 立即落盘一份空 session（覆盖旧文件）。

### 10.6 PersistedSessionState 字段

```
{
  version: 1,
  savePath: string,
  lastSaveMtime: number,
  rollingWindowMinutes: number,
  liveMemoryEnabled?: boolean,
  tracker: TrackerSnapshot,    // 含 sessionStart/cumulativeGained/heroMeters/samples/...
  chestDropTracker?: ChestDropTrackerSnapshot,
  boxOpenTracker?: BoxOpenTrackerSnapshot,
  ui: { miniOverlayOpen: boolean, boxTrackerOpen: boolean }
}
```

---

## 11. BoxTimer 业务流程（`app/src/main/services/BoxTimerService.ts`）

### 11.1 数据来源

- `catalogFile = loadStageBoxCatalogFile()`：读 `data/stage_boxes.json`，含 `defaultCooldownSeconds`。
- `routes = loadStageBoxTrackerRoutes()`：从 catalog 过滤 `grade === "RARE" && obtainable && tracker.canonical === true` 的条目，构造 `StageBoxTrackerRoute[]`。
- `routeById = trackerRoutesById(routes)`、`boxById = new Map(...)`、`routeBoxIds`（按 level 升序）。

### 11.2 1Hz tickTimer 与 subscribers 引用计数

`startTick()`：`subscribers++`；若 `tickTimer` 已存在直接返回；否则 `setInterval(() => push(), 1000)`。

`stopTick()`：`subscribers = max(0, subscribers-1)`；若 `subscribers > 0 || !tickTimer` 返回；否则 `clearInterval`。

订阅者来自 `boxTrackerWindow`：窗口创建时 `boxTimers.startTick()`，关闭时 `stopTick()` + `setBoxTrackerOpen(false)` + `tracking.flushSession()`。无订阅者时停止 tick 节省 CPU。

### 11.3 关键方法

- **`setCurrentStageKey(key)`**：值变化时更新 `currentStageKey` 并 `push()`。
- **`markDropped(boxId)`**：`timers.set(boxId, Date.now())`；触发 `onChestDropped?.({ boxId, name, level })` → NotificationService.showChestDrop；`commitState()`（persist + buildState + broadcast）。
- **`tryMarkDroppedFromLiveStage(stageKey) → boolean`**：
  1. `boxId = resolveTrackedDropBoxIdForStage(stageKey, enabledBoxIds, routes, idealStageKeyByBoxId)`：
     - 过滤 `enabledBoxIds.has(boxId) && route.dropStageKeys.includes(stageKey)` 的候选。
     - 0 候选 → 返回 null（log 说明匹配 route 但未 enabled，或没匹配 route）。
     - 1 候选 → 直接返回。
     - 多候选 → 优先匹配 farmStageKey；无匹配则用全部候选；按 level 降序选最高级。
  2. `boxId == null` → 返回 false。
  3. `isBoxOnCooldown(boxId)` → log info + 返回 true（已冷却中，幂等跳过）。
  4. 否则 `markDropped(boxId)` + 返回 true。
- **`setBoxTrackerNotify(boxId, enabled)`**：enabled=true → 从 `notifyWhenReadyByBoxId` 删除（恢复默认 true）；enabled=false → set false；清 catalogCache + commitState。
- **`setCooldownSeconds / setFarmStageKey / setEnabledBoxIds / setSortOrder / clearCooldownOverride / clearFarmStageOverride`**：类似 markDropped 的"修改内部状态 → 清 catalogCache → commitState"模式。`setCooldownSeconds` 限制 [60, 86400]；`setFarmStageKey` 必须在 route.dropStageKeys 内。

### 11.4 buildState() — 1Hz tick 核心

1. `now = Date.now()`。
2. 遍历 `routeBoxIds`：
   - `!enabledBoxIds.has(boxId)` → 从 `wasOnCooldown` 删除 + continue。
   - `prevOnCooldown = wasOnCooldown.get(boxId) ?? false`。
   - `row = buildRow(boxId, now)`：计算 `remainingSeconds`、`active`、`progress`。
   - 若 `!active`（计时器刚过期）：从 `timers.delete(boxId)` + 标记 `persistDirty = true`（延迟到 buildState 末尾统一持久化）。
   - **通知检测**：`prevOnCooldown && !row.active && resolveNotifyWhenReady(boxId)` → push 到 `readyNotifications`。
   - `wasOnCooldown.set(boxId, row.active)`。
3. 触发 `onChestReady?.(payload)` for each readyNotification → NotificationService.showChestReady。
4. `rows.sort(compareBoxTimerRows(a, b, sortOrder))` — `cooldown-first`：冷却中优先（按 remainingSeconds 升序），就绪按 level/boxId；`ready-first`：相反。
5. 计算 `readyCount` / `cooldownCount`。
6. 若 `persistDirty` → flush 一次 persist。
7. 返回 `BoxTimerState`。

### 11.5 seedWasOnCooldown（load 时调用）

构造后立即调用：对每个 `enabledBoxIds`，根据 `timers.get(boxId)` 与 cooldown 计算 remaining，>0 则 `wasOnCooldown.set(boxId, true)`，否则 `false`。**防止首次 buildState tick 触发假 onChestReady**（通知只在 `prev=true → active=false` 转换时触发，`false → false` 不触发）。

### 11.6 box_timers.json 持久化

**load()**：构造时调用。文件不存在 → 用 `defaultEnabledIds()` 填充 `enabledBoxIds`（DEFAULT_ENABLED_BOX_IDS = `[920151, 920201, 920301, 920401]`，过滤掉 catalog 中不存在的；fallback 取 routeBoxIds 前 4 个）。文件存在 → 解析 `PersistedFile`：
- `timers`：过滤有效 boxId + droppedAtMs。
- `cooldownSecondsByBoxId`：过滤 Number.isFinite + >0 + routeById 中存在的。
- `idealStageKeyByBoxId`：过滤 route.dropStageKeys 包含 stageKey，且不等于 route.idealStageKey。
- `notifyWhenReadyByBoxId`：boolean 化。
- `sortOrder`：normalizeBoxTrackerSortOrder。
- `enabledBoxIds`：过滤 routeById 中存在的；空则用 defaultEnabledIds。

**persist()**：序列化为 `{ timers, enabledBoxIds, cooldownSecondsByBoxId, idealStageKeyByBoxId, notifyWhenReadyByBoxId, sortOrder }`。`notifyWhenReadyByBoxId` 只持久化 `false` 项（默认 true 不写盘）。失败仅 warn，不破坏 in-memory state。

### 11.7 notificationPrefs vs per-box notify 的区别

- **notificationPrefs**（config.json）：全局通知偏好，按 kind（chestDrop / chestReady / heroLevelUp / inventoryAlmostFull）配置 `enabled + sound`。`NotificationService.playKindSound` 检查 `notificationPrefs[kind].enabled` 决定是否播音。
- **per-box notifyWhenReady**（box_timers.json）：单宝箱级别的"就绪通知开关"。`BoxTimerService.resolveNotifyWhenReady(boxId)` 决定是否调用 `onChestReady`。两者是"双层开关"：per-box 关闭则完全不触发回调；per-box 开启但 notificationPrefs.chestReady.enabled=false 则回调到达 NotificationService 但不播音。

---

## 12. StageRun 业务流程（`app/src/main/services/StageRunService.ts` + `app/src/core/stageRunTracker.ts`）

### 12.1 触发时机

`StageRunService.recordClear(stageKey, clearTimeSec, xpGained, goldGained)` 由 TrackingService 在 `ingestLiveFrame` 内检测到 `snap.stageClears.length > 0` 时通过 `onLiveStageClear` 回调调用。**仅在 live memory 路径触发**，save 路径不触发（save 无 stageClears 字段）。

### 12.2 recordClear 流程

1. `tracker.recordClear(stageKey, clearTimeSec, xpGained, goldGained)`：
   - `stageKey <= 0 || clearTimeSec <= 0` → return（过滤无效）。
   - `history.push({ wallTime, stageKey, clearTimeSec, xpGained: max(0, xpGained), goldGained: max(0, goldGained) })`。
   - 超 `HISTORY_LIMIT = 200` → `splice(0, length - 200)`（保留最近 200 条）。
2. `persist()`：`writeFileSync(stage_run_history.json, JSON.stringify(tracker.captureSnapshot(), null, 2))` — 每次 clear 都立即落盘。
3. `push()`：`broadcast(IPC.STAGE_RUNS, getStats())`。

### 12.3 独立持久化

`stage_run_history.json` 与 `session_state.json` **完全独立**：session 重置不影响 stage run history。原因：stage run history 是"历史记录"而非"session 统计"，不应被 reset session stats 或 live-memory-toggle 重置清空。

### 12.4 load + restore 校验

- **load()**（构造时）：文件不存在 return；存在则 `JSON.parse` → `tracker.applySnapshot(raw)`。失败仅 warn。
- **applySnapshot**：`raw.history` 必须是 array，否则清空。每条用 `isValidHistoryEntry` 校验，过滤后 slice 到 HISTORY_LIMIT。

### 12.5 getStats()

返回 `StageRunStats`：`{ history: 最近 20 条倒序, readerRequired: true }`。每条调用 `withStageName(entry, localeCatalog)` 重新计算 stageName（不信任持久化的 stageName，支持语言切换）。

---

## 13. ChestService 业务流程（`app/src/main/services/ChestService.ts`）

### 13.1 onSave 触发

`chests.onSave(text, mtime, chests: ChestHolding[])` 由 `TrackingService` 的 `parseInventorySnapshot` 回调调用。`chests: ChestHolding[]` 来自 `inventory.parseFromSave(text, mtime).chests`。

### 13.2 resolveAndPush 流程

1. `purchases = parseRuneSaveData(text)` — 解析玩家购买的 rune 列表。
2. `lastChests = buildChestState(chests, purchases, mtime, boxTypes, runeCap, runeAutoOpen)`（`app/src/core/boxes/resolve.ts`）：
   - `rows = resolveChestHoldings(chests, boxTypeCatalog)`：按 boxType 聚合数量，attach label/category，按 category 排序。
   - `commonCapTotal = commonBoxCapacity(purchases, runeCapCatalog)` = `baseCapacity + runeCapacityBonus`。
   - `stageCapTotal`、`actCapTotal` 同理（注意 stageBoss 对应 "rare" 分类）。
   - `common = boxSlotState(quantityForCategory(rows, "common"), commonCapTotal)` — 计算数量、容量、isFull、slotsRemaining。
   - `stageBoss`、`actBoss` 同理。
   - `capacity`：每类的 `{ base, runeBonus, purchasedCapRuneNodes, runeLabel }` 明细。
   - `autoOpen`：`effectiveAutoOpenSeconds(purchases, runeAutoOpenCatalog.common/stageBoss/actBoss)` — rune 减少自动开启时间。
   - 返回 `ChestState`：`{ rows, common, stageBoss, actBoss, capacity, autoOpen, totalHeld, saveMtime, runeBonusSlots }`。
3. `reconcile()`：触发 `onReconcile?.({ common, rare: stageBoss.quantity, act: actBoss.quantity })` — AutoClassifyService 用此校准队列。
4. `broadcast(IPC.CHESTS, lastChests)`。

### 13.3 容量计算（`app/src/core/boxes/capacity.ts`）

- `boxCapacity(purchases, def) = def.baseCapacity + runeCapacityBonus(purchases, def)`。
- `boxSlotState(heldQty, capacity)`：clamp quantity ≥0、capacity ≥1，`isFull = quantity >= capacity`，`slotsRemaining = max(0, capacity - quantity)`。

### 13.4 与 AutoClassifyService 的协作

- **`setOnReconcile(cb)`**：appState 装配时注入 `(slots) => autoClassify.reconcileWithChestSlots(slots)`。
- **`getAutoOpenSeconds()`**：AutoClassifyService.handleChestDrop 时调用，返回 `{ common, stageBoss, actBoss }` 或 null（首次 save 解析前）。null 时 AutoClassify 用 FALLBACK_AUTO_OPEN = `{ common: 300, stageBoss: 600, actBoss: 60 }`。

---

## 14. AutoClassify 业务流程（`app/src/main/services/AutoClassifyService.ts`）

详细规约见 [`docs/findings/auto-classify-business-logic.md`](./findings/auto-classify-business-logic.md)，本节是摘要。

### 14.1 核心模型：串行队列（per-category shared timer）

每个 category（common/rare/act）有独立的 shared timer。新掉落进入队列时：
- 队列为空 → `autoOpenAtMs = droppedAtMs + autoOpenSec*1000`。
- 队列非空 → `autoOpenAtMs = prevTail.autoOpenAtMs + autoOpenSec*1000`（必须等前面所有同类 chest 开完）。

队列按 `autoOpenAtMs` 升序排序，全局 head = 下一个预计自动开启的 chest。

### 14.2 关键回调

- **`handleChestDrop(event)`**：`chestDropTracker.onDrop` 触发。
  1. `maybeRecalibrateQueue()` — 检测 autoOpenSeconds 漂移。
  2. `stageKey = getCurrentStageKey() ?? 0`。
  3. `autoOpen = chestService.getAutoOpenSeconds() ?? FALLBACK_AUTO_OPEN`。
  4. `boxKey = resolveDropBoxKey(event, stageKey)`：common → commonRoutes 推断 level；rare → BoxTimer catalog 推断 level；act → actBossRoutes 推断 level。
  5. **inventory full 处理**：`droppedAtMs = inventoryFullSinceMs != null ? getEffectiveNow() : event.wallTime*1000`（pause 期间掉落的 chest 锚定到 pauseStart，让倒计时显示完整 autoOpenSec）。
  6. `queue = enqueue(queue, {...})` — 串行链式计算 autoOpenAtMs。
  7. `liveSlots[cat]++`（实时槽位跟踪）。
- **`handleUnclassifiedBatch(entries)`**：`boxOpenTracker.onUnclassified` 触发（microtask 批处理）。
  1. `events = groupBoxOpenEvents(entries.map(e => ({itemKey, wallTime})))` — 按 2s gap 把 entries 分组成"开箱事件"。
  2. 对每个 event 调用 `processEvent(itemKeys, evt.startMs)`。

### 14.3 processEvent(itemKeys, burstWallTimeSec)

1. 若已有 pending prompt → 累加 itemKeys（不重复 broadcast），return。
2. `burstMs = burstWallTimeSec * 1000`。
3. `match = findBurstMatch(burstMs)`：
   - Stage 1：head-first match — 全局 head 的 `autoOpenAtMs` 在 ±15s（`BURST_MATCH_GRACE_MS`）内 → match。
   - Stage 2：全队列搜索最近的 ±15s 内 item。
4. **匹配成功**：
   - 从 queue 移除该 item。
   - 对每个 itemKey 调用 `boxOpenTracker.reclassifyItem(UNCLASSIFIED_BOX_KEY, itemKey, item.boxKey)`。
   - 实时槽位：`liveSlots[cat]--`（除非已在 WeakSet 中，避免 double-decrement）。
   - WeakSet.add(item)。
   - **校准同 category 剩余 items**：`resetSlotTimersForCategory(cat, burstMs + autoOpenSec*1000)` — 重排链式 autoOpenAtMs，避免累积误差。
5. **未匹配 + 队列空**：broadcast `LOOT_PROMPT_CLASSIFY`，创建 pending prompt（60s 超时）。
6. **未匹配 + 队列非空**：创建 PendingBurst（5 分钟 TTL），等下次 `reconcileWithChestSlots` 通过 save 槽位 delta 分类。

### 14.4 reconcileWithChestSlots(slots) — 每次 save 解析触发

1. `maybeRecalibrateQueue()`。
2. **Step 1: excess-prune**：对每个 category，queue 数 > slot 数 → 移除最老的 `excess` 个（autoOpenAtMs 最早的，本应已开）。
3. **Step 2: classifyPendingBursts(slots)**：比较 `liveSlots`（pre-save 实时）与 save 的 slots：
   - 0 category decreased → 等待（TTL prune）。
   - 1 category decreased + 1 pending burst → reclassify burst items 到该 category + resetSlotTimersForCategory。
   - 多 category decreased（ambiguous）→ 不 reclassify，所有 category 用 earliestBurstMs + per-cat autoOpenSec 重置 timer。
4. **Step 3: liveSlots = {...slots}** — save 是 ground truth，覆盖实时调整。
5. **Step 4: backfill**：queue 数 < slot 数（live reader 漏掉或刚启动）→ 用 placeholder item 锚定到当前 `getEffectiveNow()`，每个获得完整 autoOpenSec 倒计时。

### 14.5 tick()（1Hz，由 TrackingService.tickTimer 调用）

1. `updateInventoryPauseState()`：
   - `isFull = inv.used >= inv.capacity`。
   - full → not-full 转换：记录 `inventoryFullSinceMs`，不操作 queue。
   - not-full → full 转换：`shiftQueueTimes(pausedMs)` 把所有 non-slot-decremented item 的 `autoOpenAtMs` 和 `expiresAtMs` 向前推 pausedMs。
2. **inventory full 时**：跳过 slot decrement 和 prune（timer 暂停）。仅处理 pending prompt timeout（wall-clock）和 pendingBursts TTL prune。
3. **正常路径**：
   - 遍历 queue prefix，对每个 `autoOpenAtMs <= now` 且未在 WeakSet 中的 item：`liveSlots[cat]--` + WeakSet.add。
   - `queue = pruneExpired(queue, now)` — 移除 `expiresAtMs <= now`。
   - pending prompt 60s 超时 → 置 null。
   - `pruneExpiredPendingBursts(now)` — 5 分钟 TTL。

### 14.6 maybeRecalibrateQueue（漂移检测）

- `current = chestService.getAutoOpenSeconds()`；null → return。
- 与 `lastAutoOpenSeconds` 比较每类：abs delta < 1s 或相对 < 1% → 视为 below threshold。
- 全部 below threshold → return。
- 否则 `recomputeQueueAutoOpenAtMs(current)`：按 droppedAtMs 升序，per-category 链式重算 autoOpenAtMs；重置 WeakSet。

### 14.7 getQueueSnapshot()

返回 `AutoClassifyStatePayload`：`{ enabled, totalQueued, byCategory: [{category, count, nextAutoOpenInMs, lastAutoOpenInMs}], items, liveSlots, paused: inventoryFullSinceMs != null, pendingBurstsCount }`。renderer 在 auto-classify enabled 时 1Hz 调用。

---

## 15. Notification 业务流程（`app/src/main/services/NotificationService.ts`）

### 15.1 触发源

| 触发源 | 方法 | 触发条件 |
|--------|------|----------|
| `boxTimers.onChestDropped` | `showChestDrop(payload)` | live 检测 rare 掉落或 UI 手动 mark |
| `boxTimers.onChestReady` | `showChestReady(payload)` | buildState 检测 `prev=true → active=false` |
| `tracking.onHeroLevelUp` | `showHeroLevelUp(events)` | save 解析时 detectHeroLevelUps 检测到升级 |
| `inventory.onAlmostFull` | `showInventoryAlmostFull(payload)` | 库存 used/capacity 超过阈值 |
| `updates.onUpdateAvailable` | `showUpdateAvailable(version)` | GitHub release 检测到新版本 |

### 15.2 路由到 renderer

- **chestDrop / chestReady / heroLevelUp**：仅播放声音。`playKindSound(kind)` → 检查 `notificationsEnabled && notificationPrefs[kind].enabled` → `playSound(pref.sound, volumePercent)` → `sendNotificationSound({ soundId, volumePercent })`。
- **inventoryAlmostFull**：OS Notification + 声音。先 `Notification.isSupported()` 检查，构造 `new Notification({ title, body })`，`notification.on("click", focusMainWindow)`，`notification.show()`；再 `playSound(pref.sound, volume)`。
- **updateAvailable**：仅 OS Notification（无声音）。`notificationsEnabled && notifyOnUpdateAvailable` 检查；`lastNotifiedVersion === version` 去重（同版本只通知一次）。

### 15.3 sendNotificationSound

`sendNotificationSound(payload)`（`app/src/main/services/broadcast.ts`）：从所有 live windows 中找第一个非辅助 renderer（非 #overlay / #box-tracker），通常是主窗口；若无主窗口则用第一个 live window。`webContents.send(IPC.PLAY_NOTIFICATION_SOUND, payload)`。

### 15.4 notificationCatalog（`app/shared/notificationCatalog.ts`）

- 16 种声音：`soft-chime / double-tap / wood-tick / whisper-ping / bright-pop / clear-bell / soft-ding / quick-rise / game-blip / arcade-tone / crystal-chime / happy-ping / magic-spark / level-triumph / treasure-fanfare / gentle-alert`。
- 4 种 kind：`chestDrop / chestReady / heroLevelUp / inventoryAlmostFull`。
- `DEFAULT_NOTIFICATION_PREFS`：chestDrop=treasure-fanfare、chestReady=soft-chime、heroLevelUp=level-triumph、inventoryAlmostFull=happy-ping（全部 enabled=true）。
- `migrateNotificationPrefs`：兼容旧 `chestSoundVariant` 字段迁移到 `notificationPrefs.chestReady`。

---

## 16. Update 业务流程（`app/src/main/services/UpdateService.ts`）

### 16.1 启动

`start()`：幂等。`!app.isPackaged` → 设 phase="disabled" + log + return。

packaged 模式：
- `autoUpdater.autoDownload = false`、`autoUpdater.autoInstallOnAppQuit = false`。
- 注册 6 个事件：`checking-for-update` → phase="checking"；`update-available` → phase="available" + `onUpdateAvailable?.(info.version)`；`update-not-available` → phase="not-available"；`download-progress` → phase="downloading" + percent；`update-downloaded` → phase="ready"；`error` → phase="error" + friendlyUpdateError。
- `backgroundTimer = setTimeout(() => checkForUpdates(), 30000)` — 30s 后台检查。

### 16.2 checkForUpdates / downloadUpdate / quitAndInstall

- `checkForUpdates()`：检查 in-flight / phase=="downloading" / phase=="ready" → 直接返回当前 status；否则 `checkInFlight=true` + `autoUpdater.checkForUpdates()`。catch → friendlyUpdateError + phase="error"。
- `downloadUpdate()`：必须 phase=="available"；`downloadInFlight=true` + `autoUpdater.downloadUpdate()`。
- `quitAndInstall()`：必须 phase=="ready"；`setAppQuitting(true)` + `autoUpdater.quitAndInstall()`。

### 16.3 friendlyUpdateError

把网络错误（net::/enotfound/econnrefused 等）映射为"Could not reach GitHub..."；403/429 → "GitHub rate limit"；404 → "No release found"；其它原样返回。

### 16.4 GitHub release 检查

`electron-updater` 默认从 GitHub releases 拉取 `latest.yml`。配置在 `package.json` 的 `build.publish`（GitHub repo）。本项目无自定义 provider，依赖 electron-updater 默认行为。

---

## 17. Pet 业务流程（`app/src/main/services/PetService.ts` + `app/src/core/pets/*`）

### 17.1 onSave 触发

`pets.onSave(text, mtime)` 由 TrackingService 的 `parseInventorySnapshot` 回调调用（与 chests.onSave 同时）。

### 17.2 解析流程

1. `saveRows = parsePetSaveData(text)` — 从 save 文本解析 `petSaveDatas` 列表，提取 `petKey + unlocked`。
2. `killCounts = parseMonsterKillCounts(text)` — 从 `monsterKillSaveDatas` 解析 monster key → kill count 映射。
3. `arrangedPetKey = parseArrangedPetKey(text)` — 当前装备的宠物 key。
4. `lastPets = buildPetState(catalog, saveRows, killCounts, arrangedPetKey, mtime)`：
   - 对每个 catalog entry：`monsterKey = entry.unlockMonsterKey ?? 0`；`killCount = monsterKey > 0 ? (killCounts.get(monsterKey) ?? 0) : 0`；`resolvePetRow(entry, saveByKey.get(petKey), killCount, killTarget, arrangedPetKey, dlcLabel)`。
   - 返回 `PetState: { pets: PetRow[], saveMtime, arrangedPetKey, unlockKillCount, dlcLabel }`。
5. `broadcast(IPC.PETS, lastPets)`。

### 17.3 PetRow 字段

- `dlc` 类：`{ petKey, name, unlocked, equipped, unlockKind: "dlc", bonuses, dlcLabel }`。
- `kills` 类：`{ petKey, name, unlocked, equipped, unlockKind: "kills", killCount, killTarget, killsRemaining, progressPct, bonuses, appearsOnStages, bestStages }`。
  - `bestStages`：每个 `bestFarmStage` 计算 `expectedKillsPerClear(monstersPerClear, spawnPercent)`、`runsToUnlock(remaining, expected)`、`formatRunsMessage(runs)`，未解锁时显示 runsMessage。

### 17.4 pet bonuses / farm 计算（`app/src/core/pets/bonuses.ts` / `farm.ts`）

- `aggregatePassiveBonuses`：聚合所有已解锁宠物的被动加成。
- `expectedKillsPerClear(monstersPerClear, spawnPercent)` = `monstersPerClear * spawnPercent / 100`。
- `runsToUnlock(remaining, expected)` = `ceil(remaining / expected)`。
- `formatRunsMessage(runs, false)`：格式化为 "X runs" 文本。

---

## 18. 跨服务数据流总览

```
[游戏写 SaveFile_Live.es3]
        ↓ mtime 变化
SaveWatcher.tick (poll)
        ↓ readAndDecrypt
        ↓ parseSnapshot → SaveSnapshot
        ├─→ TrackingService.onSnapshot:
        │     ├─ detectHeroLevelUps → NotificationService.showHeroLevelUp
        │     ├─ sessionState.tryRestoreOnSnapshot (首次)
        │     ├─ tracker.update(snap) → XpTracker
        │     ├─ onStageKey → BoxTimerService.setCurrentStageKey
        │     └─ pushStats → broadcast(IPC.STATS)
        └─→ parseInventorySnapshot(text, mtime):
              ├─ inventory.parseFromSave → InventorySnapshot
              │     └─ inventory.onInventory → broadcast(IPC.INVENTORY)
              ├─ chests.onSave(text, mtime, inv.chests):
              │     ├─ buildChestState → ChestState
              │     ├─ reconcile → AutoClassifyService.reconcileWithChestSlots
              │     └─ broadcast(IPC.CHESTS)
              └─ pets.onSave(text, mtime):
                    ├─ buildPetState → PetState
                    └─ broadcast(IPC.PETS)

[Live Memory Worker ~25Hz]
        ↓ LiveMemorySnapshot
TrackingService.ingestLiveFrame
        ├─ tracker.updateLive → XpTracker (live path)
        ├─ dpsTracker.update
        ├─ chestAggregator.feed → chestDropTracker.recordLiveChestDrop
        │     └─ onDrop → AutoClassifyService.handleChestDrop
        ├─ onLiveStageBossDrop → BoxTimerService.tryMarkDroppedFromLiveStage
        │     └─ markDropped → onChestDropped → NotificationService.showChestDrop
        ├─ onLiveStageClear → StageRunService.recordClear
        │     └─ persist + broadcast(IPC.STAGE_RUNS)
        ├─ boxOpenTracker.recordOpen (per entry)
        │     └─ onUnclassified (microtask) → AutoClassifyService.handleUnclassifiedBatch
        └─ pushStats (节流 200ms) → broadcast(IPC.STATS)

[TrackingService 1Hz tick]
        ├─ autoClassify.tick (queue prune + prompt timeout + inventory pause)
        ├─ stale-frame guard (5s)
        └─ pushStats (若未节流)

[SessionStateService 15s autosave]
        └─ persist → userData/session_state.json

[BoxTimerService 1Hz tick (subscribers > 0)]
        └─ buildState:
              ├─ 检测 cooldown → ready 转换
              ├─ onChestReady → NotificationService.showChestReady
              └─ broadcast(IPC.BOX_TIMERS)

[UpdateService 30s 后台检查]
        └─ autoUpdater.checkForUpdates
              └─ update-available → NotificationService.showUpdateAvailable

[CatalogRefreshService 启动 + gameVersion 变化]
        └─ extractCatalog + extractLocales
              └─ reloadLocaleCatalog → 6 个服务 setLocaleCatalog
```

---

## 19. 关键错误处理路径汇总

| 场景 | 行为 |
|------|------|
| Save 文件不存在 | `SaveReadError` → SaveWatcher `onError` → `lastError` 显示在 stats.status |
| mid-write sharing violation | `readBytesShared` 4 次重试 50ms；AES 块大小不符 → `Es3Error` → 不前进 mtime → 下次 poll 重试 |
| 错误密码 | `Es3Error(WRONG_PASSWORD)` → 持续失败需要用户更新 `es3Password` 配置 |
| parseInventory 抛错 | `log.error`，不影响 save snapshot 推送 |
| Session restore 文件 corrupt | `isPersistedSessionState` 失败 → 忽略，返回默认 ui |
| Session restore mtime 不连续 | discard + deleteFile |
| Session restore 数值不合理 | discard + deleteFile（防 live/save baseline 混合污染） |
| applySnapshot 抛错（schema drift） | discard + deleteFile |
| Live memory worker 崩溃 | `lastLiveFrame` 超过 5s 未更新 → TrackingService tickTimer 清空 `lastLiveFrame`/`lastLiveStage`，stats 回退到 save 值 |
| Live hero exp 异常（>1e12） | `plausibleHeroRuntimeExp` 拒绝 |
| Live 单 tick gain 异常（>1e7） | `plausibleLiveHeroGain` 拒绝 |
| Live level-drop（dirty read） | 跳过该 hero 不计数 |
| Live same-level dip | 跳过计数但 refreshRolling |
| LiveMemory worker exit (code 非 0) | 构造 `"live reader stopped unexpectedly"` status 广播；不自动重启 |
| inventoryWorker fork 失败 | log.error，`ready=false`，走 sync fallback |
| inventoryWorker resolve 超时（5s） | reject pending promise，host 走 sync fallback |
| inventoryWorker crash | `handleExit` reject 所有 pending，`ready=false`，host 后续走 sync fallback |
| Steam 429 | `parseRetryAfterMs` 取 Retry-After，与指数退避取较大值；连续 3 次熔断 |
| Steam 网络错误 | cache 有该 hash 的 market data → 刷新时间戳使其 fresh；否则 `counters.failed++` |
| nameid 解析失败 | 跳过 buyOrder，不影响 sell price 写入 |
| LookupPriceService fetch 失败 | log warn，保留旧 snapshot |
| LookupPriceService 校验失败 | log warn，保留旧 snapshot |
| LookupPricePolling cycle 中 429 | `consecutiveRateLimits++`，达 3 中止本轮（`aborted: true`） |
| CatalogRefresh asset 文件缺失 | 抛错，`lastError` 记录，broadcast stale 状态，返回 `{ ok: false }` |
| CatalogRefresh locale 提取失败 | `extractLocales` 返回 null 时 per-locale 诊断，不阻塞 gamedata 写入 |
| proxy 创建失败 | log warn，`cachedDispatcher = {}`（直连） |
| priceCache 文件损坏 | `tryLoadCache` catch，返回空 cache |
| AutoClassify queue item 过期 | pruneExpired 移除 |
| AutoClassify pending burst 5 分钟无 save reconcile | TTL prune（items 留在 unclassified） |
| AutoClassify ambiguous classification | 不 reclassify，全部 reset timer |
| BoxTimer persist 失败 | `writeFileSync` 失败 → 仅 warn，不破坏 in-memory state + broadcast；下次 tick 重试 |
| Update 检查网络错误 | friendlyUpdateError 显示友好提示 |
| Update GitHub rate limit | 提示用户等待 |
| Update 404 | "No release found" |
| Update 开发模式 | phase="disabled"，所有操作 noop |

---

## 20. 关键文件路径速查

| 模块 | 文件 |
|------|------|
| 入口 | `app/src/main/index.ts` |
| appState | `app/src/main/app/appState.ts` |
| 单实例 | `app/src/main/app/singleInstance.ts` |
| lifecycle | `app/src/main/app/lifecycle.ts` |
| config | `app/src/main/config.ts` |
| configPatch | `app/src/main/ipc/configPatch.ts` |
| registerIpc | `app/src/main/ipc/registerIpc.ts` |
| broadcast | `app/src/main/services/broadcast.ts` |
| SaveWatcher | `app/src/main/saveWatcher.ts` |
| saveFile I/O | `app/src/main/io/saveFile.ts` |
| ES3 解密 | `app/src/core/es3.ts` |
| save snapshot 解析 | `app/src/core/save/snapshot.ts` |
| TrackingService | `app/src/main/services/TrackingService.ts` |
| stats 构建 | `app/src/main/stats.ts` |
| blend 纯函数 | `app/src/core/liveMemory/blend.ts` |
| tracker 核心 | `app/src/core/tracker.ts` |
| trackerLimits | `app/src/core/trackerLimits.ts` |
| levelCurve | `app/src/core/levelCurve.ts` |
| detectLevelUps | `app/src/core/heroes/detectLevelUps.ts` |
| SaveWatcher | `app/src/main/saveWatcher.ts` |
| LiveMemoryService | `app/src/main/services/LiveMemoryService.ts` |
| liveMemoryWorker | `app/src/main/services/liveMemoryWorker.ts` |
| LiveMemoryReader | `app/src/main/liveMemory/liveReader.ts` |
| offsetExtractor | `app/src/main/liveMemory/offsetExtractor.ts` |
| offsetHealing | `app/src/main/liveMemory/offsetHealing.ts` |
| offsetCache | `app/src/main/liveMemory/offsetCache.ts` |
| WinProcess + FFI | `app/src/main/liveMemory/winProcess.ts` |
| runtime 字段读取 | `app/src/core/liveMemory/runtime.ts` |
| chestSlots 读取 | `app/src/core/liveMemory/chestSlots.ts` |
| il2cppScanner | `app/src/core/liveMemory/il2cppScanner.ts` — Rev 13 `findBoxDataFields` 结构化派生 boxTypes/boxQuantity |
| offsets 类型 + 内置表 | `app/src/core/liveMemory/offsets.ts` — `LiveOffsets` 接口、`offsetsForVersion` / `offsetsForVersionMeta`、`_criticalRvasValidated` / `_fallbackFromVersion` / `_extractorRev` 字段定义 |
| offsetCompleteness | `app/src/core/liveMemory/offsetCompleteness.ts` — `isOffsetTableComplete` / `mergeOffsets` / `ENRICHMENT_FIELDS`（Rev 13 加入 `boxData.boxTypes` / `boxData.boxQuantity`） |
| InventoryService | `app/src/main/services/InventoryService.ts` |
| inventory parse | `app/src/core/inventory/parse.ts` |
| inventory composition | `app/src/core/inventory/composition.ts` |
| inventory buyOrder | `app/src/core/inventory/buyOrder.ts` |
| inventory predictFill | `app/src/core/inventory/predictFillTime.ts` |
| inventoryWorker | `app/src/main/services/inventoryWorker.ts` / `inventoryWorkerEntry.ts` / `inventoryWorkerProtocol.ts` |
| priceCache | `app/src/main/services/priceCache.ts` |
| steamMarketProvider | `app/src/main/services/steamMarketProvider.ts` |
| steamPriceApi | `app/src/main/services/steamPriceApi.ts` |
| steamBuyOrderApi | `app/src/main/services/steamBuyOrderApi.ts` |
| steamItemNameId | `app/src/main/services/steamItemNameId.ts` |
| proxyResolver | `app/src/main/services/proxyResolver.ts` |
| retryAfter | `app/src/main/services/retryAfter.ts` |
| marketName | `app/src/core/marketName.ts` |
| steamMarketFee | `app/src/core/steamMarketFee.ts` / `steamMarketFeeBundled.ts` |
| steamPrice 表 | `app/src/core/steamPrice.ts` |
| LookupService | `app/src/main/services/LookupService.ts` |
| LookupPriceService | `app/src/main/services/LookupPriceService.ts` |
| LookupPricePollingService | `app/src/main/services/LookupPricePollingService.ts` |
| lookup core | `app/src/core/lookup/*.ts` |
| lookupPrice core | `app/src/core/lookupPrice/*.ts` |
| CatalogRefreshService | `app/src/main/catalogRefreshService.ts` |
| catalogExtractor | `app/src/core/unityAssets/catalogExtractor.ts` |
| localeExtractor | `app/src/core/unityAssets/localeExtractor.ts` |
| SessionStateService | `app/src/main/services/SessionStateService.ts` |
| sessionState core | `app/src/core/sessionState.ts` |
| BoxTimerService | `app/src/main/services/BoxTimerService.ts` |
| stageBoxTracker | `app/src/core/stageBoxTracker.ts` |
| boxTrackerSort | `app/src/core/boxTrackerSort.ts` |
| boxTrackerWindow | `app/src/main/windows/boxTrackerWindow.ts` |
| StageRunService | `app/src/main/services/StageRunService.ts` |
| stageRunTracker | `app/src/core/stageRunTracker.ts` |
| ChestService | `app/src/main/services/ChestService.ts` |
| boxes resolve | `app/src/core/boxes/resolve.ts` |
| boxes capacity | `app/src/core/boxes/capacity.ts` |
| AutoClassifyService | `app/src/main/services/AutoClassifyService.ts` |
| AutoClassify 规约 | `docs/findings/auto-classify-business-logic.md` |
| chestDropTracker | `app/src/core/chestDropTracker.ts` |
| boxOpenTracker | `app/src/core/boxOpenTracker.ts` |
| dpsTracker | `app/src/core/liveMemory/dpsTracker.ts` |
| NotificationService | `app/src/main/services/NotificationService.ts` |
| notificationCatalog | `app/shared/notificationCatalog.ts` |
| UpdateService | `app/src/main/services/UpdateService.ts` |
| PetService | `app/src/main/services/PetService.ts` |
| pets core | `app/src/core/pets/*.ts` |
| shared types | `app/shared/types.ts` |
| IPC 通道名 | `app/shared/ipc.ts` |
| preload bridge | `app/src/preload/index.ts` |
| TbhProvider | `app/src/renderer/context/TbhProvider.tsx` |

---

## 21. 文档维护约定

本文档与代码同步演进，遵循以下不变量：

1. **代码改动→文档同步**：任何针对项目业务逻辑的代码改动（新增/修改/删除流程、调整数据流、变更服务边界、修改关键不变量），改动落地后**必须同步更新本文档对应章节**。详见 `AGENTS.md` 的 Conventions 节。
2. **章节编号稳定**：0-20 的章节编号已分配，新增章节追加到 21+，不重排已有编号便于外部引用。
3. **路径基准**：所有文件路径以仓库根为基准（`app/src/...`），与 `AGENTS.md` 的 "Where things are" 节一致。
4. **不重复架构细节**：本文档关注"业务流程"（数据如何流动、服务如何协作）；架构分层、IPC 边界、文件结构由 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 维护；save 解密细节由 [`SAVE_FORMAT.md`](./SAVE_FORMAT.md) 维护；agent 行为规范由 [`docs/agent/`](./agent/README.md) 维护。本文档只在必要处给出摘要链接。
5. **跨文档链接**：引用其他文档时使用相对路径（如 `[auto-classify-business-logic](./findings/auto-classify-business-logic.md)`），便于离线阅读。
6. **审计/调研文档独立**：专项审计报告（如 `docs/findings/*.md`）作为本文档的细化补充，不在本文档内重复其细节，仅给出摘要 + 链接。
7. **`docs/agent/generated/`** 是 code-derived 自动生成清单，不手编辑；本文档是 hand-curated 业务流程单一真理源，不与 generated 重复。

---

## 22. 历史背景（简要）

- 项目最初是 Python 原型 `tbh_xp/`，仅做 ES3 解密 + XP/hour 显示。
- TS core 达到 parity 后 Python 原型已删除（见 [`docs/DECISIONS.md`](./DECISIONS.md) 的 ADR 记录）。
- Live Memory 功能于 v1.00.x 后期加入，引入 utilityProcess worker + FFI 进程附加架构。
- AutoClassify 串行队列模型于 2026-07 重构为 per-category shared timer + 漂移检测 + WeakSet slot 计数（见 `project_memory.md` 的 Auto-classify 条目）。
- CatalogRefresh 于 2026-07 加入，从游戏 Unity bundle 直接提取 catalog + locale，替代手动维护 `data/gamedata.json`。
- LookupPricePollingService 于 2026-07 加入，让用户本地刷新 watched/owned 物品价格，弥补 CI 6 小时快照的滞后。
