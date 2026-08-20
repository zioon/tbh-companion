// Live-memory offset capture tool.
//
// Attaches to a running TBH game process, runs the FULL runtime extractor
// (critical path — all anchors, incl. Rev 15 BoxData structural capture),
// and prints the resulting LiveOffsets as a ready-to-paste TypeScript
// constant matching offsets.ts style (e.g. `V1_01_05`).
//
// Usage (game must be running):
//   pnpm exec tsx scripts/capture-live-offsets.ts [--json]
//
// Without --json: prints a TS constant block for offsets.ts.
// With --json:    prints the raw table (bigints as 0x hex strings) for
//                 inspection or machine consumption.
//
// This is a diagnostic/dev tool — it is NOT part of the app runtime. The
// app's self-healing extractor runs the same derivation inside the worker;
// this tool exists to freeze a captured table as a bundled baseline.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LiveOffsets } from "../src/core/liveMemory/offsets";
import { extractOffsets } from "../src/main/liveMemory/offsetExtractor";
import { WinProcess } from "../src/main/liveMemory/winProcess";

function detectGameVersion(p: WinProcess): { version: string; installDir: string } | null {
  try {
    const exe = p.listModules().find((m) => /taskbarhero\.exe$/i.test(m.name))?.path;
    if (!exe) return null;
    const installDir = dirname(exe);
    const versionFile = join(installDir, "Version.txt");
    if (!existsSync(versionFile)) return null;
    const v = readFileSync(versionFile, "utf-8").trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
    return { version: v, installDir };
  } catch {
    return null;
  }
}

function gameAssembly(p: WinProcess): { base: bigint; size: number } | null {
  const m = p.listModules().find((mod) => /^gameassembly\.dll$/i.test(mod.name));
  return m ? { base: m.baseAddress, size: m.size } : null;
}

// ── TS constant formatting (offsets.ts style) ────────────────────────────────

function fmtValue(v: unknown): string {
  if (typeof v === "bigint") return v === 0n ? "0n" : `0x${v.toString(16)}n`;
  if (typeof v === "number") return Number.isInteger(v) ? `0x${v.toString(16)}` : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function fmtObj(obj: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) {
      lines.push(`${indent}${k}: 0,`);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${k}: [${v.map((e) => fmtValue(e)).join(", ")}],`);
    } else if (typeof v === "object") {
      lines.push(`${indent}${k}: {`);
      lines.push(fmtObj(v as Record<string, unknown>, indent + "  "));
      lines.push(`${indent}},`);
    } else {
      lines.push(`${indent}${k}: ${fmtValue(v)},`);
    }
  }
  return lines.join("\n");
}

function toTsConstant(table: LiveOffsets, name: string): string {
  const { gameVersion: _gv, ...rest } = table;
  return `const ${name}: LiveOffsets = {\n  gameVersion: ${JSON.stringify(table.gameVersion)},\n${fmtObj(rest, "  ")}\n};`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const wantJson = process.argv.includes("--json");

const proc = WinProcess.findByNames(["TaskBarHero.exe"]);
if (proc == null) {
  console.error("capture: TaskBarHero.exe not found — is the game running?");
  process.exit(1);
}
console.error(`capture: attached pid=${proc.pid} name=${proc.name}`);

const versionInfo = detectGameVersion(proc);
if (!versionInfo) {
  console.error("capture: could not read Version.txt — is this a real game install?");
  proc.close();
  process.exit(1);
}
console.error(`capture: game version=${versionInfo.version}`);

const ga = gameAssembly(proc);
if (!ga) {
  console.error("capture: gameassembly.dll not found in module list");
  proc.close();
  process.exit(1);
}
console.error(`capture: gameassembly base=0x${ga.base.toString(16)} size=${ga.size}`);

try {
  const result = extractOffsets(proc, ga, versionInfo.version, (msg) => console.error(msg), false);
  if (result == null) {
    console.error("capture: extractor returned null (critical anchor failed)");
    proc.close();
    process.exit(1);
  }
  const table = result.offsets;
  // Prefer the requested version string in the emitted table (extractor emits
  // the same version, but keep it explicit for the bundled constant).
  table.gameVersion = versionInfo.version;
  if (wantJson) {
    const replacer = (_k: string, v: unknown): unknown =>
      typeof v === "bigint" ? `0x${v.toString(16)}` : v;
    console.log(JSON.stringify(table, replacer, 2));
  } else {
    const name = `V${versionInfo.version.replace(/\./g, "_")}`;
    console.log(`// v${versionInfo.version} — captured from a live run (extractor Rev 15).`);
    console.log(toTsConstant(table, name));
  }
} finally {
  proc.close();
}
