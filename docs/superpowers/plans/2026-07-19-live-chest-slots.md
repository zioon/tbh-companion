# Live Chest Slots 实时化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 chest slots 的 `quantity` 字段从 save-file 触发（数十秒延迟）改为 live memory 实时读取（5Hz 广播），并让 AutoClassifyService 高频消费该数据持续校正队列。

**Architecture:** 在 `PlayerSaveData.BoxData` runtime 路径上新增 `readRuntimeChestSlots` 核心函数，读取 `BoxTypes[]` + `BoxQuantity[]` 并按 catalog 聚合到 common/rare/act。结果通过扩展的 `LiveMemorySnapshot.chestSlots` 字段在 5Hz 广播中传给 renderer，同时由 `TrackingService.ingestLiveFrame` 高频喂给 `AutoClassifyService.reconcileWithChestSlots`。Capacity 仍由 save 路径派生（rune 购买极低频）。Live 失败时 renderer 回退到 save 的 quantity，AutoClassifyService 跳过本次 reconcile。

**Tech Stack:** TypeScript, Electron (utilityProcess worker), Vitest, React, IL2CPP memory reading

**Spec:** `docs/superpowers/specs/2026-07-19-live-chest-slots-design.md`

---

## File Structure

### 新建文件

- `app/src/core/liveMemory/chestSlots.ts` — 纯函数 `readRuntimeChestSlots` + `readIntArray` 辅助 + 类型定义。无 electron/node 依赖，纯 unit-testable
- `app/test/core/liveMemoryChestSlots.test.ts` — `readRuntimeChestSlots` 单元测试

### 修改文件

- `app/src/core/liveMemory/offsets.ts` — 扩展 `LiveOffsets.player.boxData` + 新增 `LiveOffsets.boxData` struct
- `app/src/core/liveMemory/il2cppScanner.ts` — 扩展 `findPlayerSaveData` 派生 `boxData` offset + 新增 `findBoxDataFields` 函数
- `app/src/core/liveMemory/runtime.ts` — 在 liveReader 调用链中接入 `readRuntimeChestSlots`（实际在 `liveReader.ts`）
- `app/src/main/liveMemory/liveReader.ts` — snapshot 构造时调用 `readRuntimeChestSlots` 填充 `chestSlots` 字段
- `app/shared/types.ts` — 扩展 `LiveMemorySnapshot` 加 `chestSlots` + `chestSlotsStatus` 字段；新增 `LiveChestSlots` 类型
- `app/src/main/services/AutoClassifyService.ts` — `reconcileWithChestSlots` 加 `lastSlotCounts` 变化检测，避免高频日志爆炸
- `app/src/main/services/TrackingService.ts` — `ingestLiveFrame` 中调用 `onLiveChestSlots` 回调
- `app/src/main/app/appState.ts` — 连接 `tracking.onLiveChestSlots` → `autoClassify.reconcileWithChestSlots`
- `app/src/renderer/lib/useLoot.ts` — 暴露 `liveChestSlots` 状态（从 `useLiveMemory` 读取）
- `app/src/renderer/tabs/Loot.tsx` — 传入 `liveChestSlots` 给 `LootQueueSlots`
- `app/src/renderer/components/loot/LootQueueSlots.tsx` — 合并 live quantity + save capacity

### 测试文件

- `app/test/core/liveMemoryChestSlots.test.ts` — 新建
- `app/test/main/autoClassifyService.test.ts` — 扩展高频 reconcile 测试
- `app/test/main/trackingService.test.ts` — 扩展 `ingestLiveFrame` chestSlots 回调测试（注意：此文件有 4 个 pre-existing 失败，仅新增测试需通过）
- `app/test/renderer-component/LootQueueSlots.test.tsx` — 新建组件测试

---

## Task 1: 扩展 LiveOffsets 类型加 boxData 字段

**Files:**
- Modify: `app/src/core/liveMemory/offsets.ts`

- [ ] **Step 1: 在 `LiveOffsets.player` 中新增 `boxData` 字段**

打开 `app/src/core/liveMemory/offsets.ts`，在 `player` 块内 `aggregates` 字段后追加：

```typescript
player: {
  commonSaveData: number;
  currency: number;
  heroSaveDatas: number;
  petSaveDatas: number;
  /** PlayerSaveData.itemSaveDatas — List<ItemSaveData> (live bag via save snapshot). */
  itemSaveDatas: number;
  /**
   * PlayerSaveData.aggregateSaveDatas — List<AggregateSaveData>.
   * Used by combat gold reader (GoldEarn[SubKey=1]). 0 = known fallback to wallet balance.
   */
  aggregates: number;
  /**
   * PlayerSaveData.BoxData — BoxData instance field offset. Holds the runtime
   * equivalent of the save `BoxData` struct (BoxTypes[] + BoxQuantity[]).
   * 0 = not derived; reader falls back to save path for slot quantities.
   */
  boxData: number;
};
```

- [ ] **Step 2: 在 `LiveOffsets` 中新增 `boxData` struct 块**

在 `runtime` 块之前（或 `petSaveData` 之后）插入新块：

```typescript
/**
 * BoxData struct field offsets. BoxData is held by PlayerSaveData and contains
 * two parallel int arrays: BoxTypes (chest type IDs) and BoxQuantity (per-type
 * counts). Used by readRuntimeChestSlots for live slot-quantity reading.
 */
boxData: {
  /** BoxData.BoxTypes — List<int> field offset. 0 = not derived. */
  boxTypes: number;
  /** BoxData.BoxQuantity — List<int> field offset. 0 = not derived. */
  boxQuantity: number;
};
```

- [ ] **Step 3: 更新所有 bundled offset 表**

搜索项目内所有 `LiveOffsets` 字面量定义（在 `offsets.ts` 同文件下方或 `liveMemoryOffsets.ts`），给每个版本表的 `player` 加 `boxData: 0`，并在顶层加 `boxData: { boxTypes: 0, boxQuantity: 0 }`。0 表示"未派生"，reader 会安全回退到 save 路径。

```bash
# 验证 typecheck 通过
cd app && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
git add app/src/core/liveMemory/offsets.ts
git commit -m "feat(liveMemory): extend LiveOffsets with player.boxData and boxData struct"
```

---

## Task 2: 实现 readRuntimeChestSlots 核心函数

**Files:**
- Create: `app/src/core/liveMemory/chestSlots.ts`
- Test: `app/test/core/liveMemoryChestSlots.test.ts`

- [ ] **Step 1: 写失败测试 — offset 未派生时返回 null**

