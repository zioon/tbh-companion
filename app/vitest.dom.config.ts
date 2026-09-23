import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The web target inlines the repo-root `data/*.json` via `?raw`
// (`src/web/dataSource.ts`), but Vite's dev-server file check stops at the
// `app/` workspace root, so importing the real bundled catalog from a jsdom
// test would otherwise fail with "Denied ID ...data/gamedata.json?raw". Allow
// the repo root so those tests can install the real data source.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/renderer-component/setup.ts"],
    include: [
      "test/renderer-component/**/*.test.{ts,tsx}",
      "src/renderer/design-system/**/*.test.tsx",
    ],
  },
});
