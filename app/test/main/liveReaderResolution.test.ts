// Tests for the self-healing offset resolution in LiveMemoryReader.attach():
//   seed (bundled/cache) → completeness check → attempt-capped extract + merge.
// The completeness/merge helpers run for real; only the impure edges are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { offsetsForVersion, type LiveOffsets } from "../../src/core/liveMemory/offsets";

// A game version NOT in the bundled table, so offsetsForVersion() returns null
// naturally and resolution falls to the cache/extractor mocks.
const VERSION = "9.99.99";

// Real v1.00.21 table, re-versioned. As-is it is complete-critical but missing
// the enrichment `logManager` RVA (0n) → isOffsetTableComplete === false.
const INCOMPLETE: LiveOffsets = { ...offsetsForVersion("1.00.21")!, gameVersion: VERSION };
// Same table with the last gap filled → fully complete.
const COMPLETE: LiveOffsets = {
  ...INCOMPLETE,
  typeInfoRva: {
    ...INCOMPLETE.typeInfoRva,
    logManager: 0x5e40000n,
    monsterSpawnManager: 0x5e50000n,
  },
  runtime: {
    ...INCOMPLETE.runtime,
    log: { ...INCOMPLETE.runtime.log, getItemWithBoxOpenTypeKey: 42 },
    monster: { ...INCOMPLETE.runtime.monster, monsterList: 0x20, deadMonsterList: 0x30 },
    boxOpenLog: {
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
      boxType: 0,
      level: 0,
    },
  },
};
// What the extractor "derives": only the missing enrichment RVA.
const DERIVED: LiveOffsets = {
  ...INCOMPLETE,
  typeInfoRva: {
    ...INCOMPLETE.typeInfoRva,
    logManager: 0x5e40000n,
    monsterSpawnManager: 0x5e50000n,
  },
  runtime: {
    ...INCOMPLETE.runtime,
    log: { ...INCOMPLETE.runtime.log, getItemWithBoxOpenTypeKey: 42 },
    monster: { ...INCOMPLETE.runtime.monster, monsterList: 0x20, deadMonsterList: 0x30 },
    boxOpenLog: {
      itemStringKey: 0x18,
      itemGradeType: 0x1c,
      gradeSO: 0,
      gradeSOGrade: 0,
      boxType: 0,
      level: 0,
    },
  },
};

const stubs = vi.hoisted(() => ({
  cached: null as LiveOffsets | null,
  extracted: null as LiveOffsets | null,
  mayAttempt: true,
  mayAttemptEnrichment: true,
  saved: null as LiveOffsets | null,
  extractCalls: 0,
  recordCalls: 0,
  enrichmentRecordCalls: 0,
  enrichmentResetCalls: 0,
  version: "9.99.99" as string,
}));

vi.mock("../../src/main/liveMemory/offsetCache", () => ({
  loadCachedOffsets: (_dir: string, _version: string, _minRev: number = 0) => stubs.cached,
  saveCachedOffsets: (_dir: string, offsets: LiveOffsets) => {
    stubs.saved = offsets;
  },
  offsetCachePath: () => "/fake/path",
}));

vi.mock("../../src/main/liveMemory/offsetExtractor", () => ({
  EXTRACTOR_REVISION: 11,
  extractOffsets: () => {
    stubs.extractCalls += 1;
    // extractOffsets now returns { offsets, classIndex }; wrap the stubbed
    // LiveOffsets so the reader's merge/persist path keeps working. The class
    // index is empty for tests — the name-scan fast path isn't exercised here.
    return stubs.extracted ? { offsets: stubs.extracted, classIndex: new Map() } : null;
  },
  buildClassNameIndex: () => new Map(),
}));

vi.mock("../../src/main/liveMemory/offsetHealing", () => ({
  mayAttemptExtraction: () => stubs.mayAttempt,
  recordExtractionAttempt: () => {
    stubs.recordCalls += 1;
  },
  extractionAttempts: () => (stubs.mayAttempt ? 0 : 3),
  MAX_EXTRACTION_ATTEMPTS: 3,
  mayAttemptEnrichment: () => stubs.mayAttemptEnrichment,
  recordEnrichmentAttempt: () => {
    stubs.enrichmentRecordCalls += 1;
  },
  enrichmentAttempts: () => (stubs.mayAttemptEnrichment ? 0 : 3),
  MAX_ENRICHMENT_ATTEMPTS: 3,
  resetEnrichmentAttempts: () => {
    stubs.enrichmentResetCalls += 1;
  },
}));

vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: () => stubs.version,
}));

vi.mock("node:path", async () => {
  const nodePath = await import("node:path");
  return { ...nodePath, dirname: () => "C:\\game", join: (...p: string[]) => p.join("\\") };
});

vi.mock("../../src/main/liveMemory/winProcess", () => ({
  WinProcess: {
    findByNames: () => ({
      pid: 9999,
      isAlive: () => true,
      close: () => undefined,
      listModules: () => [
        {
          name: "GameAssembly.dll",
          baseAddress: 0x140000000n,
          size: 0x6000000,
          path: "C:\\game\\GameAssembly.dll",
        },
        {
          name: "TaskBarHero.exe",
          baseAddress: 0x400000n,
          size: 0x1000,
          path: "C:\\game\\TaskBarHero.exe",
        },
      ],
      readBytes: () => null,
    }),
  },
}));

async function attachFresh() {
  vi.resetModules();
  const { LiveMemoryReader } = await import("../../src/main/liveMemory/liveReader");
  const reader = new LiveMemoryReader();
  reader.attach("test-build");
  return reader;
}

beforeEach(() => {
  stubs.cached = null;
  stubs.extracted = null;
  stubs.mayAttempt = true;
  stubs.mayAttemptEnrichment = true;
  stubs.saved = null;
  stubs.extractCalls = 0;
  stubs.recordCalls = 0;
  stubs.enrichmentRecordCalls = 0;
  stubs.enrichmentResetCalls = 0;
  stubs.version = "9.99.99";
});

describe("LiveMemoryReader self-healing resolution", () => {
  it("skips extraction when the cached table is already complete", async () => {
    stubs.cached = COMPLETE;
    const reader = await attachFresh();
    expect(stubs.extractCalls).toBe(0);
    expect(reader.supported).toBe(true);
  });

  it("runs the extractor and merges when the cached table is incomplete", async () => {
    stubs.cached = INCOMPLETE; // logManager 0n
    stubs.extracted = DERIVED;
    const reader = await attachFresh();
    expect(stubs.extractCalls).toBe(1);
    // Merged table persisted with the derived gap filled.
    expect(stubs.saved?.typeInfoRva.logManager).toBe(0x5e40000n);
    expect(reader.supported).toBe(true);
  });

  it("records an enrichment attempt (not a critical one) when supported", async () => {
    stubs.cached = INCOMPLETE;
    stubs.extracted = DERIVED;
    await attachFresh();
    // INCOMPLETE is supported (critical offsets present), so extraction runs
    // via the enrichment budget path — enrichment attempt recorded, critical
    // attempt counter untouched.
    expect(stubs.recordCalls).toBe(0);
    expect(stubs.enrichmentRecordCalls).toBe(1);
  });

  it("records an attempt when not supported (no cached base)", async () => {
    stubs.cached = null;
    stubs.extracted = DERIVED;
    await attachFresh();
    expect(stubs.recordCalls).toBe(1);
  });

  it("keeps a base value over the derived one when merging (fills only gaps)", async () => {
    stubs.cached = INCOMPLETE;
    // Extractor returns a DIFFERENT heroList — merge must keep the base's value.
    stubs.extracted = {
      ...DERIVED,
      runtime: { ...DERIVED.runtime, heroList: 0x999 },
    };
    await attachFresh();
    expect(stubs.saved?.runtime.heroList).toBe(INCOMPLETE.runtime.heroList);
  });

  it("skips extraction when enrichment budget exhausted (supported)", async () => {
    stubs.cached = INCOMPLETE;
    stubs.mayAttemptEnrichment = false;
    stubs.extracted = DERIVED;
    const reader = await attachFresh();
    // Supported but enrichment budget exhausted → extractor skipped, no
    // attempt recorded. Critical budget is independent and also untouched.
    expect(stubs.extractCalls).toBe(0);
    expect(stubs.enrichmentRecordCalls).toBe(0);
    expect(stubs.recordCalls).toBe(0);
    expect(reader.supported).toBe(true);
  });

  it("degrades (supported=false) when nothing resolves and extraction fails", async () => {
    stubs.cached = null;
    stubs.extracted = null;
    const reader = await attachFresh();
    expect(reader.supported).toBe(false);
    expect(reader.attached).toBe(true);
  });
});

