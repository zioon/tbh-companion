# 网页版部署与域名关联

`pnpm build:web` 产出的 `dist-web/` 是一份纯静态站点（无服务端、无 Node 依赖），可以托管在任何静态托管平台上。本文覆盖两种发布路径：

- **方案 A（推荐，已有流水线）**：挂到官网 `website/` 的子路径，随 GitHub Pages 一起发布。
- **方案 B**：独立托管（Cloudflare Pages / Netlify / Vercel / 自建 Nginx）。

两种方案都不需要改 `vite.web.config.ts` —— 构建用的是 `base: "./"`（相对路径），产物放在根目录或任意子路径都能正确加载资源。

---

## 1. 构建产物

```bash
cd app
pnpm build:web
```

产物落在**仓库根** `dist-web/`：

| 内容 | 大小 | 说明 |
| --- | --- | --- |
| `index.html` | 1.14 kB | 单页入口 |
| `assets/index-*.js` | 3.39 MB（gzip 489 kB） | 全部逻辑 + `lookup_items` / `gamedata` / 四语言 locale 内联 |
| `assets/index-*.css` | 10.3 kB（gzip 2.9 kB） | |
| `assets/*.wav` | 约 3.6 MB | 通知音效（网页版不会用到，可删） |
| `icons/*.png` | 364 个，约 0.1 MB | 物品图标（`copy-web-icons.mjs` 构建后复制） |

> **`icons/` 是必需的。** 桌面版通过自定义协议 `tbh-asset://icon/<name>` 提供图标，浏览器无法解析该 scheme。`vite.web.config.ts` 里的 `tbh-browser-safe-core` 插件把 `renderer/lib/iconSrc` 换成 `src/web/iconSrcWeb.ts`，后者返回 `<base>/icons/<name>.png`。`app/scripts/smoke-app/smoke-web.cjs` 会断言图标 `naturalWidth > 0`（非 broken image），缺了这一步回归会在 CI 里失败。

构建后本地冒烟：

```bash
cd app
pnpm preview:web     # vite preview，起本地静态服务
pnpm smoke:web       # Electron + Chromium 端到端：拖入真实存档 → 断言背包表渲染 + 图标解码
```

