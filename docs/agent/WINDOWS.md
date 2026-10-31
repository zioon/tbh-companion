# Windows development environment

This project is developed and run on **Windows + PowerShell**. When something behaves oddly, suspect the environment (encoding, paths, line endings, file locking, shell) **before** assuming a logic bug — several "bugs" here turned out to be Windows/PowerShell quirks.

## JSON must be BOM-free

PowerShell 5.1 `Set-Content -Encoding UTF8` writes a UTF-8 **BOM** that breaks `JSON.parse` ("Unexpected token '\uFEFF'"). This silently broke the bundled `data/*.json` catalogs. To write JSON use Node `fs.writeFileSync`, or `[System.IO.File]::WriteAllText($p,$txt,(New-Object System.Text.UTF8Encoding($false)))`. Readers strip a leading BOM defensively, but don't rely on it.

## Shell is PowerShell, not bash

- Chain commands with `;` (not `&&`).
- Quote paths with spaces (the repo path has one).
- Heredocs don't work — pass commit messages with multiple `-m` flags.

## Invoke-WebRequest

Hangs/parses slowly on large HTML in PS 5.1 (legacy DOM parsing). Always pass `-UseBasicParsing`.

## Save file locking

The save file is locked / atomically rewritten by the game while playing. Reads can hit sharing violations or catch a mid-write (ciphertext length not % 16) — retry briefly and treat as transient (see `readBytesShared`).

## Paths

- Game save: `%USERPROFILE%\AppData\LocalLow\...`
- App `userData`: `%APPDATA%`
- Expand env vars (`expandPath`); never hard-code a home dir.

## Line endings

Keep files LF; avoid tools that rewrite to CRLF.

## Electron binary

If `pnpm install` doesn't fetch it (some sandboxes block the postinstall extraction), run `node node_modules/electron/install.js`, or download the matching `electron-v<ver>-win32-x64.zip` and extract it into `node_modules/electron/dist/` with `path.txt` containing `electron.exe`.

pnpm blocks dependency build/postinstall scripts by default — allow-listed packages live in `app/pnpm-workspace.yaml`'s `allowBuilds`; if a new dependency's script gets silently skipped, check the `pnpm install` output for "Ignored build scripts" and add it there (`pnpm approve-builds --all` writes the same file interactively).

## esbuild temp-file deletion fails on Windows

Symptom — `pnpm dev` / `pnpm build` dies right after Rollup prints its module count:

```
✗ Build failed in 4.08s
ERROR  [vite:esbuild-transpile] remove C:\Users\<you>\AppData\Local\Temp\esbuild-<64 hex chars>: Access is denied.
```

Cause: Vite's `vite:esbuild-transpile` plugin re-transforms every emitted chunk with
esbuild. esbuild's JS API hands a transform payload larger than **1 MiB** to its Go
service through a temp file (`%TEMP%\esbuild-<random hex>`) that the service deletes
right after reading it. On Windows a real-time scanner (Defender) can still hold that
fresh file open, `DeleteFile` returns `ERROR_ACCESS_DENIED`, and esbuild turns the
failed delete into a fatal transform error. The chunks that trip it here are the
main-process bundle (`out/main/index.js`, ~2 MB) and the renderer entry chunk
(~1.8 MB).

Fix in this repo: `app/patches/esbuild@0.28.1.patch` (wired through
`patchedDependencies` in `app/pnpm-workspace.yaml`) raises esbuild's inline-payload
limit from 1 MiB to 64 MiB, so big chunks travel over the stdio protocol and no temp
file is created at all. Upstream issue (still open): https://github.com/evanw/esbuild/issues/4559

Machine-level alternative — fixes every tool on the box, not just this build. Run in
an **elevated** PowerShell:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Temp"   # or -ExclusionProcess for node.exe / esbuild.exe
```

Notes:

- `ESBUILD_BINARY_PATH` does **not** help — it only selects which executable is spawned.
- Moving `%TEMP%` does **not** help — the path travels from Node to the Go service.
- Leftover `esbuild-<hex>` files in `%TEMP%` are harmless; delete them any time.
- After upgrading esbuild, re-apply the patch:
  `pnpm patch esbuild@<version> --edit-dir .pnpm-patch/esbuild` then
  `pnpm patch-commit .pnpm-patch/esbuild`.

## Electron dies at startup with exit code 2147483651

Symptom — the dev server comes up fine, then Electron never shows a window:

```
dev server running for the electron renderer process at:
  ➜  Local:   http://localhost:5173/
