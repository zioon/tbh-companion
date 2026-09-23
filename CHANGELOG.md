# Changelog

User-facing changes for TBH Companion releases. Update the **[Unreleased]** section as features merge; move it to a version heading before tagging (Release prepare).

## [Unreleased]

_Nothing yet._

## [1.26.0] - 2026-09-23

### 祈愿

- **新增「祈愿」标签页**：自动记录每次献祭（祈愿）的结果 —— 什么物品、哪一档硬币、什么时候。骑在既有的「获得记录」文本行管道上读取，不增加任何内存读取开销。
- 祈愿有**两种计数口径**，都直接给出：**祈愿次数**（每行结果计 1 次）与**产出物品数**（行内件数之和，一个结果一次开出多件时会大于次数）。
- 祈愿历史**跨会话长期归档**：存档重置或游戏重启后仍可回看，不与单次会话的统计绑死。

### 物品栏

- **修复堆叠材料的数量统计**：游戏更新后同一种材料会**在单个背包槽内堆叠**（每格最多 5 个），而此前的计数来源是「生命周期累计计数器」，从构造上就算不出正确值 —— 现在改为按槽位数量求和。
- 该修复同时**保住了堆叠材料的市场估价**：此前只按可分配的物品实例计算，纯堆叠形式的材料会从市场页掉价，现在一并纳入。
- 旧存档（无堆叠字段）自动回落到原有计数方式，不会显示为 0。

### 宝箱

- **修复普通箱 / 稀有箱持有数与游戏不一致**：Loot 页此前会把游戏升级或重启后不再还原、**游戏内根本看不到**的幽灵行也算进持有，实测对一份真实存档多算 3 个普通箱（显示 8、实际 5）。现在以游戏自身的箱子列表为准，逐项与游戏一致。
- **修复校准后 Loot 槽位数虚高**：校准后槽位数会在整个存档周期里停在「真实值 + 1」（同一个实体宝箱被计入两次）。现在去重判定提前到队列变更之前，计数不再多一。

## [1.25.0] - 2026-09-22

### 交易

- **价格历史改为统一以美元存储**：交易页的历史价格与成交额现在一律以美元入库，展示时再按当前货币换算。此前这些数据以「入库时的显示货币」保存，**切换一次显示货币就会把全部历史清零**，只能重新拉取 Steam 重建（受接口限流，成本极高）。现在任意货币之间来回切换都能继续用既有历史；存量数据会在升级后首次启动时自动换算并迁移。
- **导入历史数据改为「融合」而非整体替换**：导入不再覆盖当前数据，而是按时间合并 —— 价格历史按 UTC 天保留更细粒度的一侧（不会重复计数），采样按时间戳去重。同一份备份重复导入不会翻倍，可以把多台机器或多份备份的历史累积起来。
- **导入时可选择备份币种，并新增自动探测**：导入改为一屏确认 —— 先看到备份摘要（物品种数、价格历史点数、时间范围），再确认或改选备份币种。旧备份若没记录币种，应用会用它**的历史价格与美元价格参考比对自动推算**（优先与你现有的美元历史比对，其次与美元挂单快照比对），并显示推算依据；实在识别不出才要求你手动选择。
- 导出的历史数据文件现在恒以美元记录并标注版本 2；旧版本应用读取该文件时会自行换算，不会显示错币种数值。

### 记录

- 修复**英雄阵亡行被误标为通关**：英雄阵亡与随后的通关几乎同时写入（实测相差 0.63 秒），此前会把阵亡行当成通关并打上金色通关徽标，尽管它自己的文字写着「英雄阵亡」。现在带英雄配色或英雄措辞（阵亡 / 被击杀 / 复活 / 升级 / 觉醒）的行会在归因前直接排除，不再被任何一步认领。

### 宝箱

- **掉落等级补齐**：此前补记的掉落只有两条线索（最近的开启记录给全量箱键、最近的宝箱掉落给类别），通关记录里现成的关卡信息没用上。现在「已知类别但等级未知」时会读取附近通关行的关卡号，再经关卡宝箱表**查表**得到等级（同类别内关卡号不重叠，故一个关卡号只对应一个等级）；难度不猜，从真实通关记录借用，范围内没有就放弃。