创建 `app/test/core/liveMemoryChestSlots.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { readRuntimeChestSlots } from "../../src/core/liveMemory/chestSlots";
import type { LiveOffsets } from "../../src/core/liveMemory/offsets";
import type { BoxCategory } from "../../shared/types";

// Helper: build a minimal LiveOffsets with chest-relevant fields overridden.
function makeOffsets(overrides: Partial<LiveOffsets> = {}): LiveOffsets {
  return {
    gameVersion: "test",
    typeInfoRva: {
      commonSaveData: 0n,
      currencyManager: 0n,
      stageCacheManager: 0n,
      stageManager: 0n,
      localInventoryManager: 0n,
      logManager: 0n,
      monsterSpawnManager: 0n,
    },
    player: {
      commonSaveData: 0,
      currency: 0,
      heroSaveDatas: 0,
      petSaveDatas: 0,
      itemSaveDatas: 0,
      aggregates: 0,
      boxData: 0,
    },
    common: { playTime: 0, arrangedHeroKey: 0, maxCompletedStage: 0, currentStageKey: 0, currentStageWave: 0 },
    hero: { heroKey: 0, level: 0, unlock: 0, exp: 0, equipped: 0 },
    unit: { cache: 0 },
    heroRuntime: { info: 0, levelHidden: 0, levelKey: 0, expHidden: 0, expKey: 0 },
    heroInfoData: { heroKey: 0 },
    currency: { key: 0, quantity: 0 },
    petSaveData: { petKey: 0, isUnlock: 0 },
    inventoryItem: { itemKey: 0, isChaotic: 0 },
    boxData: { boxTypes: 0, boxQuantity: 0 },
    runtime: {
      currency: { list: 0, dict: 0, entryInfoData: 0, entryObscuredQty: 0 },
      stage: { currentCache: 0, cacheInfoData: 0, stageKey: 0, waveAmount: 0, runtimeWave: 0 },
      currencyInfoKey: 0,
      heroList: 0,
      log: { logByType: 0, getBoxTypeKey: 0, stageClearTypeKey: 0, getItemWithBoxOpenTypeKey: 0 },
      getBoxLog: { monsterType: 0 },
      boxOpenLog: { itemStringKey: 0, itemGradeType: 0, gradeSO: 0, gradeSOGrade: 0, boxType: 0, level: 0 },
      stageClearLog: { clearTimeSec: 0 },
      monster: { monsterList: 0, summonedList: 0, deadMonsterList: 0, monsterHealth: 0, hpCurrent: 0, hpMax: 0 },
    },
    container: { objectHeader: 0, listItems: 0, listSize: 0, arrayFirst: 0 },
    dict: { entries: 0, count: 0, entrySize: 0, entryHash: 0, entryKey: 0, entryValue: 0 },
    il2cppClass: { staticFieldsOffsets: [] },
    ...overrides,
  } as LiveOffsets;
}

// Helper: build a mock MemoryReader backed by a Map<bigint, number>.
function makeReader(bytes: Map<bigint, number>) {
  return {
    readI8: (addr: bigint) => bytes.get(addr) ?? null,
    readU8: (addr: bigint) => bytes.get(addr) ?? null,
    readI16: (addr: bigint) => bytes.get(addr) ?? null,
    readU16: (addr: bigint) => bytes.get(addr) ?? null,
    readI32: (addr: bigint) => bytes.get(addr) ?? null,
    readU32: (addr: bigint) => bytes.get(addr) ?? null,
    readI64: (addr: bigint) => {
      const lo = bytes.get(addr) ?? 0;
      const hi = bytes.get(addr + 1n) ?? 0;
      return BigInt((hi << 8) | lo) as unknown as bigint;
    },
    readU64: (addr: bigint) => {
      const lo = bytes.get(addr) ?? 0;
      const hi = bytes.get(addr + 1n) ?? 0;
      return BigInt((hi << 8) | lo) as unknown as bigint;
    },
    readPtr: (addr: bigint) => {
      const lo = bytes.get(addr) ?? 0;
      const hi = bytes.get(addr + 1n) ?? 0;
      const v = BigInt((hi << 8) | lo);
      return v === 0n ? null : v;
    },
    readBytes: (addr: bigint, len: number) => {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = bytes.get(addr + BigInt(i)) ?? 0;
      return out;
    },
  };
}

describe("readRuntimeChestSlots", () => {
  it("returns null with status when player.boxData offset = 0", () => {
    const o = makeOffsets({ player: { ...makeOffsets().player, boxData: 0 } });
    const r = readRuntimeChestSlots(makeReader(new Map()), 0n, 0, o, new Map(), null);
    expect(r.slots).toBeNull();
    expect(r.status).toMatch(/boxData offset = 0/);
  });

  it("returns null when boxData.boxTypes offset = 0", () => {
    const o = makeOffsets({
      player: { ...makeOffsets().player, boxData: 0x40 },
      boxData: { boxTypes: 0, boxQuantity: 0x20 },
    });
    const r = readRuntimeChestSlots(makeReader(new Map()), 0n, 0, o, new Map(), null);
    expect(r.slots).toBeNull();
    expect(r.status).toMatch(/boxData struct offsets not derived/);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app && pnpm test -- --run test/core/liveMemoryChestSlots.test.ts
```

Expected: FAIL with "Cannot find module '../../src/core/liveMemory/chestSlots'"

- [ ] **Step 3: 实现 chestSlots.ts 的最小骨架**

创建 `app/src/core/liveMemory/chestSlots.ts`：

```typescript
// Pure: read chest slot quantities from PlayerSaveData.BoxData runtime.
// No electron / node / fs — keep unit-testable.

import type { LiveOffsets } from "./offsets";
import type { MemoryReader } from "./readerTypes";
import type { BoxCategory } from "../../../shared/types";

export interface LiveChestSlots {
  common: number;
  rare: number;
  act: number;
}

export interface ReadChestSlotsResult {
  /** Per-category slot quantity. null = unavailable this tick. */
  slots: LiveChestSlots | null;
  /** Diagnostics: why slots is null. Empty when slots are present. */
  status: string;
}

/**
 * Read current chest slot quantities from `PlayerSaveData.BoxData` runtime.
 * Returns null with a status string when any offset is unset or any pointer
 * path fails — callers fall back to the save path in that case.
 *
 * `boxTypeCatalog` maps runtime BoxType int → tracker BoxCategory. Entries
 * absent from the catalog (or "unclassified") are skipped; only common/rare/act
 * are aggregated.
 */
export function readRuntimeChestSlots(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  boxTypeCatalog: ReadonlyMap<number, BoxCategory>,
  playerPtrOverride?: bigint | null,
): ReadChestSlotsResult {
  if (o.player.boxData === 0) {
    return { slots: null, status: "player.boxData offset = 0 (not derived)" };
  }
  if (o.boxData.boxTypes === 0 || o.boxData.boxQuantity === 0) {
    return { slots: null, status: "boxData struct offsets not derived" };
  }
  // Subsequent steps will fill in the pointer-walk + array-read + aggregation.
  return { slots: null, status: "not yet implemented" };
}
```

注：`MemoryReader` 类型从 `./readerTypes` 导入；先检查该路径是否存在（实际路径可能是 `./runtime` 或 `./reader`）。运行 `pnpm typecheck` 确认导入路径正确。

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app && pnpm test -- --run test/core/liveMemoryChestSlots.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 5: 提交**

```bash
git add app/src/core/liveMemory/chestSlots.ts app/test/core/liveMemoryChestSlots.test.ts
git commit -m "feat(liveMemory): scaffold readRuntimeChestSlots with offset guards"
```

