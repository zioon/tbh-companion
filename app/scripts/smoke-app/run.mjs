// Runs the web-build smoke test in a real Chromium.
//
// `ELECTRON_RUN_AS_NODE=1` is present in some CI/agent environments (including
// this project's Windows dev box). It makes any Electron binary behave as plain
// Node, so the app never starts and `require("electron")` returns undefined.
// The same variable silently breaks browser automation tools that wrap Chromium
// — pages load as `about:blank` with no error. Stripping it for the child
// process is what makes the smoke test (and any headless browser work) reliable.
//
// Requires `pnpm build:web` to have produced `dist-web/` first.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const repoRoot = resolve(appRoot, "..");

const distWeb = resolve(repoRoot, "dist-web");
if (!existsSync(distWeb)) {
  console.error(`dist-web/ not found at ${distWeb}\nRun \`pnpm build:web\` first.`);
  process.exit(1);
}

// electron ships a small JS shim that resolves the platform binary.
const electronBin = resolve(appRoot, "node_modules", "electron", "dist", "electron.exe");
const electronPosix = resolve(appRoot, "node_modules", "electron", "dist", "electron");
const bin = existsSync(electronBin) ? electronBin : electronPosix;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(bin, [here], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
