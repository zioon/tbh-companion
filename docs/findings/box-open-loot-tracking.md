# Box open loot tracking -- research + design

Research spike against live game v1.00.28 `global-metadata.dat` (2026-07-16), plus the
design for a new **Loot** tab that records box-opening outcomes and aggregates them by
chest type and level. See also [`boxes.md`](./boxes.md) for the chest-capacity research
and [`../SAVE_FORMAT.md`](../SAVE_FORMAT.md) for the save layout.

## Motivation

The companion currently tracks **chest drops** (when a monster drops a chest during
battle) via the `GetBox` battle log. It does **not** track **box openings** (when the
player opens a held chest and receives an item). Without that signal, players cannot
answer basic questions about their loot:

- What items does a Stage boss Lv3 chest actually drop for me?
- What is my observed drop rate for `Sword of Foo` from Common Lv5?
- How much buyout gold per hour am I getting from auto-opened common chests?

This feature closes that gap: record every box open, aggregate by box type+level, and
surface the results on a new **Loot** tab.

## IL2CPP research findings (v1.00.28)

Scanned `D:\SteamLibrary\steamapps\common\TaskbarHero\TaskBarHero_Data\il2cpp_data\Metadata\global-metadata.dat`
directly for identifier strings (class/enum/method names are stored as UTF-8 in IL2CPP
metadata). Findings:

### ELogType enum -- full value list

```
GetItemWithBoxOpen | GetBox | HeroDie | StageFailed | SynthesisResult |
AlchemyResult | DecorationResult | EngravingResult | InscriptionResult |
OfferingResult | CraftingResult | ExtractionResult
```

- `GetBox` (existing, key=3) -- chest-drop log (monster drops a chest). Already tailed
  by `readRuntimeChestLog`.
- **`GetItemWithBoxOpen`** -- the new signal. This is the `ELogType` dictionary key for
  the **box-open** log bucket. Numeric value to be extracted at implementation time
  (the existing extractor resolves `ELogType.GetBox=3` and `ELogType.StageClear=1`; the
  new key follows the same pattern).

### BoxOpenLog class

Namespace `TaskbarHero.Log`, source `Assets/02_Script/16.Log/BoxOpenLog.cs`. Fields
gleaned from metadata:

| Field | Type (inferred) | Notes |
|-------|-----------------|-------|
| `itemStringKey` | string / int | Item identifier of the produced item |
| `itemGradeType` | enum | Grade of the produced item |
| `khb`, `bfne`, `bfnf`, `bfng`, `bswl` | mixed (obfuscated) | Undetermined -- likely include box type / level / count |

**Open question for implementation phase:** whether the obfuscated fields carry the
source box `boxType` and `level`. The `ExchangeOpenBox` coroutine (see below) has
`willOpenBoxData.itemInfoData.boxType` in scope, so the data is available in the open
code path; whether it is written into the log struct needs offset extraction to confirm.

### Box-open code path

- `<ExchangeOpenBox>d__2` -- coroutine with fields `willOpenBoxData`, `itemInfoData`,
  `boxType`. This is the synchronous exchange path (single box).
- `<ExchangeOpenBoxAsync>d__75`, `<OpenBoxAsync>d__74`, `<OpenAllBoxAsync>d__69` --
  async variants. `OpenAllBoxAsync` is the auto-open path (driven by Rune of Auto-Open).
- `<TryOpen>d__68`, `<WatchStuckOpenForNewBoxAsync>d__78` -- UI/edge-case handlers.

### Related identifiers

- `EItemGetSourceType.OpenBox` -- item-acquisition source enum value (separate from the
  log path; could be a fallback signal via an item-get log if one exists).
- `BoxOpenStats`, `AutoOpenBoxMaxTime`, `AutoOpenBoxReductionSeconds` -- auto-open
  tuning/state fields (not directly useful for loot tracking, but confirm the auto-open
  path is the same one that writes `BoxOpenLog`).

### Conclusion

The game **does** log box openings via `ELogType.GetItemWithBoxOpen` -> `BoxOpenLog`,
and each entry carries the produced item. This is the precise signal source for the
Loot feature. The only uncertainty is whether the source box `boxType`/`level` is
written into the log struct -- that needs runtime offset extraction to confirm.


## Design

