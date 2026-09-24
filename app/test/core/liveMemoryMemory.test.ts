// Unit tests for the bulk primitives in core/liveMemory/memory.ts.
// readPtrArray is the hot path for inventory/pets/hero-list reads:
//   one ReadProcessMemory call instead of N per-slot readPtr calls.

import { describe, it, expect } from "vitest";
import { readChunk, readPtrArray, type MemoryReader } from "../../src/core/liveMemory/memory";
import { FakeMemory } from "./liveMemoryFake";

describe("readPtrArray", () => {
  it("returns [] when count <= 0", () => {
    expect(readPtrArray(new FakeMemory(), 0x1000n, 0)).toEqual([]);
    expect(readPtrArray(new FakeMemory(), 0x1000n, -1)).toEqual([]);
  });

  it("bulk-reads all pointers in one call when the buffer is contiguous", () => {
    // One contiguous 24-byte buffer at 0x1000 holding 3 pointers. The fast
    // path issues a single readBytes(0x1000, 24) call and decodes them all.
    const buf = Buffer.alloc(24);
    buf.writeBigUInt64LE(0xdead0000n, 0);
    buf.writeBigUInt64LE(0n, 8); // implausibly low → null
    buf.writeBigUInt64LE(0xbeef1000n, 16);
    const m = new FakeMemory().writeBytes(0x1000n, buf);

    expect(readPtrArray(m, 0x1000n, 3)).toEqual([0xdead0000n, null, 0xbeef1000n]);
  });

  it("falls back to per-slot readPtr when the bulk read returns null", () => {
    // No bulk buffer at 0x2000 — only individual pointers at 0x2000/0x2008.
    // This is the FakeMemory pattern used by liveMemoryRuntime tests today:
    // each pointer is seeded with writePtr(slot, val) at its own address.
    const m = new FakeMemory().writePtr(0x2000n, 0xaa0000n).writePtr(0x2008n, 0xbb0000n);

    const out = readPtrArray(m, 0x2000n, 2);
    expect(out).toEqual([0xaa0000n, 0xbb0000n]);
  });

  it("falls back to per-slot readPtr when the bulk read returns a short buffer", () => {
    // Bulk buffer is only 8 bytes but count asks for 16 bytes (2 pointers).
    // The bulk read returns a short buffer (b.length=8 < 16) → fallback path.
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(0xcc0000n, 0);
    const m = new FakeMemory()
      .writeBytes(0x3000n, buf) // 8 bytes only
      .writePtr(0x3000n, 0xcc0000n)
      .writePtr(0x3008n, 0xdd0000n);

    expect(readPtrArray(m, 0x3000n, 2)).toEqual([0xcc0000n, 0xdd0000n]);
  });

  it("nulls slots whose value is implausibly low (< 0x10000)", () => {
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(0n, 0);
    buf.writeBigUInt64LE(0x1n, 8);
    const m = new FakeMemory().writeBytes(0x4000n, buf);

    expect(readPtrArray(m, 0x4000n, 2)).toEqual([null, null]);
  });
});

/**
 * Mirrors the real `WinProcess`: owns one reusable scan buffer and counts how
 * many times a fresh one is allocated, so the "one buffer per region walk"
 * contract can be asserted instead of only the returned bytes.
 */
class ReusingMemory implements MemoryReader {
  allocations = 0;
  backingStores = 0;
  private buf: Buffer | null = null;
  private readonly cells = new Map<string, Buffer>();

  seed(addr: bigint, bytes: Buffer): this {
    this.cells.set(addr.toString(), bytes);
    return this;
  }

  readBytes(addr: bigint, size: number): Buffer | null {
    const b = this.cells.get(addr.toString());
    if (!b || b.length < size) return null;
    return b.subarray(0, size);
  }

  acquireScanBuffer(size: number): Buffer {
    if (this.buf != null && this.buf.length >= size) return this.buf;
    this.buf = Buffer.alloc(size);
    this.allocations++;
    this.backingStores++;
    return this.buf;
  }

  readInto(addr: bigint, buf: Buffer, size: number): number {
    const b = this.cells.get(addr.toString());
    if (!b) return 0;
    const n = Math.min(size, b.length);
    b.copy(buf, 0, 0, n);
    return n;
  }
}

describe("readChunk", () => {
  it("reuses ONE buffer across a whole region walk", () => {
    // The RSS regression this guards: a per-chunk 4 MiB allocation leaves ~350 MB
    // of native memory stranded per traversal (measured on the real game), so a
    // walk must never allocate more than once.
    const m = new ReusingMemory()
      .seed(0x1000n, Buffer.from([1, 2, 3, 4]))
      .seed(0x2000n, Buffer.from([5, 6, 7, 8]))
      .seed(0x3000n, Buffer.from([9, 10, 11, 12]));

    // Each chunk aliases the same buffer, so it must be consumed (copied) before
    // the next read — exactly what the region walks do.
    const observed = [0x1000n, 0x2000n, 0x3000n].map((addr) =>
      Array.from(readChunk(m, addr, 4) ?? []),
    );

    expect(observed).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ]);
    expect(m.allocations).toBe(1);
    // …and every chunk really did alias one backing store.
    expect(m.backingStores).toBe(1);
  });

  it("bounds the returned view to the bytes actually read", () => {
    // A short read must not expose stale bytes from the previous chunk: the
    // second seed is only 3 bytes long while 8 were requested.
    const m = new ReusingMemory()
      .seed(0x1000n, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
      .seed(0x2000n, Buffer.from([9, 9, 9]));

    readChunk(m, 0x1000n, 8);
    const short = readChunk(m, 0x2000n, 8);

    expect(short).not.toBeNull();
    expect(short!.length).toBe(3);
    expect(Array.from(short!)).toEqual([9, 9, 9]);
  });

  it("returns null when the chunk is unreadable", () => {
    expect(readChunk(new ReusingMemory(), 0x9000n, 4)).toBeNull();
  });

  it("grows the buffer when a later chunk needs more room", () => {
    const m = new ReusingMemory()
      .seed(0x1000n, Buffer.from([1, 2, 3, 4]))
      .seed(0x2000n, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

    readChunk(m, 0x1000n, 4);
    const big = readChunk(m, 0x2000n, 8);

    expect(Array.from(big!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(m.allocations).toBe(2);
  });

  it("falls back to readBytes for readers without the optional scan API", () => {
    // FakeMemory implements only `readBytes` — the pure scanner path must keep
    // working unchanged for unit tests and any other reader.
    const m = new FakeMemory().writeBytes(0x1000n, Buffer.from([7, 7, 7, 7]));
    expect(Array.from(readChunk(m, 0x1000n, 4)!)).toEqual([7, 7, 7, 7]);
    expect(readChunk(m, 0x2000n, 4)).toBeNull();
  });
});
