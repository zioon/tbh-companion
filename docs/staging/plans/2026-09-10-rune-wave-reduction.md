# 符文减波（Rune of Brevity）解析与修正 —— 实施计划

**日期**: 2026-09-10
**spec**: `docs/staging/specs/2026-09-10-rune-wave-reduction.md`

顺序执行（T2/T3 依赖 T1，T4 依赖 T1–T3），完成后转入 `tdd`；无并行任务。

## 里程碑任务

- [x] T1: Core 数据层 —— ~40min
  ```
  goal:       新增减波符文目录 `rune_wave.json`、loader 与 `runeWaveCountReduction` 纯函数，并注册到打包清单
  files:      data/rune_wave.json; app/src/core/boxes/catalog.ts; app/src/core/boxes/runes.ts; app/src/core/boxes/index.ts; app/src/core/bundledData.ts; app/test/core/boxes.test.ts
  acceptance: `pnpm test` 通过（`runeWaveCountReduction` 覆盖空/部分/全 3 节点/未知 key/level>1/非法）；`app/test/core/bundledData.test.ts` 能加载 `rune_wave.json`；`pnpm typecheck` 0 errors
  spec:       #决策 contract/invariant/test
  ```

- [x] T2: 计算与传递 —— ~30min
  ```
  goal:       暴露 `ChestService.getRunePurchases()`，给 `TrackingService` 加 `setRuneWaveReduction`，appState 存档回调下推
  files:      app/src/main/services/ChestService.ts; app/src/main/services/TrackingService.ts; app/src/main/app/appState.ts; app/test/main/chestService.test.ts
  acceptance: `pnpm test` 通过（getRunePurchases 返回最近解析结果；setter 值变化触发日志、相同不触发、非法归 0）
  spec:       #决策 contract
  ```

- [x] T3: 单点修正 + 钳制 warn —— ~45min
  ```
  goal:       `ingestLiveFrame` 开头把 `stageWaveTotal` 修正为 `max(1, raw − reduction)`，并加节流钳制 warn
  files:      app/src/main/services/TrackingService.ts; app/test/main/trackingService.test.ts
  acceptance: `pnpm test` 通过（reduction=0 原样 / =3→28 / 钳制到1 / total=null 不修 / 输入帧未被就地修改 / run-end 重置用修正后 total）
  spec:       #决策 invariant/failure
  ```

- [x] T4: 文档同步 —— ~20min
  ```
  goal:       按 AGENTS.md 强制同步业务文档与打包清单
  files:      docs/BUSINESS-FLOWS.md; docs/DATA-UPDATE.md; docs/staging/specs/2026-09-10-rune-wave-reduction.md（如读后需微调）
  acceptance: 运行 `pnpm run sync:agent-docs` 回归生成 `docs/agent/generated/bundled-data-catalog.md`；检查 git diff：BUSINESS-FLOWS.md §4.6/§12 与 DATA-UPDATE.md 符文章节已更新
  spec:       #决策
  ```

- [x] T5: 收尾验证 —— ~20min
  ```
  goal:       全量质量门禁通过（bundle 守卫确认 rune_wave.json 进入 dist/data）
  files:      （仅运行命令）
  acceptance: `pnpm qa`（typecheck + lint + format + test + test:dom + build + bundle 守卫）全绿
  spec:       （范围确认）
  ```