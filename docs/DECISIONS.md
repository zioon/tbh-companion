# Decisions (ADR log)

Terse record of architectural decisions. Newest first.

## 2026-09-22 - 材料按「格子堆叠」计数：以槽位 `Quantity` 为准，跨格求和

游戏更新后材料类物品可在**单个背包格子内堆叠，每格上限 5**。旧的计数来源（`aggregateSaveDatas` 生命周期计数器 + `Math.max`）在堆叠模型下必然错误，已改造。

**字段结论（实机存档验证）**：每格的堆叠数量是**槽位对象**上的 `Quantity` 字段，**不在 `itemSaveDatas` 上**。实机 dump（`%USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskbarHero\SaveFile_Live.es3`）显示：

```
inventorySaveDatas: [{ "Index":1, "ItemUniqueId":551278195918962700, "IsUnlock":true, "Quantity":2 }, ...]
stashSaveDatas:     [{ "Index":0, "ItemUniqueId":551278195918962700, "IsUnLock":true, "Quantity":5 }, ...]
```

- 三个槽位数组（`inventorySaveDatas` / `stashSaveDatas` / `remakeTradingStashSaveDatas`）的槽位字段并集均含 `Quantity`；`itemSaveDatas` 条目的字段并集**不含**任何数量字段（材料在那里是逐实例行，与装备一致）。
- **同一材料跨多格**：多个槽位的 `ItemUniqueId` 指向同一条 `itemSaveDatas`（该行的 `ItemKey` 即 catalog id）。实测 `ItemKey=143002` 在 stash 占 9 格，`Quantity` = 5,5,4,4,3,3,1,1,1 → 总量 **27**。因此总量 = **各格 `Quantity` 求和**，绝非按格数、也非取最大值。
- **每格上限 5** 已由实机验证：所有槽位 `Quantity` 观测最大值恰为 5；`Quantity=0`（空槽）大量存在，必须忽略。
- **`itemSaveDatas` 中材料的 `UniqueId` 是「堆叠模板」而非逐件实例**：实测同一 `UniqueId` 可重复出现 24 次。故**按实例计数会严重虚高**，材总量必须走槽位求和。

**实现**：新增 `app/src/core/inventory/stacks.ts`：导出 `MAX_STACK_PER_SLOT = 5`、`clampStackQuantity`、`materialStacksFromSlots`。`parseInventory` 优先用槽位求和（含 `inventory`/`stash`/`trading` 分袋拆分）；**仅当所有槽位都缺 `Quantity`（旧存档 / 字段被移除）时**才回退到 `aggregateSaveDatas` 的 `Math.max` 路径（向后兼容，不抛错、不清零）。`resolve.ts` 的 `mergeMaterialStacks` 改为用槽位总量**覆盖**材料行的 `count`/`inventoryCount`/`stashCount`/`tradingCount`（不再有「已存在实例则跳过」的语义）。

**占用格口径（`slotCapacityFromEntries`，显式双口径）**：`capacity` 只计 `IsUnlock=true` 的格。`used` 的口径按格式分支——存在任一槽位带 `Quantity` 字段（新格式）时按 `Quantity > 0` 计；全部槽位都无 `Quantity`（旧格式）时退回 `ItemUniqueId !== "0"` 计。实机固定副本量化：新存档 `used`（UID≠0）= `used`(Quantity>0) = 3/140，且 0 个「UID≠0 但 Quantity=0」的幽灵格；旧存档无任何 `Quantity` 字段，`used`(UID≠0) = 104/176、`used`(Quantity>0) = 0/0。故**新存档上两口径等价**（保留 `uid !== "0"` 并非 bug，游戏会同时把空槽 `ItemUniqueId` 清零），但**旧格式必须走 UID 兜底**，否则会把 `used` 塌成 0。字符串路径与对象路径共用同一 helper，口径不会漂移。堆叠格（`Quantity > 1`）在两种口径下均只算 **1 格**。

**下游修正**：`ownedPriceTargets` 补上仅存在于堆叠中的材料（否则这些材料拿不到价格目标、在市场页无价值显示）。

**仓库（stash）容量的边界（2026-09-23 用户确认，据此关闭一项待裁决）**：

