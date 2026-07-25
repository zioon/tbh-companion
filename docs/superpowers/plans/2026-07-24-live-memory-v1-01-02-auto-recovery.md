# LiveMemory v1.01.02 自动恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 LiveMemory 在游戏升级到 v1.01.02（及未来同 major.minor 小版本）后，自动重新派生 critical RVA 与 BoxOpenLog 字段偏移，恢复 DPS / 掉落 / 经验三项实时数据，无需手动发布新版本 companion。

**Architecture:** 分三层修复 —— (1) 版本 fallback 时不再信任旧 RVA，强制 extractor 走完整派生路径；(2) 放宽 GetBoxLog 列表验证并新增 BoxOpen bucket 直查兜底，覆盖类名混淆 / 字段偏移漂移；(3) 在 `findLogManager` 失败路径加诊断 dump，为后续微调提供数据。所有改动保持 core 层纯净（无 node/electron 依赖），沿用现有 mock 风格的单测。

**Tech Stack:** TypeScript, Vitest, Electron utility process, IL2CPP metadata scanning。

---

## 背景

游戏 v1.01.02 上线后，companion 日志显示：

```
[liveMemory] [worker] resolve: bundled table for v1.01.02
[liveMemory] [worker] resolve: incomplete — missing runtime.boxOpenLog.itemStringKey, runtime.boxOpenLog.itemGradeType
[liveMemory] [worker] extract: logManager not derived (no validated GetBoxLog list — chest drops degrade); boxOpenLog.fields={itemStringKey:0x0,itemGradeType:0x0,...}
[liveMemory] [worker] extract: monsterSpawnManager rva=0x5d8a8d8
[liveMemory] [worker] extract: player save-data anchor not derived
```

三个症状及根因：

| 症状 | 根因 |
|------|------|
| 经验 / stage 不可用 | `offsetsForVersion("1.01.02")` fallback 到 v1.01.01 表，旧 RVA（`stageManager=0x5dd8878` 等）在 v1.01.02 已漂移；但 `hasCriticalOffsets` 只检查非零，判定 `isSupported=true` → extractor 走 `enrichmentOnly=true` 跳过 critical 重派生 → reader 拿旧 RVA 读到垃圾 |
| 掉落不可用 | `findLogManager` 依赖 `validateGetBoxLogList`，后者硬编码类名 `GetBoxLog` + 硬编码偏移 `0x50` 的 `EMonsterLogType`；v1.01.02 若改类名或偏移，整条链断 → `boxOpenLog.fields` 全 0 |
| DPS 部分不可用 | `monsterSpawnManager` extractor 能跑（enrichment-only 也跑），RVA 已更新到 `0x5d8a8d8`；但 `runtime.monster.*` 全 0 + 硬编码回退（0x28/0x38/0x30）若 v1.01.02 改了 MonsterSpawnManager 字段布局则失效 |

详见诊断对话记录。

---

## 文件结构

| 文件 | 责任 | 改动类型 |
|------|------|---------|
| `app/src/core/liveMemory/offsets.ts` | 版本表 + `offsetsForVersion` 查找 | 新增 `offsetsForVersionMeta()` 返回 fallback 标志 |
| `app/src/main/liveMemory/liveReader.ts` | `resolveOffsets` 自愈编排 | fallback 时清零 critical RVA，强制完整 extractor |
| `app/src/core/liveMemory/il2cppScanner.ts` | IL2CPP 结构探测器 | 放宽 `validateGetBoxLogList` + 新增 `findBoxOpenLogDictDirect` + 诊断 dump |
| `app/src/main/liveMemory/offsetExtractor.ts` | extractor 主入口 | `findLogManager` 失败时调兜底 + bump `EXTRACTOR_REVISION` |
| `app/test/core/liveMemoryOffsets.test.ts` | 版本表单测 | 加 fallback 标志用例 |
| `app/test/main/liveReaderResolution.test.ts` | resolveOffsets 单测 | 加 fallback 清零 RVA 用例 |
| `app/test/core/liveMemoryIl2cppScanner.test.ts` | scanner 单测 | 加放宽验证 + 兜底用例 |

---

## Task 1: `offsetsForVersionMeta` 暴露 fallback 标志

**Files:**
- Modify: `app/src/core/liveMemory/offsets.ts:638-664`
- Test: `app/test/core/liveMemoryOffsets.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/liveMemoryOffsets.test.ts` 末尾 `describe("offsetsForVersion", ...)` 块内追加：

```typescript
  it("exposes fallback flag via offsetsForVersionMeta", () => {
    // Exact match → fallback=false
    const exact = offsetsForVersionMeta("1.00.21")!;
    expect(exact.table.gameVersion).toBe("1.00.21");
    expect(exact.fallback).toBe(false);

    // Same-major.minor fallback (1.00.29 → 1.00.28) → fallback=true
    const fb = offsetsForVersionMeta("1.00.29")!;
    expect(fb.table.gameVersion).toBe("1.00.29");
    expect(fb.fallback).toBe(true);

    // v1.01.02 (not in table) falls back to v1.01.01 → fallback=true
    const v102 = offsetsForVersionMeta("1.01.02")!;
    expect(v102.table.gameVersion).toBe("1.01.02");
    expect(v102.fallback).toBe(true);

    // Different major.minor → null (no fallback available)
    expect(offsetsForVersionMeta("9.99.99")).toBeNull();
  });
```

并在文件顶部 import 中加入 `offsetsForVersionMeta`：

```typescript
import {
  offsetsForVersion,
  offsetsForVersionMeta,
  supportedVersions,
  plausiblePlayTime,
  plausibleStage,
  plausibleGold,
  plausibleWave,
} from "../../src/core/liveMemory/offsets";
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- liveMemoryOffsets`
Expected: FAIL，报 `offsetsForVersionMeta is not defined`。