### 图鉴与数据

- 内置图鉴更新到**游戏 v1.2.6**：新增 Act Boss 宝箱（Lv40 / Lv45）的四件 CELESTIAL Lv40 装备掉落（Elite Crossbow、Rune Axe、Rune Bolt、Elite Hatchet）。
- **图鉴价格快照改为读取本仓库自建的快照**：桌面版此前固定读上游作者的快照，而它绑定的是上游目录，任一侧更新后就会与本机物品表脱节。现在应用与网页读同一份自建快照，游戏更新后价格不会再与图鉴错位。

### 网页版

- 新增**免安装的网页版存档解析器**：在浏览器里拖入 `.es3` 存档即用 WebCrypto 本地解密，浏览物品栏与宝箱 —— 不需要安装桌面版，存档不会上传。
- 站点重做为与桌面版一致的标签页（**首页 / 物品栏 / 宝箱 / 图鉴 / 交易**）：图鉴、宝箱图鉴与市场交易额**无需存档**即可浏览；实时追踪、内存读取、悬浮窗与 Steam 查价等需要桌面版的能力会给出下载引导。
- 站点「下载桌面版」按钮已指向本仓库的发布页（此前指向上游作者的发布页）。

## [1.24.4] - 2026-09-21

### 记录

- **彻底修正「获得记录」的读取模型**：此前把它当成环形缓冲区（槽位按会话基准取模映射），实际是**向下平移的定长列表** —— 新记录追加到末尾、整个列表下移一格、最旧一条被挤出。这一根本性误判是「挂机后拿不到最新记录」反复出现的真正原因，此前几版的容量探测与全环扫描都只是在绕开症状。
- 读取现在直接从**列表末尾**往回取新记录，遇到已投递过的条目即停（列表只在末尾增长，首次重复就是边界），不再依赖任何计数器或槽位映射；游戏重启、跨会话恢复、长时间挂机后均能继续拿到最新内容。
- 去重改为按**条目身份**判定（跨平移稳定），替代原先按槽位记账 —— 列表平移不再导致重复投递或漏投递。
- 移除为绕开错误模型而引入的一整套临时机制（会话基准标定、槽位取模映射、暂缓阀、时间戳护栏、锚定仲裁），逻辑收敛到单一模型，后续不会再出现「静默改判」。

## [1.24.3] - 2026-09-20

### 记录

- 「获得记录」不再假定游戏记录环形区固定 2000 槽：现在按实际数组长度扫描，写入头落在假定容量之外时会采纳实测容量并重算全部槽位映射。此前若游戏侧环更大，读取会系统性错位且无从发现。
- 应用启动后的**首批**记录现在也会做偏差检查：时间戳明显偏离当前时间时先定位真正的最新记录再投递，不再把几小时前的存量内容当成最新显示。
- 修复定位到最新记录后、个别情况下最新一条仍被暂缓而迟迟不出现的问题。

## [1.24.2] - 2026-09-19

### 宝箱

- 修复**游戏重启后章节 Boss 箱（act）再次多算**：v1.24.1 用「两次存档间隔 > 30 分钟」判定游戏重启会漏判（游戏启动后数秒即写档，可观测间隔只剩停机时长）。现在改用**游戏会话锚点** —— 取游戏只在启动时改写的 `Player-prev.log`（或 `backend.dat`）的修改时间，重启判定与游戏侧一致。
- 升级到本版时会重新标定一次会话边界，v1.24.1 错标的遗留条目随之被排除。

### 记录

- 修复**长时间挂机后「获得记录」停在旧内容**：游戏记录环形区的计数器会领先实际写入最多一整圈，读取器据此定位会锚错位置。现在会做一次全环扫描找到真正的最新记录并自动校正；环形区自身滞后时照常投递并提示，不再把忠实读取误判成损坏而丢弃。
- 记录环形区的容量与基准判定新增实时校验，消除此前「静默改判」造成的漏记与重复。

