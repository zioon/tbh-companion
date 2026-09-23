# 独立回归验证报告 —— TBH Companion 祈愿页改造（Wish v2）

QA：严过关（第二层 QA）｜工程：寇豆码（自测 IS_PASS: YES）

---

## TL;DR

- **RELEASE_OK: YES**（附 1 个 P2 呈现缺陷 + 1 个环境遗留失败，均不阻断发布）
- 6 条验收标准 S1–S6 **全部通过**；6 个风险区 R1–R6 **全部通过**（R6 命中 1 个 P2 缺陷）。
- **最高优先级 R1「绝不虚构 coinKey」未被攻破**：`coinKey` 非 null 当且仅当 `confidence==="observed"`，对抗用例（多币减少 / 无帧 / 越窗含边界 / bulk / 候选 miss / 反向枚举）全绿。
- 独立运行的全部检查：`npm run lint` rc=0；`npm run test:dom` 53 文件 300 用例全过；`npx prettier --check .` 全过；`npx vitest run` 仅 9 个失败**全部**在 `lookupPricePollingService.test.ts`（与本改造无关的既有环境问题）；`npm run typecheck` 仅 4 个既有错误（并行会话的 MaterialStack 重构，非 wish）。
- 新增对抗测试：`app/test/core/wishV2.qa.test.ts`（56 用例，全过）+ `app/test/renderer-component/WishV2.qa.test.tsx`（13 用例，12 过 / 1 精准命中 P2 缺陷）。
- **未修改任何源码**；仅新增 2 个测试文件；`ipc.ts` / `registerIpc.ts` / `preload/**` / `channels.test.ts` 未触碰（git 证实）。未 commit / push。

---

## 一、独立检查原始结果（逐项）

| 检查 | 命令 | rc | 结论 |
|---|---|---|---|
| 类型检查 | `npm run typecheck`（app/） | **2** | 4 个错误，**全部**在 `src/core/inventory/{ownedPriceTargets.ts(58),parse.ts(13),resolve.ts(16),stacks.ts(24)}`，均为 `MaterialStackTotal` / `.total` → **并行会话 MaterialStack 重构**，非 wish；wish 文件零错误 |
| Lint | `npm run lint` | **0** | 0 problems |
| 核心测试 | `npx vitest run` | **1** | `Test Files 1 failed | 145 passed (146)`；`Tests 9 failed | 2220 passed (2229)`；9 个失败**全部**在 `test/main/lookupPricePollingService.test.ts`，均 `Test timed out in 5000ms` |
| 组件测试 | `npm run test:dom` | **0** | `Test Files 53 passed`；`Tests 300 passed` |
| 格式 | `npx prettier --check .` | **0** | All matched files use Prettier code style |
| 我的新测试（core） | `npx vitest run test/core/wishV2.qa.test.ts` | **0** | 56 passed |
| 我的新测试（dom） | `npx vitest run --config vitest.dom.config.ts test/renderer-component/WishV2.qa.test.tsx` | **1** | 12 passed / 1 failed（R6-e，见 P2） |

### 9 个 lookupPricePollingService 失败的独立根因确认（不轻信工程"网络不可达"结论）

- 单独跑该文件并加 `--testTimeout=20000` → **仍有 5 个失败**，说明不是"5s 阈值太小"。
- 失败用例集中在**限流退避**相关（真实 `setTimeout` 等待，部分通过用例耗时 ~10s）。
- `git status --porcelain` 证实 `LookupPricePollingService.ts` 与其测试**均未被本改造修改**（历史提交 `de40e30c`/`b7f99d6c`）。
- **判定**：根因是真实时间的退避计时（本机网络环境加剧），**与本改造无关**（环境影响，非源码/测试缺陷）。

---

## 二、验收标准 S1–S6 逐项

