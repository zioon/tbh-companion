# 应用内广告接入全流程指引

> 对象：TBH Companion（Electron 桌面版 + `dist-web/` 网页版 + `website/` 官网，MIT，v1.24.3）
>
> 本文是**决策 + 实施指引**，不是已批准方案。进入实施前必须先完成 §1 的合规确认与 §2 的风险拍板。

---

## 0. TL;DR

| # | 结论 |
| --- | --- |
| 1 | **桌面版（Electron）不能放 Google AdSense。** AdSense 计划政策明令禁止把 Google 广告整合进任何形式的软件应用，明确点名工具栏、浏览器扩展、**桌面应用**；AdSense 代码只能植入网页和**经批准的 WebView**。强行嵌入 = 封号，没有灰色地带。 |
| 2 | **Windows 桌面目前没有主流合规广告 SDK。** Microsoft 的 UWP 广告变现平台已于 **2020-06-01 关停**；AdMob 只支持 Android/iOS。 |
| 3 | 桌面端唯一合规路径：**应用内只放「入口」，广告渲染在官网页面**（用系统浏览器打开）。 |
| 4 | 真正能自动变现的广告位在 **官网 + 网页版**；但两者代价不同——官网本来就加载 Google Fonts，破坏的是弱承诺；`dist-web/` 产物目前是**真·零外链**（`docs/DEPLOY-WEB.md` §5 把它写成了上线检查项），代价高得多。 |
| 5 | 以本项目量级，广告收入大概率是**每月个位数到几十美元**。同等投入下「自营赞助位 + 捐赠 + 高级版」的收益/信任损失比更好。 |
| 6 | 本项目捆绑了游戏美术素材（364 个图标、gamedata、四语言本地化）。**用他人的 IP 做广告变现**，风险等级显著高于免费工具——这是最先要拍板的一件事。 |

---

## 1. 合规红线（先说不能做的）

| 平台 | 政策事实 | 对本项目的影响 |
| --- | --- | --- |
| Google AdSense | 计划政策「将广告置于软件应用中」：发布商**不得**通过软件应用展示 Google 广告或 AdSense 搜索广告框。此类软件应用包括但不限于工具栏、浏览器扩展和**桌面应用**。AdSense 代码只能植入网页和经过批准的 WebView 技术 | Electron `renderer` / `BrowserView` **一律不可用** |
| Google AdMob | 仅移动端（Android / iOS） | 不适用 |
| Microsoft Advertising SDK | UWP 广告变现平台 **2020-06-01 已关停** | 不适用（且本项目走 NSIS 分发，非 Store） |
| 弹窗/popunder 类联盟（PropellerAds 等） | 政策上允许桌面软件，但形态即弹窗/新窗口跳转 | **与安装包信誉直接冲突**，高概率触发 Defender / SmartScreen 标记，见 §2.4 |
| GitHub Pages | 允许有限变现（捐款按钮、众筹链接被明确点名允许）；合规站点上的一般广告可接受，但**站点不能以广告为主要目的**，且有 1 GB / 站的容量约束与带宽限制 | 官网挂 AdSense 可行；若整站变成广告驱动，应迁到商业托管 |
| AdSense 审核门槛 | 自定义顶级域名、**原创内容 15–30 篇**、HTTPS、Privacy / About / Contact 页齐全、无侵权内容、无禁止内容 | 目前官网是**单页落地页**，直接申请大概率被判 `low value content` |
| AdSense 同意管理 | EEA / UK / CH 流量必须使用 **Google 认证 CMP** 并接入 IAB **TCF v2.3**（迁移死线 2026-02-28 已过）。不合规会被降级为 Limited Ads，收入可能腰斩 | 需接入认证 CMP（Google 自家 CMP 可免费使用） |

**总结：桌面应用内嵌广告联盟 = 不可行。** 剩下的全部是「把广告放到网页上」的变体。

---

## 2. 项目专属风险（先拍板，再动手）

### 2.1 IP 与法律风险（最高）

应用捆绑了 364 个游戏物品图标、`gamedata.json`、四语言本地化文本，并读取游戏本地存档、抓取 Steam 市场数据。

- 免费、只读的 fan tool 属于常见社区实践，权利人一般容忍。
- 一旦叠加广告收入，性质从「爱好者工具」变为「使用他人 IP 的商业产品」，权利人主张的动机与力度都会上升。

**动作：** 动手前先确认游戏方（Tesseract Studio）对 fan tool / 商业化的态度（Steam 社区、官方 Discord、邮件），并保留书面沟通记录。若拿不到明确态度，宁可走捐赠路线。

### 2.2 信任资产会被削弱

- 官网卖点：open-source、read-only、不用服务器、不传存档。
- `docs/DEPLOY-WEB.md` §5 把「**无遥测**：全站无分析脚本、无第三方请求」写成了上线检查项。

