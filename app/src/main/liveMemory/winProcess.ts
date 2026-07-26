// Read-only Windows process access via koffi FFI to kernel32.
// Runs in the live-memory utilityProcess only — never on the main thread.
// OpenProcess(QUERY_INFORMATION | VM_READ) + ReadProcessMemory: no writes, no injection.

import { execFileSync } from "node:child_process";
import koffi from "koffi";
import type { MemoryReader } from "../../core/liveMemory/memory";
import { BufferPool } from "./bufferPool";

const kernel32 = koffi.load("kernel32.dll");

const TH32CS_SNAPPROCESS = 0x00000002;
const TH32CS_SNAPMODULE = 0x00000008;
const TH32CS_SNAPMODULE32 = 0x00000010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

const MEM_COMMIT = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_GUARD = 0x100;

const READABLE_PROTECT = new Set([
  0x02, // PAGE_READONLY
  0x04, // PAGE_READWRITE
  0x08, // PAGE_WRITECOPY
  0x20, // PAGE_EXECUTE_READ
  0x40, // PAGE_EXECUTE_READWRITE
  0x80, // PAGE_EXECUTE_WRITECOPY
]);

// Win64 MSVC layout — padding fields required for correct offsets.
const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32",
  cntUsage: "uint32",
  th32ProcessID: "uint32",
  _pad0: koffi.array("uint8", 4),
  th32DefaultHeapID: "uintptr",
  th32ModuleID: "uint32",
  cntThreads: "uint32",
  th32ParentProcessID: "uint32",
  pcPriClassBase: "int32",
  dwFlags: "uint32",
  szExeFile: koffi.array("uint16", 260),
});

const MODULEENTRY32W = koffi.struct("MODULEENTRY32W", {
  dwSize: "uint32",
  th32ModuleID: "uint32",
  th32ProcessID: "uint32",
  GlblcntUsage: "uint32",
  ProccntUsage: "uint32",
  modBaseAddr: "uintptr",
  modBaseSize: "uint32",
  _pad0: koffi.array("uint8", 4),
  hModule: "uintptr",
  szModule: koffi.array("uint16", 256),
  szExePath: koffi.array("uint16", 260),
});

const MEMORY_BASIC_INFORMATION = koffi.struct("MEMORY_BASIC_INFORMATION", {
  BaseAddress: "uintptr",
  AllocationBase: "uintptr",
  AllocationProtect: "uint32",
  PartitionId: "uint16",
  _pad0: koffi.array("uint8", 2),
  RegionSize: "uintptr",
  State: "uint32",
  Protect: "uint32",
  Type: "uint32",
});

const CreateToolhelp32Snapshot = kernel32.func("CreateToolhelp32Snapshot", "void *", [
  "uint32",
  "uint32",
]);
const Process32FirstW = kernel32.func("Process32FirstW", "bool", ["void *", "void *"]);
const Process32NextW = kernel32.func("Process32NextW", "bool", ["void *", "void *"]);
const Module32FirstW = kernel32.func("Module32FirstW", "bool", ["void *", "void *"]);
const Module32NextW = kernel32.func("Module32NextW", "bool", ["void *", "void *"]);
const CloseHandle = kernel32.func("CloseHandle", "bool", ["void *"]);
const OpenProcess = kernel32.func("OpenProcess", "void *", ["uint32", "bool", "uint32"]);
const ReadProcessMemory = kernel32.func("ReadProcessMemory", "bool", [
  "void *",
  "uintptr",
  "void *",
  "uintptr",
  "_Out_ uintptr *",
]);
const VirtualQueryEx = kernel32.func("VirtualQueryEx", "uintptr", [
  "void *",
  "uintptr",
  "void *",
  "uintptr",
]);
const GetExitCodeProcess = kernel32.func("GetExitCodeProcess", "bool", [
  "void *",
  "_Out_ uint32 *",
]);

