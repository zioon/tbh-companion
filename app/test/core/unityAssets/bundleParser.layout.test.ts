// app/test/core/unityAssets/bundleParser.layout.test.ts
//
// Regression guard for the v1.3.0 catalog-refresh crash
// ("Attempt to access memory outside buffer bounds").
//
// The parser used to read the blocks-info blob from a 4-byte-aligned offset
// and to add an extra 16-byte step before aligning the data-block start.
// Both are wrong: UnityFS format >= 7 aligns the reader to 16 bytes after the
// header, and the blocks-info payload is exactly `uncompressedBlocksInfoSize`
// bytes with the 16-byte hash *inside* it.
//
// The bug stayed hidden because every bundle up to v1.00.28 had a single data
// block. Game v1.3.0 shipped a 2-block EN string-table bundle, which made the
// 16-byte drift fatal: the SerializedFile header was read from the wrong
// place and the parser walked off the end of the buffer.
//
// These assertions pin the layout against the committed fixtures (both the
// 1-block shared bundle and the 2-block EN bundle).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import lz4 from "lz4js";
import { parseBundle } from "../../../src/core/unityAssets/bundleParser";
import { parseSerializedFile } from "../../../src/core/unityAssets/serializedFile";

const FIXTURES = join(__dirname, "fixtures");

function header(raw: Buffer) {
  let off = raw.indexOf(0, 0) + 1;
  const format = raw.readUInt32BE(off);
  off += 4;
  off = raw.indexOf(0, off) + 1;
  off = raw.indexOf(0, off) + 1;
  off += 8;
  const compressedBlocksInfoSize = raw.readUInt32BE(off);
  off += 4;
  const uncompressedBlocksInfoSize = raw.readUInt32BE(off);
  off += 4;
  const flags = raw.readUInt32BE(off);
  off += 4;
  return { format, compressedBlocksInfoSize, uncompressedBlocksInfoSize, flags, off };
}

describe("parseBundle — UnityFS layout invariants", () => {
  it("reads the blocks-info blob from the 16-byte-aligned header end", () => {
    const raw = readFileSync(join(FIXTURES, "shared_assets.bundle"));
    const h = header(raw);
    expect(h.format).toBeGreaterThanOrEqual(7);

    // The blocks-info blob is LZ4-compressed; decoding it from the aligned
    // offset must yield exactly uncompressedBlocksInfoSize bytes.
    const start = (h.off + 15) & ~15;
    const blob = raw.subarray(start, start + h.compressedBlocksInfoSize);
    const dst = Buffer.alloc(h.uncompressedBlocksInfoSize);
    const n = lz4.decompressBlock(blob, dst, 0, h.compressedBlocksInfoSize, 0);
    expect(n).toBe(h.uncompressedBlocksInfoSize);
    // The 16-byte uncompressed-data-hash is inside the payload, and
    // blocksCount follows it directly.
    expect(dst.readUInt32BE(16)).toBe(1);
  });

  it("decompresses the 1-block shared bundle to its exact declared size", () => {
    const raw = readFileSync(join(FIXTURES, "shared_assets.bundle"));
    const result = parseBundle(raw);
    expect(result.blocks).toHaveLength(1);
    expect(result.dataLength).toBe(result.blocks[0]!.uncompressedSize);
    // The decompressed payload starts with a SerializedFile v22 header.
    expect(result.data.readInt32BE(8)).toBe(22);
  });

  it("decompresses the 2-block EN string-table bundle to its exact declared size", () => {
    const raw = readFileSync(join(FIXTURES, "en_stringtable.bundle"));
    const result = parseBundle(raw);
    // v1.3.0 ships a two-block bundle — this is the case that used to crash.
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
    const declared = result.blocks.reduce((sum, b) => sum + b.uncompressedSize, 0);
    expect(result.dataLength).toBe(declared);
    // The first block must start with a SerializedFile v22 header, i.e. the
    // data blocks really begin where the parser thinks they do.
    expect(result.data.readInt32BE(8)).toBe(22);
  });

  it("exposes a complete storage-entry path (not truncated by a mis-aligned read)", () => {
    for (const name of ["shared_assets.bundle", "en_stringtable.bundle"]) {
      const result = parseBundle(readFileSync(join(FIXTURES, name)));
      expect(result.storageEntries.length).toBeGreaterThan(0);
      for (const entry of result.storageEntries) {
        // A truncated path loses its trailing hex characters.
        expect(entry.name).toMatch(/^CAB-[0-9a-f]{32}$/);
      }
    }
  });

  it("parses the SerializedFile header of the 2-block bundle", () => {
    const raw = readFileSync(join(FIXTURES, "en_stringtable.bundle"));
    const result = parseBundle(raw);
    const sf = parseSerializedFile(result.data);
    expect(sf.version).toBe(22);
    expect(sf.objects.length).toBeGreaterThan(0);
    // Every object must lie inside the buffer — the old parser read a
    // 16-byte-shifted stream, so object offsets pointed past the end.
    for (const obj of sf.objects) {
      const start = sf.dataOffset + obj.offset;
      expect(start + obj.size).toBeLessThanOrEqual(result.data.length);
    }
  });
});
