// app/test/core/unityAssets/textAsset.test.ts
import { describe, it, expect } from "vitest";
import { parseTextAssetRaw } from "../../../src/core/unityAssets/textAsset";

function buildTextAsset(name: string, script: string): Buffer {
  const nameBuf = Buffer.from(name, "utf-8");
  const scriptBuf = Buffer.from(script, "utf-8");
  const namePad = (4 - (nameBuf.length % 4)) % 4;
  const scriptPad = (4 - (scriptBuf.length % 4)) % 4;
  return Buffer.concat([
    Buffer.from([
      nameBuf.length & 0xff,
      (nameBuf.length >>> 8) & 0xff,
      (nameBuf.length >>> 16) & 0xff,
      (nameBuf.length >>> 24) & 0xff,
    ]),
    nameBuf,
    Buffer.alloc(namePad, 0),
    Buffer.from([
      scriptBuf.length & 0xff,
      (scriptBuf.length >>> 8) & 0xff,
      (scriptBuf.length >>> 16) & 0xff,
      (scriptBuf.length >>> 24) & 0xff,
    ]),
    scriptBuf,
    Buffer.alloc(scriptPad, 0),
  ]);
}

describe("parseTextAssetRaw", () => {
  it("returns null/null for empty input", () => {
    const [name, script] = parseTextAssetRaw(Buffer.alloc(0));
    expect(name).toBeNull();
    expect(script).toBeNull();
  });

  it("parses name + script with no padding", () => {
    const buf = buildTextAsset("ItemInfoData", "hello");
    const [name, script] = parseTextAssetRaw(buf);
    expect(name).toBe("ItemInfoData");
    expect(script).toBe("hello");
  });

  it("parses name + script with padding", () => {
    const buf = buildTextAsset("ItemInfoData", "abcd".repeat(100));
    const [name, script] = parseTextAssetRaw(buf);
    expect(name).toBe("ItemInfoData");
    expect(script).toBe("abcd".repeat(100));
  });

  it("returns null script when buffer is truncated", () => {
    const buf = buildTextAsset("ItemInfoData", "hello");
    const truncated = buf.subarray(0, 20); // cut in the middle of script
    const [name, script] = parseTextAssetRaw(truncated);
    expect(name).toBe("ItemInfoData");
    expect(script).toBeNull();
  });

  it("rejects implausible name length", () => {
    const header = Buffer.from([0xff, 0xff, 0xff, 0xff]); // name_len = 4 billion
    const [name, script] = parseTextAssetRaw(header);
    expect(name).toBeNull();
    expect(script).toBeNull();
  });
});