## [1.24.1] - 2026-09-18

### 宝箱

- 修复**章节 Boss 箱（act）持有数多算**：游戏 v1.2.4 不会恢复上一会话遗留的 act 条目，这些条目在存档里永久残留却被当成在持计入。现在只统计**本游戏会话内首次出现**的 act 条目，与游戏内显示一致。
- 修复由此产生的**自动开启队列幽灵条目**：已不可见的遗留箱子不再启动永不倒计时的队列。
- **宝箱**页 act 卡片下方会提示本轮排除了多少条遗留条目，便于对照。

## [1.24.0] - 2026-09-17

### 实时数据

- 新增**游戏 v1.2.4 支持**：内置 v1.2.4 的内存偏移表，游戏更新后实时金币、关卡与波次不再静默降级成 5 秒存档轮询。
- 修复**实时金币回退**：实时读数低于存档余额且持续 8 秒时判定读数失效，改用存档余额，状态栏同时给出提示。
- 修复**英雄等级被识别成 1 级**：实时英雄等级低于存档已知等级时整帧不予采信，改用存档等级（存档中本就是 L1 的英雄不受影响）。
- 修复部分数据下金币加密值被解码成负数、导致实时金币读取彻底失效的问题。
- 实时金币读取失败后不再无限回放旧数值（超过 5 秒即停止），避免把更新前的余额当成当前值一直显示。

### 存档与会话

- 存档连续读取失败时，顶部状态栏显示**「存档读取失败」**警示：当前数值是失败前的旧值，不再伪装成实时数据。
- 金币突变防护：单帧异常跳变、以及游戏更新后的余额迁移不再被算成会话收益，只重新校准基线。
- 会话恢复现在会校验金币数值的合理性，异常快照在恢复前即被丢弃。

### 宝箱掉率

- 修复**掉落被重复计数**导致的会话速率约 2 倍虚高：对账补偿改为延迟 5 秒宽限，先确认实时路径确实没记过再补记。
- 滚动小时速率新增 5 分钟最短统计窗口，开局一次连爆不再把速率顶到离谱数值。

### 图鉴与数据

- 检测到游戏版本与图鉴版本不一致时**自动刷新一次图鉴**（此前只提示不刷新，新物品会一直缺少映射）。
- 关卡宝箱表与游戏版本不匹配时输出告警，便于诊断「新关卡箱不计时」。

### 记录

- 记录分类新增**祈愿 / 制作 / 改造**三类筛选；装饰、雕刻、铭文、铭刻、移除归入「改造」。

## [1.23.0] - 2026-09-17

### 记录

- **Live** 页底部新增**「记录」面板**：完整复刻游戏内「获得记录」界面 —— 直接读取游戏内存中的记录时间线，随游戏实时同步，每行保留品质染色。
- 获得记录现在**跨会话长期归档**（最多 10000 条，面板展示最新 200 条），重启应用不再丢失；面板可翻页回看更早的归档。
- 每行标注由宝箱 / 开箱 / 通关事件桶拟合出的**分类徽章**（宝箱·普通 / 首领 / 幕首、污染宝箱、开箱、通关、英雄、合成），并可按**分类**与**品质**筛选。
- **设置 → 数据**新增「清除记录日志」，可单独清空 `record_log.json`。

### Loot

- **开箱统计补齐**：用「获得记录」日志补齐被漏掉的开箱条目，Loot 页不再少算。只补统计、不改动记录页内容；没有来源证据时记为未分类，**不会臆造宝箱等级**。
- 修复**一次开启多个宝箱时第一条没被记录**的问题 —— 掉落 / 开箱 / 通关三路读取的抢读条件已统一，首个条目也会在同一次突发窗口内被追击补记。
- 开箱、掉落、通关日志新增回读窗口，写了一半的条目在补齐后仍会被补记，不再永久丢失。

### 宝箱掉率

