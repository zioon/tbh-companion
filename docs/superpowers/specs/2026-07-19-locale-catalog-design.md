# Locale catalog for stage / hero / item names

**Date:** 2026-07-19
**Status:** Design — pending user review
**Depends on:** i18n framework shipped in v1.19.0 (4 locales × 16 namespaces)

## Goal

Extend i18n coverage to dynamic game data: **stage names, hero names, item
names**. These are not UI strings (already covered by i18next namespaces) but
data-driven strings sourced from the game's localization bundles.

## Context

- `stageName(key)` in [`app/src/core/stages.ts`](../../../app/src/core/stages.ts) currently returns hardcoded English ("Hell 2-5").
- `heroName(key)` in [`app/src/core/heroes.ts`](../../../app/src/core/heroes.ts) returns 6 hardcoded English names.
- `GameItem.name` in [`data/gamedata.json`](../../../data/gamedata.json) is mixed: 5,224 gear items have English names ("Long Sword"), 511 materials + 536 gear items have `ItemName_<id>` localization keys, 274 stage boxes have English names.
- Game ships 18 locale string-table bundles under `TaskbarHero_Data/StreamingAssets/aa/StandaloneWindows64/`.
- The `ItemTable Shared Data` bundle has 511 `ItemName_<id>` keys; `StringTable Shared Data` has 30 `StageName_<4digit>`, 6 `HeroName_<3digit>`, and 4 `Difficulty_<NAME>` keys.

## Non-goals

- Translating the 5,224 gear items with hardcoded English names (no localization key exists in the game data; would require game-prefab re-extraction, out of scope).
- Translating item/stage/hero descriptions (no `ItemDesc_/StageDesc_/HeroDesc_` keys exist in the bundles).
- Runtime bundle reading from the companion (we extract offline and bundle the JSON).

## Design

### 1. Offline data extraction

New script [`scripts/extract_locale_catalog.py`](../../../scripts/extract_locale_catalog.py):

- Input: 4 locale bundles (en-us, zh-hans, ja-jp, ko-kr) + `localization-assets-shared_assets_all.bundle`.
- Process: build `m_Id → m_Key` map from `SharedTableData.m_Entries`, join with each locale's `StringTable.m_TableData` (`m_Id → m_Localized`).
- Output: 4 files under `data/`:
  - `locale_strings_en.json`
  - `locale_strings_zh-CN.json`
  - `locale_strings_ja.json`
  - `locale_strings_ko.json`

Each file:

```json
{
  "source": "game v1.00.28 localization bundles",
  "fetchedUtc": "2026-07-19T...",
  "items": { "110001": "Goblin Hide", "110002": "Skeleton Bone", ... },
  "stages": { "1101": "Pasture", "1102": "Shadow Meadow", ... },
  "heroes": { "101": "Knight", "201": "Ranger", "301": "Sorcerer", "401": "Priest", "501": "Hunter", "601": "Slayer" },
  "difficulties": { "NORMAL": "Normal", "NIGHTMARE": "Nightmare", "HELL": "Hell", "TORMENT": "Torment" }
}
```

Key format notes:
- `stages` key is `<act><stage>` 4-digit (e.g. `2105` = act 2 stage 5). Difficulty is not in the key — the same name is reused across Normal/Nightmare/Hell/Torment for the same act/stage.
- `heroes` key is the hero key string (`"101"` etc.), matching `Hero.heroKey`.
- `difficulties` key is the enum name (`NORMAL`/`NIGHTMARE`/`HELL`/`TORMENT`).

Bundle size estimate: ~50 KB per locale × 4 = ~200 KB total (well under the gamedata.json 600 KB).

### 2. Core layer (stays pure)

New module [`app/src/core/localeCatalog.ts`](../../../app/src/core/localeCatalog.ts):

```typescript
import type { ResolvedLanguage } from "../../shared/language";

export interface LocaleCatalog {
  items: Record<string, string>;       // itemKey string -> localized name
  stages: Record<string, string>;      // <act><stage> 4-digit -> localized name
  heroes: Record<string, string>;      // heroKey string -> localized name
  difficulties: Record<string, string>; // NORMAL/NIGHTMARE/HELL/TORMENT -> localized name
}

export function loadLocaleCatalog(lang: ResolvedLanguage): LocaleCatalog;
export function emptyLocaleCatalog(): LocaleCatalog;
```

`loadLocaleCatalog` reads the bundled JSON via the existing `core/bundledData.ts` pattern (synchronous `readFileSync` + `JSON.parse`, cached for process lifetime). `emptyLocaleCatalog` returns an empty stub used in tests and as a fallback.

Modified functions add a `catalog: LocaleCatalog | null` parameter:

```typescript
// stages.ts
export function stageName(key: number, catalog: LocaleCatalog | null): string {
  // Extract act+stage from key (3205 -> "2105"), look up catalog.stages["2105"].
  // Fallback: build "<difficulty> <act>-<stage>" using catalog.difficulties
  // (or English default if catalog is null).
}

// heroes.ts
export function heroName(key: string, catalog: LocaleCatalog | null): string {
  return catalog?.heroes[key] ?? HERO_NAMES[key] ?? key;
}

// gamedata.ts — new function
export function gameItemName(item: GameItem, catalog: LocaleCatalog | null): string {
  if (item.name.startsWith("ItemName_")) {
    const id = item.name.slice("ItemName_".length);
    return catalog?.items[id] ?? item.name;
  }
  return item.name;  // English hardcoded name — no localization key
}
```

Stage-key parsing detail: `stageKey` is `<difficulty><act><stage>` where difficulty is 1 digit (1-4), act is 1 digit (1-3), stage is 2 digits (01-10). To form the catalog key:
- `stageKey = 3205` → `difficulty = 3, act = 2, stage = 05` → catalog key `"2105"`
- `stageKey = 1310` → `difficulty = 1, act = 3, stage = 10` → catalog key `"1310"`

### 3. Main layer (service constructor injection)

`appState.ts` loads the catalog once at startup and injects it into services:

```typescript
const catalog = loadLocaleCatalog(resolvedLanguage);
const trackingService = new TrackingService(onStats, ..., catalog);
const inventoryService = new InventoryService(..., catalog);
const boxTimerService = new BoxTimerService(..., catalog);
```

Services store the catalog as an instance field and pass it to every `stageName` / `heroName` / `gameItemName` call inside their methods.

Language switch flow:
1. User picks new language in Settings → `savePartial({ language })` → `changeLanguage(lang)` in main.
2. Main re-loads catalog: `const newCatalog = loadLocaleCatalog(newResolvedLanguage)`.
3. Main calls `service.setLocaleCatalog(newCatalog)` on each injected service.
4. Services re-broadcast their current state (TrackingService re-emits stats, InventoryService re-resolves inventory, BoxTimerService re-emits box state) so the renderer receives freshly-localized names.
5. Main's `getConfig` IPC return value already includes `resolvedLanguage` (existing mechanism) — no change needed there.

### 4. Renderer layer (strict main-only read)

Renderer does **not** load the catalog. All localized names come from IPC payload fields:

| IPC stream | New field | Source |
|------------|-----------|--------|
| `onStats` (Stats) | `stageName: string` | `stageName(stats.stageKey, catalog)` computed in main |
| `onStats` (Stats) | `heroes[].name` (already exists) | Now uses `heroName(key, catalog)` |
| `onLiveMemory` (LiveMemorySnapshot) | (no change — uses stageKey, renderer resolves via Stats) | — |
| `onStageRuns` (StageRunEntry) | `stageName: string` | `stageName(entry.stageKey, catalog)` |
| `onBoxTimers` (BoxTimerState) | `currentStageLabel: string` (already exists) | Now uses `stageName(key, catalog)` |
| `onInventory` (ResolvedInventory) | `items[].name` (already exists) | Now uses `gameItemName(item, catalog)` |
| `getConfig` (AppConfig) | `stageMetadata: Record<number, string>` | Full stageKey → localized name map (30 entries), for `boxLootFilters` text matching |

The 7 renderer call sites of `stageName` / `heroName` are updated:

| File | Line | Change |
|------|------|--------|
| [`Overlay.tsx`](../../../app/src/renderer/Overlay.tsx) | 203 | `stats.stageName` (from IPC) |
| [`Live.tsx`](../../../app/src/renderer/tabs/Live.tsx) | 422 | `stage?.stageName ?? stats.stageName` (both from IPC) |
| [`Live.tsx`](../../../app/src/renderer/tabs/Live.tsx) | 552 | `e.stageName` (from IPC) |
| [`BoxTracker.tsx`](../../../app/src/renderer/BoxTracker.tsx) | 96 | `state.currentStageLabel` (from IPC, already exists) |
| [`StageRunPanel.tsx`](../../../app/src/renderer/components/live/StageRunPanel.tsx) | 50 | `entry.stageName` (from IPC) |
| [`LiveMemoryDiagnostics.tsx`](../../../app/src/renderer/tabs/LiveMemoryDiagnostics.tsx) | 127 | `h.name` (from LiveMemorySnapshot heroes — add `name` field) |
| [`boxLootFilters.ts`](../../../app/src/renderer/lib/boxLootFilters.ts) | 92 | Use `stageMetadata` from `useConfig()` instead of calling `stageName` |

