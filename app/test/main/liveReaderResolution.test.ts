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
  player: {
    ...INCOMPLETE.player,
    boxData: 0x78, // PlayerSaveData.BoxData — derived at runtime by findPlayerSaveData
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
  player: {
    ...INCOMPLETE.player,
    boxData: 0x78, // PlayerSaveData.BoxData — derived at runtime by findPlayerSaveData
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
  criticalResetCalls: 0,
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
  resetExtractionAttempts: () => {
    stubs.criticalResetCalls += 1;
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
  stubs.criticalResetCalls = 0;
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

  // ── mergeOffsets fallback semantics (end-to-end) ────────────────────────
  // The fix for "实时数据都是回退" on v1.01.02: when the base table is a
  // same-major.minor fallback (v1.01.02 → v1.01.01), the extractor re-derives
  // fresh v1.01.02 RVAs. mergeOffsets MUST let the derived RVAs WIN over the
  // stale fallback baseline — otherwise the persisted merged table keeps
  // v1.01.01's RVAs and every live read resolves to a wrong class (returning
  // null). Pre-fix this test would fail: saved.stageManager would equal
  // v1.01.01's RVA (the fallback baseline), not the derived RVA.
  it("persists derived RVAs (not stale fallback baseline) after merge", async () => {
    stubs.version = "1.01.02"; // falls back to 1.01.01 bundled table
    stubs.cached = null;

    // v1.01.01's stageManager RVA (the fallback baseline we expect to override)
    const fallbackStageMgr = offsetsForVersion("1.01.01")!.typeInfoRva.stageManager;
    // Extractor re-derives a DIFFERENT RVA for v1.01.02 (hypothetical fresh value)
    const derivedStageMgr = fallbackStageMgr + 0x1000n;
    expect(derivedStageMgr).not.toBe(fallbackStageMgr); // sanity

    stubs.extracted = {
      ...DERIVED,
      gameVersion: "1.01.02",
      typeInfoRva: {
        ...DERIVED.typeInfoRva,
        stageManager: derivedStageMgr,
        stageCacheManager: derivedStageMgr + 0x100n,
      },
    };

    await attachFresh();

    // Persisted merged table uses the DERIVED v1.01.02 RVA, not the v1.01.01
    // fallback baseline. Pre-fix this assertion would fail.
    expect(stubs.saved?.typeInfoRva.stageManager).toBe(derivedStageMgr);
    expect(stubs.saved?.typeInfoRva.stageCacheManager).toBe(derivedStageMgr + 0x100n);
    // _fallbackFromVersion is preserved (provenance marker for diagnostics).
    expect(stubs.saved?._fallbackFromVersion).toBe("1.01.01");
  });

  it("keeps fallback baseline for fields the extractor couldn't derive", async () => {
    // When extractor returns 0 for some RVAs (e.g. logManager — the box isn't
    // open yet, so the LogManager anchor isn't static-reachable), the merged
    // table keeps the fallback baseline for those fields. The reader stays
    // supported (has critical anchors) and degrades gracefully on enrichment.
    stubs.version = "1.01.02";
    stubs.cached = null;

    const fallbackLogMgr = offsetsForVersion("1.01.01")!.typeInfoRva.logManager;

    stubs.extracted = {
      ...DERIVED,
      gameVersion: "1.01.02",
      typeInfoRva: {
        ...DERIVED.typeInfoRva,
        // logManager left as 0 (extractor couldn't derive)
        logManager: 0n,
        monsterSpawnManager: 0n,
      },
    };

    await attachFresh();

    // Fallback baseline preserved for fields extractor returned 0.
    expect(stubs.saved?.typeInfoRva.logManager).toBe(fallbackLogMgr);
    expect(stubs.saved?.typeInfoRva.monsterSpawnManager).toBe(
      offsetsForVersion("1.01.01")!.typeInfoRva.monsterSpawnManager,
    );
  });

  // ── Critical-stale-on-fallback deadlock break ──────────────────────────
  // Reproduces the "本地全部都没有" bug: attach while the player is in the
  // main menu → StageManager singleton not instantiated → extractor fails →
  // 3 critical failures → critical budget permanently exhausted → reader
  // stays on stale v1.01.01 baseline RVAs → all live reads return null.
  // The fix: healOffsets detects isCriticalStaleOnFallback and resets the
  // critical budget BEFORE resolving, so the next heal tick retries the
  // extractor (and once the player enters a stage, the singleton instantiates
  // and derivation succeeds — derived RVAs overwrite the stale baseline).
  it("healOffsets resets critical budget when stale on fallback", async () => {
    stubs.version = "1.01.02";
    stubs.cached = null;
    // First attach: extractor fails (StageManager singleton not up yet).
    // resolveOffsets records 1 critical attempt and stays on fallback baseline.
    stubs.extracted = null;

    const reader = await attachFresh();
    // Sanity: reader is supported (fallback baseline has critical fields) but
    // still on stale v1.01.01 RVAs.
    expect(reader.supported).toBe(true);
    expect(reader.isCriticalStaleOnFallback).toBe(true);

    // Simulate the player entering a stage: next extractor run succeeds and
    // re-derives fresh v1.01.02 RVAs.
    const derivedStageMgr = offsetsForVersion("1.01.01")!.typeInfoRva.stageManager + 0x1000n;
    stubs.extracted = {
      ...DERIVED,
      gameVersion: "1.01.02",
      typeInfoRva: {
        ...DERIVED.typeInfoRva,
        stageManager: derivedStageMgr,
        stageCacheManager: derivedStageMgr + 0x100n,
      },
    };

    // Worker calls healOffsets — should reset critical budget first, then
    // run the extractor, which now succeeds and overwrites the baseline.
    const beforeRecordCalls = stubs.recordCalls;
    const beforeCriticalResets = stubs.criticalResetCalls;
    reader.healOffsets();

    // Critical budget was reset (the key assertion — pre-fix this was 0).
    expect(stubs.criticalResetCalls).toBe(beforeCriticalResets + 1);
    // Extractor ran (after the reset unblocked it).
    expect(stubs.recordCalls).toBe(beforeRecordCalls + 1);
    // Persisted table now has the derived v1.01.02 RVA, not v1.01.01's.
    expect(stubs.saved?.typeInfoRva.stageManager).toBe(derivedStageMgr);
    // Reader is no longer "stale on fallback" — derived has overwritten.
    expect(reader.isCriticalStaleOnFallback).toBe(false);
  });

  it("healOffsets does NOT reset critical budget when derived already overwrote", async () => {
    // Once the extractor has successfully re-derived critical RVAs (StageManager
    // singleton was up at attach time), isCriticalStaleOnFallback=false and
    // healOffsets must NOT needlessly reset the critical budget — that would
    // cause the extractor to re-run on every heal tick (CPU waste).
    stubs.version = "1.01.02";
    stubs.cached = null;
    const derivedStageMgr = offsetsForVersion("1.01.01")!.typeInfoRva.stageManager + 0x1000n;
    stubs.extracted = {
      ...DERIVED,
      gameVersion: "1.01.02",
      typeInfoRva: {
        ...DERIVED.typeInfoRva,
        stageManager: derivedStageMgr,
        stageCacheManager: derivedStageMgr + 0x100n,
      },
    };

    const reader = await attachFresh();
    expect(reader.isCriticalStaleOnFallback).toBe(false);

    const beforeCriticalResets = stubs.criticalResetCalls;
    reader.healOffsets();
    // No reset needed — derived already overwrote the baseline.
    expect(stubs.criticalResetCalls).toBe(beforeCriticalResets);
  });

  it("healOffsets does NOT reset critical budget for exact-match bundled version", async () => {
    // v1.00.21 is in the table → exact match, no fallback. Even if the
    // extractor runs (enrichment mode), isCriticalStaleOnFallback=false and
    // the critical budget is never touched.
    stubs.version = "1.00.21";
    stubs.cached = null;
    stubs.extracted = null;

    const reader = await attachFresh();
    expect(reader.isCriticalStaleOnFallback).toBe(false);

    const beforeCriticalResets = stubs.criticalResetCalls;
    reader.healOffsets();
    expect(stubs.criticalResetCalls).toBe(beforeCriticalResets);
  });
});

// ── Disk cache reuse for bundled/fallback versions ───────────────────────
// Pre-fix: the cache was only read when `offsetsForVersionMeta(version)`
// returned null (unknown version). Bundled and fallback versions always
// started from the bundled table, ignoring the persisted cache — so every
// launch re-ran the ~8s extractor even though the previous session had
// already persisted a complete merged table.
// Post-fix: the cache is always consulted, and a more complete (or equally
// complete but extractor-validated) cache wins over the bundled table.
// Fallback versions whose cache already has derived critical RVAs no longer
// force the critical path on every launch.
describe("LiveMemoryReader disk cache reuse for bundled/fallback versions", () => {
  // A complete cache for v1.00.21 (re-versioned COMPLETE fixture). Represents
  // what the previous session would have persisted after a successful
  // enrichment extraction filled the logManager gap in the bundled table.
  const COMPLETE_V1_00_21: LiveOffsets = { ...COMPLETE, gameVersion: "1.00.21" };

  it("skips extraction on a bundled version when cache is already complete", async () => {
    // v1.00.21 is in the bundled table (INCOMPLETE — missing logManager), but
    // the cache holds a fully complete table from a prior session. The cache
    // must win and the extractor must NOT run.
    stubs.version = "1.00.21";
    stubs.cached = COMPLETE_V1_00_21;

    const reader = await attachFresh();

    expect(stubs.extractCalls).toBe(0);
    expect(reader.supported).toBe(true);
  });

  it("prefers a more complete cache over the bundled table and runs enrichment only", async () => {
    // v1.00.21 bundled table is INCOMPLETE (missing logManager + boxOpenLog).
    // Cache has logManager filled but is still missing boxOpenLog → cache is
    // strictly more complete than bundled, so cache wins. The extractor then
    // runs in enrichment mode (not critical) to fill the remaining gap.
    stubs.version = "1.00.21";
    stubs.cached = {
      ...INCOMPLETE,
      gameVersion: "1.00.21",
      typeInfoRva: { ...INCOMPLETE.typeInfoRva, logManager: 0x5e40000n },
    };
    stubs.extracted = DERIVED;

    await attachFresh();

    expect(stubs.extractCalls).toBe(1);
    // Enrichment budget consumed, critical budget untouched.
    expect(stubs.enrichmentRecordCalls).toBe(1);
    expect(stubs.recordCalls).toBe(0);
  });

  it("does NOT force critical path when fallback cache already has derived RVAs", async () => {
    // v1.01.02 falls back to v1.01.01. The cache holds a prior session's
    // merged result: `_fallbackFromVersion` is preserved (provenance), but
    // critical RVAs (stageManager/stageCacheManager) have been overwritten
    // with derived values that DIFFER from the v1.01.01 baseline. The reader
    // must trust the cache and NOT force the critical path again — this is
    // the key win: a fallback version's second launch skips the ~8s critical
    // extraction.
    stubs.version = "1.01.02";
    const baseline = offsetsForVersion("1.01.01")!;
    const derivedStageMgr = baseline.typeInfoRva.stageManager + 0x1000n;
    stubs.cached = {
      ...COMPLETE,
      gameVersion: "1.01.02",
      _fallbackFromVersion: "1.01.01",
      typeInfoRva: {
        ...COMPLETE.typeInfoRva,
        stageManager: derivedStageMgr,
        stageCacheManager: derivedStageMgr + 0x100n,
      },
    };

    const reader = await attachFresh();

    // Cache is complete → extractor skipped entirely.
    expect(stubs.extractCalls).toBe(0);
    expect(reader.supported).toBe(true);
    // Not stale on baseline — derived RVAs are in place.
    expect(reader.isCriticalStaleOnFallback).toBe(false);
  });

  it("forces critical path when fallback cache still has baseline RVAs", async () => {
    // Defensive: if the cache somehow holds a fallback table whose critical
    // RVAs still match the baseline (e.g. prior session's extractor failed
    // before deriving critical anchors, but a partial cache was written by
    // an older code path), the critical path must still be forced so the
    // stale baseline gets re-derived. This guards against a stale cache
    // silently keeping the reader on wrong RVAs forever.
    stubs.version = "1.01.02";
    const baseline = offsetsForVersion("1.01.01")!;
    // Cache = baseline's critical RVAs (unchanged) + gameVersion re-versioned.
    stubs.cached = {
      ...baseline,
      gameVersion: "1.01.02",
      _fallbackFromVersion: "1.01.01",
    };
    stubs.extracted = {
      ...DERIVED,
      gameVersion: "1.01.02",
      typeInfoRva: {
        ...DERIVED.typeInfoRva,
        stageManager: baseline.typeInfoRva.stageManager + 0x1000n,
        stageCacheManager: baseline.typeInfoRva.stageCacheManager + 0x100n,
      },
    };

    await attachFresh();

    // isCriticalStaleOnBaseline(cache)=true → forceCriticalPath=true →
    // critical budget consumed (not enrichment).
    expect(stubs.recordCalls).toBe(1);
    expect(stubs.enrichmentRecordCalls).toBe(0);
  });

  it("does NOT force critical path when cache has _extractorRev even if critical RVAs match baseline", async () => {
    // Bug: when a fallback version's extractor ran in a prior session but
    // could not derive critical RVAs (e.g. StageManager singleton not
    // instantiated because the user was at the main menu), mergeOffsets
    // keeps the baseline RVAs (derived=0 → base wins) and the cache is
    // saved with _extractorRev set. On the next launch, the cache loads
    // with _fallbackFromVersion + baseline-matching critical RVAs, so
    // isCriticalStaleOnBaseline() returns true → Path 3 (worker) triggers
    // healOffsets every 30s → extractor re-runs (~8-10s of scanning) →
    // same outcome (StageManager still not instantiated OR derived RVA
    // genuinely equals baseline because the game didn't change) → cache
    // saved again → infinite loop. User-visible symptom: live page flips
    // to "scanning" for ~10s every ~30s.
    //
    // Fix: isCriticalStaleOnBaseline() checks _extractorRev — if the
    // extractor already ran (cache carries the rev marker), trust that
    // the baseline is either confirmed-correct or unrecoverable (user
    // needs to enter a stage for StageManager to instantiate; the reader
    // can't force that). The user can still manually clear the cache.
    stubs.version = "1.01.02";
    const baseline = offsetsForVersion("1.01.01")!;
    // Complete cache (enrichment filled) + baseline-matching critical RVAs
    // + _extractorRev marker. This is the post-extractor cache state when
    // the extractor ran but StageManager wasn't instantiated (critical RVAs
    // kept as baseline) and enrichment succeeded.
    stubs.cached = {
      ...COMPLETE,
      gameVersion: "1.01.02",
      _fallbackFromVersion: "1.01.01",
      _extractorRev: 11, // prior session's extractor already ran
      typeInfoRva: {
        ...COMPLETE.typeInfoRva,
        stageManager: baseline.typeInfoRva.stageManager,
        stageCacheManager: baseline.typeInfoRva.stageCacheManager,
      },
    };

    const reader = await attachFresh();

    // Cache is complete + extractor already ran → extractor NOT re-run.
    expect(stubs.extractCalls).toBe(0);
    expect(reader.supported).toBe(true);
    // Not stale — _extractorRev present means extractor already validated.
    expect(reader.isCriticalStaleOnFallback).toBe(false);
  });

  it("enrichmentAlreadyAttempted is true when cache has _extractorRev but enrichment still incomplete", async () => {
    // Bug: when the extractor ran in a prior session but failed to derive
    // some enrichment fields (e.g. BoxOpenLog struct offsets — scanner
    // can't identify v1.01.02's obscured field layout), the cache is
    // saved with _extractorRev set but boxOpenLog.itemStringKey=0. On the
    // next launch, enrichmentComplete=false (fields still 0) and the
    // worker's Path 2 (fallback enrichment heal) sees this and every 30s
    // calls resetEnrichmentBudget + healOffsets → extractor re-runs ~9s
    // → same validation failure → cache saved → next 30s same trigger.
    // User-visible symptom: live page flips to "scanning" for ~9s every
    // ~30s, forever.
    //
    // Fix: reader exposes `enrichmentAlreadyAttempted` — true when the
    // cache carries _extractorRev (extractor ran at least once). Worker
    // Path 2 uses this to skip resetEnrichmentBudget when the extractor
    // already had its turn, so the budget stays exhausted and
    // resolveOffsets' mayAttemptEnrichment check short-circuits the
    // extractor. Path 1 (box-open event) and Path 1.5 (cache-pollution)
    // still reset the budget because they carry new signals.
    stubs.version = "1.01.02";
    const baseline = offsetsForVersion("1.01.01")!;
    stubs.cached = {
      ...COMPLETE,
      gameVersion: "1.01.02",
      _fallbackFromVersion: "1.01.01",
      _extractorRev: 12, // extractor already ran
      typeInfoRva: {
        ...COMPLETE.typeInfoRva,
        stageManager: baseline.typeInfoRva.stageManager,
        stageCacheManager: baseline.typeInfoRva.stageCacheManager,
      },
      // boxOpenLog fields still 0 — extractor ran but validation failed.
      runtime: {
        ...COMPLETE.runtime,
        boxOpenLog: {
          itemStringKey: 0,
          itemGradeType: 0,
          gradeSO: 0,
          gradeSOGrade: 0,
          boxType: 0,
          level: 0,
        },
      },
    };
    // Budget exhausted — extractor already ran in the prior session that
    // wrote this cache. mayAttemptEnrichment=false → resolveOffsets skips
    // the extractor call entirely on this attach.
    stubs.mayAttemptEnrichment = false;

    const reader = await attachFresh();

    // Extractor already ran (budget exhausted) → not re-run on this attach.
    expect(stubs.extractCalls).toBe(0);
    expect(reader.supported).toBe(true);
    expect(reader.enrichmentComplete).toBe(false);
    // Key assertion: extractor already attempted for this version.
    expect(reader.enrichmentAlreadyAttempted).toBe(true);
  });

  it("enrichmentAlreadyAttempted is false when cache has no _extractorRev (first launch)", async () => {
    // First launch for a fallback version — no prior extractor run.
    // Path 2 SHOULD resetEnrichmentBudget and let the extractor try.
    stubs.version = "1.01.02";
    const baseline = offsetsForVersion("1.01.01")!;
    stubs.cached = {
      ...COMPLETE,
      gameVersion: "1.01.02",
      _fallbackFromVersion: "1.01.01",
      // No _extractorRev — first launch.
      typeInfoRva: {
        ...COMPLETE.typeInfoRva,
        stageManager: baseline.typeInfoRva.stageManager,
        stageCacheManager: baseline.typeInfoRva.stageCacheManager,
      },
    };

    const reader = await attachFresh();

    expect(reader.enrichmentAlreadyAttempted).toBe(false);
  });
});

// ── Cache-pollution self-heal (forced re-extraction) ────────────────────
// Reproduces the VM bug where a cached `getItemWithBoxOpenTypeKey` /
// `boxOpenLog.itemStringKey` value is non-zero but invalid (an unvalidated
// baseline copy from a fallback table). Pre-fix: `isOffsetTableComplete`
// only checks non-zero, so the bad cache is trusted forever, the extractor
// is never re-run, and `readRuntimeBoxOpenLog` silently fails with
// "dict lookup failed" while chest drops work normally (LogManager itself
// is fine). Post-fix: `detectCachePollution` (called from read()) watches
// for >60s of continuous boxOpen "dict lookup failed" while chest drops
// resolve, and sets `forceExtractorNextHeal`. The worker's Path 1.5
// triggers an immediate heal; `resolveOffsets` sees the flag, bypasses the
// complete-table short-circuit AND the per-budget attempt cap, runs the
// extractor, then clears the flag (one-shot).
describe("LiveMemoryReader cache-pollution self-heal", () => {
  it("forces extractor re-run even when cache is complete and budget is exhausted", async () => {
    // Setup: a complete cache (all fields non-zero) — this is the polluted
    // state. The values look valid but `getItemWithBoxOpenTypeKey=42` won't
    // match any live dict bucket at runtime.
    stubs.cached = COMPLETE;
    // Enrichment budget exhausted — pre-fix this would block any extractor
    // run. Post-fix the forced path bypasses the budget.
    stubs.mayAttemptEnrichment = false;
    // Extractor will succeed this time and return corrected values.
    stubs.extracted = {
      ...COMPLETE,
      runtime: {
        ...COMPLETE.runtime,
        log: { ...COMPLETE.runtime.log, getItemWithBoxOpenTypeKey: 99 },
      },
    };

    const reader = await attachFresh();

    // Sanity: at attach time the cache is complete → extractor skipped.
    expect(stubs.extractCalls).toBe(0);
    expect(reader.supported).toBe(true);
    expect(reader.needsForcedReextract).toBe(false);

    // Simulate detectCachePollution firing: 60s of continuous boxOpen
    // "dict lookup failed" while chest drops resolve. We set the internal
    // flag directly (the read() path that drives the detector needs a fully
    // mocked process / memory map — exercised via integration tests).
    (reader as unknown as { forceExtractorNextHeal: boolean }).forceExtractorNextHeal = true;
    expect(reader.needsForcedReextract).toBe(true);

    const beforeExtractCalls = stubs.extractCalls;
    const beforeEnrichmentRecordCalls = stubs.enrichmentRecordCalls;

    // Worker's Path 1.5 calls healOffsets() — resolveOffsets sees the flag,
    // bypasses the complete-table short-circuit AND the budget cap, runs
    // the extractor.
    reader.healOffsets();

    // Extractor ran exactly once despite complete cache + exhausted budget.
    expect(stubs.extractCalls).toBe(beforeExtractCalls + 1);
    // Forced re-extract does NOT consume the enrichment budget — it is a
    // signal-driven diagnostic run, not a permanent budget unit.
    expect(stubs.enrichmentRecordCalls).toBe(beforeEnrichmentRecordCalls);
    // Persisted merged table now carries the corrected getItemWithBoxOpenTypeKey.
    expect(stubs.saved?.runtime.log.getItemWithBoxOpenTypeKey).toBe(99);
    // Flag consumed — one extractor run per detection event.
    expect(reader.needsForcedReextract).toBe(false);
  });

  it("clears the flag even when forced extractor fails (no infinite loop)", async () => {
    // If the extractor fails to derive valid boxOpenLog fields (e.g. dict
    // really is empty because the player hasn't opened a box yet), the flag
    // must still be cleared so we don't hammer the 8s extractor on every
    // tick. The next detectCachePollution cycle starts a fresh 60s timer.
    stubs.cached = COMPLETE;
    stubs.mayAttemptEnrichment = false;
    stubs.extracted = null; // extractor fails

    const reader = await attachFresh();
    expect(stubs.extractCalls).toBe(0);

    (reader as unknown as { forceExtractorNextHeal: boolean }).forceExtractorNextHeal = true;

    reader.healOffsets();

    // Extractor ran once.
    expect(stubs.extractCalls).toBe(1);
    // Flag cleared despite failure — no infinite loop on next heal tick.
    expect(reader.needsForcedReextract).toBe(false);
  });

  it("does not run extractor when cache is complete and no pollution signal", async () => {
    // Sanity: the forced path is opt-in via the flag. A normal complete cache
    // must still skip the extractor entirely.
    stubs.cached = COMPLETE;
    stubs.mayAttemptEnrichment = true;

    const reader = await attachFresh();

    expect(stubs.extractCalls).toBe(0);
    expect(reader.needsForcedReextract).toBe(false);

    // A normal healOffsets (no pollution flag) must not run the extractor
    // when the cache is complete.
    const before = stubs.extractCalls;
    reader.healOffsets();
    expect(stubs.extractCalls).toBe(before);
  });
});