- 普通图与瘟疫图的宝箱速率改用**各自的地图时间**作分母 —— 混合刷两类地图时，不再把刷另一类地图的时间算进来稀释掉率。
- **Live** 页宝箱速率卡片下方显示已累计的**普通地图 / 瘟疫地图**时长。
- 修复掉落章节 Boss 宝箱后计时队列被误归零的问题；修复物品栏中已开启的宝箱仍被计入持有的问题。

### 物品栏与市场

- 「立即出售」相关金额现在**按订单簿每一档价格逐笔扣除 Steam 与厂商交易成本**，不再用总价乘统一费率估算。
- 物品栏新增可选的**「到手价」列**（按市场价售出后实际到账金额），汇总卡片同步显示扣除交易成本后的净额。
- 交易成本模型修正：手续费按买家支付价计算，并接入各币种的最低手续费（国区为 ¥0.07）。

### 其它

- **Live** 页布局调整：移除原有的宝箱掉落 / 通关历史面板，改为「英雄等级 + 物品栏填充预估」并列展示；实时内存未启用时才显示经验历史表。

## [1.22.3] - 2026-09-11

### 合成点数

- 宝箱图鉴与 **Market** 交易卡片新增按物品品质估算的**合成点数**，饰品类按 3 倍计数，帮助评估宝箱价值。

### 宝箱图鉴

- **Chests** 页新增宝箱图鉴区：按分类与等级筛选，展示持有数量、来源关卡与掉落区间；瘟疫宝箱按 915 / 925 / 935 独立分组展示。

### 市场

- **Market** 交易卡片关联图鉴，显示物品品质与合成点数信息。

## [1.22.2] - 2026-09-11

### 瘟疫关卡

- 新增 **瘟疫（Contaminated）地图关卡**解析：正确识别 Nightmare 21 / Hell 22 / Torment 23 等瘟疫关卡及其在地图进度中的展示。

## [1.22.1] - 2026-09-11

### 瘟疫宝箱

- **Live** 与 **Loot** 页新增瘟疫宝箱掉率统计：会话 / 每小时 / 近期掉率的瘟疫普通、瘟疫关卡首领细分。
- 瘟疫宝箱掉落在**Loot 队列**与掉落分类提示中正确展示对应类别。

### 修复

- 修复 **Rune of Brevity（缩写符文）** 造成的波次计数偏高问题：追踪器现在会根据缩减后的波次数正确计算波次。

## [1.22.0] - 2026-09-10

### 瘟疫宝箱

- 支持 **v1.02.00 瘟疫（Contaminated）宝箱**：新增瘟疫普通 / 瘟疫关卡首领 / 瘟疫章节首领三类宝箱的容量、自动开箱计时、分类与本地化，跟随 v1.02.00 的符文解锁规则。
- **Chests** 页每个宝箱卡片新增**自动开箱所需时间**显示（含符文减时后的实际耗时）。

### 修复

- 修复宝箱自动开箱计时在部分版本下不准确的问题。

## [1.21.0] - 2026-09-10

### Internationalization

- The companion UI is now translated into **English, Simplified Chinese (简体中文), Japanese (日本語), and Korean (한국어)**. Pick a language explicitly in **Settings**, or use **Auto** (follows your operating system locale).
- New **Follow game** option syncs the companion's language with the game's in-app language preference — change the language inside TBH and the companion follows on its next config read, no extra IPC.
- **Extended language support to all 16 game-supported locales**: German (Deutsch), Spanish (Español), French (Français), Polish (Polski), Portuguese (Português), Russian (Русский), Turkish (Türkçe), Ukrainian (Українська), Traditional Chinese (繁體中文), Thai (ไทย), Vietnamese (Tiếng Việt), and Indonesian (Bahasa Indonesia). Settings now lists each language by its native name. UI strings for these 12 additional languages currently fall back to English; in-game content (item names, grades, types, stats, hero classes, gear groups) is synced per-language from the game's localization bundles on every catalog refresh, so loot labels and grade names read naturally in the player's language.
- Item names pulled from the bundled game catalogs (Lookup, Inventory, Chests, etc.) honor the selected language so market valuations and drop labels read naturally in every supported locale.
- All tabs, the mini overlay, tooltips, notifications, and error toasts use the translated strings; missing keys fall back to English.