加广告等于主动放弃这一差异点。**需要接受的心理准备是：这不是技术问题，是产品定位变更。**

### 2.3 MIT 协议

MIT 允许商业化，但项目接受外部 PR。若在贡献者代码之上叠加广告收入，建议提前在 README 说明变现方式与用途（例如「捐给游戏方 / 覆盖域名与签名成本」），降低社区摩擦。

### 2.4 杀软与安装包信誉（写进设计红线）

任何「应用内弹窗 / 后台拉取广告」的实现都会显著提高被 Defender、SmartScreen 标记的概率，也会污染安装包信誉（本项目无代码签名，对信誉更敏感）。**红线：不做弹窗、不做后台广告拉取、不引入任何第三方广告 DLL/原生模块。**

---

## 3. 方案选型决策树

见配图「广告接入合规路径决策树」。一句话版本：

- **桌面应用内** → 无合规联盟可用 → 只能「自营赞助位」或「只放入口、广告在网页」。
- **官网 / 网页版** → AdSense 可用，但需先过审核（要内容）并接认证 CMP。

---

## 4. 三条可行路径

### 路径 A —— 自营赞助位（推荐起点）

不经广告联盟，直接与赞助方（游戏相关工具、外设、独立游戏、内容创作者）谈固定位置。

| 维度 | 评估 |
| --- | --- |
| 合规 | 不受 AdSense 政策约束（不是 Google 广告）；需自行标注「Sponsored」 |
| 技术 | 官网 + 应用内均可，纯静态 HTML/图片，可离线内嵌，**零第三方请求** |
| 收益 | 单笔可谈，但不稳定、需人工销售 |
| 工作量 | 低（技术）/ 高（商务） |
| 适用 | 用户量不大但画像精准（游戏玩家）时最划算 |

**最适合作为第一步**：不破坏「零外链」承诺，又能验证「用户是否接受应用内有推广位」这一关键假设。

### 路径 B —— 官网 / 网页版 AdSense（唯一能规模化自动变现）

| 维度 | 评估 |
| --- | --- |
| 合规 | 允许，但必须过审核 + 接认证 CMP |
| 前置 | 需要先做**内容**：15–30 篇原创页面（关卡掉落表、物品价格参考、新手攻略、更新日志解读） |
| 技术 | 官网可直接插代码；`dist-web/` 需改 CSP（见 §5.3） |
| 收益 | 取决于 PV，见 §8 |
| 风险 | 网页版若被用户视为「为看广告而做的演示站」，会拉低转化 |

### 路径 C —— 应用内只做「入口」（桌面端唯一合规做法）

应用内放一个「支持我们 / 赞助商」区块或标签页，点击后用系统默认浏览器打开官网。广告本身只出现在官网上。

| 维度 | 评估 |
| --- | --- |
| 合规 | 完全合规 |
| 技术 | 改动最小，已有现成机制（见 §5.4） |
| 收益 | 转化率低（多一次跳转），但零风险 |
| 注意 | 悬浮窗 `#overlay` **绝不显示任何推广内容** |

---

## 5. 技术落地

### 5.1 阶段划分与门禁

| 阶段 | 内容 | 通过门禁 |
| --- | --- | --- |
| 0 | 拍板：IP 风险、定位变更是否接受、选哪条路径 | 有明确结论，记录进本文 |
| 1 | 官网 `website/` 加赞助位（路径 A）或内容页（路径 B 前置） | `pages.yml` 部署成功；官网无 JS 报错 |
| 2 | 网页版 `dist-web/` 接 AdSense（路径 B） | CSP 改动经审视；`pnpm smoke:web` 通过 |
| 3 | 桌面端加入口（路径 C） | `pnpm qa` 全绿；断网可用；悬浮窗无推广 |
| 4 | 合规文档：隐私政策、CMP、条款 | 隐私政策覆盖广告域名与退出链接 |
| 5 | QA：断网、广告拦截器、离线、布局抖动、性能基线 | 见 §9 检查清单 |
| 6 | 灰度 + 开关 | 可一键关停（配置或远端 manifest） |

### 5.2 官网（`website/index.html`）

- 该页**没有 CSP meta**，且已经加载 `fonts.googleapis.com` / `fonts.gstatic.com` 与 Lucide CDN。因此在这里加广告，破坏的是弱承诺，实现成本最低。
- 建议同时补一条 CSP，显式放行广告域名（示例，需按实际联盟域名补全）：

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self';
           script-src 'self' https://pagead2.googlesyndication.com https://*.googlesyndication.com;
           img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com;
           frame-src https://googleads.g.doubleclick.net https://*.googlesyndication.com;
           style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
           font-src https://fonts.gstatic.com;
           connect-src 'self' https://*.googlesyndication.com https://*.doubleclick.net" />
