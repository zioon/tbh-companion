// app/src/core/unityAssets/bundleParser.ts
// UnityFS bundle parser. Pure (no node:fs), takes a Buffer, returns parsed
// structure + a single concatenated decompressed-data buffer.
//
// References:
//   - https://github.com/Perfare/UnityStudio/blob/master/UnityStudio/Assets/UnityFile.cs
//   - scripts/probe_bundle_format.py (validated against TBH v1.00.28)
//   - UnityPy `BundleFile.read_fs` (the reference implementation the layout
//     below was cross-checked against, byte for byte)
//
// Compression support: 0=none, 2=lz4, 3=lz4hc. lzma (1) is not used by TBH
// bundles but we throw a clear error if encountered.
//
// IMPORTANT: UnityFS uses BIG ENDIAN for all integer fields.
//
// Layout (verified against UnityPy on TBH v1.3.0, both the 1-block shared
// bundle and the 2-block EN string-table bundle):
//   1. Header ends, then the reader is aligned to 16 bytes (format >= 7).
//      The blocks-info blob starts there — NOT at a 4-byte-aligned offset.
//   2. The blocks-info blob decompresses to EXACTLY `uncompressedBlocksInfoSize`
//      bytes. The 16-byte uncompressed-data-hash is *inside* that payload, so
//      the destination is `uncompressedBlocksInfoSize` bytes, not `+ 16`.
//   3. Inside the payload: 16-byte hash, then blocksCount (int32), then the
//      block table, then the storage-entry table.
//   4. The data blocks start at the reader position after the blocks-info
//      blob, aligned up to 16 bytes (BlockInfoNeedPaddingAtStart). There is
//      no extra 16-byte step after the alignment.
//
// The three offsets above used to be wrong in ways that only showed up once
// the game shipped a bundle whose payload did not end where the old parser
// expected — see the comment on `blocksInfoOffset` below.

import lz4 from "lz4js";

const COMPRESSION_NONE = 0;
const COMPRESSION_LZMA = 1;
const COMPRESSION_LZ4 = 2;
const COMPRESSION_LZ4HC = 3;

const FLAG_COMPRESSION_MASK = 0x3f;
const FLAG_BLOCKS_INFO_AT_END = 0x80;
const FLAG_PADDING_AT_START = 0x200;

/** UnityFS format >= 7 aligns the reader to 16 bytes after the header. */
const MIN_ALIGNED_FORMAT = 7;

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
    // headroom, require at least the declared size, and return the ACTUAL
    // decompressed bytes (not truncated). Truncating would discard payload
    // data and cause downstream parsers to read out of bounds.
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
    // Return the ACTUAL decompressed bytes. Trailing bytes beyond
    // uncompressedSize are NOT padding to discard — they may be legitimate
    // payload that the declared size under-reports. Downstream consumers
    // (SerializedFile parser) use offsets relative to the concatenated
    // data stream, so returning the true size keeps offsets valid.
    return out.subarray(0, n);
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

  // Reader position right after the header, aligned to 16 bytes for format
  // >= 7 (UnityPy: `if self.version >= 7: reader.align_stream(16)`).
  const start = format >= MIN_ALIGNED_FORMAT ? align16(off) : off;

  let blocksInfoOffset: number;
  if (blocksInfoAtEnd) {
    blocksInfoOffset = Number(size) - compressedBlocksInfoSize;
  } else {
    // The blocks-info blob starts at the aligned reader position — NOT at a
    // 4-byte-aligned offset. The old code used a 4-byte alignment here,
    // which landed 12 bytes inside the zero padding: LZ4 then decoded that
    // padding as payload, shifting the whole blocks-info by 16 bytes and
    // truncating the tail (the storage entry's path). It happened to still
    // yield a plausible blocksCount on the 1-block shared bundle, so the bug
    // stayed hidden until the game shipped a 2-block bundle.
    blocksInfoOffset = start;
  }

  // Read blocks-info (may be compressed, even when data blocks use a different
  // compression). The decompressed payload is EXACTLY
  // `uncompressedBlocksInfoSize` bytes — the 16-byte uncompressed-data-hash
  // lives *inside* it, so the destination must not be enlarged.
  const blocksInfoAllocSize = uncompressedBlocksInfoSize;
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
  // Layout: 16-byte uncompressed-data-hash, then blocksCount (int32), then
  // the block table, then the storage-entry table.
  let p = 16; // skip the 16-byte uncompressed-data-hash
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
  // aligned up to a 16-byte boundary when BlockInfoNeedPaddingAtStart is set.
  //
  // The old code computed `align16(blocksInfoEnd + 16)` — i.e. it added a
  // 16-byte step *before* aligning. UnityPy's `reader.align_stream(16)`
  // aligns the reader's current position, which is already `blocksInfoEnd`;
  // there is no extra step. The two differ by 16 whenever
  // `blocksInfoEnd` is not ≡ 0 (mod 16), which is why the 1-block shared
  // bundle (blocksInfoEnd = 117) still worked while the 2-block EN bundle
  // (blocksInfoEnd = 129) read its data 16 bytes too far and produced
  // garbage that made the SerializedFile parser walk off the end of the
  // buffer ("Attempt to access memory outside buffer bounds").
  let dataStart: number;
  if (blocksInfoAtEnd) {
    // The reader is rewound to `start` after the blocks-info was read from
    // the end of the file, so the blocks start there.
    dataStart = start;
  } else {
    const blocksInfoEnd = blocksInfoOffset + compressedBlocksInfoSize;
    dataStart = blocksInfoEnd;
  }
  if (paddingAtStart) dataStart = align16(dataStart);

  // Decompress and concatenate all blocks. Use the ACTUAL decompressed size
  // of each block (not the declared uncompressedSize) when computing offsets
  // and the total — UnityFS may declare an aligned size while the LZ4 stream
  // produces extra bytes that are part of the payload. The SerializedFile
  // parser reads objects at offsets relative to this concatenated stream,
  // so the total must reflect the true byte count.
  const decompressedBlocks: Buffer[] = [];
  let totalActual = 0;
  let readOff = dataStart;
  for (const block of blocks) {
    const src = raw.subarray(readOff, readOff + block.compressedSize);
    const blockCompression = block.flags & FLAG_COMPRESSION_MASK;
    const decompressed = decompressBlock(src, block.uncompressedSize, blockCompression);
    decompressedBlocks.push(decompressed);
    totalActual += decompressed.length;
    readOff += block.compressedSize;
  }
  const data = Buffer.alloc(totalActual);
  let writeOff = 0;
  for (const buf of decompressedBlocks) {
    buf.copy(data, writeOff);
    writeOff += buf.length;
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
    dataLength: totalActual,
  };
}