| 项 | 结论 | 证据 |
|---|---|---|
| **S1** 移除"不可用"横幅；4 语言删 key | ✅ | 4 个 `wish.json` 无 `unavailable` 键；`Wish.tsx` 不渲染（仅 types.ts 残留 doc 注释）。QA 测试 S1-a/S1-b：zh-CN 无「实时读取器」，4 语言重渲染无任何不可用文案 |
| **S2** 按硬币类型计数；不可证时给候选集 + poolPct；**绝不虚构 coinKey** | ✅ | `coinGroupsFromHistory` 按 `observed.coinKey` 分组（offeringCount=行数，itemCount=件数和）；`inferCoinCandidates` 命中给 `inferred`+候选（含 poolPct 降序），miss 给 `unknown`+空候选。R1 全套对抗通过 |
| **S3** 记录页祈愿行不显示金色"通关"，落 `wish` 桶（紫 `#c78fe8` + `fitWish`） | ✅ | `RecordLog.tsx`：`wish:"#c78fe8"`、`wish:"fitWish"`；`deriveRow` 在 `!fit` 分支 `if(isWishLine(raw)) cat="wish"`。`fitAcquireSources` 预先排除祈愿行 → `fit` 缺失 → 落 wish 桶（非 `clear`→金色） |
| **S4** 祈愿次数 / 物品数 / 最近时间可见且一致 | ✅ | 双计数 I1（1 行=+1 次，件数另计）；`lastWishWallTime`、`recentResults` 均派生自 history |
| **S5** 布局对齐掉落页（上两列：左持有硬币 / 右最近结果 + 下按硬币分组） | ✅ | `Wish.tsx` L73-78：`grid-cols-2`（左 `WishHeldCoins` / 右 `WishRecentResults`）；L80 全宽 `WishCoinGroups` |
| **S6** `WishGrade` 恰 11 成员；4 语言 `grade` 段 11 键 | ✅ | 运行期 `gradeDistribution.length===11`；core/renderer/stats 三处顺序一致；4 语言 grade 11 键 + 顺序一致（测试 R5-a/g 通过） |

---

## 三、风险区 R1–R6 逐项

| 项 | 结论 | 证据 / 对抗用例 |
|---|---|---|
| **R1（最高）绝不虚构 coinKey** | ✅ **未攻破** | `attributeCoinByDiff` 仅在唯一减少+窗内返回 `observed` 且带 coinKey；其余路径 `coinKey:null`。对抗：多币减少→`multi-coin`；无帧→`no-frame`；窗左右边界**外** 0.001s→`out-of-window`，边界**内**（含端点）→observed；bulk→`bulk-skip`；帧时刻缺失→`no-frame-time`；候选 miss→`unknown`+空候选；反向枚举 8 组非 observed 输出 coinKey 恒 null；coinKey 恒属闭集。`attributeWishCoin` 接线复核：diff→observed 早返回；无 deps 返回 observed(此时实为 unknown，coinKey=null)；候选命中→inferred |
| **R2 记录页祈愿行归因** | ✅ | 祈愿行 sourceFit 为空（4 语言 + 结构兜底）；祈愿行+相邻通关行 0.627s→祈愿空/通关仍归；不被 Pass 1/2/3/4 认领；bulk 永不归；英雄行 5 项护栏（紫 + 文本）未破坏；**真实归档实证**：`seq=363`（木盾）距通关行仅 **0.292s**→仍不被认领 |
| **R3 `feed` 第 4 参可选** | ✅ | 3 参调用 `entry.coin===undefined`、不报错；4 参写入 `coin`；`recentResults` 对缺失 coin 兜底 unknown。`TrackingService.ts:1070` 4 参调用正确 |
| **R4 不变量 I1–I10** | ✅ | I1 双计数、I2 会话重置（session 归零/累计不变/epoch++）、I3 重置不清历史、I4 bulk 不入滚动窗、I7 非法品质→UNKNOWN、I8 `HISTORY_LIMIT=500`/`HISTORY_VISIBLE=50`/`WISH_RECENT_VISIBLE=20` 全部命中。**I5 零新 IPC**：`ipc.ts`/`channels.test.ts` git 未改，`registerIpc.ts` 未跟踪/未改，`preload/**` 无文件。**I9** 源码级断言 core 7 文件无 electron/fs/fetch/react。**I10** mermaid 图已同步（14-wish-record.md:131、11-record-log.md:195） |
| **R5 11 桶 / 三处一致 / 旧档兼容** | ✅ | `WishGrade` 11 成员；core `GRADE_ORDER`、`stats.ts EMPTY_WISH`、`useWish.ts GRADE_ORDER` **三处顺序一致**（`CELESTIAL` 先于 `BEYOND`，工程曾错序已修，**复核确认**）；`isWishGrade` 回退；旧快照 `applySnapshot` 缺新字段不崩、旧 grade 保留；4 语言对齐 |
| **R6 UI 呈现** | ⚠️ 除 P2 外全绿 | 3 态视觉互斥（仅 1 个 `data-confidence`）；observed 才带 `data-coin-key`，inferred/unknown 绝不带（不伪造）；inferred tooltip 含硬币名 + poolPct（42.0%/8.0%）；inferred 空候选降级 unknown；unattributed 空时不渲染；heldCoins 空态 + 合计；**R6-e 表头重复 → P2 缺陷** |