- **自动开箱暂停只看背包**。游戏仅在**背包满**时停下自动开箱计时器，仓库/交易暂存满**不影响**开箱行为。`appState.ts` 的 `getInventoryStatus` 因此只返回 `inventoryUsed` / `inventoryCapacity`，`AutoClassifyService.updateInventoryPauseState` 也只判背包 —— 这是正确设计，不是缺漏。
- **仓库容量只看 `slots` 数量，与堆叠无关**。堆叠只改变某一格里的 `Quantity`，不改变「该格占 1 格」这一事实（与背包同口径）。故 stash 容量无需任何堆叠相关逻辑。
- 结论：`slotCapacityFromEntries` 虽对三个数组都算出 `{ capacity, used }`，但只把**背包**那一组暴露到 `InventorySnapshot`。stash 占用若要展示属**纯展示需求**，与本次材料堆叠修复的正确性无关，不构成缺陷。

**分析纪律（本次三次踩坑的合并教训，见 skill `tbh-save-field-discovery`）**：任何数值结论必须标注 ①哪个**固定副本** ②哪个**时刻** ③哪种**解析路径**（有无精度损失）。本次分别踩了「存档是动态的（期间被游戏改写）」、「旧档与新档数字混算」、「`JSON.parse` 把超出 `MAX_SAFE_INTEGER` 的 UID 舍入导致不同材料并键」三种坑，故上文的实机数字一律以固定副本 + 无损字符串路径复算为准。

## 2026-09-10 - v1.2.2 宝箱槽位：save 解析取代内存枚举；utilityProcess 消息必须解包

两个教训，一个结论：

1. **v1.2.2 的未开箱子一直在存档里**。`findings/v1.2.2-box-data-migration.md` 曾判定「存档不再包含每类箱子数量」，据此做了运行时逐箱 `BoxData` 清堆枚举（方案 B）。实为误判：未开箱子以普通物品形式存在于 `itemSaveDatas`（STAGEBOX 物品，`910901` Normal / `920901` Stage Boss / `930901` Act Boss），其 `UniqueId` 列在 `BoxBucketGetBoxList`（未开）/ `BoxBucketUseBoxList`（已开）。最终落地为 `parseChests` 的 save 侧路径（`UniqueId` 超 `MAX_SAFE_INTEGER`，必须按原始文本字符串比较；分类由 `InventoryService` 注入 `classifyBoxItemKey`，按 gamedata `type=STAGEBOX` + 物品名前缀），`ChestHolding` 新增可选 `category/label`。方案 B 全部移除。**原则：做内存逆向兜底前，先把存档明文grep 到底——「某 key 不存在」不等于「数据不存在」，实体引用号（bucket id）需要在全文中追踪其落点。**
2. **Electron `utilityProcess` 子进程的消息回调收到的是事件对象 `{data: payload}`**，真实载荷在 `.data` 上。`process.parentPort.on("message", (msg) => ...)` 直接用 `msg` 会让所有入站消息静默失配。这一缺陷同时潜伏在 `liveMemory/worker.ts`（方案 B 映射从未送达、`stop` 从未生效）与 `services/inventoryWorkerEntry.ts`（init/ready 握手从未成功，P1-6 库存 worker 路径静默回退主线程同步 resolve，"Inventory worker ready." 零出现）两处。两边均已统一解包修复。**原则：worker 通信链路必须在每一跳留下日志证据（发送方记发送、接收方记接收），缺任何一跳的日志都应视为链路断裂而不是「功能未启用」。**

## 2026-09-10 - `unit.cache` bundled backfill（英雄 live 偏移防错）

live-memory 英雄实时数据在 v1.2.2 上「持续回退/数值全错」。经 `probe-meta` 实机校验定位：运行时实际应用的 `unit.cache=0x3b0`，而正确值为 **0x3d0**（bundled 与磁盘缓存都是 0x3d0）。`mergeOffsets` 对 `unit` 结构字段做 `...base` 整体展开，错误 base 的旧值会原样进入 merged 并被写回缓存，运行时稳定采用错误偏移，导致整条 `Hero[] → heroPtr+unit.cache → HeroRuntime` 链解错。

采用与既有 `runtime.stage.alive` backfill 相同的模式：`applyResolvedOffsets` 解析结果与 bundled 表不一致时，以 bundled 的 `unit.cache` 为准。原则：**live-memory 结构常量偏移（`unit.cache`/`heroRuntime.*`/`heroInfoData.heroKey`）以 bundled 表为权威，不应被错误 disk-cache/base 在 merge 时悄悄覆盖**；应用端置 backfill 兜底。完整排障见 `docs/findings/v1.2.2-hero-live-memory-regression.md`。

## 2026-06-10 - Diagnostic logging (`electron-log`, main-only writes)