### 新增

- **游戏数据本地化**：地图名 / 英雄名 / 物品名现在跟随 UI 语言切换。
  - 新增 `LocaleCatalog` 数据结构与 4 语言的 `data/locale_strings_*.json`
    （从游戏 Unity Localization bundle 离线提取，覆盖 511 件物品 + 30 张地图
    - 6 位英雄 + 4 个难度）。
  - 5 个 main 服务（Tracking / BoxTimer / StageRun / Inventory / LiveMemory）
    通过 `setLocaleCatalog()` 在语言切换时热更新，无需重启窗口。
  - IPC payload 新增字段：`Stats.stageName`、`StageRunHistoryEntry.stageName`、
    `HistoryEntry.stageName`、`BoxTimerState.currentStageLabel`、
    `LiveHeroData.name`、`AppConfig.stageMetadata`（120 条 stageKey → 名称
    映射）——不新增 IPC 通道。
  - 渲染层不再 import `core/stages` / `core/heroes`，所有本地化名从 IPC 字段
    读取；`boxLootFilters` 通过 `stageMetadata` 做文本匹配。
  - 硬编码英文名的装备物品（无 `ItemName_` key，约 5,224 件）保持英文；
    `marketHashName` 始终保留英文以兼容 Steam 市场查价与链接。

### 修复

- 修复 XP 历史表显示原始 stageKey 而非本地化名的回归（`HistoryEntry.stageName`
  现由 main 端 `buildStats` 填充）。
- **价格轮询按设置间隔刷新**：移除自动周期的 6 小时固定冷却——此前开启「高价值
  物品价格轮询」后，成功一轮周期之后的 6 小时内所有自动触发都被跳过（日志
  `cycle skip: within 6h refresh cache`），导致设置里的「轮询间隔（5–60 分钟）」
  形同虚设，市场/图鉴价格与交易页成交量长时间不更新。现在自动周期严格按
  `intervalMinutes` 触发，限流保护由互斥锁、逐项 3s 间隔、每 10 个一批 + 2 分钟
  批间等待与 429 熔断承担。

## [1.18.0] - 2026-06-30

### Lookup

- **Lookup** tab now shows approximate Steam Market **listed prices** on grid cards, the item detail panel, and hover peek for tradable items — green accent with a Steam logo.
- Click a price (or **No listed price**) to open the item's Steam Market listing in your browser.
- Prices come from a shared snapshot refreshed about every 6 hours; switching currency in **Settings** or the **Market** tab re-resolves from the same cached file with no extra download.
- **Market** tab explains how Lookup prices differ from **Inventory** valuation and shows when Lookup prices were last updated.
- **Settings** adds **Clear Lookup market prices** to reset the cached snapshot.

### About

- **Buy Me a Coffee** support link in the tab bar (beside **Mini** and **Boss chests**) and on the **About** tab next to **GitHub** and **Discord**.

### UI

- Tooltips across the app now use styled, keyboard-reachable tooltips instead of OS-default hover delays (inventory badges, Live rates, filters, and similar controls). The mini overlay and Boss chests window keep native tooltips because frameless windows cannot host tooltip portals.

### Fixed

- Closing or reloading a window during Steam price fetches no longer logs render-frame disposal errors in the console.

## [1.17.0] - 2026-06-26

### Lookup

- Box detail panel: **Where to find** with per-stage spawn %, searchable loot table, and **First clear** treatment for one-time chests.
- Box hover peek shows the same stage ranges and drop sources summary as the detail header.
- Item **Drop** rows label first-clear chests with **First clear only**.
- Material pages now show a **Used in crafting** section listing every recipe that consumes the material.

### Inventory

- Item names in the **Inventory** table are now links; click any row to open its detail in the **Lookup** side panel.

### Fixed

