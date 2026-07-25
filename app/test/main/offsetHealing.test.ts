import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attemptMarkerPath,
  enrichmentAttemptMarkerPath,
  enrichmentAttempts,
  extractionAttempts,
  mayAttemptEnrichment,
  mayAttemptExtraction,
  MAX_EXTRACTION_ATTEMPTS,
  recordEnrichmentAttempt,
  recordExtractionAttempt,
  resetEnrichmentAttempts,
  resetExtractionAttempts,
} from "../../src/main/liveMemory/offsetHealing";

const DIR = join(process.env["TEMP"] ?? "/tmp", `tbh-offset-healing-${process.pid}`);
const VERSION = "1.00.21";
const BUILD = "2.3.4";

beforeEach(() => mkdirSync(DIR, { recursive: true }));
afterEach(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("extractionAttempts", () => {
  it("returns 0 when no marker exists", () => {
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(0);
  });

  it("counts recorded attempts for the same build", () => {
    recordExtractionAttempt(DIR, VERSION, BUILD);
    recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(2);
  });

  it("resets to 0 for a different app build (may ship an improved extractor)", () => {
    recordExtractionAttempt(DIR, VERSION, BUILD);
    recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(extractionAttempts(DIR, VERSION, "9.9.9")).toBe(0);
  });

  it("resets to 0 when the extractor revision bumps", () => {
    recordExtractionAttempt(DIR, VERSION, BUILD);
    recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(2);
    // Simulate an older marker written before EXTRACTOR_REVISION was recorded.
    writeFileSync(
      attemptMarkerPath(DIR, VERSION),
      JSON.stringify({ appBuild: BUILD, attempts: 3, extractorRevision: 0 }),
      "utf-8",
    );
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(0);
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(true);
  });

  it("is keyed per game version", () => {
    recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(extractionAttempts(DIR, "2.00.00", BUILD)).toBe(0);
  });
});

describe("mayAttemptExtraction", () => {
  it("allows attempts until the cap is reached, then stops", () => {
    for (let i = 0; i < MAX_EXTRACTION_ATTEMPTS; i++) {
      expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(true);
      recordExtractionAttempt(DIR, VERSION, BUILD);
    }
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(false);
  });

  it("re-opens the budget when the app build changes", () => {
    for (let i = 0; i < MAX_EXTRACTION_ATTEMPTS; i++) recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(false);
    expect(mayAttemptExtraction(DIR, VERSION, "next-build")).toBe(true);
  });
});

describe("enrichmentAttempts", () => {
  it("returns 0 when no marker exists", () => {
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(0);
  });

  it("counts recorded attempts for the same build", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(2);
  });

  it("resets to 0 for a different app build", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, VERSION, "9.9.9")).toBe(0);
  });

  it("resets to 0 when the extractor revision bumps", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(2);
    writeFileSync(
      enrichmentAttemptMarkerPath(DIR, VERSION),
      JSON.stringify({ appBuild: BUILD, attempts: 3, extractorRevision: 0 }),
      "utf-8",
    );
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(0);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(true);
  });

  it("is keyed per game version", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, "2.00.00", BUILD)).toBe(0);
  });
});

describe("mayAttemptEnrichment", () => {
  it("allows attempts until the cap is reached, then stops", () => {
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(true);
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(false);
  });

  it("re-opens the budget when the app build changes", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(false);
    expect(mayAttemptEnrichment(DIR, VERSION, "next-build")).toBe(true);
  });
});

describe("resetEnrichmentAttempts", () => {
  it("clears the budget so enrichment may run again", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(false);
    resetEnrichmentAttempts(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(0);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(true);
  });
});

describe("resetExtractionAttempts", () => {
  it("clears the critical budget so extraction may run again", () => {
    // Exhaust the critical budget — simulates the "3 failures" deadlock when
    // StageManager singleton is not instantiated at attach time.
    for (let i = 0; i < MAX_EXTRACTION_ATTEMPTS; i++) recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(false);
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(MAX_EXTRACTION_ATTEMPTS);

    // Worker calls resetExtractionAttempts (via healOffsets) once it detects
    // isCriticalStaleOnFallback — this clears the budget so the next heal
    // tick can retry the extractor.
    resetExtractionAttempts(DIR, VERSION, BUILD);
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(0);
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(true);
  });

  it("does not affect the enrichment budget (budgets are independent)", () => {
    // Pre-condition: enrichment budget is partially used.
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(1);

    // Resetting critical budget must NOT clear enrichment — they are tracked
    // in separate marker files for independent budget control.
    resetExtractionAttempts(DIR, VERSION, BUILD);
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(1);
  });
});

describe("enrichment vs critical budget isolation", () => {
  it("exhausting enrichment does not affect the critical budget", () => {
    recordEnrichmentAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(false);
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(true);
    expect(extractionAttempts(DIR, VERSION, BUILD)).toBe(0);
  });

  it("exhausting critical does not affect the enrichment budget", () => {
    for (let i = 0; i < MAX_EXTRACTION_ATTEMPTS; i++) recordExtractionAttempt(DIR, VERSION, BUILD);
    expect(mayAttemptExtraction(DIR, VERSION, BUILD)).toBe(false);
    expect(mayAttemptEnrichment(DIR, VERSION, BUILD)).toBe(true);
    expect(enrichmentAttempts(DIR, VERSION, BUILD)).toBe(0);
  });
});
