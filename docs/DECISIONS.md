# Decisions (ADR log)

Terse record of architectural decisions. Newest first.

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
