/**
 * Parse the HTTP `Retry-After` header to milliseconds.
 *
 * Steam returns it on 429 responses in two formats (per RFC 7231):
 *  - integer seconds: `Retry-After: 30`
 *  - HTTP-date:        `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 *
 * Returns `undefined` when the header is missing or unparseable — callers
 * should then fall back to their own exponential backoff.
 *
 * Capped at 5 minutes so a misbehaving server can't stall the refresh
 * indefinitely. Steam's typical 429 windows are 5–60s; anything beyond 5m
 * is almost certainly stale or malformed.
 */
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

export function parseRetryAfterMs(
  res: Response | { headers?: { get?: (name: string) => string | null } },
): number | undefined {
  const get = res.headers?.get?.bind(res.headers);
  if (!get) return undefined;
  const raw = get("retry-after");
  if (!raw) return undefined;
  const trimmed = raw.trim();

  // Integer seconds (most common from Steam).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta <= 0) return undefined; // already past — no need to wait
    return Math.min(delta, MAX_RETRY_AFTER_MS);
  }

  return undefined;
}
