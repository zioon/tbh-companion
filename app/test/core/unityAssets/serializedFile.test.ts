// app/test/core/unityAssets/serializedFile.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBundle } from "../../../src/core/unityAssets/bundleParser";
import { parseSerializedFile } from "../../../src/core/unityAssets/serializedFile";

const FIXTURE = join(__dirname, "fixtures", "shared_assets.bundle");

describe("parseSerializedFile", () => {
  it("parses the SerializedFile embedded in shared_assets.bundle", () => {
    const bundle = parseBundle(readFileSync(FIXTURE));
    const sf = parseSerializedFile(bundle.data);
    expect(sf.version).toBeGreaterThanOrEqual(17);
    expect(sf.objects.length).toBeGreaterThan(0);
    // All objects should have valid offsets and sizes within the buffer.
    for (const obj of sf.objects) {
      expect(obj.offset + obj.size).toBeLessThanOrEqual(bundle.data.length);
    }
  });

  it("exposes raw bytes for each object", () => {
    const bundle = parseBundle(readFileSync(FIXTURE));
    const sf = parseSerializedFile(bundle.data);
    const first = sf.objects[0];
    const raw = sf.getObjectRaw(first, bundle.data);
    expect(raw.length).toBe(first.size);
  });

  it("filters objects by type name via typeID", () => {
    const bundle = parseBundle(readFileSync(FIXTURE));
    const sf = parseSerializedFile(bundle.data);
    // MonoBehaviour is classID 114; TextAsset is 49.
    const monoBehaviours = sf.objects.filter((o) => o.typeID === 114);
    expect(monoBehaviours.length).toBeGreaterThan(0);
  });
});
