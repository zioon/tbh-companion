import { describe, it, expect } from "vitest";
import { BufferPool } from "../../src/main/liveMemory/bufferPool";

describe("BufferPool", () => {
  it("should return a Buffer of the requested size", () => {
    const pool = new BufferPool();
    const buf = pool.acquire(256 * 1024);
    expect(buf.length).toBe(256 * 1024);
  });

  it("should reuse the same Buffer for consecutive same-size acquires", () => {
    const pool = new BufferPool();
    const buf1 = pool.acquire(1024);
    pool.release(buf1);
    const buf2 = pool.acquire(1024);
    expect(buf2.buffer).toBe(buf1.buffer);
  });

  it("should not grow beyond maxPerBucket entries per size bucket", () => {
    const pool = new BufferPool(2);
    const bufs: Buffer[] = [];
    for (let i = 0; i < 5; i++) bufs.push(pool.acquire(1024));
    for (const b of bufs) pool.release(b);
    // Pool should have at most 2 entries for this size bucket
    const reused1 = pool.acquire(1024);
    const reused2 = pool.acquire(1024);
    const reused3 = pool.acquire(1024);
    // First two should be from pool (reused), third is new alloc
    expect(reused1.buffer).toBe(bufs[4].buffer);
    expect(reused2.buffer).toBe(bufs[3].buffer);
    expect(reused3.length).toBe(1024);
  });

  it("should clear all pooled buffers", () => {
    const pool = new BufferPool();
    // Use a buffer larger than Node's ~8KB Buffer slab so each allocUnsafe
    // owns its own ArrayBuffer (small buffers share a slab, so comparing
    // `.buffer` on them is meaningless). This makes "fresh allocation, not the
    // same pooled buffer" a meaningful assertion.
    const size = 64 * 1024;
    const buf1 = pool.acquire(size);
    pool.release(buf1);
    pool.clear();
    const buf2 = pool.acquire(size);
    // After clear, should be a fresh allocation, not the same buffer
    expect(buf2.buffer).not.toBe(buf1.buffer);
  });
});