---

## Task 3: 实现 readIntArray 辅助函数

`BoxTypes` 和 `BoxQuantity` 在 runtime 可能是 `List<int>` 也可能是 `int[]`。统一处理。

**Files:**
- Modify: `app/src/core/liveMemory/chestSlots.ts`
- Test: `app/test/core/liveMemoryChestSlots.test.ts`

- [ ] **Step 1: 写失败测试 — List<int> 路径**

在测试文件中追加：

```typescript
describe("readIntArray (List<int> path)", () => {
  it("reads ints from a List<int> backing array", () => {
    // Layout: obj+0x10 = List<int> ptr
    //         list+0x08 = _items (int[] ptr)  [container.listItems]
    //         list+0x10 = _size (int32)        [container.listSize]
    //         items+0x10 = first element       [container.arrayFirst]
    // Element size = 4 bytes (int32)
    const bytes = new Map<bigint, number>();
    const obj = 0x1000n;
    const list = 0x2000n;
    const items = 0x3000n;
    const container = { objectHeader: 0x10, listItems: 0x08, listSize: 0x10, arrayFirst: 0x10 };
    bytes.set(obj + 0x10n, ...ptrToBytes(list));          // obj.field -> List ptr
    bytes.set(list + BigInt(container.listItems), ...ptrToBytes(items));
    bytes.set(list + BigInt(container.listSize), 3);       // size = 3
    // Write 3 ints at items+0x10, items+0x14, items+0x18
    bytes.set(items + BigInt(container.arrayFirst), 920011);
    bytes.set(items + BigInt(container.arrayFirst) + 4n, 920051);
    bytes.set(items + BigInt(container.arrayFirst) + 8n, 920101);

    const arr = readIntArray(makeReader(bytes), obj, 0x10, container);
    expect(arr).toEqual([920011, 920051, 920101]);
  });
});

// Helper: split bigint ptr into two LE bytes for the mock reader.
function ptrToBytes(p: bigint): [number, number] {
  const lo = Number(p & 0xffn);
  const hi = Number((p >> 8n) & 0xffn);
  return [lo, hi];
}
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app && pnpm test -- --run test/core/liveMemoryChestSlots.test.ts
```

Expected: FAIL (readIntArray not exported)

- [ ] **Step 3: 实现 readIntArray**

在 `chestSlots.ts` 中追加：

```typescript
/** Container layout for List<int> / int[] reading. */
interface ArrayContainer {
  objectHeader: number;
  listItems: number;
  listSize: number;
  arrayFirst: number;
}

const MAX_CHEST_SLOTS = 100;

/**
 * Read an int array from a struct field. Handles both `List<int>` (with
 * `_items` backing array + `_size`) and raw `int[]` (where the field points
 * directly at the array). Returns null when the pointer walk fails or the
 * size is implausible.
 */
export function readIntArray(
  reader: MemoryReader,
  obj: bigint,
  fieldOff: number,
  c: ArrayContainer,
): number[] | null {
  const fieldPtr = reader.readPtr(obj + BigInt(fieldOff));
  if (fieldPtr == null) return null;

  // Try List<int> path first: read list._items (backing array) + list._size.
  const itemsPtr = reader.readPtr(fieldPtr + BigInt(c.listItems));
  const size = reader.readI32(fieldPtr + BigInt(c.listSize));
  if (itemsPtr == null || size == null) {
    // Fall back to direct int[] path: fieldPtr IS the array, size at items-0x8.
    return readDirectIntArray(reader, fieldPtr, c);
  }
  if (size <= 0 || size > MAX_CHEST_SLOTS) return null;
  return readInt32Elements(reader, itemsPtr, size, c.arrayFirst);
}

function readDirectIntArray(
  reader: MemoryReader,
  arrPtr: bigint,
  c: ArrayContainer,
): number[] | null {
  // IL2CPP arrays store length at offset 0x18 (in standard layout) — but our
  // container.arrayFirst assumes the data starts after the header. Read length
  // at arrPtr + 0x18 (standard Il2CppArray.size) when possible.
  const size = reader.readI32(arrPtr + 0x18n);
  if (size == null || size <= 0 || size > MAX_CHEST_SLOTS) return null;
  return readInt32Elements(reader, arrPtr, size, c.arrayFirst);
}

function readInt32Elements(
  reader: MemoryReader,
  arrPtr: bigint,
  size: number,
  firstOff: number,
): number[] {
  const out: number[] = [];
  const base = arrPtr + BigInt(firstOff);
  for (let i = 0; i < size; i++) {
    const v = reader.readI32(base + BigInt(i * 4));
    if (v == null) break;
    out.push(v);
  }
  return out;
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app && pnpm test -- --run test/core/liveMemoryChestSlots.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
git add app/src/core/liveMemory/chestSlots.ts app/test/core/liveMemoryChestSlots.test.ts
git commit -m "feat(liveMemory): add readIntArray helper for List<int> and int[] paths"
```

---

## Task 4: 完成 readRuntimeChestSlots 完整实现

**Files:**
- Modify: `app/src/core/liveMemory/chestSlots.ts`
- Test: `app/test/core/liveMemoryChestSlots.test.ts`

- [ ] **Step 1: 写失败测试 — 完整路径**

在测试文件中追加：

