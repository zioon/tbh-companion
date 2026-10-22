# 富数据更新全流程（管道2）

> 游戏版本更新后，用本文档的流程重新生成全部富数据（物品目录、掉落图、合成模型、图标、本地化）。**先读本文档，再动手。**
>
> 适用范围：TBH 游戏客户端更新（`sharedassets0.assets` / 本地化 bundle 变化）后，`data/` 下的内置数据需要同步刷新。业务层面的运行时行为见 [`docs/BUSINESS-FLOWS.md`](BUSINESS-FLOWS.md) 第 9 章（Catalog Refresh）。

## 1. 数据从哪来

游戏安装目录的 Unity 资源是唯一数据源：

| 数据 | 来源文件 |
|------|----------|
| 物品基础表（CSV） | `<installDir>/sharedassets0.assets` 内嵌 `ItemInfoData` TextAsset |
| 物品名称（本地化键→英文） | `StreamingAssets/aa/StandaloneWindows64/localization-assets-shared_assets_all.bundle` + `localization-string-tables-english(...)_assets_all.bundle` |
| 全部语言本地化 | 同目录 `localization-string-tables-*` 全部 bundle |
| 物品图标 | `sharedassets0.assets` 内 `Item_<id>` / `<GEARTYPE>_<id>` 精灵（含 SpriteAtlas 图集） |
| 符文基础表（CSV） | `sharedassets0.assets` 内嵌 `RuneInfoData` / `RuneLevelInfoData` TextAsset（**非管道2产物**，见 §3.3） |
| 宝箱槽位类型 | `data/box_types.json` 手动维护（boxType → label/category/color，见 §3.3） |

管道2 = [`scripts/build_tbh_data.py`](../scripts/build_tbh_data.py)：一次解析上述资源，生成 `data/` 下全部富数据 JSON。

## 2. 前置条件

- 游戏安装目录存在，默认 `D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data`（可用 `--game-dir` 覆盖）。
- Python 3 + `UnityPy`（`pip install UnityPy`）。
- `data/_game_locale_dump.json` 存在（管道2 用它解析名称与 stat 模板，缺失时物品名会退化为 `ItemName_xxx`）。

## 3. 标准更新流程

### 步骤 0：更新本地化全量转储（游戏加了新语言/新文本时）

```powershell
python scripts/dump_game_locale.py
```

输出 `data/_game_locale_dump.json`（`{ lang: { key: value } }`）。运行时 `backfillItemNames` 依赖它解析 `ItemName_*` 占位名（`app/src/main/catalogRefreshService.ts`）。

### 步骤 1：运行管道2，重新生成全部富数据

```powershell
python scripts/build_tbh_data.py [--game-dir DIR] [--out DIR] [--no-oracle] [--no-website]
```

- `--no-oracle`：跳过从旧 `data/` 推导派生规则（stat 除数、合成等级等），换游戏数据源时建议带上；常规更新不带。
- `--game-version`：默认从安装目录的 `Version.txt` **自动探测**（与运行时 `detectGameVersion` 同源），仅在探测失败或需要强行覆盖时才手动指定。运行时会打印解析结果 `game version: X.Y.Z (from ...)`，务必核对。
- `--no-website`：跳过站点副本同步（见下）。**常规更新不要带**。
- **注意**：脚本会**覆盖** `data/` 下 6 个 JSON，先 `git status` 确认无未提交改动。

产物（`data/` 下）：

| 文件 | 内容 |
|------|------|
| `gamedata.json` | 物品基础目录（含 `schemaVersion`、`gearType`、`level`、`marketTradable`） |
| `lookup_sources.json` | 宝箱/关卡掉落图、合成、usedIn（物品获取途径） |
| `offerings.json` | 金币供奉掉落表 |
| `synthesis_model.json` | 合成权重、配方、掉落桶 |
| `lookup_items.json` | 图鉴条目（stats、gearGroups、iconPath、来源）；v1.3.0 起另含 `relic` / `reliquary` / `attunement`（圣物系，见步骤 1.6） |
| `stage_boxes.json` | STAGEBOX 目录 + 追踪元数据 |