- **Inventory** counts and totals no longer include Steam Market pipeline copies (items on Ship or listed for sale use duplicate save rows that the companion now ignores).
- Drop chances and pool percentages in **Lookup** now match game-extracted values, correcting over- and undercounts from earlier catalog entries.

### Data

- Bundled catalogs synced with game **v1.00.21**; item display texts match current in-game names.

## [1.16.1] - 2026-06-23

### Fixed

- Game item icons (gear, materials, boxes) now appear correctly in installed builds. Icons worked in dev but were missing from packaged releases because the build step copied JSON catalogs only, not the bundled `data/icons/` folder.

## [1.16.0] - 2026-06-23

### Lookup

- New **Lookup** tab: browse 1,500+ obtainable items, boxes, and stages with search, filters (grade, gear type, hero class, stat modifier, level range, material kind), and sort by name, grade, level, or type.
- Item detail shows base stats, inherent stats, unique effects, and **Where to find** — boss box drops, crafting recipes, synthesis formulas, and Cube **Offering** coins that can yield the item (with drop chance).
- Open any box or stage to see its drop table.
- Gear synthesis odds in the item detail panel; click any linked item, box, or stage to jump in a side panel without leaving the tab.
- **Offering** coins (Cube toss): full weighted loot table on the coin's detail page; search and sort by drop %.

### Inventory

- **Grade**, **Item type**, and **Location** filters are now multi-select — combine several grades, types, or locations at once.

### Data

- Bundled catalogs synced with game **1.00.19**; Lookup includes item icons for gear and materials.

## [1.15.0] - 2026-06-20

### Inventory

- **Instant total** now walks the full Steam buy-order book level by level (best price first), so large stacks no longer undercount proceeds when the top order cannot cover the whole stack. A badge appears when the book still cannot cover your full quantity.
- **Market value** and **Instant total** summary cards update with your active filters instead of always showing whole-inventory totals.
- **Unequipped only** filter replaces **In use only** — hides rows where every copy is equipped; rows with both equipped and stash/inventory copies still appear.
- **In use** column renamed to **Equipped**, with tooltips explaining per-row counts.
- Optional **Instant avg** column (hidden by default): average price per unit realized across the order-book levels used for instant sell.

### Fixed

- **Unequipped only** no longer hides items that have some copies equipped and others in inventory or stash.

## [1.14.0] - 2026-06-19

### Live

- **Inventory fill prediction** on the Live tab: estimate when unlocked inventory slots fill up from held chest auto-open (with companion toggles for common and stage boss chests) and session drop rates from Player.log.

### Notifications

- **Inventory almost full** alert with configurable fill threshold (Settings, default 90%) and **Happy ping** sound; shows a Windows toast with used/capacity when OS notifications are supported.

## [1.13.0] - 2026-06-18

### About

- **Discord** button on **About** next to **GitHub** — opens the TBH Companion community server.
- **GitHub** and **Discord** links use clearer button styling with icons.

### App

- **What's New** modal after updates when a release includes bundled in-app notes; shown once per version, with a link to full release notes on GitHub and optional actions (e.g. **Join Discord**).

## [1.12.0] - 2026-06-16

### Inventory

- **Inventory** tab summary matches **Live**: market value hero, estimated wallet total after Steam fees, and **instant sell** total capped by buy-order book depth (not full stack × top price).
- Table columns for sell price, buy order, and totals; pick visible columns; refresh Steam price per item.
- Location filters (Trading, Unknown, etc.) keep your selection and show an empty table when nothing matches.

### Market

- Gear Steam prices and buy orders use market variant **A** only (links, refresh, and bundled nameids).
- Buy order prices from the Steam order histogram even when there is no sell listing; formatted prices use thousand separators.
- After upgrading: use **Force refresh** on Inventory (or delete `userData/prices.<currency>.json`) once to clear stale cached B–E variant rows.

### App

- **Settings → Notifications**: global **Sound volume** slider (0–100%) for all notification sounds; **Preview sound** respects the current volume.
- Main window is **1100×720** (fixed width) to fit the inventory table and summary cards.

### Fixed

