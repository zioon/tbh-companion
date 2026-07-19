#!/usr/bin/env node
/**
 * 一键同步 locale 翻译到游戏 bundle。
 *
 * 需要游戏装在默认路径（SteamLibrary），否则先手动跑
 * `python scripts/dump_game_locale.py` 并在 `scripts/sync_common_with_game.py`
 * 中调整 GAME_DIR。
 *
 * 用法：
 *   cd app && pnpm sync-locale
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(label, cmd) {
  console.log(`\n=== ${label} ===`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

run("Dump game locale", "python scripts/dump_game_locale.py");
run("Sync common.json", "python scripts/sync_common_with_game.py");

console.log("\n\u2705 Done. 用 `git diff` 确认变更后提交。");