### Architecture (four layers, per AGENTS.md)

| Layer | Path | New/Modified | Responsibility |
|-------|------|--------------|----------------|
| **shared** | `app/shared/types.ts`, `app/shared/ipc.ts` | Add `BoxOpen*` types + reset IPC channels | Types + channel names, no runtime logic |
| **core** | `app/src/core/boxOpenTracker.ts` (new), `app/src/core/liveMemory/offsets.ts`, `app/src/core/liveMemory/runtime.ts` | New tracker + new tail reader | Pure logic: record, aggregate, snapshot, tail |
| **main** | `app/src/main/liveMemory/liveReader.ts`, `app/src/main/services/TrackingService.ts`, `app/src/main/services/SessionStateService.ts`, `app/src/main/app/appState.ts`, `app/src/main/ipc/handlers/` | Wire reader, persist, expose reset | Orchestration + I/O + IPC |
| **preload** | `app/src/preload/index.ts` | Expose `resetLootBox` / `resetLootAll` | Thin contextBridge |
| **renderer** | `app/src/renderer/tabs/Loot.tsx` (new), `app/src/renderer/lib/useLoot.ts`, `app/src/renderer/lib/lootFilters.ts`, `app/src/renderer/components/loot/*`, `app/src/renderer/components/appTabs.ts` | New tab + hook + filters + components | UI |

### Data model (`app/shared/types.ts`)

```ts
// A single recorded box open (history entry).
export interface BoxOpenHistoryEntry {
  wallTime: number;          // epoch seconds
  boxKey: string;            // "common" | "rare" | "act" | "rare:3" | "common:5" ...
  itemKey: number;           // produced item id (resolved from itemStringKey)
  itemName: string;
  grade: string | null;
  count: number;             // typically 1; reserved for batch opens
}

// Per-item aggregation row inside a boxKey bucket.
export interface BoxOpenBreakdownRow {
  itemKey: number;
  name: string;
  grade: string | null;
  count: number;             // total produced of this item under this boxKey
  dropPct: number;           // observed frequency = count / boxKey.totalOpens
  buyOrderUnit: number | null; // Steam buy-order unit price (instant-sell price)
  buyOrderValue: number | null; // count * buyOrderUnit
  hourlyValue: number | null;  // buyOrderValue / sessionHours
}

// Per-boxKey aggregation.
export interface BoxOpenStats {
  boxKey: string;
  label: string;             // "Common" | "Stage boss Lv3" | ...
  category: "common" | "rare" | "act";
  level: number | null;      // null = category-only fallback
  totalOpens: number;
  totalBuyOrderValue: number | null; // sum of buyOrderValue across items
  hourlyValue: number | null;        // totalBuyOrderValue / sessionHours
  breakdown: BoxOpenBreakdownRow[];
  history: BoxOpenHistoryEntry[];    // most recent N (visible window)
  lastOpenWallTime: number | null;
}

// Persisted to session_state.json.
export interface BoxOpenTrackerSnapshot {
  // boxKey -> itemKey -> count
  countsByKey: Record<string, Record<string, number>>;
  // itemKey -> name (shared across all boxKeys)
  namesByKey: Record<string, string>;
  // itemKey -> grade (shared across all boxKeys)
  gradesByKey: Record<string, string | null>;
  history: BoxOpenHistoryEntry[];
  // boxKey metadata (category/level/label) is derived from the catalog at read time,
  // not persisted.
}
```

Add `boxOpens: BoxOpenStats[]` to the existing `Stats` interface (pushed from main to
renderer alongside `chestDrops`).

Add `boxOpenTracker?: BoxOpenTrackerSnapshot` to `PersistedSessionState`.

### Live-memory reader (`app/src/core/liveMemory`)

**`offsets.ts`:**

- Extend `runtime.log` with `getItemWithBoxOpenTypeKey: number` -- the `ELogType`
  enum value for `GetItemWithBoxOpen` (numeric value extracted at runtime; the bundled
  `RUNTIME_V1_00_21` / `V1_00_23` tables need the value populated, or it can be derived
  by the existing dynamic offset extractor).
- Add `boxOpenLog` struct offsets -- at minimum `itemStringKey` and `itemGradeType`;
  `boxType` and `level` if present. If `boxType`/`level` are absent from the struct,
  fall back to category-only aggregation (see "Risks and mitigations").

