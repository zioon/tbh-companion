// Attempt-cap bookkeeping for the self-healing offset extractor.
// Stores how many times extraction has been attempted for a given game version
// under a given app build, so an incomplete table is not re-scanned on every
// launch forever when a field is genuinely underivable. A new app build (which
// may ship an improved extractor) or a new game version resets the count.
//
// Two budgets are tracked independently:
//   - critical (recordExtractionAttempt / mayAttemptExtraction): gates the
//     initial anchor scan; once exhausted the reader degrades to save-only.
//   - enrichment (recordEnrichmentAttempt / mayAttemptEnrichment): gates the
//     follow-up scan for non-blocking fields (boxOpenLog struct offsets, …)
//     which can stay 0 until the game first instantiates the corresponding
//     class (e.g. until the player opens a box). Budget is reset on a detected
//     "box-open event" — see LiveMemoryReader.consumeBoxOpenEvent — so the heal
//     scheduler stops hammering a version that will never succeed on its own,
//     but resumes the moment the precondition becomes true.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXTRACTOR_REVISION } from "./offsetExtractor";

/** Max extractions per (game version, app build) before we stop retrying. */
export const MAX_EXTRACTION_ATTEMPTS = 3;

/** Max enrichment extractions before stopping periodic heal. See header.
 *  1 = attach-time only; further retries are event-driven (box-open detected). */
export const MAX_ENRICHMENT_ATTEMPTS = 1;

interface AttemptMarker {
  appBuild: string;
  attempts: number;
  /** Last extractor revision that recorded attempts — bump resets the budget. */
  extractorRevision?: number;
}

export function attemptMarkerPath(dir: string, version: string): string {
  return join(dir, `tbh-companion-offsets-v${version}.attempts.json`);
}

export function enrichmentAttemptMarkerPath(dir: string, version: string): string {
  return join(dir, `tbh-companion-offsets-v${version}.enrichment-attempts.json`);
}

function readMarkerFile(path: string): AttemptMarker | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AttemptMarker;
    if (typeof parsed?.appBuild !== "string" || typeof parsed?.attempts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readMarker(dir: string, version: string): AttemptMarker | null {
  return readMarkerFile(attemptMarkerPath(dir, version));
}

function readEnrichmentMarker(dir: string, version: string): AttemptMarker | null {
  return readMarkerFile(enrichmentAttemptMarkerPath(dir, version));
}

function writeMarkerFile(path: string, marker: AttemptMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker), "utf-8");
}

function effectiveAttempts(marker: AttemptMarker | null, appBuild: string): number {
  if (!marker || marker.appBuild !== appBuild) return 0;
  if ((marker.extractorRevision ?? 0) < EXTRACTOR_REVISION) return 0;
  return marker.attempts;
}

/**
 * Attempts recorded for this game version UNDER the current app build and
 * extractor revision. Returns 0 when no marker exists, the marker is from a
 * different app build, or a newer extractor shipped (revision bump).
 */
export function extractionAttempts(dir: string, version: string, appBuild: string): number {
  return effectiveAttempts(readMarker(dir, version), appBuild);
}

/** Enrichment attempts recorded for this game version under the current app build. */
export function enrichmentAttempts(dir: string, version: string, appBuild: string): number {
  return effectiveAttempts(readEnrichmentMarker(dir, version), appBuild);
}

/** True when the extractor may run again for this version+build. */
export function mayAttemptExtraction(dir: string, version: string, appBuild: string): boolean {
  return extractionAttempts(dir, version, appBuild) < MAX_EXTRACTION_ATTEMPTS;
}

/** True when enrichment extraction may run again for this version+build. */
export function mayAttemptEnrichment(dir: string, version: string, appBuild: string): boolean {
  return enrichmentAttempts(dir, version, appBuild) < MAX_ENRICHMENT_ATTEMPTS;
}

/**
 * Record one extraction attempt. Resets the counter to 1 when the app build or
 * extractor revision has changed since the last marker. No-throw: silently
 * swallows FS errors.
 */
export function recordExtractionAttempt(dir: string, version: string, appBuild: string): void {
  try {
    const prior = extractionAttempts(dir, version, appBuild);
    writeMarkerFile(attemptMarkerPath(dir, version), {
      appBuild,
      attempts: prior + 1,
      extractorRevision: EXTRACTOR_REVISION,
    });
  } catch {
    // Non-fatal — worst case we retry more than the cap.
  }
}

/**
 * Record one enrichment extraction attempt. Same reset semantics as
 * {@link recordExtractionAttempt}. Tracked separately so a stuck enrichment
 * field (e.g. BoxOpenLog struct offsets pending the player opening a box) does
 * not exhaust the critical budget.
 */
export function recordEnrichmentAttempt(dir: string, version: string, appBuild: string): void {
  try {
    const prior = enrichmentAttempts(dir, version, appBuild);
    writeMarkerFile(enrichmentAttemptMarkerPath(dir, version), {
      appBuild,
      attempts: prior + 1,
      extractorRevision: EXTRACTOR_REVISION,
    });
  } catch {
    // Non-fatal — worst case we retry more than the cap.
  }
}

/**
 * Reset the enrichment attempt counter to 0. Called when a precondition for
 * enrichment success becomes true (e.g. the BoxOpenLog list transitions from
 * empty to non-empty), so the next heal tick is allowed to retry. No-throw.
 */
export function resetEnrichmentAttempts(dir: string, version: string, appBuild: string): void {
  try {
    writeMarkerFile(enrichmentAttemptMarkerPath(dir, version), {
      appBuild,
      attempts: 0,
      extractorRevision: EXTRACTOR_REVISION,
    });
  } catch {
    // Non-fatal — worst case the budget stays exhausted for this session.
  }
}

/**
 * Reset the critical extraction attempt counter to 0. Called when the reader
 * is on a fallback table whose critical RVAs have not yet been re-derived by
 * the extractor (e.g. attach happened while the player was in the main menu
 * and StageManager singleton was not instantiated). Without this reset, the
 * 3-failure critical budget would permanently block re-derivation, leaving
 * the reader "supported" but reading from stale baseline RVAs → all live
 * data null. The worker triggers this on the 30s fallback heal cadence while
 * `isCriticalStaleOnFallback` remains true, so the extractor keeps retrying
 * until the player enters a game stage and the singleton instantiates.
 */
export function resetExtractionAttempts(dir: string, version: string, appBuild: string): void {
  try {
    writeMarkerFile(attemptMarkerPath(dir, version), {
      appBuild,
      attempts: 0,
      extractorRevision: EXTRACTOR_REVISION,
    });
  } catch {
    // Non-fatal — worst case the budget stays exhausted for this session.
  }
}