**站点数据无需拷贝（构建期内联）**：网页版在 `pnpm build:web` 的**构建期**用 `?raw` 把 `data/` 下的文件内联进 bundle —— `app/src/web/dataSource.ts` 注册的是 `gamedata.json`、`stage_boxes.json`、`lookup_items.json`、`box_types.json`、`steam_market_fee.json` 与 4 份 `locale_strings_*.json`。所以**站点直接消费 `data/`，不存在需要同步的目录副本**：提交推送里带上 `data/**` 就会触发 `pages.yml` 重建（其 `paths` 已包含 `data/**`），站点自动跟随。站点唯一的**运行时**数据是 `website/data/prices.json`，由 `pages.yml` 从滚动 release 自动暂存（见 [`docs/DEPLOY-WEB.md`](DEPLOY-WEB.md) §2.2）。

### 步骤 1.5：符文数据（`rune_box_cap.json` / `rune_auto_open.json` / `rune_wave.json` / `rune_drop_chance.json` / `box_types.json`）

> 这五个文件**不是管道2产物**，由 `RuneInfoData` / `RuneLevelInfoData` TextAsset **手动提取**。游戏符文系统更新（新符文链、新宝箱槽位类型、减波节点、掉率符文）时需同步刷新。

**数据源**：`sharedassets0.assets` 内嵌两个 CSV TextAsset：

| 表 | 列 | 用途 |
|----|----|------|
| `RuneInfoData` | `RuneKey`、`NameKey`、`LevelDataKey`、`NextRuneKey` … | 符文节点 → 效果类型（`MaxAmountNormalChest`、`UnlockAutoOpenNormalChest`、`ReduceAutoOpenNormalChestTime` 等，从 `NameKey` 后缀读取） |
| `RuneLevelInfoData` | `LevelKey`、`Level`、`STATTYPE`、`Value` | 每级数值：`MaxAmount*Chest` → 容量 +1/级；`UnlockAutoOpen*Chest` → 自动开箱 baseSeconds；`ReduceAutoOpen*ChestTime` → 每级减秒 |

**五个文件各自的口径**：

| 文件 | 口径 |
|------|------|
| `rune_box_cap.json` | 每个槽位类别（common/stageBoss/actBoss/plague*）的 `boxType` + `baseCapacity` + `bonusPerLevel` + 该类别全部 `MaxAmount*Chest` 的 `runeKeys` |
| `rune_auto_open.json` | 每类别 `baseSeconds`（`UnlockAutoOpen*Chest` 的 Value）+ `perLevelSeconds`（`ReduceAutoOpen*ChestTime` 各节点每级 Value，键为 RuneKey 字符串） |
| `rune_wave.json` | `reductionPerLevel`：Rune of Brevity（`STATTYPE = WaveCountReduction`）各节点每级 Value（键为 RuneKey 字符串），即减波数 |
| `rune_drop_chance.json` | 每类别 `perLevelPercent`：掉率符文（Rune of Exploration / Rune of Conquest）各节点每级的**掉率乘数**提升百分比（v1.3.0 新增，由 `scripts/dump_rune_drop_chance.py` 生成） |
| `box_types.json` | boxType → label/category/color；与 `core/boxes/catalog.ts` 的 `BoxTypeCatalog` 一致 |

**更新步骤**：运行 `python scripts/dump_rune_tables.py` 转储两张表（按 `STATTYPE` 分组，便于发现**新增的 stat 族**），逐项对照 `rune_box_cap.json` / `rune_auto_open.json` / `rune_wave.json` / `box_types.json`，有差异才手工更新。任何新增 `BoxCategory` 值（如 v1.02.00 的 `plagueCommon/plagueRare/plagueAct`）需同步 `shared/types.ts`、`chestSlots.ts` 前缀分类、`boxOpenLog.ts` boxType 映射、AutoClassify 类别遍历、UI/locale。

> **⚠️ 掉率符文的键名错配**（v1.3.0）：`RuneInfoData.NameKey` 是 `RuneName_DropChanceNormalChest`（**无** `Percent` 后缀），但 `RuneLevelInfoData.STATTYPE` 是 `DropChanceNormalChestPercent`（**有**后缀）。**按 NameKey 反查 STATTYPE 会得到「不存在」** —— 必须按 `LevelDataKey` 反查真实 STATTYPE。`scripts/dump_rune_drop_chance.py` 已处理，并会校验「同一节点各 level 值一致」，不一致即报错退出。

**步骤 2：提取物品图标**
```powershell
python scripts/extract_icons.py
```

按 `lookup_items.json` 的 `iconPath` 导出 PNG 到 `data/icons/`（缺失才导出）。独立精灵与 SpriteAtlas 图集精灵统一走 `UnityPy.export.SpriteHelper.get_image_from_sprite`（处理图集 rect 与旋转）。`.resS` 必须与 `sharedassets0.assets` 同目录，否则图集纹理读不到。