describe("LiveMemoryReader fallback version handling", () => {
  // A version that falls back to v1.00.21 (same major.minor 1.00).
  // v1.00.21's table has non-zero critical RVAs (stageManager, stageCacheManager)
  // but is a fallback. Per Rev 10+fix strategy, the fallback RVAs are KEPT as a
  // working baseline (so isSupported=true → reader stays supported), AND the
  // extractor is forced to run the FULL critical path (enrichmentOnly=false) so
  // it re-derives StageManager/StageCacheManager from live memory and overwrites
  // the stale baseline via mergeOffsets. Without forcing the critical path, the
  // extractor would take the enrichment-only path (because isSupported=true)
  // and never re-derive critical anchors — the reader would stay "supported"
  // but return null for every live read (no DPS/XP/stage-clears).
  const FALLBACK_VERSION = "1.00.20"; // not in TABLE, falls back to 1.00.21

  it("keeps fallback RVAs as baseline but forces critical-path extraction", async () => {
    stubs.version = FALLBACK_VERSION;
    stubs.cached = null;
    stubs.extracted = DERIVED;

    const reader = await attachFresh();

    // Fallback table's critical RVAs are present → isSupported=true, BUT
    // isFallbackTable=true forces the extractor to run with enrichmentOnly=false
    // (critical path) so it re-derives StageManager/StageCacheManager. The
    // critical budget (recordExtractionAttempt) is consumed, not enrichment.
    expect(stubs.extractCalls).toBe(1);
    expect(stubs.recordCalls).toBe(1); // critical budget, not enrichment
    expect(stubs.enrichmentRecordCalls).toBe(0);
    expect(reader.supported).toBe(true); // fallback RVAs keep reader supported
  });

  it("stays supported even when critical extraction fails (fallback RVAs keep working)", async () => {
    // This is the v1.01.02 scenario: fallback table present, extractor runs
    // critical path but fails (e.g. StageManager not yet instantiated at
    // attach time). Old Rev 9 behavior:
    //   fallback RVAs zeroed → critical missing → 3 failures → permanently
    //   unsupported.
    // Rev 10 bug:
    //   fallback RVAs kept → isSupported=true → enrichment-only path → never
    //   re-derives critical anchors → "supported" but no data.
    // Rev 10 + this fix:
    //   fallback RVAs kept → isSupported=true → critical path forced → fails
    //   → budget exhausted, but reader stays SUPPORTED because fallback RVAs
    //   are still in the table (may return null data, but not "unsupported").
    stubs.version = FALLBACK_VERSION;
    stubs.cached = null;
    stubs.extracted = null; // extractor fails
    stubs.mayAttempt = true; // critical budget available

    const reader = await attachFresh();

    expect(stubs.extractCalls).toBe(1);
    expect(stubs.recordCalls).toBe(1); // critical budget consumed
    expect(stubs.enrichmentRecordCalls).toBe(0);
    expect(reader.supported).toBe(true); // ← key assertion: stays supported
  });

  it("does NOT force critical path for an exact-match bundled version", async () => {
    // v1.00.21 is in the table → exact match, no fallback. Extractor runs in
    // enrichment mode (enrichmentOnly=true) because the bundled RVAs are
    // trusted for the exact version.
    stubs.version = "1.00.21";
    stubs.cached = null;
    // Extractor returns null — we only care that it ran in enrichment mode.
    stubs.extracted = null;

    await attachFresh();

    // Exact-match bundled table has critical offsets → isSupported=true, no
    // fallback → extractor runs in enrichment mode (enrichment attempt
    // recorded, not critical).
    expect(stubs.enrichmentRecordCalls).toBe(1);
    expect(stubs.recordCalls).toBe(0);
  });
});
