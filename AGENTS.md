# AGENTS.md - TBH Companion

供任何从头接手此项目的 agent 或贡献者快速上手的简要说明。改动解密逻辑或物品映射前，请先阅读 `docs/`。

**Agent 工作框架：** 各项策略与分层指南位于 [`docs/agent/`](docs/agent/README.md) —— 每个主题一个文件。git、QA、PR 与编码规则请从这里开始。

## 项目简介

这是放置类游戏 **TBH: Task Bar Hero** 的伴侣应用。它以只读方式读取游戏的本地加密存档，并展示实时数据：经验/小时、金币/小时、各英雄速率、会话历史，以及基于 Steam 市场的库存估值。它从不修改存档，也从不与游戏服务器通信。

## 目录结构

- `app/` - 伴侣应用本体（Electron + React + TypeScript），即目标代码库。
  - `app/src/main/` - Electron 主进程（Node）：文件监听、解密、追踪、IPC。拥有全部文件/网络访问权限。
  - `app/src/preload/` - 通过 `contextBridge` 暴露类型化的 `window.tbh` API。
  - `app/src/core/` - 无框架依赖、经单元测试的业务逻辑。子模块：`es3`、`save/snapshot`、`tracker`、`stages`、`heroes`、`gamedata`、`boxes/*`、`inventory/*`、`liveMemory/*`、`lookup/*`、`lookupPrice/*`、`pets/*`，以及 `steamPrice`、`steamMarketFee*`、`sessionState`、`stageRunTracker`、`chestDropTracker`、`grades`、`labels`、`levelCurve`、`windowLayout`。
  - `app/src/renderer/` - React UI（标签页 + 迷你悬浮窗）。纯 UI，不依赖 Node API。通过 `context/TbhProvider.tsx` 共享 IPC 状态。
  - `app/shared/` - `types.ts`、`ipc.ts`（IPC 通道名）、`notificationCatalog.ts` —— 跨进程共享，不含运行时逻辑。
- `data/` - 内置数据目录（`gamedata.json`、`stage_boxes.json`）。
- `docs/` - 知识库（见下文）。
- `config.json` - 用户设置，供应用复用。

原 Python 原型（`tbh_xp/`）在 TS 核心达到同等能力后已移除；历史沿革见 `docs/DECISIONS.md`。

应用共有两个共享同一 bundle 的窗口：完整的标签页伴侣界面（`#main`）与无边框置顶迷你悬浮窗（`#overlay`）。点击标签栏的 "Mini" 按钮切换到悬浮窗；点击悬浮窗的展开按钮恢复主窗口。

## 构建 / 运行 / 测试

本项目使用 **pnpm**（通过 `packageManager` 锁定版本，经 Corepack 激活：`corepack enable`）。

```
cd app
pnpm install
pnpm dev                 # electron-vite 开发模式（主进程 + 渲染进程，支持 HMR）
pnpm build               # 生产构建（输出到 out/）
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm test                # vitest（核心逻辑）
pnpm test:dom            # 使用 DOM 配置的 vitest（渲染进程组件测试）
pnpm bench               # 见 docs/BENCHMARKS.md
pnpm bench:ci
pnpm storybook           # Storybook 开发服务器
pnpm build-storybook     # Storybook 静态构建
pnpm build:lookup-prices # 重新构建内置的查询价格快照
pnpm minify-and-copy-data # 压缩数据目录到 dist/data（pack/dist 前执行）
pnpm qa                  # typecheck + lint + format + test + build + bundle 守卫
pnpm qa:dev              # UI 不可见时的自动化开发冒烟测试 —— 见 docs/agent/QA.md
pnpm pack                # 压缩数据 + 构建 + electron-builder --dir -> release/win-unpacked
pnpm dist                # 压缩数据 + 构建 + Windows NSIS 安装包
pnpm build:web           # 浏览器版（站点根五页应用）静态构建 -> 仓库根 dist-web/
pnpm preview:web         # 本地预览 dist-web/（部署前冒烟）
```