- Item catalog **market tradable** flags corrected so non-tradable gear is not priced on Steam Market.
- Diagnostic log messages use ASCII punctuation on Windows.

## [1.11.0] - 2026-06-16

### Live

- **Chest drops** on the **Live** tab: session totals and per-hour rates in stat tiles, per-type breakdown cards, and a scrollable drop history from Player.log (common and stage boss chests).
- Chest drop counts and history **persist across app restarts** mid-session.
- Heroes and XP history use matched column heights so long histories scroll inside the panel.

### Fixed

- **Player.log** status in the header no longer turns gold when only the save file is stale.

## [1.10.0] - 2026-06-14

### Market

- Settings and Market currency dropdown now include all live Steam wallet currencies (43 ISO codes).

## [1.9.0] - 2026-06-14

### App behavior

- Main window, Mini overlay, and Stage boss chest tracker remember their position (and size where resizable) across restarts, including on multi-monitor setups. If a monitor is unplugged, windows fall back to the primary display.
- **Stage boss chest tracker** appears on the Windows taskbar and in Alt+Tab, so you can bring it back when the main window is hidden to the tray. Use the header **−** button to minimize it without closing timers.

### Chests

- **Stage boss chest tracker** overlay: choose whether **On cooldown** or **Ready to mark** chests appear first (**Chests** tab → **Overlay display**). Preference is saved with your tracker settings.

### Fixed

- Launching TBH Companion again while it is already running (for example, hidden in the system tray) now focuses the existing window instead of starting a second background process.

## [1.8.1] - 2026-06-14

### Market

- Updated the bundled item catalog from game-extracted data (v1.00.11). **Dimensional Arcana** gear and other items with corrected Steam tradability are now included in **Refresh prices** instead of being skipped as non-tradable.

### Inventory

- Item names and tradability flags in **Inventory** match the current game catalog (5885 items).

## [1.8.0] - 2026-06-13

### Notifications

- **Notification sounds** in **Settings** now configure three alert types separately: **Chest drop** (Player.log or **Dropped**), **Chest ready** (cooldown finished), and **Hero level up** (level gain detected in your save).
- Each type has its own **Enabled** toggle, **Sound** picker, and **Preview sound** button.
- Added twelve new sounds (**Bright pop**, **Clear bell**, **Soft ding**, **Quick rise**, **Game blip**, **Arcade tone**, **Crystal chime**, **Happy ping**, **Magic spark**, **Level triumph**, **Treasure fanfare**, **Gentle alert**) in addition to the four from v1.7.0; pick **None (silent)** per type.
- Existing **Chest ready** sound choices migrate automatically from the old single picker.

### Market

- Steam price refresh shows shared progress on **Market** and **Inventory** while a fetch runs, with a **Stop** control.
- Refresh result messages are clearer when a run is queued, everything is already up to date, or inventory is not loaded yet.
- Price fetching is more reliable (timeouts and stale cache cleanup).

### App behavior

- On Windows, the taskbar shows **TBH Companion** with the app icon instead of a generic Electron label.

### Settings

- Diagnostic logs are consolidated into **app.log**; the path shown under **Advanced — logs and cached data** reflects the single file.

## [1.7.0] - 2026-06-11

### Notifications

- **Enable notifications** master toggle in **Settings** controls update toasts and chest-ready sounds.
- **Notify when an app update is available** shows a Windows notification when a newer release is found (requires the master toggle).
- Stage boss chest cooldown ready alerts are **sound only** (no OS toast). Per-level **Notify when ready** toggles on the **Chests** tab choose which routes alert you.
- Pick a chest-ready sound: **Soft chime**, **Double tap**, **Wood tick**, **Whisper ping**, or **None**.
- **Preview sound** in Settings plays your current selection so you can hear a variant before moving on.

### Settings

- Settings save automatically as you change them — no **Save** or **Reset** buttons.
- Changing **Rolling window (minutes)** still asks for confirmation because it resets the current session.

### Live stats

- Removed the **Hero-dric Cube XP** tracking option; live XP totals use hero XP only.