**`runtime.ts`:**

- `BoxOpenPinState` = `ChestLogPinState` (same shape: `ptr`, `lastCount`, `primed`).
  Reuse `makeChestLogPinState` or add `makeBoxOpenPinState` for naming clarity.
- `readRuntimeBoxOpenLog(reader, gaBase, gaSize, o, pin): { opens: BoxOpenEntry[] | null; status: string }` --
  tails the `GetItemWithBoxOpen` bucket the same way `readRuntimeChestLog` tails
  `GetBox`. Primes to current length on first read, restarts from 0 if the log
  shrinks, returns `null` when the LogManager cannot be resolved (distinct from `[]`).
- `BoxOpenEntry = { itemKey: number; boxType?: number; level?: number }` -- the raw
  entry; `boxType`/`level` are optional pending offset extraction.

**`itemStringKey` resolution:**

- If `itemStringKey` is an inline int (like `GetBoxLog.monsterType`), use it directly.
- If it is a string key, build a `stringKey -> itemKey` map from `gamedata.json` at
  startup and resolve at ingest time. The map lives in `core/gamedata.ts` or a new
  `core/boxOpenLog.ts` helper next to the tracker.

### BoxOpenTracker (`app/src/core/boxOpenTracker.ts`)

Mirrors `ChestDropTracker` structure:

```ts
export class BoxOpenTracker {
  // boxKey -> (itemKey -> count)
  private countsByKey = new Map<string, Map<string, number>>();
  private namesByKey = new Map<string, string>();
  private gradesByKey = new Map<string, string | null>();
  private history: BoxOpenHistoryEntry[] = [];

  recordOpen(boxKey: string, itemKey: number, name: string, grade: string | null,
             count: number, wallTime: number): void;

  getStats(sessionSeconds: number,
           priceResolver: (itemKey: number) => {
             buyOrderUnit: number | null;
           } | null): BoxOpenStats[];

  resetBox(boxKey: string): void;     // per-box reset
  resetAll(): void;                   // reset everything

  captureSnapshot(): BoxOpenTrackerSnapshot;
  applySnapshot(data: BoxOpenTrackerSnapshot): void;
}
```

**`boxKey` derivation** (`resolveBoxKey(boxType, level?, catalog)`):

- `boxType` 0 -> `"common"`; 1 -> `"rare"`; 2 -> `"act"`.
- If `level` is present (>0) and the catalog confirms the box has levels
  (rare boxes have `920xxx` levels; common `910xxx`; act `930xxx`), append:
  `"rare:3"`. Otherwise use category-only key.
- The catalog lookup uses `loadStageBoxCatalogFile()` from `core/stageBoxTracker.ts`
  (the same source as the existing box-tracker overlay).

**`getStats` flow:**

1. For each `boxKey` in `countsByKey`:
   - Derive `label`, `category`, `level` from the catalog (or from `boxKey` itself
     if no catalog entry -- `"rare:3"` -> category `rare`, level `3`).
   - Sum `count` across items -> `totalOpens`.
   - For each item: resolve `buyOrderUnit` via `priceResolver`; compute
     `buyOrderValue = count * buyOrderUnit`; `dropPct = count / totalOpens`;
     `hourlyValue = buyOrderValue / (sessionSeconds / 3600)`.
   - Sum `buyOrderValue` across items -> `totalBuyOrderValue`;
     `hourlyValue = totalBuyOrderValue / sessionHours`.
2. Sort breakdown by `count` desc, then name asc.
3. Return most-recent `HISTORY_VISIBLE` (e.g. 50) history entries per boxKey, reversed.

### Price resolver

**Decision:** price resolution runs in the **main process**, not the renderer. The
main process already owns both price sources (inventory buy-order cache and the
lookup-price snapshot), so duplicating that knowledge in the renderer would violate
the layer boundary. The renderer receives `BoxOpenStats[]` already populated with
`buyOrderUnit` / `buyOrderValue` / `hourlyValue` and just renders.

`TrackingService` holds the `BoxOpenTracker` and the price cache (from
`InventoryService` / `LookupPriceService`); when it builds `Stats.boxOpens` each
tick, it passes a `priceResolver` closure into `boxOpenTracker.getStats(...)`. The
resolver composes two sources, in priority order:

1. **Inventory buy-order prices** -- for items currently in the player inventory
   (`buyOrderUnit` is already populated by the existing Steam Market price pipeline).
2. **Lookup-price snapshot** -- bundled snapshot for items not in inventory (so a
   consumed drop still shows a buyout estimate).
3. `null` fallback -- item is non-tradable or price unknown; the row still appears
   with count and dropPct, but `buyOrderUnit` / `buyOrderValue` / `hourlyValue` are
   `null` and the renderer shows "N/A".


### IPC + persistence

**`app/shared/ipc.ts`:**

- `LOOT_RESET_BOX` -- payload: `{ boxKey: string }`.
- `LOOT_RESET_ALL` -- no payload.

**`TrackingService.ingestLiveFrame`:**

- Consume `snap.boxOpens: BoxOpenEntry[] | null` -> for each entry, derive `boxKey`
  via `resolveBoxKey(boxType, level, catalog)`, resolve `itemKey` (stringKey -> int),
  look up `name`/`grade` from gamedata, then `boxOpenTracker.recordOpen(...)`.

**`SessionStateService`:**

- `PersistedSessionState` gains `boxOpenTracker?: BoxOpenTrackerSnapshot`.
- `persist` writes `boxOpenTracker.captureSnapshot()`.
- `tryRestoreOnSnapshot` calls `boxOpenTracker.applySnapshot(snapshot)`.
- `clearSession` calls `boxOpenTracker.reset()` and persists.
- All three flows mirror the existing `chestDropTracker` handling exactly.

**`appState.ts`:**

- Add `resetLootBox(boxKey)` and `resetLootAll()` handlers, calling
  `tracking.resetLootBox(boxKey)` / `tracking.resetLootAll()` and then
  `sessionState.flush(...)`.

**`ipc/handlers/loot.ts` (new):**

- Register `IPC.LOOT_RESET_BOX` and `IPC.LOOT_RESET_ALL` -> call the appState handlers.

**`preload/index.ts`:**

- Expose `window.tbh.resetLootBox(boxKey: string): Promise<void>` and
  `window.tbh.resetLootAll(): Promise<void>`.

### Renderer

**`app/src/renderer/components/appTabs.ts`:**

- Add `{ id: "loot", label: "Loot" }` to `TABS`, placed after `"chests"`.

**`app/src/renderer/tabs/Loot.tsx`:**

- `TabHeader` with intro: "Live box-opening outcomes, aggregated by chest type and level."
- A top-level "Reset all" button (with confirm).
- One `<LootBoxSection>` per `BoxOpenStats` (sorted by category, then level asc).
- Empty state when `boxOpens.length === 0`: "No boxes opened yet this session. Open a
  chest in-game with the live reader running."

**`app/src/renderer/components/loot/LootBoxSection.tsx`:**

- Header row: box label + `totalOpens` + `hourlyValue` (formatted as gold/hour) +
  per-section "Reset" button (with confirm).
- `DataTable` columns: Item | Count | Drop% | Buyout | Hourly value.
  - Item cell: `<ItemLink>` (reuse existing component).
  - Drop%: `fmtDropPct(count / totalOpens)`.
  - Buyout: `buyOrderUnit` formatted as gold (or "N/A").
  - Hourly value: `hourlyValue` formatted as gold/hour (or "N/A").
- Sort/search via `lootFilters.ts` (mirror `boxLootFilters.ts`).

**`app/src/renderer/lib/useLoot.ts`:**

- Hook that pulls `boxOpens` from the shared IPC state (via `useStats` or
  `TbhProvider`).
- Exposes `resetBox(boxKey)` and `resetAll()` that call `window.tbh.*`.

**`app/src/renderer/lib/lootFilters.ts`:**

- `filterAndSortLoot(rows: BoxOpenBreakdownRow[], state: LootFilterState)` -- mirror
  `boxLootFilters.ts` structure: query, grade filter, sort by count/dropPct/name/grade.

### Reset behavior

- **Per-box reset:** `window.tbh.resetLootBox(boxKey)` -> main clears that boxKey
  counts + history, persists, the next stats tick pushes the updated `boxOpens` to
  the renderer. The section collapses to "no data" or disappears.