Support logs go to `userData/logs/app.log` (1 MB rotation → `app.old.log`), separate
from optional XP CSV export. **main** uses `createLogger(module)` in `app/src/main/log.ts`;
**core** stays log-free; **renderer** forwards errors via `LOG_RENDERER_ERROR` IPC.
Identical warn/error lines are throttled (5 min) so a bad save path does not flood the
file on every poll. Secrets are redacted before write. Users clear logs from Settings →
Diagnostics. Agent how-to: `docs/DIAGNOSTIC_LOGGING.md`.

## 2026-06-09 - Stage boxes in the `9xxxxx` ItemKey range

The main scraped catalog lists GEAR + MATERIAL only. Saves also reference
**STAGEBOX** loot chests at `910xxx` (Normal Monster Box), `920xxx` (Stage Boss
Box), and `930xxx` (Act Boss Box). These were previously mistaken for hero soul
gear because some ids echo hero digits (`910151`, …); wiki stage-box data
confirms all 59 ids. We ship `data/stage_boxes.json`, merge at load, and **omit
stage boxes from the Inventory tab** (unopened counts remain in `BoxData`).

## 2026-06-09 - Phase 9 inventory improvements

- **Gear Steam variants:** pricing uses hash suffix **`A`** only (save letter not
  decoded yet; non-A variants dropped after phantom B listings on Steam).
- **Material stacks:** `aggregateSaveDatas` Type `0` rows merge when SubKey
  maps to a catalog ItemKey (direct id or `140000 + SubKey % 10000`). Many
  live-save SubKeys (e.g. `10021`) remain unmapped.

## 2026-06-09 - Renderer IPC via `TbhProvider` context

Stats, inventory, and price-progress IPC channels register once in
`renderer/context/TbhProvider.tsx` (parallel initial fetch on mount). Tab
components consume thin hooks (`useStats`, `useInventory`, `usePrices`) instead
of each subscribing to `window.tbh.onStats` / `onInventory` independently.

## 2026-06-09 - CSP tightened for production renderer

`index.html` adds explicit `script-src 'self'`, `connect-src` for Steam market
hosts, and keeps `style-src 'unsafe-inline'` (required for inline styles).
Dev uses the same policy via electron-vite; prod builds disable source maps.

## 2026-06 - Inventory reads `itemSaveDatas` directly, not a slot->item id join

`itemSaveDatas` is the master list of every owned item instance (inventory +
stash + trading + equipped) - verified: all 142 non-empty inventory/stash/
trading slot `ItemUniqueId` refs resolve into it. So we list owned items by
iterating that array and grouping by `ItemKey`.

We deliberately do NOT join slots to instances by `UniqueId`, because those ids
(e.g. `514119247889201000`) exceed JS's safe-integer range; `JSON.parse` rounds
them and distinct ids collide (observed ~6 collisions in 185 items). A
per-location split (inventory vs stash vs trading) would need a lossless
big-int id parse and is deferred until there's a reason to build it.

## 2026-06 - Item catalog with bundled stage boxes and self-refresh (superseded)

~~The main item list scrape yields GEAR + MATERIAL whose record `id` equals the
save's `ItemKey`. We bundle it as `data/gamedata.json` (offline fallback), cache
refreshes in `userData`, and re-scrape on a TTL.~~ **Superseded 2026-06:** catalog
is **bundled-only** from tbh-data (`data/gamedata.json`); no userData cache, no
runtime scrape, no `gamedata-refresh` IPC. Missing bundled gamedata fails startup.
Unknown save keys still degrade to `Unknown #<key>`. **Stage boxes** (`910`/`920`/`930`
prefixes) still ship separately in `data/stage_boxes.json`. See `docs/findings/item-mapping.md`.

## 2026-06 - Steam prices via `priceoverview` in a configurable currency

`priceoverview` reliably honors the `currency` param; `search/render` does not
(it returns a region-fixed currency, verified). Pricing uses `priceoverview`
in `config.currency` (ISO, default USD, also selectable from Settings or Market),
cached per-currency. Background refresh runs on save load (incremental, skips
items priced <24h ago, backs off on HTTP 429). Market tab also has a manual
refresh button. See `docs/findings/steam-market.md`.

## 2026-06 - Inventory valuation: materials + Legendary+ gear only

Steam prices on the Inventory tab target **owned** items only (not the full
~650-item catalog). **Materials** are priced at any grade (1:1 on display name).
**Gear** is priced only at **Legendary and above**; Rare or lower gear is
skipped (low value + ambiguous Steam variant mapping). Gear hashes use
`<name> (<Grade>) A`. Background refresh runs on save load, backs off on HTTP 429 until the
queue finishes, and re-pushes inventory rows as prices arrive.

