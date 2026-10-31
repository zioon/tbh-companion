#!/usr/bin/env node
/**
 * Dev launcher with automatic recovery for a Chromium that dies during startup.
 *
 * Symptom: the dev server comes up, "starting electron app..." is printed, and then
 * Electron goes away - either with exit code 2147483651 (0x80000003 STATUS_BREAKPOINT)
 * or with exit code 0 after Chromium fails to create its single-instance lock file
 * ("process_singleton_win.cc: Lock file can not be created! Error code: 5").
 *
 * Both are environment problems, not repository problems: a trivial Electron app and
 * older packaged builds fail the same way on such machines. What we can fix from
 * here, in order:
 *
 *   1. Chromium's sandbox cannot initialise. electron-vite maps NO_SANDBOX=1 to
 *      --no-sandbox, so the retry disables it.
 *   2. Chromium cannot create its lock file in the app's userData dir. The retry uses
 *      a throwaway --user-data-dir that is deliberately NOT in %TEMP% (that folder is
 *      where Chromium/esbuild hand files to each other, and it is where endpoint
 *      security software tends to interfere).
 *   3. A corrupt Chromium cache in the userData dir. The retry renames the
 *      regenerable cache folders aside (the app's own JSON state is untouched) and
 *      starts again.
 *
 * "Success" is decided by whether the app's main process actually ran: Electron can
 * exit 0 without the app ever starting, so we compare the app log's timestamp before
 * and after each attempt instead of trusting the exit code.
 *
 * `pnpm dev:raw` runs electron-vite directly, with no recovery.
 * See docs/agent/WINDOWS.md for the permanent machine-side fix.
 */
import { spawn } from "node:child_process";
import { existsSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Pure browser caches: Chromium regenerates these, the app keeps no state in them.
// A corrupt one of them makes Chromium CHECK-fail during startup, before the app's
// main script runs, so it has to be movable to recover.
const REGENERABLE_CACHES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "blob_storage",
  "Local State",
];

function resolveCli() {
  try {
    return join(dirname(require.resolve("electron-vite/package.json")), "bin", "electron-vite.js");
  } catch {
    return join(appRoot, "node_modules", "electron-vite", "bin", "electron-vite.js");
  }
}

function userDataDir() {
  if (process.platform !== "win32") return null;
  const appName = require(join(appRoot, "package.json")).name;
  const base = process.env.APPDATA;
  return base ? join(base, appName) : null;
}

/**
 * Timestamp of the app's main-process log, used to tell "app ran" from "Electron died".
 *
 * The app writes logs/app.log (DIAGNOSTIC_LOG_FILE in app/src/main/log.ts);
 * logs/main.log is the legacy electron-log default that older builds still use.
 * Watch BOTH - watching only main.log never notices a current build starting.
 */
function appLogStamp() {
  const dir = userDataDir();
  if (!dir) return 0;
  let newest = 0;
  for (const name of ["app.log", "main.log"]) {
    try {
      newest = Math.max(newest, statSync(join(dir, "logs", name)).mtimeMs);
    } catch {
      // A log file that does not exist yet is simply not evidence either way.
    }
  }
  return newest;
}

/**
 * The main process prints this the moment it is up
 * (app/src/main/index.ts: `appLog.info(\`TBH Companion v${appVersion()} ready\`)`).
 * It is the only start signal that does NOT depend on the app being able to
 * WRITE its log file - when endpoint security or a sandbox filters the
 * Electron child process the log transport fails with EPERM, and a purely
 * file-based check then reports a false negative even though the app started.
 */
const READY_MARKER = /TBH Companion v\S+ ready/;

function runDev(extraEnv, extraArgs) {
  return new Promise((resolve) => {
    // Extra Chromium switches are passed through electron-vite's own `--`
    // passthrough. Setting ELECTRON_CLI_ARGS in the environment does NOT work:
    // electron-vite's CLI rewrites that variable from its own `--` arguments,
    // so the value is replaced before Electron is spawned.
    const args = [resolveCli(), "dev"];
    if (extraArgs && extraArgs.length > 0) args.push("--", ...extraArgs);
    // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave like plain Node:
    // `require("electron")` then returns the path to the executable instead of
    // the Electron API, so the main process dies on its first `electron.app`
    // call ("TypeError: Cannot read properties of undefined"). Nothing wants
    // that flag when launching the app - it only exists so tooling can reuse
    // the Electron binary as a Node runtime - and some harnesses/IDEs export it
    // globally. Drop it for the child process.
    const env = { ...process.env, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, args, {
      // stdout is piped rather than inherited so the marker can be recognised;
      // it is forwarded to the parent unchanged, so the dev output is the same.
      stdio: ["inherit", "pipe", "inherit"],
      env,
    });
    let sawReady = false;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (READY_MARKER.test(text)) sawReady = true;
      process.stdout.write(text);
    });
    child.on("exit", (code, signal) => resolve({ code: code ?? 0, signal, sawReady }));
    child.on("error", (err) => {
      console.error(`[dev] could not start electron-vite: ${err.message}`);
      resolve({ code: 1, signal: null, sawReady: false });
    });
  });
}