**箱子 band 图标**（`item-910011` / `item-915001` / `item-940001` …）不在 `lookup_items.json` 里（STAGEBOX 被排除在图鉴目录外），由脚本内的 `BOX_BAND_ICONS` 常量显式列出并一并提取。**游戏新增箱子段时，必须同时在两处补**：`scripts/extract_icons.py` 的 `BOX_BAND_ICONS` 与 `app/src/renderer/lib/boxIconPath.ts` 的 `boxIconPath()` 映射（两处对不上会渲染成缺图）。

### 步骤 3：数据质量审计

```powershell
python scripts/audit_catalog.py        # 审计 gamedata.json 质量
python scripts/audit_unresolved.py     # 审计未解析的 ItemName_ 键
python scripts/check_icons.py          # 图标覆盖：no_icon_path / missing_png
```

- `check_icons.py` 的 `missing_png` 应为 0；`no_icon_path` 允许少量（无图标材料/特殊物品）。
- 游戏 CSV 表头变化（新增/改名列）时用 `python scripts/peek_iteminfo_columns.py` 查看新表头。

### 步骤 4：应用侧验证

```powershell
cd app
pnpm typecheck && pnpm lint && pnpm format
pnpm test          # 核心逻辑（catalogExtractor 等）
pnpm test:dom      # 渲染进程组件
pnpm build         # 生产构建
```

内置数据变化后必须确认：

- `app/test/core/unityAssets/catalogExtractor.test.ts` 的提取断言仍通过（fixture 是 1.00.28 旧文件，断言的是过滤行为，一般无需改）。
- `app/test/main/gameDataProvider.test.ts` 的 `itemCount` 数量级断言匹配新 `gamedata.json`，且 `expect(provider.getVersion()).toBe("<新版本>")` 已同步更新 —— 该断言直接读内置 `data/gamedata.json`，**忘了改会必然失败**。
- 图鉴（Lookup 页）不出现「Unknown 分类」「重复物品」「游戏内不存在的物品」。

### 步骤 4.5：同步站点数据副本（易漏）

`website/data/` 下的 `gamedata.json` / `stage_boxes.json` 是 **手工拷贝，不是符号链接**。不重新拷贝，落地页会继续展示旧版本数据（详见 [`DEPLOY-WEB.md`](DEPLOY-WEB.md)）。

```powershell
Copy-Item data\gamedata.json    website\data\gamedata.json -Force
Copy-Item data\stage_boxes.json website\data\stage_boxes.json -Force
git diff --stat website/data
```

`website/index.html` 里的 `id="side-version"` / `id="data-version"` 是加载前的占位文案（`js/app.js` 会用 JSON 里的 `gameVersion` 覆盖），顺手把占位里的版本号一并更新即可。

### 步骤 5：运行时刷新与缓存自愈

应用有两种目录数据来源，**优先级：`userData/gamedata.json` > 内置 `data/gamedata.json`**：

- **运行时提取**：`app/src/core/unityAssets/catalogExtractor.ts` 从用户本地游戏资源提取，`app/src/main/catalogRefreshService.ts` 写入 `userData/gamedata.json`（带 `schemaVersion`）。
- **启动自愈**：`getStatus().stale` = 目录版本 ≠ 游戏版本 **或** 已加载目录的 `schemaVersion` ≠ `CATALOG_SCHEMA_VERSION`。旧缓存（无 `schemaVersion` 或值旧）会被判 stale，启动 3 秒后自动重新提取覆盖 —— 部署新数据后用户**重启一次应用即可生效**，无需手动操作。
- **手动刷新**：设置 → Item Catalog → 刷新（IPC `CATALOG_REFRESH`）。

> 升级代码中 `CATALOG_SCHEMA_VERSION`（`app/src/core/unityAssets/catalogExtractor.ts`）的时机：**提取输出形状或过滤语义变化时递增**（例如新增过滤字段）。仅物品数据变化（游戏更新）不需要递增，版本号相同也会因 `gameVersion` 不匹配触发刷新。

## 4. 关键数据规则（勿随意改动）

