// Proof that `winProcess.ts` is importable without any native DLL.
//
// This reproduces the Linux CI condition exactly: `koffi.load` throws. Before
// the lazy-loading change, importing the module threw at module scope and no
// test in the file could run. After it, the pure helpers are importable and
// callable, while a real native call still fails loudly.
//
// Kept in the repo as the regression guard for that behaviour: this file is
// platform-independent, so it runs on CI (Linux) and on Windows alike.
import { describe, expect, it, vi } from "vitest";
import type * as Koffi from "koffi";

vi.mock("koffi", async () => {
  const actual = await vi.importActual<typeof Koffi>("koffi");
  return {
    default: {
      ...actual,
      // Simulate the DLL being unavailable (Linux / missing native lib).
      load: () => {
        throw new Error("SIMULATED missing shared library");
      },
    },
  };
});

describe("winProcess module loads without native DLLs", () => {
  it("importing the module does not touch kernel32/psapi", async () => {
    // If module-scope loading came back, this import would reject here.
    const mod = await import("../../src/main/liveMemory/winProcess");
    expect(typeof mod.parseHModulesBuffer).toBe("function");
    expect(typeof mod.extractBasename).toBe("function");
    expect(typeof mod.selectProcessBySandbox).toBe("function");
    expect(typeof mod.WinProcess).toBe("function");
  });

  it("pure helpers are fully usable with no native library present", async () => {
    const { parseHModulesBuffer, extractBasename, selectProcessBySandbox } =
      await import("../../src/main/liveMemory/winProcess");

    // parseHModulesBuffer — byte-layout parsing, no FFI.
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(0x140000000n, 0);
    buf.writeBigUInt64LE(0x7ff00000000n, 8);
    expect(parseHModulesBuffer(buf, 16)).toEqual([0x140000000n, 0x7ff00000000n]);

    // extractBasename — pure string work.
    expect(extractBasename("C:\\Games\\TaskbarHero.exe")).toBe("TaskbarHero.exe");

    // selectProcessBySandbox — pure selection logic.
    expect(selectProcessBySandbox([], false)).toBeNull();
    expect(selectProcessBySandbox([{ pid: 42, inSandbox: false }], false)).toBe(42);
  });

  it("a genuine native call still fails loudly rather than silently", async () => {
    const { WinProcess } = await import("../../src/main/liveMemory/winProcess");
    // Sandboxie env var absent, and GetModuleHandleW cannot load -> must throw,
    // not return a bogus `false` that would mask a real environment problem.
    delete process.env.sandbox;
    expect(() => WinProcess.isCurrentProcessInSandbox()).toThrow(
      /SIMULATED missing shared library/,
    );
  });
});
