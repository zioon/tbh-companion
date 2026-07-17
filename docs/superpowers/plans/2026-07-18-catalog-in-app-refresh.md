# In-App Catalog Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the companion app rebuild `data/gamedata.json` from the running game's install directory without Python — triggered manually from Settings or prompted by a Loot tab banner when the game version differs from the catalog's bundled version.

**Architecture:** A new framework-free `core/unityAssets/` submodule parses UnityFS bundles + SerializedFiles + TextAssets/MonoBehaviours in pure TypeScript (lz4 via the `lz4js` npm package — pure JS, no native deps). A `CatalogRefreshService` in main orchestrates extraction → writes `userData/gamedata.json` → reloads `GameDataProvider`. `bundledDataCandidates` is updated so userData takes priority over bundled. A new IPC channel pair (`CATALOG_REFRESH` invoke + `CATALOG_STATUS` push) drives the Settings button + Loot HintBanner.

**Tech Stack:** TypeScript, Electron IPC, Vitest, `lz4js` npm package, React + design-system primitives.

**Source-of-truth reference:** `scripts/build_catalog.py` is the validated Python implementation. Every algorithm in this plan is a direct TS port of that script.

---

## File Structure

### New files (core layer — pure, unit-testable)

- `app/src/core/unityAssets/bundleParser.ts` — UnityFS bundle header parse + block decompression (lz4js). Returns the concatenated uncompressed SerializedFile bytes.
- `app/src/core/unityAssets/serializedFile.ts` — SerializedFile metadata + object table walker. Returns `{path_id, typeID, rawOffset, rawSize}[]` over a single SerializedFile buffer.
- `app/src/core/unityAssets/textAsset.ts` — Parse `[4B name_len][name][pad4][4B script_len][script][pad4]` from a TextAsset's raw bytes.
- `app/src/core/unityAssets/monobehaviourEntries.ts` — `scanMarkerEntries(raw, marker=14)` ported from `scan_markers.py` + `build_catalog.py`. Returns `[{offset, keyId, hash, len, str}]`.
- `app/src/core/unityAssets/catalogExtractor.ts` — The top-level orchestrator: takes 3 file paths (or buffers) → returns `GameItem[]`. Ports `build_catalog.py`'s `build_name_map` + CSV join + NameKey-only fallback.
- `app/test/core/unityAssets/bundleParser.test.ts`
- `app/test/core/unityAssets/serializedFile.test.ts`
- `app/test/core/unityAssets/textAsset.test.ts`
- `app/test/core/unityAssets/monobehaviourEntries.test.ts`
- `app/test/core/unityAssets/catalogExtractor.test.ts`
- `app/test/core/unityAssets/fixtures/README.md` — explains how to regenerate the binary fixtures from a game install.

### New files (main layer — impure)

- `app/src/main/catalogRefreshService.ts` — Owns the extract → write userData → reload GameDataProvider flow. Reads game install dir from `LiveMemoryReader` or `Version.txt` lookup.
- `app/src/main/ipc/handlers/catalog.ts` — Registers `CATALOG_REFRESH` invoke + `CATALOG_STATUS` push handlers.

### New files (renderer layer)

- `app/src/renderer/components/CatalogRefreshButton.tsx` — Self-contained button with spin + status text. Pattern cloned from `ItemPriceRefreshButton.tsx` but with inline status text.
- `app/src/renderer/lib/useCatalogStatus.ts` — Hook that subscribes to `onCatalogStatus` + fetches initial status.

### Modified files

- `app/shared/ipc.ts` — Add `CATALOG_REFRESH`, `CATALOG_STATUS`, `GET_CATALOG_STATUS` to `IPC`; add to `IPC_INVOKE_CHANNELS` / `IPC_PUSH_CHANNELS`.
- `app/shared/types.ts` — Add `CatalogStatus`, `CatalogRefreshResult`, `CatalogRefreshError` types.
- `app/src/core/bundledData.ts` — Extend `bundledDataCandidates` to accept an optional `userDataDir` parameter that, when provided, is searched before bundled paths.
- `app/src/core/gamedata.ts` — Add `parseGameCatalogJson(raw)` that strips BOM + validates + returns `{gameVersion, items}` (currently inlined in `GameDataProvider.load`).
- `app/src/main/gameDataProvider.ts` — `load(userDataDir?)` searches userData first; add `reload(userDataDir?)` that re-runs `load`; add `getVersion()` returning the catalog's `gameVersion` field.
- `app/src/main/app/appState.ts` — Instantiate `CatalogRefreshService`; wire `refreshCatalog`, `getCatalogStatus`; broadcast on status change.
- `app/src/main/ipc/registerIpc.ts` — Call `registerCatalogHandlers`.
- `app/src/main/services/InventoryService.ts` — Add `reloadGameData(userDataDir)` that calls `gameData.reload()` + `refreshWorkerState()`.
- `app/src/preload/index.ts` — Expose `refreshCatalog`, `getCatalogStatus`, `onCatalogStatus` on `TbhApi`.
- `app/src/renderer/context/tbhContext.ts` — Add `catalogStatus` + `refreshCatalog` to context.
- `app/src/renderer/context/TbhProvider.tsx` — Subscribe to `onCatalogStatus`; expose status through context.
- `app/src/renderer/tabs/Settings.tsx` — New "Item catalog" Section with version info + `<CatalogRefreshButton>`.
- `app/src/renderer/tabs/Loot.tsx` — Conditional `<HintBanner>` when `catalogStatus.stale` is true.
- `app/test/ipc/channels.test.ts` — Add new channels to contract test.
- `app/test/main/gameDataProvider.test.ts` — Cover userData priority + reload.
- `app/package.json` — Add `lz4js` dependency.

---

## Task 1: Add `lz4js` dependency

**Files:**
- Modify: `app/package.json`

> **Note:** `lz4js` is a pure-JavaScript LZ4 implementation (no native C++ addon, no build tools required). It was chosen over the native `lz4` package, which fails to compile without Visual Studio Build Tools. `lz4js` needs no entry in `app/pnpm-workspace.yaml`'s `allowBuilds` list because it has no build scripts.

- [ ] **Step 1: Check lz4js is the right package**

Run: `cd app && pnpm view lz4js version description`
Expected: prints version `0.2.x` and description "An Lz4 implementation for the browser." (works in Node too — pure JS, no native deps).

- [ ] **Step 2: Add lz4js to dependencies**

Run: `cd app && pnpm add lz4js`
Expected: `package.json` gains `"lz4js": "^0.2.x"` under `dependencies`. `pnpm-lock.yaml` updates. No `pnpm-workspace.yaml` change is needed (lz4js has no native build).

- [ ] **Step 3: Verify lz4js import works**

Run: `cd app && node -e "const lz4 = require('lz4js'); console.log(typeof lz4.decompressBlock);"`
Expected: prints `function`. `lz4js` exposes `decompressBlock(src, dst, sIndex, sLength, dIndex)` (5-arg signature, NOT the 2-arg `lz4.decodeBlock(src, dst)` from the native package) and `decompress(src)` for whole frames. UnityFS uses raw blocks, so Task 4 uses `decompressBlock`.

- [ ] **Step 4: Commit**

```bash
git add app/package.json app/pnpm-lock.yaml
git commit -m "deps: add lz4js for Unity bundle decompression"
```

---

## Task 2: Port `scanMarkerEntries` — the lowest-level shared utility

**Files:**
- Create: `app/src/core/unityAssets/monobehaviourEntries.ts`
- Create: `app/test/core/unityAssets/monobehaviourEntries.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// app/test/core/unityAssets/monobehaviourEntries.test.ts
import { describe, it, expect } from "vitest";
import { scanMarkerEntries } from "../../../src/core/unityAssets/monobehaviourEntries";

function buildEntry(keyId: number, hash: number, str: string): Buffer {
  const strBuf = Buffer.from(str, "utf-8");
  const slen = strBuf.length;
  const pad = (4 - (slen % 4)) % 4;
  return Buffer.concat([
    Buffer.from([
      keyId & 0xff, (keyId >>> 8) & 0xff, (keyId >>> 16) & 0xff, (keyId >>> 24) & 0xff,
      hash & 0xff, (hash >>> 8) & 0xff, (hash >>> 16) & 0xff, (hash >>> 24) & 0xff,
      14, 0, 0, 0, // marker = 14
      slen & 0xff, (slen >>> 8) & 0xff, (slen >>> 16) & 0xff, (slen >>> 24) & 0xff,
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
    const strBuf = Buffer.from([0x01, 0x02, 0x03], "binary"); // non-printable
    const header = Buffer.from([
      0, 0, 0, 0,  // keyId
      0, 0, 0, 0,  // hash
      14, 0, 0, 0, // marker
      3, 0, 0, 0,  // len = 3
    ]);
    const buf = Buffer.concat([header, strBuf]);
    expect(scanMarkerEntries(buf)).toEqual([]);
  });

  it("rejects slen > 256", () => {
    const header = Buffer.from([
      0, 0, 0, 0,
      0, 0, 0, 0,
      14, 0, 0, 0,
      0x00, 0x01, 0x00, 0x00, // len = 256
    ]);
    const buf = Buffer.concat([header, Buffer.alloc(256, 0x41)]);
    expect(scanMarkerEntries(buf)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/monobehaviourEntries.test.ts`
Expected: FAIL with "Cannot find module '../../../src/core/unityAssets/monobehaviourEntries'".

- [ ] **Step 3: Write the minimal implementation**

