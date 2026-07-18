// Shared test double: a synthetic address space implementing MemoryReader.
// Not a test file (no .test suffix) — imported by the core liveMemory tests.

import type { MemoryReader } from "../../src/core/liveMemory/memory";

/**
 * A sparse fake memory keyed by exact address. Unlike a real MemoryReader,
 * writes only populate specific slots, but reads return zero-filled buffers
 * for any range that overlaps at least one written slot. This enables
 * heap-scanning tests where the scanner walks large regions looking for
 * specific pointer values, while still returning null for truly unwritten
 * addresses (required by other tests).
 */
export class FakeMemory implements MemoryReader {
  private readonly words = new Map<string, Buffer>();

  writePtr(addr: bigint, value: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
    this.words.set(addr.toString(), b);
    return this;
  }

  writeI32(addr: bigint, value: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value, 0);
    this.words.set(addr.toString(), b);
    return this;
  }

  writeU32(addr: bigint, value: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    this.words.set(addr.toString(), b);
    return this;
  }

  writeF32(addr: bigint, value: number): this {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value, 0);
    this.words.set(addr.toString(), b);
    return this;
  }

  writeBytes(addr: bigint, buf: Buffer): this {
    this.words.set(addr.toString(), buf);
    return this;
  }

  readBytes(addr: bigint, size: number): Buffer | null {
    // Check if any written slot falls within the requested range.
    // If nothing was written in this range, return null (unreachable address).
    let hasAnyWrittenSlot = false;
    for (const key of this.words.keys()) {
      const writtenAddr = BigInt(key);
      if (writtenAddr >= addr && writtenAddr < addr + BigInt(size)) {
        hasAnyWrittenSlot = true;
        break;
      }
    }
    if (!hasAnyWrittenSlot) return null;

    // Build a zero-filled buffer and copy any written data into it.
    const result = Buffer.alloc(size, 0);
    for (const [key, data] of this.words) {
      const writtenAddr = BigInt(key);
      if (writtenAddr < addr || writtenAddr >= addr + BigInt(size)) continue;
      const offset = Number(writtenAddr - addr);
      const copySize = Math.min(data.length, size - offset);
      data.copy(result, offset, 0, copySize);
    }
    return result;
  }
}
