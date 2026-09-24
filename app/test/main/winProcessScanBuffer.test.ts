// Regression guard for the reusable scan buffer in `WinProcess`.
//
// Region walks (scanBytes / scanBytesInRange / resolveClassByName Pass 2) read
// one chunk at a time and consume it immediately, so they all draw from a single
// long-lived buffer. Taking a buffer from the size-bucketed pool per chunk does
// not work: the pool keys buckets by EXACT size, a region walk asks for a new
// partial-chunk size on every region, and after ~20 regions the pool's global cap
// makes `release()` drop every later buffer. One traversal of the real game's
// multi-GB address space then allocates ~1000 fresh 4 MiB Buffers — measured
// impact: the live-memory worker sat at ~400 MB RSS after a single attach (from
// 42 MB), with `heapUsed` ~20 MB, and a forced full GC did not move RSS because
// the pages were freed but never returned to the OS.
//
// `acquireScanBuffer` is pure bookkeeping (no FFI), but WinProcess only has a
// private constructor / a native `open()`. A prototype-created instance runs the
// real method body without touching kernel32.
import { describe, expect, it } from "vitest";
import { WinProcess, lazyFunc } from "../../src/main/liveMemory/winProcess";

function scanBufferHolder(): WinProcess {
  return Object.create(WinProcess.prototype) as WinProcess;
}

describe("WinProcess.acquireScanBuffer", () => {
  it("returns the SAME buffer for repeated acquires of the same size", () => {
    const proc = scanBufferHolder();
    const first = proc.acquireScanBuffer(4 * 1024 * 1024);
    const second = proc.acquireScanBuffer(4 * 1024 * 1024);
    expect(first.length).toBe(4 * 1024 * 1024);
    expect(second.buffer).toBe(first.buffer);
  });

  it("keeps reusing the buffer across many chunks (one allocation per walk)", () => {
    const proc = scanBufferHolder();
    const seen = new Set<ArrayBufferLike>();
    for (let i = 0; i < 500; i++) {
      // Mimic a region walk: mostly full chunks, plus a varying partial chunk.
      const size = i % 50 === 0 ? 4 * 1024 * 1024 - i : 4 * 1024 * 1024;
      seen.add(proc.acquireScanBuffer(size).buffer);
    }
    expect(seen.size).toBe(1);
  });

  it("grows the buffer when a larger chunk is requested", () => {
    const proc = scanBufferHolder();
    const small = proc.acquireScanBuffer(256 * 1024);
    const large = proc.acquireScanBuffer(4 * 1024 * 1024);
    expect(large.length).toBe(4 * 1024 * 1024);
    expect(large.buffer).not.toBe(small.buffer);
  });

  it("does not shrink a large buffer for a later small request", () => {
    const proc = scanBufferHolder();
    const large = proc.acquireScanBuffer(4 * 1024 * 1024);
    const small = proc.acquireScanBuffer(256 * 1024);
    expect(small.length).toBe(4 * 1024 * 1024);
    expect(small.buffer).toBe(large.buffer);
  });

  it("releases the buffer on close so a detached process does not pin it", () => {
    const proc = scanBufferHolder();
    // Use a size above Node's ~8 KB Buffer slab: smaller buffers share one slab,
    // which makes `.buffer` identity meaningless.
    const size = 64 * 1024;
    const first = proc.acquireScanBuffer(size);
    // `close()` is a no-op without a handle (nothing to CloseHandle) but must
    // still drop the scan buffer.
    proc.close();
    const afterClose = proc.acquireScanBuffer(size);
    expect(afterClose.buffer).not.toBe(first.buffer);
  });
});

// koffi retains the native trampoline built by `lib.func()` for the life of the
// process, so declaring per call leaked ~176 B per read — measured 83.8 MB per
// 500k declarations, invisible to V8 (a forced GC does not reclaim it) and worth
// ~1 GB/hour in the live-memory worker. Every kernel32/psapi declaration must be
// declared at most once.
describe("lazyFunc", () => {
  it("runs the declarer exactly once across many accesses", () => {
    let declarations = 0;
    const fn = lazyFunc(() => {
      declarations++;
      return () => 42;
    });

    for (let i = 0; i < 1000; i++) fn();

    expect(declarations).toBe(1);
  });

  it("returns one stable reference so call sites can do Fn()(...)", () => {
    const fn = lazyFunc(() => () => 7);
    expect(fn()).toBe(fn());
  });

  it("does not cache a falsy-but-valid declaration twice", () => {
    // Guards the `??=` choice: a declared function is never null/undefined, so
    // caching on the first access is correct.
    let declarations = 0;
    const fn = lazyFunc(() => {
      declarations++;
      return { value: declarations };
    });
    expect(fn().value).toBe(1);
    expect(fn().value).toBe(1);
    expect(declarations).toBe(1);
  });
});
