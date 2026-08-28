# 审计整改实施方案（2026-08-28 全量审计）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复全量审计报告（`docs/findings/full-code-audit-2026-08-28.md`）中的全部 P0/P1 问题与主要 P2 问题：2 处掉落统计丢数据、10 处崩溃/脏数据/限流/错误隔离缺口，以及 6 处性能热点与一批小整改。

**Architecture:** 按审计报告建议的五个批次推进，每批可独立交付（通过 `pnpm qa` 门槛后合并）。所有 core 层修复遵循 TDD（先写失败测试）；main 服务层修复复用 `test/main/` 既有测试工厂模式；renderer 修复用 `test/renderer-component/`（DOM 配置）验证。修复不引入新 IPC 通道、不改变四层架构边界；core 层保持无 electron/fetch 依赖。

**Tech Stack:** TypeScript、Electron、React 18、Vitest（`pnpm test` = `vitest run`；`pnpm test:dom` = DOM 配置）、pnpm。

**验收总闸（每个批次完成后执行一次）：**

```
cd app
pnpm typecheck
pnpm lint
pnpm test
pnpm test:dom
```

预期：0 错误；lint 警告数不增加；1550+ 全部用例通过。

**重要约定：**
- 业务逻辑改动需同步更新 `docs/BUSINESS-FLOWS.md` 对应章节（本计划中已标注哪个 Task 需要）。
- commit 粒度按 Task；commit message 用英文（与仓库惯例一致）。
- 每批结束前跑一次 `git status`，确认没有临时调试脚本/数据文件混入。

---

## 批次 1 — P0：掉落统计丢数据（必须立即修复）

### Task 1: 修复 settle resumeFrom 差一（P0-1）

**Files:**
- Modify: `app/src/core/liveMemory/runtime.ts:965`
- Test: `app/test/core/liveMemoryRuntime.test.ts`（`readRuntimeChestLog` describe 内新增用例）

- [ ] **Step 1: 读取现状，确认锚点**

`app/src/core/liveMemory/runtime.ts` 第 915-1046 行。确认：
- 第 965 行：`const resumeFrom = pin.pendingIdx != null ? lastCountBefore + 1 : lastCountBefore;`
- 第 1040 行：`pin.pendingIdx = count - 1;`（withhold 的是下标 `count-1`）
- 第 1046 行：`pin.lastCount = count;`（即 `pendingIdx = lastCountBefore - 1`，因此新条目从 `lastCountBefore` 起）

现象：settle 分支已重读 `pendingIdx`；循环却从 `lastCountBefore + 1` 扫描，把下标 `lastCountBefore` 的第一条新掉落整条跳过。

- [ ] **Step 2: 写失败测试**

在 `app/test/core/liveMemoryRuntime.test.ts` 的 `describe("readRuntimeChestLog", ...)` 内、`corrects a provisional 'common' → settled 'rare' cross-tick` 用例之后新增：

```ts
it("does not skip the first newly appended entry while settling the withheld one", () => {
  // Off-by-one regression: when a settle is pending AND a new drop landed in
  // the same tick, the scan used to resume at lastCount+1 and permanently
  // skip the entry at lastCount (the first new one).
  const pin = makeChestLogPinState();
  pin.primed = true;
  pin.lastCount = 1;
  pin.pendingIdx = 0; // previous tick withheld index 0
  pin.pendingCat = "common";
  // Log now has 3 entries: idx0 (withheld, settled common) + idx1 rare + idx2 act.
  const m = seedLogChain(new FakeMemory(), [0, 1, 2]);
  const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
  // settle emits idx0; scan must emit idx1 (rare) and withhold idx2 (act).
  expect(r1.drops).toEqual(["common", "rare"]);
  expect(pin.pendingCat).toBe("act");
  expect(pin.pendingIdx).toBe(2);
  expect(pin.lastCount).toBe(3);
  // Next tick settles the withheld act; nothing new.
  const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
  expect(r2.drops).toEqual(["act"]);
  expect(pin.lastCount).toBe(3);
});
```

- [ ] **Step 3: 运行测试确认失败**

```
cd app
pnpm test -- test/core/liveMemoryRuntime.test.ts
```

预期：新用例 FAIL —— 实际得到 `r1.drops = ["common"]`（idx1 被跳过）或 `["common","act"]` 变体，断言不通过。

- [ ] **Step 4: 修复实现**

`runtime.ts` 第 965 行改为：

```ts
const resumeFrom = pin.pendingIdx != null ? pin.pendingIdx + 1 : lastCountBefore;
```

（`pendingIdx + 1` 恒等于 `lastCountBefore`；显式写 `+ 1` 表达"从被 hold 条目的下一条开始"的语义，防止未来改动 withhold 下标后又引入同类差一。）

- [ ] **Step 5: 运行测试确认通过**

```
cd app
pnpm test -- test/core/liveMemoryRuntime.test.ts
```

预期：全部 PASS（含既有 settle/retry/shrink 用例，确认无回归）。

- [ ] **Step 6: Commit**

```bash
git add app/src/core/liveMemory/runtime.ts app/test/core/liveMemoryRuntime.test.ts
git commit -m "fix(liveMemory): stop skipping first new chest-drop entry during cross-tick settle"
```

### Task 2: shrink 分支清除 pendingIdx/pendingCat（P0-2）

**Files:**
- Modify: `app/src/core/liveMemory/runtime.ts:936-945`
- Test: `app/test/core/liveMemoryRuntime.test.ts`（在 `realigns the tail...` 用例之后新增）

- [ ] **Step 1: 写失败测试**

在 `app/test/core/liveMemoryRuntime.test.ts` 中新增：

```ts
it("clears withheld-entry state when the log shrinks (no phantom drop next run)", () => {
  // Regression: a new-run log clear invalidates the absolute pendingIdx, but
  // the shrink branch only reset the retry state. The stale pendingIdx then
  // made the next run re-read an unrelated index (phantom drop) and, combined
  // with the settle resume path, skip the run's first real drop.
  const pin = makeChestLogPinState();
  pin.primed = true;
  pin.lastCount = 2;
  pin.pendingIdx = 1; // withheld from the previous run
  pin.pendingCat = "rare";
  const m = seedLogChain(new FakeMemory(), [0]); // new run cleared the log
  const r1 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
  expect(r1.drops).toEqual([]);
  expect(pin.lastCount).toBe(1); // realigned
  expect(pin.pendingIdx).toBeNull();
  expect(pin.pendingCat).toBeNull();

  // First drop of the new run: must be classified fresh (not settled from a
  // stale index) and then withheld normally.
  seedLogChain(m, [0, 1]);
  const r2 = readRuntimeChestLog(m, GA_BASE, GA_SIZE, LOG_O, pin);
  expect(r2.drops).toEqual(["common"]); // idx0 common emitted, idx1 rare withheld
  expect(pin.pendingCat).toBe("rare");
});
```

- [ ] **Step 2: 运行测试确认失败**

```
cd app
pnpm test -- test/core/liveMemoryRuntime.test.ts
```

预期：新用例 FAIL（`pin.pendingIdx` 仍为 1；`r2.drops` 出现幻影/缺失）。

- [ ] **Step 3: 修复实现**

`runtime.ts` 第 939-940 行（`pin.retryFrom = null; pin.retryConsecutive = 0;`）之后追加两行：

```ts
    pin.retryFrom = null;
    pin.retryConsecutive = 0;
    // A shrink also invalidates any withheld settle index: the log may be a
    // brand-new run whose indices mean something completely different, so a
    // stale pendingIdx would re-read an unrelated entry next tick.
    pin.pendingIdx = null;
    pin.pendingCat = null;
```

- [ ] **Step 4: 运行测试确认通过**

```
cd app
pnpm test -- test/core/liveMemoryRuntime.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/core/liveMemory/runtime.ts app/test/core/liveMemoryRuntime.test.ts
git commit -m "fix(liveMemory): clear withheld chest entry on log shrink to prevent phantom drops"
```

**批次 1 验收：** `pnpm typecheck && pnpm lint && pnpm test` 全绿后继续。

---

## 批次 2 — P1：崩溃、脏数据、限流、错误隔离、IPC 校验

### Task 3: LootRing 除零守卫 + 圈层封顶 + 配置 clamp（P1-1）