// psapi.dll — PSAPI module enumeration, used as a fallback when ToolHelp's
// CreateToolhelp32Snapshot(TH32CS_SNAPMODULE) is blocked by sandbox software
// (e.g. Sandboxie-Plus) and returns an empty module list. PSAPI calls
// EnumProcessModulesEx directly on the process handle we already opened with
// PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, so it does not need any extra
// privileges and does not shell out to a child process (unlike the PowerShell
// fallback). On Win64, HMODULE is an 8-byte pointer.
const psapi = koffi.load("psapi.dll");
const LIST_MODULES_ALL = 0x03;
const EnumProcessModulesEx = psapi.func("EnumProcessModulesEx", "bool", [
  "void *", // hProcess
  "void *", // lphModule (HMODULE[] — pass null to query size, Buffer to receive)
  "uint32", // cb (size in bytes)
  "_Out_ uint32 *", // lpcbNeeded
  "uint32", // dwFilterFlag
]);
const GetModuleFileNameExW = psapi.func("GetModuleFileNameExW", "uint32", [
  "void *", // hProcess
  "uintptr", // hModule (HMODULE as uintptr — accepts bigint read from buffer)
  "void *", // lpFilename (wchar_t buffer — Buffer accepted as void *)
  "uint32", // cch
]);
// MODULEINFO layout (Win64): lpBaseOfDll(8) + SizeOfImage(4) + 4-byte pad + EntryPoint(8) = 24 bytes.
// Read via Buffer rather than a koffi struct to avoid alignment surprises.
const MODULEINFO_SIZE = 24;
const GetModuleInformation = psapi.func("GetModuleInformation", "bool", [
  "void *", // hProcess
  "uintptr", // hModule
  "void *", // lpmodinfo (MODULEINFO buffer)
  "uint32", // cb
]);

const STILL_ACTIVE = 259;

/**
 * Diagnostic counters for the live-memory read loop. Read-only outside
 * {@link WinProcess.readBytes}; reset by the worker's memory sampler.
 * Helps attribute RSS growth (external vs arrayBuffers vs heap) to the
 * 25 Hz read path without adding per-call logging overhead.
 */
export const winProcessStats = {
  readBytesCalls: 0,
  readBytesBytes: 0,
};

/**
 * Optional logger for the module-enumeration fallback paths. When set, each
 * path (ToolHelp / PSAPI / PowerShell) records its failure reason so the
 * worker's main.log can attribute "version=? ga=missing" on attach to a
 * specific cause (e.g. sandbox blocking CreateToolhelp32Snapshot). Set by
 * the worker via {@link setWinProcessLogger}.
 */
let winProcessLogger: ((message: string) => void) | null = null;
export function setWinProcessLogger(fn: ((message: string) => void) | null): void {
  winProcessLogger = fn;
}

/**
 * Parse an HMODULE array buffer returned by EnumProcessModulesEx into a list
 * of bigint handles. Each HMODULE is 8 bytes on Win64. Trailing bytes that do
 * not form a complete 8-byte handle are dropped.
 *
 * Exported for unit testing — the native EnumProcessModulesEx call itself
 * cannot be unit-tested, but this byte-layout parsing can.
 */
export function parseHModulesBuffer(buf: Buffer, bytesValid: number): bigint[] {
  const count = Math.floor(bytesValid / 8);
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    out.push(buf.readBigUInt64LE(i * 8));
  }
  return out;
}

/**
 * Extract the basename (e.g. "GameAssembly.dll") from a Windows module path.
 * Exported for unit testing alongside {@link parseHModulesBuffer}.
 */
export function extractBasename(path: string): string {
  const parts = path.split("\\");
  return parts[parts.length - 1] ?? "";
}

function isInvalidHandle(handle: unknown): boolean {
  if (handle == null) return true;
  if (handle === 0 || handle === -1) return true;
  if (typeof handle === "bigint" && (handle === 0n || handle === -1n)) return true;
  return false;
}

function initStruct(ptr: unknown, type: unknown, fields: Record<string, unknown>): void {
  koffi.encode(ptr, type as never, fields);
}

function utf16ArrayToString(arr: number[]): string {
  const chars: string[] = [];
  for (const code of arr) {
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join("");
}

function normalizeProcessName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/i, "");
}

export interface ProcessInfo {
  pid: number;
  name: string;
}