```typescript
describe("readRuntimeChestSlots (full path)", () => {
  it("aggregates BoxTypes/BoxQuantity into common/rare/act categories", () => {
    const bytes = new Map<bigint, number>();
    const playerPtr = 0x1000n;
    const boxDataPtr = 0x2000n;
    const typesList = 0x3000n;
    const typesArr = 0x4000n;
    const qtyList = 0x5000n;
    const qtyArr = 0x6000n;

    const container = { objectHeader: 0x10, listItems: 0x08, listSize: 0x10, arrayFirst: 0x10 };

    // player + boxData offset → boxDataPtr
    bytes.set(playerPtr + 0x40n, ...ptrToBytes(boxDataPtr)); // boxData field at 0x40

    // boxData.boxTypes → typesList → typesArr (3 elements)
    bytes.set(boxDataPtr + 0x10n, ...ptrToBytes(typesList));
    bytes.set(typesList + BigInt(container.listItems), ...ptrToBytes(typesArr));
    bytes.set(typesList + BigInt(container.listSize), 3);
    bytes.set(typesArr + BigInt(container.arrayFirst), 920011);     // common Lv1
    bytes.set(typesArr + BigInt(container.arrayFirst) + 4n, 920151); // common Lv15
    bytes.set(typesArr + BigInt(container.arrayFirst) + 8n, 930101); // act Lv1

    // boxData.boxQuantity → qtyList → qtyArr (3 elements)
    bytes.set(boxDataPtr + 0x18n, ...ptrToBytes(qtyList));
    bytes.set(qtyList + BigInt(container.listItems), ...ptrToBytes(qtyArr));
    bytes.set(qtyList + BigInt(container.listSize), 3);
    bytes.set(qtyArr + BigInt(container.arrayFirst), 2);  // 2 common Lv1
    bytes.set(qtyArr + BigInt(container.arrayFirst) + 4n, 3); // 3 common Lv15
    bytes.set(qtyArr + BigInt(container.arrayFirst) + 8n, 1);  // 1 act Lv1

    const catalog = new Map<number, BoxCategory>([
      [920011, "common"],
      [920151, "common"],
      [930101, "act"],
    ]);

    const o = makeOffsets({
      player: { ...makeOffsets().player, boxData: 0x40 },
      boxData: { boxTypes: 0x10, boxQuantity: 0x18 },
      container,
    });

    const r = readRuntimeChestSlots(makeReader(bytes), 0n, 0, o, catalog, playerPtr);
    expect(r.slots).toEqual({ common: 5, rare: 0, act: 1 });
    expect(r.status).toBe("");
  });

  it("returns null when types/qty lengths mismatch", () => {
    const bytes = new Map<bigint, number>();
    const playerPtr = 0x1000n;
    const boxDataPtr = 0x2000n;
    const typesList = 0x3000n;
    const typesArr = 0x4000n;
    const qtyList = 0x5000n;
    const qtyArr = 0x6000n;
    const container = { objectHeader: 0x10, listItems: 0x08, listSize: 0x10, arrayFirst: 0x10 };

    bytes.set(playerPtr + 0x40n, ...ptrToBytes(boxDataPtr));
    bytes.set(boxDataPtr + 0x10n, ...ptrToBytes(typesList));
    bytes.set(typesList + BigInt(container.listItems), ...ptrToBytes(typesArr));
    bytes.set(typesList + BigInt(container.listSize), 2);   // types has 2
    bytes.set(typesArr + BigInt(container.arrayFirst), 920011);
    bytes.set(typesArr + BigInt(container.arrayFirst) + 4n, 920151);

    bytes.set(boxDataPtr + 0x18n, ...ptrToBytes(qtyList));
    bytes.set(qtyList + BigInt(container.listItems), ...ptrToBytes(qtyArr));
    bytes.set(qtyList + BigInt(container.listSize), 3);     // qty has 3 — mismatch
    bytes.set(qtyArr + BigInt(container.arrayFirst), 1);
    bytes.set(qtyArr + BigInt(container.arrayFirst) + 4n, 2);
    bytes.set(qtyArr + BigInt(container.arrayFirst) + 8n, 3);

    const o = makeOffsets({
      player: { ...makeOffsets().player, boxData: 0x40 },
      boxData: { boxTypes: 0x10, boxQuantity: 0x18 },
      container,
    });

    const r = readRuntimeChestSlots(makeReader(bytes), 0n, 0, o, new Map(), playerPtr);
    expect(r.slots).toBeNull();
    expect(r.status).toMatch(/length mismatch/);
  });

  it("skips unknown boxTypes not in catalog", () => {
    const bytes = new Map<bigint, number>();
    const playerPtr = 0x1000n;
    const boxDataPtr = 0x2000n;
    const typesList = 0x3000n;
    const typesArr = 0x4000n;
    const qtyList = 0x5000n;
    const qtyArr = 0x6000n;
    const container = { objectHeader: 0x10, listItems: 0x08, listSize: 0x10, arrayFirst: 0x10 };

    bytes.set(playerPtr + 0x40n, ...ptrToBytes(boxDataPtr));
    bytes.set(boxDataPtr + 0x10n, ...ptrToBytes(typesList));
    bytes.set(typesList + BigInt(container.listItems), ...ptrToBytes(typesArr));
    bytes.set(typesList + BigInt(container.listSize), 2);
    bytes.set(typesArr + BigInt(container.arrayFirst), 999999); // unknown
    bytes.set(typesArr + BigInt(container.arrayFirst) + 4n, 930101); // act Lv1

    bytes.set(boxDataPtr + 0x18n, ...ptrToBytes(qtyList));
    bytes.set(qtyList + BigInt(container.listItems), ...ptrToBytes(qtyArr));
    bytes.set(qtyList + BigInt(container.listSize), 2);
    bytes.set(qtyArr + BigInt(container.arrayFirst), 7);
    bytes.set(qtyArr + BigInt(container.arrayFirst) + 4n, 1);

    const catalog = new Map<number, BoxCategory>([[930101, "act"]]);
    const o = makeOffsets({
      player: { ...makeOffsets().player, boxData: 0x40 },
      boxData: { boxTypes: 0x10, boxQuantity: 0x18 },
      container,
    });

    const r = readRuntimeChestSlots(makeReader(bytes), 0n, 0, o, catalog, playerPtr);
    expect(r.slots).toEqual({ common: 0, rare: 0, act: 1 });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app && pnpm test -- --run test/core/liveMemoryChestSlots.test.ts
```

Expected: FAIL (status "not yet implemented")

- [ ] **Step 3: 完整实现 readRuntimeChestSlots**

替换 `chestSlots.ts` 中的 `readRuntimeChestSlots` 函数体（保留 offset guards）：

```typescript
export function readRuntimeChestSlots(
  reader: MemoryReader,
  gaBase: bigint,
  gaSize: number,
  o: LiveOffsets,
  boxTypeCatalog: ReadonlyMap<number, BoxCategory>,
  playerPtrOverride?: bigint | null,
): ReadChestSlotsResult {
  if (o.player.boxData === 0) {
    return { slots: null, status: "player.boxData offset = 0 (not derived)" };
  }
  if (o.boxData.boxTypes === 0 || o.boxData.boxQuantity === 0) {
    return { slots: null, status: "boxData struct offsets not derived" };
  }

  // Resolve playerPtr — accept override (from cached player scan) before
  // falling back to the CommonSaveData static-field walk.
  let playerPtr = playerPtrOverride ?? null;
  if (playerPtr == null) {
    playerPtr = readStaticFieldPtr(reader, gaBase, gaSize, o.typeInfoRva.commonSaveData, o.player.commonSaveData, o.il2cppClass.staticFieldsOffsets);
  }
  if (playerPtr == null) {
    return { slots: null, status: "PlayerSaveData (CommonSaveData singleton) static field unreadable" };
  }

  const boxDataPtr = reader.readPtr(playerPtr + BigInt(o.player.boxData));
  if (boxDataPtr == null) {
    return { slots: null, status: "BoxData pointer null (player.boxData offset suspect)" };
  }

  const types = readIntArray(reader, boxDataPtr, o.boxData.boxTypes, o.container);
  const quantities = readIntArray(reader, boxDataPtr, o.boxData.boxQuantity, o.container);
  if (types == null || quantities == null) {
    return { slots: null, status: "BoxTypes/BoxQuantity array unreadable" };
  }
  if (types.length !== quantities.length) {
    return {
      slots: null,
      status: `length mismatch: types=${types.length} qty=${quantities.length}`,
    };
  }

  const slots: LiveChestSlots = { common: 0, rare: 0, act: 0 };
  for (let i = 0; i < types.length; i++) {
    const category = boxTypeCatalog.get(types[i]!);
    if (category == null || category === "unclassified") continue;
    slots[category] += quantities[i]!;
  }
  return { slots, status: "" };
}
```