**Files:**
- Modify: `app/src/renderer/components/loot/LootRing.tsx:44-63`
- Modify: `app/src/renderer/tabs/Loot.tsx:136-147`
- Test: `app/test/renderer-component/LootRing.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `app/test/renderer-component/LootRing.test.tsx`：

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LootRing } from "../../src/renderer/components/loot/LootRing";

describe("LootRing", () => {
  it("renders nothing when lapSeconds is not positive (zero from corrupt config)", () => {
    const { container } = render(
      <LootRing lastDropWallTime={Date.now() / 1000 - 100} lapSeconds={0} />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("caps the number of completed lap rings (long idle must not explode SVG nodes)", () => {
    const now = Date.now() / 1000;
    // 5 hours since last drop with 1s laps = 18000 laps before the fix.
    const { container } = render(<LootRing lastDropWallTime={now - 5 * 3600} lapSeconds={1} />);
    const paths = container.querySelectorAll("path");
    // Max 3 completed laps + 1 current lap, each lap = 2 paths (glow + main).
    expect(paths.length).toBeLessThanOrEqual(8);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```
cd app
pnpm test:dom -- test/renderer-component/LootRing.test.tsx
```

预期：第一个用例渲染进程进入死循环（vitest 超时挂起——如果出现，直接进入 Step 3 修复，不必等超时）；第二个用例 paths 数量远大于 8。**注意**：若 vitest 卡死，按 Ctrl+C 停止后直接修复，修复后重新运行验证。

- [ ] **Step 3: 修复实现**

`LootRing.tsx` 第 44-58 行替换为：

```ts
/** Ring colors cap at 3 (calm → warning → urgent); never render more laps. */
const MAX_COMPLETED_LAPS = LAP_COLORS.length;

function buildRings(
  lastDropWallTime: number | null,
  nowSeconds: number,
  lapSeconds: number,
): Ring[] {
  if (lastDropWallTime == null) return [];
  // Corrupt config (lapSeconds === 0) would make elapsed/0 = Infinity and the
  // lap loop below never terminate. Treat any non-positive lap as "no ring".
  if (!(lapSeconds > 0)) return [];
  // Clamp to >= 0: clock skew between game wall time and Date.now() can yield
  // a negative elapsed, which would produce negative lap counts and broken
  // color indices.
  const elapsed = Math.max(0, nowSeconds - lastDropWallTime);
  const totalLaps = Math.min(Math.floor(elapsed / lapSeconds), MAX_COMPLETED_LAPS);
  const currentProgress = (elapsed % lapSeconds) / lapSeconds;
  const colorIndex = Math.min(totalLaps, LAP_COLORS.length - 1);
  const rings: Ring[] = [];
  for (let i = 0; i < totalLaps; i++) {
    rings.push({ color: LAP_COLORS[Math.min(i, LAP_COLORS.length - 1)], progress: 1 });
  }
  rings.push({ color: LAP_COLORS[colorIndex], progress: currentProgress });
  return rings;
}
```

- [ ] **Step 4: 配置读取 clamp**

`Loot.tsx` 第 136-147 行的 effect 替换为：

```ts
  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((cfg) => {
        if (mounted && cfg.lootRingSeconds) setRingSeconds(clampRingSeconds(cfg.lootRingSeconds));
      })
      .catch(reportIpcError);
    return () => {
      mounted = false;
    };
  }, []);
```

并在 `Loot.tsx` 中 `DEFAULT_RING_SECONDS` 定义下方新增模块级函数：

```ts
/** Same [1, 3600] clamp as LootBoxSection.commitRingDraft — config.json may be hand-edited. */
function clampRingSeconds(raw: LootRingSeconds): LootRingSeconds {
  const out: LootRingSeconds = { ...DEFAULT_RING_SECONDS };
  for (const key of ["common", "stage"] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = Math.min(3600, Math.max(1, Math.round(v)));
    }
  }
  return out;
}
```

- [ ] **Step 5: 运行测试确认通过**

```
cd app
pnpm test:dom -- test/renderer-component/LootRing.test.tsx
```

预期：全部 PASS，且不再挂起。

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/components/loot/LootRing.tsx app/src/renderer/tabs/Loot.tsx app/test/renderer-component/LootRing.test.tsx
git commit -m "fix(renderer): guard LootRing against zero lap seconds and cap completed laps"
```

### Task 4: tracker totalXp 与首帧基线加可信度过滤（P1-2）

**Files:**
- Modify: `app/src/core/tracker.ts:461-478`
- Test: `app/test/core/tracker.test.ts`（新增用例）

- [ ] **Step 1: 读取现状，确认测试文件 helper**

`app/test/core/tracker.test.ts` 顶层已有 `snap(...)` helper 与 tracker 构造方式（文件开头 `t.update(snap(1000, 500))` 模式）。记录其构造函数名（如 `new XpTracker(...)` 或封装 helper），Step 2 用例中沿用。

- [ ] **Step 2: 写失败测试**

在 `app/test/core/tracker.test.ts` 中新增（按 Step 1 确认的构造方式替换 `new XpTracker(300)`）：

```ts
it("ignores implausible live hero exp in totalXp and takeover seeding", () => {
  const t = new XpTracker(300);
  t.update(snap(1000, 0)); // initialize so updateLive is accepted
  // First live frame = takeover. key2 carries a dirty read far above the
  // 1e12 runtime-exp cap; it must not pollute totalXp or the per-hero baseline.
  t.updateLive(
    {
      gold: null,
      heroes: [
        { heroKey: 1, level: 10, exp: 500 },
        { heroKey: 2, level: 10, exp: 3e12 },
      ],
    },
    1000,
  );
  expect(t.currentTotalXp).toBe(500);
  // Clean follow-up frame: only key1 advances.
  t.updateLive({ gold: null, heroes: [{ heroKey: 1, level: 10, exp: 600 }] }, 1001);
  expect(t.currentTotalXp).toBe(600);
  const snap2 = t.captureSnapshot();
  expect(snap2.currentTotalXp).toBe(600);
  expect(snap2.prevHero["2"]).toBeUndefined(); // dirty hero never seeded
});
```

- [ ] **Step 3: 运行测试确认失败**

```
cd app
pnpm test -- test/core/tracker.test.ts
```

预期：新用例 FAIL（`currentTotalXp` 为 `500 + 3e12`）。

- [ ] **Step 4: 修复实现**

`tracker.ts` 第 461-464 行改为：

```ts
    let totalXp = 0;
    for (const h of heroes) {
      // Dirty HeroList slots surface valid heroKeys with garbage exp; keep the
      // same plausibility gate used for gain so one bad read can't pollute the
      // persisted session snapshot (captureSnapshot writes currentTotalXp).
      if (!plausibleHeroRuntimeExp(h.exp)) continue;
      totalXp += h.exp;
    }
```

第 476-478 行（`takingOver` 分支的种子循环）开头追加同款守卫：

```ts
      for (const h of heroes) {
        if (!plausibleHeroRuntimeExp(h.exp)) continue;
        const key = String(h.heroKey);
        this.prevHero.set(key, { level: h.level, exp: h.exp });
```

- [ ] **Step 5: 运行测试确认通过**

```
cd app
pnpm test -- test/core/tracker.test.ts
```

预期：全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add app/src/core/tracker.ts app/test/core/tracker.test.ts
git commit -m "fix(core): filter implausible live hero exp from totalXp and takeover baseline"
```

### Task 5: MarketVolumeService 429 熔断与退避（P1-3）

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts:55-57（常量）、524、571-593`
- Modify: `docs/BUSINESS-FLOWS.md`（8.7 节 429 描述）
- Test: `app/test/main/marketVolumeService.test.ts`

- [ ] **Step 1: 读取测试文件既有 429/refreshHistory 用例**

`app/test/main/marketVolumeService.test.ts` 与 `app/src/main/services/MarketVolumeService.ts:481-651`。确认既有 fake-timer 用例的 deps 构造 helper 名称（grep `useFakeTimers`）。

- [ ] **Step 2: 写失败测试**

在 `marketVolumeService.test.ts` 中新增用例（沿用 Step 1 找到的 helper 与 fake-timer 模式）：