```

- 广告位摆放：内容之间、页脚之前。**不要**放在下载按钮旁边（AdSense 明令禁止把广告伪装成功能按钮，属最高风险等级违规）。

### 5.3 网页版（`app/src/web/index.html`）

当前 CSP 是硬约束：

```
default-src 'self'; script-src 'self'; img-src 'self' data:;
style-src 'self' 'unsafe-inline'; font-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'
```

放 AdSense 必须放开 `script-src` / `img-src` / `frame-src` / `connect-src`。

**代价清单（都要一起改，否则不一致）：**

1. `docs/DEPLOY-WEB.md` §5 检查清单里的「无遥测 / 无第三方请求」条目必须改写，说明广告域名白名单。
2. `app/src/web/index.html` 的 CSP 注释目前写着「the only outbound requests are for bundled same-origin assets」，需同步更新。
3. `app/scripts/smoke-app/smoke-web.cjs` 建议加一条断言：广告脚本加载失败时页面主体仍可用（不能被广告阻塞）。
4. 若广告脚本在离线/被拦截时抛错，必须捕获，不能影响存档解析主流程。

### 5.4 桌面端（路径 C）

**已有机制，无需新造：** `app/src/main/app/lifecycle.ts` 的 `attachExternalLinkHandlers` 会把 renderer 里的 `window.open("http(s)://…")` 转交 `shell.openExternal` 打开系统浏览器，并 `deny` Electron 新窗口。

- **最小改动**：renderer 里 `window.open(SPONSOR_URL)`，URL 常量集中在 `app/shared/` 管理。
- **更稳做法**：新增 `sponsor:open` 类 IPC，URL 白名单固定在主进程，避免 renderer 能打开任意地址。按 `AGENTS.md` 的分层契约改三处：`app/shared/ipc.ts` + `app/src/main/ipc/registerIpc.ts` + `app/src/preload/`，并补 `app/test/ipc/channels.test.ts`。
- **保持不动**：`app/src/renderer/index.html` 的 CSP（`script-src 'self'`）。**不要为了在应用内渲染第三方广告去放开它**——放开之后既没有合规广告可填，又永久降低了渲染进程的安全边界。

### 5.5 用户体验硬约束

| 约束 | 说明 |
| --- | --- |
| 不遮挡 | 不覆盖数据表、不盖住悬浮窗内容 |
| 不打断 | 无弹窗、无自动播放、无声音 |
| 可永久关闭 | 偏好写入 `config.json`（走现有 `configPatch` 校验链路），关闭后不再出现 |
| 零布局抖动 | 广告位预留固定高度，避免 CLS |
| 不拖性能 | 项目有 `pnpm bench` / `docs/BENCHMARKS.md`，改动后需复核基线 |
| 悬浮窗豁免 | `#overlay` 窗口永不展示推广内容 |

### 5.6 分层约束

`app/src/core/` **禁止**引入 Electron、`node:fs`、`fetch`、React。广告相关逻辑只能落在 `main/`（网络、外链）与 `renderer/`（展示）。若需要「当前是否显示广告位」的纯逻辑判断，可放 `core/`，但不得触发任何 I/O。

---

## 6. 隐私与法律

1. **隐私政策**至少包含：广告合作伙伴名称、cookie / 本地存储用途、个性化广告说明、退出方式（Google Ads Settings、aboutads.info、youronlinechoices.com）。
2. **EEA / UK / CH**：必须接 Google 认证 CMP 并产出合法 TC string（TCF v2.3），否则只有 Limited Ads。
3. **CCPA / CPRA（加州）**：需要「Do Not Sell or Share My Personal Information」入口，并支持 Global Privacy Control。
4. **标注要求**：任何推广内容必须明确标注「广告 / 赞助」，且不得伪装成功能按钮或导航项。
5. **数据最小化**：绝不向广告方传递存档、背包、Steam 账号或市场数据。广告脚本应独立于应用数据流。
6. **应用内变更披露**：README、官网、以及应用内（设置页）都应说明引入了广告，并给出关闭方式。

---

## 7. 指标与灰度

- **北极星不要只用广告收入**，要用「广告收入 / 卸载率 / 次日留存」组合。真正的风险不是赚得少，而是流失。
- **埋点是第二笔信任成本**。若为优化广告位而引入分析脚本，等于再破坏一次「无遥测」承诺。优先方案：只用联盟后台数据，或自托管极简计数。
- **灰度与开关**：复用项目已有的官网 manifest 机制做远端开关，配合 `config.json` 本地开关，保证可一键关停。
- **A/B 范围**：只在官网层面做；**不要**在应用内 A/B 影响核心流程（rate、inventory、boxTimer）。

---

## 8. 收益现实预期

以下是**量级估算框架，不是承诺**：