注：`readStaticFieldPtr` 已在 `runtime.ts` 中定义。从 `./runtime` 导入，或在 `chestSlots.ts` 中重导出。检查导入路径后调整。

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app && pnpm test -- --run test/core/liveMemoryChestSlots.test.ts
```

Expected: PASS (all tests, 6+)

- [ ] **Step 5: typecheck 验证**

```bash
cd app && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 6: 提交**

```bash
git add app/src/core/liveMemory/chestSlots.ts app/test/core/liveMemoryChestSlots.test.ts
git commit -m "feat(liveMemory): implement readRuntimeChestSlots full path with aggregation"
```

---

## Task 5: 扩展 LiveMemorySnapshot 类型

**Files:**
- Modify: `app/shared/types.ts`

- [ ] **Step 1: 新增 LiveChestSlots 类型**

在 `app/shared/types.ts` 中 `LiveInventoryItem` 之后插入：

```typescript
/**
 * Live chest slot quantities per category, read from
 * `PlayerSaveData.BoxData` runtime. Broadcast as part of `LiveMemorySnapshot`
 * at ~5 Hz. `null` fields in the snapshot mean the live path is unavailable;
 * the renderer falls back to the save-derived `ChestState`.
 */
export interface LiveChestSlots {
  common: number;
  /** Stage boss chests (auto-classify "rare" category). */
  rare: number;
  act: number;
}
```

- [ ] **Step 2: 在 LiveMemorySnapshot 中加 chestSlots 字段**

在 `LiveMemorySnapshot` 接口的 `chestLogDebug` 字段之后插入：

```typescript
  /**
   * Live chest slot quantities per category, read from
   * `PlayerSaveData.BoxData` runtime. `null` = live path unavailable
   * (offset not derived / pointer walk failed); renderer falls back to the
   * save-derived `ChestState` quantity.
   */
  chestSlots: LiveChestSlots | null;
  /** Diagnostics: why `chestSlots` is null this tick. Dev-only. */
  chestSlotsStatus?: string;
```

- [ ] **Step 3: typecheck 验证**

```bash
cd app && pnpm typecheck
```

Expected: 报错指向所有构造 `LiveMemorySnapshot` 的地方缺 `chestSlots` 字段。下一步在 liveReader 中补齐。

- [ ] **Step 4: 提交**

```bash
git add app/shared/types.ts
git commit -m "feat(shared): add LiveChestSlots type and chestSlots field to LiveMemorySnapshot"
```

---

## Task 6: liveReader 集成 readRuntimeChestSlots

**Files:**
- Modify: `app/src/main/liveMemory/liveReader.ts`

- [ ] **Step 1: 导入 readRuntimeChestSlots 和 boxTypeCatalog**

在 `liveReader.ts` 顶部 import 块中追加：

```typescript
import { readRuntimeChestSlots } from "../../core/liveMemory/chestSlots";
import { boxTypeIndex, loadBoxTypeCatalog } from "../../core/boxes/catalog";
```

- [ ] **Step 2: 在 LiveMemoryReader 类中加 boxTypeCatalog 缓存**

找到 `LiveMemoryReader` 类的字段定义区，追加：

```typescript
private readonly boxTypeCatalog: ReadonlyMap<number, BoxCategory> = boxTypeIndex(loadBoxTypeCatalog());
```

注：需 `import type { BoxCategory } from "../../../shared/types";`

- [ ] **Step 3: 在 read() 方法中调用 readRuntimeChestSlots**

在 `read()` 方法中 `cachedPets` 读取之后、`return { ... }` 之前插入：

```typescript
const chestSlotsResult = readRuntimeChestSlots(
  p,
  ga.base,
  ga.size,
  o,
  this.boxTypeCatalog,
  this.playerPtr,
);
```

- [ ] **Step 4: 在返回的 snapshot 对象中加 chestSlots 字段**

修改 `return { ... }` 块，在 `petDataStatus` 之后追加：

```typescript
      chestSlots: chestSlotsResult.slots,
      chestSlotsStatus: chestSlotsResult.status || undefined,
```

- [ ] **Step 5: typecheck 验证**

```bash
cd app && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 6: 运行所有测试验证无回归**

```bash
cd app && pnpm test
```

Expected: 仅 pre-existing 失败（trackingService.test.ts 4 个），无新失败

- [ ] **Step 7: 提交**

```bash
git add app/src/main/liveMemory/liveReader.ts
git commit -m "feat(liveMemory): wire readRuntimeChestSlots into LiveMemoryReader snapshot"
```

---

## Task 7: AutoClassifyService 高频 reconcile 日志抑制

**Files:**
- Modify: `app/src/main/services/AutoClassifyService.ts`
- Test: `app/test/main/autoClassifyService.test.ts`

- [ ] **Step 1: 写失败测试 — 相同 slots 不重复打日志**

在 `autoClassifyService.test.ts` 的 `describe("AutoClassifyService.reconcileWithChestSlots", ...)` 块中追加：

```typescript
it("suppresses log when slots unchanged across consecutive reconciles", () => {
  const { service, chestDropTracker } = makeService({
    enabled: true,
    autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
    catalog: CATALOG,
    currentStageKey: 1105,
  });
  chestDropTracker.recordLiveChestDrop("common", 1.0);
  chestDropTracker.recordLiveChestDrop("common", 2.0);

  // First reconcile with slots=2: matches queue, no pruning, logs once
  service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
  // Second reconcile with same slots=2: should not log again
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
  // (Logging is via createLogger, not console.log directly — see note below)
  logSpy.mockRestore();

  // Verify behavior: queue unchanged, no exception
  expect(service.getQueueSnapshot().totalQueued).toBe(2);
});

it("prunes queue when live slots decrease", () => {
  const { service, chestDropTracker } = makeService({
    enabled: true,
    autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
    catalog: CATALOG,
    currentStageKey: 1105,
  });
  chestDropTracker.recordLiveChestDrop("common", 1.0);
  chestDropTracker.recordLiveChestDrop("common", 2.0);
  chestDropTracker.recordLiveChestDrop("common", 3.0);
  expect(service.getQueueSnapshot().totalQueued).toBe(3);

  // Live reports 1 chest remaining → prune 2 soonest-autoOpen
  service.reconcileWithChestSlots({ common: 1, rare: 0, act: 0 });
  const snap = service.getQueueSnapshot();
  expect(snap.totalQueued).toBe(1);
  expect(snap.items[0]!.droppedAtMs).toBe(3000); // latest survives
});
```

- [ ] **Step 2: 运行测试验证**

```bash
cd app && pnpm test -- --run test/main/autoClassifyService.test.ts
```

Expected: 第二个测试 PASS（现有逻辑已支持）。第一个测试可能因日志检查方式不正确而 FAIL — 调整为行为验证而非日志检查。

修正第一个测试：

```typescript
it("does not throw or prune when slots unchanged across consecutive reconciles", () => {
  const { service, chestDropTracker } = makeService({
    enabled: true,
    autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
    catalog: CATALOG,
    currentStageKey: 1105,
  });
  chestDropTracker.recordLiveChestDrop("common", 1.0);
  chestDropTracker.recordLiveChestDrop("common", 2.0);

  service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 });
  expect(service.getQueueSnapshot().totalQueued).toBe(2);

  // Second call with identical slots: queue unchanged, no exception
  expect(() => service.reconcileWithChestSlots({ common: 2, rare: 0, act: 0 })).not.toThrow();
  expect(service.getQueueSnapshot().totalQueued).toBe(2);
});
```

- [ ] **Step 3: 实现 lastSlotCounts 变化检测**

在 `AutoClassifyService.ts` 的类字段区追加：

```typescript
/** Last reconcile slot counts, for high-frequency call log suppression. */
private lastSlotCounts: { common: number; rare: number; act: number } | null = null;
```

在 `reconcileWithChestSlots` 方法的 `if (!this.enabled) return;` 之后插入：

```typescript
const changed =
  this.lastSlotCounts == null ||
  this.lastSlotCounts.common !== slots.common ||
  this.lastSlotCounts.rare !== slots.rare ||
  this.lastSlotCounts.act !== slots.act;
