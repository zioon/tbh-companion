import { describe, it, expect } from "vitest";
import {
  findBoxQueueClass,
  makeBoxQueuePinState,
  resolveBoxDataOffsets,
  scanBoxQueue,
  toBoxQueueItems,
  validateBoxQueueInstance,
  type BoxQueuePinState,
  type HeapRegion,
  type RawBoxQueue,
} from "../../src/core/liveMemory/boxQueueScanner";
import type { MemoryReader } from "../../src/core/liveMemory/memory";
import { FakeMemory } from "./liveMemoryFake";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Encode an int32 as an ACTk ObscuredInt (8 bytes: hidden + cryptoKey). */
function encodeObscuredInt(value: number, crypto: number): Buffer {
  const buf = Buffer.alloc(8);
  // (value ^ crypto) + crypto, mod 2^32 (signed-int32 wrap).
  const v = BigInt(value);
  const k = BigInt(crypto);
  const hidden = Number(BigInt.asIntN(32, ((v ^ k) + k) & 0xffffffffn));
  buf.writeInt32LE(hidden, 0);
  buf.writeInt32LE(crypto, 4);
  return buf;
}

/**
 * Write a null-terminated ASCII string at `addr` in a fixed 256-byte buffer.
 * The scanner's `readCString` asks for up to 256 bytes (MAX_TYPE_NAME_LEN)
 * and FakeMemory.readBytes returns null when the stored buffer is shorter
 * than the requested size, so we always allocate the full 256 bytes.
 */
function writeString(m: FakeMemory, addr: bigint, s: string): void {
  const b = Buffer.alloc(256, 0);
  b.write(s, 0, "utf8");
  m.writeBytes(addr, b);
}

/** Seed a minimal Il2CppClass* with the given field info entries. */
function seedClass(
  m: FakeMemory,
  classPtr: bigint,
  fields: Array<{ name: string; offset: number; typeName?: string }>,
  className?: string,
): void {
  const fieldsPtr = classPtr + 0x1000n;
  m.writePtr(classPtr + 0x80n, fieldsPtr); // Il2CppClass.fields @ +0x80
  // Il2CppClass.name @ +0x10 (char*) — used by the name-based class finder.
  if (className != null) {
    const nameAddr = fieldsPtr + 0x2000n;
    writeString(m, nameAddr, className);
    m.writePtr(classPtr + 0x10n, nameAddr);
  }
  for (let i = 0; i < fields.length; i++) {
    const base = fieldsPtr + BigInt(i * 0x20);
    const nameAddr = fieldsPtr + 0x1000n + BigInt(i * 0x100);
    const fieldName = fields[i]!.name;
    writeString(m, nameAddr, fieldName);
    m.writePtr(base + 0x0n, nameAddr); // field name
    m.writeI32(base + 0x18n, fields[i]!.offset); // field offset
    if (fields[i]!.typeName) {
      // Il2CppFieldInfo.type is at +0x10 (x64).
      const typePtr = nameAddr + 0x80n;
      m.writePtr(base + 0x10n, typePtr);
      // Il2CppType.data (string ptr) at +0x8.
      const typeStrPtr = typePtr + 0x80n;
      m.writePtr(typePtr + 0x8n, typeStrPtr);
      writeString(m, typeStrPtr, fields[i]!.typeName!);
    }
  }
  // sentinel: null name pointer at the next entry.
  m.writePtr(fieldsPtr + BigInt(fields.length * 0x20), 0n);
}

/**
 * Build a complete runtime box-queue singleton in FakeMemory:
 *   - box-queue class (vw) with a `Dictionary<EBoxType, List<BoxData>>` field
 *   - one live instance whose dict has 3 buckets (common/rare/act)
 *   - each bucket is a List<BoxData> with N BoxData instances
 *   - each BoxData has a `o_rewardItemId` ObscuredInt field
 *
 * Returns the addresses the test needs to assert against.
 */
