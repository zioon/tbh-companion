// Copy bundled item icons into the web build output.
//
// The desktop build ships `data/icons/*.png` as Electron `extraResources` and
// serves them through the `tbh-asset://` protocol. A browser has no such
// protocol, so the web build serves the same PNGs as ordinary static files.
//
// Icons are tiny (364 files, ~0.1 MB total; largest is 1.3 KB), so shipping the
// whole set costs nothing next to the 3.4 MB JS bundle.
//
// Run after `vite build --config vite.web.config.ts` (wired into `build:web`).
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..");

const source = resolve(repoRoot, "data", "icons");
const outDir = resolve(repoRoot, "dist-web", "icons");

if (!existsSync(source)) {
  console.error(`[web-icons] FAIL: missing icon source directory at ${source}`);
  process.exit(1);
}

if (!existsSync(resolve(repoRoot, "dist-web"))) {
  console.error(`[web-icons] FAIL: dist-web/ not found — run the vite build first.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
cpSync(source, outDir, { recursive: true });

const count = readdirSync(outDir).filter((name) => name.endsWith(".png")).length;
if (count === 0) {
  console.error(`[web-icons] FAIL: no PNG icons copied to ${outDir}`);
  process.exit(1);
}

console.log(`[web-icons] Copied ${count} icon(s) to ${outDir}`);