export interface ModuleInfo {
  name: string;
  path: string;
  baseAddress: bigint;
  size: number;
}

export interface MemoryRegion {
  baseAddress: bigint;
  size: number;
  protect: number;
  type: number;
}

export class WinProcess implements MemoryReader {
  readonly pid: number;
  readonly name: string;
  private handle: unknown;
  /**
   * Per-process buffer pool for {@link readBytes}. Reuses Buffers across the
   * 25 Hz read loop and the 4 MiB-chunk memory scanner so V8 GC isn't flooded
   * by millions of allocations/sec. Single-threaded utilityProcess → no lock.
   * Note: returned Buffers are NOT released back to the pool by callers (they
   * may be held by parsers); the pool only helps when successive reads of the
   * same size reuse freshly-acquired buffers that were released here on short
   * reads or never made it out.
   */
  private readonly bufPool = new BufferPool();

  private constructor(pid: number, name: string, handle: unknown) {
    this.pid = pid;
    this.name = name;
    this.handle = handle;
  }

  static listProcesses(): ProcessInfo[] {
    const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (isInvalidHandle(snap)) {
      throw new Error("CreateToolhelp32Snapshot(PROCESS) failed.");
    }
    const entry = koffi.alloc(PROCESSENTRY32W, 1);
    initStruct(entry, PROCESSENTRY32W, { dwSize: koffi.sizeof(PROCESSENTRY32W) });
    const out: ProcessInfo[] = [];
    try {
      if (Process32FirstW(snap, entry)) {
        do {
          const decoded = koffi.decode(entry, PROCESSENTRY32W);
          out.push({
            pid: decoded.th32ProcessID,
            name: utf16ArrayToString(decoded.szExeFile),
          });
        } while (Process32NextW(snap, entry));
      }
    } finally {
      CloseHandle(snap);
    }
    return out;
  }