**网页版（`dist-web/` → 站点根）**：`pnpm build:web` 用 `vite.web.config.ts` 单独构建一份不依赖 Electron 的静态产物，由 `pages.yml` 暂存到 `website/` 根目录——**站点根就是真应用**，含 Home / Inventory / Chests / Lookup / Trading 五页（旧 `/inspector/` 仅剩跳转桩）。它复用同一份 `core/` 源码，构建期做三处替换：`core/es3` → `core/es3Web`（node:crypto → WebCrypto）、`bundledData` → `bundledDataWeb`（磁盘读取 → `src/web/dataSource.ts` 注入的内存目录）、`renderer/lib/iconSrc` → `src/web/iconSrcWeb.ts`（`tbh-asset://` 自定义协议 → 同源静态 PNG；图标由 `scripts/copy-web-icons.mjs` 在 vite 构建后复制到 `dist-web/icons/`）。**不导入存档也要有内容**：Lookup / Chests / Trading 用构建期内联的目录数据 + 同源价格快照（`website/data/prices.json`，CI 暂存），无需存档即渲染真实内容；Home / Inventory 无存档时显示存档路径指引。实时追踪、内存读取、悬浮窗、自动更新等能力在页面上以导流卡片指向桌面版。改 `core/` 业务逻辑时两份产物自动同步，但**改动 `es3` 的加解密契约必须同时核对 `es3Web`**，`test/web/es3Parity.test.ts` 是这两者的等价性守卫。部署与域名关联见 [`docs/DEPLOY-WEB.md`](docs/DEPLOY-WEB.md)。

**Windows 注意事项**（BOM、PowerShell、路径、Electron 安装）：[`docs/agent/WINDOWS.md`](docs/agent/WINDOWS.md)。

## 约定

- **文档语言：** 所有说明文件（`docs/` 下的全部 `.md`、根目录 `*.md`、`docs/agent/` 与 `docs/superpowers/` 下的所有文档）必须使用中文撰写。代码注释、commit message、PR 描述保持现有惯例（中英混合/英文）。新增英文文档需在 PR 中说明理由。
- **业务流程变更（强制）：** 所有针对项目业务逻辑的代码改动（save 解析、tracker 速率计算、live memory 读取、inventory/lookup/market、boxTimer、autoClassify、notification、session 持久化、catalog refresh、update、pet、stageRun 等任意业务流程），**必须**：
  1. **动手前**：先查阅 [`docs/BUSINESS-FLOWS.md`](docs/BUSINESS-FLOWS.md) 的章节索引，定位并阅读 [`docs/business-flows/`](docs/business-flows/) 中承载该流程正文的子文件，理解现有数据流、服务边界与不变量，避免重复设计或破坏既有契约。
  2. **落地后**：在同一个 PR 内**同步更新**该流程所在的子文件（含数据流图、错误处理路径、关键文件路径速查表）。若新增了业务流程，在子目录追加新文件并在主索引的章节索引表中登记（章节编号按现有顺序递增，不重排已有编号）。
  3. **审查时**：PR 审查者需确认对应子文件与主索引已同步，未同步的 PR 不予合并。
- **代码导航优先用 codegraph：** 涉及代码理解、定位、修改或调试的任务，第一步先通过 MCP 工具 `codegraph_explore` 查询相关符号/文件（`projectPath` 传仓库根 `d:\Project\TBH\tbh-companion`），其返回的源码视为已读；仅当 codegraph 未命中或需要文件级细节时，再回退 Read/Grep。
- **codegraph 索引自动同步：** 仓库根 `.githooks/post-commit` 会在每次 commit 后自动执行 `codegraph sync -q` 增量更新索引（`core.hooksPath` 已指向 `.githooks`），无需手动维护。
- `app/` 内全部使用 TypeScript。保持 `core/` 不引入 Electron/React 依赖，以维持其可单元测试性。
- **开始 `app/` 工作前：** 先阅读 [`docs/agent/SKILLS.md`](docs/agent/SKILLS.md)（路由）与 [`docs/agent/CODING-GUIDELINES.md`](docs/agent/CODING-GUIDELINES.md)。
- **完成的定义：** 通过 [`docs/agent/QA.md`](docs/agent/QA.md) —— 而不仅是测试全绿。
- **Git / push / PR：** 见 [`docs/agent/GIT.md`](docs/agent/GIT.md)、[`docs/agent/PULL-REQUEST.md`](docs/agent/PULL-REQUEST.md)。

## 架构（四层）

添加功能时请遵循以下分层 —— 完整细节见 `docs/ARCHITECTURE.md`：

| 层 | 路径 | 规则 |
|-------|------|--------|
| **shared** | `app/shared/` | 类型 + `ipc.ts` 通道名。无运行时逻辑。 |
| **core** | `app/src/core/` | 纯领域逻辑。**不得**引入 `electron`、**不得**引入 `node:fs`、**不得**使用 `fetch`、**不得**依赖 React。 |
| **main** | `app/src/main/` | 文件 I/O、网络、窗口、IPC。通过 `app/appState.ts` 与 `ipc/` 编排 core。 |
| **preload** | `app/src/preload/` | 仅薄薄一层 `contextBridge`；从 `shared/ipc.ts` 导入通道名。 |
| **renderer** | `app/src/renderer/` | 通过 `window.tbh` 访问的 React UI。筛选/排序放在 `renderer/lib/` 或 `core/` 纯函数中。 |