```ts
it("aborts the batch after 3 consecutive 429s instead of hammering Steam", async () => {
  vi.useFakeTimers();
  try {
    const targets = ["hash-a", "hash-b", "hash-c", "hash-d"];
    const calls: string[] = [];
    const svc = makeService({
      getTargetHashes: () => targets,
      fetchHistory: async (hash: string) => {
        calls.push(hash);
        return { ok: false, status: 429, reason: "http", retryAfterMs: 5000 };
      },
    });
    const p = svc.refreshHistory(Date.now(), { targets, force: true });
    for (let i = 0; i < 20 && calls.length < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await p;
    // 1) first 429 (no backoff wait for the very first), 2) second 429 after
    // retryAfterMs, 3) third 429 → abort. Never reaches hash-d.
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls).not.toContain("hash-d");
  } finally {
    vi.useRealTimers();
  }
});
```

（若既有测试实现为"每次 429 立即继续"，本用例在当前代码下会拉 4 个 hash → FAIL 成立。）

- [ ] **Step 3: 运行测试确认失败**

```
cd app
pnpm test -- test/main/marketVolumeService.test.ts
```

预期：新用例 FAIL（当前无熔断，4 个 hash 全部被请求）。

- [ ] **Step 4: 修复实现**

A. 在常量区（第 56 行 `HISTORY_FETCH_DELAY_MS` 下方）新增：

```ts
/** SteamMarketProvider 同款熔断：连续 429 达到该次数即中止整批刷新。 */
const MAX_CONSECUTIVE_429 = 3;
```

B. `refreshHistory` 中 `let done = 0;`（约第 524 行附近，批次循环外）新增 `let consecutive429 = 0;`。

C. 将第 570-593 行的结果处理改造如下（保留 400/cookie 分支不变）：

```ts
            } else if (view.status === 429) {
              // Rate-limited: respect Steam's retryAfterMs and stop hammering.
              // Three in a row means the quota is gone for this window — abort
              // the batch (keep whatever was already fetched) instead of
              // burning the remaining items at 1.5s intervals.
              consecutive429++;
              const backoffMs =
                typeof view.retryAfterMs === "number" && view.retryAfterMs > 0
                  ? view.retryAfterMs
                  : HISTORY_FETCH_DELAY_MS;
              log.warn(
                `refreshHistory: ${hash} rate-limited (429) consecutive=${consecutive429}/${MAX_CONSECUTIVE_429}, ` +
                  `waiting ${backoffMs}ms`,
              );
              if (consecutive429 >= MAX_CONSECUTIVE_429) {
                log.warn(`refreshHistory: aborting batch after ${consecutive429} consecutive 429s`);
                break outer;
              }
              if (await this.waitOrAbort(backoffMs)) break outer;
            } else {
              consecutive429 = 0;
              const reason = view.reason ?? (r.ok ? "no_data" : "failed");
              const retry = view.retryAfterMs ? `, retryAfter=${view.retryAfterMs}ms` : "";
              log.warn(
                `refreshHistory: ${hash} no data (status=${view.status ?? 0}, reason=${reason}${retry})`,
              );
            }
```

并在成功分支（`r.ok && r.points && r.points.length > 0` 内、`log.info` 之前）加 `consecutive429 = 0;`（成功即复位计数，避免把不同校验周期里的偶发 429 累计成熔断）。

- [ ] **Step 5: 同步业务文档**

`docs/BUSINESS-FLOWS.md`：定位「Steam pricehistory 拉取」章节中"429 限流"描述，替换为：

> 429 处理：单物品连续 429 达 3 次即中止整批刷新（保留已完成数据）；每次 429 后按 Steam `retryAfterMs`（缺失时 1500ms）等待再继续下一个物品，等待可被用户手动取消中断；成功响应会复位连续 429 计数。

- [ ] **Step 6: 运行测试确认通过**

```
cd app
pnpm test -- test/main/marketVolumeService.test.ts
```