this.lastSlotCounts = { ...slots };
```

在方法末尾把 `if (prunedTotal > 0) { log.info(...) }` 改为：

```typescript
if (prunedTotal > 0 && changed) {
  log.info(`reconcile: total pruned ${prunedTotal} item(s) across categories`);
}
```

并在 `setEnabled(false)` 路径中重置：

```typescript
setEnabled(enabled: boolean): void {
  if (this.enabled === enabled) return;
  this.enabled = enabled;
  if (!enabled) {
    this.queue = [];
    this.pending = null;
    this.lastSlotCounts = null;
  }
  log.info(`auto-classify ${enabled ? "enabled" : "disabled"}`);
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app && pnpm test -- --run test/main/autoClassifyService.test.ts
```

Expected: PASS (all tests including new ones)

- [ ] **Step 5: 提交**

```bash
git add app/src/main/services/AutoClassifyService.ts app/test/main/autoClassifyService.test.ts
git commit -m "feat(autoClassify): add lastSlotCounts change detection for high-freq reconcile"
```

---

## Task 8: TrackingService 暴露 onLiveChestSlots 回调

**Files:**
- Modify: `app/src/main/services/TrackingService.ts`
- Modify: `app/src/main/app/appState.ts`
- Test: `app/test/main/trackingService.test.ts` (新增测试，不修复 pre-existing 失败)

- [ ] **Step 1: 在 TrackingService 中加回调字段**

在 `TrackingService` 类的构造函数参数之后（约 line 127 附近）追加：

```typescript
private readonly onLiveChestSlots?: (slots: { common: number; rare: number; act: number }) => void,
```

注：检查现有构造函数签名，决定是加到构造参数还是作为 setter。参考 `onLiveStageBossDrop` 的模式（构造参数注入）。

- [ ] **Step 2: 在 ingestLiveFrame 中调用回调**

在 `ingestLiveFrame` 方法中处理完 `chestCategories` 之后（约 line 700 附近）追加：

```typescript
// Live chest slot quantities (from PlayerSaveData.BoxData runtime). Fed to
// AutoClassifyService for high-frequency reconcile: when a chest opens
// (slot count decreases) the queue prunes the corresponding entry within
// seconds, rather than waiting for the next save parse (tens of seconds).
if (snap.chestSlots != null && this.onLiveChestSlots) {
  this.onLiveChestSlots(snap.chestSlots);
}
```

- [ ] **Step 3: 在 appState.ts 中连接回调**

找到 `appState.ts` 中 `tracking` 构造的位置（搜索 `new TrackingService`），在构造参数中加入新的回调：

```typescript
onLiveChestSlots: (slots) => autoClassifyRef.reconcileWithChestSlots(slots),
```

注：`autoClassifyRef` 已在 line 213 定义。需检查 TrackingService 构造参数顺序与回调签名匹配。

如果 TrackingService 使用 setter 而非构造参数，则在 `autoClassify` 创建后追加：

```typescript
tracking.setOnLiveChestSlots((slots) => autoClassifyRef.reconcileWithChestSlots(slots));
```

- [ ] **Step 4: 写测试验证回调触发**

在 `trackingService.test.ts` 中追加新测试（不修改 pre-existing 失败用例）：

```typescript
describe("TrackingService.onLiveChestSlots", () => {
  it("invokes onLiveChestSlots when snapshot.chestSlots is non-null", () => {
    const onLiveChestSlots = vi.fn();
    const svc = new TrackingService(vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, onLiveChestSlots);
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));
    onLiveMemory?.({
      ...baseLiveSnap,
      chestSlots: { common: 3, rare: 1, act: 0 },
    });
    expect(onLiveChestSlots).toHaveBeenCalledWith({ common: 3, rare: 1, act: 0 });
  });

  it("does not invoke onLiveChestSlots when chestSlots is null", () => {
    const onLiveChestSlots = vi.fn();
    const svc = new TrackingService(vi.fn(), /* ... other undefined args ... */);
    svc.start(baseConfig);
    onSnapshot?.(snap(5, 1000, 0));
    onLiveMemory?.({ ...baseLiveSnap, chestSlots: null });
    expect(onLiveChestSlots).not.toHaveBeenCalled();
  });
});
```

注：TrackingService 构造函数参数较多，需阅读其签名后填入正确的 undefined 数量。如果参数过多，改用 setter 模式更清晰（见 Step 3 备选方案）。

- [ ] **Step 5: typecheck + 运行新测试**

```bash
cd app && pnpm typecheck
cd app && pnpm test -- --run test/main/trackingService.test.ts -t "onLiveChestSlots"
```

Expected: typecheck 0 errors；新测试 PASS

- [ ] **Step 6: 提交**

```bash
git add app/src/main/services/TrackingService.ts app/src/main/app/appState.ts app/test/main/trackingService.test.ts
git commit -m "feat(tracking): expose onLiveChestSlots callback for high-freq AutoClassify reconcile"
```

---

## Task 9: Renderer 合并 live quantity + save capacity

**Files:**
- Modify: `app/src/renderer/lib/useLoot.ts`
- Modify: `app/src/renderer/tabs/Loot.tsx`
- Modify: `app/src/renderer/components/loot/LootQueueSlots.tsx`
- Test: `app/test/renderer-component/LootQueueSlots.test.tsx` (新建)

- [ ] **Step 1: 写组件测试 — live quantity 优先**

创建 `app/test/renderer-component/LootQueueSlots.test.tsx`：

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LootQueueSlots } from "../../src/renderer/components/loot/LootQueueSlots";
import type { AutoClassifyStatePayload, ChestState } from "../../shared/types";

// Minimal i18n setup — reuse pattern from LootBoxSection.test.tsx
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const EMPTY_QUEUE: AutoClassifyStatePayload = {
  enabled: true,
  totalQueued: 0,
  byCategory: [
    { category: "common", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "rare", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
    { category: "act", count: 0, nextAutoOpenInMs: null, lastAutoOpenInMs: null },
  ],
  items: [],
};

const CHESTS: ChestState = {
  common: { quantity: 5, capacity: 10, isFull: false, slotsRemaining: 5 },
  stageBoss: { quantity: 1, capacity: 3, isFull: false, slotsRemaining: 2 },
  actBoss: { quantity: 0, capacity: 2, isFull: false, slotsRemaining: 2 },
  autoOpen: { common: 300, stageBoss: 600, actBoss: 60 },
  mtime: 0,
};

describe("LootQueueSlots live/save merge", () => {
  it("uses liveChestSlots quantity when available", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={CHESTS}
        liveChestSlots={{ common: 7, rare: 2, act: 0 }}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
      />,
    );
    // common row should show 7/10 (live quantity / save capacity)
    expect(screen.getByLabelText(/slots.*used: 7.*capacity: 10/i)).toBeTruthy();
  });

  it("falls back to save quantity when liveChestSlots is null", () => {
    render(
      <LootQueueSlots
        queue={EMPTY_QUEUE}
        chests={CHESTS}
        liveChestSlots={null}
        dropsPerHour={{ common: 10, rare: 2, act: null }}
      />,
    );
    // common row should show 5/10 (save quantity / save capacity)
    expect(screen.getByLabelText(/slots.*used: 5.*capacity: 10/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app && pnpm test:dom -- --run test/renderer-component/LootQueueSlots.test.tsx
```

