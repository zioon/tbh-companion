// Web build: bundled item icons as same-origin static files.
//
// Replaces `renderer/lib/iconSrc` via the Vite plugin in `vite.web.config.ts`.
// The desktop version emits `tbh-asset://icon/<name>`, a custom protocol served
// by the main process — a browser cannot resolve that scheme, so every item icon
// would render as a broken image. Icons are copied to `<base>/icons/<name>.png`
// at build time (see `scripts/copy-web-icons.mjs`), so the browser can fetch
// them as ordinary relative URLs.
//
// `import.meta.env.BASE_URL` honours the Vite `base` setting, so this keeps
// working if the build is ever served from a subpath.

/** Bundled game item icon, served as a same-origin static PNG. */
export function iconSrc(iconPath: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}icons/${encodeURIComponent(iconPath)}.png`;
}