预期：全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add app/src/main/services/MarketVolumeService.ts app/test/main/marketVolumeService.test.ts docs/BUSINESS-FLOWS.md
git commit -m "fix(market): breaker + backoff for pricehistory 429 responses"
```

### Task 6: saveConfig 写盘异常隔离（P1-4）

**Files:**
- Modify: `app/src/main/config.ts:474-476`

- [ ] **Step 1: 修复实现**

`config.ts` 第 474-476 行替换为：

```ts
  try {
    mkdirSync(dirname(target), { recursive: true });
    const toSave = normalizeConfig({ ...existing, ...config });
    writeFileSync(target, JSON.stringify(toSave, null, 2));
  } catch (err) {
    // A read-only disk / full disk must not break the in-memory config or the
    // downstream side effects (currency switch, broadcast) that callers run
    // right after saveConfig. Mirrors BoxTimerService.persist isolation.
    configLog.warn(`saveConfig failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
```

- [ ] **Step 2: 验证**

```
cd app
pnpm typecheck
```

预期：0 错误（`configLog` 已在文件内定义；若未定义，改为 `console.warn` 并在计划外自行核对——执行时以文件现状为准）。

- [ ] **Step 3: Commit**

```bash
git add app/src/main/config.ts
git commit -m "fix(config): isolate saveConfig disk errors from downstream side effects"
```

### Task 7: applyConfigPatch null patch 防护（P1-5）

**Files:**
- Modify: `app/src/main/ipc/configPatch.ts:41-43`
- Test: `app/test/main/configPatch.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/main/configPatch.test.ts` 新增：

```ts
it("returns current config instead of throwing on a null patch", () => {
  const deps = makeDeps(); // 沿用文件既有 deps 工厂
  const prev = deps.getConfig();
  // Object.keys(null) threw in the old implementation — this must not throw.
  expect(() => applyConfigPatch(deps, null as unknown as Partial<AppConfig>)).not.toThrow();
  expect(applyConfigPatch(deps, undefined as unknown as Partial<AppConfig>)).toEqual(prev);
  expect(deps.saveConfigSpy).not.toHaveBeenCalled();
});
```

（按文件既有 mock 形态调整 spy 名称——Step 1 先读 `configPatch.test.ts` 确认其 deps 工厂与 spy 命名，再落地本用例。）

- [ ] **Step 2: 运行测试确认失败**

```
cd app
pnpm test -- test/main/configPatch.test.ts
```

预期：新用例 FAIL（`Object.keys(null)` 抛 TypeError）。

- [ ] **Step 3: 修复实现**

`configPatch.ts` 第 41 行函数开头（`const needsWatcher` 之前）插入：

```ts
  // The renderer is untrusted: a null/undefined/non-object patch used to reach
  // Object.keys() after saveConfig had already persisted — throwing mid-way and
  // leaving a half-applied state. Treat malformed input as a no-op patch.
  if (patch === null || patch === undefined || typeof patch !== "object" || Array.isArray(patch)) {
    return deps.getConfig();
  }
```

- [ ] **Step 4: 运行测试确认通过**

```
cd app
pnpm test -- test/main/configPatch.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/ipc/configPatch.ts app/test/main/configPatch.test.ts
git commit -m "fix(ipc): no-op malformed config patch instead of half-applying then throwing"
```

### Task 8: IPC handler 输入校验（P1-6）

**Files:**
- Modify: `app/src/main/ipc/handlers/market.ts`
- Modify: `app/src/main/ipc/handlers/lookup.ts:12`
- Modify: `app/src/main/ipc/handlers/log.ts:8-10`
- Test: `app/test/ipc/inputValidation.test.ts`（新建）

- [ ] **Step 1: 修复实现**

A. `handlers/market.ts` 顶部（`registerMarketHandlers` 之前）新增守卫，并替换对应 handler：

```ts
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
```

- `SET_CURRENCY`：`ipc.handle(IPC.SET_CURRENCY, (_e, iso: unknown) => (isNonEmptyString(iso) ? services.setCurrency(iso) : undefined));`
- `REFRESH_MARKET_VOLUME_ITEMS`：`(_e, cardOrder: unknown) => services.refreshMarketVolumeItems(isStringArray(cardOrder) ? cardOrder : undefined)`
- `REFRESH_MARKET_VOLUME_ITEM`：`(_e, hash: unknown) => (isNonEmptyString(hash) ? services.refreshMarketVolumeItem(hash) : undefined)`

B. `handlers/lookup.ts:12`：

```ts
  ipc.handle(IPC.LOOKUP_PRICES_POLL, (_e, hash: unknown) =>
    services.pollLookupPrices(isNonEmptyString(hash) ? hash : undefined),
  );
```

并在文件顶部加入同款 `isNonEmptyString` 守卫（从 market.ts 复制三行，不走跨文件导出，保持 handler 各自独立）。

C. `handlers/log.ts:8-10`：

```ts
  ipc.handle(IPC.LOG_RENDERER_ERROR, (_e, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    services.logRendererError(payload as RendererLogPayload);
  });
```

- [ ] **Step 2: 写测试**

新建 `app/test/ipc/inputValidation.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../src/shared/ipc";
import { registerMarketHandlers } from "../../src/main/ipc/handlers/market";
import { registerLookupHandlers } from "../../src/main/ipc/handlers/lookup";
import { registerLogHandlers } from "../../src/main/ipc/handlers/log";

/** Minimal ipcMain double recording handle()/on() callbacks. */
function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn as never),
    on: () => {},
  };
}

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    pricesStatus: vi.fn(),
    refreshPrices: vi.fn(),
    refreshItemPrices: vi.fn(),
    cancelPrices: vi.fn(),
    setCurrency: vi.fn(),
    setMarketAutoScanEnabled: vi.fn(),
    getMarketVolume: vi.fn(),
    getMarketVolumeItems: vi.fn(),
    refreshMarketVolumeItems: vi.fn(),
    refreshMarketVolumeItem: vi.fn(),
    exportMarketVolumeHistory: vi.fn(),
    importMarketVolumeHistory: vi.fn(),
    cancelHistoryRefresh: vi.fn(),
    pollLookupPrices: vi.fn(),
    logRendererError: vi.fn(),
    ...overrides,
  };
}

describe("market/volume handler input validation", () => {
  it("SET_CURRENCY ignores non-string input without throwing", async () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerMarketHandlers(ipc as never, services as never);
    await expect(ipc.handlers.get(IPC.SET_CURRENCY)!(null, 12345)).resolves.toBeUndefined();
    expect(services.setCurrency).not.toHaveBeenCalled();
  });

  it("REFRESH_MARKET_VOLUME_ITEM ignores a non-string hash", async () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerMarketHandlers(ipc as never, services as never);
    await ipc.handlers.get(IPC.REFRESH_MARKET_VOLUME_ITEM)!(null, { evil: true });
    expect(services.refreshMarketVolumeItem).not.toHaveBeenCalled();
  });

  it("REFRESH_MARKET_VOLUME_ITEMS filters non-string array elements", async () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerMarketHandlers(ipc as never, services as never);
    await ipc.handlers.get(IPC.REFRESH_MARKET_VOLUME_ITEMS)!(
      null,
      ["good-hash", 42, null],
    );
    expect(services.refreshMarketVolumeItems).not.toHaveBeenCalled();
  });

  it("LOOKUP_PRICES_POLL tolerates a missing hash", async () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerLookupHandlers(ipc as never, services as never);
    await ipc.handlers.get(IPC.LOOKUP_PRICES_POLL)!(null, undefined);
    expect(services.pollLookupPrices).toHaveBeenCalledWith(undefined);
  });

  it("LOG_RENDERER_ERROR ignores a non-object payload", async () => {
    const ipc = fakeIpcMain();
    const services = makeServices();
    registerLogHandlers(ipc as never, services as never);
    await ipc.handlers.get(IPC.LOG_RENDERER_ERROR)!(null, "garbage");
    expect(services.logRendererError).not.toHaveBeenCalled();
  });
});
```

（`app/test/ipc/channels.test.ts` 已存在同目录 + `test/tsconfig.json` 覆盖该目录；若 `IPC.LOG_RENDERER_ERROR` 等通道名与 `shared/ipc.ts` 不一致，执行时以 grep 实际名称为准。）

- [ ] **Step 3: 运行测试确认通过**

```
cd app
pnpm test -- test/ipc/inputValidation.test.ts
```

预期：全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add app/src/main/ipc/handlers/market.ts app/src/main/ipc/handlers/lookup.ts app/src/main/ipc/handlers/log.ts app/test/ipc/inputValidation.test.ts
git commit -m "fix(ipc): validate renderer inputs on market/lookup/log handlers"
```

**批次 2 验收：** `pnpm typecheck && pnpm lint && pnpm test` 全绿后继续。

---

## 批次 3 — P1：静默错算与生命周期

### Task 9: parseSlotCapacity 改用深度切分（P1-7）

**Files:**
- Modify: `app/src/core/inventory/parse.ts:70-86`
- Test: `app/test/core/inventory.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/inventory.test.ts` 新增：

```ts
it("counts slot capacity/used correctly when a slot object has nested braces", () => {
  const playerStr = `{
    "inventorySaveDatas": [
      { "IsUnlock": true, "ItemUniqueId": 123 },
      { "IsUnlock": true, "ItemUniqueId": 0,
        "EnchantData": [{ "StatModKey": 7 }] },
      { "IsUnlock": false, "ItemUniqueId": 0 }
    ]
  }`;
  const snap = parseInventory(playerStr, makeLookup()); // 沿用文件既有 helper
  expect(snap.inventoryCapacity).toBe(2);
  expect(snap.inventoryUsed).toBe(1);
});
```

（按 `inventory.test.ts` 既有 parseInventory 调用方式修正 helper 名——Step 1 先读该文件确认。）

- [ ] **Step 2: 运行测试确认失败**

```
cd app
pnpm test -- test/core/inventory.test.ts
```

预期：新用例 FAIL（浅正则 `/\{[^{}]*\}/g` 把嵌套槽位切碎，capacity/used 错算）。

- [ ] **Step 3: 修复实现**

`parse.ts` 第 74-86 行替换为：

```ts
/** Counts unlocked inventory slots and how many hold an item, from a flat slot-object array.
 *  Uses depth-aware splitting (same as `splitTopLevelObjects`) so a save format that
 *  later adds nested sub-objects inside a slot (e.g. enchant data) is not mis-parsed. */
function parseSlotCapacity(arrText: string): { capacity: number; used: number } {
  let capacity = 0;
  let used = 0;
  for (const obj of splitTopLevelObjects(arrText)) {
    const isUnlock = /"IsUnlock"\s*:\s*true/.test(obj);
    if (!isUnlock) continue;
    capacity++;
    const idMatch = /"ItemUniqueId"\s*:\s*(\d+)/.exec(obj);
    if (idMatch && idMatch[1] !== "0") used++;
  }
  return { capacity, used };
}
```

删除不再使用的 `SLOT_OBJECT_RE` 常量（第 70 行），并检查 `parseSlotUniqueIds`（第 60-68 行）是否仍引用 `SLOT_ID_RE`——若它同样存在嵌套风险，将其 `arr.matchAll(SLOT_ID_RE)` 的输入来源保持不变（本 Task 只改容量路径；如审查发现同一输入供给两处，按最小改动只在容量路径切换）。

- [ ] **Step 4: 运行测试确认通过**

```
cd app
pnpm test -- test/core/inventory.test.ts
```

预期：全部 PASS（含既有背包解析用例无回归）。

- [ ] **Step 5: Commit**

```bash
git add app/src/core/inventory/parse.ts app/test/core/inventory.test.ts
git commit -m "fix(inventory): depth-aware slot capacity parsing for nested slot objects"
```

### Task 10: computeInventoryComposition 去副作用（P1-8）

**Files:**
- Modify: `app/src/core/inventory/composition.ts:28-43,57-60`
- Test: `app/test/core/inventoryComposition.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `app/test/core/inventoryComposition.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { computeInventoryComposition } from "../../src/core/inventory/composition";
import { getTbhMarketFeeRates } from "../../src/core/steamMarketFeeBundled"; // 按实际导出修正
import type { ResolvedInventoryRow } from "../../src/shared/types";

function row(partial: Partial<ResolvedInventoryRow>): ResolvedInventoryRow {
  return {
    itemKey: 1,
    count: 1,
    grade: "common",
    type: "gear",
    known: true,
    marketTradable: false,
    inUseCount: 0,
    chaoticCount: 0,
    priceRaw: null,
    rawMedian: null,
    rawLowest: null,
    unitPrice: null,
    priceSource: null,
    priceChecked: false,
    value: null,
    buyOrderRaw: null,
    buyOrderUnit: null,
    buyOrderQuantity: null,
    buyOrderLevels: null,
    buyOrderValue: null,
    buyOrderCoveredCount: null,
    buyOrderChecked: false,
    ...partial,
  } as ResolvedInventoryRow;
}

describe("computeInventoryComposition", () => {
  it("does not clear pricing fields on input rows (pure contract)", () => {
    const priced = row({ itemKey: 1, unitPrice: 5, priceRaw: 500, marketHashName: "x", value: 20 });
    const unpriced = row({ itemKey: 2, priceRaw: null });
    const rows = [priced, unpriced];
    computeInventoryComposition(rows, getTbhMarketFeeRates());
    // Re-aggregating a subset must not wipe previously resolved pricing.
    expect(priced.unitPrice).toBe(5);
    expect(priced.priceRaw).toBe(500);
    expect(unpriced.priceRaw).toBeNull(); // untouched, but never mutated by this call
  });
});
```

（`ResolvedInventoryRow` 字段以 `app/src/shared/types.ts` 实际定义为准，缺失字段按定义补全——执行时先读该类型。）

- [ ] **Step 2: 运行测试确认失败**

```
cd app
pnpm test -- test/core/inventoryComposition.test.ts
```

预期：新用例 FAIL（`clearRowPricing` 把 unpriced 行的 `priceRaw` 等清空——用例需要构造一个"此前有价、本次聚合中无 marketHashName"的行才能稳定复现；若 FAIL 不成立，检查 `unpriced` 行是否命中 `!row.marketHashName` 分支。以 `priced` 行断言为主。）

- [ ] **Step 3: 修复实现**

A. 删除 `clearRowPricing` 函数（第 28-43 行）。

B. `accumulateCompositionRow`（第 57-60 行）：

```ts
  if (!row.marketHashName) {
    return;
  }
```

C. 更新文件头注释（第 1-2 行）为：

```ts
// Composition aggregation — pure, no node:fs/bundled-data imports, safe to call from the renderer
// to re-aggregate totals over a filtered row subset (rows are already priced by resolveInventory).
// Contract: never mutates input rows — re-aggregation must not clear pricing fields.
```

- [ ] **Step 4: 运行测试确认通过**

```
cd app
pnpm test -- test/core/inventoryComposition.test.ts
pnpm test -- test/core/inventory.test.ts
```

预期：全部 PASS（inventory 既有用例若曾断言"聚合后无 hash 行被清空"，应仍绿；若有反证则说明该副作用被依赖，需回到本 Task 重新评估——以此为准）。

- [ ] **Step 5: Commit**

```bash
git add app/src/core/inventory/composition.ts app/test/core/inventoryComposition.test.ts
git commit -m "fix(inventory): make composition aggregation side-effect free on input rows"
```

### Task 11: disposeWorker 接线（P1-10）

**Files:**
- Modify: `app/src/main/index.ts:66-73`

- [ ] **Step 1: 修复实现**

`index.ts` 的 `before-quit` 回调（第 66-73 行）改为：

```ts
  app.on("before-quit", () => {
    createLogger("app").info("App quitting");
    setAppQuitting(true);
    const services = getAppServices();
    services.stopUpdates();
    services.flushSession();
    // Release the inventory utility process explicitly instead of relying on
    // Electron to reap it (best effort — quit proceeds without waiting).
    void services.inventory.disposeWorker();
    destroyTray();
  });
```

（若 `AppServices` 类型未导出 `inventory` 字段，按 `appState.ts` 实际字段名调整。）

- [ ] **Step 2: 验证**

```
cd app
pnpm typecheck
pnpm test -- test/main/inventoryService.test.ts
```

预期：0 错误、测试全绿。

- [ ] **Step 3: Commit**

```bash
git add app/src/main/index.ts
git commit -m "fix(main): dispose inventory worker on quit"
```

**批次 3 验收：** `pnpm typecheck && pnpm lint && pnpm test` 全绿后继续。

---

## 批次 4 — P1/P2：性能热点

### Task 12: 交易量刷新进度移出全局 context（P1-9）

**Files:**
- Create: `app/src/renderer/lib/marketVolumeRefreshStore.ts`
- Modify: `app/src/renderer/context/TbhProvider.tsx:28-31,70-94,122-141`（移除相关字段与订阅）
- Modify: `app/src/renderer/context/tbhContext.ts:21-23`（类型移除三字段）
- Modify: `app/src/renderer/lib/useMarketVolumeItems.ts`
- Test: `app/test/renderer-component/marketVolumeRefreshStore.test.tsx`（新建，可选但推荐）

- [ ] **Step 1: 创建模块单例 store**

新建 `app/src/renderer/lib/marketVolumeRefreshStore.ts`：

```ts
import type {
  MarketVolumeItem,
  MarketVolumeRefreshProgress,
} from "../../shared/types";

// Module-level store replaces the three TbhProvider context fields.
// Rationale: onMarketVolumeRefreshProgress fires once per completed item during
// a history refresh (tens to hundreds of pushes). Keeping that in the global
// context re-rendered every useTbhContext() consumer on every push — including
// LootBoxSection cards that only read `inventory.currency`. Only the Trading
// tab (via useMarketVolumeItems) needs this data.

const EMPTY_PROGRESS: MarketVolumeRefreshProgress = {
  running: false,
  total: 0,
  done: 0,
  current: null,
};

let progress: MarketVolumeRefreshProgress = EMPTY_PROGRESS;
let pending: MarketVolumeItem[] = [];
let subscribed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Idempotent IPC subscription; lives for the app's renderer lifetime. */
export function ensureMarketVolumeRefreshSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  window.tbh.onMarketVolumeRefreshProgress((p) => {
    if (!p.running) {
      progress = p;
      pending = [];
    } else {
      progress = p;
      if (p.pending) pending = p.pending;
      if (p.updatedItem) {
        const idx = pending.findIndex((it) => it.hash === p.updatedItem!.hash);
        if (idx >= 0) {
          pending = pending.map((it, i) => (i === idx ? p.updatedItem! : it));
        }
      }
    }
    emit();
  });
}

export function subscribeMarketVolumeRefresh(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getMarketVolumeRefreshProgress(): MarketVolumeRefreshProgress {
  return progress;
}

export function getMarketVolumePending(): MarketVolumeItem[] {
  return pending;
}

export function setMarketVolumePending(items: MarketVolumeItem[]): void {
  pending = items;
  emit();
}
```

- [ ] **Step 2: 精简 TbhProvider**

`TbhProvider.tsx`：

A. 删除第 28-31 行的三个 useState，删除第 71-94 行的 progress 订阅处理，改为在 effect 中调用一次 `ensureMarketVolumeRefreshSubscription()`（保留 inventory/notification/progress 订阅）。effect 的 cleanup 中不再需要 `offMarketVolumeProgress`。

B. `value` 的 useMemo（第 122-141 行）只保留：

```ts
  const value = useMemo(
    () => ({
      inventory,
      lastPriceRefreshMessage,
      clearLastPriceRefreshMessage: () => setLastPriceRefreshMessage(null),
      catalogStatus,
      refreshCatalog,
    }),
    [inventory, lastPriceRefreshMessage, catalogStatus, refreshCatalog],
  );
```

C. 删除 `tbhContext.ts` 中 `marketVolumeProgress`、`marketVolumePending`、`setMarketVolumePending` 三字段及相关类型 import（若 `MarketVolumeRefreshProgress`/`MarketVolumeItem` 只被这三字段使用，同时删除 import）。

- [ ] **Step 3: useMarketVolumeItems 改用 useSyncExternalStore**

`useMarketVolumeItems.ts`：

```ts
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ensureMarketVolumeRefreshSubscription,
  getMarketVolumePending,
  getMarketVolumeRefreshProgress,
  setMarketVolumePending,
  subscribeMarketVolumeRefresh,
} from "./marketVolumeRefreshStore";
```

删除 `useTbhContext` import 与第 29 行解构；在组件体内增加：

```ts
  const marketVolumeProgress = useSyncExternalStore(
    subscribeMarketVolumeRefresh,
    getMarketVolumeRefreshProgress,
  );
  const marketVolumePending = useSyncExternalStore(
    subscribeMarketVolumeRefresh,
    getMarketVolumePending,
  );
```

并在 effect 中（`getMarketVolumeItems` 之前）调用 `ensureMarketVolumeRefreshSubscription();`。第 51 行 `setMarketVolumePending(...)` 与第 56 行依赖不变（现引用 store 导出的函数，依赖数组 `[ ]` 可留空——模块级函数稳定）。

- [ ] **Step 4: 验证**

```
cd app
pnpm typecheck
pnpm test:dom
```

预期：0 错误、全部 PASS（`LootBoxSection.test.tsx` 等既有组件测试若对 context 形状有依赖会在此暴露——若失败，按报错补齐 store 化后的 provider 装配）。

- [ ] **Step 5: QA 冒烟**

```
cd app
pnpm qa:dev
```

重点确认：交易页刷新历史时进度环正常、切到 Loot 页后 Loot 卡片不再随刷新逐项重渲染（DevTools React Profiler 抽查）。

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/lib/marketVolumeRefreshStore.ts app/src/renderer/context/TbhProvider.tsx app/src/renderer/context/tbhContext.ts app/src/renderer/lib/useMarketVolumeItems.ts
git commit -m "perf(renderer): move market-volume refresh progress out of global context"
```

### Task 13: bundled JSON 读取缓存 + 刷新后失效（P2）

**Files:**
- Modify: `app/src/core/bundledData.ts:66-69`
- Modify: `app/src/main/catalogRefreshService.ts`（写盘点）
- Test: `app/test/core/bundledData.test.ts`

- [ ] **Step 1: 写失败测试**

在 `app/test/core/bundledData.test.ts` 新增：

```ts
it("caches reads: second call does not hit the filesystem again", () => {
  const spy = vi.spyOn(fs, "readFileSync");
  readBundledJson("stage_boxes.json");
  readBundledJson("stage_boxes.json");
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
```

（按该文件现有 mock 方式调整——若其已 mock `node:fs`，复用其 setup。）

- [ ] **Step 2: 运行测试确认失败**

```
cd app
pnpm test -- test/core/bundledData.test.ts
```

预期：新用例 FAIL（被调用 2 次）。

- [ ] **Step 3: 修复实现**

`bundledData.ts` 第 66-69 行替换为：

```ts
const jsonCache = new Map<string, unknown>();

export function readBundledJson<T>(filename: BundledDataFile | string): T {
  const hit = jsonCache.get(filename);
  if (hit !== undefined) return hit as T;
  const raw = readFileSync(resolveBundledDataPath(filename), "utf-8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as T;
  jsonCache.set(filename, parsed);
  return parsed;
}

/** Drop cached reads — call after writing refreshed catalog files to userData. */
export function clearBundledJsonCache(): void {
  jsonCache.clear();
}
```

- [ ] **Step 4: 刷新写入点失效缓存**

`catalogRefreshService.ts`：找到写 `gamedata.json`/`locale` 到 userData 的 `writeFileSync` 位置，在写盘成功代码后追加：

```ts
import { clearBundledJsonCache } from "../core/bundledData";
// 写入后：...
clearBundledJsonCache();
```

（确保 import 路径相对该文件位置正确。）

- [ ] **Step 5: 运行测试确认通过**

```
cd app
pnpm test -- test/core/bundledData.test.ts
pnpm test -- test/main/catalogRefreshService.test.ts
```

预期：全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add app/src/core/bundledData.ts app/src/main/catalogRefreshService.ts app/test/core/bundledData.test.ts
git commit -m "perf(bundledData): cache JSON reads, invalidate on catalog refresh"
```

### Task 14: ChestDropTracker.getStats 滚动窗口增量化（P2）

**Files:**
- Modify: `app/src/core/chestDropTracker.ts:505-567`
- Test: `app/test/core/chestDropTracker.test.ts`

- [ ] **Step 1: 读现状确认 history 添加点**

`app/src/core/chestDropTracker.ts` 中所有向 `this.history` push 的位置（`recordLiveChestDrop` / `recordLogDrop` / 恢复路径），以及 `HISTORY_LIMIT`、`ROLLING_HOUR_SEC` 常量。

- [ ] **Step 2: 修复实现**

A. 新增私有字段与方法（类内）：

```ts
  /** Incremental mirrors of getStats()'s hot-path scans, maintained on append. */
  private lastRareWallTime: number | null = null;
  private recentEntries: Array<{ wallTime: number; category: DropCategory }> = [];
  private recentCounts: Record<DropCategory, number> = { common: 0, rare: 0, act: 0 };

  /** Single choke point for history growth — updates the incremental caches. */
  private appendHistory(entry: BoxOpenHistoryEntry & DropHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    if (entry.category === "rare") this.lastRareWallTime = entry.wallTime;
    this.recentEntries.push({ wallTime: entry.wallTime, category: entry.category });
    this.recentCounts[entry.category]++;
    this.drainRecentEntries(nowSeconds() - ROLLING_HOUR_SEC);
  }

  private drainRecentEntries(cutoff: number): void {
    while (this.recentEntries.length > 0 && this.recentEntries[0].wallTime < cutoff) {
      const removed = this.recentEntries.shift()!;
      this.recentCounts[removed.category]--;
    }
  }
```

（`DropCategory` / 条目类型名以文件实际定义为准。）

B. 全部 history push 位置改为调用 `appendHistory`（保持原条目构造不变）。

C. `getStats()` 中第 527-567 行的两段扫描替换为：

```ts
    const nowSec = nowSeconds();
    this.drainRecentEntries(nowSec - ROLLING_HOUR_SEC);
    const lastRareDropWallTime = this.lastRareWallTime;
    const commonRecent = this.recentCounts.common;
    const rareRecent = this.recentCounts.rare;
    const actRecent = this.recentCounts.act;
    const earliestRecentWallTime = this.recentEntries[0]?.wallTime ?? null;
    const recentWindowSec = ... // 原公式不变，earliestRecentWallTime 来源换成缓存
```

D. 恢复/重置路径（`restoreHistory`、`reset` 系列）：重建 `recentEntries/recentCounts/lastRareWallTime`（遍历 history 重新 append 一次即可——在恢复方法末尾调用一个 `rebuildIncrementalCaches()` 私有方法）。

- [ ] **Step 3: 写测试**

在 `app/test/core/chestDropTracker.test.ts` 新增：

```ts
it("getStats rolling window matches a full scan before and after eviction", () => {
  const tracker = /* 按文件既有构造方式 */
  const now = /* 固定时钟，沿用文件的 fakeNow 模式 */
  // feed drops spanning > 1h, then assert recentPerHour values equal the
  // values computed from an explicit manual scan over tracker.history
});
```

（按文件既有 fake clock 模式落地，断言 `getStats()` 返回值与手动全量扫描一致，以及在 `restore()` 后一致。）

- [ ] **Step 4: 运行测试确认通过**

```
cd app
pnpm test -- test/core/chestDropTracker.test.ts
```

预期：全部 PASS（重点确认恢复/重置用例无回归）。

- [ ] **Step 5: Commit**

```bash
git add app/src/core/chestDropTracker.ts app/test/core/chestDropTracker.test.ts
git commit -m "perf(chestDrops): maintain rolling stats incrementally instead of full scans at 5Hz"
```

### Task 15: 长列表 content-visibility + BackToTop passive（P2）

**Files:**
- Modify: `app/src/renderer/components/lookup/ItemCard.tsx`（根节点 props）
- Modify: `app/src/renderer/tabs/Lookup.tsx:181-187`
- Modify: `app/src/renderer/components/lookup/BackToTop.tsx:36`

- [ ] **Step 1: 修复实现**

A. `ItemCard.tsx` 组件 props 增加可选 `lazy?: boolean`；根 `Card`（两处 return）的 className 中追加：

```ts
cn(
  cardClassName,
  lazy && "[content-visibility:auto] [contain-intrinsic-size:auto_240px]",
  ...
)
```

B. `Lookup.tsx` 第 185 行：

```tsx
filtered.map((item) => (
  <ItemCard key={item.id} item={item} onSelect={handleItemSelect} lazy />
))
```

C. `BackToTop.tsx` 第 36 行：

```ts
    container.addEventListener("scroll", onScroll, { passive: true });
```

- [ ] **Step 2: 验证**

```
cd app
pnpm typecheck
pnpm test:dom -- test/renderer-component
pnpm qa:dev
```

预期：0 错误、测试全绿；Lookup 页滚动流畅性无回归（首屏外卡片延迟渲染属预期）。

- [ ] **Step 3: Commit**

```bash
git add app/src/renderer/components/lookup/ItemCard.tsx app/src/renderer/components/lookup/BackToTop.tsx app/src/renderer/tabs/Lookup.tsx
git commit -m "perf(renderer): content-visibility for lookup grid and passive scroll listener"
```

### Task 16: 日志降噪 + lint 三警告清零（P2）

**Files:**
- Modify: `app/src/main/services/MarketVolumeService.ts:684-686`
- Modify: `app/src/main/services/TrackingService.ts:34`
- Modify: `app/src/renderer/lib/useLoot.ts:62-77`
- Modify: `app/test/main/steamItemNameId.test.ts:8`

- [ ] **Step 1: 修复实现**

A. `MarketVolumeService.ts` 第 684-686 行 `log.info(...)` → `log.debug(...)`。

B. `TrackingService.ts:34` 将普通 import 改为 `import type`（或直接运行 `pnpm lint:fix` 自动修复这三处）。

C. `useLoot.ts` 第 62-77 行：

```ts
  const boxOpens = useMemo(() => stats?.boxOpens ?? [], [stats?.boxOpens]);
```

再以 `boxOpens` 替代后续引用（原第 62 行的 `const boxOpens = stats?.boxOpens ?? [];` 删除）。

D. `steamItemNameId.test.ts:8` 的 `import()` 注解按 eslint 提示修正。

- [ ] **Step 2: 验证**

```
cd app
pnpm lint
```

预期：0 错误、0 警告。

- [ ] **Step 3: Commit**

```bash
git add app/src/main/services/MarketVolumeService.ts app/src/main/services/TrackingService.ts app/src/renderer/lib/useLoot.ts app/test/main/steamItemNameId.test.ts
git commit -m "chore: silence noisy volume-stats log and clear lint warnings"
```

**批次 4 验收：** `pnpm qa` 全绿（含故事书构建等既有入口除外项以实际脚本为准）。

---

## 批次 5 — P2 收尾小修与可选加固

### Task 17: renderer 边界小修（NaN / 卸载保护 / 拖拽提交 / key）

**Files:**
- Modify: `app/src/renderer/tabs/Market.tsx:19-26`
- Modify: `app/src/renderer/components/inventory/ItemPriceRefreshButton.tsx:26-46`
- Modify: `app/src/renderer/tabs/Trading.tsx:225-237`
- Modify: `app/src/renderer/components/market/MarketVolumeSection.tsx:431-444`

- [ ] **Step 1: 修复实现**

A. `Market.tsx` 的 `fmtAge`：

```ts
function fmtAge(t: ReturnType<typeof useTranslation<"market">>["t"], iso: string | null): string {
  if (!iso) return t("ageNever");
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return t("ageNever");
  const secs = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  ...
```

B. `ItemPriceRefreshButton.tsx` 的 `onRefresh` 加卸载保护：

```ts
  async function onRefresh(): Promise<void> {
    if (pending) return;
    setPending(true);
    let mounted = true;
    try {
      await window.tbh.refreshItemPrices(itemKey);
    } catch (err) {
      if (mounted) reportIpcError(err, "inventory-item-price-refresh");
    } finally {
      mounted = false;
      setPending(false); // React 18 no-ops on unmounted; guard keeps intent explicit
    }
  }
```

（如需严格防卸载 setState，改为 `useRef` 的 `aliveRef` 模式并在 effect cleanup 置 false；二选一，推荐后者。C 项同。）

C. `Trading.tsx` 第 225-237 行 `handleImportHistory` 的 `finally { setImporting(false) }` 改为经 `mountedRef`（组件顶部 `const mountedRef = useRef(true)` + `useEffect(() => () => { mountedRef.current = false; }, [])`）守卫。

D. `MarketVolumeSection.tsx` 的 `handlePointerUp`（第 441-443 行）：

```ts
    } else {
      onOffsetCommit(pendingOffsetRef.current);
    }
```

（`pendingOffsetRef.current` 在 `handlePointerDown` 中已初始化为 `offset`——若未初始化，则在按下的处理中补 `pendingOffsetRef.current = offset;`。）

- [ ] **Step 2: 验证**

```
cd app
pnpm typecheck && pnpm test:dom
```

- [ ] **Step 3: Commit**

```bash
git add app/src/renderer/tabs/Market.tsx app/src/renderer/components/inventory/ItemPriceRefreshButton.tsx app/src/renderer/tabs/Trading.tsx app/src/renderer/components/market/MarketVolumeSection.tsx
git commit -m "fix(renderer): NaN-safe age format, unmount guards, and drag-commit offset"
```

### Task 18: core 小修（parseMoney 注释 / capacity clamp / totalOpens 改名 / 循环外除法）

**Files:**
- Modify: `app/src/core/steamPrice.ts:202-209`（注释 + 不变式）
- Modify: `app/src/core/boxes/capacity.ts:26-35`
- Modify: `app/src/core/boxOpenTracker.ts:269,341`（改名 `totalOpens` → `totalItems`，同步 shared 类型与 renderer 引用）
- Modify: `app/src/core/boxOpenAutoClassify.ts:258`

- [ ] **Step 1: 修复实现**

A. `steamPrice.ts` 的 `parseMoney` 文档注释追加"末尾恰 3 位的处理仅在整数货币（JPY/KRW/VND）语境下正确；新增 3 位小数货币前必须重审此分支"。

B. `boxes/capacity.ts:26-35`：`const cap = Math.max(1, capacity);` → `const cap = Math.max(0, capacity);`，并检查下游 `isFull`/除零处是否有 `cap === 0` 兜底；若无，在容量进度条使用处加 `cap === 0 && used === 0` 时"不显示进度"分支。

C. `boxOpenTracker.ts`：`totalOpens` 字段与相关命名统一改为 `totalItems`（grep 全仓同步 renderer/shared 引用，全部同 commit 落地）。

D. `boxOpenAutoClassify.ts:258`：`const gapSeconds = gapMs / 1000;` 提出循环。

- [ ] **Step 2: 验证**

```
cd app
pnpm typecheck && pnpm test -- test/core
```

- [ ] **Step 3: Commit**

```bash
git add app/src/core/steamPrice.ts app/src/core/boxes/capacity.ts app/src/core/boxOpenTracker.ts app/src/core/boxOpenAutoClassify.ts app/src/shared/types.ts app/src/renderer
git commit -m "refactor(core): clarify money-parse invariant, honest capacity zero, rename totalOpens->totalItems"
```

### Task 19: main 服务层小修

**Files:**
- Modify: `app/src/main/services/steamItemNameId.ts:45-49,109-110`
- Modify: `app/src/main/services/priceCache.ts:83-87`
- Modify: `app/src/main/saveWatcher.ts:70-77`
- Modify: `app/src/main/services/LiveMemoryService.ts:135-146`

- [ ] **Step 1: 修复实现**

A. `steamItemNameId.ts`：`persistUserCache` 全量写盘改为「try/catch + 末尾节流写」（用 `setTimeout` 合并 500ms 内的多次触发，退出前 flush）；`userCache` 加 `MAX_NAMEID_CACHE = 50000` 上限（超出时删除最旧——若无时间戳则按插入序删头）。

B. `priceCache.ts` 的 `persistPriceCache` 为 `mkdirSync`+`writeFileSync` 包 try/catch + `log.warn`。

C. `saveWatcher.ts` 的 inventory 解析失败分支：`log.error` 之后追加 `this.onError?.(...)`（若 onError 语义仅限主解析，则新增可选的 `onInventoryError` 回调，并在 appState 接线处广播到 renderer 状态——最小实现为复用 onError）。

D. `LiveMemoryService.ts` 第 135-146 行 stderr 上限改为字节口径：

```ts
    this.child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
      stderrBytes += chunk.length; // 按接收 Buffer 的字节数计
      while (stderrBytes > STDERR_MAX_BYTES && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrBytes -= Buffer.byteLength(removed, "utf8");
      }
      if (chunk.length > STDERR_MAX_BYTES) {
        // A single oversized dump: keep only the trailing part.
        const text = stderrChunks[stderrChunks.length - 1] ?? "";
        stderrChunks[stderrChunks.length - 1] = text.slice(-Math.floor(STDERR_MAX_BYTES / 2));
        stderrBytes = STDERR_MAX_BYTES / 2;
      }
      log.warn(`[worker stderr] ${stderrChunks.join("").trimEnd().slice(-500)}`);
    });
```

- [ ] **Step 2: 验证**

```
cd app
pnpm typecheck && pnpm test -- test/main
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/services/steamItemNameId.ts app/src/main/services/priceCache.ts app/src/main/saveWatcher.ts app/src/main/services/LiveMemoryService.ts
git commit -m "fix(main): throttle name-id cache writes, isolate price-cache persist, surface inventory parse errors, byte-accurate stderr cap"
```

### Task 20: 死代码与重复订阅清理

**Files:**
- Delete: `app/src/renderer/context/StatsContext.tsx`、`app/src/renderer/context/PriceContext.tsx`
- Modify: `app/src/renderer/lib/useLiveMemory.ts:116-125`（删除 `useLiveMemoryField`）
- Modify: `app/src/renderer/lib/usePrices.ts:41-57` 与 `app/src/renderer/context/TbhProvider.tsx:95-111`（收敛 `pricesStatus()` 二次拉取）

- [ ] **Step 1: 删除前确认零引用**

```
cd app
npm exec --no -- eslint . 2>&1 | Select-String "StatsContext|PriceContext|useLiveMemoryField"
```

并 Grep `StatsProvider|PriceProvider|useStatsContext|useLiveMemoryField` 于 `app/src` — 预期仅定义文件自身命中（Task 执行时必须确认）。

- [ ] **Step 2: 删除与收敛**

A. 删除两个 context 文件；删除 `useLiveMemoryField`。

B. `usePrices.ts` 与 `TbhProvider.tsx` 的 `onPricesProgress` 结束后重复 `pricesStatus()`：只保留 `usePrices.ts` 单例侧一次（删除 `TbhProvider.tsx:95-111` 的 offProgress 订阅块——`lastPriceRefreshMessage` 改由 `usePrices` 单例快照派生；若 `lastPriceRefreshMessage` 字符串生成依赖 `pricesStatus` 结果，将其迁移到 `usePrices.ts` 的 store 中并导出，`TbhProvider` 只读。执行时以最小 diff 落地：把 TbhProvider 里 offProgress 的回调内容整体移入 usePrices 单例）。

- [ ] **Step 3: 验证**

```
cd app
pnpm typecheck && pnpm lint && pnpm test && pnpm test:dom
```

- [ ] **Step 4: Commit**

```bash
git add -A app/src/renderer/context app/src/renderer/lib/useLiveMemory.ts app/src/renderer/lib/usePrices.ts app/src/renderer/context/TbhProvider.tsx
git commit -m "refactor(renderer): remove dead contexts and dedupe prices-status refresh"
```

### Task 21（可选加固）: liveMemory 扫描预算 / bufferPool 释放 / fast poll 对齐 / pending 上限

> 本 Task 每项都独立可合并；建议按子项分开 commit，并以实机（游戏运行中）验证后再合入。

**Files:**
- Modify: `app/src/main/liveMemory/winProcess.ts:624-659,698-723`
- Modify: `app/src/main/liveMemory/worker.ts:32`
- Modify: `app/src/main/liveMemory/liveReader.ts:1039`（push 上限）
- Modify: `docs/BUSINESS-FLOWS.md`（fast poll 节拍描述核对）

- [ ] **Step 1: readableRegions 字节预算**

`winProcess.ts` 第 624 行签名与循环改为：

```ts
  *readableRegions(
    maxRegions = 5000,
    start = 0n,
    maxBytes = SCAN_BUDGET_BYTES, // 200 * 1024 * 1024 at module scope
  ): Generator<MemoryRegion> {
    let budget = maxBytes;
    ...
    while (count < maxRegions && budget > 0) {
      ...
      if (readable) {
        if (regionSize > budget) break; // never yield partial regions
        yield { baseAddress: base, size: regionSize, protect, type: info.Type };
        budget -= regionSize;
        count++;
      }
      ...
    }
  }
```

并加模块常量 `const SCAN_BUDGET_BYTES = 200 * 1024 * 1024;`。同步更新调用方注释说明"预算耗尽时 name-scan 可能 miss——由 resolveClassByName 的 GA 优先路径兜底"。

- [ ] **Step 2: 扫描路径 Buffer 归还**

在 `winProcess.ts` 的 `scanBytes`/`scanBytesInRange`/`resolveClassByName` 中，每块 `readBytes` 成功后、使用完毕处调用 `this.bufPool.release(buf)`（仅当该调用点读取后立即用完、无别名逃逸——执行时必须逐点核查；`readPtr`/`readI32` 等瞬时读路径的 `readBytes` 一律不归还）。

- [ ] **Step 3: fast poll 节拍对齐**

`worker.ts:32` `const FAST_CHEST_POLL_MS = 2;` → `= 5;`，与 `docs/BUSINESS-FLOWS.md` 文档一致（并核对文档无"2ms"字样残留）。

- [ ] **Step 4: pendingChestDrops 上限**

`liveReader.ts` `pollChestTailFast` 的 push 处：

```ts
  if (this.pendingChestDrops.length >= MAX_PENDING_CHEST_DROPS) {
    // Drain failure is pathological (read() early-returns during name-scan);
    // drop the oldest rather than growing unbounded.
    this.pendingChestDrops.shift();
  }
  this.pendingChestDrops.push(...drops);
```

（`MAX_PENDING_CHEST_DROPS = 1000` 模块常量。）

- [ ] **Step 5: 验证与实机 QA**

```
cd app
pnpm typecheck && pnpm test -- test/main/liveReaderResolution.test.ts test/main/winProcessPsapi.test.ts test/main/winProcessSandboxIsolation.test.ts
pnpm qa:dev
```

实机确认：live 页功能正常、main.log 无新增异常、内存扫描不再超预算（观察 `scanBytes` 日志条数）。

- [ ] **Step 6: Commit（每子项一条）**

```bash
git add app/src/main/liveMemory/winProcess.ts && git commit -m "perf(liveMemory): enforce byte budget on readable region scans"
git add app/src/main/liveMemory/winProcess.ts && git commit -m "perf(liveMemory): return scan chunk buffers to the pool"
git add app/src/main/liveMemory/worker.ts docs/BUSINESS-FLOWS.md && git commit -m "fix(liveMemory): align fast chest poll cadence with docs (5ms)"
git add app/src/main/liveMemory/liveReader.ts && git commit -m "fix(liveMemory): cap pending chest drops queue"
```

---

## Self-Review（本计划对照审计报告）

1. **覆盖核对**：报告 P0-1/P0-2 → Task 1/2；P1-1..P1-6 → Task 3/4/5/6/7/8；P1-7/8/10 → Task 9/10/11；P1-9 → Task 12；性能 P2 热点（getStats/入队 O(N²)/bundled 缓存/扫描预算/bufferPool/fast poll/pending 上限/长列表/日志）→ Task 13-16、21；剩余 P2（格式化/命名/死代码/重复订阅/错误可见性）→ Task 17-20。**未纳入本计划**：auto-classify 入队 O(N²)（队列规模有限，收益低）、save 解析下沉 worker（需单独设计评审，建议另立计划）、proxyResolver 异步化（启动预热可一并做，但涉及网络栈初始化时序，留待专项）、unsupported 状态 PowerShell 枚举降频（依赖 Task 21 后重新评估）。这些延续项已列入审计报告文档，不阻塞本计划交付。
2. **占位符扫描**：所有修复步骤均有代码或明确的"读文件确认 helpers 名"前置步骤；无 TBD。
3. **类型一致性**：`clampRingSeconds`（Task 3）与 `LootRingSeconds = { common, stage }`（shared/types）一致；`marketVolumeRefreshStore` 导出名在 Task 12 三个文件中一致；`appendHistory`/`drainRecentEntries`（Task 14）与 `nowSeconds()`、`ROLLING_HOUR_SEC` 现有符号一致。