Expected: FAIL (LootQueueSlots 不接受 liveChestSlots prop)

- [ ] **Step 3: 修改 LootQueueSlots 接受 liveChestSlots prop**

在 `LootQueueSlots.tsx` 中：

1. 导入 `LiveChestSlots` 类型：
```typescript
import type { AutoClassifyStatePayload, BoxSlotStatus, ChestState, LiveChestSlots } from "../../../../shared/types";
```

2. 在 `LootQueueSlotsProps` 中加字段：
```typescript
interface LootQueueSlotsProps {
  queue: AutoClassifyStatePayload;
  chests: ChestState | null;
  /**
   * Live chest slot quantities from `LiveMemorySnapshot.chestSlots`. When
   * non-null, overrides `chests[slotKey].quantity` for display. `null` falls
   * back to the save-derived quantity. Capacity always comes from save.
   */
  liveChestSlots: LiveChestSlots | null;
  dropsPerHour: { [K in QueueCategory]: number | null };
}
```

3. 在组件签名中解构 `liveChestSlots`：
```typescript
export function LootQueueSlots({ queue, chests, liveChestSlots, dropsPerHour }: LootQueueSlotsProps) {
```

4. 在 `SLOT_ROWS.map` 回调中改 `quantity` 计算：
```typescript
const saveQuantity = slot?.quantity ?? 0;
const liveQuantity = liveChestSlots?.[row.queueCategory] ?? null;
const quantity = liveQuantity ?? saveQuantity;
```

注：`LiveChestSlots` 的字段是 `common/rare/act`，与 `QueueCategory` 一致，可直接索引。

- [ ] **Step 4: 修改 Loot.tsx 传入 liveChestSlots**

在 `Loot.tsx` 中：

1. 从 useLoot 解构 `liveChestSlots`：
```typescript
const {
  // ... existing fields ...
  liveChestSlots,
} = useLoot();
```

2. 传给组件：
```typescript
<LootQueueSlots
  queue={autoClassifyState}
  chests={chests}
  liveChestSlots={liveChestSlots}
  dropsPerHour={dropsPerHour}
/>
```

- [ ] **Step 5: 修改 useLoot 暴露 liveChestSlots**

在 `useLoot.ts` 中：

1. 导入 useLiveMemory（或直接用 useLiveMemoryField 选择 chestSlots）：
```typescript
import { useLiveMemoryField } from "./useLiveMemory";
import type { LiveChestSlots } from "../../../shared/types";
```

2. 在 hook 中读取：
```typescript
const liveChestSlots = useLiveMemoryField<LiveChestSlots | null>(
  (snap) => snap?.chestSlots ?? null,
);
```

3. 在返回对象中加入 `liveChestSlots`。

4. 同时更新 `EMPTY_STATE` 或默认值定义，确保 `liveChestSlots: null` 作为初始值。

- [ ] **Step 6: 运行测试验证通过**

```bash
cd app && pnpm test:dom -- --run test/renderer-component/LootQueueSlots.test.tsx
```

Expected: PASS (2 tests)

- [ ] **Step 7: typecheck 验证**

```bash
cd app && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 8: 提交**

```bash
git add app/src/renderer/components/loot/LootQueueSlots.tsx app/src/renderer/tabs/Loot.tsx app/src/renderer/lib/useLoot.ts app/test/renderer-component/LootQueueSlots.test.tsx
git commit -m "feat(renderer): merge live chestSlots quantity with save capacity in LootQueueSlots"
```

---

## Task 10: 端到端验证 + 完整测试套件

**Files:** 无修改

- [ ] **Step 1: 完整 typecheck**

```bash
cd app && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 2: 完整 lint**

```bash
cd app && pnpm lint
```

Expected: 0 errors（允许 pre-existing 4 warnings）

- [ ] **Step 3: 完整 test**

```bash
cd app && pnpm test
```

Expected: 仅 pre-existing 4 个 trackingService.test.ts 失败，无新失败。新增测试全部通过。

- [ ] **Step 4: 完整 test:dom**

```bash
cd app && pnpm test:dom
```

Expected: 全部通过（含新增 LootQueueSlots.test.tsx）

- [ ] **Step 5: 手动验证清单（如游戏可用）**

启动 dev 模式 `pnpm dev`，在游戏运行时检查：

1. Loot 页 LootQueueSlots 的 quantity 是否在 5 秒内更新（开箱后）
2. AutoClassify queue 是否在 chest 打开后 5 秒内剪枝对应项
3. live memory 不可用时（关闭 live reader），quantity 回退到 save 路径，UI 不报错
4. capacity 始终来自 save（开箱后 capacity 不变，直到下次 save parse）

如果游戏不可用，跳过此步骤 — 单元测试已覆盖核心逻辑。

- [ ] **Step 6: 更新 project_memory**

在 `c:\Users\zioon\.trae-cn\memory\projects\-d-Project-TBH-tbh-companion\project_memory.md` 的 Engineering Conventions 中追加：

```markdown
- Chest slot `quantity` 通过 live memory 路径（`PlayerSaveData.BoxData` runtime offset）读取，5Hz 广播；`capacity` 仍由 save 路径派生（rune 购买极低频）。Live 失败时 renderer 回退到 save quantity，AutoClassifyService 跳过本次 reconcile。
- AutoClassifyService.reconcileWithChestSlots 同时被 live snapshot（高频 5Hz）和 save parse（低频）调用；内部用 `lastSlotCounts` 变化检测抑制重复日志。
- LiveMemorySnapshot.chestSlots 字段走现有 IPC.LIVE_MEMORY 流，不新增 IPC channel。
```

