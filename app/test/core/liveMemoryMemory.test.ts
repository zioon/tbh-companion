// Unit tests for the bulk primitives in core/liveMemory/memory.ts.
// readPtrArray is the hot path for inventory/pets/hero-list reads:
//   one ReadProcessMemory call instead of N per-slot readPtr calls.

import { describe, it, expect } from "vitest";
import { readPtrArray } from "../../src/core/liveMemory/memory";
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
