# 符文减波（Rune of Brevity）解析与修正

**日期**: 2026-09-10
**状态**: 已实现（待评审/提交）

## 决策

- contract:
  - `data/rune_wave.json`：`{ runeLabel: "Rune of Brevity", reductionPerLevel: Record<string,number>, note? }`
  - 新增 `loadRuneWaveCatalog()`（`core/boxes/catalog.ts`，走 `readBundledJson`），导出自 `core/boxes/index.ts`
  - 新增 `runeWaveCountReduction(purchases, catalog): number`（`core/boxes/runes.ts`，累加 `level × reductionPerLevel[runeKey]`，未知 key 跳过）
  - `ChestService.getRunePurchases(): RunePurchase[]` 复用已解析 purchases
  - `TrackingService.setRuneWaveReduction(n)`；`ingestLiveFrame` 单点修正 `stageWaveTotal`
- invariant:
  - 有效总波次 = `max(1, 运行时 waveAmount − runeWaveReduction)`（live 值基准，方案 B）
  - `runeWaveReduction === 0` 时行为与现状逐字节一致（不创建副本）
  - 修正只改 `stageWaveTotal`，不改 `stageWave`/`stageKey`/`stageAlive`/heroes/DPS/宝箱
  - 输入帧对象不被就地修改（用 `{ ...snap, stageWaveTotal }` 替换）
- failure:
  - `raw − reduction < 1` → 钳制为 1，打节流 warn（按 `(stageKey, raw, reduction)` 去重 + 时间节流）——这是"游戏已内建减波致重复扣"的探测信号
  - `stageWaveTotal == null` 或 `<= 0` → 不修正
  - `snap.connected === false` → 提前 return
  - 存档解析失败 → purchases 空/上次值，`setRuneWaveReduction(0)` 安全退化
- data:
  - 减波符文节点：`1171` / `1242` / `1301`（`RuneInfoData`），各 `MaxLevel=1`、`RuneLevelInfoData.Value=1` → 全点满 −3 波
  - 打包清单：`app/src/core/bundledData.ts` 的 `REQUIRED_BUNDLED_DATA_FILES` 与 `QA_GATE_BUNDLED_DATA_FILES` 均加入 `rune_wave.json`
- test:
  - 非目标（不做，减少范围）：
    - 不处理 `WaveMonsterAmount`（每波怪物数）
    - 不引入游戏静态关卡表 `StageInfoData.WaveAmount` 作为基准（仅方案 A；本次用方案 B）
    - 不新增 IPC channel、不改 renderer、不改 `stats.ts`/live 偏移读取
- 说明（决策记录）：
  - 口径 = live 值基准（你已确认方案 B，否决方案 A 静态表）
  - 落点 = `ingestLiveFrame` 单点（显示与 run-end 判据自动一致）
  - 诊断 warn = 保留（你已确认）
  - `runeWaveReduction` 不随 live 开关重置（存档属性）

## Working notes

- 依据（探索所得，含提取的符文表）：上一轮对话已确认。
- 本仓库另有 `docs/superpowers/specs/2026-09-10-rune-wave-reduction-design.md`（详版）；本文件为 praxis 工作流归档。
- 实现核对（2026-09-10）：数据层 `rune_wave.json` + `loadRuneWaveCatalog` + `runeWaveCountReduction` 已落地；`ChestService.getRunePurchases` / `TrackingService.setRuneWaveReduction` / `ingestLiveFrame` 单点修正 / `warnClampedWaveTotal` 节流 warn 均已实现并经单测（changeset：boxes/catalog.ts、boxes/index.ts、boxes/runes.ts、bundledData.ts、appState.ts、ChestService.ts、TrackingService.ts + 对应测试）。
- 门禁：typecheck/lint/format/build/minify（`dist/data/rune_wave.json` 已就位）均通过；除 `pnpm qa` 顶层被一个**预存在且无关**的 pets 集成测试失败阻塞（`test/integration/realSave.test.ts`：「parses pets and kill progress from live save」断言本地真实存档 `killCount >= 5000`，实为 81）外，其余单测全绿。该失败与符文改动零交集。
- **待处理项：** 是否单独修复上述 pets 集成测试（或改为数据无关断言）以令 `pnpm qa` 整体变绿；以及本次改动尚未 git commit。