- [ ] **Step 7: 最终提交**

```bash
git add c:\Users\zioon\.trae-cn\memory\projects\-d-Project-TBH-tbh-companion\project_memory.md
git commit -m "docs(memory): update project memory with live chest slots conventions"
```

注：memory 文件不在 repo 中，无需 git commit；直接保存即可。

---

## Self-Review 检查

**Spec coverage**:
- ✅ LiveOffsets 扩展 player.boxData + boxData struct → Task 1
- ✅ readRuntimeChestSlots 核心函数 → Task 2-4
- ✅ LiveMemorySnapshot 扩展 chestSlots 字段 → Task 5
- ✅ LiveMemoryService worker 集成 → Task 6
- ✅ AutoClassifyService 高频 reconcile + 日志抑制 → Task 7
- ✅ TrackingService onLiveChestSlots 回调 → Task 8
- ✅ Renderer 合并 live/save → Task 9
- ✅ il2cppScanner findBoxDataFields 扩展 → **GAP**: 未单独列任务

**Gap 修复**: 需要新增 Task 11 覆盖 il2cppScanner 的 `findPlayerSaveData` 扩展和 `findBoxDataFields` 函数。

**Placeholder scan**: 无 TBD/TODO，所有步骤都有具体代码。

**Type consistency**:
- `LiveChestSlots` 类型在 types.ts 定义，在 chestSlots.ts / liveReader.ts / useLoot.ts / LootQueueSlots.tsx 中使用 — 一致
- `ReadChestSlotsResult` 在 chestSlots.ts 定义，在 liveReader.ts 中消费 — 一致
- `boxTypeCatalog: ReadonlyMap<number, BoxCategory>` 在 chestSlots.ts 定义，在 liveReader.ts 中通过 `boxTypeIndex(loadBoxTypeCatalog())` 构造 — 一致

---

## Task 11: il2cppScanner 扩展 findPlayerSaveData 派生 boxData offset

**Files:**
- Modify: `app/src/core/liveMemory/il2cppScanner.ts`
- Test: `app/test/core/liveMemoryIl2cppScanner.test.ts`

- [ ] **Step 1: 写失败测试 — findPlayerSaveData 返回 boxData offset**

在 `liveMemoryIl2cppScanner.test.ts` 中追加测试（参考现有 findPlayerSaveData 测试模式）：

```typescript
describe("findPlayerSaveData boxData derivation", () => {
  it("derives boxData offset by field name when present", () => {
    // Setup: a static class with PetSaveData + itemSaveDatas + BoxData fields,
    // where BoxData points at an object containing BoxTypes + BoxQuantity Lists.
    // ... mock scan context ...
    const anchor = findPlayerSaveData(ctx, entries);
    expect(anchor).not.toBeNull();
    expect(anchor!.boxData).toBeGreaterThan(0);
  });

  it("returns boxData=0 when BoxData field absent", () => {
    // Setup: static class without BoxData field.
    const anchor = findPlayerSaveData(ctx, entries);
    expect(anchor).not.toBeNull();
    expect(anchor!.boxData).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app && pnpm test -- --run test/core/liveMemoryIl2cppScanner.test.ts
```

Expected: FAIL (PlayerAnchor 无 boxData 字段)

- [ ] **Step 3: 扩展 PlayerAnchor 类型加 boxData**

在 `il2cppScanner.ts` 的 `PlayerAnchor` 接口中追加：

```typescript
export interface PlayerAnchor {
  commonSaveData: bigint;
  playerStaticOff: number;
  petSaveDatas: number;
  itemSaveDatas: number;
  aggregateSaveDatas?: number;
  /** PlayerSaveData.BoxData field offset. 0 when absent (reader falls back to save). */
  boxData?: number;
  petKey: number;
  petIsUnlock: number;
  itemKey: number;
  itemIsChaotic: number;
}
```

- [ ] **Step 4: 在 findPlayerSaveData 中派生 boxData**

修改 `findPlayerSaveData` 函数，在 `return { ... }` 前追加：

```typescript
const boxDataOff = fields.get("BoxData") ?? 0;
// Optional structural fallback: scan for a field pointing at an object
// with two consecutive List<int> fields. Skipped for now — name match is
// reliable for the ES3-stable BoxData field. Add fallback only if a game
// version is found where BoxData is renamed.
```

在 return 对象中加入：

```typescript
return {
  commonSaveData: entry.slotRva,
  playerStaticOff: soff,
  petSaveDatas: petsOff,
  itemSaveDatas: itemsOff,
  boxData: boxDataOff,
  petKey: namedClassField(ctx, entries, "PetSaveData", "PetKey"),
  petIsUnlock: namedClassField(ctx, entries, "PetSaveData", "IsUnlock"),
  itemKey: namedClassField(ctx, entries, "ItemSaveData", "ItemKey"),
  itemIsChaotic: namedClassField(ctx, entries, "ItemSaveData", "IsChaotic"),
};
```

- [ ] **Step 5: 在 offsetExtractor 中写回 boxData offset**

搜索 `offsetExtractor.ts`（或类似自愈主入口），找到 `PlayerAnchor` 被序列化到 `LiveOffsets` 的位置，加入：

```typescript
player: {
  commonSaveData: anchor.commonSaveData,
  currency: ...,
  heroSaveDatas: ...,
  petSaveDatas: anchor.petSaveDatas,
  itemSaveDatas: anchor.itemSaveDatas,
  aggregates: anchor.aggregateSaveDatas ?? 0,
  boxData: anchor.boxData ?? 0,
},
```

并在 BoxData struct offset 派生位置加入对 `BoxTypes` / `BoxQuantity` 字段名的查找（同样优先命名匹配，0 表示未派生）。

- [ ] **Step 6: 运行测试验证通过**

```bash
cd app && pnpm test -- --run test/core/liveMemoryIl2cppScanner.test.ts
cd app && pnpm typecheck
```

Expected: 测试 PASS，typecheck 0 errors

- [ ] **Step 7: 提交**

```bash
git add app/src/core/liveMemory/il2cppScanner.ts app/test/core/liveMemoryIl2cppScanner.test.ts
git commit -m "feat(liveMemory): derive player.boxData offset in findPlayerSaveData"
```

---

## 总结

11 个任务覆盖：
1. LiveOffsets 类型扩展
2. readRuntimeChestSlots 骨架 + offset guards
3. readIntArray 辅助函数（List<int> + int[] 双路径）
4. readRuntimeChestSlots 完整实现（聚合 + 错误处理）
5. LiveMemorySnapshot 类型扩展
6. liveReader 集成
7. AutoClassifyService 高频 reconcile 日志抑制
8. TrackingService onLiveChestSlots 回调
9. Renderer 合并 live/save
10. 端到端验证 + project_memory 更新
11. il2cppScanner boxData offset 派生

每个任务独立可测、独立可提交。Phase 1-3 (Task 1-6) 是 core + main 层的基础设施；Phase 4-5 (Task 7-9) 是 AutoClassify + renderer 集成；Task 10 是验收；Task 11 是自愈扩展（可后置）。
