import { describe, it, expect } from "vitest";
import {
  offsetsForVersion,
  offsetsForVersionMeta,
  supportedVersions,
  plausiblePlayTime,
  plausibleStage,
  plausibleGold,
  plausibleWave,
  type LiveOffsets,
} from "../../src/core/liveMemory/offsets";

describe("offsetsForVersion", () => {
  it("returns the bundled table for an exact version match (fast path — LMR-06)", () => {
    const o = offsetsForVersion("1.00.21");
    expect(o).not.toBeNull();
    expect(o?.gameVersion).toBe("1.00.21");
    // spot-check a couple of locked schema values so an accidental edit is caught
    expect(o?.goldKey).toBe(100001);
    expect(o?.runtime.stage.stageKey).toBe(0x30);
    expect(o?.typeInfoRva.stageCacheManager).toBe(0x5dc9958n);
  });

  it("returns the bundled table for v1.00.23", () => {
    const o = offsetsForVersion("1.00.23");
    expect(o).not.toBeNull();
    expect(o?.gameVersion).toBe("1.00.23");
    expect(o?.typeInfoRva.currencyManager).toBe(0x5db9758n);
    expect(o?.typeInfoRva.stageCacheManager).toBe(0x5dba2f8n);
    expect(o?.typeInfoRva.stageManager).toBe(0x5e30318n);
    expect(o?.typeInfoRva.logManager).toBe(0x5e2fb58n);
    expect(o?.player.petSaveDatas).toBe(0x70);
    expect(o?.player.itemSaveDatas).toBe(0xa8);
  });

  it("returns null for an absent/invalid version (degraded mode — LMR-07)", () => {
    // Different major.minor — no fallback available.
    expect(offsetsForVersion("9.99.99")).toBeNull();
    expect(offsetsForVersion("2.00.00")).toBeNull();
    expect(offsetsForVersion(null)).toBeNull();
    expect(offsetsForVersion(undefined)).toBeNull();
    expect(offsetsForVersion("")).toBeNull();
  });

  it("falls back to the nearest same-major.minor version for unknown patches", () => {
    // 1.00.29 is not in the table → falls back to 1.00.28 (nearest 1.00.x).
    const fallback = offsetsForVersion("1.00.29");
    expect(fallback).not.toBeNull();
    expect(fallback?.gameVersion).toBe("1.00.29");
    // Offsets inherited from v1.00.28 (ObscuredDouble exp layout).
    expect(fallback?.heroRuntime.expHidden).toBe(0x118);
    expect(fallback?.unit.cache).toBe(0x3b0);

    // 1.00.50 also falls back to 1.00.28 (only same-major.minor candidate).
    const far = offsetsForVersion("1.00.50");
    expect(far).not.toBeNull();
    expect(far?.gameVersion).toBe("1.00.50");

    // 1.00.20 falls back to 1.00.21 (nearest lower).
    const lower = offsetsForVersion("1.00.20");
    expect(lower).not.toBeNull();
    expect(lower?.gameVersion).toBe("1.00.20");
    expect(lower?.heroRuntime.expHidden).toBe(0x110); // v1.00.21 ObscuredFloat
  });

  it("lists the supported versions", () => {
    expect(supportedVersions()).toContain("1.00.21");
    expect(supportedVersions()).toContain("1.00.23");
  });

  it("exposes the complete shared schema shape (locked for Phase 3)", () => {
    const o = offsetsForVersion("1.00.21")!;
    expect(Object.keys(o.typeInfoRva).sort()).toEqual([
      "commonSaveData",
      "currencyManager",
      "localInventoryManager",
      "logManager",
      "monsterSpawnManager",
      "stageCacheManager",
      "stageManager",
    ]);
    expect(o.runtime.currency.entryObscuredQty).toBe(0x28);
    expect(o.dict.entryKey).toBe(8); // inline int32 key trap (not boxed)
    // Phase 2 schema additions
    expect(o.runtime.heroList).toBe(0x30); // StageManager.HeroList — real field
    expect(o.unit.cache).toBe(0x3a8); // Unit.cache → HeroRuntime
    expect(o.heroRuntime.info).toBe(0x30); // HeroRuntime.info → HeroInfoData
    expect(o.heroRuntime.expHidden).toBe(0x110); // ObscuredFloat xp hiddenValue
    expect(o.heroInfoData.heroKey).toBe(0x30);
    // Phase 3.1 chest-log schema (GetBoxLog via LogManager)
    expect(o.runtime.log.logByType).toBe(0x28); // LogManager Dictionary<ELogType, List>
    expect(o.runtime.log.getBoxTypeKey).toBe(3); // ELogType.GetBox
    expect(o.runtime.getBoxLog.monsterType).toBe(0x50); // GetBoxLog EMonsterLogType
    // Phase 4 stage-clear schema (StageClearLog via LogManager)
    expect(o.runtime.log.stageClearTypeKey).toBe(1); // ELogType.StageClear
    expect(o.runtime.stageClearLog.act).toBe(0x40); // StageClearLog.act — live-verified on v1.00.23
    expect(o.runtime.stageClearLog.stage).toBe(0x44); // StageClearLog.stage
    expect(o.runtime.stageClearLog.clearTimeSec).toBe(0x48); // StageClearLog.clearTimeSec
    expect("petSaveData" in o).toBe(true);
    expect("inventoryItem" in o).toBe(true);
    expect("petSaveDatas" in o.player).toBe(true);
    expect("itemSaveDatas" in o.player).toBe(true);
  });

  it("exposes fallback flag via offsetsForVersionMeta", () => {
    // Exact match → fallback=false, no provenance marker
    const exact = offsetsForVersionMeta("1.00.21")!;
    expect(exact.table.gameVersion).toBe("1.00.21");
    expect(exact.fallback).toBe(false);
    expect(exact.table._fallbackFromVersion).toBeUndefined();

    // Same-major.minor fallback (1.00.29 → 1.00.28) → fallback=true, marker set
    const fb = offsetsForVersionMeta("1.00.29")!;
    expect(fb.table.gameVersion).toBe("1.00.29");
    expect(fb.fallback).toBe(true);
    expect(fb.table._fallbackFromVersion).toBe("1.00.28");

    // v1.01.02 (not in table) falls back to v1.01.01 → fallback=true, marker set
    const v102 = offsetsForVersionMeta("1.01.02")!;
    expect(v102.table.gameVersion).toBe("1.01.02");
    expect(v102.fallback).toBe(true);
    expect(v102.table._fallbackFromVersion).toBe("1.01.01");

    // Different major.minor → null (no fallback available)
    expect(offsetsForVersionMeta("9.99.99")).toBeNull();
  });

  it("offsetsForVersion also sets _fallbackFromVersion on fallback paths", () => {
    // Exact match → no marker
    expect(offsetsForVersion("1.00.21")?._fallbackFromVersion).toBeUndefined();

    // Fallback → marker records the source version
    expect(offsetsForVersion("1.00.29")?._fallbackFromVersion).toBe("1.00.28");
    expect(offsetsForVersion("1.00.20")?._fallbackFromVersion).toBe("1.00.21");
  });
});