---

## 四、缺陷清单（按严重度）

### P2（呈现瑕疵，不阻断发布）

- **祈愿页「最近祈愿结果」表头重复"物品"**
  - **文件**：`app/src/renderer/components/wish/WishRecentResults.tsx:48`
  - **复现**：渲染 `WishRecentResults`，读取 `thead th` → `["时间","物品","硬币","物品"]`（第 4 个应为"数量"）
  - **预期**：4 列头为 时间 / 物品 / 硬币 / 数量，互不重复
  - **实际**：第 4 个 `<th>` 误用 `t("recent.columnItem")`；且 `recent.columnCount` 键**不存在**（`zh-CN/wish.json` 的 `recent` 段仅 columnItem/columnCoin/columnTime，`columnCount` 只在 `history` 段）
  - **归因**：**源码缺陷**（测试正确，抓到了真实缺陷）。修复需：4 语言 `recent` 段增 `columnCount`（如"数量"/"Qty"等）+ 组件改引用。**我是 QA，不得改源码，交由 Engineer 修复**
  - **影响**：仅表头文案重复（数据单元格用的是 `recent.countLabel`，正确）；不影响数据正确性
  - **测试**：`app/test/renderer-component/WishV2.qa.test.tsx` → `R6-e`（保持红，作为缺陷回归证据）

### 环境遗留（非本改造）

- **`test/main/lookupPricePollingService.test.ts` 9 个超时失败**
  - **归因**：**环境**（真实时间退避计时 + 本机网络），**非源码/测试缺陷**。该服务与本改造无关，文件未被修改。
  - 建议：CI 环境固定重跑验证，或标记为已知 flaky。

### 并行会话遗留（非本改造）

- **`typecheck` 4 个 `MaterialStackTotal` 错误**（`src/core/inventory/*`）
  - **归因**：**并行会话** MaterialStack 重构（`MaterialStackTotal` 在 HEAD 不存在）。`shared/types.ts` 改动为纯增量（126 增 0 删），未引入该错误。

---

## 五、对抗测试清单（新增，均遵守项目约定）

**`app/test/core/wishV2.qa.test.ts`（56 用例，全过）**
- R1：单/多币、无帧、越窗（含边界内/外 0.001s）、bulk、帧时刻缺失、候选命中/miss、反向枚举、闭集校验（10 条）
- R1-window：`WishCoinDiffWindow` bracket 语义（保留 2 帧、乱序、<= 语义、reset、非有限 at）（6 条）
- R2：4 语言前缀、祈愿+相邻通关、Pass1/2/3、跨语言识别、零误判、真实归档 seq=363/3432、英雄行、bulk（11 条）
- R3：3 参/4 参/recentResults 兜底（3 条）
- R4：I1/I2/I3/I4/I7/I8/I9（7 条）
- R5：11 桶、三处顺序、旧档兼容、含 coin 分组、4 语言（7 条）
- S2/S4 coinGroups 派生（3 条）+ 常量 + buildNameIndex + 类型（9 条）

