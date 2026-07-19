# UtilityProcess 内存扫描修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 UtilityProcess 因 `resolveClassByName` 全进程地址空间扫描导致的 3GB+ 内存峰值，将扫描内存占用降至 200MB 以内。

**Architecture:** 三管齐下——(1) Buffer 复用消除每秒数百万次分配；(2) `scanBytes` 限定扫描范围为 GameAssembly.dll 而非全地址空间；(3) `resolveClassByName` Pass 2 合并为单次扫描。辅以 V8 堆限制和手动 GC。

**Tech Stack:** Node.js Buffer pool、koffi FFI、Electron utilityProcess

---

## 问题根因回顾

`winProcess.ts` 的 `resolveClassByName` 执行最多 101 次全进程地址空间扫描：

1. `scanBytes` 调用 `readableRegions()` **无参数**，从地址 0 开始遍历整个 64 位地址空间
2. 每个区域以 256KB 分块读取，每次 `Buffer.alloc(256KB)` 分配 V8 外部内存
3. Pass 2 对每个 nameAddr（最多 100 个）再次全进程扫描
4. Unity 游戏进程 2-4GB 可读内存 × 101 次扫描 = 瞬时分配数百 GB，V8 GC 无法跟上

此外 25Hz 运行时路径中 `readBytes` 每次调用也分配新 Buffer（750 万次/秒）。

---

## 文件结构总览

| 文件 | 职责 | 任务 |
|------|------|------|
| `app/src/main/liveMemory/winProcess.ts` | FFI 内存读取 + 扫描 | Task 1, 2, 3 |
| `app/src/core/liveMemory/memory.ts` | MemoryReader 接口 | Task 1 (接口变更) |
| `app/src/main/liveMemory/offsetExtractor.ts` | 偏移量提取 | Task 2 (适配) |
| `app/src/main/liveMemory/liveReader.ts` | LiveMemoryReader | Task 3 (适配) |
| `app/src/main/liveMemory/worker.ts` | UtilityProcess 入口 | Task 4 |
| `app/src/main/services/LiveMemoryService.ts` | 进程启动 | Task 4 |
| `app/test/core/winProcess.test.ts` | 测试 | Task 1, 2 |

---

## Task 1: Buffer 复用 — `readBytes` 预分配池

**问题:** `readBytes` 每次调用 `Buffer.alloc(size)` 分配新 Buffer。25Hz 热路径中每秒 750 万次分配。扫描期间每秒数千次 256KB 分配。这些 Buffer 属于 V8 外部内存（>8KB），GC 无法及时回收。

**方案:** 为 `WinProcess` 实例引入按大小分组的 Buffer 池——预分配一组固定大小 Buffer，每次 `readBytes` 复用而非新建。`MemoryReader` 接口不变，对外行为完全一致。

**Files:**
- Modify: `app/src/main/liveMemory/winProcess.ts` — `WinProcess` 类
- Test: `app/test/core/winProcess.test.ts` (新建或扩展)

- [ ] **Step 1: 编写 Buffer 池单元测试**

```ts
// app/test/core/winProcess.test.ts
import { describe, it, expect } from "vitest";

// These tests verify the BufferPool behavior in isolation.
// WinProcess itself requires koffi + a real process, so we test the pool directly.

describe("BufferPool", () => {
  it("should return a Buffer of the requested size", async () => {
    const { BufferPool } = await import("../../src/main/liveMemory/bufferPool");
    const pool = new BufferPool();
    const buf = pool.acquire(256 * 1024);
    expect(buf.length).toBe(256 * 1024);
  });

  it("should reuse the same Buffer for consecutive same-size acquires", async () => {
    const { BufferPool } = await import("../../src/main/liveMemory/bufferPool");
    const pool = new BufferPool();
    const buf1 = pool.acquire(1024);
    pool.release(buf1);
    const buf2 = pool.acquire(1024);
    // Should be the same underlying buffer (reused)
    expect(buf2.buffer).toBe(buf1.buffer);
  });

  it("should not grow beyond maxPooled entries per size bucket", async () => {
    const { BufferPool } = await import("../../src/main/liveMemory/bufferPool");
    const pool = new BufferPool(2); // max 2 per bucket
    const bufs: Buffer[] = [];
    for (let i = 0; i < 5; i++) bufs.push(pool.acquire(1024));
    for (const b of bufs) pool.release(b);
    // Internal pool should have at most 2 entries for this size bucket
    // (verified by acquiring 2 and checking they're reused, 3rd is new)
    const reused1 = pool.acquire(1024);
    const reused2 = pool.acquire(1024);
    const reused3 = pool.acquire(1024);
    // First two should be from pool (reused), third is new alloc
    expect(reused1.buffer).toBe(bufs[4].buffer);
    expect(reused2.buffer).toBe(bufs[3].buffer);
    // Third is a fresh allocation — just verify it works
    expect(reused3.length).toBe(1024);
  });
});
```