  /** PowerShell fallback when Toolhelp32 enumeration fails or returns nothing. */
  static findViaPowerShell(names: string[]): ProcessInfo | null {
    const stems = [...new Set(names.map((n) => normalizeProcessName(n)))];
    const pattern = stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const script = [
      `$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(?:${pattern})$' }`,
      "if (-not $p) { exit 1 }",
      "if ($p -is [array]) { $p = $p | Sort-Object Id -Descending | Select-Object -First 1 }",
      "$p | Select-Object Id, ProcessName | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const raw = execFileSync("powershell", ["-NoProfile", "-Command", script], {
        encoding: "utf-8",
        windowsHide: true,
      }).trim();
      const parsed = JSON.parse(raw) as { Id?: number; ProcessName?: string };
      if (!parsed.Id || !parsed.ProcessName) return null;
      return { pid: parsed.Id, name: `${parsed.ProcessName}.exe` };
    } catch {
      return null;
    }
  }

  static findByNames(names: string[]): WinProcess | null {
    const wanted = new Set(names.flatMap((n) => [n.toLowerCase(), normalizeProcessName(n)]));

    let matches: ProcessInfo[] = [];
    try {
      matches = WinProcess.listProcesses().filter(
        (p) => wanted.has(p.name.toLowerCase()) || wanted.has(normalizeProcessName(p.name)),
      );
    } catch {
      // fall through to PowerShell
    }

    if (matches.length === 0) {
      const viaPs = WinProcess.findViaPowerShell(names);
      if (viaPs) matches = [viaPs];
    }

    if (matches.length === 0) return null;
    const pick = matches.sort((a, b) => b.pid - a.pid)[0];
    return WinProcess.open(pick.pid, pick.name);
  }

  static open(pid: number, name: string): WinProcess {
    const handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (isInvalidHandle(handle)) {
      throw new Error(`OpenProcess failed for pid ${pid}. Try running as Administrator.`);
    }
    return new WinProcess(pid, name, handle);
  }

  close(): void {
    if (this.handle) {
      CloseHandle(this.handle);
      this.handle = null;
    }
  }

  /** False when the game process has exited (handle is stale). */
  isAlive(): boolean {
    if (isInvalidHandle(this.handle)) return false;
    const code = [0];
    if (!GetExitCodeProcess(this.handle, code)) return false;
    return code[0] === STILL_ACTIVE;
  }

  listModules(): ModuleInfo[] {
    const viaToolhelp = this.listModulesViaToolhelp();
    if (viaToolhelp.length > 0) return viaToolhelp;

    // ToolHelp returned empty — on Sandboxie-Plus and similar sandboxes,
    // CreateToolhelp32Snapshot(TH32CS_SNAPMODULE) is blocked even for
    // processes inside the same sandbox. Fall through to PSAPI, which calls
    // EnumProcessModulesEx on the handle we already opened and is not
    // intercepted by sandbox tools that block ToolHelp's snapshot creation.
    const viaPsapi = this.listModulesViaPsapi();
    if (viaPsapi.length > 0) {
      winProcessLogger?.(
        `listModules: ToolHelp returned empty for pid=${this.pid}; PSAPI fallback found ${viaPsapi.length} modules`,
      );
      return viaPsapi;
    }

    const viaPowerShell = this.listModulesViaPowerShell();
    if (viaPowerShell.length > 0) {
      winProcessLogger?.(
        `listModules: ToolHelp and PSAPI both empty for pid=${this.pid}; PowerShell fallback found ${viaPowerShell.length} modules`,
      );
      return viaPowerShell;
    }

    winProcessLogger?.(
      `listModules: all 3 paths returned empty for pid=${this.pid} (toolhelp=0, psapi=0, powershell=0)`,
    );
    return [];
  }

  private listModulesViaToolhelp(): ModuleInfo[] {
    const snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, this.pid);
    if (isInvalidHandle(snap)) return [];
    const entry = koffi.alloc(MODULEENTRY32W, 1);
    initStruct(entry, MODULEENTRY32W, { dwSize: koffi.sizeof(MODULEENTRY32W) });
    const out: ModuleInfo[] = [];
    try {
      if (Module32FirstW(snap, entry)) {
        do {
          const decoded = koffi.decode(entry, MODULEENTRY32W);
          out.push({
            name: utf16ArrayToString(decoded.szModule),
            path: utf16ArrayToString(decoded.szExePath),
            baseAddress: BigInt(decoded.modBaseAddr),
            size: decoded.modBaseSize,
          });
        } while (Module32NextW(snap, entry));
      }
    } finally {
      CloseHandle(snap);
    }
    return out;
  }

  /**
   * PSAPI fallback for module enumeration. Called when ToolHelp's
   * CreateToolhelp32Snapshot returns an empty list (blocked by sandbox
   * software). Uses EnumProcessModulesEx on the already-opened process
   * handle — same privileges as ReadProcessMemory, no child process spawn.
   *
   * Two-phase query: first call with cb=0 to learn the required buffer size,
   * second call to fill the buffer. Then for each HMODULE, fetch its file
   * name and base/size via GetModuleFileNameExW + GetModuleInformation.
   */
  private listModulesViaPsapi(): ModuleInfo[] {
    if (isInvalidHandle(this.handle)) return [];
    const needed = [0];
    // Phase 1: query required size. lphModule=null, cb=0.
    if (!EnumProcessModulesEx(this.handle, null, 0, needed, LIST_MODULES_ALL)) {
      return [];
    }
    const bytesNeeded = needed[0];
    if (bytesNeeded === 0) return [];

    // Phase 2: allocate HMODULE array buffer and enumerate.
    const hModsBuf = Buffer.alloc(bytesNeeded);
    if (!EnumProcessModulesEx(this.handle, hModsBuf, bytesNeeded, needed, LIST_MODULES_ALL)) {
      return [];
    }
    const actualBytes = needed[0];
    const handles = parseHModulesBuffer(hModsBuf, actualBytes);

    // Phase 3: per-module file name + base/size.
    const out: ModuleInfo[] = [];
    const nameBuf = Buffer.alloc(260 * 2); // MAX_PATH * sizeof(wchar_t)
    const modInfoBuf = Buffer.alloc(MODULEINFO_SIZE);
    for (const hMod of handles) {
      const nameLen = GetModuleFileNameExW(this.handle, hMod, nameBuf, 260);
      if (nameLen === 0) continue;
      const path = nameBuf.toString("utf16le", 0, nameLen * 2);
      const name = extractBasename(path);
      if (!GetModuleInformation(this.handle, hMod, modInfoBuf, MODULEINFO_SIZE)) continue;
      const base = modInfoBuf.readBigUInt64LE(0); // lpBaseOfDll (uintptr, 8 bytes)
      const size = modInfoBuf.readUInt32LE(8); // SizeOfImage (uint32, 4 bytes after base)
      out.push({ name, path, baseAddress: base, size });
    }
    return out;
  }

  private listModulesViaPowerShell(): ModuleInfo[] {
    const script = [
      `$p = Get-Process -Id ${this.pid} -ErrorAction Stop`,
      "$p.Modules | Select-Object ModuleName, FileName, BaseAddress, ModuleMemorySize | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const raw = execFileSync("powershell", ["-NoProfile", "-Command", script], {
        encoding: "utf-8",
        windowsHide: true,
      }).trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw) as
        | {
            ModuleName?: string;
            FileName?: string;
            BaseAddress?: number;
            ModuleMemorySize?: number;
          }
        | {
            ModuleName?: string;
            FileName?: string;
            BaseAddress?: number;
            ModuleMemorySize?: number;
          }[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((row) => {
        if (!row.ModuleName || row.BaseAddress == null) return [];
        return [
          {
            name: row.ModuleName,
            path: row.FileName ?? "",
            baseAddress: BigInt(row.BaseAddress),
            size: row.ModuleMemorySize ?? 0,
          },
        ];
      });
    } catch (err) {
      winProcessLogger?.(
        `listModulesViaPowerShell failed for pid=${this.pid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** Walk committed readable regions from `start` (default: whole address space). */
  *readableRegions(maxRegions = 5000, start = 0n): Generator<MemoryRegion> {
    const mbiSize = koffi.sizeof(MEMORY_BASIC_INFORMATION);
    const mbi = koffi.alloc(MEMORY_BASIC_INFORMATION, 1);
    let address = start;
    let count = 0;

    while (count < maxRegions) {
      const result = VirtualQueryEx(this.handle, address, mbi, mbiSize);
      if (result === 0n || result === 0) break;

      const info = koffi.decode(mbi, MEMORY_BASIC_INFORMATION);
      const base = BigInt(info.BaseAddress);
      const regionSize = Number(info.RegionSize);
      const protect = info.Protect & 0xff;

      if (
        info.State === MEM_COMMIT &&
        !(protect & PAGE_GUARD) &&
        protect !== PAGE_NOACCESS &&
        READABLE_PROTECT.has(protect) &&
        regionSize > 0
      ) {
        yield {
          baseAddress: base,
          size: regionSize,
          protect,
          type: info.Type,
        };
        count++;
      }

      const next = base + BigInt(regionSize);
      if (next <= address) break;
      address = next;
    }
  }

  readBytes(address: bigint, size: number): Buffer | null {
    if (isInvalidHandle(this.handle)) return null;
    winProcessStats.readBytesCalls++;
    winProcessStats.readBytesBytes += size;
    // Use allocUnsafe + pool reuse instead of Buffer.alloc (which zero-fills
    // every call). The 25 Hz read loop + 4 MiB chunk scanner would otherwise
    // generate millions of zero-fill allocations per second, overwhelming V8
    // GC. Callers always check length or read within bounds, so uninitialized
    // memory is never observed (ReadProcessMemory overwrites the whole buffer
    // on success).
    const buf = this.bufPool.acquire(size);
    const outLen = [0n];
    const ok = ReadProcessMemory(this.handle, address, buf, BigInt(size), outLen);
    if (!ok) {
      this.bufPool.release(buf);
      return null;
    }
    const read = Number(outLen[0]);
    if (read === size) return buf;
    if (read === 0) {
      this.bufPool.release(buf);
      return null;
    }
    // Short read: return a subarray view of the actually-read bytes. The
    // underlying ArrayBuffer stays alive with the full `size` capacity, but
    // callers only see `read` bytes. Previously this returned
    // `buf.subarray(0, read)` directly, which caused RangeError in callers
    // doing `readBigUInt64LE()` / `readInt32LE()` when `read < 8`/`< 4` —
    // crashing the worker loop and forcing a detach. Return null instead so
    // helpers like readPtr/readI32 fall through to their null paths.
    this.bufPool.release(buf);
    return null;
  }
}

export { MEM_COMMIT };

/** Scan readable memory regions for a byte pattern. Returns addresses where the pattern starts. */
export function scanBytes(proc: WinProcess, pattern: Buffer, maxMatches = 200): bigint[] {
  const results: bigint[] = [];
  for (const region of proc.readableRegions()) {
    if (results.length >= maxMatches) break;
    // Read the region in manageable chunks to avoid excessive memory
    const CHUNK = 256 * 1024; // 256 KB per read
    let offset = 0n;
    while (offset < BigInt(region.size) && results.length < maxMatches) {
      const remaining = Number(BigInt(region.size) - offset);
      const chunkSize = Math.min(CHUNK, remaining);
      const buf = proc.readBytes(region.baseAddress + offset, chunkSize);
      if (!buf) {
        offset += BigInt(chunkSize);
        continue;
      }
      let pos = -1;
      while ((pos = buf.indexOf(pattern, pos + 1)) !== -1) {
        results.push(region.baseAddress + offset + BigInt(pos));
        if (results.length >= maxMatches) break;
      }
      offset += BigInt(chunkSize);
    }
  }
  return results;
}

/**
 * Scan a specific memory range (base..base+size) for a byte pattern. Used to
 * restrict expensive pattern scans to a single module's address range (e.g.
 * GameAssembly.dll) instead of the whole address space.
 */
export function scanBytesInRange(
  proc: WinProcess,
  pattern: Buffer,
  base: bigint,
  size: number,
  maxMatches = 200,
): bigint[] {
  const results: bigint[] = [];
  const CHUNK = 1 << 22; // 4 MiB per read — large regions scan faster with bigger chunks
  let offset = 0n;
  while (offset < BigInt(size) && results.length < maxMatches) {
    const remaining = size - Number(offset);
    const chunkSize = Math.min(CHUNK, remaining);
    const buf = proc.readBytes(base + offset, chunkSize);
    if (!buf) {
      offset += BigInt(chunkSize);
      continue;
    }
    let pos = -1;
    while ((pos = buf.indexOf(pattern, pos + 1)) !== -1) {
      results.push(base + offset + BigInt(pos));
      if (results.length >= maxMatches) break;
    }
    offset += BigInt(chunkSize);
  }
  return results;
}

/** Scan readable memory for 8-aligned pointers to a target address. */
export function scanPointers(proc: WinProcess, target: bigint, maxMatches = 4000): bigint[] {
  const needle = Buffer.alloc(8);
  needle.writeBigUInt64LE(target);
  const raw = scanBytes(proc, needle, maxMatches);
  // Only keep 8-aligned addresses
  return raw.filter((addr) => (addr & 7n) === 0n);
}

/**
 * Resolve an Il2Cpp class by its real name string.
 * Returns the Il2CppClass* pointer or null if not found.
 *
 * Two-pass approach (derived from meter's 3-pass):
 *   1. Find the `"ClassName\0"` string constant in memory. IL2CPP stores
 *      these in the global-metadata mapping (typically PAGE_READONLY), not in
 *      GameAssembly.dll's .rdata — so a GA-restricted scan usually misses and
 *      we fall back to a whole-address-space scan.
 *   2. Find 8-aligned pointers to any name-string address. The pointer lives
 *      in the `Il2CppClass.name` field at +0x10, so `pointerLocation - 0x10`
 *      is a candidate `Il2CppClass*`. Verify by reading the name pointer back
 *      and checking the `element_class`/`cast_class` round-trip.
 *
 * Performance: Pass 2 does a SINGLE whole-address-space traversal (4 MiB
 * chunks) that checks every 8-aligned slot against ALL name addresses at once
 * via a Set lookup. This replaces the previous N-queries approach (one
 * `scanPointers` call per name address) which took 60–80s when the name had
 * several copies in memory.
 */
export function resolveClassByName(
  proc: WinProcess,
  className: string,
  ga?: { base: bigint; size: number },
): bigint | null {
  const IL2CPP_CLASS_NAME_OFFSET = 0x10n;

  // Pass 1: find the name string in memory.
  const nameBuffer = Buffer.from(className + "\0", "utf-8");
  let nameAddrs: bigint[] = [];
  if (ga) {
    nameAddrs = scanBytesInRange(proc, nameBuffer, ga.base, ga.size, 100);
  }
  if (nameAddrs.length === 0) {
    nameAddrs = scanBytes(proc, nameBuffer, 100);
  }
  if (nameAddrs.length === 0) return null;

  // Deduplicate name addresses and build a Set for O(1) slot-value checks.
  const nameAddrSet = new Set<bigint>();
  for (const a of nameAddrs) nameAddrSet.add(a);
  if (nameAddrSet.size === 0) return null;

  // Pass 2: single-pass scan of all readable regions for 8-aligned pointers
  // whose value is in nameAddrSet. One traversal covers every name address —
  // no per-address re-scanning.
  const CHUNK = 1 << 22; // 4 MiB
  for (const region of proc.readableRegions()) {
    let off = 0n;
    while (off < BigInt(region.size)) {
      const remaining = Number(BigInt(region.size) - off);
      const chunkSize = Math.min(CHUNK, remaining);
      const buf = proc.readBytes(region.baseAddress + off, chunkSize);
      if (!buf) {
        off += BigInt(chunkSize);
        continue;
      }
      // Check every 8-aligned slot in the chunk.
      for (let i = 0; i + 8 <= buf.length; i += 8) {
        const v = buf.readBigUInt64LE(i);
        if (!nameAddrSet.has(v)) continue;
        // `v` is a name-string address; the slot at `buf[i..i+8]` holds it.
        // The slot is at `Il2CppClass + 0x10`, so the class pointer is
        // `slotAddress - 0x10`.
        const slotAddr = region.baseAddress + off + BigInt(i);
        const K = slotAddr - IL2CPP_CLASS_NAME_OFFSET;
        if (K <= 0x10000n) continue;

        // Verify element_class or cast_class round-trip (same as meter).
        const elemClass = proc.readBytes(K + 0x40n, 8);
        if (elemClass) {
          const elemVal = elemClass.readBigUInt64LE();
          if (elemVal === K || proc.readBytes(K + 0x48n, 8)?.readBigUInt64LE() === K) {
            return K;
          }
        }
      }
      off += BigInt(chunkSize);
    }
  }
  return null;
}

/**
 * Resolve a singleton instance from its class by finding the `bbwf` static field.
 * The singleton lives in the parent class (nn<T>) static_fields block at offset 0.
 */
export function singletonFromClass(proc: WinProcess, classPtr: bigint): bigint | null {
  // Parent class is at +0x58
  const parentBuf = proc.readBytes(classPtr + 0x58n, 8);
  if (!parentBuf) return null;
  const parent = parentBuf.readBigUInt64LE();
  if (parent <= 0x10000n || parent >= 0x7ff0_0000_0000n) return null;

  // Try static_fields at known offsets (0xb0, 0xb8, 0xa8)
  for (const soff of [0xb0, 0xb8, 0xa8]) {
    const blockBuf = proc.readBytes(parent + BigInt(soff), 8);
    if (!blockBuf) continue;
    const block = blockBuf.readBigUInt64LE();
    if (block <= 0x10000n || block >= 0x7ff0_0000_0000n) continue;

    // bbwf is at static_fields + 0 (offset 0 in the block)
    const instBuf = proc.readBytes(block, 8);
    if (!instBuf) continue;
    const inst = instBuf.readBigUInt64LE();
    if (inst > 0x10000n && inst < 0x7ff0_0000_0000n) return inst;
  }
  return null;
}