function announce(lines) {
  console.warn(["", ...lines.map((line) => `      ${line}`), ""].join("\n"));
}

function resetCaches(dir) {
  const moved = [];
  for (const name of REGENERABLE_CACHES) {
    const target = join(dir, name);
    try {
      if (!existsSync(target)) continue;
      renameSync(target, `${target}.stale-${Date.now()}`);
      moved.push(name);
    } catch {
      // A cache we cannot move is not fatal - Electron simply reuses it.
    }
  }
  return moved;
}

// A throwaway profile that lives outside %TEMP%: Chromium hands files to itself
// through that folder, so keeping the profile elsewhere sidesteps whatever blocks
// it there.
const throwawayProfile = join(appRoot, "node_modules", ".cache", "tbh-companion-dev-profile");

const results = [];

async function attemptDev(label, extraEnv, extraArgs) {
  const before = appLogStamp();
  const result = await runDev(extraEnv, extraArgs);
  const after = appLogStamp();
  // Either signal proves the main process booted: the app log advanced, or the
  // app announced itself on stdout. The stdout marker matters because the log
  // file may be unwritable (EPERM) on a filtered machine.
  const appRan = after > before || result.sawReady;
  results.push({ label, code: result.code, appRan });
  console.log(
    `[dev] attempt ${results.length} (${label}) exited with code ${result.code}` +
      ` - app main process ${appRan ? "started" : "did NOT start"}`,
  );
  return appRan;
}

if (await attemptDev("default", {})) process.exit(0);

announce([
  "The app's main process never started.",
  "Electron either died with 2147483651 (0x80000003 STATUS_BREAKPOINT) or Chromium",
  "could not create its single-instance lock file. Both are environment problems",
  "(sandbox init, or file creation being blocked), not repository problems.",
  "",
  "Retrying with --no-sandbox.",
]);
if (await attemptDev("no-sandbox", { NO_SANDBOX: "1" })) process.exit(0);

announce([
  "Still not running. Retrying with a throwaway --user-data-dir outside %TEMP%:",
  `  ${throwawayProfile}`,
]);
if (
  await attemptDev("no-sandbox + throwaway profile", { NO_SANDBOX: "1" }, [
    `--user-data-dir=${throwawayProfile}`,
  ])
) {
  process.exit(0);
}

const dir = userDataDir();
if (dir) {
  const moved = resetCaches(dir);
  if (moved.length > 0) {
    announce([
      `Moved the regenerable Chromium caches aside in ${dir}:`,
      ...moved.map((name) => `  - ${name}`),
      "Retrying with the real profile.",
    ]);
    if (await attemptDev("no-sandbox + reset caches", { NO_SANDBOX: "1" })) process.exit(0);
  }
}

const appName = require(join(appRoot, "package.json")).name;
const electronExe = join(appRoot, "node_modules", "electron", "dist", "electron.exe");

announce([
  "The app still does not start. Attempts made:",
  ...results.map((r) => `  - ${r.label}: exit ${r.code}, app started: ${r.appRan}`),
  "",
  "Chromium cannot create the files it needs (its single-instance lock file), so",
  "Electron starts, the app's requestSingleInstanceLock() fails and the app quits",
  "silently with exit code 0. File operations succeed from PowerShell but fail",
  "inside the Electron child process - that is the signature of endpoint security",
  "software filtering child processes (Defender real-time protection is the usual",
  "suspect).",
  "",
  "A/B test it - in an ELEVATED PowerShell:",
  "",
  "  Set-MpPreference -DisableRealtimeMonitoring $true",
  '  # run "pnpm dev" in another terminal - does the window appear?',
  "  Set-MpPreference -DisableRealtimeMonitoring $false",
  "",
  "If it does, make it permanent:",
  "",
  '  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\Temp"',
  '  Add-MpPreference -ExclusionPath "$env:APPDATA\\' + appName + '"',
  '  Add-MpPreference -ExclusionProcess "' + electronExe + '"',
  "",
  'Other machine-side option: turn off "内存完整性 / Memory integrity" under',
  "Windows 安全中心 → 设备安全性 → 内核隔离, then reboot.",
  "Full notes: docs/agent/WINDOWS.md",
]);
process.exit(results[results.length - 1].code || 1);
