# scripts/ README

本目录存放**逆向工程与数据提取**类脚本，对象是 TBH 游戏的 Unity bundle、CSV 数据表和本地化资源。它们大多是开发期「探查 / 倒出 / 核对」的一次性工具，**不属于应用运行时依赖**。产物通常落到 `data/`（如 `gamedata.json`、`common.json`）供应用使用。

> 与其它脚本目录不同：`app/scripts/`（构建/QA/市场数据工具）、`.github/scripts/`（发布 CI）、`docs/agent/scripts/`（文档可视化）功能各异。

## 一、反向构建 gamedata.json

| 脚本 | 功能 |
|------|------|
| [extract_catalog.py](extract_catalog.py) | 从 ItemInfoData CSV + Unity 本地化 bundle 提取物品目录数据 |
| [extract_catalog_with_names.py](extract_catalog_with_names.py) | 提取目录，并携带物品名称 |
| [build_catalog.py](build_catalog.py) | 汇总上述提取结果，生成 `data/gamedata.json` |
| [peek_iteminfo_columns.py](peek_iteminfo_columns.py) | 查看 ItemInfoData CSV 表头与示例行（找图标字段） |
| [inspect_items.py](inspect_items.py) | 检查 ItemItemTable/CSV 中特定物品行的细节 |
| [analyze_itemkeys.py](analyze_itemkeys.py) | 分析 itemKey 模式（如 620017 为何出现在内存中） |
| [find_itemname.py](find_itemname.py) | 在提取结果中定位物品名 |

## 二、表 / SharedTableData 倒出

| 脚本 | 功能 |
|------|------|
| [dump_itemtable.py](dump_itemtable.py) | 深度倒出 ItemTable MonoBehaviour，找 key_id → string 映射 |
| [dump_shared.py](dump_shared.py) | 倒出 localization-assets-shared bundle（SharedTableData） |
| [dump_shared_keys.py](dump_shared_keys.py) | 倒出 ItemTable 中所有 marker=14 条目，看全部键类型 |
| [dump_shared_table.py](dump_shared_table.py) | 倒出 localization-assets-shared bundle 中的 SharedTableData |
| [dump_all_tables.py](dump_all_tables.py) | 倒出 sharedassets0 中每个 CSV TextAsset 的表头 + 示例行 |
| [scan_textassets.py](scan_textassets.py) | 扫描游戏 TextAssets，汇总其内容 |
| [dump_mono.py](dump_mono.py) | 倒出 MonoBehaviour 对象 |

## 三、本地化 / 多语言

| 脚本 | 功能 |
|------|------|
| [dump_game_locale.py](dump_game_locale.py) | 倒出所有 locale bundle 的全量本地化条目 |
| [extract_locale_catalog.py](extract_locale_catalog.py) | 按 locale bundle 提取本地化目录（含键前缀过滤） |
| [extract_loc_strings.py](extract_loc_strings.py) | 提取本地化字符串 |
| [dump_locale_index.py](dump_locale_index.py) | 倒出游戏 Locale 元数据：idx → LocaleCode 映射 |
| [dump_loc_bundle.py](dump_loc_bundle.py) | 倒出英文本地化 bundle 中 MonoBehaviour 的原始字节 |
| [dump_stringtable.py](dump_stringtable.py) | 倒出英文 string-table bundle 的完整结构 |
| [dump_stage_hero_names.py](dump_stage_hero_names.py) | 从 en-US 字符串表倒出所有 StageName_/HeroName_/Difficulty_ 条目 |

## 四、逆向探查（探针，多为研究用）

| 脚本 | 功能 |
|------|------|
| [probe_bundle_format.py](probe_bundle_format.py) | 探查 Unity bundle 格式，评估 Node.js 解析复杂度 |
| [probe_bundle_keys.py](probe_bundle_keys.py) | 探查 Unity 本地化 string-table bundle 的结构 |
| [probe_catalog.py](probe_catalog.py) | 探查目录生成结构 |
| [probe_localization.py](probe_localization.py) | 探查本地化机制 |
| [scan_markers.py](scan_markers.py) | 扫描本地化 bundle 中所有 marker=14 出现点，理解条目结构 |
| [compare_hashes.py](compare_hashes.py) | 对比 SharedTableData 与 EN StringTable 的哈希，找链接关系 |
| [probe_droppct.py](probe_droppct.py) | 逆向宝箱 dropPct 算法（diff 各种思路） |
| [probe_fields.py](probe_fields.py) | Probe 4：剩余字段推导（stats 显示、gearGroups、合成等级范围、stage spawnPct、firstDropOnly、合成模型、offerings） |
| [probe_scale.py](probe_scale.py) | Probe 5：(a) 装备 base/inherent 原始数值→展示值换算,(b) offerings 来源,(c) 合成等级范围来源,(d) synthesis 桶 materialAvgLevel |
| [probe_lookup_sources.py](probe_lookup_sources.py) | Probe：lookup_sources.json 结构样本 + DropInfoData DropType 统计 |
| [probe_lookup_sources2.py](probe_lookup_sources2.py) | Probe 2：synthesis_model 结构、offerings 来源、合成链接、dropPct 求和 |

## 五、图标相关

| 脚本 | 功能 |
|------|------|
| [probe_icons.py](probe_icons.py) | 探查游戏 assets 中按物品 id 键控的图标纹理/精灵 |
| [extract_icons.py](extract_icons.py) | 导出名为 `Item_<id>` 的物品图标精灵 |
| [verify_icons.py](verify_icons.py) | 校验 `Item_<id>` 精灵在 sharedassets0 中是否存在 |

## 六、数据质量审计

| 脚本 | 功能 |
|------|------|
| [audit_catalog.py](audit_catalog.py) | 审计生成的 gamedata.json 数据质量 |
| [audit_unresolved.py](audit_unresolved.py) | 审计未解析的 `ItemName_` 键，分析为何缺少本地化字符串 |

## 七、Node 同步脚本

| 脚本 | 功能 |
|------|------|
| [sync_common_with_game.py](sync_common_with_game.py) | 用游戏 bundle 翻译同步 `common.json` 的 labels 部分 |
| [sync-locale.mjs](sync-locale.mjs) | 一键同步 locale 翻译到游戏 bundle（`pnpm sync-locale`，默认期望游戏装在 SteamLibrary） |
| [sync-agent-skills.mjs](sync-agent-skills.mjs) | 将 `.cursor/skills` 镜像到 `.claude/skills` |
| [sync-agent-docs.mjs](sync-agent-docs.mjs) | 用代码生成 agent 文档清单（避免手维护） |

## 数据产物（非脚本）

- `itemname-extracted.json` — 提取出的物品名数据
- `loc-strings-en.json` — 英文本地化字符串快照