| 规则 | 位置 | 说明 |
|------|------|------|
| **服务器已删除过滤** | `build_tbh_data.py`（`build_gamedata`/`build_lookup_items`）与 `catalogExtractor.ts` | CSV 行 `IsDeletedInServer=True` 跳过。这些行**仍在游戏 CSV 中**（官方只打标记不删行，如 v1.2.2 全部 Lv85 装备），不过滤会在图鉴里列出游戏内不存在的物品。过滤掉的 id 记入 `deletedIds`，NameKey-only 兜底也不再拉回。 |
| **变体去重** | `build_tbh_data.py build_lookup_items` 与 `LookupService.setGameData` | 同名+同品质+同等级的多个 ItemKey（词条变体、可交易/不可交易副本）合并为一个条目，保最小 id。LookupService 用 `(type, name, grade)` 唯一键跳过重复变体。 |
| **NameKey-only 兜底** | `catalogExtractor.ts` 与 `build_tbh_data.py` | 本地化表存在 `ItemName_<id>` 但 CSV 没有的（如 620017），追加为空 type 条目供 BoxOpenLog 解析；**排除 `deletedIds`**。 |
| **gearType / iconPath** | `build_tbh_data.py` | 从 CSV `GEARTYPE` 列提取并保留 `gearType`（缺失会让运行时合并的装备显示 Unknown）；`iconPath` 由 `IconPath` 列归一化为 `item-<id>` / `<geartype>-<id>`。 |

## 5. 本次实战踩坑（2026-09 数据更新）

1. **85 级物品"删不掉"**：内置 `gamedata.json` 过滤了，但 `userData/gamedata.json` 是旧代码缓存的（6318 项含 Lv85 GEAR），优先级高于内置且 `gameVersion` 一致 → 永不 stale。修复 = `schemaVersion` 自愈机制（见步骤 5）。
2. **lookup 页重复物品**：同一物品多 ItemKey 变体重复显示 → `(type, name, grade)` 去重。
3. **未知分类**：合并的 GEAR `gearType=null` 显示 Unknown → `build_gamedata`/`catalogExtractor` 提取并保留 `gearType` 字段。
4. **图标不完整/错位**：自定义图集提取方法不可靠 → 改用 `SpriteHelper.get_image_from_sprite` 官方解码路径。
5. **物品名英文**：`ItemName_*` 占位名未解析 → `backfillItemNames` + 更新 `_game_locale_dump.json`。

### v1.02.00 Plague（瘟疫）符文更新（2026-09-10）

游戏 9/8 更新到 **Ver 1.02.00（瘟疫之地）**。管道2 产物（6 个 JSON）**无实质变化**（仅 fetchedUtc 时间戳，污染宝箱物品 `915xxx/925xxx/935xxx` 早已存在于 gamedata）；真正变化的是**符文表**与宝箱槽位类型：

- `RuneInfoData`/`RuneLevelInfoData` 新增 Plague 系列：`MaxAmountPlagueNormalChest`（1162, 11621-11624）、`MaxAmountPlagueStageBossChest`（1164, 11641-11644）、`MaxAmountPlagueActBossChest`（1166, 11661-11664）、`UnlockAutoOpenPlague*Chest`（600/1200/120s）、`ReduceAutoOpenPlague*ChestTime`（4/8/1s 每级）。
- **污染宝箱与普通宝箱分开保管**（wiki 确认），容量/自动开箱用独立符文链 → companion 新增 `plagueCommon/plagueRare/plagueAct` 三个 `BoxCategory` 值。
- 同步改动：`rune_box_cap.json` / `rune_auto_open.json` 各 +3 组、`box_types.json` +3（boxType 3/4/5）、`shared/types.ts` BoxCategory/ChestState、`chestSlots.ts` 前缀分类、`boxOpenLog.ts` boxType 映射、`resolve.ts`/`capacity.ts` 容量、`ChestService`/`AutoClassify` 类别遍历、UI（Chests 页 + CapacityBar green）+ 全部 locale。详见 [`docs/BUSINESS-FLOWS.md`](BUSINESS-FLOWS.md) §13.6。
- **未做**：live GetBoxLog 的 `monsterType` 仍只映射 0/1/2，污染宝箱实时掉落分类待真机确认后扩展（save 侧解析已完整支持）。
- **踩坑**：BOX 分类新增值牵连面大（类型联合、sort 顺序、AutoClassify 三处类别遍历、测试断言），改动前先 `grep -n '"common" | "rare" | "act"' app/` 摸底。

### v1.2.6 更新实战（2026-09-22）

游戏更新到 **Ver 1.2.6**（`sharedassets0.assets` 9/22 07:57 重写）。本次是"小版本 + 掉落补齐"型更新：