## 2026-06 - ~~Hero-class items via bundled supplement catalog~~ (superseded)

~~tbh.city/items omits hero-bound `ItemKey`s in the `9xxxxx` range. We ship
`data/hero_items.json` merged into the catalog at load time (names only; not on
Steam).~~ **Superseded 2026-06-09:** the `9xxxxx` gap is **stage boxes**
(STAGEBOX), not hero gear. See `data/stage_boxes.json` and the stage-box ADR above.
`hero_items.json` was removed after incorrect manual entries.

## 2026-06 - Inventory market columns: buy orders, fees, column picker

Inventory shows **Market price** / **List value** (sell-side), **Instant sell** /
**Instant total** (buy-order histogram), plus summary cards for market value,
estimated **After Steam fees**, and instant-sell total. Column visibility persists
in `config.inventoryTable`. Sell-side from `priceoverview` (median + lowest); buy
orders from `itemordershistogram` + bundled `data/steam_item_nameids.json` (tbh-data
`npm run build:steam-nameids`) with **on-demand lazy scrape** for missing ids (same
`bMarketOptOut=1` listing HTML). **No Steam login** for market polling. Gear uses
variant **A** at refresh and display resolve (bundled nameids are A-only).
Market
price column shows median and lowest listing when both differ (e.g. `$15.42`
`($714.15)`); list value still uses median-first `pickMarketUnit`. Orderbook API
spiked and rejected (session-locked currency). TBH fee default ~5% in
`data/steam_market_fee.json` — estimates only; Steam listing UI is authoritative.

Gear prices use `<name> (<Grade>) A`. Materials map 1:1 by name. Gear below
Legendary is not priced. Valuation uses `median_price` when available, otherwise
`lowest_price`.

## 2026-06 - Inventory location from slot refs (lossless UniqueId)

Bag/stash/trading counts come from slot `ItemUniqueId`s matched against
`itemSaveDatas` via string parsing (big-int safe). Equipped gear uses
`equippedItemIds` only.

The in-game Records tab (per-stage clear times, chest-drop log) is NOT written
to the save — only progress (`maxCompletedStage`), current chest holdings
(`BoxData`), and lifetime aggregate counters (`aggregateSaveDatas`) persist.
Deriving a durable drop log from save deltas is lossy (save rewrites ~every 2 min;
chests can be opened before `BoxData` updates). **Time-series charts** (XP/hr,
inventory value in SQLite) are also deferred — see `docs/ARCHITECTURE.md`.

## 2026-07 - Stage clear history: per-run log, not fastest-clear aggregate (LMR-20)

Live `StageClearLog` reads give per-clear duration from the game; XP/gold gained are companion deltas
between clears. History lives in `stage_run_history.json` (not session state), capped at 200 rows with
validated restore. A fastest-clear-per-stage leaderboard was dropped mid-PR — "which stage is best to
farm" is a separate analytics feature. `EXTRACTOR_REVISION` 4 adds stage-clear offsets to completeness
checks so pre-LMR-20 cached tables re-extract instead of silently returning `stageClears: null`.

## 2026-06 - All-TypeScript (Electron + React) over Python + web UI

The hard part (ES3 decryption + save reverse-engineering) is solved and the
scheme is fully known. Node's built-in `crypto` reproduces it
(PBKDF2-SHA1 + AES-128-CBC) with no native deps. Going single-language removed
the Python venv + FastAPI/WebSocket bridge. The Python prototype (`tbh_xp/`) has
been removed after TS parity; see git history.

## 2026-06 - Electron over Tauri for the desktop shell

Goal was to stop mixing languages. Tauri's shell is Rust, which reintroduces a
second toolchain. Electron is pure JS/TS with the most mature desktop APIs
(always-on-top overlay, multi-window, tray, single-exe packaging). Accepted the
larger bundle (~150MB) as fine for a desktop tool.

## 2026-06 - IPC over a local HTTP server

For a single desktop app the renderer talks to main directly via Electron IPC
(`contextBridge` preload). No need for a local HTTP/WebSocket server just to
reach our own UI.

## 2026-06 - Private GitHub repo

Repo `tbh-companion` starts private. The ES3 password is already public on the
community wiki, but a fan tool that reverse-engineers a game save is kept
private to start; can flip to public later.

## Earlier (Python prototype) - read the save file, not network traffic

TBH is an idle game that computes XP locally, so there is no useful network
traffic to sniff. Reading the local save file is the correct source. Kept as
the foundational decision behind the whole project.
