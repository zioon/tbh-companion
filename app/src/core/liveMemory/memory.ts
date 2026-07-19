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