- **`ItemInfoData` 无变化**：仍 1954 项，物品记录集合与 v1.2.2 **逐字节相同**。因此 `gamedata.json` / `lookup_items.json` / `offerings.json` / `stage_boxes.json` 实质零改动（只有 `gameVersion` / `fetchedUtc` / `source` 三行头部）；图标 0 新增。
- **掉落图新增 4 件 CELESTIAL Lv40 装备**：`930401` Act Boss Box Lv40 与 `930451` Lv45 现在掉落 Elite Crossbow `347091`、Rune Axe `357091`（0.0005）、Rune Bolt `447091`、Elite Hatchet `457091`（0.0003）。这 4 件物品**早已在 gamedata 中**（`level=40`、`gearType` 齐全），此前只是缺掉落途径 —— 所以这是"补缺口"，不是新增物品。
- **`synthesis_model.json` 连带变化**：`CELESTIAL|Gear|40` 桶 12 → 16 项，`poolPct` 重新分配（11.6664 → 9.2105、1.6671 → 1.3162 等）；同一批 37 个物品的 `dropPct` 出现 1e-4 级重算（如 0.6342 → 0.6341）。**这是分母变化的数学结果，不是平衡性改动**，解读报告时不要当成 nerf/buff。
- **符文表**：现有 `rune_box_cap.json` / `rune_auto_open.json` / `rune_wave.json` 与 `RuneInfoData`/`RuneLevelInfoData` **逐项核对一致，无需改动**。但本版**新增一族掉率符文** `DropChance*ChestPercent`：普通箱/关卡 Boss 箱的 `DropChance*ChestPercent` 早就有，本版补上瘟疫链 `DropChancePlagueNormalChestPercent`（节点 `1211`/`1271`/`1311`/`11629`）与 `DropChancePlagueStageBossChestPercent`（`1302`/`1322`/`11649`），对应本地化 `Plague Rune of Exploration` / `Plague Rune of Conquest`。companion **未建模掉率符文**（没有对应 JSON，`bundledData` 也不注册），本次未新增模型 —— 属**已知缺口**，若要支持需先设计掉率加成如何并入掉落展示。
- **本地化 +46 个 en 键**（2067 → 2113）：Credits（开发/致谢/素材授权）、皮肤商店（Dusk Wanderers Bundle、Steam Overlay 支付提示、Outfits、Split）、4 个瘟疫宝箱 `AccountStat_DropChancePlague*`。**无删除、无改写**。全部 16 语言同为 +46。

两个踩坑（均已修）：

1. **`Version.txt` 才是版本真源。** 本次 `--game-version` 的默认常量还是 `1.2.2`，忘传参会把新数据打上旧版本号 → app 侧 `getStatus().stale` 判定失准、用户端反复重新提取。已改为**从安装目录 `Version.txt` 自动探测**（与运行时 `detectGameVersion` 同源，可 `--game-version` 覆盖），运行日志会打印 `game version: X.Y.Z (from ...)`。
2. **Windows 下脚本写出 CRLF。** `open(..., "w")` 文本模式在 Windows 写 `\r\n`，与 `.gitattributes` 的 `* text=auto eol=lf` 冲突：`git diff` 看不出来（git 会自动规范化，只显示真实行改动），但 `git ls-files --eol data/<file>` 会暴露 `w/crlf`，并且 `website/data/` 的拷贝会连带 CRLF。已在 `build_tbh_data.py` / `dump_game_locale.py` 加 `newline="\n"`；**更新后请用 `git ls-files --eol data/` 复核为 `w/lf`**。

### v1.2.8 更新实战（2026-09-23）

游戏更新到 **Ver 1.2.8**（`Version.txt` 9/22 20:11 重写）。本次是**纯版本号型更新**，管道2 产物与 v1.2.6 **几乎逐字节相同**：

