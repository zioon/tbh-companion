// Cross-environment bundled-data resolution.
//
// `core/bundledData.ts` reads JSON synchronously with `node:fs`, which works in
// the Electron main process but not in a browser bundle. The web build installs
// a preloaded in-memory source here (see `src/web/dataSource.ts`), letting the
// same `core` parsing code run unchanged on both targets: `readBundledJson`
// consults this source before falling back to the filesystem.
//
// The source must be installed *synchronously at startup*, before the renderer
// mounts — `loadLocaleCatalog` and friends call `readBundledJson` from module
// scope / first render, so a lazily-awaited fetch would race the first paint.

/** Reads a bundled JSON filename and returns its raw text, or null when absent. */
export type BundledDataTextSource = (filename: string) => string | null;

let textSource: BundledDataTextSource | null = null;

/**
 * Install (or clear, with `null`) an in-memory bundled-data source.
 * Used by the browser build; the Electron main process leaves this unset.
 */
export function setBundledDataTextSource(source: BundledDataTextSource | null): void {
  textSource = source;
}

/** The installed source, if any. */
export function getBundledDataTextSource(): BundledDataTextSource | null {
  return textSource;
}