**`app/test/renderer-component/WishV2.qa.test.tsx`（13 用例，12 过 / 1 命中 P2）**
- R6-a/a2 三态互斥 + coinKey 不伪造；R6-b/b2 候选 tooltip + 空候选降级；R6-c/c2/c3 unattributed 空时不渲染 + 候选展示；R6-d/d2 heldCoins 空态 + 合计；**R6-e 表头唯一性（缺陷）**；R6-f 未知硬币降级；S1-a/b 横幅移除（含 4 语言）

**约定遵守**：`record_log` 用例用高位唯一 `ringSeq`（900000+）；帧数据手写 `Map<number,number>`（10 coinKey），不读真实存档（仅 R2-b2/b3 引用真实归档**数值**作为证据，仍用 900000+ seq）。

---

## 六、未验证 / 存疑项

1. `WISH_COIN_GRADE_FALLBACK` 与 `lookup_items.json` 一致（160007=BEYOND, 160008=CELESTIAL），与「WishGrade 顺序中 CELESTIAL 先于 BEYOND」形成**文档/数据与枚举顺序的表达冲突**。经核：mandated 顺序已在三处 `GRADE_ORDER` 正确实现，fallback 表**忠实于权威数据**，故**非代码缺陷**（仅命名/文档层面易混淆）。已记录，建议文档显式说明。
2. `RecordLog.tsx:138-149` 自有 `GRADE_ORDER`（10 项，BEYOND 先于 CELESTIAL）——**另一个特性**（记录页品质 chip 排序），与 Wish 11 桶无关；仅一致性观察，未改。
3. 真实归档端到端仅覆盖 2 条历史祈愿行（zh-CN），非 4 语言真实样本；4 语言识别由合成样本覆盖。
4. 未做真实 Electron 运行期人工验证（reader 开启下真实祈愿）；本轮为纯逻辑 + 组件级验证。

---

## 七、智能路由判定

- **R6-e 表头重复 → 送 Engineer（Alex/寇豆码）修复**：源码缺陷（`WishRecentResults.tsx:48` + 4 语言 `recent.columnCount` 缺失）。测试正确，保持红。
- **测试自查修复（QA 自己）**：R5-c 初版断言误假设 `stats.ts` 用 `COMMON:` 简写（实为 `{grade:"COMMON"}` 对象）→ 已修正为按 `grade:"X"` 正则提取；R1/R5 我的 2 处类型形状（`buildNameIndex` 返回 Map、`OfferingsModel` 为数组）→ 已修正。以上均为**测试 bug**，已自修，现全绿。
- **其余全过 → 报告成功（NoOne）**。

---

## 八、最终结论

**RELEASE_OK: YES**（阻断级缺陷 0）

- Wish v2 改动**未引入任何新类型错误 / lint / 格式问题**；未新增 IPC（I5 守住）。
- 6 项验收标准 + 6 个风险区全部通过；核心不变量 R1「绝不虚构 coinKey」经对抗验证**未被攻破**。
- 唯一新增缺陷为 P2 呈现瑕疵（表头重复），不阻断发布，建议 Engineer 随下一次提交修复。
- 既有 9 个 `lookupPricePollingService` 失败为环境问题；4 个 typecheck 错误为并行会话 MaterialStack 重构。
- **2 轮内完成**（Round 1 写出并运行对抗测试，自修测试 bug；Round 2 复跑全绿 + 确认 P2）。

**测试文件**：`app/test/core/wishV2.qa.test.ts`（56）、`app/test/renderer-component/WishV2.qa.test.tsx`（13）。未 commit / push，未改源码。
