// Tests for the pure helpers used by the PSAPI module-enumeration fallback path.
// listModulesViaPsapi() shells out to native EnumProcessModulesEx, which can't
// be unit-tested — but the buffer parsing and path extraction it relies on can.

import { describe, it, expect } from "vitest";
import { parseHModulesBuffer, extractBasename } from "../../src/main/liveMemory/winProcess";

describe("parseHModulesBuffer", () => {
  it("returns empty array when no bytes are valid", () => {
    expect(parseHModulesBuffer(Buffer.alloc(0), 0)).toEqual([]);
  });

  it("parses a single HMODULE (8 bytes)", () => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(0x140000000n, 0);
    expect(parseHModulesBuffer(buf, 8)).toEqual([0x140000000n]);
  });

  it("parses multiple HMODULEs in sequence", () => {
    const buf = Buffer.alloc(24);
    buf.writeBigUInt64LE(0x140000000n, 0);
    buf.writeBigUInt64LE(0x180000000n, 8);
    buf.writeBigUInt64LE(0x7ff00000n, 16);
    expect(parseHModulesBuffer(buf, 24)).toEqual([0x140000000n, 0x180000000n, 0x7ff00000n]);
  });

  it("truncates incomplete trailing bytes (not a multiple of 8)", () => {
    const buf = Buffer.alloc(20);
    buf.writeBigUInt64LE(0x140000000n, 0);
    buf.writeBigUInt64LE(0x180000000n, 8);
    // 20 bytes = 2 full HMODULEs + 4 trailing bytes (incomplete — must be dropped)
    expect(parseHModulesBuffer(buf, 20)).toEqual([0x140000000n, 0x180000000n]);
  });

  it("handles bytesValid smaller than buffer length", () => {
    const buf = Buffer.alloc(24);
    buf.writeBigUInt64LE(0x140000000n, 0);
    buf.writeBigUInt64LE(0x180000000n, 8);
    buf.writeBigUInt64LE(0xdeadbeefn, 16);
    // Only first 16 bytes are valid
    expect(parseHModulesBuffer(buf, 16)).toEqual([0x140000000n, 0x180000000n]);
  });
});

describe("extractBasename", () => {
  it("extracts filename from a Windows absolute path", () => {
    expect(extractBasename("C:\\game\\GameAssembly.dll")).toBe("GameAssembly.dll");
  });

  it("extracts filename from a path with multiple directories", () => {
    expect(
      extractBasename("D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskBarHero.exe"),
    ).toBe("TaskBarHero.exe");
  });

  it("returns the input as-is when there is no backslash", () => {
    expect(extractBasename("GameAssembly.dll")).toBe("GameAssembly.dll");
  });

  it("returns empty string for empty input", () => {
    expect(extractBasename("")).toBe("");
  });

  it("handles trailing backslash", () => {
    expect(extractBasename("C:\\game\\")).toBe("");
  });
});
