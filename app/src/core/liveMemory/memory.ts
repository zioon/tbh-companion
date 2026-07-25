// Pure primitive readers over an injected MemoryReader.
//
// The live-memory read algorithms live in core so they can be unit-tested over
// synthetic memory maps. The impure koffi/ReadProcessMemory backing implements
// MemoryReader in the utilityProcess worker. No node/electron/koffi imports here.

/** Minimal read-only view of a process's address space. */
export interface MemoryReader {
  /** Read `size` bytes at `addr`, or null if the region is unreadable. */
  readBytes(addr: bigint, size: number): Buffer | null;
}

/** Read a 64-bit pointer; null for short reads or implausibly-low values (< 0x10000). */
export function readPtr(reader: MemoryReader, addr: bigint): bigint | null {
  const b = reader.readBytes(addr, 8);
  if (!b || b.length < 8) return null;
  const v = b.readBigUInt64LE(0);
  return v < 0x10000n ? null : v;
}

/**
 * Read `count` contiguous 64-bit pointers starting at `base`. Returns the same
 * `(bigint | null)[]` shape as calling `readPtr` per slot, but uses a SINGLE
 * `readBytes` call for the whole backing array when possible — this is the
 * hot path for IL2CPP `T[]` arrays (inventory item pointers, pet pointers,
 * hero party pointers) where per-slot `readPtr` would issue N separate
 * `ReadProcessMemory` kernel calls.
 *
 * Falls back to per-slot `readPtr` when:
 *   - the bulk read returns null (e.g. the array spans a region boundary that
 *     `ReadProcessMemory` can't cross in a single call), or
 *   - the bulk read returns fewer than `count * 8` bytes (short read).
 *
 * Both fallbacks match the previous per-slot behavior exactly, so existing
 * tests over exact-address-keyed `FakeMemory` keep working unchanged.
 *
 * Returns `null` only when `count <= 0` (caller should treat as empty input).
 */
export function readPtrArray(
  reader: MemoryReader,
  base: bigint,
  count: number,
): (bigint | null)[] | null {
  if (count <= 0) return [];
  const total = count * 8;
  const buf = reader.readBytes(base, total);
  if (buf && buf.length === total) {
    const out: (bigint | null)[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const v = buf.readBigUInt64LE(i * 8);
      out[i] = v < 0x10000n ? null : v;
    }
    return out;
  }
  // Bulk read failed or partial — fall back to per-slot readPtr.
  const out: (bigint | null)[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = readPtr(reader, base + BigInt(i * 8));
  }
  return out;
}

/** Read a signed 32-bit int; null for short reads. */
export function readI32(reader: MemoryReader, addr: bigint): number | null {
  const b = reader.readBytes(addr, 4);
  return b && b.length >= 4 ? b.readInt32LE(0) : null;
}

/** Read an unsigned 32-bit int; null for short reads (used by ACTk Obscured decode). */
export function readU32(reader: MemoryReader, addr: bigint): number | null {
  const b = reader.readBytes(addr, 4);
  return b && b.length >= 4 ? b.readUInt32LE(0) : null;
}

/** Read a 32-bit float; null for short reads. */
export function readF32(reader: MemoryReader, addr: bigint): number | null {
  const b = reader.readBytes(addr, 4);
  return b && b.length >= 4 ? b.readFloatLE(0) : null;
}

/** Read a signed 64-bit int; null for short reads. */
export function readI64(reader: MemoryReader, addr: bigint): bigint | null {
  const b = reader.readBytes(addr, 8);
  return b && b.length >= 8 ? b.readBigInt64LE(0) : null;
}

/** Read an unsigned 64-bit int; null for short reads (used by ACTk ObscuredDouble decode). */
export function readU64(reader: MemoryReader, addr: bigint): bigint | null {
  const b = reader.readBytes(addr, 8);
  return b && b.length >= 8 ? b.readBigUInt64LE(0) : null;
}

/**
 * Read an IL2CPP System.String at `addr`. Layout (Unity standard):
 *   +0x00: Il2CppClass* klass
 *   +0x08: Il2CppMonitor* monitor
 *   +0x10: int32 length (char count, excluding NUL)
 *   +0x14: char[] first char (UTF-16, 2 bytes per char)
 *
 * Returns the decoded UTF-16 string, or null when the pointer is unreadable,
 * the length is implausible (< 0 or > 4096), or the char buffer is short.
 */
export function readIl2CppString(reader: MemoryReader, addr: bigint): string | null {
  const len = readI32(reader, addr + 0x10n);
  if (len == null || len < 0 || len > 4096) return null;
  if (len === 0) return "";
  const buf = reader.readBytes(addr + 0x14n, len * 2);
  if (buf == null || buf.length < len * 2) return null;
  return buf.toString("utf16le", 0, len * 2);
}
