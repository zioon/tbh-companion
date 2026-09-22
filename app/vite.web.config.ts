import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Web build: compiles the renderer + core into a static bundle that runs in a
// plain browser (no Electron). Run with `pnpm build:web`.
//
// Two aliases make the shared source tree browser-safe without forking it:
//   * `core/es3` -> `core/es3Web`   node:crypto is replaced by WebCrypto, so the
//     decrypt API becomes async (the web save loader is async end to end).
//   * `bundledData` still imports `node:fs`, but the web entry installs an
//     in-memory source via `core/dataSource` before any read happens — the
//     `node:fs` import only needs to resolve, not run.
//
// Output goes to `dist-web/` at the repo root so the landing site can serve it
// under a subpath.

const appRoot = __dirname;

/**
 * Rewrite core module specifiers to their browser-safe counterparts.
 *
 * A plain `resolve.alias` entry cannot express this: the imports under `core/`
 * are relative ("./bundledData", "../es3"), so the same target is reached from
 * several depths. Resolving through the importer's directory catches them all.
 */
function browserSafeCoreModules(): Plugin {
  const normalize = (p: string): string => p.replace(/\\/g, "/");
  const coreDir = normalize(resolve(appRoot, "src/core"));
  const rendererLibDir = normalize(resolve(appRoot, "src/renderer/lib"));

  // Keyed by normalized absolute path (forward slashes) so the lookup below,
  // which builds a `/`-joined path, compares like with like on Windows.
  const swaps: Record<string, string> = {
    [`${coreDir}/bundledData.ts`]: normalize(resolve(coreDir, "bundledDataWeb.ts")),
    [`${coreDir}/es3.ts`]: normalize(resolve(coreDir, "es3Web.ts")),
    // `iconSrc` emits the desktop-only `tbh-asset://` scheme; the web version
    // points at static PNGs under `<base>/icons/`. Without this swap every item
    // icon in the inventory table renders as a broken image.
    [`${rendererLibDir}/iconSrc.ts`]: normalize(resolve(appRoot, "src/web/iconSrcWeb.ts")),
  };

  return {
    name: "tbh-browser-safe-core",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null;
      if (!/(?:^|\/)(?:core\/)?(?:bundledData|es3|iconSrc)$/.test(source)) return null;

      const importerDir = normalize(importer);
      const parts = importerDir.slice(0, importerDir.lastIndexOf("/")).split("/");
      for (const segment of source.split("/")) {
        if (segment === "..") parts.pop();
        else if (segment !== ".") parts.push(segment);
      }

      const swap = swaps[`${parts.join("/")}.ts`];
      if (swap) this.warn(`swapped ${source} -> ${swap.replace(appRoot, ".")}`);
      return swap ?? null;
    },
  };
}

export default defineConfig({
  root: resolve(appRoot, "src/web"),
  base: "./",
  plugins: [browserSafeCoreModules(), tailwindcss(), react()],
  resolve: {
    alias: [],
  },
  build: {
    outDir: resolve(appRoot, "..", "dist-web"),
    emptyOutDir: true,
    sourcemap: false,
    // The bundled catalog JSON (lookup_items 1.2 MB + gamedata 300 KB) is the
    // bulk of the payload. `?raw` imports are inlined as string literals, so the
    // only way to split them out is a chunk rule — but a plain `manualChunks`
    // map cannot target them. Leave the default hashing and let the browser
    // stream: this is a static host, and the shell renders from the small
    // chunks well before the catalog chunk finishes parsing.
    chunkSizeWarningLimit: 4096,
  },
});
