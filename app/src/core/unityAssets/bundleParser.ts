// app/src/core/unityAssets/bundleParser.ts
// UnityFS bundle parser. Pure (no node:fs), takes a Buffer, returns parsed
// structure + a single concatenated decompressed-data buffer.
//
// References:
//   - https://github.com/Perfare/UnityStudio/blob/master/UnityStudio/Assets/UnityFile.cs
//   - scripts/probe_bundle_format.py (validated against TBH v1.00.28)
//
// Compression support: 0=none, 2=lz4, 3=lz4hc. lzma (1) is not used by TBH
// bundles but we throw a clear error if encountered.
//
// IMPORTANT: UnityFS uses BIG ENDIAN for all integer fields. The 16-byte
// uncompressed-data-hash at the start of BlocksInfo is NOT counted in
// `uncompressedBlocksInfoSize`; allocate `uncompressedBlocksInfoSize + 16`
// for the LZ4 destination. On format 8 (TBH v1.00.28), an additional 16-byte
// block-info hash follows, so `p` starts at 32 (not 16) when scanning for
// blocksCount.

import lz4 from "lz4js";

const COMPRESSION_NONE = 0;
const COMPRESSION_LZMA = 1;
const COMPRESSION_LZ4 = 2;
const COMPRESSION_LZ4HC = 3;

const FLAG_COMPRESSION_MASK = 0x3f;
const FLAG_BLOCKS_INFO_AT_END = 0x80;
const FLAG_PADDING_AT_START = 0x200;

export interface BundleBlock {
  uncompressedSize: number;
  compressedSize: number;
  flags: number;
}

export interface BundleStorageEntry {
  offset: bigint;
  size: bigint;
  flags: number;
  name: string;
}

export interface ParsedBundle {
  signature: string;
  format: number;
  unityVersion: string;
  unityRevision: string;
  size: bigint;
  flags: number;
  blocks: BundleBlock[];
  storageEntries: BundleStorageEntry[];
  /** All decompressed blocks concatenated. This is the SerializedFile payload. */
  data: Buffer;
  dataLength: number;
}

function readCString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) throw new Error("unterminated cstring in bundle header");
  return [buf.subarray(offset, end).toString("utf-8"), end + 1];
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

function align16(n: number): number {
  return (n + 15) & ~15;
}

function decompressBlock(src: Buffer, uncompressedSize: number, compression: number): Buffer {
  if (compression === COMPRESSION_NONE) return src;
  if (compression === COMPRESSION_LZMA) {
    throw new Error("LZMA compression not supported (TBH bundles use lz4)");
  }
  if (compression === COMPRESSION_LZ4 || compression === COMPRESSION_LZ4HC) {
    // Allocate headroom beyond the declared uncompressedSize. UnityFS blocks
    // sometimes declare an aligned uncompressedSize while the LZ4 stream
    // actually produces a few extra bytes (padding to the next compression
    // boundary). lz4js decompresses until the input is consumed, so the
    // returned byte count may exceed the declared size — we allocate
    // headroom, require at least the declared size, then truncate.
    const allocSize = uncompressedSize + 4096;
    const out = Buffer.alloc(allocSize);
    // lz4js.decompressBlock is the synchronous raw-block primitive.
    // Signature: (src, dst, sIndex, sLength, dIndex) -> new dIndex (= bytes written).
    // Note: lz4js has NO 2-arg decodeBlock and NO stream API; decompress() is for
    // whole lz4 frames (with magic 0x184D2204), which UnityFS blocks are NOT.
    const n = lz4.decompressBlock(src, out, 0, src.length, 0);
    if (n < uncompressedSize) {
      throw new Error(
        `lz4 decompression incomplete: expected at least ${uncompressedSize}, got ${n}`,
      );
    }
    // Truncate to the declared payload size; trailing bytes are padding.
    return out.subarray(0, uncompressedSize);
  }
  throw new Error(`unknown block compression: ${compression}`);
}