- **Reset all:** `window.tbh.resetLootAll()` -> clears every boxKey. Persists.
- Both require a confirm dialog (reuse `Dialog` primitive) to prevent accidental loss.
- Reset does **not** reset the session timer (the `sessionSeconds` denominator for
  hourly rates stays the same). This matches the "session duration" decision: rates
  are always relative to the live session, so a fresh reset of one box still divides
  by the full session duration. (Rationale: a per-box reset that also reset the
  session clock would corrupt other boxes rates.)

### Testing

**`app/test/core/boxOpenTracker.test.ts`** (new):

- `recordOpen` accumulates counts.
- `getStats` computes `dropPct`, `hourlyValue`, `totalBuyOrderValue` correctly with
  a fake `priceResolver`.
- `resetBox` clears only the targeted boxKey; `resetAll` clears all.
- `captureSnapshot` / `applySnapshot` round-trip preserves counts and history.
- Empty tracker returns `[]`.

**`app/test/core/liveMemory/runtimeBoxOpenLog.test.ts`** (new):

- `readRuntimeBoxOpenLog` over `FakeMemory`: prime on first read returns `[]`,
  subsequent reads return new entries, log shrink restarts from 0, unresolved
  LogManager returns `null`. Mirror the existing `readRuntimeChestLog` tests.

**`app/test/ipc/channels.test.ts`:**

- Assert `LOOT_RESET_BOX` and `LOOT_RESET_ALL` channels exist in `shared/ipc.ts`.

**`app/test/main/sessionStateService.test.ts`** (extend):

- `persist` writes `boxOpenTracker` snapshot; `tryRestoreOnSnapshot` applies it;
  `clearSession` resets it.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `BoxOpenLog` does not carry `boxType` / `level` | Offset extraction confirms at impl time. If absent: fall back to category-only aggregation (`"common"`/`"rare"`/`"act"`). The UI reserves a Level column; shows "-" when category-only. The `boxKey` derivation function already supports both forms. |
| `itemStringKey` is a string, not an int | Build `stringKey -> itemKey` map from `gamedata.json` at startup. If the key is an int, use directly (no map needed). Detect format during offset extraction. |
| Buyout price unavailable for consumed items | Use the lookup-price snapshot (bundled, refreshed every 30 min by `LookupPriceService`). If still missing, show "N/A" -- the row still appears with count and dropPct. |
| Game version v1.00.28 > currently bundled v1.00.23 offsets | The offset extractor is version-agnostic -- `BoxOpenLog` offsets are derived at runtime by `il2cppScanner` (same as `GetBoxLog` was). The bundled `RUNTIME_V1_00_21` / `V1_00_23` tables are fallbacks; if v1.00.28 is not bundled, the scanner derives live. |
| Auto-open spamming `BoxOpenLog` at high rate | The tail reader is incremental (only new entries since last read). History is capped at `HISTORY_LIMIT = 500` per boxKey, visible window 50 -- same as `ChestDropTracker`. Counts are O(1) map updates. |
| `ELogType.GetItemWithBoxOpen` numeric value unknown | The extractor resolves it the same way it resolves `GetBox=3` and `StageClear=1`: by reading the `ELogType` enum metadata at runtime, or by hardcoding once known. A bundled fallback value can be added after live verification. |

### Out of scope

- **Predictive/theoretical drop rates** -- the Lookup tab already shows catalog
  `dropPct`. The Loot tab shows *observed* frequencies only.
- **Cross-session aggregation** -- resets with the session, like `ChestDropTracker`.
  Long-term stats would be a separate feature.
- **Overlay mini view** -- the Loot tab is main-window only; the overlay stays focused
  on chest-drop cooldowns.
- **Per-item drill-down** -- clicking an item links to the existing Lookup item page;
  no new detail view.

### Assumptions

- **buyout price** = Steam Market buy-order unit price (instant-sell price), same as
  `buyOrderUnit` in `ResolvedInventoryRow`.
- **probability** = observed frequency (`count / totalOpens`), not the catalog
  theoretical `dropPct`.
- **hourly value** = produced buyout value / live session duration. Session reset
  (existing "Reset session" action) zeroes all box stats, matching the
  `ChestDropTracker` behavior.
- **session duration** = `tracking.tracker.elapsed` (the same `elapsedSeconds` used
  by `chestDropTracker.getStats`).