| 假设 | 取值 |
| --- | --- |
| 展示广告的页面 | 站点根（网页版五页应用：Home / Inventory / Chests / Lookup / Trading） |
| 月 PV 量级 | 低（小众游戏伴侣工具，非内容站） |
| 广告可见率 | ~50% |
| 工具类站点 RPM | 个位数美元 / 千次曝光量级 |

→ **月收入量级：个位数到几十美元。** 桌面版用户再多也不产生广告曝光，因为广告在网页上。

同等投入下回报更好的方向：

| 方向 | 说明 |
| --- | --- |
| GitHub Sponsors | 面向开源使用者，零第三方请求 |
| Buy Me a Coffee | **桌面版工具栏已有入口**（`app/src/renderer/components/AppToolbar.tsx` → `externalLinks.ts` 的 `BUYMEACOFFEE_URL`）；站点根现为真应用，若要在网页端强化需在壳内加入口 |
| 高级版一次性买断 | 需区分免费/付费功能边界，注意 MIT 与社区观感 |
| Steam 生态推广 | 与游戏方谈官方推广位，比第三方联盟更可持续 |

**结论：以「补贴域名 / 签名 / 服务器成本」为目标合理；以「养项目」为目标不现实。**

---

## 9. 上线前检查清单

| 项 | 检查方式 |
| --- | --- |
| 断网可用 | 断网启动，核心功能（rate / inventory / boxTimer）完全正常 |
| 广告脚本失败可用 | 用广告拦截器 + 改 hosts 屏蔽广告域名，应用与网页版主体功能不受影响 |
| 无阻塞渲染 | 广告位预留固定高度，无 CLS 抖动 |
| 不遮挡核心数据 | 逐标签页检查：概览、背包、宝箱、图鉴、悬浮窗 |
| 可关闭且被记住 | 关闭后重启应用，广告位不再出现（`config.json` 已持久化） |
| 悬浮窗无推广 | 切到 `#overlay`，确认无任何广告/赞助元素 |
| CSP 一致 | `dist-web/index.html` 与 `app/src/web/index.html` 的 CSP 与实际请求一致 |
| 隐私政策可访问 | 页脚链接可达，内容与已接入的实际第三方一致 |
| 文档已同步 | `docs/DEPLOY-WEB.md` §5、`docs/BUSINESS-FLOWS.md`（新增章节）、`README` 均已更新 |
| 性能未回退 | `pnpm bench:ci` 对比基线无显著劣化 |
| 全量门禁 | `pnpm qa` 全绿 |

---

## 10. 与项目文档规范的衔接

一旦决定实施，以下文档必须**在同一个 PR 内**同步：

| 文档 | 需要做的改动 |
| --- | --- |
| `docs/BUSINESS-FLOWS.md` | 章节索引登记 **§26 广告/赞助投放**（下一个可用编号，不重排已有编号） |
| `docs/business-flows/14-ad-serving.md` | 新建：数据流图、错误处理路径（脚本失败/被拦截/离线）、关键文件路径速查 |
| `docs/DEPLOY-WEB.md` §5 | 改写「无遥测 / 无第三方请求」检查项 |
| `docs/business-flows/01-startup-and-config.md` | 新增广告开关配置项 → 更新 §2 配置加载与 configPatch |
| `app/test/ipc/channels.test.ts` | 若新增 IPC 通道，必须补测试 |
| `README.md` / `README.en.md` | 披露变现方式与关闭方式 |
| `AGENTS.md` | 若新增交付物（如隐私政策页），补充到文档索引 |

---

## 11. 参考来源

- Google AdSense 广告展示位置政策（软件应用条款）：https://support.google.com/adsense/answer/1346295
- Google AdSense 计划政策（总则，含软件应用与流量来源）：https://support.google.com/adsense/topic/1261918
- Microsoft Advertising SDK for UWP 关停通知（2020-06-01）：https://learn.microsoft.com/windows/uwp/monetize/
- GitHub 附加产品条款（Pages 与变现边界）：https://docs.github.com/en/site-policy/github-additional-product-terms
- Google EU User Consent Policy 与认证 CMP 要求（TCF v2.3，2026-02-28 死线）
- 项目内部：`docs/DEPLOY-WEB.md`、`docs/ARCHITECTURE.md`、`AGENTS.md`、`app/src/main/app/lifecycle.ts`

---

## 附：待你拍板的三个问题

1. **IP 风险**：是否已确认游戏方对 fan tool 商业化的态度？拿不到明确态度时，是否接受只走捐赠 + 自营赞助（不加广告联盟）？
2. **定位**：是否接受「无遥测、无第三方请求」这一卖点被改写？如果不接受，只剩路径 A（纯静态自营赞助）。
3. **目标**：是补贴成本（个位数到几十美元/月足够），还是期望形成收入？若是后者，广告不是合适的工具，应重新设计付费模型。