- **`ItemInfoData` 无变化**：仍 1954 项；逐条比对 `id / name / grade / type / marketTradable / level / gearType`，**新增 0、字段变化 0**。`lookup_items.json`（1,725 条）/ `offerings.json` / `lookup_sources.json` / `synthesis_model.json` **内容零改动**（`git diff --numstat` 为空），`gamedata.json` / `stage_boxes.json` 只有 `gameVersion` / `fetchedUtc` / `source` 三行头部变化。
- **图标 0 新增**（`extract_icons.py` → `exported 0 new icons`），审计全过：`audit_catalog` = 1954 项 / 空名 0 / 仍为 raw `ItemName_` 0；`check_icons` = `1725/1725 ok, missing_png=0`。
- **本地化转储只有 16 行变化**（`_game_locale_dump.json`），无新语言、无表结构变化。
- **站点数据在本版前后均为「零拷贝」**：`0647230`（serve the real web app at the site root）之后站点根目录直接跑真实 web 应用，物品目录由 `pnpm build:web` 在构建期用 `?raw` 内联 `data/`（`app/src/web/dataSource.ts`）。所以**更新富数据后只需把 `data/` 提交推送**，`pages.yml` 因 `data/**` 触发重建，站点自动跟上 —— 既不用手工 `Copy-Item`，也不需要任何同步脚本。（历史上曾经存在的 `website/data/{gamedata,stage_boxes}.json` 手工/脚本副本随该重构一并作废。）
- **注意**：`app/test/main/gameDataProvider.test.ts` 的版本断言必须同步改成 `1.2.8`（否则 `pnpm test` / Release 的 QA gate 必挂）。

### v1.3.0 更新实战（2026-10-22）

游戏更新到 **Ver 1.3.0**（`Version.txt` 10/22 16:21 重写）。这是**内容大版本**：万圣节活动 + Plaguelands 圣物系（Relic / Reliquary）+ 调律（Attunement）+ 共鸣（Resonance）。本次**管道2 产物有实质变化**（v1.2.6 / v1.2.8 两次都是零改动）。

- **`ItemInfoData` 大改**：1954 → **7031 行**（服务器已删 4364 行，实际入库 2804 项，+850）。**新增列**：`CONTENTTYPE`（`PLAGUE` 129 / `EVENT` 6）、`IsBucketBox`（116）、`ContaminOverride`、`PARTS`、`ItemSynthesisType`、`GearGroup` 已存在但取值扩展。`ItemInfoData.Level` 对全部 `RELIC_*` / `RELIQUARY` 行为**空**（圣物不是按等级缩放的装备）。
- **新增 GEARTYPE**：`RELIQUARY`（382 件）+ `RELIC_WHITE/BLUE/PURPLE/RED/YELLOW`（20/70/80/90/100 件），`GearGroup` 相应新增 `RELIC` / `RELIQUARY` 两个值。**`shared/types.ts` 的 `BoxCategory` 无需扩展**（那是箱子分类，与 gearType 无关）。
- **新增合成族**：`SynthesisRecipeInfoData` 新增 `ItemSynthesisType` = `RELIC` / `RELIQUARY`（各 9 条配方，`MinResultLevel = MaxResultLevel = 1`），`synthesis_model.json` 的 `recipesByType` 3 → 5、`buckets` 149 → 167。
- **万圣节活动**：`EventPeriodInfoData` EventKey 50001（2026-09-18 ~ 2026-11-11）；`EventStageInfoData` 3 张 EVENT 关卡（2901/3901/4901）；新增 6 个箱子（`CONTENTTYPE=EVENT`）：`940xxx` Halloween Normal Box（COMMON）、`941xxx` Halloween Stage Box（RARE）。**没有**活动专用容量符文链 ⇒ 复用 common/rare 槽位，**不新增 BoxCategory**。
- **符文表**：现有 `rune_box_cap.json` / `rune_auto_open.json` / `rune_wave.json` 与 `RuneInfoData`/`RuneLevelInfoData` **逐项核对一致，无需改动**（严格归一化数值后比对；注意用 `int` 比较，CSV 值是字符串，直接比会误报 DIFF）。本版新增的未建模族：`OpenAllTypeChestAllAtOnce` / `OpenOneTypeChestAllAtOnce`（一次开箱）、`UnlockArrangeSlotCount` / `UnlockSkillSlotCount`。
- **本地化 +1119 键/语言**（2113 → 3232，含 `Relic_*` / `ATTUNEMENT` / `Event_*` / `ContentType_*`）。16 语言同步。
- **`locale_strings_*.json` 必须一并重跑**（`scripts/extract_locale_catalog.py`）：此前停留在 v1.00.28（6178 条），1.3.0 后为 7022 条 —— 缺它则新物品在网页版全部显示占位名。

四个踩坑（均已修）：

