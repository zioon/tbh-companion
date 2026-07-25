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
    // LRU eviction: when the bucket is full, drop the oldest entry to make
    // room for the newest. The header comment says "small LRU cache" but the
    // previous implementation dropped the *newest* (early return), which left
    // the pool holding stale buffers while fresh ones were discarded — the
    // opposite of LRU. Tests assert the LRU contract (most-recently-released
    // survives).
    if (bucket.length >= this.maxPerBucket) {
      bucket.shift();
    } else {
      this.totalPooled++;
    }
    bucket.push(buf);
  }

  /** Clear all pooled buffers. */
  clear(): void {
    this.pool.clear();
    this.totalPooled = 0;
  }
}