- [ ] **Step 2: 创建 BufferPool 类**

```ts
// app/src/main/liveMemory/bufferPool.ts

/**
 * Per-size Buffer pool for WinProcess.readBytes.
 *
 * Buffers > 8 KB are allocated on the V8 external (native) heap and not
 * pooled by Node. In the 25 Hz read loop and the 256 KB-chunk memory
 * scanner, this causes millions of allocations per second that V8 GC
 * cannot keep up with, leading to RSS bloat.
 *
 * This pool keeps a small LRU cache of recently-released Buffers per
 * size bucket. acquire() returns a pooled Buffer (or allocates a new
 * one); release() returns it to the pool for reuse.
 *
 * Thread-safety: single-threaded (utilityProcess runs one event loop).
 */

const MAX_PER_BUCKET = 3;
const MAX_TOTAL_POOLED = 20;

export class BufferPool {
  private readonly pool = new Map<number, Buffer[]>();
  private readonly maxPerBucket: number;
  private totalPooled = 0;

  constructor(maxPerBucket: number = MAX_PER_BUCKET) {
    this.maxPerBucket = maxPerBucket;
  }

  /** Get a Buffer of exactly `size` bytes. Contents are undefined. */
  acquire(size: number): Buffer {
    const bucket = this.pool.get(size);
    if (bucket && bucket.length > 0) {
      const buf = bucket.pop()!;
      this.totalPooled--;
      return buf;
    }
    return Buffer.allocUnsafe(size);
  }

  /** Return a Buffer to the pool for future reuse. No-op if pool is full. */
  release(buf: Buffer): void {
    if (this.totalPooled >= MAX_TOTAL_POOLED) return;
    const size = buf.length;
    let bucket = this.pool.get(size);
    if (!bucket) {
      bucket = [];
      this.pool.set(size, bucket);
    }
    if (bucket.length >= this.maxPerBucket) return;
    bucket.push(buf);
    this.totalPooled++;
  }

  /** Clear all pooled buffers. */
  clear(): void {
    this.pool.clear();
    this.totalPooled = 0;
  }
}
```

- [ ] **Step 3: 修改 WinProcess.readBytes 使用 BufferPool**

在 `winProcess.ts` 中，为 `WinProcess` 添加一个 BufferPool 实例并修改 `readBytes`：

```ts
// app/src/main/liveMemory/winProcess.ts — 在 imports 区域添加:
import { BufferPool } from "./bufferPool";

// 在 WinProcess 类中添加字段 (在 private handle 旁边):
export class WinProcess implements MemoryReader {
  readonly pid: number;
  readonly name: string;
  private handle: unknown;
  private readonly bufPool = new BufferPool();

  // ... 构造函数不变 ...

  // 修改 readBytes 方法:
  readBytes(address: bigint, size: number): Buffer | null {
    const buf = this.bufPool.acquire(size);
    const outLen = [0n];
    const ok = ReadProcessMemory(this.handle, address, buf, BigInt(size), outLen);
    if (!ok) {
      this.bufPool.release(buf);
      return null;
    }
    const read = Number(outLen[0]);
    if (read === size) {
      return buf; // 完整读取 — 调用者用完后应 release
    }
    // 短读取 — 返回 subarray，原始 buf 无法复用
    return buf.subarray(0, read);
  }

  /** Release a Buffer previously acquired via readBytes back to the pool. */
  releaseBuffer(buf: Buffer): void {
    this.bufPool.release(buf);
  }
}
```