`smoke:web` 会读取 `%USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskBarHero\` 下最新的 `.es3` 存档。

---

## 2. 方案 A：挂到官网子路径（推荐）

官网落地页由 `.github/workflows/pages.yml` 发布，该工作流把 **`website/` 目录**上传为 Pages 产物。因此把网页版放进 `website/inspector/` 即可一起上线。

### 2.1 一次性改造

在 `pages.yml` 的 checkout 之后、`upload-pages-artifact` 之前插入构建步骤：

```yaml
      - uses: actions/checkout@v5

      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: app/pnpm-lock.yaml

      - name: Build web inspector
        working-directory: app
        run: |
          pnpm install --frozen-lockfile
          pnpm build:web          # -> <repo root>/dist-web

      # dist-web 构建在仓库根，拷进 website/ 后随 artifact 一起上传
      - name: Stage inspector into website/
        run: |
          rm -rf website/inspector
          mkdir -p website/inspector
          cp -r dist-web/. website/inspector/
          rm -f website/inspector/assets/*.wav   # 网页版不用音效，省 3.6 MB

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v3
        with:
          path: website
```

同时把触发路径补上 app 源码与构建脚本，否则改了前端不会重新发布：

```yaml
    paths:
      - "website/**"
      - "app/src/**"
      - "app/shared/**"
      - "app/scripts/copy-web-icons.mjs"
      - "app/vite.web.config.ts"
      - "app/package.json"
      - "data/icons/**"
      - ".github/workflows/pages.yml"
```

### 2.2 官网加一个入口

`website/index.html` 里的下载按钮旁边（或 `hero-download` 区块）加链接：

```html
<a class="btn btn-secondary" href="./inspector/">Try the web save inspector</a>
```

相对路径 `./inspector/` 在 `https://<user>.github.io/<repo>/` 和自定义域名下都成立。

上线后地址为：

```
https://<user>.github.io/<repo>/inspector/
```

### 2.3 `dist-web/` 是否提交进仓库

**不提交。** 该目录目前未被 `.gitignore` 覆盖（`git status` 里是 untracked），建议显式忽略，产物一律由 CI 构建：

```gitignore
# web inspector build output — produced by `pnpm build:web`, staged into
# website/inspector/ by the Pages workflow
dist-web/
website/inspector/
```

---

## 3. 方案 B：独立托管

若不想和官网耦合，直接部署 `dist-web/` 到独立域名。

### 3.1 Cloudflare Pages

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，选本仓库。
2. 构建设置：
   - **Root directory**：`app`
   - **Build command**：`pnpm install --frozen-lockfile && pnpm build:web`
   - **Build output directory**：`../dist-web`
3. Save and Deploy。

> Pages 的构建容器已带 pnpm；若报找不到 pnpm，把 build command 换成 `corepack enable && pnpm install --frozen-lockfile && pnpm build:web`。

### 3.2 Netlify

`netlify.toml`（放仓库根）：

```toml
[build]
  base    = "app"
  command = "pnpm install --frozen-lockfile && pnpm build:web"
  publish = "../dist-web"

[build.environment]
  NODE_VERSION = "22"
```

或 UI 里填同样的三项。

### 3.3 Vercel

`vercel.json`（放仓库根）：

```json
{
  "buildCommand": "cd app && pnpm install --frozen-lockfile && pnpm build:web",
  "outputDirectory": "dist-web",
  "installCommand": "echo skip"
}
```

### 3.4 自建 Nginx

```bash
# 本机构建后上传
cd app && pnpm build:web
rsync -av --delete dist-web/ user@host:/var/www/tbh-inspector/
```

`/etc/nginx/sites-available/tbh-inspector`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name inspector.example.com;
    root /var/www/tbh-inspector;
    index index.html;

    # 单页应用：任何未命中的路径都回落到 index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite 产物带内容哈希，可长期强缓存
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # 图标文件名固定，但内容随游戏版本变；用较短缓存
    location /icons/ {
        expires 7d;
        add_header Cache-Control "public";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
```

HTTPS 用 certbot：

```bash
sudo certbot --nginx -d inspector.example.com
```

---

## 4. 关联域名

### 4.1 GitHub Pages 自定义域名

以方案 A（Pages）为例。假设目标是 `tbh.example.com`。

**第 1 步：仓库设置里填域名**

Settings → Pages → **Custom domain** → 填 `tbh.example.com` → Save。

这会自动往仓库写入/更新 `CNAME` 文件。**但 Pages 部署的是 `website/` 目录**，所以 `CNAME` 必须出现在 `website/CNAME`（artifact 根），而不是仓库根：

```bash
echo "tbh.example.com" > website/CNAME
git add website/CNAME && git commit -m "chore(pages): set custom domain"
```

> 若在 Settings 里填了域名后 `website/CNAME` 没有自动生成，手动补上即可 —— Pages 只认 artifact 根目录下的 `CNAME`。

**第 2 步：配 DNS 记录**

在域名服务商处按主机名类型选择：

**子域名（`tbh.example.com`）— 推荐**，用 CNAME：

| 类型 | 主机记录 | 记录值 | TTL |
| --- | --- | --- | --- |
| CNAME | `tbh` | `<user>.github.io` | 3600 |

**裸域 / apex（`example.com`）**，用 4 条 A + 4 条 AAAA：

| 类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |

> **不要**给 apex 配 `CNAME` 到 `<user>.github.io` —— 部分服务商支持 CNAME flattening，但行为不一致，用上面这组固定 IP 最稳。这组 IP 由 GitHub 官方文档给出，变更概率极低。
>
> **不要**额外加 `www` 的 A 记录指向 GitHub IP；如果想让 `www` 也生效，加一条 `CNAME www -> <user>.github.io`，然后在 Pages 设置里把 `www.example.com` 填成自定义域名（GitHub 会自动把另一个方向做 301 跳转）。

**第 3 步：等 DNS 生效**

```bash
# 换成你的域名
nslookup tbh.example.com
dig +short tbh.example.com
```

CNAME 生效后回 Settings → Pages，Custom domain 旁的检查会变成绿色勾。

**第 4 步：开启 Enforce HTTPS**

Settings → Pages → 勾选 **Enforce HTTPS**。

首次签发 Let's Encrypt 证书需要几分钟到 24 小时不等（DNS 传播 + GitHub 的签发队列）。证书签发完成前该复选框会置灰，等待即可。开启后 HTTP 会 301 跳转到 HTTPS。

**第 5 步：验证**

```bash
curl -sI https://tbh.example.com/           | head -1   # 200
curl -sI http://tbh.example.com/            | head -1   # 301 -> https
curl -sI https://tbh.example.com/inspector/ | head -1   # 200（方案 A）
```

### 4.2 Cloudflare Pages / Netlify / Vercel 的自定义域名

三家都是在控制台 **Custom domains** 里填域名，然后按提示配 DNS。共同点：

- 平台会给出一个可 CNAME 的目标（如 `<project>.pages.dev`、`<site>.netlify.app`、`cname.vercel-dns.com`）。
- **子域名**：CNAME 指向该目标。
- **apex**：Netlify / Vercel 支持 ALIAS/ANAME，或直接把 NS 托管到平台；Cloudflare Pages 建议把域名的 NS 转到 Cloudflare（若域名已在 Cloudflare，直接加一条 CNAME 到 `<project>.pages.dev`，开启橙色云朵即代理模式）。
- HTTPS 由平台自动签发并续期，无需手动操作。

自建 Nginx 见 §3.4（certbot 自动续期，`systemctl status certbot.timer` 可查）。

### 4.3 如果域名已经挂在别处

同一时刻只能有一处解析生效。迁移时把旧记录删干净再配新记录；用 `dig +trace` 或 https://dnschecker.org 确认全球解析一致后再开 Enforce HTTPS。

---

## 5. 上线前检查清单

网页版把存档解密**完全放在浏览器内**（WebCrypto），文件不出本机。上线前逐项确认：

| 项 | 检查方式 |
| --- | --- |
| 图标正常显示 | 拖入存档，背包每行左侧有彩色图标框，无 broken image |
| 物品名本地化 | 切换语言后名称跟随变化（`getLookupCatalog` 按 `resolvedLanguage` 本地化） |
| CSP 允许同源图标 | `dist-web/index.html` 的 `img-src 'self' data:`；图标是同源 PNG，无需放开 `tbh-asset:` |
| Steam 查价显示为「未加载」 | 这是**预期行为**，不是 bug —— 浏览器无法调 Steam 市场接口（无 CORS），页面有说明文案 |
| 无遥测 | 全站无分析脚本，无第三方请求（Lucide 图标走 CDN 的只有官网落地页，网页版产物无外链） |
| 存档不外传 | DevTools → Network，拖入存档后不产生任何携带存档内容的请求 |
| 桌面版导流卡片 | 切到 Live tracking 标签，应显示「These features need the desktop app」三张卡片 |
| base 路径正确 | 子路径部署时 `view-source:` 里的资源引用为相对路径（`./assets/...`、`./icons/...`） |

---

## 6. 常见问题

**图标全部空白。**
`dist-web/icons/` 缺失或未随产物上传。确认构建跑了 `copy-web-icons.mjs`（输出 `[web-icons] Copied 364 icon(s)`），且部署时没有只传 `index.html` + `assets/`。

**资源 404（JS/CSS 加载不到）。**
产物被放到了与构建时不同的子路径，且部署工具重写了路径。检查构建实际上有没有用 `base: "./"`；若托管平台强制注入绝对路径，改用 `base: "/inspector/"` 重新构建。

**存档拖入后报解密失败。**
网页版用 `es3Web`（WebCrypto）而非桌面版的 `node:crypto`。两者契约由 `app/test/web/es3Parity.test.ts` 守卫 —— 若该测试通过而线上仍失败，多半是存档本身密码不同或文件损坏。

**自定义域名显示 404。**
`website/CNAME` 内容与所填域名不一致，或 artifact 根目录下没有 `CNAME`。Pages 只读 artifact 根。

**HTTPS 复选框一直是灰的。**
DNS 还没完全生效，或 apex 记录混用了 CNAME 与 A。等 DNS 全球一致后重试；必要时在 Settings 里先移除自定义域名再重新添加，强制 GitHub 重跑校验。

---

## 相关文档

- 构建脚本与 qa 命令：仓库根 [`AGENTS.md`](../AGENTS.md)
- 网页版与桌面版的数据流差异：[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
- Save 解密流程（含 `es3Web` 分支）：[`docs/BUSINESS-FLOWS.md`](BUSINESS-FLOWS.md) §3
