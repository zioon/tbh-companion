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
 * Returns null when the file is missing, corrupt, version-mismatched, OR was
 * written by an older extractor revision (so a buggy prior revision's values
 * can't survive via `mergeOffsets`'s "base non-zero is trusted" rule).
 */
export function loadCachedOffsets(cacheDir: string, version: string): LiveOffsets | null {
  try {
    const path = offsetCachePath(cacheDir, version);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw, reviver) as CacheEnvelope | LiveOffsets;
    // Back-compat: older builds wrote a bare LiveOffsets object (no envelope).
    // Detect by presence of `typeInfoRva` at the top level.
    if (parsed == null) return null;
    const isEnvelope = (p: unknown): p is CacheEnvelope =>
      typeof p === "object" &&
      p !== null &&
      "offsets" in p &&
      "extractorRevision" in p;
    if (isEnvelope(parsed)) {
      if (parsed.gameVersion !== version) return null;
      // Revision mismatch: discard the cache so the extractor re-derives
      // (and corrects any prior-revision wrong-but-nonzero values).
      if (parsed.extractorRevision < EXTRACTOR_REVISION) return null;
      return parsed.offsets;
    }
    // Bare-object back-compat: treat as revision 0 (forces re-derivation
    // under any modern extractor revision). Verify version match regardless.
    const bare = parsed as LiveOffsets;
    if (bare.gameVersion !== version) return null;
    return bare;
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