`boxLootFilters.stageMatchesQuery` signature changes to accept `stageMetadata` from the caller:

```typescript
export function stageMatchesQuery(
  stageKey: number,
  displayName: string,
  query: string,
  stageMetadata: Record<number, string>,  // new param
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const compact = (stageMetadata[stageKey] ?? "").toLowerCase();
  const difficulty = compact.split(" ")[0] ?? "";
  return displayName.toLowerCase().includes(q) || compact.includes(q) || difficulty.includes(q);
}
```

`LiveMemorySnapshot.heroes` (in `shared/types.ts`) adds optional `name?: string` field, populated by main when the catalog is available. `LiveMemoryDiagnostics` reads `h.name ?? heroName(h.heroKey)` — but since renderer no longer imports `heroName`, it just reads `h.name ?? String(h.heroKey)`.

### 5. Shared types changes

[`app/shared/types.ts`](../../../app/shared/types.ts):

```typescript
export interface Stats {
  // ... existing fields ...
  stageName: string;  // NEW: localized stage name (e.g. "Pasture")
}

export interface StageRunEntry {
  // ... existing fields ...
  stageName: string;  // NEW: localized stage name
}

export interface LiveMemorySnapshot {
  // ... existing fields ...
  heroes?: { heroKey: number; level: number; exp: number; name?: string }[] | null;  // NEW: name field
}

export interface AppConfig {
  // ... existing fields ...
  stageMetadata?: Record<number, string>;  // NEW: stageKey -> localized name (30 entries), runtime-only like resolvedLanguage
}
```

### 6. Testing

- **New:** `test/core/localeCatalog.test.ts` — tests `loadLocaleCatalog` for each language, fallback behavior, empty catalog.
- **Modified:** `test/core/stages.test.ts` — add cases with `catalog` param (with/without matching entry).
- **Modified:** `test/core/heroes.test.ts` — add cases with `catalog` param.
- **Modified:** `test/main/trackingService.test.ts` / `inventoryService.test.ts` / `boxTimerService.test.ts` — inject `emptyLocaleCatalog()` to preserve current behavior, add cases with populated catalog.
- **Modified:** `test/renderer/boxLootFilters.test.ts` — pass `stageMetadata` to `stageMatchesQuery`.
- **New:** `test/main/localeCatalogInjection.test.ts` — end-to-end: main loads catalog, injects to service, service emits localized names in IPC payload.

### 7. Documentation

- [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) Internationalization section: add paragraph on locale catalog for dynamic game data.
- [`CHANGELOG.md`](../../../CHANGELOG.md) `[Unreleased]`: add bullets for stage/hero/item name localization.
- No version bump (same 1.19.0 cycle).

### 8. Build pipeline

- `app/scripts/minify-and-copy-data.mjs` already copies `data/*.json` to `dist/data/`. New `locale_strings_*.json` files are picked up automatically — no script change needed.
- Bundle size: +200 KB across 4 JSON files (uncompressed), ~60 KB after minification.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Game updates add new StageName_/ItemName_ keys not in bundled catalog | Fallback to English hardcoded name (stageName) or raw key (`ItemName_<id>`); catalog refresh is a re-run of the Python script |
| Stage key parsing edge case (e.g. key `1110` = act 1 stage 10, not act 11 stage 0) | Parser uses `act = Math.floor(key / 100) % 10` and `stage = key % 100`, matching existing `stageName` logic |
| `setLocaleCatalog` on services triggers re-broadcast storm | Services deduplicate: only re-emit if the localized names actually changed (compare against last emitted payload) |
| `stageMetadata` in config IPC bloats payload | 30 entries × ~15 chars = ~450 bytes; negligible |
| Renderer test snapshots break due to new IPC fields | Tests use `emptyLocaleCatalog()` in main mocks → fields fall back to English defaults, matching pre-change behavior |

## Implementation order

1. Write `scripts/extract_locale_catalog.py`, run it, commit the 4 JSON files under `data/`.
2. Add `app/src/core/localeCatalog.ts` + tests.
3. Modify `stages.ts` / `heroes.ts` / `gamedata.ts` signatures + tests.
4. Modify main services to accept and use catalog (constructor injection + `setLocaleCatalog`).
5. Modify `appState.ts` to load catalog on startup and on language switch.
6. Extend shared types (`Stats`, `StageRunEntry`, `LiveMemorySnapshot.heroes`, `AppConfig.stageMetadata`).
7. Update renderer call sites (7 locations) to read from IPC fields.
8. Update `boxLootFilters` to accept `stageMetadata`.
9. Update `docs/ARCHITECTURE.md` and `CHANGELOG.md`.
10. Run `pnpm qa` and fix all breakage.