1. **管道2 的 `category_via_for` 漏了 940/941 段**。它原本只覆盖 910000-939999，导致 6 个万圣节箱既不在 `lookup_sources.boxes`（无掉落图）、也不在 `stage_boxes.json`，且 `stages` 里 EVENT 关卡的 `boxes` 引用退化成裸 id（`"name": "940001"`）。已扩展到 940000-949999。
2. **`isBoxItemKey` 的上界把活动箱排除在外**（`itemKey >= 940_000` 直接 false）。已放宽到 950000 并补 940/941 两个 band。同类问题还有 `categoryFromPrefix`（`core/chestDropTracker.ts`）、`chestCategoryFromKey`（`renderer/lib/chests.ts`）、`categoryFromBoxItemName`（`core/liveMemory/chestSlots.ts`，按**名称前缀**分类）。
3. **箱子 band 图标是手工加的**（`item-910011` / `item-915001` / … 都不在 `lookup_items.json` 里，因为 STAGEBOX 被排除）。`extract_icons.py` 新增 `BOX_BAND_ICONS` 常量纳入自动提取，否则每次新版本都要手工补 `item-940001` / `item-941001`。
4. **`locale_strings_*.json` 与 `sync_common_with_game.py` 是两条独立链路**：前者由 `extract_locale_catalog.py` 产出（4 语言，网页版消费），后者由 `sync_common_with_game.py` 维护 `common.json` 的 labels 节。`Relic_*` / `Relic_Name` 的键名不遵循 `GearType_` / `StashItemFilterType_` 约定，**两条链路都要显式加映射**，否则网页版（不带 `_game_locale_dump.json`）拿不到标签。

另外：`scripts/extract_locale_catalog.py` 与 `build_tbh_data.py` / `dump_game_locale.py` 一样，已加 `newline="\n"` —— Windows 文本模式默认写 CRLF，与 `.gitattributes` 的 `* text=auto eol=lf` 冲突（`git ls-files --eol data/` 可复核为 `w/lf`）。

### v1.3.0 缺口补齐（2026-10-22 续）

上面那次更新之后，还有两个**建模缺口**没补（不是「适配新版本」必做，但会让新内容显示不全），本次一并补上：

#### 缺口 A：圣物系属性（`RelicInfoData` / `ReliquaryInfoData` 未接入）

圣物与圣物匣**不在 `GearInfoData` 里**（`GearKey` 为空），所以 `lookup_items.json` 里它们的 `stats` 是空的 —— 742 件新装备在图鉴里没有任何属性说明。已接入（管道2 提取 → `lookup_items.json` 的 `relic` / `reliquary` / `attunement` 三个新字段 → Lookup 详情卡新面板），详见 [`docs/business-flows/05-inventory-and-lookup.md`](business-flows/05-inventory-and-lookup.md) §7.9。

读表要点：

- **词条是区间不是定值**。圣物词条从 `(InherentStatModKey, InherentStatTier)` 定位 `StatModInfoData` 的一行，其 `MinValue~MaxValue` 是抽取时的 roll 区间 ⇒ 沿用 `LookupMaterialOutcome` 的 min/max 形状（与材料 outcome 同构）。
- **`tier` 1..10 严格对应 COMMON..COSMIC 十个品质**（实测逐档核对）。
- **`Decrease*Resistance` 是减益词条**（tier 越高值越小，tier 10 归零）—— 那 5 件最高档 "Echo" 圣物因此**没有**有效词条区间，只带 `ResonanceDoubleCount` 附加效果。管道2 跳过零区间（不是 bug），UI 只显示附加效果。
- **圣物匣没有固定词条**：它从 `InherentPoolKey` 指向的词条池（10 池 × 9 条）里 roll `InherentStatCount`（1~3）条。
- **共鸣效果两种形态**：`PartyModType=UniqueMod` 的复用 `UniqueModInfoData`（`Param1` 是 `UniqueModKey`）→ 走既有 `uniqueModLabel` 通道；`PartyModType=PartyMod` 的用游戏自己的 `PartyMod_<name>` 文案。
- **圣物的 `Level` 全为空**（非按等级缩放），但配方 `MinResultLevel=MaxResultLevel=1`、模型每品质恰好一个桶 ⇒ 合成结果等级从**模型桶**推导（`synthesisResultLevel`），否则 `pathsToItem` 会因 `level == null` 直接返回空数组。

#### 缺口 B：掉率符文（`DropChance*` 族从未建模）

