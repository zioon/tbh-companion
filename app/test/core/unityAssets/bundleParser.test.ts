// app/test/core/unityAssets/bundleParser.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBundle } from "../../../src/core/unityAssets/bundleParser";

const FIXTURE = join(__dirname, "fixtures", "shared_assets.bundle");

describe("parseBundle", () => {
  it("parses the real shared_assets.bundle fixture", () => {
    const raw = readFileSync(FIXTURE);
    const result = parseBundle(raw);
    expect(result.signature).toBe("UnityFS");
    expect(result.format).toBeGreaterThanOrEqual(6);
    expect(result.blocks).toBeInstanceOf(Array);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.dataLength).toBeGreaterThan(10000);
  });

  it("decompresses all blocks into a single buffer", () => {
    const raw = readFileSync(FIXTURE);
    const result = parseBundle(raw);
    // The decompressed data should contain recognizable strings like "ItemName_".
    const str = result.data.toString("utf-8", 0, Math.min(result.data.length, 200000));
    expect(str).toContain("ItemName_");
  });

  it("rejects invalid signature", () => {
    expect(() => parseBundle(Buffer.from("NOTABUNDLE\x00rest"))).toThrow(/signature/i);
  });
});