- [ ] **Step 3: 实现 `offsetsForVersionMeta`**

在 `app/src/core/liveMemory/offsets.ts` 的 `offsetsForVersion` 函数之后（约第 664 行后）追加：

```typescript
/**
 * Like {@link offsetsForVersion} but also reports whether the result came from a
 * same-major.minor fallback. Callers that need to decide whether to trust
 * bundled RVAs (which drift across game patches even within the same minor)
 * use this to force a full extractor run instead of enrichment-only mode.
 *
 * Returns `{ table, fallback: false }` on exact match, `{ table, fallback: true }`
 * on fallback, or `null` when no same-major.minor candidate exists.
 */
export function offsetsForVersionMeta(
  version: string | null | undefined,
): { table: LiveOffsets; fallback: boolean } | null {
  if (!version) return null;
  const exact = TABLE[version];
  if (exact) return { table: exact, fallback: false };

  const parsed = parseVersion(version);
  if (!parsed) return null;

  let bestVersion: string | null = null;
  let bestDiff = Infinity;
  for (const known of Object.keys(TABLE)) {
    const pk = parseVersion(known);
    if (!pk) continue;
    if (pk[0] !== parsed[0] || pk[1] !== parsed[1]) continue;
    const diff = Math.abs(pk[2] - parsed[2]);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestVersion = known;
    }
  }
  if (bestVersion) {
    return { table: { ...TABLE[bestVersion], gameVersion: version }, fallback: true };
  }
  return null;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test -- liveMemoryOffsets`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add app/src/core/liveMemory/offsets.ts app/test/core/liveMemoryOffsets.test.ts
git commit -m "feat(liveMemory): expose fallback flag via offsetsForVersionMeta

