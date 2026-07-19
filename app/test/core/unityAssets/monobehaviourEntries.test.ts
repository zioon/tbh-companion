// app/test/core/unityAssets/monobehaviourEntries.test.ts
import { describe, it, expect } from "vitest";
import { scanMarkerEntries } from "../../../src/core/unityAssets/monobehaviourEntries";

function buildEntry(keyId: number, hash: number, str: string): Buffer {
  const strBuf = Buffer.from(str, "utf-8");
  const slen = strBuf.length;
  const pad = (4 - (slen % 4)) % 4;
  return Buffer.concat([
    Buffer.from([
      keyId & 0xff,
      (keyId >>> 8) & 0xff,
      (keyId >>> 16) & 0xff,
      (keyId >>> 24) & 0xff,
      hash & 0xff,
      (hash >>> 8) & 0xff,
      (hash >>> 16) & 0xff,
      (hash >>> 24) & 0xff,
      14,
      0,
      0,
      0, // marker = 14
      slen & 0xff,
      (slen >>> 8) & 0xff,
      (slen >>> 16) & 0xff,
      (slen >>> 24) & 0xff,
    ]),
    strBuf,
    Buffer.alloc(pad, 0),
  ]);
}

describe("scanMarkerEntries", () => {
  it("returns empty array for empty input", () => {
    expect(scanMarkerEntries(Buffer.alloc(0))).toEqual([]);
  });

  it("parses a single well-formed entry", () => {
    const buf = buildEntry(626, 0x22d8410a, "ItemName_110001");
    const hits = scanMarkerEntries(buf);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      offset: 0,
      keyId: 626,
      hash: 0x22d8410a,
      len: 15,
      str: "ItemName_110001",
    });
  });

  it("parses multiple consecutive entries", () => {
    const buf = Buffer.concat([
      buildEntry(626, 0x22d8410a, "ItemName_110001"),
      buildEntry(0, 0x22d8410b, "ItemName_120001"),
      buildEntry(0, 0x22d8410c, "ItemName_130001"),
    ]);
    const hits = scanMarkerEntries(buf);
    expect(hits).toHaveLength(3);
    expect(hits[1].str).toBe("ItemName_120001");
    expect(hits[2].str).toBe("ItemName_130001");
  });

  it("skips non-marker bytes and resumes scanning", () => {
    const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    const entry = buildEntry(0, 0x22d8410a, "ItemName_110001");
    const buf = Buffer.concat([junk, entry]);
    const hits = scanMarkerEntries(buf);
    expect(hits).toHaveLength(1);
    expect(hits[0].offset).toBe(junk.length);
  });

  it("rejects strings with non-printable chars", () => {
    const strBuf = Buffer.from([0x01, 0x02, 0x03]); // non-printable
    const header = Buffer.from([
      0,
      0,
      0,
      0, // keyId
      0,
      0,
      0,
      0, // hash
      14,
      0,
      0,
      0, // marker
      3,
      0,
      0,
      0, // len = 3
    ]);
    const buf = Buffer.concat([header, strBuf]);
    expect(scanMarkerEntries(buf)).toEqual([]);
  });

  it("rejects slen > 256", () => {
    const header = Buffer.from([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      14,
      0,
      0,
      0,
      0x01,
      0x01,
      0x00,
      0x00, // len = 257 (> MAX_LEN)
    ]);
    const buf = Buffer.concat([header, Buffer.alloc(257, 0x41)]);
    expect(scanMarkerEntries(buf)).toEqual([]);
  });
});