starting electron app...
[ELIFECYCLE] Command failed with exit code 2147483651.
```

2147483651 = `0x80000003` = STATUS_BREAKPOINT. Electron raises it from a Chromium
CHECK, and on Windows the one that fires before anything is logged is the **sandbox
initialisation** failing. Tells:

- `electron.exe --version` crashes with the same code, while
  `electron.exe --version --no-sandbox` prints the version — the binary is fine, the
  sandbox cannot start.
- `--disable-gpu`, `--disable-gpu-sandbox` and `--in-process-gpu` do **not** help;
  only `--no-sandbox` does.
- A different `--user-data-dir` does not help either — it is not the app's userData.

Machine suspects: VBS / Memory integrity (HVCI) with code-integrity enforcement, or a
half-finished Windows update. Check `Get-CimInstance -Namespace
root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard` —
`VirtualizationBasedSecurityStatus = 2` means VBS is running.

Workarounds:

- **Dev: automatic.** `pnpm dev` runs through `scripts/dev.mjs`. If Electron dies
  with exactly 2147483651 it retries automatically — first with `--no-sandbox`
  (electron-vite maps `NO_SANDBOX=1` to it), then with a throwaway
  `--user-data-dir` in case the single-instance lock is the problem. Each retry
  prints why. `pnpm dev:raw` runs electron-vite directly, with no fallback.
  Two details the launcher has to get right, both learned the hard way:
  - The throwaway `--user-data-dir` must be passed through electron-vite's own
    `--` passthrough (`electron-vite dev -- --user-data-dir=…`). Setting
    `ELECTRON_CLI_ARGS` in the environment does **not** work: electron-vite's CLI
    rewrites that variable from its own `--` arguments, so the value is
    replaced before Electron is spawned and the profile is never used.
  - "Did the app start?" is answered from the log file **and** from the main
    process' own stdout line `TBH Companion v<version> ready`. The log file to
    watch is `logs/app.log` (`logs/main.log` is the legacy name older builds
    used); the stdout marker is what makes the check work when the log directory
    is not writable.
- Manual equivalent: `$env:NO_SANDBOX='1'; pnpm dev`.
- Shipped build: launch it with `--no-sandbox` as a stopgap, but fix the machine
  (turn off "内存完整性 / Memory integrity" under Windows 安全中心 → 设备安全性 →
  内核隔离, then reboot) before shipping to users — a sandbox failure kills the app
  with no message at all.

Tells that separate the causes:

- `electron.exe --version` crashing too → the sandbox cannot initialise.
- Only the app crashing, while `--version` is fine → the app's Chromium profile state
  in `%APPDATA%\tbh-companion` is corrupt. Chromium CHECK-fails while opening it and
  never reaches the app's main script, so the app writes no log at all. Fix: rename
  the regenerable profile state aside and retry:

  ```powershell
  $ud = "$env:APPDATA\tbh-companion"; $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  'Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache','blob_storage','Local State' |
    ForEach-Object { $p = Join-Path $ud $_; if (Test-Path $p) { Rename-Item $p "$_.stale-$stamp" } }
  ```

  These are Chromium caches and prefs - the app's own state lives in the JSON files
  next to them (`config.json`, `session_state.json`, prices, wish record, ...) and is
  untouched. `pnpm dev` does this automatically as its last fallback.

Windows also records the crash itself: `Application Error` event 1000 and
`Windows Error Reporting` event 1001 name the faulting module and the exception
code (`0xc0000005` ACCESS_VIOLATION or `0x80000003` STATUS_BREAKPOINT), and the
report archive under `C:\ProgramData\Microsoft\Windows\WER\ReportArchive` holds
the loaded-module list.

### Decisive A/B test: is it the endpoint security filter?

Everything Chromium does here is a plain file operation, yet the same operations
succeed from PowerShell and fail *inside* the Electron child process with
`ERROR_ACCESS_DENIED`. That asymmetry is the signature of a filter driver hooking
child processes (Defender real-time protection is the usual suspect) — the same thing
that breaks esbuild's temp-file handoff above.

Prove it in 30 seconds, in an **elevated** PowerShell:

```powershell
Set-MpPreference -DisableRealtimeMonitoring $true
# run "pnpm dev" in another terminal - does the window appear?
Set-MpPreference -DisableRealtimeMonitoring $false
```

If the window appears with real-time protection off, make it permanent:

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Temp"
Add-MpPreference -ExclusionPath "$env:APPDATA\tbh-companion"
Add-MpPreference -ExclusionProcess "D:\Project\TBH\tbh-companion\app\node_modules\electron\dist\electron.exe"
```