**注意:** `Buffer.allocUnsafe` 不清零内存，比 `Buffer.alloc` 快。`ReadProcessMemory` 会覆写内容，所以不清零是安全的。调用者（`scanBytes`、`readPtr` 等）不需要修改——它们已经只读取 Buffer 内容后丢弃。但 `scanBytes` 需要在用完后 release（见 Task 2）。

- [ ] **Step 4: 修改 close() 清理 BufferPool**

```ts
// winProcess.ts — close() 方法:
close(): void {
  if (this.handle) {
    CloseHandle(this.handle);
    this.handle = null;
  }
  this.bufPool.clear();
}
```

- [ ] **Step 5: 运行测试**

```bash
cd app && pnpm test -- --reporter=verbose -- bufferPool
```
预期: BufferPool 测试通过。

- [ ] **Step 6: 验证编译**

```bash
cd app && node node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 7: 提交**

```bash
git add app/src/main/liveMemory/bufferPool.ts app/src/main/liveMemory/winProcess.ts app/test/core/winProcess.test.ts
git commit -m "perf: add BufferPool to WinProcess.readBytes

Reuses Buffers instead of allocating new ones per call. The 25Hz read
loop previously allocated ~7.5M Buffers/sec; scanBytes allocated
~8K 256KB Buffers per full scan. Pool keeps 3 per size bucket."
```

---

## Task 2: `scanBytes` 限定扫描范围 + Buffer release

**问题:** `scanBytes` 调用 `proc.readableRegions()` **无参数**，从地址 0 开始遍历整个 64 位地址空间（最多 5000 个区域，2-4GB 可读内存）。`resolveClassByName` 调用它最多 101 次。

**方案:**
1. 为 `scanBytes` 添加可选的 `regions` 参数——当调用方已知目标区域时直接传入，避免全空间遍历
2. `resolveClassByName` 传入 GameAssembly.dll 的区域范围
3. 在 `scanBytes` 内部使用完 Buffer 后调用 `releaseBuffer`

**Files:**
- Modify: `app/src/main/liveMemory/winProcess.ts` — `scanBytes`、`scanPointers`、`resolveClassByName`
- Modify: `app/src/main/liveMemory/liveReader.ts` — 传入 GA 区域
- Modify: `app/src/main/liveMemory/offsetExtractor.ts` — 复用 `gaScanRegions`

- [ ] **Step 1: 修改 scanBytes 签名接受可选 regions 参数**

```ts
// app/src/main/liveMemory/winProcess.ts — 修改 scanBytes:

/**
 * Scan readable memory regions for a byte pattern. Returns addresses where the pattern starts.
 * When `regions` is provided, scans only those regions; otherwise scans all readable regions.
 */
export function scanBytes(
  proc: WinProcess,
  pattern: Buffer,
  maxMatches = 200,
  regions?: readonly MemoryRegion[],
): bigint[] {
  const results: bigint[] = [];
  const regionIter = regions ?? proc.readableRegions();
  for (const region of regionIter) {
    if (results.length >= maxMatches) break;
    const CHUNK = 256 * 1024; // 256 KB per read
    let offset = 0n;
    while (offset < BigInt(region.size) && results.length < maxMatches) {
      const remaining = Number(BigInt(region.size) - offset);
      const chunkSize = Math.min(CHUNK, remaining);
      const buf = proc.readBytes(region.baseAddress + offset, chunkSize);
      if (!buf) {
        offset += BigInt(chunkSize);
        continue;
      }
      let pos = -1;
      while ((pos = buf.indexOf(pattern, pos + 1)) !== -1) {
        results.push(region.baseAddress + offset + BigInt(pos));
        if (results.length >= maxMatches) break;
      }
      offset += BigInt(chunkSize);
      proc.releaseBuffer(buf);
    }
  }
  return results;
}
```

- [ ] **Step 2: 修改 scanPointers 也接受可选 regions 参数**

```ts
// app/src/main/liveMemory/winProcess.ts — 修改 scanPointers:

/** Scan readable memory for 8-aligned pointers to a target address. */
export function scanPointers(
  proc: WinProcess,
  target: bigint,
  maxMatches = 4000,
  regions?: readonly MemoryRegion[],
): bigint[] {
  const needle = Buffer.alloc(8);
  needle.writeBigUInt64LE(target);
  const raw = scanBytes(proc, needle, maxMatches, regions);
  return raw.filter((addr) => (addr & 7n) === 0n);
}
```

- [ ] **Step 3: 修改 resolveClassByName 接受 GA 区域参数**

```ts
// app/src/main/liveMemory/winProcess.ts — 修改 resolveClassByName:

/**
 * Resolve an Il2Cpp class by its real name string (meter's 3-pass approach).
 * Returns the Il2CppClass* pointer or null if not found.
 *
 * When `scanRegions` is provided, scans only those regions instead of the
 * entire process address space — dramatically reduces memory and time.
 */
export function resolveClassByName(
  proc: WinProcess,
  className: string,
  scanRegions?: readonly MemoryRegion[],
): bigint | null {
  const IL2CPP_CLASS_NAME_OFFSET = 0x10n;

  // Pass 1: find the name string in memory
  const nameBuffer = Buffer.from(className + "\0", "utf-8");
  const nameAddrs = scanBytes(proc, nameBuffer, 100, scanRegions);
  if (nameAddrs.length === 0) return null;

  // Pass 2: find 8-aligned pointers to any name string address.
  // Single merged scan: collect all name addrs, then scan once for each.
  // (Still per-nameAddr because we need to identify which pointer points
  // to which name, but now each scan is limited to scanRegions.)
  const seen = new Set<string>();
  for (const nameAddr of nameAddrs) {
    if (seen.has(nameAddr.toString())) continue;
    seen.add(nameAddr.toString());
    const ptrHits = scanPointers(proc, nameAddr, 4000, scanRegions);
    for (const ploc of ptrHits) {
      const K = ploc - IL2CPP_CLASS_NAME_OFFSET;
      if (K <= 0x10000n) continue;

      const namePtr = proc.readBytes(K + IL2CPP_CLASS_NAME_OFFSET, 8);
      if (!namePtr) continue;
      if (namePtr.readBigUInt64LE() !== nameAddr) {
        proc.releaseBuffer(namePtr);
        continue;
      }
      proc.releaseBuffer(namePtr);

      const elemClass = proc.readBytes(K + 0x40n, 8);
      if (elemClass) {
        const elemVal = elemClass.readBigUInt64LE();
        proc.releaseBuffer(elemClass);
        if (elemVal === K) return K;
        const castClass = proc.readBytes(K + 0x48n, 8);
        if (castClass) {
          const castVal = castClass.readBigUInt64LE();
          proc.releaseBuffer(castClass);
          if (castVal === K) return K;
        }
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: 导出 MemoryRegion 类型（已导出，确认即可）**

`MemoryRegion` 已在 `winProcess.ts` 第 137-142 行导出。无需修改。

- [ ] **Step 5: 修改 liveReader.ts 传入 GA 区域**

在 `liveReader.ts` 中，`resolveClassByName` 的两个调用点需要传入 GA 区域。在 `read()` 方法中，已有 `this.ga` 字段包含 GA base 和 size。需要在调用前收集 GA 范围内的可读区域。

```ts
// app/src/main/liveMemory/liveReader.ts — 在 read() 方法中，第 328 行之前添加:

// Collect GA-readable regions once for name-scan fallbacks.
// This avoids resolveClassByName scanning the entire process address space.
let gaRegions: MemoryRegion[] | null = null;
if (this.ga) {
  const gaEnd = this.ga.base + BigInt(this.ga.size);
  gaRegions = [];
  for (const region of p.readableRegions(5000, this.ga.base)) {
    if (region.baseAddress >= gaEnd) break;
    if (region.baseAddress < this.ga.base || region.size < 8) continue;
    if (!GA_READABLE_PROTECT.has(region.protect)) continue;
    gaRegions.push(region);
  }
}
```

需要添加 import 和常量。在文件顶部 imports 区域添加：

```ts
// app/src/main/liveMemory/liveReader.ts — 添加 import:
import type { MemoryRegion } from "./winProcess";
```

在类中添加 GA 可读保护常量（与 offsetExtractor.ts 中的相同）：

```ts
// 在 LiveMemoryReader 类中添加:
/** Memory protection constants for readable GameAssembly pages. */
private static readonly GA_READABLE_PROTECT = new Set([
  0x02, 0x04, 0x08, 0x20, 0x40, 0x80,
]);
```

然后在两个 `resolveClassByName` 调用中传入 `gaRegions ?? undefined`：

```ts
// MonsterSpawnManager fallback (第 335 行):
const msClass = resolveClassByName(p, "MonsterSpawnManager", gaRegions ?? undefined);

// LogManager fallback (第 363 行):
const lmClass = resolveClassByName(p, "LogManager", gaRegions ?? undefined);
```

**注意:** 类名字符串通常存储在 GameAssembly.dll 的 `.rdata` 段中。将扫描限定在 GA 区域内足够找到 IL2CPP 类名。如果极端情况下类名存储在堆中（非 GA 区域），名称扫描会返回空并降级——这比扫描 4GB 内存可接受得多。

- [ ] **Step 6: 修改 offsetExtractor.ts 的 gaScanRegions 导出复用**

`offsetExtractor.ts` 中的 `gaScanRegions` 函数目前是模块私有的。将其导出，以便 `liveReader.ts` 可以复用：

```ts
// app/src/main/liveMemory/offsetExtractor.ts — 将 gaScanRegions 改为 export:
export function gaScanRegions(proc: WinProcess, ga: { base: bigint; size: number }): ScanRegion[] {
  // ... 现有实现不变 ...
}
```

然后在 `liveReader.ts` 中复用：

```ts
// app/src/main/liveMemory/liveReader.ts — 修改 import:
import { extractOffsets, gaScanRegions } from "./offsetExtractor";
import type { ScanRegion } from "../../core/liveMemory/il2cppScanner";

// 在 read() 方法中替换 Step 5 的手动收集:
let gaRegions: MemoryRegion[] | null = null;
if (this.ga) {
  const scanRegions = gaScanRegions(p, this.ga);
  gaRegions = scanRegions.map(r => ({
    baseAddress: r.base,
    size: r.size,
    protect: 0x04, // PAGE_READWRITE — gaScanRegions 已过滤可读保护
    type: 0,
  }));
}
```

- [ ] **Step 7: 验证编译**

```bash
cd app && node node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 8: 提交**

```bash
git add app/src/main/liveMemory/winProcess.ts app/src/main/liveMemory/liveReader.ts app/src/main/liveMemory/offsetExtractor.ts
git commit -m "perf: limit resolveClassByName scan to GameAssembly.dll regions

scanBytes now accepts optional regions parameter. resolveClassByName
passes GA-readable regions instead of scanning the entire 2-4GB
process address space. Also releases Buffers back to pool after use.

Expected: scan memory reduced from ~200GB cumulative to ~50MB per
resolveClassByName call (100MB GA × 2 passes)."
```

---

## Task 3: `resolveClassByName` Pass 2 合并扫描

**问题:** Pass 2 对每个 nameAddr（最多 100 个）单独调用 `scanPointers`，每次 `scanPointers` 内部调用 `scanBytes` 全量扫描。100 个 nameAddr = 100 次完整扫描。

**方案:** 将 Pass 2 改为**单次扫描**——扫描 GA 区域中的所有 8 字节对齐的指针值，然后在内存中匹配是否指向任一 nameAddr。这样 101 次扫描降为 2 次（Pass 1 找名字 + Pass 2 找指针）。

**Files:**
- Modify: `app/src/main/liveMemory/winProcess.ts` — `resolveClassByName`

- [ ] **Step 1: 重写 resolveClassByName 的 Pass 2**

```ts
// app/src/main/liveMemory/winProcess.ts — 替换 resolveClassByName:

export function resolveClassByName(
  proc: WinProcess,
  className: string,
  scanRegions?: readonly MemoryRegion[],
): bigint | null {
  const IL2CPP_CLASS_NAME_OFFSET = 0x10n;

  // Pass 1: find the name string in memory (scans GA regions only when provided)
  const nameBuffer = Buffer.from(className + "\0", "utf-8");
  const nameAddrs = scanBytes(proc, nameBuffer, 100, scanRegions);
  if (nameAddrs.length === 0) return null;

  // Build a Set of name addresses for O(1) lookup
  const nameAddrSet = new Set<bigint>();
  for (const addr of nameAddrs) nameAddrSet.add(addr);
  if (nameAddrSet.size === 0) return null;

  // Pass 2: SINGLE scan — read all 8-byte values from GA regions,
  // check if any points to a nameAddr. This replaces 100 separate
  // scanPointers calls with one pass through the regions.
  const regionIter = scanRegions ?? proc.readableRegions();
  for (const region of regionIter) {
    const CHUNK = 256 * 1024;
    let offset = 0n;
    while (offset < BigInt(region.size)) {
      const remaining = Number(BigInt(region.size) - offset);
      const chunkSize = Math.min(CHUNK, remaining);
      const buf = proc.readBytes(region.baseAddress + offset, chunkSize);
      if (!buf) {
        offset += BigInt(chunkSize);
        continue;
      }

      // Scan 8-byte-aligned slots
      for (let i = 0; i + 8 <= buf.length; i += 8) {
        const slotAddr = region.baseAddress + offset + BigInt(i);
        if ((slotAddr & 7n) !== 0n) continue; // skip non-aligned

        const ptrVal = buf.readBigUInt64LE(i);
        if (!nameAddrSet.has(ptrVal)) continue;

        // Found a pointer to a name address — check if it's an Il2CppClass
        const K = slotAddr - IL2CPP_CLASS_NAME_OFFSET;
        if (K <= 0x10000n) continue;

        // Verify: read the name pointer at K + 0x10
        const namePtr = proc.readBytes(K + IL2CPP_CLASS_NAME_OFFSET, 8);
        if (!namePtr) continue;
        const namePtrVal = namePtr.readBigUInt64LE();
        proc.releaseBuffer(namePtr);
        if (namePtrVal !== ptrVal) continue;

        // Verify element_class or cast_class round-trip
        const elemClass = proc.readBytes(K + 0x40n, 8);
        if (elemClass) {
          const elemVal = elemClass.readBigUInt64LE();
          proc.releaseBuffer(elemClass);
          if (elemVal === K) return K;
          const castClass = proc.readBytes(K + 0x48n, 8);
          if (castClass) {
            const castVal = castClass.readBigUInt64LE();
            proc.releaseBuffer(castClass);
            if (castVal === K) return K;
          }
        }
      }

      offset += BigInt(chunkSize);
      proc.releaseBuffer(buf);
    }
  }

  return null;
}
```

**关键变化:**
- Pass 2 不再对每个 nameAddr 调用 `scanPointers`（每次全扫描）
- 改为单次遍历 GA 区域，读取每个 8 字节对齐的值，检查是否在 `nameAddrSet` 中
- 101 次扫描降为 **2 次**（Pass 1 找名字 + Pass 2 单次遍历找指针）

- [ ] **Step 2: 验证编译**

```bash
cd app && node node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add app/src/main/liveMemory/winProcess.ts
git commit -m "perf: merge resolveClassByName Pass 2 into single scan

Previously Pass 2 called scanPointers for each of up to 100 name
addresses, each doing a full region scan. Now does ONE pass through
GA regions, checking each 8-byte-aligned value against a Set of
name addresses. Reduces scan count from 101 to 2."
```

---

## Task 4: UtilityProcess V8 堆限制 + 手动 GC

**问题:** UtilityProcess 没有设置 `--max-old-space-size`，V8 默认堆上限约 4GB（64位），GC 不够积极。扫描完成后 V8 不会立即将 native heap 内存归还操作系统。

**方案:**
1. 在 `LiveMemoryService.start()` 中通过 `utilityProcess.fork` 的选项传递 V8 标志
2. 在扫描完成后调用 `global.gc()`（需 `--expose-gc`）主动触发 GC

**Files:**
- Modify: `app/src/main/services/LiveMemoryService.ts` — fork 选项
- Modify: `app/src/main/liveMemory/worker.ts` — 扫描后 GC
- Modify: `app/src/main/liveMemory/liveReader.ts` — 扫描完成回调

- [ ] **Step 1: 修改 LiveMemoryService 传递 V8 标志**

```ts
// app/src/main/services/LiveMemoryService.ts — 修改 start() 方法:

start(): void {
  if (this.child) return;
  const workerPath = join(__dirname, "liveMemoryWorker.js");
  try {
    this.child = utilityProcess.fork(workerPath, [], {
      serviceName: "tbh-live-memory",
      stdio: "ignore",
      env: { ...process.env, [LIVE_MEMORY_USER_DATA_ENV]: resolveUserDataDir() },
      // Limit V8 old space to 512MB — the worker only does memory reads
      // and scans, it doesn't hold large data structures permanently.
      // This forces more aggressive GC of scan-time Buffer allocations.
    });
  } catch (err) {
    // ... error handling 不变 ...
  }
```

**注意:** Electron 的 `utilityProcess.fork` 不直接支持 `--js-flags`。V8 标志需要通过环境变量或 `process.execArgv` 传递。检查 Electron 文档——在 `utilityProcess.fork` 选项中，可以通过 `execArgv` 传递：

```ts
// 修改 fork 调用:
this.child = utilityProcess.fork(workerPath, [], {
  serviceName: "tbh-live-memory",
  stdio: "ignore",
  env: { ...process.env, [LIVE_MEMORY_USER_DATA_ENV]: resolveUserDataDir() },
});
```

实际上 `utilityProcess.fork` 在 Electron 中不支持 `execArgv`。替代方案：在 worker.ts 入口处通过 `v8.setFlagsFromString` 设置：

- [ ] **Step 2: 在 worker.ts 中设置 V8 标志和手动 GC**

```ts
// app/src/main/liveMemory/worker.ts — 在文件顶部添加:

// Limit V8 old generation heap to 512MB. The worker does memory reads
// and scans — it doesn't need a 4GB default heap. This forces GC to
// reclaim scan-time Buffer allocations more aggressively.
try {
  const v8 = require("node:v8") as { setFlagsFromString: (s: string) => void };
  v8.setFlagsFromString("--max-old-space-size=512");
} catch {
  // non-fatal — default heap limit applies
}
```

**注意:** `v8.setFlagsFromString` 必须在 V8 初始化早期调用才有效。在 `utilityProcess` 中，worker 入口是第一个执行的代码，所以此时调用可以生效。`--expose-gc` 也通过 `setFlagsFromString` 设置。

添加 `--expose-gc`:

```ts
// 在上面的 setFlagsFromString 调用中:
v8.setFlagsFromString("--max-old-space-size=512 --expose-gc");
```

- [ ] **Step 3: 在扫描完成后调用手动 GC**

在 `liveReader.ts` 中，`resolveClassByName` 的两个调用点在 `finally` 块后。在 `read()` 方法中，扫描完成后添加 GC 调用：

```ts
// app/src/main/liveMemory/liveReader.ts — 在 read() 方法中，
// LogManager name-scan fallback 的 finally 块之后添加:

    } finally {
      this.setScanning(false);
      // After expensive name scans, force GC to reclaim native Buffer
      // backing stores that V8 wouldn't collect until the next major GC.
      if (typeof globalThis.gc === "function") {
        try { globalThis.gc(); } catch { /* non-fatal */ }
      }
    }
```

对 MonsterSpawnManager 的 finally 块也添加同样的 GC 调用：

```ts
// MonsterSpawnManager fallback finally 块:
    } finally {
      this.setScanning(false);
      if (typeof globalThis.gc === "function") {
        try { globalThis.gc(); } catch { /* non-fatal */ }
      }
    }
```

- [ ] **Step 4: 验证编译**

```bash
cd app && node node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 5: 提交**

```bash
git add app/src/main/liveMemory/worker.ts app/src/main/liveMemory/liveReader.ts
git commit -m "perf: set V8 heap limit and manual GC for utilityProcess

--max-old-space-size=512 forces aggressive GC of scan Buffers.
--expose-gc allows manual GC after name-scan fallbacks complete,
reclaiming native heap backing stores immediately."
```

---

## Task 5: UtilityProcess 游戏关闭后超时停止

**问题:** `worker.ts` 的 `loop()` 在游戏关闭后仍以 `POLL_DETACHED_MS = 1500ms` 持续轮询尝试 reattach。UtilityProcess 基线内存约 50-80MB。

**方案:** 在 worker 中添加一个 reattach 超时计数器——连续 N 次尝试失败后进入"休眠"状态，通知主进程并降低轮询频率到 30 秒。用户可通过 UI 重新激活。

**Files:**
- Modify: `app/src/main/liveMemory/worker.ts`

- [ ] **Step 1: 添加 reattach 超时逻辑**

```ts
// app/src/main/liveMemory/worker.ts — 添加常量和状态:

const POLL_ATTACHED_MS = 40; // ~25 Hz while attached
const POLL_DETACHED_MS = 1500; // retry attach while the game is closed
const POLL_DORMANT_MS = 30_000; // slow retry after extended detach
const HEAL_UNSUPPORTED_MS = 10_000;
const DETACH_TIMEOUT_RETRIES = 20; // ~30s at POLL_DETACHED_MS before going dormant

let reader: LiveMemoryReader | null = null;
let loadError: string | null = null;
let healDueAt = 0;
let detachRetries = 0;
```

修改 `loop()` 函数：

```ts
// app/src/main/liveMemory/worker.ts — 修改 loop():

function loop(): void {
  if (!reader) {
    postStatusIfChanged();
    schedule(POLL_DETACHED_MS);
    return;
  }
  if (!reader.attached) {
    reader.attach();
    postStatusIfChanged();
    if (reader.attached) {
      detachRetries = 0; // reset on successful attach
    } else {
      detachRetries++;
    }
  } else {
    detachRetries = 0;
    maybeHealUnsupported();
  }
  if (reader.attached && reader.supported) {
    const snap = reader.read();
    postStatusIfChanged();
    if (snap) {
      post({ type: "snapshot", snapshot: snap });
      schedule(POLL_ATTACHED_MS);
      return;
    }
  }
  // Use dormant poll rate after extended detach to reduce idle CPU + memory
  const pollMs = detachRetries > DETACH_TIMEOUT_RETRIES
    ? POLL_DORMANT_MS
    : (reader.attached ? POLL_ATTACHED_MS : POLL_DETACHED_MS);
  schedule(pollMs);
}
```

- [ ] **Step 2: 在 stop 消息中重置计数器**

```ts
// app/src/main/liveMemory/worker.ts — 修改 parentPort message handler:

parentPort?.on("message", (msg) => {
  if (msg === "stop") {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    reader?.detach();
    detachRetries = 0;
  }
  if (msg === "attach") {
    // User re-enabled — reset dormant state
    detachRetries = 0;
    if (!timer) schedule(POLL_DETACHED_MS);
  }
});
```

- [ ] **Step 3: 验证编译**

```bash
cd app && node node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add app/src/main/liveMemory/worker.ts
git commit -m "perf: dormant mode after extended game detach

After ~30s of failed reattach attempts, poll rate drops from 1.5s
to 30s, reducing idle CPU and keeping utilityProcess memory idle.
Reset on successful attach or user re-enable."
```

---

## 验收检查

完成所有 Task 后：

```bash
cd app && node node_modules/typescript/bin/tsc --noEmit
```

手动验证:
1. `pnpm dev` 启动应用
2. 启用 LiveMemory 功能
3. 启动游戏，确认 Live 标签实时更新（25Hz）
4. 如果游戏版本未在偏移表中（触发 name scan）：
   - 观察"scanning..."状态显示
   - 扫描完成后检查任务管理器——UtilityProcess 内存应 **< 500MB**（此前 3GB+）
   - 扫描时间应显著缩短（GA-only 扫描 vs 全空间扫描）
5. 关闭游戏后等待 30 秒，确认轮询频率降为 30s（任务管理器 CPU 降至 0%）
6. 重新打开游戏，确认自动恢复 25Hz 读取

---

## 预期内存改善

| 优化项 | 此前 | 此后 | 节省 |
|--------|------|------|------|
| Buffer 复用（25Hz 路径） | 7.5M alloc/s | ~0 alloc/s | GC 压力消除 |
| scanBytes 限定 GA 区域 | 2-4GB/次 × 101 次 | 100-500MB/次 × 2 次 | ~99% 减少 |
| Pass 2 合并扫描 | 101 次全扫描 | 2 次扫描 | ~98% 减少 |
| V8 堆限制 512MB | 4GB 上限 | 512MB 上限 | 更积极 GC |
| 手动 GC | 扫描后 RSS 不降 | 立即回收 | native heap 归还 |
| 休眠模式 | 永久 1.5s 轮询 | 30s 轮询 | 50-80MB 空闲 |
| **合计 UtilityProcess** | **3GB+** | **< 300MB** | **~2.7GB 减少** |