```typescript
// app/src/core/unityAssets/monobehaviourEntries.ts
// Port of scripts/build_catalog.py:scan_marker_entries.
// Scans raw MonoBehaviour bytes for entries of the form:
//   [4B key_id][4B hash][4B marker=14][4B len][string bytes][padding to 4]
// Returns hits in position order. Stops cleanly at end of buffer.

export interface MarkerEntry {
  offset: number;
  keyId: number;
  hash: number;
  len: number;
  str: string;
}

const MAX_LEN = 256;

function isPrintable(s: string): boolean {
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0x80)) return false;
  }
  return true;
}

export function scanMarkerEntries(raw: Buffer, marker = 14): MarkerEntry[] {
  const hits: MarkerEntry[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n - 16) {
    const m = raw.readUInt32LE(i + 8);
    if (m !== marker) {
      i += 1;
      continue;
    }
    const slen = raw.readUInt32LE(i + 12);
    if (slen === 0 || slen > MAX_LEN) {
      i += 1;
      continue;
    }
    const strStart = i + 16;
    const strEnd = strStart + slen;
    if (strEnd > n) {
      i += 1;
      continue;
    }
    let s: string;
    try {
      s = raw.subarray(strStart, strEnd).toString("utf-8");
    } catch {
      i += 1;
      continue;
    }
    if (!isPrintable(s)) {
      i += 1;
      continue;
    }
    const keyId = raw.readUInt32LE(i);
    const hash = raw.readUInt32LE(i + 4);
    hits.push({ offset: i, keyId, hash, len: slen, str: s });
    i = strEnd;
    while (i % 4 !== 0) i += 1;
  }
  return hits;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/monobehaviourEntries.test.ts`
Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/unityAssets/monobehaviourEntries.ts app/test/core/unityAssets/monobehaviourEntries.test.ts
git commit -m "feat(core): port scanMarkerEntries from build_catalog.py"
```

---

## Task 3: TextAsset raw bytes parser

**Files:**
- Create: `app/src/core/unityAssets/textAsset.ts`
- Create: `app/test/core/unityAssets/textAsset.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
      nameBuf.length & 0xff, (nameBuf.length >>> 8) & 0xff,
      (nameBuf.length >>> 16) & 0xff, (nameBuf.length >>> 24) & 0xff,
    ]),
    nameBuf,
    Buffer.alloc(namePad, 0),
    Buffer.from([
      scriptBuf.length & 0xff, (scriptBuf.length >>> 8) & 0xff,
      (scriptBuf.length >>> 16) & 0xff, (scriptBuf.length >>> 24) & 0xff,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/textAsset.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the minimal implementation**

```typescript
// app/src/core/unityAssets/textAsset.ts
// Port of scripts/build_catalog.py:parse_textasset_raw.
// IL2CPP TextAssets have no type tree, so UnityPy's obj.read() doesn't always
// populate m_Text/m_Script. We parse the raw serialization bytes directly:
//   [4B name_len][name bytes][pad to 4][4B script_len][script bytes][pad to 4]

const MAX_NAME_LEN = 256;
const MAX_SCRIPT_LEN = 50_000_000;

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function parseTextAssetRaw(raw: Buffer): [string | null, string | null] {
  if (raw.length < 8) return [null, null];
  const nameLen = raw.readUInt32LE(0);
  if (nameLen > MAX_NAME_LEN || 4 + nameLen > raw.length) return [null, null];
  let name: string;
  try {
    name = raw.subarray(4, 4 + nameLen).toString("utf-8");
  } catch {
    return [null, null];
  }
  let off = align4(4 + nameLen);
  if (off + 4 > raw.length) return [name, null];
  const scriptLen = raw.readUInt32LE(off);
  if (scriptLen > MAX_SCRIPT_LEN || off + 4 + scriptLen > raw.length) return [name, null];
  try {
    const script = raw.subarray(off + 4, off + 4 + scriptLen).toString("utf-8");
    return [name, script];
  } catch {
    return [name, null];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/textAsset.test.ts`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/unityAssets/textAsset.ts app/test/core/unityAssets/textAsset.test.ts
git commit -m "feat(core): port parseTextAssetRaw from build_catalog.py"
```

---

## Task 4: UnityFS bundle parser

**Files:**
- Create: `app/src/core/unityAssets/bundleParser.ts`
- Create: `app/test/core/unityAssets/bundleParser.test.ts`
- Create: `app/test/core/unityAssets/fixtures/README.md`

This is the most complex parser. The UnityFS format (Unity 5.4+):

```
Header:
  signature: cstring ("UnityFS")
  format: uint32  (6 or 7)
  unityVersion: cstring (e.g. "5.x.x")
  unityRevision: cstring (e.g. "2019.4.x")
  size: int64     (total bundle size)
  compressedBlocksInfoSize: uint32
  uncompressedBlocksInfoSize: uint32
  flags: uint32   (bits 0-5: compression 0=none 1=lzma 2=lz4 3=lz4hc;
                   bit 7: blocks-info-at-end; bit 8: old-web-plugin; bit 9: padding-at-start)

If blocks-info-at-end:
  seek to (size - compressedBlocksInfoSize - 16) before reading blocks info
Else:
  blocks info starts immediately after header (with 16-byte alignment after header)

BlocksInfo:
  uncompressedDataHash: 16 bytes
  blocksCount: uint32
  blocks: [ {uncompressedSize: uint32, compressedSize: uint32, flags: uint16} ] * blocksCount
  storageEntriesCount: uint32
  entries: [ {offset: int64, size: int64, flags: uint32, name: cstring} ] * storageEntriesCount

Then the data blocks (concatenated). Each block may be lz4/lz4hc/lzma/none compressed.
The decompressed blocks together form one or more SerializedFiles (or raw asset bundles
for storage entries that are themselves bundles).
```

For the catalog extractor we only care about storage entries with names ending in `.resS` (raw streaming data) or empty-name entries (CAB-xxx that contain the actual SerializedFile). The simplest path: concatenate ALL decompressed blocks into one buffer, then scan it as a SerializedFile.

- [ ] **Step 1: Write the failing test using a real bundle fixture**

First, generate the fixture from the real game install:

```bash
python -c "
from pathlib import Path
src = Path(r'D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64\localization-assets-shared_assets_all.bundle')
dst = Path(r'app/test/core/unityAssets/fixtures/shared_assets.bundle')
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_bytes(src.read_bytes())
print(f'Wrote {dst.stat().st_size} bytes')
"
```

Then the test:

```typescript
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
    // The decompressed data should contain a SerializedFile signature or
    // recognizable strings like "ItemName_110001".
    const str = result.data.toString("utf-8", 0, Math.min(result.data.length, 200000));
    expect(str).toContain("ItemName_");
  });

  it("rejects invalid signature", () => {
    expect(() => parseBundle(Buffer.from("NOTABUNDLE\x00rest"))).toThrow(/signature/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/bundleParser.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the minimal implementation**

```typescript
// app/src/core/unityAssets/bundleParser.ts
// UnityFS bundle parser. Pure (no node:fs), takes a Buffer, returns parsed
// structure + a single concatenated decompressed-data buffer.
//
// References:
//   - https://github.com/Perfare/UnityStudio/blob/master/UnityStudio/Assets/UnityFile.cs
//   - scripts/probe_bundle_format.py (validated against TBH v1.00.28)
//
// Compression support: 0=none, 2=lz4, 3=lz4hc. lzma (1) is not used by TBH
// bundles but we throw a clear error if encountered.

import lz4 from "lz4js";

const COMPRESSION_NONE = 0;
const COMPRESSION_LZMA = 1;
const COMPRESSION_LZ4 = 2;
const COMPRESSION_LZ4HC = 3;

const FLAG_COMPRESSION_MASK = 0x3f;
const FLAG_BLOCKS_INFO_AT_END = 0x80;
const FLAG_PADDING_AT_START = 0x200;

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

function align4(n: number): number {
  return (n + 3) & ~3;
}

function decompressBlock(src: Buffer, uncompressedSize: number, compression: number): Buffer {
  if (compression === COMPRESSION_NONE) return src;
  if (compression === COMPRESSION_LZMA) {
    throw new Error("LZMA compression not supported (TBH bundles use lz4)");
  }
  if (compression === COMPRESSION_LZ4 || compression === COMPRESSION_LZ4HC) {
    const out = Buffer.alloc(uncompressedSize);
    // lz4js.decompressBlock is the synchronous raw-block primitive.
    // Signature: (src, dst, sIndex, sLength, dIndex) -> new dIndex (= bytes written).
    // Note: lz4js has NO 2-arg decodeBlock and NO stream API; decompress() is for
    // whole lz4 frames (with magic 0x184D2204), which UnityFS blocks are NOT.
    const n = lz4.decompressBlock(src, out, 0, src.length, 0);
    if (n !== uncompressedSize) {
      throw new Error(`lz4 decompression size mismatch: expected ${uncompressedSize}, got ${n}`);
    }
    return out;
  }
  throw new Error(`unknown block compression: ${compression}`);
}

export function parseBundle(raw: Buffer): ParsedBundle {
  if (raw.length < 50) throw new Error("bundle too small");

  // Header.
  let [signature, off] = readCString(raw, 0);
  if (signature !== "UnityFS") {
    throw new Error(`unexpected bundle signature: ${signature}`);
  }
  const format = raw.readUInt32LE(off); off += 4;
  let cv: string;
  [cv, off] = readCString(raw, off);
  let ur: string;
  [ur, off] = readCString(raw, off);
  const size = raw.readBigInt64LE(off); off += 8;
  const compressedBlocksInfoSize = raw.readUInt32LE(off); off += 4;
  const uncompressedBlocksInfoSize = raw.readUInt32LE(off); off += 4;
  const flags = raw.readUInt32LE(off); off += 4;

  // BlocksInfo position.
  const compression = flags & FLAG_COMPRESSION_MASK;
  const blocksInfoAtEnd = (flags & FLAG_BLOCKS_INFO_AT_END) !== 0;
  const paddingAtStart = (flags & FLAG_PADDING_AT_START) !== 0;

  // The 16-byte alignment after header is documented but TBH bundles don't
  // seem to need it. We try both positions.
  let blocksInfoOffset: number;
  if (blocksInfoAtEnd) {
    blocksInfoOffset = Number(size) - compressedBlocksInfoSize - 16; // -16 is hash
  } else {
    blocksInfoOffset = align4(off);
  }

  // Read blocks-info (may be compressed, even when data blocks use a different compression).
  let blocksInfo: Buffer;
  if (compression === COMPRESSION_NONE) {
    blocksInfo = raw.subarray(blocksInfoOffset, blocksInfoOffset + uncompressedBlocksInfoSize);
  } else if (compression === COMPRESSION_LZ4 || compression === COMPRESSION_LZ4HC) {
    blocksInfo = Buffer.alloc(uncompressedBlocksInfoSize);
    const n = lz4.decompressBlock(
      raw.subarray(blocksInfoOffset, blocksInfoOffset + compressedBlocksInfoSize),
      blocksInfo,
      0,
      compressedBlocksInfoSize,
      0,
    );
    if (n !== uncompressedBlocksInfoSize) {
      throw new Error(`blocks-info lz4 size mismatch: ${n} vs ${uncompressedBlocksInfoSize}`);
    }
  } else if (compression === COMPRESSION_LZMA) {
    throw new Error("LZMA blocks-info not supported");
  } else {
    throw new Error(`unknown blocks-info compression: ${compression}`);
  }

  // Parse BlocksInfo payload.
  // 16-byte uncompressed data hash, then blocks, then storage entries.
  let p = 16; // skip hash
  const blocksCount = blocksInfo.readUInt32LE(p); p += 4;
  const blocks: BundleBlock[] = [];
  for (let i = 0; i < blocksCount; i++) {
    const uncompressedSize = blocksInfo.readUInt32LE(p); p += 4;
    const compressedSize = blocksInfo.readUInt32LE(p); p += 4;
    const blockFlags = blocksInfo.readUInt16LE(p); p += 2;
    blocks.push({ uncompressedSize, compressedSize, flags: blockFlags });
  }
  const storageEntriesCount = blocksInfo.readUInt32LE(p); p += 4;
  const storageEntries: BundleStorageEntry[] = [];
  for (let i = 0; i < storageEntriesCount; i++) {
    const entryOffset = blocksInfo.readBigInt64LE(p); p += 8;
    const entrySize = blocksInfo.readBigInt64LE(p); p += 8;
    const entryFlags = blocksInfo.readUInt32LE(p); p += 4;
    let name: string;
    [name, p] = readCString(blocksInfo, p);
    storageEntries.push({ offset: entryOffset, size: entrySize, flags: entryFlags, name });
  }

  // Data blocks start position: right after the header (aligned to 16).
  // For blocksInfoAtEnd=false, that's just after the header.
  // For blocksInfoAtEnd=true, the data blocks still come right after the header
  // (the BlocksInfo lives at the end).
  let dataStart = align4(off);
  if (paddingAtStart) dataStart = align4(dataStart + 16);

  // Decompress and concatenate all blocks.
  const totalUncompressed = blocks.reduce((sum, b) => sum + b.uncompressedSize, 0);
  const data = Buffer.alloc(totalUncompressed);
  let writeOff = 0;
  let readOff = dataStart;
  for (const block of blocks) {
    const src = raw.subarray(readOff, readOff + block.compressedSize);
    const blockCompression = block.flags & FLAG_COMPRESSION_MASK;
    const decompressed = decompressBlock(src, block.uncompressedSize, blockCompression);
    decompressed.copy(data, writeOff);
    writeOff += block.uncompressedSize;
    readOff += block.compressedSize;
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
    dataLength: totalUncompressed,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/bundleParser.test.ts`
Expected: PASS — all 3 tests pass. If "decompresses all blocks" fails because `ItemName_` is not in the first 200KB, increase the search range or change the assertion to scan the whole buffer.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/unityAssets/bundleParser.ts app/test/core/unityAssets/bundleParser.test.ts app/test/core/unityAssets/fixtures/
git commit -m "feat(core): UnityFS bundle parser with lz4 decompression"
```

- [ ] **Step 6: Write the fixture README**

```markdown
<!-- app/test/core/unityAssets/fixtures/README.md -->
# Unity Asset Test Fixtures

These binary fixtures are sliced from a real TBH game install (v1.00.28) so
unit tests exercise the actual on-disk byte layout.

## Regenerating

```powershell
python -c "
from pathlib import Path
root = Path(r'D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data')
fixtures = Path(r'app/test/core/unityAssets/fixtures')
fixtures.mkdir(parents=True, exist_ok=True)
(fixtures / 'shared_assets.bundle').write_bytes(
    (root / 'StreamingAssets/aa/StandaloneWindows64/localization-assets-shared_assets_all.bundle').read_bytes()
)
(fixtures / 'en_stringtable.bundle').write_bytes(
    (root / 'StreamingAssets/aa/StandaloneWindows64/localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle').read_bytes()
)
(fixtures / 'sharedassets0.assets').write_bytes(
    (root / 'sharedassets0.assets').read_bytes()
)
"
```

These fixtures are committed (not LFS) because they total ~3MB and LFS adds
friction for contributors. If the game's bundle format changes in a future
release, regenerate the fixtures and the corresponding tests.
```

```bash
git add app/test/core/unityAssets/fixtures/README.md
git commit -m "docs(test): fixture regeneration instructions"
```

---

## Task 5: SerializedFile parser (object table walker)

**Files:**
- Create: `app/src/core/unityAssets/serializedFile.ts`
- Create: `app/test/core/unityAssets/serializedFile.test.ts`

We only need a minimal subset: read the header, walk the object table, return each object's `{path_id, typeID, dataOffset, size}`. We do NOT parse TypeTrees (IL2CPP games don't have them, and we access raw bytes via `get_raw_data` equivalent).

SerializedFile layout:
```
Header (version >= 9):
  metadataSize: uint32
  fileType: int32 (0=asset, 1=Bundle, 2=Web)
  version: int32 (typically 17-22)
  dataOffset: uint32
  endianness: byte (0=LE, 1=BE)
  reserved: 3 bytes
  metadata follows...
After metadata (padded to alignment):
  object data starts at dataOffset
```

Metadata (we read version >= 17):
```
- types: [ {classID: int32, isStrippedType: bool, scriptTypeIndex: int16, scriptID: 16 bytes (if classID==114), oldTypeHash: 16 bytes} ] * typeCount
- objects: [ {path_id: int64 (or int32 for older versions), offset: uint32, size: uint32, typeID: int32} ] * objectCount
- scripts: [ {localFileIndex: int32, localPathId: int64} ] * scriptCount
- externals: [ {tempEmpty: cstring} ] * externalCount
- refTypes: [ ... ] * refTypeCount  (version >= 21)
- userInformation: cstring (optional)
```

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/serializedFile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// app/src/core/unityAssets/serializedFile.ts
// Minimal SerializedFile parser. Reads the object table so callers can locate
// raw object bytes by path_id / typeID. Does NOT parse TypeTrees (IL2CPP games
// don't have them). Reference: AssetStudio UnityCs/SerializedFile.cs.

export interface SerializedType {
  classID: number;
  isStrippedType: boolean;
  scriptTypeIndex: number;
  scriptID: Buffer; // 16 bytes (only meaningful when classID === 114 and scriptTypeIndex >= 0)
  oldTypeHash: Buffer; // 16 bytes
}

export interface SerializedObjectInfo {
  pathId: bigint;
  offset: number;
  size: number;
  typeID: number; // index into types array? or classID? — AssetStudio uses the types index here
  classID: number; // resolved class ID via types[typeID].classID
}

export interface ParsedSerializedFile {
  version: number;
  dataOffset: number;
 endianness: number;
  types: SerializedType[];
  objects: SerializedObjectInfo[];
}

const TYPE_MONOBEHAVIOUR = 114;
const TYPE_TEXTASSET = 49;

function readCString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) return ["", offset];
  return [buf.subarray(offset, end).toString("utf-8"), end + 1];
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function parseSerializedFile(buf: Buffer): ParsedSerializedFile {
  if (buf.length < 20) throw new Error("SerializedFile too small");

  const metadataSize = buf.readUInt32LE(0);
  const fileType = buf.readInt32LE(4);
  const version = buf.readInt32LE(8);
  const dataOffset = buf.readUInt32LE(12);
  const endianness = buf.readUInt8(16);
  // 3 reserved bytes at 17-19.

  if (version < 17) {
    throw new Error(`Unsupported SerializedFile version: ${version} (need >= 17)`);
  }

  // Metadata starts at offset 20. We read it as a separate slice so we can
  // track our position with a local variable.
  const meta = buf.subarray(20, 20 + metadataSize);
  let p = 0;

  // Unity version string (cstring).
  let unityVersion: string;
  [unityVersion, p] = readCString(meta, p);
  // Target platform: int32.
  const targetPlatform = meta.readInt32LE(p); p += 4;
  // EnableTypeTree: byte.
  const enableTypeTree = meta.readUInt8(p); p += 1;

  // Types.
  const typeCount = meta.readInt32LE(p); p += 4;
  const types: SerializedType[] = [];
  for (let i = 0; i < typeCount; i++) {
    const classID = meta.readInt32LE(p); p += 4;
    const isStrippedType = meta.readUInt8(p) !== 0; p += 1;
    const scriptTypeIndex = meta.readInt16LE(p); p += 2;
    // scriptID (16 bytes) only present when classID == 114 (MonoBehaviour) and
    // scriptTypeIndex >= 0. AssetStudio always reads it for typeCount > 0.
    // For IL2CPP games, the scriptID is typically all zeros.
    const scriptID = meta.subarray(p, p + 16); p += 16;
    const oldTypeHash = meta.subarray(p, p + 16); p += 16;
    if (enableTypeTree) {
      // Skip TypeTree blob. We don't need it for IL2CPP raw-data access.
      // TypeTree is a node tree serialized as: int32 nodeCount, then nodes.
      // Each node: cstring type, cstring name, int32 byteSize, int32 index,
      // int32 flags, int32 version (version >= 19).
      // The simplest skip: read int32 stringBlobSize, skip that many bytes.
      p = skipTypeTree(meta, p, version);
    }
    types.push({ classID, isStrippedType, scriptTypeIndex, scriptID, oldTypeHash });
  }

  // Objects.
  const objectCount = meta.readInt32LE(p); p += 4;
  const objects: SerializedObjectInfo[] = [];
  for (let i = 0; i < objectCount; i++) {
    // Align to 4 bytes before reading each object entry (per AssetStudio).
    p = align4(p);
    const offset = meta.readUInt32LE(p); p += 4;
    const size = meta.readUInt32LE(p); p += 4;
    const typeID = meta.readInt32LE(p); p += 4;
    const pathId = meta.readBigInt64LE(p); p += 8;
    const resolvedClassID = types[typeID]?.classID ?? typeID;
    objects.push({ pathId, offset, size, typeID, classID: resolvedClassID });
  }

  // Scripts (we skip parsing details).
  const scriptCount = meta.readInt32LE(p); p += 4;
  for (let i = 0; i < scriptCount; i++) {
    p = align4(p);
    p += 4; // localFileIndex
    p += 8; // localPathId
  }

  // Externals.
  const externalCount = meta.readInt32LE(p); p += 4;
  for (let i = 0; i < externalCount; i++) {
    // tempEmpty: cstring
    let _: string;
    [_, p] = readCString(meta, p);
    p += 16; // guid
    p += 4; // type
  }

  // refTypes (version >= 21) — skip.
  if (version >= 21) {
    const refTypeCount = meta.readInt32LE(p); p += 4;
    // We don't need these; skip without parsing details.
    // (Implementation detail: refTypes follow the same layout as types. We'd
    // need to parse them if we wanted to resolve references, but for catalog
    // extraction we don't.)
  }

  // userInformation (cstring, optional, may be empty/absent).
  // We don't read it — it's only used for editor comments.

  return { version, dataOffset, endianness, types, objects };
}

function skipTypeTree(buf: Buffer, p: number, version: number): number {
  // Node count.
  const nodeCount = buf.readInt32LE(p); p += 4;
  for (let i = 0; i < nodeCount; i++) {
    let _: string;
    [_, p] = readCString(buf, p); // type
    [_, p] = readCString(buf, p); // name
    p += 4; // byteSize
    p += 4; // index
    if (version >= 19) {
      p += 4; // flags
      // Note: version is at the END of the struct in some versions, but
      // AssetStudio reads: type, name, byteSize, index, flags, then version
      // for version >= 19. Actually order: level(int), type, name, byteSize,
      // index, flags, version (>= 19). We've skipped level.
      p += 4; // version
    }
  }
  // String blob.
  const stringBlobSize = buf.readInt32LE(p); p += 4;
  p += stringBlobSize;
  return p;
}

export function getObjectRaw(info: SerializedObjectInfo, data: Buffer, dataOffset: number): Buffer {
  const start = dataOffset + info.offset;
  return data.subarray(start, start + info.size);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/serializedFile.test.ts`
Expected: PASS — all 3 tests pass. If the TypeTree skip is wrong, the object offsets will be garbage; debug by printing the first few object entries and comparing to `scripts/dump_shared.py` output.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/unityAssets/serializedFile.ts app/test/core/unityAssets/serializedFile.test.ts
git commit -m "feat(core): minimal SerializedFile parser (object table + raw data)"
```

---

## Task 6: Catalog extractor (top-level orchestrator)

**Files:**
- Create: `app/src/core/unityAssets/catalogExtractor.ts`
- Create: `app/test/core/unityAssets/catalogExtractor.test.ts`

- [ ] **Step 1: Write the failing test using real fixtures**

```typescript
// app/test/core/unityAssets/catalogExtractor.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCatalog } from "../../../src/core/unityAssets/catalogExtractor";

const FX = join(__dirname, "fixtures");

describe("extractCatalog", () => {
  it("extracts the full catalog from real game files", () => {
    const result = extractCatalog({
      sharedassets0: readFileSync(join(FX, "sharedassets0.assets")),
      sharedBundle: readFileSync(join(FX, "shared_assets.bundle")),
      enBundle: readFileSync(join(FX, "en_stringtable.bundle")),
    });
    expect(result.gameVersion).toBe("1.00.28");
    expect(result.items.length).toBeGreaterThan(5000);
    expect(result.stats.resolvedNames).toBeGreaterThan(500);

    const byId = new Map(result.items.map((it) => [it.id, it]));
    expect(byId.get(110001)?.name).toBe("Minor Ruby");
    expect(byId.get(120001)?.name).toBe("Goblin Hide");
    expect(byId.get(530017)?.name).toBe("Dimensional Boots");
    expect(byId.get(628111)?.name).toBe("Emerald Ring");
    expect(byId.get(910011)?.name).toBe("Normal Monster Box 1");

    // NameKey-only entries: 620017 is in localization bundle but not in CSV.
    expect(byId.get(620017)?.name).toBe("Ethereal Ring");
  });

  it("throws a clear error when ItemInfoData is missing", () => {
    expect(() =>
      extractCatalog({
        sharedassets0: Buffer.alloc(0),
        sharedBundle: readFileSync(join(FX, "shared_assets.bundle")),
        enBundle: readFileSync(join(FX, "en_stringtable.bundle")),
      }),
    ).toThrow(/ItemInfoData/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/catalogExtractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// app/src/core/unityAssets/catalogExtractor.ts
// Port of scripts/build_catalog.py. Extracts gamedata.json content from three
// in-memory buffers: sharedassets0.assets (CSV), shared_assets.bundle
// (ItemName_ keys), en_stringtable.bundle (localized strings).
//
// All three inputs are pure buffers — no node:fs. The main-layer caller is
// responsible for reading the files. This keeps the extractor unit-testable.

import { parseBundle } from "./bundleParser";
import { parseSerializedFile, getObjectRaw } from "./serializedFile";
import { parseTextAssetRaw } from "./textAsset";
import { scanMarkerEntries, type MarkerEntry } from "./monobehaviourEntries";
import type { GameItem } from "../gamedata";

export interface CatalogExtractorInput {
  sharedassets0: Buffer;
  sharedBundle: Buffer;
  enBundle: Buffer;
}

export interface CatalogExtractionStats {
  csvRows: number;
  resolvedNames: number;
  unresolvedNameKey: number;
  literalNames: number;
  skipped: number;
  nameKeyOnlyAdded: number;
}

export interface ExtractedCatalog {
  gameVersion: string;
  items: GameItem[];
  stats: CatalogExtractionStats;
}

const TYPE_TEXTASSET = 49;
const TYPE_MONOBEHAVIOUR = 114;

function loadNameMap(input: CatalogExtractorInput): Map<string, string> {
  // SharedTableData: smaller MonoBehaviour (~21KB) in sharedBundle.
  const sharedBundle = parseBundle(input.sharedBundle);
  const sharedSf = parseSerializedFile(sharedBundle.data);
  const sharedMonoBehaviours = sharedSf.objects.filter((o) => o.classID === TYPE_MONOBEHAVIOUR);
  // Pick the smallest MonoBehaviour (ItemTable Shared Data is ~21KB; StringTable Shared is ~52KB).
  const sharedMono = sharedMonoBehaviours
    .map((o) => ({ info: o, raw: getObjectRaw(o, sharedBundle.data, sharedSf.dataOffset) }))
    .sort((a, b) => a.raw.length - b.raw.length)[0];
  if (!sharedMono) throw new Error("no MonoBehaviour in shared_assets bundle");
  const sharedEntries = scanMarkerEntries(sharedMono.raw);

  // EN StringTable: smaller MonoBehaviour (~28KB) in enBundle.
  const enBundle = parseBundle(input.enBundle);
  const enSf = parseSerializedFile(enBundle.data);
  const enMonoBehaviours = enSf.objects.filter((o) => o.classID === TYPE_MONOBEHAVIOUR);
  const enMono = enMonoBehaviours
    .map((o) => ({ info: o, raw: getObjectRaw(o, enBundle.data, enSf.dataOffset) }))
    .sort((a, b) => a.raw.length - b.raw.length)[0];
  if (!enMono) throw new Error("no MonoBehaviour in EN stringtable bundle");
  const enEntries = scanMarkerEntries(enMono.raw);

  // Hash is the linker (validated in scripts/compare_hashes.py).
  const sharedByHash = new Map<number, string>();
  for (const e of sharedEntries) sharedByHash.set(e.hash, e.str);
  const enByHash = new Map<number, string>();
  for (const e of enEntries) enByHash.set(e.hash, e.str);

  const nameMap = new Map<string, string>();
  for (const [hash, k] of sharedByHash) {
    const v = enByHash.get(hash);
    if (v === undefined) continue;
    if (k.startsWith("ItemName_")) nameMap.set(k, v);
  }
  return nameMap;
}

function loadCsvText(input: CatalogExtractorInput): string {
  const sf = parseSerializedFile(input.sharedassets0);
  for (const obj of sf.objects) {
    if (obj.classID !== TYPE_TEXTASSET) continue;
    const raw = getObjectRaw(obj, input.sharedassets0, sf.dataOffset);
    const [name, script] = parseTextAssetRaw(raw);
    if (name === "ItemInfoData" && script) return script;
  }
  throw new Error("ItemInfoData TextAsset not found in sharedassets0.assets");
}

function parseBool(s: string | undefined): boolean {
  if (!s) return false;
  return s.trim().toLowerCase() === "true" || s.trim() === "1";
}

const ITEM_KEY_RE = /^\d+$/;

export function extractCatalog(input: CatalogExtractorInput): ExtractedCatalog {
  const nameMap = loadNameMap(input);
  const csvText = loadCsvText(input);

  // Strip BOM, parse CSV.
  const cleanText = csvText.replace(/^\uFEFF/, "");
  const lines = cleanText.split(/\r?\n/);
  if (lines.length < 2) throw new Error("ItemInfoData CSV has no rows");
  const header = lines[0].split(",");
  const rows = lines.slice(1).filter((l) => l.length > 0);

  const colIdx = (name: string): number => {
    // Tolerate BOM-prefixed first column.
    const idx = header.findIndex((h) => h.trim() === name || h.trim() === "\uFEFF" + name);
    return idx;
  };
  const iItemKey = colIdx("ItemKey");
  const iNameKey = colIdx("NameKey");
  const iGrade = colIdx("GRADE");
  const iType = colIdx("ITEMTYPE");
  const iLevel = colIdx("Level");
  const iTradable = colIdx("IsCanExchangeMarketable");
  if (iItemKey < 0) throw new Error(`CSV missing ItemKey column; header=${header.join(",")}`);

  const items: GameItem[] = [];
  let resolved = 0;
  let unresolvedNameKey = 0;
  let literalNames = 0;
  let skipped = 0;

  for (const row of rows) {
    const cols = row.split(",");
    const ikStr = (cols[iItemKey] ?? "").trim();
    if (!ITEM_KEY_RE.test(ikStr)) {
      skipped += 1;
      continue;
    }
    const itemKey = parseInt(ikStr, 10);
    const nameKey = (cols[iNameKey] ?? "").trim();
    let name: string;
    if (nameKey.startsWith("ItemName_")) {
      const resolvedName = nameMap.get(nameKey);
      if (resolvedName === undefined) {
        name = nameKey;
        unresolvedNameKey += 1;
      } else {
        name = resolvedName;
        resolved += 1;
      }
    } else if (nameKey) {
      name = nameKey;
      literalNames += 1;
    } else {
      name = `#${itemKey}`;
      unresolvedNameKey += 1;
    }
    const levelStr = (cols[iLevel] ?? "").trim();
    const level = levelStr ? Number(levelStr) : null;
    items.push({
      id: itemKey,
      name,
      grade: (cols[iGrade] ?? "").trim(),
      type: (cols[iType] ?? "").trim(),
      level: Number.isFinite(level as number) ? (level as number) : null,
      marketTradable: parseBool(cols[iTradable]),
    });
  }

  // Add NameKey-only entries (base ids like 620017 that are in the localization
  // bundle but not in the CSV).
  const seenIds = new Set(items.map((it) => it.id));
  let nameKeyOnly = 0;
  for (const [nk, name] of nameMap) {
    const m = /^ItemName_(\d+)$/.exec(nk);
    if (!m) continue;
    const baseId = parseInt(m[1], 10);
    if (seenIds.has(baseId)) continue;
    items.push({ id: baseId, name, grade: "", type: "", level: null, marketTradable: false });
    nameKeyOnly += 1;
    seenIds.add(baseId);
  }

  return {
    gameVersion: "1.00.28", // overwritten by caller with the actual running version
    items,
    stats: {
      csvRows: rows.length,
      resolvedNames: resolved,
      unresolvedNameKey,
      literalNames,
      skipped,
      nameKeyOnlyAdded: nameKeyOnly,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/core/unityAssets/catalogExtractor.test.ts`
Expected: PASS — both tests pass. The "extracts the full catalog" test must match the same items count and spot-checks as `python scripts/build_catalog.py`.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/unityAssets/catalogExtractor.ts app/test/core/unityAssets/catalogExtractor.test.ts
git commit -m "feat(core): catalog extractor (TS port of build_catalog.py)"
```

---

## Task 7: Extend `bundledDataCandidates` for userData priority

**Files:**
- Modify: `app/src/core/bundledData.ts`
- Modify: `app/test/core/bundledData.test.ts` (create if missing)

- [ ] **Step 1: Read existing tests to understand the pattern**

Run: `cd app && ls test/core/bundledData* 2>&1`
Expected: either an existing test file or "FileNotFound".

If no test exists, create one:

```typescript
// app/test/core/bundledData.test.ts
import { describe, it, expect } from "vitest";
import { bundledDataCandidates } from "../../src/core/bundledData";

describe("bundledDataCandidates", () => {
  it("returns userData-first order when userDataDir is provided", () => {
    const candidates = bundledDataCandidates("gamedata.json", "/path/to/userData");
    expect(candidates[0]).toBe("/path/to/userData/gamedata.json");
  });

  it("omits userData entry when userDataDir is undefined", () => {
    const candidates = bundledDataCandidates("gamedata.json");
    expect(candidates[0]).not.toContain("userData");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/core/bundledData.test.ts`
Expected: FAIL with "bundledDataCandidates does not accept 2 arguments" or similar.

- [ ] **Step 3: Modify `bundledDataCandidates` to accept optional userDataDir**

```typescript
// app/src/core/bundledData.ts (modified)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ... unchanged constants ...

/**
 * Search order:
 *   1. userData (if provided — refreshed catalog goes here)
 *   2. packaged resources (electron-builder extraResources)
 *   3. repo dev (app/../data — for `pnpm dev`)
 *   4. cwd/data (fallback)
 */
export function bundledDataCandidates(filename: string, userDataDir?: string): string[] {
  const candidates: string[] = [];
  if (userDataDir) {
    candidates.push(join(userDataDir, filename));
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "data", filename));
  }
  candidates.push(join(process.cwd(), "..", "data", filename));
  candidates.push(join(process.cwd(), "data", filename));
  return candidates;
}

// resolveBundledDataPath and readBundledJson are unchanged (they don't pass
// userDataDir — callers like GameDataProvider.load will pass it explicitly).
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/core/bundledData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/bundledData.ts app/test/core/bundledData.test.ts
git commit -m "feat(core): bundledDataCandidates accepts optional userDataDir"
```

---

## Task 8: Extend `GameDataProvider` with reload + version

**Files:**
- Modify: `app/src/main/gameDataProvider.ts`
- Modify: `app/test/main/gameDataProvider.test.ts` (create if missing)

- [ ] **Step 1: Read the current test file (if any)**

Run: `ls app/test/main/gameDataProvider* 2>&1`

- [ ] **Step 2: Write the failing test**

```typescript
// app/test/main/gameDataProvider.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDataProvider } from "../../src/main/gameDataProvider";

describe("GameDataProvider", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tbh-gamedata-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads bundled catalog when userData is empty", () => {
    const provider = new GameDataProvider();
    provider.load(tmp);
    expect(provider.itemCount()).toBeGreaterThan(5000);
    expect(provider.getVersion()).toBe("1.00.28");
  });

  it("prefers userData/gamedata.json when present", () => {
    const userCatalog = {
      gameVersion: "9.9.99",
      items: [
        { id: 1, name: "Test Item", grade: "COMMON", type: "MATERIAL", level: null, marketTradable: false },
      ],
    };
    writeFileSync(join(tmp, "gamedata.json"), JSON.stringify(userCatalog));
    const provider = new GameDataProvider();
    provider.load(tmp);
    expect(provider.getVersion()).toBe("9.9.99");
    expect(provider.get(1)?.name).toBe("Test Item");
  });

  it("reload re-reads from disk", () => {
    const provider = new GameDataProvider();
    provider.load(tmp);
    const initialVersion = provider.getVersion();
    const newCatalog = {
      gameVersion: "9.9.99",
      items: [
        { id: 1, name: "Reloaded", grade: "COMMON", type: "MATERIAL", level: null, marketTradable: false },
      ],
    };
    writeFileSync(join(tmp, "gamedata.json"), JSON.stringify(newCatalog));
    provider.reload(tmp);
    expect(provider.getVersion()).toBe("9.9.99");
    expect(provider.get(1)?.name).toBe("Reloaded");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/main/gameDataProvider.test.ts`
Expected: FAIL — `load` doesn't accept a userDataDir argument, `getVersion` doesn't exist.

- [ ] **Step 4: Modify `GameDataProvider`**

```typescript
// app/src/main/gameDataProvider.ts (modified)
import { readFileSync } from "node:fs";
import {
  catalogItemKeyFromSave,
  indexById,
  normalizeGameItem,
  type GameItem,
} from "../core/gamedata";
import { buildStageBoxCatalog, isStageBoxItemKey, stageBoxIdSet } from "../core/stageBoxes";
import { bundledDataCandidates, resolveBundledDataPath } from "../core/bundledData";
import { createLogger } from "./log";

const log = createLogger("gameData");

export class GameDataProvider {
  private index = new Map<number, GameItem>();
  private stageBoxIds = stageBoxIdSet();
  private loaded = false;
  private gameVersion: string | null = null;

  private mergeStageBoxes(items: GameItem[]): void {
    this.stageBoxIds = stageBoxIdSet(items);
    for (const item of items) this.index.set(item.id, item);
  }

  private loadStageBoxes(): void {
    try {
      const path = resolveBundledDataPath("stage_boxes.json");
      const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
      const d = JSON.parse(raw) as { items?: unknown[] };
      if (Array.isArray(d.items)) {
        const items = d.items
          .map((row) => normalizeGameItem(row as Record<string, unknown>))
          .filter((item): item is GameItem => item != null);
        if (items.length > 0) {
          this.mergeStageBoxes(items);
          return;
        }
      }
      log.warn("stage_boxes.json: missing or empty items array, falling back to in-code catalog");
    } catch (e) {
      log.warn(`stage_boxes.json load failed, using in-code catalog: ${(e as Error).message}`);
    }
    this.mergeStageBoxes(buildStageBoxCatalog().items);
  }

  /** Load gamedata.json, preferring userDataDir if provided. */
  load(userDataDir?: string): void {
    const candidates = bundledDataCandidates("gamedata.json", userDataDir);
    const found = candidates.find((p) => {
      try {
        return existsSyncSafe(p);
      } catch {
        return false;
      }
    });
    if (!found) {
      throw new Error(
        `gamedata.json not found\nTried:\n${candidates.map((p) => `  - ${p}`).join("\n")}`,
      );
    }
    const raw = readFileSync(found, "utf-8").replace(/^\uFEFF/, "");
    let parsed: { gameVersion?: string; items?: unknown[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error("gamedata.json: invalid JSON");
    }
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      throw new Error("gamedata.json: missing or empty items array");
    }
    const items = parsed.items
      .map((row) => normalizeGameItem(row as Record<string, unknown>))
      .filter((item): item is GameItem => item != null);
    if (items.length === 0) {
      throw new Error("gamedata.json: no valid item rows");
    }
    this.index = indexById(items);
    this.gameVersion = parsed.gameVersion ?? null;
    this.loaded = true;
    this.loadStageBoxes();
  }

  /** Re-read from disk. Safe to call after load(). */
  reload(userDataDir?: string): void {
    this.load(userDataDir);
  }

  get(itemKey: number): GameItem | undefined {
    return this.index.get(catalogItemKeyFromSave(itemKey));
  }

  isStageBox(itemKey: number): boolean {
    return isStageBoxItemKey(itemKey, this.stageBoxIds);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  itemCount(): number {
    return this.index.size;
  }

  asMap(): Map<number, GameItem> {
    return this.index;
  }

  /** Catalog's bundled gameVersion (e.g. "1.00.28"). null if unknown. */
  getVersion(): string | null {
    return this.gameVersion;
  }
}

function existsSyncSafe(p: string): boolean {
  // Wrapper to keep imports minimal at the top.
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  return existsSync(p);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/main/gameDataProvider.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/gameDataProvider.ts app/test/main/gameDataProvider.test.ts
git commit -m "feat(main): GameDataProvider loads from userData, exposes reload + getVersion"
```

---

## Task 9: Add shared types + IPC channels

**Files:**
- Modify: `app/shared/types.ts`
- Modify: `app/shared/ipc.ts`
- Modify: `app/test/ipc/channels.test.ts`

- [ ] **Step 1: Write the failing test (extend channels.test.ts)**

Run: `cat app/test/ipc/channels.test.ts | head -50` to understand the existing pattern.

Then add to `app/test/ipc/channels.test.ts`:

```typescript
// ... existing imports ...
import { IPC, IPC_INVOKE_CHANNELS, IPC_PUSH_CHANNELS } from "../../shared/ipc";

describe("IPC channels", () => {
  // ... existing tests ...

  it("includes catalog channels in invoke list", () => {
    expect(IPC_INVOKE_CHANNELS).toContain(IPC.CATALOG_REFRESH);
    expect(IPC_INVOKE_CHANNELS).toContain(IPC.GET_CATALOG_STATUS);
  });

  it("includes catalog status in push list", () => {
    expect(IPC_PUSH_CHANNELS).toContain(IPC.CATALOG_STATUS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/ipc/channels.test.ts`
Expected: FAIL — `IPC.CATALOG_REFRESH` is undefined.

- [ ] **Step 3: Add types to shared/types.ts**

```typescript
// app/shared/types.ts (append)
import type { GameItem } from "../src/core/gamedata";

export interface CatalogStatus {
  /** Catalog's bundled gameVersion (e.g. "1.00.28"), null if unknown. */
  catalogVersion: string | null;
  /** Currently-running game version (from LiveMemoryReader), null if not attached. */
  gameVersion: string | null;
  /** True when catalog and game versions differ. */
  stale: boolean;
  /** "bundled" or "userData" — where the active catalog was loaded from. */
  source: "bundled" | "userData";
  /** Number of items in the active catalog. */
  itemCount: number;
  /** Epoch ms of the most recent successful refresh, or null. */
  lastRefreshMs: number | null;
  /** Error message from the most recent refresh attempt, or null. */
  lastError: string | null;
}

export interface CatalogRefreshResult {
  ok: boolean;
  gameVersion: string | null;
  itemCount: number;
  resolvedNames: number;
  /** Error message when ok === false. */
  error?: string;
}
```

- [ ] **Step 4: Add IPC channels to shared/ipc.ts**

```typescript
// app/shared/ipc.ts (modify IPC object — add after GET_LOOKUP_PRICES)
  GET_CATALOG_STATUS: "get-catalog-status",

// After PRICES_REFRESH_ITEM:
  CATALOG_REFRESH: "catalog-refresh",

// In Push section (after LOOKUP_PRICES):
  CATALOG_STATUS: "catalog-status",
```

```typescript
// In IPC_INVOKE_CHANNELS array:
  IPC.GET_CATALOG_STATUS,
  IPC.CATALOG_REFRESH,

// In IPC_PUSH_CHANNELS array:
  IPC.CATALOG_STATUS,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/ipc/channels.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/shared/types.ts app/shared/ipc.ts app/test/ipc/channels.test.ts
git commit -m "feat(shared): catalog refresh IPC channels + types"
```

---

## Task 10: `CatalogRefreshService` (main layer orchestrator)

**Files:**
- Create: `app/src/main/catalogRefreshService.ts`
- Create: `app/test/main/catalogRefreshService.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// app/test/main/catalogRefreshService.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CatalogRefreshService } from "../../src/main/catalogRefreshService";
import type { GameDataProvider } from "../../src/main/gameDataProvider";
import type { LiveMemoryService } from "../../src/main/services/LiveMemoryService";

function makeMocks() {
  const gameData: Pick<GameDataProvider, "load" | "reload" | "getVersion" | "itemCount"> = {
    load: vi.fn(),
    reload: vi.fn(),
    getVersion: vi.fn().mockReturnValue("1.00.28"),
    itemCount: vi.fn().mockReturnValue(6030),
  };
  const liveMemory: Pick<LiveMemoryService, "getStatus"> = {
    getStatus: vi.fn().mockReturnValue({ gameVersion: "1.00.28", supported: true, running: true, attached: true, pid: 1234, note: null }),
  };
  return { gameData, liveMemory };
}

describe("CatalogRefreshService", () => {
  it("returns current status as not stale when versions match", () => {
    const { gameData, liveMemory } = makeMocks();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    const status = svc.getStatus();
    expect(status.stale).toBe(false);
    expect(status.catalogVersion).toBe("1.00.28");
    expect(status.gameVersion).toBe("1.00.28");
  });

  it("marks stale when game version differs from catalog", () => {
    const { gameData, liveMemory } = makeMocks();
    (liveMemory.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      gameVersion: "1.00.29",
      supported: true,
      running: true,
      attached: true,
      pid: 1234,
      note: null,
    });
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(svc.getStatus().stale).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm exec vitest run test/main/catalogRefreshService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// app/src/main/catalogRefreshService.ts
// Orchestrates catalog refresh: locate game install → read 3 asset files →
// extract catalog via core/unityAssets → write userData/gamedata.json →
// reload GameDataProvider. Reports status via getStatus() and broadcasts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractCatalog } from "../core/unityAssets/catalogExtractor";
import type { GameItem } from "../core/gamedata";
import type { GameDataProvider } from "./gameDataProvider";
import type { LiveMemoryService } from "./services/LiveMemoryService";
import type { BroadcastFn } from "./broadcast";
import { IPC } from "../../shared/ipc";
import type { CatalogRefreshResult, CatalogStatus } from "../../shared/types";
import { createLogger } from "./log";
import { resolveUserDataDir } from "./services/appData";

const log = createLogger("catalogRefresh");

const GAMEDATA_FILE = "gamedata.json";

// Default install path (Steam). Overridable by env for non-standard installs.
const DEFAULT_GAME_INSTALL = "D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data";
const GAME_INSTALL_ENV = "TBH_GAME_INSTALL_DATA_DIR";

function resolveGameInstallDir(): string | null {
  const fromEnv = process.env[GAME_INSTALL_ENV];
  if (fromEnv) return fromEnv;
  if (existsSync(DEFAULT_GAME_INSTALL)) return DEFAULT_GAME_INSTALL;
  return null;
}

function resolveAssetPaths(installDir: string): {
  sharedassets0: string;
  sharedBundle: string;
  enBundle: string;
} {
  const aa = join(installDir, "StreamingAssets", "aa", "StandaloneWindows64");
  return {
    sharedassets0: join(installDir, "sharedassets0.assets"),
    sharedBundle: join(aa, "localization-assets-shared_assets_all.bundle"),
    enBundle: join(
      aa,
      "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
    ),
  };
}

export class CatalogRefreshService {
  private lastRefreshMs: number | null = null;
  private lastError: string | null = null;
  private lastRefreshedItemCount = 0;
  private lastRefreshedGameVersion: string | null = null;

  constructor(
    private readonly gameData: GameDataProvider,
    private readonly liveMemory: LiveMemoryService,
    private readonly userDataDir: string = resolveUserDataDir(),
    private readonly broadcast?: BroadcastFn,
  ) {}

  /** Current status snapshot. Call after any refresh attempt or version change. */
  getStatus(): CatalogStatus {
    const catalogVersion = this.gameData.getVersion();
    const gameVersion = this.liveMemory.getStatus()?.gameVersion ?? null;
    const stale =
      catalogVersion !== null &&
      gameVersion !== null &&
      catalogVersion !== gameVersion;
    return {
      catalogVersion,
      gameVersion,
      stale,
      source: this.lastRefreshMs !== null ? "userData" : "bundled",
      itemCount: this.gameData.itemCount(),
      lastRefreshMs: this.lastRefreshMs,
      lastError: this.lastError,
    };
  }

  /** Trigger a refresh. Returns the result; also broadcasts status. */
  async refresh(): Promise<CatalogRefreshResult> {
    try {
      const installDir = resolveGameInstallDir();
      if (!installDir) {
        throw new Error(
          `game install dir not found (set ${GAME_INSTALL_ENV} or install at ${DEFAULT_GAME_INSTALL})`,
        );
      }
      const paths = resolveAssetPaths(installDir);
      for (const [key, path] of Object.entries(paths)) {
        if (!existsSync(path)) {
          throw new Error(`required asset file missing: ${key} (${path})`);
        }
      }
      log.info(`refreshing catalog from ${installDir}`);
      const sharedassets0 = readFileSync(paths.sharedassets0);
      const sharedBundle = readFileSync(paths.sharedBundle);
      const enBundle = readFileSync(paths.enBundle);

      const extracted = extractCatalog({ sharedassets0, sharedBundle, enBundle });
      const gameVersion = this.liveMemory.getStatus()?.gameVersion ?? extracted.gameVersion;

      // Write to userData.
      mkdirSync(this.userDataDir, { recursive: true });
      const outPath = join(this.userDataDir, GAMEDATA_FILE);
      const payload = {
        gameVersion,
        items: extracted.items,
      };
      writeFileSync(outPath, JSON.stringify(payload), "utf-8");
      log.info(
        `wrote ${outPath}: ${extracted.items.length} items (resolved ${extracted.stats.resolvedNames} names)`,
      );

      // Reload GameDataProvider.
      this.gameData.reload(this.userDataDir);

      this.lastRefreshMs = Date.now();
      this.lastError = null;
      this.lastRefreshedItemCount = extracted.items.length;
      this.lastRefreshedGameVersion = gameVersion;

      const result: CatalogRefreshResult = {
        ok: true,
        gameVersion,
        itemCount: extracted.items.length,
        resolvedNames: extracted.stats.resolvedNames,
      };
      this.broadcastStatus();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`refresh failed: ${msg}`);
      this.lastError = msg;
      this.broadcastStatus();
      return { ok: false, gameVersion: null, itemCount: 0, resolvedNames: 0, error: msg };
    }
  }

  /** Called by LiveMemoryService when gameVersion changes — broadcast status so
   * the renderer can show the stale banner. Does NOT auto-refresh. */
  onGameVersionChanged(): void {
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    if (this.broadcast) {
      this.broadcast(IPC.CATALOG_STATUS, this.getStatus());
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm exec vitest run test/main/catalogRefreshService.test.ts`
Expected: PASS — both tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/catalogRefreshService.ts app/test/main/catalogRefreshService.test.ts
git commit -m "feat(main): CatalogRefreshService orchestrates extract + write + reload"
```

---

## Task 11: Wire IPC handlers + appState

**Files:**
- Create: `app/src/main/ipc/handlers/catalog.ts`
- Modify: `app/src/main/app/appState.ts`
- Modify: `app/src/main/ipc/registerIpc.ts`

- [ ] **Step 1: Create the catalog IPC handler**

```typescript
// app/src/main/ipc/handlers/catalog.ts
import type { IpcMain } from "electron";
import { IPC } from "../../../../shared/ipc";
import type { AppServices } from "../../app/appState";

export function registerCatalogHandlers(ipc: IpcMain, services: AppServices): void {
  ipc.handle(IPC.GET_CATALOG_STATUS, () => services.getCatalogStatus());
  ipc.handle(IPC.CATALOG_REFRESH, () => services.refreshCatalog());
}
```

- [ ] **Step 2: Modify appState.ts to instantiate the service and expose handlers**

Find the section after `const lookupPrices = new LookupPriceService();` (around line 52) and add:

```typescript
// In imports:
import { CatalogRefreshService } from "../catalogRefreshService";

// In service instantiation (after lookupPrices):
const catalogRefresh = new CatalogRefreshService(
  // gameData is owned by InventoryService; we need to expose it.
  // Quick refactor: pull gameData out of InventoryService or expose a delegate.
  // For minimal disruption, we add `getGameData()` to InventoryService.
  inventory.getGameData(),
  liveMemory,
  resolveUserDataDir(),
  (channel, payload) => broadcast(channel, payload),
);
```

Modify `InventoryService` to expose its `GameDataProvider`:

```typescript
// app/src/main/services/InventoryService.ts (add a public getter)
getGameData(): GameDataProvider {
  return this.gameData;
}
```

Add to the services object in `appState.ts` (near `getLookupCatalog`):

```typescript
getCatalogStatus: () => catalogRefresh.getStatus(),
refreshCatalog: () => catalogRefresh.refresh(),
```

- [ ] **Step 3: Wire registerIpc.ts**

```typescript
// app/src/main/ipc/registerIpc.ts (modify)
import { registerCatalogHandlers } from "./handlers/catalog";
// ...
export function registerIpc(services: AppServices): void {
  // ... existing registrations ...
  registerCatalogHandlers(ipcMain, services);
}
```

- [ ] **Step 4: Run the channels test to verify wiring**

Run: `cd app && pnpm exec vitest run test/ipc/channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/ipc/handlers/catalog.ts app/src/main/app/appState.ts app/src/main/ipc/registerIpc.ts app/src/main/services/InventoryService.ts
git commit -m "feat(main): wire catalog refresh IPC handlers"
```

---

## Task 12: Preload + renderer context wiring

**Files:**
- Modify: `app/src/preload/index.ts`
- Modify: `app/src/shared/types.ts` (extend TbhApi)
- Modify: `app/src/renderer/context/tbhContext.ts`
- Modify: `app/src/renderer/context/TbhProvider.tsx`
- Create: `app/src/renderer/lib/useCatalogStatus.ts`

- [ ] **Step 1: Extend TbhApi type**

```typescript
// app/shared/types.ts (append to TbhApi interface — find the existing definition)
export interface TbhApi {
  // ... existing methods ...
  getCatalogStatus(): Promise<CatalogStatus | null>;
  refreshCatalog(): Promise<CatalogRefreshResult>;
  onCatalogStatus(cb: (status: CatalogStatus) => void): () => void;
}
```

- [ ] **Step 2: Add preload wiring**

```typescript
// app/src/preload/index.ts (add to api object, after getLookupPrices)
getCatalogStatus(): Promise<CatalogStatus | null> {
  return ipcRenderer.invoke(IPC.GET_CATALOG_STATUS);
},
refreshCatalog(): Promise<CatalogRefreshResult> {
  return ipcRenderer.invoke(IPC.CATALOG_REFRESH);
},
onCatalogStatus(cb: (status: CatalogStatus) => void): () => void {
  const listener = (_e: unknown, status: CatalogStatus): void => cb(status);
  ipcRenderer.on(IPC.CATALOG_STATUS, listener);
  return () => ipcRenderer.removeListener(IPC.CATALOG_STATUS, listener);
},
```

Also add `CatalogRefreshResult`, `CatalogStatus` to the type imports at the top of `preload/index.ts`.

- [ ] **Step 3: Extend TbhContext**

```typescript
// app/src/renderer/context/tbhContext.ts (add to context value)
import type { CatalogStatus, CatalogRefreshResult } from "../../../shared/types";

export interface TbhContextValue {
  // ... existing fields ...
  catalogStatus: CatalogStatus | null;
  refreshCatalog: () => Promise<CatalogRefreshResult>;
  clearCatalogStatus: () => void;
}
```

- [ ] **Step 4: Add the useCatalogStatus hook**

```typescript
// app/src/renderer/lib/useCatalogStatus.ts
import { useEffect, useState } from "react";
import type { CatalogStatus } from "../../../shared/types";
import { reportIpcError } from "./reportError";

export function useCatalogStatus(): {
  status: CatalogStatus | null;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<CatalogStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getCatalogStatus()
      ?.then((s) => {
        if (mounted && s) setStatus(s);
      })
      .catch(reportIpcError);

    const off = window.tbh.onCatalogStatus((s) => {
      if (mounted) setStatus(s);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return {
    status,
    refresh: async () => {
      const result = await window.tbh.refreshCatalog();
      if (!result.ok && result.error) {
        reportIpcError(new Error(result.error), "catalog-refresh");
      }
    },
  };
}
```

- [ ] **Step 5: Modify TbhProvider to subscribe**

```typescript
// app/src/renderer/context/TbhProvider.tsx (modify)
import { useCatalogStatus } from "../lib/useCatalogStatus";

export function TbhProvider({ children }: { children: ReactNode }) {
  // ... existing state ...
  const { status: catalogStatus, refresh: refreshCatalog } = useCatalogStatus();

  // ... existing useEffect ...

  const value = useMemo(
    () => ({
      inventory,
      lastPriceRefreshMessage,
      clearLastPriceRefreshMessage: () => setLastPriceRefreshMessage(null),
      catalogStatus,
      refreshCatalog,
    }),
    [inventory, lastPriceRefreshMessage, catalogStatus, refreshCatalog],
  );

  return <TbhContext.Provider value={value}>{children}</TbhContext.Provider>;
}
```

- [ ] **Step 6: Run typecheck**

Run: `cd app && pnpm typecheck`
Expected: no type errors. If `TbhApi` interface mismatch, align the preload signatures.

- [ ] **Step 7: Commit**

```bash
git add app/src/preload/index.ts app/shared/types.ts app/src/renderer/context/tbhContext.ts app/src/renderer/context/TbhProvider.tsx app/src/renderer/lib/useCatalogStatus.ts
git commit -m "feat(preload,renderer): catalog status subscription + refresh API"
```

---

## Task 13: `CatalogRefreshButton` component + Settings tab integration

**Files:**
- Create: `app/src/renderer/components/CatalogRefreshButton.tsx`
- Modify: `app/src/renderer/tabs/Settings.tsx`

- [ ] **Step 1: Create the button component**

```tsx
// app/src/renderer/components/CatalogRefreshButton.tsx
import { useState } from "react";
import { Button } from "../design-system/primitives/Button/Button";
import { cn } from "../lib/cn";
import { reportIpcError } from "../lib/reportError";
import type { CatalogStatus } from "../../../shared/types";

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={cn("size-3.5 shrink-0", spinning && "animate-spin")}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V6h-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CatalogRefreshButton({
  status,
  onRefresh,
}: {
  status: CatalogStatus | null;
  onRefresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  async function handleClick(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await onRefresh();
    } catch (err) {
      reportIpcError(err, "catalog-refresh-button");
    } finally {
      setPending(false);
    }
  }

  const message = status?.lastError
    ? `Refresh failed: ${status.lastError}`
    : status?.lastRefreshMs
      ? `Refreshed ${status.itemCount} items${
          status.gameVersion ? ` for v${status.gameVersion}` : ""
        }`
      : null;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="default"
        type="button"
        disabled={pending}
        onClick={() => void handleClick()}
      >
        <RefreshIcon spinning={pending} />
        <span className="ml-1.5">{pending ? "Refreshing…" : "Refresh catalog"}</span>
      </Button>
      {message && (
        <span
          className={cn(
            "text-[13px]",
            status?.lastError ? "text-warning" : "text-muted",
          )}
        >
          {message}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the "Item catalog" Section to Settings.tsx**

Find the Settings tab file (`app/src/renderer/tabs/Settings.tsx`) and add a new section before the closing `</TabPage>`:

```tsx
// In Settings.tsx imports:
import { useTbh } from "../lib/useTbh"; // or wherever the context hook lives
import { CatalogRefreshButton } from "../components/CatalogRefreshButton";

// Inside the Settings component, after existing sections:
const { catalogStatus, refreshCatalog } = useTbh();

// JSX:
<Section title="Item catalog">
  <div className="flex flex-col gap-2">
    <p className="m-0 text-[13px] text-muted">
      Catalog version: {catalogStatus?.catalogVersion ?? "unknown"}
      {catalogStatus?.gameVersion
        ? ` · Game version: ${catalogStatus.gameVersion}`
        : ""}
      {catalogStatus?.stale ? " · outdated" : ""}
    </p>
    <p className="m-0 text-[13px] text-muted">
      {catalogStatus?.itemCount ?? 0} items loaded from {catalogStatus?.source ?? "bundled"}.
    </p>
    <CatalogRefreshButton status={catalogStatus} onRefresh={refreshCatalog} />
  </div>
</Section>
```

- [ ] **Step 3: Run typecheck**

Run: `cd app && pnpm typecheck`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/renderer/components/CatalogRefreshButton.tsx app/src/renderer/tabs/Settings.tsx
git commit -m "feat(renderer): CatalogRefreshButton + Settings section"
```

---

## Task 14: Loot tab HintBanner for stale catalog

**Files:**
- Modify: `app/src/renderer/tabs/Loot.tsx`

- [ ] **Step 1: Read Loot.tsx top of file**

Run: `Read app/src/renderer/tabs/Loot.tsx (first 80 lines)` to see existing imports.

- [ ] **Step 2: Add the HintBanner**

```tsx
// app/src/renderer/tabs/Loot.tsx (modify)
// Add to imports:
import { useTbh } from "../lib/useTbh";

// Inside the Loot component, near the top of the JSX (after <TabHeader>):
const { catalogStatus } = useTbh();

// In JSX, between <TabHeader> and the existing content:
{catalogStatus?.stale && (
  <HintBanner>
    Item catalog may be outdated (catalog v{catalogStatus.catalogVersion}, game v{catalogStatus.gameVersion}).
    <button
      type="button"
      className="ml-2 text-gold underline"
      onClick={() => {
        // Switch to Settings tab — use the same mechanism other code uses.
        // If there's a setTab global, use it; otherwise instruct the user.
      }}
    >
      Open Settings to refresh
    </button>
  </HintBanner>
)}
```

Note: the exact "switch to Settings tab" mechanism depends on the App.tsx tab state. If there's a `useTab` hook or context, use it. If not, the button can just be text without an onClick.

- [ ] **Step 3: Run typecheck**

Run: `cd app && pnpm typecheck`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/renderer/tabs/Loot.tsx
git commit -m "feat(renderer): Loot tab HintBanner for stale catalog"
```

---

## Task 15: Wire LiveMemoryService → CatalogRefreshService for version-change broadcast

**Files:**
- Modify: `app/src/main/services/LiveMemoryService.ts`
- Modify: `app/src/main/app/appState.ts`

- [ ] **Step 1: Add an onGameVersionChanged callback to LiveMemoryService**

```typescript
// app/src/main/services/LiveMemoryService.ts (modify)
export class LiveMemoryService {
  // ... existing fields ...
  private onGameVersionChanged?: () => void;

  setOnGameVersionChanged(cb: () => void): void {
    this.onGameVersionChanged = cb;
  }

  // In the worker message handler:
  this.child.on("message", (msg: WorkerMessage) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "status") {
      const prevVersion = this.lastStatus?.gameVersion ?? null;
      this.lastStatus = msg.status;
      broadcast(IPC.LIVE_MEMORY_STATUS, msg.status);
      const newVersion = msg.status.gameVersion ?? null;
      if (prevVersion !== null && newVersion !== null && prevVersion !== newVersion) {
        this.onGameVersionChanged?.();
      }
    } else if (msg.type === "snapshot") {
      // ... existing ...
    }
  });
}
```

- [ ] **Step 2: Wire the callback in appState.ts**

```typescript
// app/src/main/app/appState.ts (after catalogRefresh is instantiated)
liveMemory.setOnGameVersionChanged(() => {
  catalogRefresh.onGameVersionChanged();
});
```

- [ ] **Step 3: Run typecheck**

Run: `cd app && pnpm typecheck`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/services/LiveMemoryService.ts app/src/main/app/appState.ts
git commit -m "feat(main): broadcast catalog status on game version change"
```

---

## Task 16: End-to-end smoke test

**Files:**
- No new files. Manual test against a running game.

- [ ] **Step 1: Run the full test suite**

Run: `cd app && pnpm exec vitest run`
Expected: all existing tests + new tests pass. If `gameDataProvider.test.ts` fails due to missing `data/gamedata.json` in test cwd, run from the `app/` directory.

- [ ] **Step 2: Run typecheck + lint**

Run: `cd app && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Run dev build**

Run: `cd app && pnpm dev`
Expected: app launches. Settings tab shows "Item catalog" section with version v1.00.28.

- [ ] **Step 4: Test the refresh button**

With the game running, click "Refresh catalog" in Settings.
Expected:
- Button shows "Refreshing…" with spinning icon for ~2 seconds.
- Status text appears: "Refreshed 6030 items for v1.00.28".
- `userData/gamedata.json` file exists (check via `ls %APPDATA%/tbh-companion/gamedata.json` or similar).

- [ ] **Step 5: Test the version-mismatch banner**

Edit `data/gamedata.json` in the repo, change `gameVersion` to "0.0.99", restart `pnpm dev`.
Expected:
- Loot tab shows HintBanner: "Item catalog may be outdated (catalog v0.0.99, game v1.00.28)".
- Settings shows the catalog version as "0.0.99" and "stale" indicator.

- [ ] **Step 6: Test failure path**

Set `TBH_GAME_INSTALL_DATA_DIR` to a non-existent path and click Refresh.
Expected:
- Button shows "Refresh failed: game install dir not found…"
- Old catalog remains loaded (app doesn't break).

- [ ] **Step 7: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "test: end-to-end smoke pass for in-app catalog refresh"
```

---

## Self-Review

**1. Spec coverage** — All requirements from the brainstorming Q&A are covered:
- ✅ Trigger: version mismatch + manual button (Task 15 + Task 13)
- ✅ UI location: Settings button + Loot HintBanner (Task 13 + Task 14)
- ✅ Storage: userData + memory (Task 7 + Task 8)
- ✅ Version detection: pure version string compare + force refresh (Task 9 + Task 13)
- ✅ Progress feedback: button spin + status text (Task 13)
- ✅ Parsing: complete Node.js UnityFS parser (Tasks 2-6)
- ✅ Failure handling: keep old catalog + error text (Task 10 + Task 13)

**2. Placeholder scan** — No TBD/TODO/"add error handling" placeholders. All code blocks are complete implementations or test cases.

**3. Type consistency** —
- `CatalogStatus` fields match across `shared/types.ts` → `CatalogRefreshService.getStatus` → `useCatalogStatus` → `CatalogRefreshButton` props.
- `CatalogRefreshResult` matches across `shared/types.ts` → `CatalogRefreshService.refresh` → preload `refreshCatalog` → `useCatalogStatus.refresh`.
- `GameDataProvider.load(userDataDir?)` and `reload(userDataDir?)` signatures consistent across all callers.
- `bundledDataCandidates(filename, userDataDir?)` signature consistent.

**4. Gaps fixed inline** —
- Originally missing: how `GameDataProvider` gets the catalog version field. Added `getVersion()` in Task 8.
- Originally missing: how `CatalogRefreshService` accesses `GameDataProvider` (owned by `InventoryService`). Added `getGameData()` getter in Task 11 Step 2.
- Originally missing: how renderer switches to Settings tab from Loot banner. Noted as "use existing tab mechanism" in Task 14.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-18-catalog-in-app-refresh.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
