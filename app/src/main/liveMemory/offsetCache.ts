// Per-version LiveOffsets disk cache — stored under app userData (not the game folder).
// JSON round-trips the full LiveOffsets shape; bigint fields are serialized as decimal strings.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LiveOffsets } from "../../core/liveMemory/offsets";
import { EXTRACTOR_REVISION } from "./offsetExtractor";

// ── Serialization: bigint ↔ string ───────────────────────────────────────────

// Bigints are serialized as hex strings prefixed with "0x" so they are
// unambiguously distinguished from plain JSON numbers on round-trip.
function replacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `0x${v.toString(16)}` : v;
}

function reviver(_k: string, v: unknown): unknown {
  if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)) return BigInt(v);
  return v;
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Wrapper shape persisted to disk. The outer envelope records the
 * `extractorRevision` that produced the cached table so a future extractor
 * bug-fix (revision bump) can invalidate previously-written wrong-but-nonzero
 * values. Without this, `mergeOffsets`'s "base non-zero is trusted" rule
 * would let a buggy prior revision's values survive forever.
 *
 * Older companion builds wrote a bare `LiveOffsets` JSON object (no
 * envelope); `loadCachedOffsets` still accepts that shape for back-compat
 * but treats it as revision 0 (so any newer extractor revision forces
 * re-derivation).
 */
interface CacheEnvelope {
  gameVersion: string;
  extractorRevision: number;
  offsets: LiveOffsets;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Path for the per-version cache file under a resolved offset-cache directory. */
export function offsetCachePath(cacheDir: string, version: string): string {
  return join(cacheDir, `tbh-companion-offsets-v${version}.json`);
}

/**
 * Load cached offsets for `version` from `cacheDir`.
 * Returns null when the file is missing, corrupt, version-mismatched, OR when
 * the cache was written by an older extractor revision than `minRev` (so a new
 * extractor revision that fixes a derivation bug actually re-runs instead of
 * loading stale offsets).
 *
 * Two on-disk shapes are accepted:
 *   - Envelope (current): `{ gameVersion, extractorRevision, offsets }` written
 *     by `saveCachedOffsets`. The revision is read from `extractorRevision`.
 *   - Bare `LiveOffsets` (legacy pre-Rev 11): no envelope. The revision is read
 *     from the optional `_extractorRev` field on the LiveOffsets itself, or 0
 *     when absent → always invalidated when `minRev > 0`.
 *
 * Pre-fix this function returned the envelope as if it were a `LiveOffsets`,
 * so every field inside `.offsets` (`goldKey`, `typeInfoRva`, …) was unreachable
 * and the `_extractorRev` lookup (which only exists on the envelope as
 * `extractorRevision`) always returned 0 → caches were silently invalidated
 * every launch.
 */
export function loadCachedOffsets(
  cacheDir: string,
  version: string,
  minRev: number = 0,
): LiveOffsets | null {
  try {
    const path = offsetCachePath(cacheDir, version);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw, reviver) as CacheEnvelope | LiveOffsets;
    // Envelope detection: a present-and-object `offsets` field is the marker.
    const isEnvelope =
      typeof (parsed as CacheEnvelope | null)?.offsets === "object" &&
      (parsed as CacheEnvelope | null)?.offsets !== null;
    const offsets = isEnvelope ? (parsed as CacheEnvelope).offsets : (parsed as LiveOffsets);
    const envGameVersion = isEnvelope
      ? (parsed as CacheEnvelope).gameVersion
      : (parsed as LiveOffsets).gameVersion;
    const cacheRev = isEnvelope
      ? (parsed as CacheEnvelope).extractorRevision
      : ((parsed as LiveOffsets)._extractorRev ?? 0);
    if (envGameVersion !== version) return null;
    if (minRev > 0 && cacheRev < minRev) return null;
    return offsets;
  } catch {
    return null;
  }
}

/**
 * Save `offsets` under userData atomically (tmp file + rename) so a crash mid-write
 * can't leave a half-written JSON that would silently fail to parse on next launch.
 * No-throw: silently swallows FS errors.
 */
export function saveCachedOffsets(cacheDir: string, offsets: LiveOffsets): void {
  try {
    const path = offsetCachePath(cacheDir, offsets.gameVersion);
    ensureParentDir(path);
    const envelope: CacheEnvelope = {
      gameVersion: offsets.gameVersion,
      extractorRevision: EXTRACTOR_REVISION,
      offsets,
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(envelope, replacer), "utf-8");
    renameSync(tmp, path);
  } catch {
    // Cache write failure is non-fatal.
  }
}