export function parseBundle(raw: Buffer): ParsedBundle {
  // Header. Signature is checked first so clearly-invalid buffers fail with
  // a /signature/i error rather than "bundle too small".
  const sigTuple = readCString(raw, 0);
  const signature = sigTuple[0];
  let off = sigTuple[1];
  if (signature !== "UnityFS") {
    throw new Error(`unexpected bundle signature: ${signature}`);
  }
  if (raw.length < 50) throw new Error("bundle too small");

  const format = raw.readUInt32BE(off);
  off += 4;
  const cvTuple = readCString(raw, off);
  const cv = cvTuple[0];
  off = cvTuple[1];
  const urTuple = readCString(raw, off);
  const ur = urTuple[0];
  off = urTuple[1];
  const size = raw.readBigInt64BE(off);
  off += 8;
  const compressedBlocksInfoSize = raw.readUInt32BE(off);
  off += 4;
  const uncompressedBlocksInfoSize = raw.readUInt32BE(off);
  off += 4;
  const flags = raw.readUInt32BE(off);
  off += 4;

  // BlocksInfo position.
  const compression = flags & FLAG_COMPRESSION_MASK;
  const blocksInfoAtEnd = (flags & FLAG_BLOCKS_INFO_AT_END) !== 0;
  const paddingAtStart = (flags & FLAG_PADDING_AT_START) !== 0;

  let blocksInfoOffset: number;
  if (blocksInfoAtEnd) {
    blocksInfoOffset = Number(size) - compressedBlocksInfoSize;
  } else {
    blocksInfoOffset = align4(off);
  }

  // Read blocks-info (may be compressed, even when data blocks use a different compression).
  // uncompressedBlocksInfoSize excludes the 16-byte uncompressed-data-hash that
  // prefixes the payload, so the LZ4 destination must be `+ 16` larger.
  const blocksInfoAllocSize = uncompressedBlocksInfoSize + 16;
  let blocksInfo: Buffer;
  if (compression === COMPRESSION_NONE) {
    blocksInfo = raw.subarray(blocksInfoOffset, blocksInfoOffset + blocksInfoAllocSize);
  } else if (compression === COMPRESSION_LZ4 || compression === COMPRESSION_LZ4HC) {
    blocksInfo = Buffer.alloc(blocksInfoAllocSize);
    const n = lz4.decompressBlock(
      raw.subarray(blocksInfoOffset, blocksInfoOffset + compressedBlocksInfoSize),
      blocksInfo,
      0,
      compressedBlocksInfoSize,
      0,
    );
    if (n !== blocksInfoAllocSize) {
      throw new Error(`blocks-info lz4 size mismatch: ${n} vs ${blocksInfoAllocSize}`);
    }
  } else if (compression === COMPRESSION_LZMA) {
    throw new Error("LZMA blocks-info not supported");
  } else {
    throw new Error(`unknown blocks-info compression: ${compression}`);
  }

  // Parse BlocksInfo payload.
  // Layout (format 8, TBH v1.00.28): 16-byte uncompressed-data-hash + 16-byte
  // block-info-hash, then blocksCount, blocks, storageEntriesCount, entries.
  // Older formats may have only one 16-byte hash; this parser targets TBH's
  // format 8 layout where the second hash is present (verified empirically).
  let p = 32; // skip 16-byte data hash + 16-byte block-info hash
  const blocksCount = blocksInfo.readUInt32BE(p);
  p += 4;
  const blocks: BundleBlock[] = [];
  for (let i = 0; i < blocksCount; i++) {
    const uncompressedSize = blocksInfo.readUInt32BE(p);
    p += 4;
    const compressedSize = blocksInfo.readUInt32BE(p);
    p += 4;
    const blockFlags = blocksInfo.readUInt16BE(p);
    p += 2;
    blocks.push({ uncompressedSize, compressedSize, flags: blockFlags });
  }
  const storageEntriesCount = blocksInfo.readUInt32BE(p);
  p += 4;
  const storageEntries: BundleStorageEntry[] = [];
  for (let i = 0; i < storageEntriesCount; i++) {
    const entryOffset = blocksInfo.readBigInt64BE(p);
    p += 8;
    const entrySize = blocksInfo.readBigInt64BE(p);
    p += 8;
    const entryFlags = blocksInfo.readUInt32BE(p);
    p += 4;
    let name: string;
    [name, p] = readCString(blocksInfo, p);
    storageEntries.push({ offset: entryOffset, size: entrySize, flags: entryFlags, name });
  }

  // Data blocks start position: right after the BlocksInfo (when not at end),
  // with optional padding to a 16-byte boundary plus an extra 16 bytes when
  // FLAG_PADDING_AT_START is set. When BlocksInfo lives at the end of the file,
  // the data blocks still come right after the header.
  let dataStart: number;
  if (blocksInfoAtEnd) {
    dataStart = align4(off);
    if (paddingAtStart) dataStart = align16(dataStart + 16);
  } else {
    const blocksInfoEnd = blocksInfoOffset + compressedBlocksInfoSize;
    dataStart = paddingAtStart ? align16(blocksInfoEnd + 16) : blocksInfoEnd;
  }

  // Decompress and concatenate all blocks.
  const totalUncompressed = blocks.reduce((sum, b) => sum + b.uncompressedSize, 0);
  const data = Buffer.alloc(totalUncompressed);
  let writeOff = 0;
  let readOff = dataStart;
  for (const block of blocks) {
    const src = raw.subarray(readOff, readOff + block.compressedSize);
    const blockCompression = block.flags & FLAG_COMPRESSION_MASK;
    const decompressed = decompressBlock(src, block.uncompressedSize, blockCompression);
    decompressed.copy(data, writeOff);
    writeOff += block.uncompressedSize;
    readOff += block.compressedSize;
  }

  return {
    signature,
    format,
    unityVersion: cv,
    unityRevision: ur,
    size,
    flags,
    blocks,
    storageEntries,
    data,
    dataLength: totalUncompressed,
  };
}