**添加功能：** 分层文档位于 `docs/agent/layers/` —— 新增 IPC → `shared/ipc.ts` + `main/ipc/registerIpc.ts` + preload + `test/ipc/channels.test.ts`。新增存档字段 → 仅在 `core/` 中解析、仅在 `main/` 中读取字节。新增 main 服务 → 按 `docs/DIAGNOSTIC_LOGGING.md` 记录日志。

**测试：** 新增 `core/` 逻辑需要 Vitest 测试；新增 IPC/config 处理器需要 `test/main/` 或 `test/ipc/` 下的测试。

## 工作流技能（Cursor + Claude）

多步骤工作流以技能形式存放在 `.cursor/skills/`（手动镜像到 `.claude/skills/` —— 目前 `package.json` 中未定义同步脚本）：

| 技能 | 使用时机 |
|-------|------|
| **tbh-reviewer** | `/review-pr <N>` |
| **tbh-feature-showcase** | 功能上线后的截图 + 玩家公告 |
| **tlc-spec-driven** | 项目工作流的规格 / 计划 / 实现 |

在 `.cursor/skills/` 中编辑规范技能；将修改镜像到 `.claude/skills/` 并提交两处目录。

## 文档索引

### Agent 工作框架（`docs/agent/`）

- [`README.md`](docs/agent/README.md) — agent 文档地图
- [`SKILLS.md`](docs/agent/SKILLS.md) — 按路径查阅对应文档
- [`CODING-GUIDELINES.md`](docs/agent/CODING-GUIDELINES.md) — 实现行为规范
- [`QA.md`](docs/agent/QA.md)、[`QA-CHECKLIST.md`](docs/agent/QA-CHECKLIST.md) — 完成门槛
- [`GIT.md`](docs/agent/GIT.md)、[`PULL-REQUEST.md`](docs/agent/PULL-REQUEST.md) — commit、push、PR
- [`WINDOWS.md`](docs/agent/WINDOWS.md) — PowerShell 与环境
- [`CHANGELOG-RELEASE.md`](docs/agent/CHANGELOG-RELEASE.md) — 发布说明与语义化版本
- [`MAINTENANCE.md`](docs/agent/MAINTENANCE.md) — 保持 agent 文档与代码同步
- [`generated/`](docs/agent/generated/) — 由代码生成的清单（请勿手工编辑）
- [`layers/`](docs/agent/layers/) — main、core、renderer、renderer-performance、UX、UX-patterns、design-system、data

### 领域知识

- [`docs/BUSINESS-FLOWS.md`](docs/BUSINESS-FLOWS.md) — **业务流程单一真理源（索引与框架）**（必读）。主文件保留 §0 项目目标与四层架构、章节索引、§18 跨服务数据流总览、§19 关键错误处理路径汇总、§20 关键文件路径速查、§21 文档维护约定、§22 历史背景；**各流程正文按主题拆分在 [`docs/business-flows/`](docs/business-flows/)**（13 个文件，覆盖 §1–§17、§23、§24 的启动、save 解析、tracker 双路径、live memory、inventory/lookup/market、boxTimer、autoClassify、notification、session 持久化、catalog refresh、update、pet、stageRun、record log、开箱补齐等全部业务流程）。任何业务逻辑改动**必须**先经主索引查阅、落地后**同步更新**对应子文件。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - 进程、IPC 边界、窗口、数据流
- [`docs/STYLING.md`](docs/STYLING.md) - Tailwind + 设计系统 vs 旧版 `styles.css`
- [`docs/DIAGNOSTIC_LOGGING.md`](docs/DIAGNOSTIC_LOGGING.md) - 支持日志（main/renderer 规则）
- [`docs/SAVE_FORMAT.md`](docs/SAVE_FORMAT.md) - ES3 解密 + 存档 JSON 结构
- [`docs/DATA-UPDATE.md`](docs/DATA-UPDATE.md) - **富数据更新全流程（管道2）**：游戏版本更新后重新生成 gamedata/lookup/图标/本地化的操作手册
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) - 性能基准
- [`docs/DECISIONS.md`](docs/DECISIONS.md) - ADR 日志
- [`docs/findings/`](docs/findings/) - 研究成果（Steam Market、物品映射、审计报告）