Prep for forcing a full extractor run on fallback versions where bundled
RVAs have drifted. Pure addition — offsetsForVersion is unchanged."
```

---

## Task 2: `resolveOffsets` 在 fallback 时清零 critical RVA

**Files:**
- Modify: `app/src/main/liveMemory/liveReader.ts:356-463`
- Test: `app/test/main/liveReaderResolution.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/main/liveReaderResolution.test.ts` 末尾追加新 describe 块：

```typescript
describe("LiveMemoryReader fallback version handling", () => {
  // A version that falls back to v1.00.21 (same major.minor 1.00).
  // v1.00.21's table has non-zero critical RVAs (stageManager, stageCacheManager)
  // but is a fallback — those RVAs may have drifted in the real game build.
  const FALLBACK_VERSION = "1.00.20"; // not in TABLE, falls back to 1.00.21

  it("zeroes critical RVAs when the bundled table is a fallback", async () => {
    // Override the version read by detectGameVersion (mocked readFileSync).
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => FALLBACK_VERSION,
    }));
    stubs.cached = null;
    stubs.extracted = DERIVED;

    const reader = await attachFresh();

    // The extractor must have been called with enrichmentOnly=false (critical
    // path), which means an extraction attempt was recorded (not enrichment).
    expect(stubs.extractCalls).toBe(1);
    expect(stubs.recordCalls).toBe(1);
    expect(stubs.enrichmentRecordCalls).toBe(0);
    // Reader is supported because DERIVED fills the gaps.
    expect(reader.supported).toBe(true);
  });

  it("does NOT zero critical RVAs for an exact-match bundled version", async () => {
    // v1.00.21 is in the table → exact match, no fallback.
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readFileSync: () => "1.00.21",
    }));
    stubs.cached = null;
    // Extractor returns null — we only care that it ran in enrichment mode.
    stubs.extracted = null;

    await attachFresh();

    // Exact-match bundled table has critical offsets → isSupported=true →
    // extractor runs in enrichment mode (enrichment attempt recorded, not
    // critical).
    expect(stubs.enrichmentRecordCalls).toBe(1);
    expect(stubs.recordCalls).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- liveReaderResolution`
Expected: FAIL，`stubs.recordCalls` 为 0（因为当前 fallback 版本被当成 exact-match 一样处理，走 enrichment 路径）。

- [ ] **Step 3: 实现 fallback 清零逻辑**

在 `app/src/main/liveMemory/liveReader.ts` 顶部 import 中，把 `offsetsForVersion` 替换为同时导入两个函数：

```typescript
import {
  offsetsForVersion,
  offsetsForVersionMeta,
  type LiveOffsets,
} from "../../core/liveMemory/offsets";
```

（如果原 import 只导入了 `offsetsForVersion` 和 `LiveOffsets`，按需调整。先 Read 确认现有 import。）

修改 `resolveOffsets` 方法第 371-383 行。原代码：

```typescript
    const bundled = offsetsForVersion(version);
    if (bundled) {
      base = bundled;
      source = "bundled";
      this.log(`resolve: bundled table for v${version}`);
    } else if (cacheDir && version) {
```

改为：

```typescript
    const meta = offsetsForVersionMeta(version);
    if (meta) {
      if (meta.fallback) {
        // Fallback to a same-major.minor version: the bundled RVAs are from
        // the fallback version and may have drifted in the real game build.
        // Zero every TypeInfo RVA so the extractor runs the full critical
        // path (enrichmentOnly=false) and re-derives them from live memory.
        // Struct constants (heroRuntime, container, dict, …) are kept — they
        // are stable across patches within the same major.minor.
        base = {
          ...meta.table,
          typeInfoRva: {
            commonSaveData: 0n,
            currencyManager: 0n,
            stageCacheManager: 0n,
            stageManager: 0n,
            localInventoryManager: 0n,
            logManager: 0n,
            monsterSpawnManager: 0n,
          },
        };
        this.log(`resolve: bundled table for v${version} (fallback from v${meta.table.gameVersion === version ? "unknown" : meta.table.gameVersion} — critical RVAs zeroed, will re-derive)`);
      } else {
        base = meta.table;
        this.log(`resolve: bundled table for v${version}`);
      }
      source = "bundled";
    } else if (cacheDir && version) {
```

注意：fallback 分支的日志里 `meta.table.gameVersion` 此时已被 spread 复制为 `version`，所以判断"原 fallback 来源"需要在外层记录。简化为直接打印 fallback 标志即可，改为：

```typescript
        this.log(`resolve: bundled table for v${version} (fallback — critical RVAs zeroed for re-derivation)`);
```

（去掉那个三元判断。）

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test -- liveReaderResolution`
Expected: PASS。

如果 `attachFresh()` 用了 `vi.resetModules()` 导致 `vi.doMock` 不生效，改用 `vi.mock` + 在测试内通过 stubs 控制版本号。先 Read 现有 `attachFresh` 实现，确认 mock 策略。当前 `node:fs` 是 `vi.mock` 顶层固定的（返回 `VERSION = "9.99.99"`）。Step 1 的测试需要版本号可变 —— 改用 stubs 控制版本号更稳妥。

**修订 Step 1 测试**：不 mock `node:fs`，而是给 `attachFresh` 加参数：

```typescript
async function attachFresh(version: string = VERSION) {
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    existsSync: () => true,
    readFileSync: () => version,
  }));
  const { LiveMemoryReader } = await import("../../src/main/liveMemory/liveReader");
  const reader = new LiveMemoryReader();
  reader.attach("test-build");
  return reader;
}
```

并把顶层 `vi.mock("node:fs", ...)` 删除（或保留为默认，但 `vi.doMock` 在 `vi.resetModules` 后会覆盖）。确认 `vi.resetModules` + `vi.doMock` 的组合在 vitest 里生效。

- [ ] **Step 5: 运行全量 liveReader 测试确认无回归**

Run: `pnpm test -- liveReaderResolution`
Expected: 全部 PASS（包括原有的 6 个用例）。

- [ ] **Step 6: 提交**

```bash
git add app/src/main/liveMemory/liveReader.ts app/test/main/liveReaderResolution.test.ts
git commit -m "fix(liveMemory): zero critical RVAs on fallback versions

When offsetsForVersion falls back to a same-major.minor table (e.g. v1.01.02
→ v1.01.01), the bundled TypeInfo RVAs are from the fallback version and
have drifted in the real game build. Zeroing them forces the extractor to
run the full critical path (enrichmentOnly=false) and re-derive stageManager
/ stageCacheManager / logManager / monsterSpawnManager from live memory.

Restores XP/stage/DPS on v1.01.02 without shipping a new bundled table."
```

---

## Task 3: `findLogManager` 失败诊断 dump

**Files:**
- Modify: `app/src/core/liveMemory/il2cppScanner.ts:1079-1145` (`findLogManager` 返回 null 前加诊断)
- Modify: `app/src/main/liveMemory/offsetExtractor.ts:263-267` (消费诊断日志)
- Test: `app/test/core/liveMemoryIl2cppScanner.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/liveMemoryIl2cppScanner.test.ts` 末尾追加（如果该文件已有 FakeMemory 基础设施，复用之；否则参考现有用例的 setup 模式）：

```typescript
describe("findLogManager diagnostics", () => {
  it("emits diagnostic log when no GetBoxLog bucket validates", () => {
    // Build a fake memory layout where a static slot points at an object
    // whose dict has a non-empty bucket, but the entries are NOT GetBoxLog
    // (class name mismatch) and lack itemStringKey/itemGradeType fields.
    // findLogManager should return null AND emit a diagnostic describing
    // what it saw (bucket count, first entry class name).
    const { ctx, entries, logs } = buildFakeScanContextWithInvalidLogBucket();
    const result = findLogManager(ctx, entries);
    expect(result).toBeNull();
    const diagnostic = logs.find((l) => l.includes("[logManager-diag]"));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain("bucketCount=1");
    expect(diagnostic).toContain("firstEntryClassName=");
  });
});
```

（`buildFakeScanContextWithInvalidLogBucket` 是测试 helper，构造一个最小 fake memory：一个 static slot → object → dict → 一个 bucket，bucket 里有 1 个 entry，entry 的 class name 是 "SomeOtherClass"，classFields 是 `{foo: 0x10}`。）

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- liveMemoryIl2cppScanner`
Expected: FAIL，`logs` 为空或无 diagnostic 输出。

- [ ] **Step 3: 实现诊断 dump**

在 `app/src/core/liveMemory/il2cppScanner.ts` 的 `findLogManager` 函数（第 1079-1145 行）的 `return null`（第 1144 行）之前，加诊断收集。需要先让 `findLogManager` 接收一个可选的 `log` 回调，或返回诊断信息让 caller 打印。

**方案选择**：为保持 core 层纯净（不引入 log 依赖），改为让 `findLogManager` 在遍历过程中记录"最接近成功"的候选诊断，作为返回值的一部分。但 `findLogManager` 返回 null 时没有载体 —— 改为新增一个 `collectLogManagerDiagnostics` 导出函数，由 `offsetExtractor.ts` 在 `findLogManager` 返回 null 时调用。

在 `il2cppScanner.ts` `findLogManager` 之后追加：

```typescript
/**
 * Best-effort diagnostics for why {@link findLogManager} returned null.
 * Walks the same static slots, finds any object whose field at a candidate
 * logByType offset looks like a Dictionary (non-empty entries array), and
 * dumps the first bucket's list size + first entry's class name + class
 * fields. This pinpoints whether v1.01.02 renamed GetBoxLog, shifted the
 * EMonsterLogType offset, or restructured LogManager entirely.
 *
 * Pure-read, no state change. Returns a diagnostic string (possibly multi-line).
 */
export function collectLogManagerDiagnostics(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): string {
  const lines: string[] = [];
  let probed = 0;
  for (const entry of entries) {
    for (const { soff, value: inst } of ctx.staticSlots(entry.classPtr)) {
      for (const logOff of LOG_DICT_OFFSET_CANDIDATES) {
        const dictPtr = readPtr(ctx.reader, inst + BigInt(logOff));
        if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) continue;
        const entriesArr = readPtr(ctx.reader, dictPtr + BigInt(STRUCT_DICT.entries));
        if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) continue;
        const count = readI32(ctx.reader, dictPtr + BigInt(STRUCT_DICT.count));
        if (count == null || count <= 0 || count > MAX_LOG_DICT_ENTRIES) continue;
        // This looks like a real dict — dump its first bucket.
        const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
        const eBase = first;
        const listPtr = readPtr(ctx.reader, eBase + BigInt(STRUCT_DICT.entryValue));
        if (listPtr == null || !isPlausibleHeapPtr(listPtr)) {
          lines.push(`[logManager-diag] slotRva=0x${entry.slotRva.toString(16)} logOff=0x${logOff.toString(16)} dictCount=${count} bucketCount=null (no list ptr)`);
          continue;
        }
        const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
        const bucketCount = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
        let firstEntryClassName: string | null = null;
        let firstEntryFields: string | null = null;
        if (arr != null && bucketCount != null && bucketCount > 0) {
          const firstEntry = readPtr(ctx.reader, arr + BigInt(STRUCT_CONTAINER.arrayFirst));
          if (firstEntry != null && isPlausibleHeapPtr(firstEntry)) {
            firstEntryClassName = ctx.instanceClassName(firstEntry);
            const fields = ctx.instanceClassFields(firstEntry);
            if (fields != null) {
              const fl: string[] = [];
              for (const [fn, fo] of fields) fl.push(`${fn}=0x${fo.toString(16)}`);
              firstEntryFields = `[${fl.join(",")}]`;
            }
          }
        }
        lines.push(`[logManager-diag] slotRva=0x${entry.slotRva.toString(16)} logOff=0x${logOff.toString(16)} dictCount=${count} bucketCount=${bucketCount ?? "null"} firstEntryClassName=${firstEntryClassName ?? "null"} firstEntryFields=${firstEntryFields ?? "null"}`);
        probed++;
        if (probed >= 5) return lines.join("\n"); // cap output
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "[logManager-diag] no dict-shaped static slot found";
}
```

- [ ] **Step 4: 在 extractor 消费诊断**

在 `app/src/main/liveMemory/offsetExtractor.ts` 第 263-267 行（`findLogManager` 返回 null 的 else 分支），在现有 log 之后追加：

```typescript
  } else {
    log(
      `extract: logManager not derived (no validated GetBoxLog list — chest drops degrade); boxOpenLog.fields={itemStringKey:0x${boxOpenFields.itemStringKey.toString(16)},itemGradeType:0x${boxOpenFields.itemGradeType.toString(16)},gradeSO:0x${boxOpenFields.gradeSO.toString(16)},gradeSOGrade:0x${boxOpenFields.gradeSOGrade.toString(16)}}`,
    );
    // Dump candidate dict buckets so we can see WHY validation failed on
    // this game version. Capped at 5 candidates by collectLogManagerDiagnostics.
    const diag = collectLogManagerDiagnostics(ctx, entries);
    log(diag);
  }
```

并在 `offsetExtractor.ts` 顶部 import 中加入 `collectLogManagerDiagnostics`。

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test -- liveMemoryIl2cppScanner`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add app/src/core/liveMemory/il2cppScanner.ts app/src/main/liveMemory/offsetExtractor.ts app/test/core/liveMemoryIl2cppScanner.test.ts
git commit -m "feat(liveMemory): dump logManager candidate diagnostics on failure

When findLogManager returns null, emit up to 5 candidate dict buckets with
their bucketCount, first entry class name, and class fields. Lets us see
whether v1.01.02 renamed GetBoxLog, shifted EMonsterLogType offset, or
restructured LogManager — without a live debugger.

Pure-read diagnostic; no behavior change on the success path."
```

---

## Task 4: 放宽 `validateGetBoxLogList` 验证

**Files:**
- Modify: `app/src/core/liveMemory/il2cppScanner.ts:49` (常量改候选列表)
- Modify: `app/src/core/liveMemory/il2cppScanner.ts:564-577` (`validateGetBoxList`)
- Test: `app/test/core/liveMemoryIl2cppScanner.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/liveMemoryIl2cppScanner.test.ts` 追加：

```typescript
describe("validateGetBoxList tolerance", () => {
  it("accepts a GetBoxLog entry whose EMonsterLogType is at 0x48 instead of 0x50", () => {
    // Simulate v1.01.02 shifting the EMonsterLogType field offset.
    const { ctx, listPtr } = buildFakeGetBoxLogList({
      entryClassName: "GetBoxLog",
      monsterTypeOffset: 0x48,
      monsterTypeValue: 1,
      count: 1,
    });
    expect(validateGetBoxList(ctx, listPtr)).toBe(true);
  });

  it("accepts a GetBoxLog entry with obfuscated class name but valid EMonsterLogType", () => {
    // Simulate v1.01.02 renaming GetBoxLog → vb.bfne (namespace + obfuscated).
    // classNameMatches tolerates namespace prefix but NOT obfuscated short name.
    // Fallback: if the entry's class fields include a known GetBoxLog stable
    // field (e.g. "monsterLogType" or "EMonsterLogType"), accept it.
    const { ctx, listPtr } = buildFakeGetBoxLogList({
      entryClassName: "vb.bfne",
      entryFields: new Map([["monsterLogType", 0x50], ["stageKey", 0x10]]),
      monsterTypeOffset: 0x50,
      monsterTypeValue: 2,
      count: 1,
    });
    expect(validateGetBoxList(ctx, listPtr)).toBe(true);
  });
});
```

注意：`validateGetBoxList` 当前不是 export 的。需要在 `il2cppScanner.ts` 把它 export（或在测试里通过 `findGetBoxLogDict` 间接测）。先 Read 现有 export 情况。

**如果选择 export `validateGetBoxList`**：在函数声明加 `export`。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- liveMemoryIl2cppScanner`
Expected: FAIL，第一个用例因 `STRUCT_GETBOX_MONSTER_TYPE = 0x50` 硬编码读不到值而返回 false；第二个用例因类名 `vb.bfne` 不匹配 `GetBoxLog` 且无字段名 fallback 而返回 false。

- [ ] **Step 3: 实现放宽验证**

在 `app/src/core/liveMemory/il2cppScanner.ts` 第 49 行，把常量改为候选列表：

```typescript
/** GetBoxLog EMonsterLogType field offset candidates. The field has lived at
 *  0x50 on every version seen so far, but the field name is obfuscated so the
 *  byte offset is not name-stable. Probe a small candidate set rather than
 *  assume — extended for v1.01.02 where the offset may have shifted. */
const STRUCT_GETBOX_MONSTER_TYPE_CANDIDATES = [0x50, 0x48, 0x58, 0x40, 0x60];
```

修改 `validateGetBoxList`（第 564-577 行）。原代码：

```typescript
function validateGetBoxList(ctx: ScanContext, listPtr: bigint): boolean {
  const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (arr == null || count == null || count <= 0 || count > MAX_CHEST_LOG) return false;
  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);
  for (let i = 0; i < Math.min(count, LOG_VALIDATE_ENTRIES); i++) {
    const e = readPtr(ctx.reader, first + BigInt(i * 8));
    if (e == null || !isPlausibleHeapPtr(e)) return false;
    if (!isGetBoxLogClassName(ctx.instanceClassName(e))) return false;
    const mt = readI32(ctx.reader, e + BigInt(STRUCT_GETBOX_MONSTER_TYPE));
    if (mt == null || mt < 0 || mt > 2) return false;
  }
  return true;
}
```

改为：

```typescript
export function validateGetBoxList(ctx: ScanContext, listPtr: bigint): boolean {
  const arr = readPtr(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listItems));
  const count = readI32(ctx.reader, listPtr + BigInt(STRUCT_CONTAINER.listSize));
  if (arr == null || count == null || count <= 0 || count > MAX_CHEST_LOG) return false;
  const first = arr + BigInt(STRUCT_CONTAINER.arrayFirst);
  // Probe the first entry to discover the EMonsterLogType offset. Try each
  // candidate until one yields a value in {0,1,2}. If none does, the field
  // layout is unknown — reject.
  const firstEntry = readPtr(ctx.reader, first);
  if (firstEntry == null || !isPlausibleHeapPtr(firstEntry)) return false;
  const monsterTypeOff = resolveGetBoxMonsterTypeOffset(ctx, firstEntry);
  if (monsterTypeOff == null) return false;

  for (let i = 0; i < Math.min(count, LOG_VALIDATE_ENTRIES); i++) {
    const e = readPtr(ctx.reader, first + BigInt(i * 8));
    if (e == null || !isPlausibleHeapPtr(e)) return false;
    if (!isGetBoxLogClassName(ctx.instanceClassName(e))) {
      // Class-name gate failed. Try the field-name fallback: read this
      // entry's IL2CPP class fields and accept if a known GetBoxLog stable
      // field name is present. GetBoxLog's serialization-stable field is
      // "monsterLogType" (ES3 name). This covers per-build obfuscation that
      // renames the class beyond what classNameMatches tolerates.
      if (i === 0) {
        const fields = ctx.instanceClassFields(e);
        if (fields == null || !fields.has("monsterLogType")) return false;
        continue;
      }
      // Subsequent entries: trust the first entry's verdict (homogeneous list).
      continue;
    }
    const mt = readI32(ctx.reader, e + BigInt(monsterTypeOff));
    if (mt == null || mt < 0 || mt > 2) return false;
  }
  return true;
}

/** Discover the EMonsterLogType field offset on a GetBoxLog instance by
 *  probing candidate offsets. Returns the first offset whose value is in
 *  {0,1,2}, or null when none validates. Also tries the field name
 *  "monsterLogType" from the class metadata first (stable ES3 name). */
function resolveGetBoxMonsterTypeOffset(ctx: ScanContext, entryPtr: bigint): number | null {
  // 1. Named field lookup (most robust).
  const fields = ctx.instanceClassFields(entryPtr);
  if (fields != null) {
    const named = fields.get("monsterLogType");
    if (named != null && named > 0) {
      const v = readI32(ctx.reader, entryPtr + BigInt(named));
      if (v != null && v >= 0 && v <= 2) return named;
    }
  }
  // 2. Candidate offset probe.
  for (const off of STRUCT_GETBOX_MONSTER_TYPE_CANDIDATES) {
    const v = readI32(ctx.reader, entryPtr + BigInt(off));
    if (v != null && v >= 0 && v <= 2) return off;
  }
  return null;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test -- liveMemoryIl2cppScanner`
Expected: PASS。

- [ ] **Step 5: 运行全量 core 测试确认无回归**

Run: `pnpm test`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add app/src/core/liveMemory/il2cppScanner.ts app/test/core/liveMemoryIl2cppScanner.test.ts
git commit -m "fix(liveMemory): tolerate GetBoxLog class/offset shifts

validateGetBoxList now:
1. Probes EMonsterLogType offset across [0x50,0x48,0x58,0x40,0x60] instead
   of hardcoding 0x50 — covers v1.01.02 field shifts.
2. Falls back to the 'monsterLogType' ES3 field name when the class name is
   obfuscated beyond classNameMatches tolerance (mirrors validateBoxOpenList's
   field-name fallback).

Restores chest-drop tracking on versions that rename GetBoxLog or shift its
EMonsterLogType offset."
```

---

## Task 5: `findBoxOpenLogDictDirect` 兜底直查 BoxOpen bucket

**Files:**
- Modify: `app/src/core/liveMemory/il2cppScanner.ts` (新增函数)
- Modify: `app/src/main/liveMemory/offsetExtractor.ts:239-267` (findLogManager 失败时调兜底)
- Test: `app/test/core/liveMemoryIl2cppScanner.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/liveMemoryIl2cppScanner.test.ts` 追加：

```typescript
describe("findBoxOpenLogDictDirect fallback", () => {
  it("locates a BoxOpenLog bucket without going through GetBoxLog validation", () => {
    // Scenario: LogManager's dict has a BoxOpen bucket (key=2) whose entries
    // ARE valid BoxOpenLog instances (class name matches, itemStringKey field
    // present), but the GetBox bucket (key=3) is empty or has obfuscated
    // entries that fail validateGetBoxList. findLogManager returns null, but
    // findBoxOpenLogDictDirect should still find the BoxOpen bucket and
    // resolve its field offsets.
    const { ctx, entries } = buildFakeLayoutWithBoxOpenButNotGetBox();
    const result = findBoxOpenLogDictDirect(ctx, entries);
    expect(result).not.toBeNull();
    expect(result!.boxOpenTypeKey).toBe(2);
    expect(result!.logByType).toBe(0x28);
    expect(result!.boxOpenLog.itemStringKey).toBeGreaterThan(0);
    expect(result!.boxOpenLog.itemGradeType).toBeGreaterThan(0);
  });

  it("returns null when no dict has a valid BoxOpenLog bucket", () => {
    const { ctx, entries } = buildFakeLayoutWithNoValidBuckets();
    const result = findBoxOpenLogDictDirect(ctx, entries);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- liveMemoryIl2cppScanner`
Expected: FAIL，`findBoxOpenLogDictDirect is not defined`。

- [ ] **Step 3: 实现 `findBoxOpenLogDictDirect`**

在 `app/src/core/liveMemory/il2cppScanner.ts` 的 `findLogManager` 之后追加：

```typescript
/**
 * Direct fallback for {@link findLogManager} when GetBoxLog validation fails.
 * Walks every static slot's candidate logByType offsets, scans each dict's
 * buckets, and returns the first one whose value validates as a
 * `List<BoxOpenLog>` (via {@link validateBoxOpenList}, which has a field-name
 * fallback for obfuscated class names). Resolves BoxOpenLog field offsets
 * from the live first entry.
 *
 * Returns `{ slotRva, logByType, boxOpenTypeKey, boxOpenLog }` on success,
 * or null when no dict has a valid BoxOpen bucket. `getBoxTypeKey` is 0
 * (GetBoxLog chest-drop log is unavailable in this path — only loot tracking
 * is restored).
 *
 * This is the v1.01.02 safety net: when GetBoxLog's class name or
 * EMonsterLogType offset shifts beyond what validateGetBoxList tolerates
 * (even after Task 4's widening), the loot tracker can still function
 * because BoxOpenLog validation is more tolerant (field-name fallback).
 */
export function findBoxOpenLogDictDirect(
  ctx: ScanContext,
  entries: readonly ClassEntry[],
): {
  slotRva: bigint;
  logByType: number;
  boxOpenTypeKey: number;
  boxOpenLog: {
    itemStringKey: number;
    itemGradeType: number;
    gradeSO: number;
    gradeSOGrade: number;
    diagnostics?: string;
  };
} | null {
  for (const entry of entries) {
    for (const { value: inst } of ctx.staticSlots(entry.classPtr)) {
      for (const logOff of LOG_DICT_OFFSET_CANDIDATES) {
        const dictPtr = readPtr(ctx.reader, inst + BigInt(logOff));
        if (dictPtr == null || !isPlausibleHeapPtr(dictPtr)) continue;
        const entriesArr = readPtr(ctx.reader, dictPtr + BigInt(STRUCT_DICT.entries));
        if (entriesArr == null || !isPlausibleHeapPtr(entriesArr)) continue;
        const count = readI32(ctx.reader, dictPtr + BigInt(STRUCT_DICT.count));
        if (count == null || count <= 0 || count > MAX_LOG_DICT_ENTRIES) continue;
        const first = entriesArr + BigInt(STRUCT_CONTAINER.arrayFirst);
        for (let i = 0; i < count; i++) {
          const eBase = first + BigInt(i * STRUCT_DICT.entrySize);
          const hash = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryHash));
          if (hash == null || hash < 0) continue;
          const key = readI32(ctx.reader, eBase + BigInt(STRUCT_DICT.entryKey));
          if (key == null) continue;
          const listPtr = readPtr(ctx.reader, eBase + BigInt(STRUCT_DICT.entryValue));
          if (listPtr == null || !isPlausibleHeapPtr(listPtr)) continue;
          const firstEntryPtr = validateBoxOpenList(ctx, listPtr);
          if (firstEntryPtr == null) continue;
          // Found a BoxOpen bucket — resolve field offsets from the live entry.
          const boxOpenLog = findBoxOpenLogFields(ctx, entries, firstEntryPtr);
          return {
            slotRva: entry.slotRva,
            logByType: logOff,
            boxOpenTypeKey: key,
            boxOpenLog,
          };
        }
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: 在 extractor 消费兜底**

修改 `app/src/main/liveMemory/offsetExtractor.ts` 第 239-267 行。原代码在 `findLogManager` 失败时只 log。改为：

```typescript
  const lm = findLogManager(ctx, entries);
  const boxOpenFields = findBoxOpenLogFields(ctx, entries);
  // Fallback: when findLogManager fails (GetBoxLog validation rejected every
  // candidate), try to locate the BoxOpen bucket directly. This restores
  // loot tracking even when chest-drop (GetBoxLog) tracking is unavailable.
  const lmFallback = lm == null ? findBoxOpenLogDictDirect(ctx, entries) : null;
  if (lm) {
    let msg = `extract: logManager rva=0x${lm.slotRva.toString(16)} logByType=0x${lm.logByType.toString(16)} getBoxKey=${lm.getBoxTypeKey} boxOpenKey=${lm.boxOpenTypeKey} boxOpenLog.fields={itemStringKey:0x${lm.boxOpenLog.itemStringKey.toString(16)},itemGradeType:0x${lm.boxOpenLog.itemGradeType.toString(16)},gradeSO:0x${lm.boxOpenLog.gradeSO.toString(16)},gradeSOGrade:0x${lm.boxOpenLog.gradeSOGrade.toString(16)}}`;
    if (lm.boxOpenDiagnostics) {
      const d = lm.boxOpenDiagnostics;
      const ptrStr = d.firstEntryPtr == null ? "null" : `0x${d.firstEntryPtr.toString(16)}`;
      const countStr = d.bucketCount == null ? "null" : String(d.bucketCount);
      const nameStr = d.firstEntryClassName == null ? "null" : `"${d.firstEntryClassName}"`;
      msg += ` — validation failed: bucketCount=${countStr} firstEntryPtr=${ptrStr} firstEntryClassName=${nameStr}`;
      if (d.fieldsProbe) {
        log(d.fieldsProbe);
      }
    }
    if (lm.boxOpenLog.diagnostics) {
      log(lm.boxOpenLog.diagnostics);
    }
    log(msg);
  } else if (lmFallback) {
    log(
      `extract: logManager fallback (BoxOpen bucket direct) rva=0x${lmFallback.slotRva.toString(16)} logByType=0x${lmFallback.logByType.toString(16)} boxOpenKey=${lmFallback.boxOpenTypeKey} boxOpenLog.fields={itemStringKey:0x${lmFallback.boxOpenLog.itemStringKey.toString(16)},itemGradeType:0x${lmFallback.boxOpenLog.itemGradeType.toString(16)}} — getBoxKey=0 (chest-drop log unavailable)`,
    );
  } else {
    log(
      `extract: logManager not derived (no validated GetBoxLog list — chest drops degrade); boxOpenLog.fields={itemStringKey:0x${boxOpenFields.itemStringKey.toString(16)},itemGradeType:0x${boxOpenFields.itemGradeType.toString(16)},gradeSO:0x${boxOpenFields.gradeSO.toString(16)},gradeSOGrade:0x${boxOpenFields.gradeSOGrade.toString(16)}}`,
    );
    const diag = collectLogManagerDiagnostics(ctx, entries);
    log(diag);
  }
```

然后在返回的 `offsets` 对象里，把 `lm?.boxOpenLog.itemStringKey ?? boxOpenFields.itemStringKey` 改为也考虑 `lmFallback`：

```typescript
        boxOpenLog: {
          itemStringKey:
            lm?.boxOpenLog.itemStringKey ?? lmFallback?.boxOpenLog.itemStringKey ?? boxOpenFields.itemStringKey,
          itemGradeType:
            lm?.boxOpenLog.itemGradeType ?? lmFallback?.boxOpenLog.itemGradeType ?? boxOpenFields.itemGradeType,
          gradeSO: lm?.boxOpenLog.gradeSO ?? lmFallback?.boxOpenLog.gradeSO ?? boxOpenFields.gradeSO ?? 0,
          gradeSOGrade:
            lm?.boxOpenLog.gradeSOGrade ?? lmFallback?.boxOpenLog.gradeSOGrade ?? boxOpenFields.gradeSOGrade ?? 0,
          boxType: 0,
          level: 0,
        },
```

同样，`typeInfoRva.logManager` 和 `runtime.log.*` 也要考虑 `lmFallback`：

```typescript
      typeInfoRva: {
        commonSaveData: player?.commonSaveData ?? 0n,
        currencyManager: cm?.slotRva ?? 0n,
        stageCacheManager: scm?.slotRva ?? 0n,
        stageManager: sm?.slotRva ?? 0n,
        localInventoryManager: 0n,
        logManager: lm?.slotRva ?? lmFallback?.slotRva ?? 0n,
        monsterSpawnManager: msm?.slotRva ?? 0n,
      },
```

```typescript
        log: {
          logByType: lm?.logByType ?? lmFallback?.logByType ?? STRUCT_LOG_BY_TYPE,
          getBoxTypeKey: lm?.getBoxTypeKey ?? 0, // fallback path can't derive GetBox key
          stageClearTypeKey: STRUCT_STAGE_CLEAR_KEY,
          getItemWithBoxOpenTypeKey: lm?.boxOpenTypeKey ?? lmFallback?.boxOpenTypeKey ?? 0,
        },
```

并在 `offsetExtractor.ts` 顶部 import 中加入 `findBoxOpenLogDictDirect`。

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test -- liveMemoryIl2cppScanner`
Expected: PASS。

- [ ] **Step 6: 运行全量测试确认无回归**

Run: `pnpm test`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add app/src/core/liveMemory/il2cppScanner.ts app/src/main/liveMemory/offsetExtractor.ts app/test/core/liveMemoryIl2cppScanner.test.ts
git commit -m "feat(liveMemory): add findBoxOpenLogDictDirect fallback for loot tracking

When findLogManager fails (GetBoxLog validation rejects every candidate),
scan every static slot's dict directly for a BoxOpenLog bucket. BoxOpenLog
validation is more tolerant (field-name fallback for obfuscated class names),
so this restores loot tracking even when chest-drop tracking is unavailable.

getBoxTypeKey stays 0 in the fallback path — only loot (BoxOpenLog) is
restored, not the GetBox chest-drop log."
```

---

## Task 6: bump `EXTRACTOR_REVISION` + 集成验证

**Files:**
- Modify: `app/src/main/liveMemory/offsetExtractor.ts:53`

- [ ] **Step 1: bump extractor revision**

在 `app/src/main/liveMemory/offsetExtractor.ts` 第 53 行，把 `EXTRACTOR_REVISION = 8` 改为 `9`：

```typescript
export const EXTRACTOR_REVISION = 9; // Rev 9: fallback RVA zeroing + GetBoxLog tolerance + BoxOpen direct fallback
```

这让 `offsetHealing.ts` 的 `effectiveAttempts` 重置所有版本的尝试计数（`extractorRevision < EXTRACTOR_REVISION` → 返回 0），确保 v1.01.02 用户升级 companion 后立即获得新的尝试预算。

- [ ] **Step 2: 运行全量测试**

Run: `pnpm test`
Expected: 全部 PASS。

- [ ] **Step 3: 运行 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误。

- [ ] **Step 4: 构建 + 手动验证**

Run: `pnpm dev`

启动游戏（v1.01.02），观察 companion 日志。预期：

1. `resolve: bundled table for v1.01.02 (fallback — critical RVAs zeroed for re-derivation)`
2. `resolve: running extractor (attempt 1/3)` —— 注意是 critical 路径（attempt 1/3），不是 enrichment（attempt 1/1）
3. `extract: stageManager rva=0x...`（新 RVA，非 v1.01.01 的 `0x5dd8878`）
4. `extract: stageCacheManager rva=0x...`
5. `extract: monsterSpawnManager rva=0x5d8a8d8`（与诊断日志一致）
6. `extract: logManager rva=0x...` 或 `extract: logManager fallback (BoxOpen bucket direct)`
7. 经验 / stage / DPS / 掉落实时数据恢复

如果 step 6 仍是 `logManager not derived`，查看 `[logManager-diag]` 诊断日志，根据实际类名/字段调整 Task 4 的候选偏移或字段名。

- [ ] **Step 5: 提交**

```bash
git add app/src/main/liveMemory/offsetExtractor.ts
git commit -m "chore(liveMemory): bump EXTRACTOR_REVISION to 9

Resets per-version extraction attempt budgets so v1.01.02 users get a fresh
run of the improved extractor (fallback RVA zeroing + GetBoxLog tolerance +
BoxOpen direct fallback) on their next companion launch."
```

---

## 自审

**1. Spec 覆盖：**
- 经验/stage 不可用 → Task 1+2（fallback 清零 RVA，强制 critical 重派生）✓
- 掉落不可用 → Task 4+5（放宽 GetBoxLog 验证 + BoxOpen 直查兜底）✓
- DPS 部分不可用 → Task 1+2（critical RVA 重派生涵盖 monsterSpawnManager）✓；`runtime.monster.*` 硬编码回退若失效需另开任务，但当前诊断显示 RVA 已更新（`0x5d8a8d8`），硬编码回退很可能仍有效
- "自动修正"目标 → Task 1-6 全部是运行时自愈，无需手动发布新表 ✓
- 诊断需求 → Task 3 提供运行时诊断 dump ✓

**2. Placeholder 扫描：** 无 TBD/TODO/"implement later"。所有代码块完整。测试 helper（`buildFakeScanContextWithInvalidLogBucket` 等）需要实现者根据现有 `liveMemoryIl2cppScanner.test.ts` 的 FakeMemory 模式补全 —— 这是测试基础设施，不是占位符。

**3. Type 一致性：**
- `offsetsForVersionMeta` 返回 `{ table: LiveOffsets; fallback: boolean } | null`，Task 2 使用 `meta.fallback` / `meta.table` ✓
- `findBoxOpenLogDictDirect` 返回类型与 `findLogManager` 的子集一致（`slotRva`/`logByType`/`boxOpenTypeKey`/`boxOpenLog`），Task 5 的 extractor 合并逻辑一致 ✓
- `EXTRACTOR_REVISION` bump 从 8 → 9，`offsetHealing.ts` 已有 `extractorRevision` 比较逻辑 ✓

---

## 执行选择

**Plan complete and saved to `docs/superpowers/plans/2026-07-24-live-memory-v1-01-02-auto-recovery.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 每个 Task 派发独立 subagent，任务间 review，快速迭代。

**2. Inline Execution** - 在当前会话批量执行，带检查点 review。

**Which approach?**