v1.2.6 实战里就记为「已知缺口，需先设计掉率加成如何并入掉落展示」。本次采用**保守方案**：只**展示**玩家已购符文带来的掉率加成，**不改写**任何期望值/掉落率计算 —— companion 的期望价值是「按次」口径（`05-inventory-and-lookup.md` §7.8），与掉率加成正交。

- **键名错配（关键坑）**：`RuneInfoData.NameKey` = `RuneName_DropChanceNormalChest`（**无** `Percent`），但 `RuneLevelInfoData.STATTYPE` = `DropChanceNormalChestPercent`（**有**）。按 NameKey 反查 STATTYPE 会得到「不存在」—— 必须**按 `LevelDataKey` 反查**。同名无后缀的 `AccountStat_DropChanceNormalChest` 是**另一种**（加法）属性，**不是**这些符文给的。
- **是乘数不是加法**：`AccountStat_DropChance*Percent` = `'{0}% Increased ... Drop Chance Multiplier'`。
- **每级同值** ⇒ 总加成 = `Σ(已购等级 × perLevelPercent)`，沿用现有符文族模型。
- 数据文件 `data/rune_drop_chance.json` 由 `scripts/dump_rune_drop_chance.py` **从游戏资源自动生成**（脚本会校验「同一节点各 level 值一致」，不一致即报错退出）。act boss 箱**没有**对应符文链。

## 6. 快速参考

```powershell
# 游戏更新后的完整刷新命令（按序执行）
python scripts/dump_game_locale.py
python scripts/extract_locale_catalog.py   # 4 语言的 locale_strings_*.json（网页版消费）
python scripts/build_tbh_data.py          # 版本号自动从 Version.txt 探测
python scripts/extract_icons.py
python scripts/audit_catalog.py
python scripts/audit_unresolved.py
python scripts/check_icons.py

# 站点数据：无需同步（网页版构建期内联 data/，见 §3 末）
git ls-files --eol data/gamedata.json      # 期望 w/lf
git diff --numstat -- data                 # 确认变更范围

# 符文数据（非管道2产物，游戏符文系统变化时手动提取，见步骤 1.5）
#   python scripts/dump_rune_tables.py  →  更新 rune_box_cap.json / rune_auto_open.json / box_types.json / rune_wave.json
#   该脚本是常驻工具（已入库），核对完不需要删除
#   python scripts/dump_rune_drop_chance.py  →  更新 rune_drop_chance.json（v1.3.0 掉率符文）

# locale 标签同步（游戏新增 GearType_/StashItemFilterType_ 等键时）
#   python scripts/sync_common_with_game.py    # 维护 common.json 的 labels 节
#   注意：Relic_* / Relic_Name 等非标准键名需在 build_types_lookup /
#   build_gear_groups_lookup 里显式加映射

# 应用侧
cd app
pnpm typecheck && pnpm lint && pnpm format && pnpm test
pnpm build
```

关键文件速查：

- 管道2 脚本：`scripts/build_tbh_data.py`
- 本地化转储：`scripts/dump_game_locale.py`（16 语言，供运行时回填占位名）
- 4 语言物品/关卡名：`scripts/extract_locale_catalog.py`（`data/locale_strings_*.json`，网页版消费）
- locale labels 同步：`scripts/sync_common_with_game.py`（维护 `app/shared/locales/*/common.json` 的 `labels` 节）
- 站点数据：构建期内联 `data/`（`app/src/web/dataSource.ts`）+ 运行时 `website/data/prices.json`（CI 暂存）
- 符文表转储：`scripts/dump_rune_tables.py`（容量/自动开箱/减波，人工比对）、`scripts/dump_rune_drop_chance.py`（掉率符文，**自动生成** `data/rune_drop_chance.json`）
- 图标提取/校验：`scripts/extract_icons.py`（含 `BOX_BAND_ICONS` 箱子 band 图标）、`scripts/check_icons.py`、`scripts/verify_icons.py`
- 运行时提取：`app/src/core/unityAssets/catalogExtractor.ts`（`CATALOG_SCHEMA_VERSION`）
- 运行时刷新：`app/src/main/catalogRefreshService.ts`（写入 `userData/gamedata.json`、`getStatus().stale`）
- 目录加载：`app/src/main/gameDataProvider.ts`（`getSchemaVersion()`）
- 图鉴合并：`app/src/main/services/LookupService.ts`（`setGameData`）
- 业务文档：`docs/BUSINESS-FLOWS.md` 第 9 章 / `docs/business-flows/09-chest-and-autoclassify.md` §13.7（万圣节活动箱）