The other machine-side option is to turn off "内存完整性 / Memory integrity"
(Windows 安全中心 → 设备安全性 → 内核隔离) and reboot: the Code Integrity log shows
the "Virtualization Based Security Policy" being activated at boot, and that lines up
with the last time the app ran.

Note: `pnpm dev` decides success by whether the app's main process actually ran
(the app log's timestamp changes), not by the exit code — Electron can exit 0 without
the app ever starting.

Note: `pnpm qa:dev` does **not** catch this — it only scans the log for build errors
and probes Vite, so it reports "passed" even when Electron dies immediately. Always
confirm the window manually after touching `main/` or `preload/`.

## Big numbers

Save ids like `UniqueId` exceed JS safe-integer range and collide after `JSON.parse`; parse losslessly (string/bigint) if you must use them. (Not Windows-specific, but a recurring "why don't these match" trap.)

## PR bodies on PowerShell

Never use inline `gh pr create --body "..."` — see [PULL-REQUEST.md](PULL-REQUEST.md).

## Low mandatory level 标签（进程完整性级别）

**症状一**：游戏明明在跑，助手却报「找不到游戏进程」——实时数据永久停在「等待游戏启动」，`main.log` 里只有 `attach: game process not found`。

**症状二**：日志写不进去，`logs/app.log` 报 `EPERM: operation not permitted`。

**症状三**：`pnpm dev` 需要 `--no-sandbox` 才能起来（`scripts/dev.mjs` 会自动兜底）。

**根因**：程序所在目录被打了 **"Low mandatory level"** 强制级别标签。从这里启动的 Electron 及其**全部子进程**（含 live-memory worker、inventory worker、它们 spawn 出来的 node/powershell）都以 **Low 完整性级别（S-1-16-4096）** 运行。Windows 会因此：

- 过滤低完整性调用方看到的进程列表 → 游戏进程「不存在」；
- 拒绝 `OpenProcess` 更高完整性级别的目标 → 即使知道 PID 也打不开；
- 拒绝写入 Medium 级别的 `%APPDATA%` → 日志 EPERM；
- 让 Chromium 沙箱初始化失败 → `0x80000003` 启动崩溃。

**排查三步**：

```powershell
whoami /groups | Select-String 'Mandatory'      # Medium=8192(0x2000) / Low=4096(0x1000)
icacls "<程序目录>" | Select-String 'Mandatory'   # 有 Low 标签就是它
icacls "D:\Project\TBH\tbh-companion"            # 父目录没有标签、只有仓库根有 → 标签是后加的
```

**修复**（改标签必须**管理员**权限，普通权限会 `Access is denied`）：

```powershell
icacls "<程序目录>" /setintegritylevel (OI)(CI)M
```

- 只改**根目录**即可：子目录的标签是继承来的（`icacls` 输出里的 `(I)`），根目录一改就级联生效；先验证 `icacls <程序目录>\node_modules\electron\dist\electron.exe` 是否已变成 Medium。
- 复制到别处也会重算标签（目标目录默认 Medium），可作为临时绕过。
- 改完**必须重启助手**——完整性级别在进程启动时确定。
- PowerShell 里 `(OI)(CI)M` 必须加引号，否则被当成表达式解析：`icacls "<path>" /setintegritylevel "(OI)(CI)M"`。

**为什么仓库里会出现这个标签**：仓库目录多是从下载的压缩包解压/复制而来，Windows 会把这类来源的文件标成 Low 并向下继承。`icacls <path> /reset` **不会**清除强制级别标签（它只重置 DACL），必须用 `/setintegritylevel`。

助手现在会自己做这个自检：检测到 Low 完整性级别时，实时状态徽章会显示「实时：权限不足」而不是「等待游戏启动」，日志里也会写明 `attach blocker: companion runs at low integrity`。