function seedBoxQueue(
  m: FakeMemory,
  items: { common: number[]; rare: number[]; act: number[] },
): {
  classPtr: bigint;
  instancePtr: bigint;
  dictFieldOffset: number;
  rewardOffset: number;
} {
  const classPtr = 0x1_0000_0000n;
  const instancePtr = 0x2_0000_0000n;
  const dictPtr = 0x3_0000_0000n;
  const entriesArr = 0x4_0000_0000n;
  const dictFieldOffset = 0x10;

  // Class: one field named "queue" of type "Dictionary<EBoxType, List<BoxData>>".
  // Name it "vw" so the name-based finder can locate it (stargaze's name).
  seedClass(
    m,
    classPtr,
    [{ name: "queue", offset: dictFieldOffset, typeName: "Dictionary<EBoxType, List<BoxData>>" }],
    "vw",
  );

  // Instance header: write a contiguous 0x100-byte buffer at instancePtr so
  // the heap scanner's readBytes(instancePtr, 0x100) succeeds. The first 8
  // bytes hold classPtr (the IL2CPP header); the rest is zero-padded.
  // (FakeMemory.readBytes returns null when the stored buffer is smaller
  // than the requested size, so a bare writePtr(instancePtr, classPtr) — which
  // stores only 8 bytes — would fail the heap scan's 0x100-byte read.)
  const instanceHeader = Buffer.alloc(0x100, 0);
  instanceHeader.writeBigUInt64LE(classPtr, 0);
  m.writeBytes(instancePtr, instanceHeader);
  // Instance dict field (separate exact-address write for readPtr at +0x10).
  m.writePtr(instancePtr + BigInt(dictFieldOffset), dictPtr);

  // Dictionary layout (x64):
  //   +0x18 entries ptr
  //   +0x20 count (int32)
  // Each entry is 24 bytes: hash@0 (int32), key@8 (int32), value@16 (ptr).
  m.writePtr(dictPtr + 0x18n, entriesArr);
  const buckets: Array<{ key: number; items: number[] }> = [
    { key: 0, items: items.common },
    { key: 1, items: items.rare },
    { key: 2, items: items.act },
  ].filter((b) => b.items.length > 0);
  m.writeI32(dictPtr + 0x20n, buckets.length);

  // BoxData class + instances. We need the BoxData class to have a
  // `o_rewardItemId` field. Lay out each BoxData at a unique address.
  const boxDataClassPtr = 0x5_0000_0000n;
  const rewardOffset = 0x18;
  seedClass(m, boxDataClassPtr, [{ name: "o_rewardItemId", offset: rewardOffset }]);

  let entryIdx = 0;
  let boxDataAddr = 0x6_0000_0000n;
  for (const bucket of buckets) {
    const entryBase = entriesArr + 0x20n + BigInt(entryIdx * 24);
    m.writeI32(entryBase + 0x0n, bucket.key + 1); // hash (>0 = occupied)
    m.writeI32(entryBase + 0x8n, bucket.key); // key
    // Value: List<BoxData> ptr.
    const listPtr = 0x7_0000_0000n + BigInt(entryIdx * 0x1000);
    m.writePtr(entryBase + 0x10n, listPtr);
    // List<T> layout: +0x10 array ptr, +0x18 size.
    const arrPtr = listPtr + 0x100n;
    m.writePtr(listPtr + 0x10n, arrPtr);
    m.writeI32(listPtr + 0x18n, bucket.items.length);
    // Array layout: +0x20 first element.
    for (let i = 0; i < bucket.items.length; i++) {
      const boxDataPtr = boxDataAddr;
      boxDataAddr += 0x100n;
      m.writePtr(arrPtr + 0x20n + BigInt(i * 8), boxDataPtr);
      // BoxData header: *boxData = boxDataClassPtr.
      m.writePtr(boxDataPtr, boxDataClassPtr);
      // BoxData.o_rewardItemId = ObscuredInt(itemKey, crypto=42).
      m.writeBytes(boxDataPtr + BigInt(rewardOffset), encodeObscuredInt(bucket.items[i], 42));
    }
    entryIdx++;
  }

  return { classPtr, instancePtr, dictFieldOffset, rewardOffset };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("findBoxQueueClass", () => {
  it("matches a class by name (vw) when classNameLookup is provided", () => {
    const m = new FakeMemory();
    const classPtr = 0x1_0000_0000n;
    seedClass(m, classPtr, [{ name: "queue", offset: 0x10 }], "vw");
    const lookup = (ptr: bigint) => (ptr === classPtr ? "vw" : null);
    const found = findBoxQueueClass(m, [classPtr], lookup);
    expect(found).not.toBeNull();
    expect(found!.classPtr).toBe(classPtr);
    expect(found!.dictFieldOffset).toBe(0x10);
  });

  it("matches a namespaced class name (vb.vw) by short name", () => {
    const m = new FakeMemory();
    const classPtr = 0x1_0000_0000n;
    seedClass(m, classPtr, [{ name: "queue", offset: 0x10 }], "vb.vw");
    const lookup = (ptr: bigint) => (ptr === classPtr ? "vb.vw" : null);
    const found = findBoxQueueClass(m, [classPtr], lookup);
    expect(found).not.toBeNull();
    expect(found!.classPtr).toBe(classPtr);
  });

  it("falls back to structural probe when classNameLookup is unavailable", () => {
    const m = new FakeMemory();
    const classPtr = 0x1_0000_0000n;
    // Single field at a plausible offset — matches the structural heuristic.
    seedClass(m, classPtr, [{ name: "queue", offset: 0x10 }]);
    const found = findBoxQueueClass(m, [classPtr]);
    expect(found).not.toBeNull();
    expect(found!.classPtr).toBe(classPtr);
    expect(found!.dictFieldOffset).toBe(0x10);
  });

  it("returns null when no class has the matching name and structural probe fails", () => {
    const m = new FakeMemory();
    const classPtr = 0x2_0000_0000n;
    // Two fields — fails the "exactly 1 field" structural check.
    seedClass(m, classPtr, [
      { name: "a", offset: 0x8 },
      { name: "b", offset: 0x10 },
    ]);
    const lookup = () => null;
    expect(findBoxQueueClass(m, [classPtr], lookup)).toBeNull();
  });

  it("returns null for an empty class list", () => {
    expect(findBoxQueueClass(new FakeMemory(), [])).toBeNull();
  });
});

describe("resolveBoxDataOffsets", () => {
  it("resolves rewardOffset from o_rewardItemId field name", () => {
    const m = new FakeMemory();
    const classPtr = 0x3_0000_0000n;
    seedClass(m, classPtr, [
      { name: "other", offset: 0x8 },
      { name: "o_rewardItemId", offset: 0x18 },
      { name: "gradeSO", offset: 0x20 },
    ]);
    const r = resolveBoxDataOffsets(m, classPtr);
    expect(r.rewardOffset).toBe(0x18);
    expect(r.gradePtrOffset).toBe(0x20);
  });

  it("returns 0 offsets when the class has no matching field names", () => {
    const m = new FakeMemory();
    const classPtr = 0x4_0000_0000n;
    seedClass(m, classPtr, [{ name: "unrelated", offset: 0x8 }]);
    const r = resolveBoxDataOffsets(m, classPtr);
    expect(r.rewardOffset).toBe(0);
  });
});

describe("validateBoxQueueInstance", () => {
  it("returns the dict pointer for a well-formed instance", () => {
    const m = new FakeMemory();
    const { classPtr, instancePtr, dictFieldOffset } = seedBoxQueue(m, {
      common: [100, 101],
      rare: [],
      act: [],
    });
    const dict = validateBoxQueueInstance(m, instancePtr, classPtr, dictFieldOffset);
    expect(dict).not.toBeNull();
  });

  it("returns null when the header doesn't match the class", () => {
    const m = new FakeMemory();
    const { instancePtr, dictFieldOffset } = seedBoxQueue(m, {
      common: [100],
      rare: [],
      act: [],
    });
    // Wrong class pointer.
    expect(validateBoxQueueInstance(m, instancePtr, 0xdeadbeefn, dictFieldOffset)).toBeNull();
  });

  it("returns null for an empty dict (all buckets size 0)", () => {
    const m = new FakeMemory();
    // Build a class + instance with an empty dict.
    const classPtr = 0x1_0000_0000n;
    const instancePtr = 0x2_0000_0000n;
    const dictPtr = 0x3_0000_0000n;
    const entriesArr = 0x4_0000_0000n;
    const dictFieldOffset = 0x10;
    seedClass(m, classPtr, [
      { name: "queue", offset: dictFieldOffset, typeName: "Dictionary<EBoxType, List<BoxData>>" },
    ]);
    m.writePtr(instancePtr, classPtr);
    m.writePtr(instancePtr + BigInt(dictFieldOffset), dictPtr);
    m.writePtr(dictPtr + 0x18n, entriesArr);
    m.writeI32(dictPtr + 0x20n, 1); // 1 entry
    // Entry: key=0, hash=1, list with size 0.
    const entryBase = entriesArr + 0x20n;
    m.writeI32(entryBase + 0x0n, 1);
    m.writeI32(entryBase + 0x8n, 0);
    const listPtr = 0x7_0000_0000n;
    m.writePtr(entryBase + 0x10n, listPtr);
    m.writePtr(listPtr + 0x10n, listPtr + 0x100n);
    m.writeI32(listPtr + 0x18n, 0); // size 0
    expect(validateBoxQueueInstance(m, instancePtr, classPtr, dictFieldOffset)).toBeNull();
  });
});

describe("scanBoxQueue (end-to-end with FakeMemory)", () => {
  it("locates the class, scans the heap, and reads all 3 buckets", () => {
    const m = new FakeMemory();
    const { classPtr, instancePtr } = seedBoxQueue(m, {
      common: [100, 101, 102],
      rare: [200],
      act: [300, 301],
    });
    const pin = makeBoxQueuePinState();
    // Region must be >= MIN_REGION_SIZE_TO_SCAN (1MB) to pass the size filter.
    // FakeMemory.readBytes now returns non-null for ranges that contain at
    // least one written slot, so the instance data written by seedBoxQueue
    // is sufficient for the scan to succeed.
    const regions: HeapRegion[] = [{ base: instancePtr, size: 1 << 20 }];
    const result = scanBoxQueue(m, [classPtr], regions, pin);
    expect(result.status).toBe("ok");
    expect(result.queue).not.toBeNull();
    const bucketsByType = new Map(result.queue!.buckets.map((b) => [b.eboxType, b.items]));
    expect(bucketsByType.get(0)?.map((i) => i.itemKey)).toEqual([100, 101, 102]);
    expect(bucketsByType.get(1)?.map((i) => i.itemKey)).toEqual([200]);
    expect(bucketsByType.get(2)?.map((i) => i.itemKey)).toEqual([300, 301]);
  });

  it("returns class_not_found when no class matches name or structure", () => {
    const m = new FakeMemory();
    const classPtr = 0x5_0000_0000n;
    // Two fields — fails the "exactly 1 field" structural check, and no
    // classNameLookup is provided so name matching is skipped.
    seedClass(m, classPtr, [
      { name: "a", offset: 0x8 },
      { name: "b", offset: 0x10 },
    ]);
    const pin = makeBoxQueuePinState();
    const result = scanBoxQueue(m, [classPtr], [], pin);
    expect(result.status).toBe("class_not_found");
    expect(result.queue).toBeNull();
  });

  it("returns scan_failed when the instance can't be located in the heap", () => {
    const m = new FakeMemory();
    const { classPtr, instancePtr } = seedBoxQueue(m, {
      common: [100],
      rare: [],
      act: [],
    });
    const pin = makeBoxQueuePinState();
    // Heap region that doesn't contain the instance.
    const regions: HeapRegion[] = [{ base: 0x100n, size: 0x100 }];
    void instancePtr;
    const result = scanBoxQueue(m, [classPtr], regions, pin);
    expect(result.status).toBe("scan_failed");
  });

  it("caches the resolved class + instance across ticks (re-validate fast path)", () => {
    const m = new FakeMemory();
    const { classPtr, instancePtr } = seedBoxQueue(m, {
      common: [100],
      rare: [],
      act: [],
    });
    const pin = makeBoxQueuePinState();
    // Use multiple small regions, each covering one allocated address range.
    // This is more realistic (Windows heap has many small regions) and avoids
    // the O(n) slot-checking overhead of a single huge region in FakeMemory.
    const regions: HeapRegion[] = [
      { base: 0x1_0000_0000n, size: 1 << 20 }, // class + fields
      { base: 0x2_0000_0000n, size: 1 << 20 }, // instance + dict field
      { base: 0x3_0000_0000n, size: 1 << 20 }, // dict
      { base: 0x4_0000_0000n, size: 1 << 20 }, // entries array
      { base: 0x5_0000_0000n, size: 1 << 20 }, // boxData class
      { base: 0x6_0000_0000n, size: 1 << 20 }, // boxData instances
      { base: 0x7_0000_0000n, size: 1 << 20 }, // lists
    ];
    // First tick: full scan.
    const r1 = scanBoxQueue(m, [classPtr], regions, pin);
    expect(r1.status).toBe("ok");
    expect(pin.classPtr).toBe(classPtr);
    expect(pin.instancePtr).toBe(instancePtr);
    // Second tick: should reuse the cached pin (no rescan).
    const r2 = scanBoxQueue(m, [], [], pin); // empty class list + empty regions
    expect(r2.status).toBe("ok");
    expect(r2.queue!.buckets[0]!.items[0]!.itemKey).toBe(100);
  });
});

describe("toBoxQueueItems", () => {
  it("groups raw buckets into common/rare/act arrays, head-first", () => {
    const raw: RawBoxQueue = {
      buckets: [
        { eboxType: 0, items: [{ itemKey: 1 }, { itemKey: 2 }] },
        { eboxType: 2, items: [{ itemKey: 9 }] },
        { eboxType: 1, items: [{ itemKey: 5 }] },
      ],
    };
    const out = toBoxQueueItems(raw);
    expect(out.common.map((i) => i.itemKey)).toEqual([1, 2]);
    expect(out.rare.map((i) => i.itemKey)).toEqual([5]);
    expect(out.act.map((i) => i.itemKey)).toEqual([9]);
  });

  it("drops buckets with unknown eboxType (>2)", () => {
    const raw: RawBoxQueue = {
      buckets: [
        { eboxType: 0, items: [{ itemKey: 1 }] },
        { eboxType: 99, items: [{ itemKey: 999 }] },
      ],
    };
    const out = toBoxQueueItems(raw);
    expect(out.common.map((i) => i.itemKey)).toEqual([1]);
    expect(out.rare).toEqual([]);
    expect(out.act).toEqual([]);
  });
});

// Unused import suppressor — MemoryReader is referenced via FakeMemory only.
void (undefined as unknown as MemoryReader);
void (undefined as unknown as BoxQueuePinState);