describe("plausibility guards", () => {
  it("plausiblePlayTime accepts sane play times, rejects garbage/null", () => {
    expect(plausiblePlayTime(3600)).toBe(true);
    expect(plausiblePlayTime(100)).toBe(false); // exclusive lower bound
    expect(plausiblePlayTime(1e9)).toBe(false); // exclusive upper bound
    expect(plausiblePlayTime(null)).toBe(false);
  });

  it("plausibleStage accepts positive stage keys within range", () => {
    expect(plausibleStage(1)).toBe(true);
    expect(plausibleStage(999_999)).toBe(true);
    expect(plausibleStage(0)).toBe(false);
    expect(plausibleStage(1_000_000)).toBe(false);
    expect(plausibleStage(null)).toBe(false);
  });

  it("plausibleGold accepts non-negative values below the safe ceiling", () => {
    expect(plausibleGold(0)).toBe(true);
    expect(plausibleGold(123456)).toBe(true);
    expect(plausibleGold(-1)).toBe(false);
    expect(plausibleGold(1e15)).toBe(false);
    expect(plausibleGold(null)).toBe(false);
  });

  it("plausibleWave accepts 0 (challenge-fail reset) and positive waves under 1000", () => {
    expect(plausibleWave(0)).toBe(true); // pre-wave / challenge-failure reset
    expect(plausibleWave(1)).toBe(true);
    expect(plausibleWave(999)).toBe(true);
    expect(plausibleWave(1000)).toBe(false);
    expect(plausibleWave(null)).toBe(false);
  });
});