## [1.6.0] - 2026-06-11

### Chests

- **Stage boss chest tracker** on the Chests tab: pick levels to track, set per-level cooldowns and farm stages, and open the overlay from the tab or toolbar.
- Overlay shows ready/cooling timers; tap **Dropped** manually or rely on **Player.log** auto-detect when a stage boss chest drops.
- Player.log watch status appears in the save status bar when the log file is available.

### Settings

- Advanced clear-cache action renamed to **Reset stage boss chest tracker** (resets `box_timers.json`).

## [1.5.0] - 2026-06-11

### Pets

- New **Pets** tab tracks companion unlock progress from your save, total passive bonuses, kill targets, best farm stages (with expected kills per clear), and where each monster appears.

### Settings

- **Keep all windows on top** now applies to the main window, **Mini** overlay, and **Stage chest tracker**, and updates live when you change it in Settings.

### Inventory

- Fixed gear and materials from newer game saves showing as **Unknown #…** in **Inventory** instead of the correct item name.
- The **Price** column now shows **No active listings** when Steam has no listing or recent sales, instead of looking like a price is still loading.

## [1.4.1] - 2026-06-11

### About & updates

- Fixed in-app update downloads failing when a newer release was available from **About**.

## [1.4.0] - 2026-06-11

### Market

- Added **Indonesian Rupiah (IDR)** and **Vietnamese Dong (VND)** as Steam Market currency options in Settings and the Market tab.

## [1.3.0] - 2026-06-10

### About & updates

- New **About** tab (after Settings) shows the installed version and in-app updates from GitHub Releases.
- **GitHub** and **Release notes** links under the version open the project repo and the matching release on GitHub.
- Installed builds check for updates in the background about 30 seconds after startup; download and install only when you confirm in About.
- Updates install over your existing folder. Windows may still show an unsigned-app SmartScreen prompt — choose **More info** → **Run anyway**, same as the first install.

### App behavior

- Live session stats and rolling history resume after you restart the app, as long as your save file and tracking settings are unchanged.
- If the **Mini** overlay or **Stage chest tracker** was open when you quit, it reopens automatically on the next launch.

### Live

- Refreshed **Live** layout with stat cards and clearer hero and session history tables.
- Save status (watching, errors, session restored) appears in a bar under the tab strip instead of mixed into tab content.

### Settings

- Reworked **Settings** with clearer sections for save file, live stats, Steam Market, window & tray, and advanced cache controls.
- **Advanced — logs and cached data** lets you view the diagnostic log path, clear diagnostic logs, reset the session snapshot, or clear cached catalog, prices, and tracker data without touching `config.json`.
- Removed misleading save-password wording from Diagnostics.

### Mini overlay

- More uniform padding on the **Mini** overlay and **Stage chest tracker** windows.
- Expand and close controls sit flush with the window edges for easier clicking.

### Inventory

- **Inventory** table uses the same card styling as other tabs for a consistent look.

### Appearance

- Refreshed visual design across all tabs — shared buttons, cards, badges, and status colors (including **ideal** highlights on the chest tracker).
- Taskbar and window icons use transparent backgrounds so they look correct on the Windows taskbar.

## [1.2.0] - 2026-06-10

### Market

- Added **Philippine Peso (PHP)** and **Ukrainian Hryvnia (UAH)** as Steam Market currency options in Settings and the Market tab.

## [1.1.0] - 2026-06-10

### App behavior

- Closing the main window now sends the app to the **system tray** instead of quitting. Use **Quit** from the tray menu to exit fully.

### Live, Market & Settings

- Short intro copy on the Live, Market, and Settings tabs explains what each tab is for.
- Live tab shows clearer status while waiting for your save file (instead of a confusing “XP updated never” message).

### Mini overlay

- Smaller, more compact layout with rates on a single row (aligned with the Live tab strip).
- Expand and close controls are easier to tell apart.

### Chests

- Intro copy uses clearer **stage boss chests** terminology.

### Layout

- Tighter tab bar and more compact window chrome.