// ── Cross-version regression ───────────────────────────────────────────────
// 自动回归：遍历 supportedVersions() 中所有版本表，锁定"stable across patches"
// 字段的预期值。新增版本表时无需手写新用例 —— 这里会自动覆盖。
// 触发场景：以后修改 offsets.ts 时若漏改某个版本、或写入错误值，本组测试会立即失败。
describe("cross-version offset regression (auto-covers new versions)", () => {
  const VERSIONS = supportedVersions();

  // 期望所有版本都派生了完整的 stageClearLog 三件套（act/stage/clearTimeSec）。
  // 这三个偏移在 offsets.ts 注释中明确标注为"stable across patches"，值固定为
  // 0x40 / 0x44 / 0x48（live-verified on v1.00.23）。任何版本缺失或偏差都会导致
  // 通关记录归属回退到 live stageKey，重新引发"地图快一个"的 off-by-one bug。
  const EXPECTED_STAGE_CLEAR_LOG: Readonly<Record<keyof LiveOffsets["runtime"]["stageClearLog"], number>> = {
    act: 0x40,
    stage: 0x44,
    clearTimeSec: 0x48,
  };

  // 其他在 offsets.ts 中标注为"stable across patches"的运行时偏移，一并锁定。
  const EXPECTED_STABLE_RUNTIME: Array<{
    path: string;
    get: (o: LiveOffsets) => number;
    expected: number;
  }> = [
    { path: "runtime.log.logByType", get: (o) => o.runtime.log.logByType, expected: 0x28 },
    { path: "runtime.log.getBoxTypeKey", get: (o) => o.runtime.log.getBoxTypeKey, expected: 3 },
    { path: "runtime.log.stageClearTypeKey", get: (o) => o.runtime.log.stageClearTypeKey, expected: 1 },
    { path: "runtime.getBoxLog.monsterType", get: (o) => o.runtime.getBoxLog.monsterType, expected: 0x50 },
    { path: "runtime.heroList", get: (o) => o.runtime.heroList, expected: 0x30 },
    { path: "runtime.currencyInfoKey", get: (o) => o.runtime.currencyInfoKey, expected: 0x30 },
  ];

  it("supportedVersions() is non-empty (guard against TABLE being accidentally wiped)", () => {
    expect(VERSIONS.length).toBeGreaterThan(0);
  });

  it.each(VERSIONS)("version %s has stageClearLog.act/stage/clearTimeSec at the stable offsets", (version) => {
    const o = offsetsForVersion(version)!;
    expect(o).not.toBeNull();
    for (const [field, expected] of Object.entries(EXPECTED_STAGE_CLEAR_LOG) as Array<
      [keyof LiveOffsets["runtime"]["stageClearLog"], number]
    >) {
      expect(o.runtime.stageClearLog[field]).toBe(expected);
    }
  });

  it.each(VERSIONS)("version %s preserves stable runtime log/hero/currency offsets", (version) => {
    const o = offsetsForVersion(version)!;
    for (const { path, get, expected } of EXPECTED_STABLE_RUNTIME) {
      expect(get(o), `${path} on ${version}`).toBe(expected);
    }
  });

  it.each(VERSIONS)("version %s exposes the full stageClearLog schema (3 fields, no extra keys)", (version) => {
    const o = offsetsForVersion(version)!;
    expect(Object.keys(o.runtime.stageClearLog).sort()).toEqual(["act", "clearTimeSec", "stage"]);
  });

  // 同 major.minor fallback 路径也必须继承 stageClearLog（防止 fallback 表覆盖时丢字段）。
  it("fallback path (e.g. 1.00.29 → 1.00.28) inherits stageClearLog intact", () => {
    const fb = offsetsForVersion("1.00.29")!;
    expect(fb.runtime.stageClearLog.act).toBe(0x40);
    expect(fb.runtime.stageClearLog.stage).toBe(0x44);
    expect(fb.runtime.stageClearLog.clearTimeSec).toBe(0x48);
  });

  it("fallback path (e.g. 1.01.02 → 1.01.01) inherits stageClearLog intact", () => {
    const fb = offsetsForVersion("1.01.02")!;
    expect(fb.runtime.stageClearLog.act).toBe(0x40);
    expect(fb.runtime.stageClearLog.stage).toBe(0x44);
    expect(fb.runtime.stageClearLog.clearTimeSec).toBe(0x48);
  });
});
