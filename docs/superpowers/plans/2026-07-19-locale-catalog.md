# Locale Catalog 实施计划（stage / hero / item 多语言化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 把 stage 名、hero 名、item 名纳入 i18n 覆盖，数据从游戏 localization bundle 离线提取，运行时通过 service 构造函数注入 + IPC 字段扩展传给 renderer。

**架构：** Python 脚本离线生成 4 份 `data/locale_strings_*.json`；core 层新增 `LocaleCatalog` 纯数据结构 + `loadLocaleCatalog`；`stageName` / `heroName` / `gameItemName` 加 `catalog` 参数；main 层 service 通过构造函数注入 catalog，语言切换时 `setLocaleCatalog` 重新 emit；renderer 严格不读 catalog，所有名字都从 IPC 字段（`Stats.stageName` / `StageRunHistoryEntry.stageName` / `LiveHeroData.name` / `BoxTimerState.currentStageLabel` / `AppConfig.stageMetadata`）拿。

**技术栈：** TypeScript（core/main/renderer）、Python（UnityPy 1.25.2 提取脚本）、Vitest（测试）、Electron IPC（已有 `onStats` / `onStageRuns` / `onBoxTimers` / `onInventory` / `getConfig`，零新增 channel）。

**依赖：** i18n 框架 v1.19.0 已交付（4 语言 × 16 namespace），本计划只覆盖 dynamic game data。

**spec：** [docs/superpowers/specs/2026-07-19-locale-catalog-design.md](../specs/2026-07-19-locale-catalog-design.md)

---

## 文件结构总览

| 类型 | 路径 | 责任 |
|------|------|------|
| Create | `scripts/extract_locale_catalog.py` | 离线提取 4 语言的 stage/hero/item/difficulty 翻译 |
| Create | `data/locale_strings_en.json` | 英文翻译（511 items + 30 stages + 6 heroes + 4 difficulties） |
| Create | `data/locale_strings_zh-CN.json` | 简体中文翻译 |
| Create | `data/locale_strings_ja.json` | 日文翻译 |
| Create | `data/locale_strings_ko.json` | 韩文翻译 |
| Create | `app/src/core/localeCatalog.ts` | `LocaleCatalog` 类型 + `loadLocaleCatalog` + `emptyLocaleCatalog` |
| Create | `app/test/core/localeCatalog.test.ts` | core 层单元测试 |
| Modify | `app/src/core/stages.ts` | `stageName(key, catalog?)` 加 catalog 参数 |
| Modify | `app/src/core/heroes.ts` | `heroName(key, catalog?)` 加 catalog 参数 |
| Modify | `app/src/core/gamedata.ts` | 新增 `gameItemName(item, catalog?)` |
| Modify | `app/shared/types.ts` | `Stats.stageName` / `StageRunHistoryEntry.stageName?` / `LiveHeroData.name?` / `BoxTimerState.currentStageLabel` / `AppConfig.stageMetadata?` |
| Modify | `app/src/main/stats.ts` | `buildStats` 接受 catalog 参数，填充 `stats.stageName` 与 hero `name` |
| Modify | `app/src/main/services/TrackingService.ts` | 构造函数加 `catalog` 参数 + `setLocaleCatalog` + 传给 `buildStats` |
| Modify | `app/src/main/services/BoxTimerService.ts` | 构造函数加 `catalog` 参数 + `setLocaleCatalog` + `buildState` 加 `currentStageLabel` |
| Modify | `app/src/main/services/StageRunService.ts` | 构造函数加 `catalog` 参数 + `setLocaleCatalog` + `getStats` 填 `stageName` |
| Modify | `app/src/main/services/InventoryService.ts` | 构造函数加 `catalog` 参数 + `setLocaleCatalog` + `mergeLookupNames` 接 catalog |
| Modify | `app/src/main/app/appState.ts` | 启动加载 catalog + `onLanguageChanged` reload + `getConfig` 填 `stageMetadata` |
| Modify | `app/src/renderer/Overlay.tsx` | `stageName(stats.stageKey)` → `stats.stageName` |
| Modify | `app/src/renderer/BoxTracker.tsx` | `stageName(state.currentStageKey)` → `state.currentStageLabel` |
| Modify | `app/src/renderer/tabs/Live.tsx` | 2 处 `stageName(...)` → IPC 字段 |
| Modify | `app/src/renderer/tabs/LiveMemoryDiagnostics.tsx` | `heroName(String(h.heroKey))` → `h.name ?? String(h.heroKey)` |
| Modify | `app/src/renderer/components/live/StageRunPanel.tsx` | `stageName(entry.stageKey)` → `entry.stageName` |
| Modify | `app/src/renderer/lib/boxLootFilters.ts` | `stageMatchesQuery` 加 `stageMetadata` 参数 |
| Modify | `docs/ARCHITECTURE.md` | Internationalization 段补 locale catalog |
| Modify | `CHANGELOG.md` | `[Unreleased]` 加 bullets |

---

## Task 1: Python 提取脚本 + 生成 4 份 JSON

**Files:**
- Create: `scripts/extract_locale_catalog.py`
- Create: `data/locale_strings_en.json`
- Create: `data/locale_strings_zh-CN.json`
- Create: `data/locale_strings_ja.json`
- Create: `data/locale_strings_ko.json`

- [ ] **Step 1: 写 `scripts/extract_locale_catalog.py`**

```python
#!/usr/bin/env python3
"""
Extract stage / hero / item / difficulty names from the game's Unity
Localization bundles for the 4 locales the companion app supports
(en, zh-CN, ja, ko).

Outputs 4 JSON files under data/:
  - locale_strings_en.json
  - locale_strings_zh-CN.json
  - locale_strings_ja.json
  - locale_strings_ko.json

Each file has the shape:
  {
    "source": "game v1.00.28 localization bundles",
    "fetchedUtc": "2026-07-19T...",
    "items": { "<itemKey>": "<localized name>", ... },        # 511 entries
    "stages": { "<act><stage>": "<localized name>", ... },    # 30 entries (4-digit key)
    "heroes": { "<heroKey>": "<localized name>", ... },       # 6 entries
    "difficulties": { "NORMAL": "Normal", ... }               # 4 entries
  }

Pipeline:
  1. Load localization-assets-shared_assets_all.bundle → SharedTableData
     with m_Entries[i] = { m_Id, m_Key, m_Metadata }. Build m_Id → m_Key map.
  2. For each of the 4 locale bundles:
       Load <locale>_string-tables_assets_all.bundle → StringTable
       with m_TableData[i] = { m_Id, m_Localized, m_Metadata }.
       Build m_Id → m_Localized map.
  3. Join: m_Key → m_Localized via shared m_Id.
  4. Partition by key prefix (ItemName_ / StageName_ / HeroName_ / Difficulty_).

Usage:
  python scripts/extract_locale_catalog.py [game_data_dir] [output_dir]

Defaults:
  game_data_dir = D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data\\StreamingAssets\\aa\\StandaloneWindows64
  output_dir    = <repo_root>/data
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import UnityPy

# Locale bundle filename → output language code.
LOCALE_BUNDLES = {
    "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle": "en",
    "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle": "zh-CN",
    "localization-string-tables-japanese(japan)(ja-jp)_assets_all.bundle": "ja",
    "localization-string-tables-korean(southkorea)(ko-kr)_assets_all.bundle": "ko",
}

SHARED_BUNDLE = "localization-assets-shared_assets_all.bundle"

# Key prefixes in SharedTableData.m_Entries[i].m_Key.
PREFIX_ITEM = "ItemName_"
PREFIX_STAGE = "StageName_"
PREFIX_HERO = "HeroName_"
PREFIX_DIFF = "Difficulty_"


def build_id_to_key(shared_bundle_path: str) -> dict[int, str]:
    """SharedTableData.m_Entries[i] = { m_Id: long, m_Key: string, m_Metadata }.
    Return m_Id → m_Key map."""
    env = UnityPy.load(shared_bundle_path)
    result: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        # SharedTableData has m_Entries list.
        entries = tree.get("m_Entries") or tree.get("m_TableData") or []
        for entry in entries:
            m_id = entry.get("m_Id")
            m_key = entry.get("m_Key")
            if m_id is None or not m_key:
                continue
            result[int(m_id)] = str(m_key)
    return result


def build_id_to_value(locale_bundle_path: str) -> dict[int, str]:
    """StringTable.m_TableData[i] = { m_Id: long, m_Localized: string, m_Metadata }.
    Return m_Id → m_Localized map."""
    env = UnityPy.load(locale_bundle_path)
    result: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        entries = tree.get("m_TableData") or []
        for entry in entries:
            m_id = entry.get("m_Id")
            m_value = entry.get("m_Localized")
            if m_id is None or m_value is None:
                continue
            result[int(m_id)] = str(m_value)
    return result


def partition_keys(id_to_key: dict[int, str], id_to_value: dict[int, str]) -> dict:
    """Join via m_Id, partition by key prefix."""
    items: dict[str, str] = {}
    stages: dict[str, str] = {}
    heroes: dict[str, str] = {}
    difficulties: dict[str, str] = {}
    for m_id, key in id_to_key.items():
        value = id_to_value.get(m_id)
        if value is None:
            continue
        if key.startswith(PREFIX_ITEM):
            items[key[len(PREFIX_ITEM):]] = value
        elif key.startswith(PREFIX_STAGE):
            stages[key[len(PREFIX_STAGE):]] = value
        elif key.startswith(PREFIX_HERO):
            heroes[key[len(PREFIX_HERO):]] = value
        elif key.startswith(PREFIX_DIFF):
            difficulties[key[len(PREFIX_DIFF):]] = value
    return {
        "items": items,
        "stages": stages,
        "heroes": heroes,
        "difficulties": difficulties,
    }


def main() -> int:
    default_game_dir = (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
        r"\StreamingAssets\aa\StandaloneWindows64"
    )
    game_dir = sys.argv[1] if len(sys.argv) > 1 else default_game_dir
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else repo_root / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    shared_path = os.path.join(game_dir, SHARED_BUNDLE)
    print(f"Loading shared table: {SHARED_BUNDLE}")
    id_to_key = build_id_to_key(shared_path)
    print(f"  {len(id_to_key)} shared entries")

    fetched_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
    output_files: dict[str, str] = {}

    for bundle_name, lang_code in LOCALE_BUNDLES.items():
        bundle_path = os.path.join(game_dir, bundle_name)
        print(f"\nLoading locale bundle: {bundle_name}")
        id_to_value = build_id_to_value(bundle_path)
        print(f"  {len(id_to_value)} localized entries")
        partitioned = partition_keys(id_to_key, id_to_value)
        print(
            f"  items={len(partitioned['items'])} "
            f"stages={len(partitioned['stages'])} "
            f"heroes={len(partitioned['heroes'])} "
            f"difficulties={len(partitioned['difficulties'])}"
        )
        payload = {
            "source": "game v1.00.28 localization bundles",
            "fetchedUtc": fetched_utc,
            **partitioned,
        }
        out_path = out_dir / f"locale_strings_{lang_code}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"  wrote {out_path}")
        output_files[lang_code] = str(out_path)

    print("\n=== Done ===")
    for lang, path in output_files.items():
        print(f"  {lang}: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 运行脚本生成 4 份 JSON**

```bash
python scripts/extract_locale_catalog.py
```

预期输出：4 个文件写入 `data/`，每个文件包含 `items` (~511 条) + `stages` (~30 条) + `heroes` (6 条) + `difficulties` (4 条)。

- [ ] **Step 3: 人工抽查 4 份 JSON 的 stage 1101 翻译**

预期：`data/locale_strings_en.json` 的 `stages["1101"]` = `"Pasture"`；`data/locale_strings_zh-CN.json` 的 `stages["1101"]` 是简体中文；ja/ko 同理。

- [ ] **Step 4: 验证 heroes 翻译**

预期 4 份 JSON 的 `heroes["101"]`：
- en: `"Knight"`
- zh-CN: 简体中文（如"骑士"）
- ja: 日文
- ko: 韩文

- [ ] **Step 5: Commit**

```bash
git add scripts/extract_locale_catalog.py data/locale_strings_en.json data/locale_strings_zh-CN.json data/locale_strings_ja.json data/locale_strings_ko.json
git commit -m "feat(locale): extract stage/hero/item names from game bundles

Python script joins SharedTableData.m_Entries with per-locale
StringTable.m_TableData to build 4 JSON files under data/.
Covers 511 items (ItemName_<id>), 30 stages (StageName_<act><stage>),
6 heroes (HeroName_<3digit>), 4 difficulties."
```

---

## Task 2: core/localeCatalog.ts + 测试

**Files:**
- Create: `app/src/core/localeCatalog.ts`
- Create: `app/test/core/localeCatalog.test.ts`

- [ ] **Step 1: 写失败测试 `app/test/core/localeCatalog.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";

describe("localeCatalog", () => {
  describe("emptyLocaleCatalog", () => {
    it("returns an object with all empty records", () => {
      const c = emptyLocaleCatalog();
      expect(c.items).toEqual({});
      expect(c.stages).toEqual({});
      expect(c.heroes).toEqual({});
      expect(c.difficulties).toEqual({});
    });

    it("returns a fresh object each call (no shared reference)", () => {
      const a = emptyLocaleCatalog();
      const b = emptyLocaleCatalog();
      expect(a).not.toBe(b);
      expect(a.items).not.toBe(b.items);
    });
  });

  describe("LocaleCatalog type", () => {
    it("accepts a populated catalog", () => {
      const c: LocaleCatalog = {
        items: { "110001": "Goblin Hide" },
        stages: { "1101": "Pasture" },
        heroes: { "101": "Knight" },
        difficulties: { NORMAL: "Normal" },
      };
      expect(c.items["110001"]).toBe("Goblin Hide");
      expect(c.stages["1101"]).toBe("Pasture");
      expect(c.heroes["101"]).toBe("Knight");
      expect(c.difficulties.NORMAL).toBe("Normal");
    });
  });
});
```

注：`loadLocaleCatalog` 依赖 `readFileSync`，在 vitest 默认环境里可用（Node），但为保持 core 层 pure，`loadLocaleCatalog` 实现放到 `core/localeCatalog.ts` 里通过 `core/bundledData.ts` 的 `readBundledJson` 读取。测试时只测 `emptyLocaleCatalog` 与类型，不实际加载文件（避免测试依赖磁盘存在）。

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app
pnpm test -- localeCatalog
```

预期：FAIL with "Cannot find module '../../src/core/localeCatalog'"

- [ ] **Step 3: 写 `app/src/core/localeCatalog.ts`**

```typescript
// Locale catalog for stage / hero / item / difficulty names.
//
// Bundled in data/locale_strings_<lang>.json (4 files: en, zh-CN, ja, ko).
// Loaded once per process via `loadLocaleCatalog(lang)`, then injected into
// services via constructor. Language switch triggers a re-load + service
// `setLocaleCatalog(newCatalog)` call.
//
// Pure: uses `core/bundledData.readBundledJson` (synchronous readFileSync)
// cached for process lifetime. No electron / no fetch.

import type { ResolvedLanguage } from "../../shared/language";
import { readBundledJson } from "./bundledData";

export interface LocaleCatalog {
  /** itemKey string (e.g. "110001") → localized name. */
  items: Record<string, string>;
  /** 4-digit "<act><stage>" (e.g. "2105") → localized name. Difficulty is not in the key. */
  stages: Record<string, string>;
  /** heroKey string (e.g. "101") → localized name. */
  heroes: Record<string, string>;
  /** Difficulty enum name (NORMAL / NIGHTMARE / HELL / TORMENT) → localized name. */
  difficulties: Record<string, string>;
}

interface LocaleStringsFile {
  source: string;
  fetchedUtc: string;
  items: Record<string, string>;
  stages: Record<string, string>;
  heroes: Record<string, string>;
  difficulties: Record<string, string>;
}

const LANG_TO_FILENAME: Record<ResolvedLanguage, string> = {
  en: "locale_strings_en.json",
  "zh-CN": "locale_strings_zh-CN.json",
  ja: "locale_strings_ja.json",
  ko: "locale_strings_ko.json",
};

const cache = new Map<ResolvedLanguage, LocaleCatalog>();

/**
 * Load the locale catalog for the given language. Cached for process lifetime
 * (catalog content never changes at runtime — language switch instantiates a
 * new entry in the cache rather than mutating an existing one).
 */
export function loadLocaleCatalog(lang: ResolvedLanguage): LocaleCatalog {
  const cached = cache.get(lang);
  if (cached) return cached;
  const filename = LANG_TO_FILENAME[lang];
  const raw = readBundledJson<LocaleStringsFile>(filename);
  const catalog: LocaleCatalog = {
    items: raw.items ?? {},
    stages: raw.stages ?? {},
    heroes: raw.heroes ?? {},
    difficulties: raw.difficulties ?? {},
  };
  cache.set(lang, catalog);
  return catalog;
}

/** Empty stub for tests / fallback. */
export function emptyLocaleCatalog(): LocaleCatalog {
  return {
    items: {},
    stages: {},
    heroes: {},
    difficulties: {},
  };
}

/** Test-only: clear the cache so subsequent `loadLocaleCatalog` calls re-read. */
export function _resetLocaleCatalogCacheForTests(): void {
  cache.clear();
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app
pnpm test -- localeCatalog
```

预期：PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add app/src/core/localeCatalog.ts app/test/core/localeCatalog.test.ts
git commit -m "feat(core): add LocaleCatalog type + loadLocaleCatalog

Pure data structure (items/stages/heroes/difficulties) loaded from
data/locale_strings_<lang>.json via readBundledJson. Cached per-language
for process lifetime; emptyLocaleCatalog for tests + fallback."
```

---

## Task 3: stages.ts 加 catalog 参数

**Files:**
- Modify: `app/src/core/stages.ts`
- Modify: `app/test/core/stages.test.ts`（如不存在则 Create）

- [ ] **Step 1: 写失败测试**

在 `app/test/core/stages.test.ts` 末尾追加：

```typescript
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";
import { stageName } from "../../src/core/stages";

describe("stageName with catalog", () => {
  it("uses catalog.stages when entry exists", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "2105": "Pasture" },
      difficulties: { NORMAL: "Normal", NIGHTMARE: "Nightmare", HELL: "Hell", TORMENT: "Torment" },
    };
    expect(stageName(3205, catalog)).toBe("Pasture");
  });

  it("falls back to <difficulty> <act>-<stage> when catalog.stages misses", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      difficulties: { NORMAL: "Normal", NIGHTMARE: "Nightmare", HELL: "Hell", TORMENT: "Torment" },
    };
    expect(stageName(3205, catalog)).toBe("Hell 2-5");
  });

  it("uses catalog.difficulties for fallback difficulty name", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      difficulties: { HELL: "地狱" },
    };
    expect(stageName(3205, catalog)).toBe("地狱 2-5");
  });

  it("returns ? for invalid key", () => {
    expect(stageName(0, null)).toBe("?");
    expect(stageName(-1, null)).toBe("?");
  });

  it("falls back to English default when catalog is null", () => {
    expect(stageName(3205, null)).toBe("Hell 2-5");
  });

  it("handles stage key with act 3 stage 10 (1310 → catalog '1310')", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      stages: { "1310": "Hell Command Chamber" },
    };
    expect(stageName(1310, catalog)).toBe("Hell Command Chamber");
    expect(stageName(3310, catalog)).toBe("Hell Command Chamber");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app
pnpm test -- stages
```

预期：FAIL with "stageName expects 1 argument but got 2" 或类似

- [ ] **Step 3: 改 `app/src/core/stages.ts`**

完整替换文件内容：

```typescript
// Decode TBH stage keys into human-readable map names.
//
//   3205 -> Hell 2-5      (difficulty 3, act 2, stage 5)
//   2309 -> Nightmare 3-9 (difficulty 2, act 3, stage 9)
//
// When a LocaleCatalog is provided, looks up catalog.stages["<act><stage>"]
// (e.g. 3205 → "2105") and returns the localized stage name directly.
// Otherwise falls back to "<difficulty> <act>-<stage>" using
// catalog.difficulties (or English default if catalog is null).
//
// Ported from tbh_xp/stages.py.

import type { LocaleCatalog } from "./localeCatalog";

const DIFFICULTIES: Record<number, string> = {
  1: "Normal",
  2: "Nightmare",
  3: "Hell",
  4: "Torment",
};

// Difficulty enum name keyed by digit (1..4). Used when catalog.difficulties
// contains localized names.
const DIFFICULTY_DIGIT_TO_ENUM: Record<number, string> = {
  1: "NORMAL",
  2: "NIGHTMARE",
  3: "HELL",
  4: "TORMENT",
};

export function stageName(key: number, catalog: LocaleCatalog | null = null): string {
  const k = Math.trunc(Number(key));
  if (!Number.isFinite(k) || k <= 0) return "?";
  const difficulty = Math.floor(k / 1000);
  const act = Math.floor(k / 100) % 10;
  const stage = k % 100;

  // Try catalog lookup first. Catalog key is 4-digit "<act><stage>".
  if (catalog) {
    const stageKey4 = `${act}${String(stage).padStart(2, "0")}`;
    const localized = catalog.stages[stageKey4];
    if (localized) return localized;
  }

  // Fallback: <difficulty> <act>-<stage>
  const diffEnum = DIFFICULTY_DIGIT_TO_ENUM[difficulty];
  const diff =
    (catalog && diffEnum && catalog.difficulties[diffEnum]) ||
    DIFFICULTIES[difficulty] ||
    `D${difficulty}`;
  return `${diff} ${act}-${stage}`;
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app
pnpm test -- stages
```

预期：PASS（原有 + 新增全部通过）

- [ ] **Step 5: Commit**

```bash
git add app/src/core/stages.ts app/test/core/stages.test.ts
git commit -m "feat(core): stageName accepts LocaleCatalog for localized names

stageName(key, catalog?) — when catalog.stages[\"<act><stage>\"] exists,
return it directly. Otherwise fall back to \"<difficulty> <act>-<stage>\"
using catalog.difficulties (or English default if catalog is null).

stageKey encoding: <difficulty><act><stage> = 1+1+2 digits (e.g. 3205 =
Hell act 2 stage 5). Catalog key drops the difficulty digit (2105) since
the same stage name is reused across all 4 difficulties for the same
act/stage."
```

---

## Task 4: heroes.ts 加 catalog 参数

**Files:**
- Modify: `app/src/core/heroes.ts`
- Modify: `app/test/core/heroes.test.ts`（如不存在则 Create）

- [ ] **Step 1: 写失败测试**

在 `app/test/core/heroes.test.ts` 末尾追加：

```typescript
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";
import { heroName, HERO_NAMES } from "../../src/core/heroes";

describe("heroName with catalog", () => {
  it("uses catalog.heroes when entry exists", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      heroes: { "101": "骑士" },
    };
    expect(heroName("101", catalog)).toBe("骑士");
  });

  it("falls back to HERO_NAMES when catalog misses", () => {
    const catalog = emptyLocaleCatalog();
    expect(heroName("101", catalog)).toBe("Knight");
  });

  it("falls back to HERO_NAMES when catalog is null", () => {
    expect(heroName("101", null)).toBe("Knight");
  });

  it("falls back to raw key when neither catalog nor HERO_NAMES has entry", () => {
    expect(heroName("999", null)).toBe("999");
    expect(heroName("999", emptyLocaleCatalog())).toBe("999");
  });

  it("accepts numeric key (coerced to string)", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      heroes: { "101": "骑士" },
    };
    // heroName signature is (key: string, catalog?), but Number coercion
    // through String(key) is the existing behavior. Test passes 101 as number.
    expect(heroName(101 as unknown as string, catalog)).toBe("骑士");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app
pnpm test -- heroes
```

预期：FAIL

- [ ] **Step 3: 改 `app/src/core/heroes.ts`**

完整替换文件内容：

```typescript
// Hero key -> display name. Unknown keys fall back to the raw key.
// Ported from the HERO_NAMES map in tbh_xp/app.py.
//
// When a LocaleCatalog is provided, catalog.heroes[key] takes priority
// over the English hardcoded HERO_NAMES.

import type { LocaleCatalog } from "./localeCatalog";

export const HERO_NAMES: Record<string, string> = {
  "101": "Knight",
  "201": "Ranger",
  "301": "Sorcerer",
  "401": "Priest",
  "501": "Hunter",
  "601": "Slayer",
};

export function heroName(key: string, catalog: LocaleCatalog | null = null): string {
  const k = String(key);
  if (catalog) {
    const localized = catalog.heroes[k];
    if (localized) return localized;
  }
  return HERO_NAMES[k] ?? k;
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app
pnpm test -- heroes
```

预期：PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/core/heroes.ts app/test/core/heroes.test.ts
git commit -m "feat(core): heroName accepts LocaleCatalog for localized names

heroName(key, catalog?) — catalog.heroes[key] takes priority, then
HERO_NAMES (English fallback), then raw key."
```

---

## Task 5: gamedata.ts 加 gameItemName 函数

**Files:**
- Modify: `app/src/core/gamedata.ts`
- Modify: `app/test/core/gamedata.test.ts`（如不存在则 Create）

- [ ] **Step 1: 写失败测试**

在 `app/test/core/gamedata.test.ts` 末尾追加：

```typescript
import { emptyLocaleCatalog, type LocaleCatalog } from "../../src/core/localeCatalog";
import { gameItemName, type GameItem } from "../../src/core/gamedata";

describe("gameItemName", () => {
  const itemWithName: GameItem = {
    id: 110001,
    name: "Goblin Hide",
    grade: "COMMON",
    type: "MATERIAL",
    level: null,
    marketTradable: true,
  };
  const itemWithPlaceholder: GameItem = {
    id: 530017,
    name: "ItemName_530017",
    grade: "RARE",
    type: "GEAR",
    level: 10,
    marketTradable: true,
  };

  it("returns item.name when it is not a placeholder", () => {
    expect(gameItemName(itemWithName, null)).toBe("Goblin Hide");
  });

  it("returns catalog.items[id] when item.name is a placeholder and catalog has entry", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      items: { "530017": "Ethereal Ring" },
    };
    expect(gameItemName(itemWithPlaceholder, catalog)).toBe("Ethereal Ring");
  });

  it("falls back to raw placeholder name when catalog misses", () => {
    expect(gameItemName(itemWithPlaceholder, emptyLocaleCatalog())).toBe("ItemName_530017");
  });

  it("falls back to raw placeholder name when catalog is null", () => {
    expect(gameItemName(itemWithPlaceholder, null)).toBe("ItemName_530017");
  });

  it("uses item.id as catalog key (number → string coercion)", () => {
    const catalog: LocaleCatalog = {
      ...emptyLocaleCatalog(),
      items: { "530017": "Ethereal Ring" },
    };
    // Same item, but verify the key lookup path: placeholder name is
    // "ItemName_530017" and we slice off "ItemName_" → "530017", then look
    // up catalog.items["530017"].
    expect(gameItemName(itemWithPlaceholder, catalog)).toBe("Ethereal Ring");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd app
pnpm test -- gamedata
```

预期：FAIL with "gameItemName is not exported"

- [ ] **Step 3: 在 `app/src/core/gamedata.ts` 末尾追加 `gameItemName`**

在 `normalizeGameItem` 函数后追加：

```typescript
import type { LocaleCatalog } from "./localeCatalog";

/**
 * Resolve the display name for a GameItem. If `item.name` is a localization
 * placeholder (`"ItemName_<id>"`), look up `catalog.items[id]` for the
 * localized name. Otherwise return `item.name` as-is (English hardcoded name —
 * no localization key exists in the game data).
 *
 * Returns the raw placeholder string when the catalog is null or misses the
 * entry — the renderer's `mergeLookupNames` (InventoryService) replaces
 * placeholders with English display names from lookup_items.json as a
 * secondary fallback. This function only handles the locale-catalog path.
 */
export function gameItemName(item: GameItem, catalog: LocaleCatalog | null): string {
  if (item.name.startsWith("ItemName_")) {
    const id = item.name.slice("ItemName_".length);
    if (catalog) {
      const localized = catalog.items[id];
      if (localized) return localized;
    }
    return item.name;
  }
  return item.name;
}
```

注：import 语句应放在文件顶部；如果 `gamedata.ts` 顶部已有其它 import，把 `import type { LocaleCatalog }` 加进去。

- [ ] **Step 4: 运行测试验证通过**

```bash
cd app
pnpm test -- gamedata
```

预期：PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/core/gamedata.ts app/test/core/gamedata.test.ts
git commit -m "feat(core): add gameItemName(item, catalog) for localized item names

When item.name is a placeholder (\"ItemName_<id>\"), look up
catalog.items[id] for the localized name. Otherwise return item.name
as-is — 5,224 gear items with hardcoded English names have no
localization key and are not translatable."
```

---

## Task 6: 扩展 shared/types.ts

**Files:**
- Modify: `app/shared/types.ts`

- [ ] **Step 1: 在 `Stats` 接口里加 `stageName` 字段**

定位 `export interface Stats {` (约 278 行)，在 `stageKey: number;` 后追加：

```typescript
  stageKey: number;
  /** Localized stage name (e.g. "Pasture" / "牧场"). Filled by main via buildStats. */
  stageName: string;
```

- [ ] **Step 2: 在 `StageRunHistoryEntry` 接口里加 `stageName?` 字段**

定位 `export interface StageRunHistoryEntry {` (约 751 行)，在 `stageKey: number;` 后追加：

```typescript
  stageKey: number;
  /** Localized stage name. Filled by main in getStats(); not persisted to stage_run_history.json. */
  stageName?: string;
```

- [ ] **Step 3: 在 `LiveHeroData` 接口里加 `name?` 字段**

定位 `export interface LiveHeroData {` (约 1213 行)，在末尾追加：

```typescript
export interface LiveHeroData {
  heroKey: number;
  level: number;
  exp: number;
  /** Localized hero name. Filled by main when locale catalog is loaded; otherwise renderer falls back to heroKey. */
  name?: string;
}
```

- [ ] **Step 4: 在 `AppConfig` 接口里加 `stageMetadata?` 字段**

定位 `export interface AppConfig {` (约 640 行)，在 `resolvedLanguage?: ResolvedLanguage;` 后追加：

```typescript
  resolvedLanguage?: ResolvedLanguage;
  /**
   * Runtime-only: full stageKey → localized name map (30 entries). Filled by
   * main on every `getConfig()` call so the renderer's `boxLootFilters` can
   * match search queries against localized names without importing core/stages.
   * Omitted when locale catalog is not yet loaded.
   */
  stageMetadata?: Record<number, string>;
```

- [ ] **Step 5: 在 `BoxTimerState` 接口里加 `currentStageLabel` 字段**

先 Grep 定位 `BoxTimerState`：

```bash
# 在 vitest 之外，用 Grep 工具搜：
```

定位 `export interface BoxTimerState {`，在 `currentStageKey: number;` 后追加：

```typescript
  currentStageKey: number;
  /** Localized name of `currentStageKey` (e.g. "Pasture"). Filled by main via buildState. */
  currentStageLabel: string;
```

- [ ] **Step 6: 运行 typecheck 验证类型变更不破坏现有代码**

```bash
cd app
pnpm typecheck
```

预期：typecheck 失败，因为 main 端的 buildStats / buildState / getStats 还没填新字段。这是预期的 —— 后续 task 会修复。**先记录当前失败数量作为基线**（如 "X errors"），后续每个 main task 完成后数量应递减。

- [ ] **Step 7: Commit**

```bash
git add app/shared/types.ts
git commit -m "feat(types): add locale-catalog fields to Stats / StageRunHistoryEntry / LiveHeroData / AppConfig / BoxTimerState

- Stats.stageName: localized stage name, filled by main.buildStats
- StageRunHistoryEntry.stageName?: runtime-only, not persisted
- LiveHeroData.name?: runtime-only, filled by main when catalog loaded
- AppConfig.stageMetadata?: 30-entry stageKey → name map for renderer search
- BoxTimerState.currentStageLabel: localized current stage name

All fields are optional or main-filled; renderer treats them as
read-only IPC payload."
```

---

## Task 7: TrackingService 注入 catalog

**Files:**
- Modify: `app/src/main/stats.ts`
- Modify: `app/src/main/services/TrackingService.ts`
- Modify: `app/test/main/trackingService.test.ts`（如存在）

- [ ] **Step 1: 改 `app/src/main/stats.ts` 让 `buildStats` 接受 catalog 参数**

把 `import { heroName } from "../core/heroes";` 改成：

```typescript
import { heroName } from "../core/heroes";
import { stageName } from "../core/stages";
import type { LocaleCatalog } from "../core/localeCatalog";
```

把 `buildStats` 函数签名改成：

```typescript
export function buildStats(
  tracker: XpTracker,
  chestDropTracker: ChestDropTracker,
  boxOpenTracker: BoxOpenTracker,
  dpsTracker: DpsTracker,
  lastSnap: SaveSnapshot | null,
  lastError: string | null,
  statusOverride: string | null = null,
  liveFrame: LiveMemorySnapshot | null = null,
  boxOpenPriceResolver: BoxOpenPriceResolver = null,
  lootStatus: string | null = null,
  catalog: LocaleCatalog | null = null,
): Stats {
```

在 `heroes = liveHeroes ? ... : ...` 的两个分支里，把 `heroName(key)` 改成 `heroName(key, catalog)`、`heroName(h.key)` 改成 `heroName(h.key, catalog)`。

在 `return { ... }` 块里，在 `stageKey,` 后追加 `stageName: stageName(stageKey, catalog),`。

- [ ] **Step 2: 改 `app/src/main/services/TrackingService.ts`**

在 `import` 区追加：

```typescript
import type { LocaleCatalog } from "../../core/localeCatalog";
import { emptyLocaleCatalog } from "../../core/localeCatalog";
```

在 `TrackingService` 类里加字段：

```typescript
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();
```

在 `constructor` 签名末尾追加参数：

```typescript
  constructor(
    onInventory: (snap: InventorySnapshot) => void,
    parseInventorySnapshot?: (text: string, mtime: number) => InventorySnapshot,
    private readonly onStageKey?: (stageKey: number) => void,
    private readonly sessionState?: SessionStateService,
    private readonly onHeroLevelUp?: (events: HeroLevelUpEvent[]) => void,
    private readonly onLiveStageBossDrop?: (stageKey: number) => void,
    private readonly onLiveStageClear?: (
      stageKey: number,
      clearTimeSec: number,
      xpGained: number,
      goldGained: number,
    ) => void,
    private readonly initialCatalog: LocaleCatalog | null = null,
  ) {
    this.onInventory = onInventory;
    this.parseInventorySnapshot = parseInventorySnapshot;
    if (initialCatalog) this.localeCatalog = initialCatalog;
  }
```

加 setter（紧挨 `setAutoClassifyService` 后）：

```typescript
  /**
   * Update the locale catalog (called by appState on language switch). Triggers
   * a re-broadcast so the renderer receives freshly-localized hero names and
   * stage name in the next Stats payload.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
    this.pushStats();
  }
```

改 `getStats`：

```typescript
  getStats() {
    return buildStats(
      this.tracker,
      this.chestDropTracker,
      this.boxOpenTracker,
      this.dpsTracker,
      this.lastSnap,
      this.lastError,
      this.sessionState?.getStatusOverride() ?? null,
      this.lastLiveFrame,
      this.buildBoxOpenPriceResolver(),
      null,
      this.localeCatalog,
    );
  }
```

- [ ] **Step 3: 在 `app/test/main/trackingService.test.ts` 里更新构造函数调用**

Grep `new TrackingService(` 找所有调用点。在每个调用末尾追加 `emptyLocaleCatalog()` 参数（如果该测试不关心 catalog）。例：

```typescript
// 原：
const tracking = new TrackingService(
  (snap) => (lastInventory = snap),
  undefined,
  (stageKey) => boxTimers.setCurrentStageKey(stageKey),
  sessionState,
);
// 改：
const tracking = new TrackingService(
  (snap) => (lastInventory = snap),
  undefined,
  (stageKey) => boxTimers.setCurrentStageKey(stageKey),
  sessionState,
  undefined,
  undefined,
  undefined,
  undefined,
  emptyLocaleCatalog(),
);
```

加 import：

```typescript
import { emptyLocaleCatalog } from "../../src/core/localeCatalog";
```

- [ ] **Step 4: 运行测试 + typecheck**

```bash
cd app
pnpm test -- trackingService
pnpm typecheck
```

预期：trackingService 测试通过；typecheck 错误数应比 Task 6 后减少（TrackingService 相关错误消失）。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/stats.ts app/src/main/services/TrackingService.ts app/test/main/trackingService.test.ts
git commit -m "feat(main): TrackingService accepts LocaleCatalog, populates Stats.stageName + hero name

- buildStats gains optional catalog param, calls stageName(stageKey, catalog)
  and heroName(key, catalog)
- TrackingService stores catalog as instance field, accepts via constructor
  (initialCatalog) and exposes setLocaleCatalog(catalog) for runtime switch
- setLocaleCatalog triggers pushStats so renderer sees localized names
  immediately after language change
- Tests inject emptyLocaleCatalog() to preserve pre-change behavior"
```

---

## Task 8: BoxTimerService 注入 catalog

**Files:**
- Modify: `app/src/main/services/BoxTimerService.ts`
- Modify: `app/test/main/boxTimerService.test.ts`（如存在）

- [ ] **Step 1: 改 `app/src/main/services/BoxTimerService.ts`**

在 import 区追加：

```typescript
import type { LocaleCatalog } from "../../core/localeCatalog";
import { emptyLocaleCatalog } from "../../core/localeCatalog";
```

在 `BoxTimerService` 类里加字段：

```typescript
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();
```

改 `constructor`：

```typescript
  constructor(catalog: LocaleCatalog | null = null) {
    if (catalog) this.localeCatalog = catalog;
  }
```

加 setter：

```typescript
  /**
   * Update the locale catalog (called by appState on language switch). Triggers
   * a re-broadcast so the renderer receives freshly-localized
   * currentStageLabel / farm stage labels in the next BoxTimerState payload.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
    broadcast(IPC.BOX_TIMERS, this.buildState());
  }
```

把 `resolveFarmStage` 与 `buildFarmStageOptions` 里所有 `stageName(...)` 调用改成 `stageName(..., this.localeCatalog)`：

```typescript
    const defaultLabel = defaultKey > 0 ? stageName(defaultKey, this.localeCatalog) : "—";
    // ...
      label: key > 0 ? stageName(key, this.localeCatalog) : "—",
    // ...
      label: stageKey === wikiKey
        ? `${stageName(stageKey, this.localeCatalog)} (recommended)`
        : stageName(stageKey, this.localeCatalog),
```

在 `buildState` 的 `return { ... }` 块里，在 `currentStageKey: this.currentStageKey,` 后追加：

```typescript
      currentStageKey: this.currentStageKey,
      currentStageLabel:
        this.currentStageKey > 0 ? stageName(this.currentStageKey, this.localeCatalog) : "—",
```

- [ ] **Step 2: 更新 `app/test/main/boxTimerService.test.ts`**

把所有 `new BoxTimerService()` 调用改成 `new BoxTimerService(emptyLocaleCatalog())`（或保持 `new BoxTimerService()` 因为参数有默认值 —— 但显式传更清晰）。加 import：

```typescript
import { emptyLocaleCatalog } from "../../src/core/localeCatalog";
```

- [ ] **Step 3: 运行测试 + typecheck**

```bash
cd app
pnpm test -- boxTimer
pnpm typecheck
```

预期：测试通过；typecheck 错误数应继续减少。

- [ ] **Step 4: Commit**

```bash
git add app/src/main/services/BoxTimerService.ts app/test/main/boxTimerService.test.ts
git commit -m "feat(main): BoxTimerService accepts LocaleCatalog, populates currentStageLabel

- Constructor gains optional catalog param, defaults to emptyLocaleCatalog
- setLocaleCatalog re-broadcasts BoxTimerState so renderer sees localized
  stage labels immediately after language change
- buildState fills currentStageLabel via stageName(currentStageKey, catalog)
- resolveFarmStage / buildFarmStageOptions use localized stage names
  for label and recommendation suffix"
```

---

## Task 9: StageRunService 注入 catalog

**Files:**
- Modify: `app/src/main/services/StageRunService.ts`
- Modify: `app/src/core/stageRunTracker.ts`（让 `getStats` 接 catalog 参数）
- Modify: `app/test/main/stageRunService.test.ts`（如存在）

- [ ] **Step 1: 改 `app/src/core/stageRunTracker.ts` 让 `getStats` 接 catalog**

在 import 区追加：

```typescript
import { stageName } from "./stages";
import type { LocaleCatalog } from "./localeCatalog";
```

改 `getStats` 签名：

```typescript
  getStats(catalog: LocaleCatalog | null = null): StageRunStats {
    return {
      history: this.history.slice(-HISTORY_VISIBLE).reverse().map((e) => ({
        ...e,
        stageName: stageName(e.stageKey, catalog),
      })),
      readerRequired: true,
    };
  }
```

注：`stageName` 字段不在 `StageRunHistoryEntry` 持久化格式里，但 TS 类型已经把它标成 `stageName?: string` —— 序列化时（`captureSnapshot`）只取 `history` 的 `wallTime/stageKey/clearTimeSec/xpGained/goldGained`，多余的 `stageName` 字段会被 `JSON.stringify` 包含。为保持磁盘格式不变，在 `captureSnapshot` 里做一次剥离：

```typescript
  captureSnapshot(): StageRunTrackerSnapshot {
    return {
      history: this.history.map((e) => ({
        wallTime: e.wallTime,
        stageKey: e.stageKey,
        clearTimeSec: e.clearTimeSec,
        xpGained: e.xpGained,
        goldGained: e.goldGained,
      })),
    };
  }
```

- [ ] **Step 2: 改 `app/src/main/services/StageRunService.ts`**

在 import 区追加：

```typescript
import type { LocaleCatalog } from "../../core/localeCatalog";
import { emptyLocaleCatalog } from "../../core/localeCatalog";
```

加字段：

```typescript
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();
```

改 `constructor`：

```typescript
  constructor(catalog: LocaleCatalog | null = null) {
    if (catalog) this.localeCatalog = catalog;
  }
```

加 setter：

```typescript
  /**
   * Update the locale catalog (called by appState on language switch). Triggers
   * a re-broadcast so the renderer receives freshly-localized stage names in
   * the next StageRunStats payload.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
    broadcast(IPC.STAGE_RUNS, this.tracker.getStats(this.localeCatalog));
  }
```

把 `getStats()` 调用改成 `this.tracker.getStats(this.localeCatalog)`：

```typescript
  getStats(): StageRunStats {
    return this.tracker.getStats(this.localeCatalog);
  }
```

把 `broadcast(IPC.STAGE_RUNS, this.tracker.getStats());` 改成 `broadcast(IPC.STAGE_RUNS, this.tracker.getStats(this.localeCatalog));`。

- [ ] **Step 3: 更新测试**

在 `app/test/main/stageRunService.test.ts` 与 `app/test/core/stageRunTracker.test.ts`（如存在）里，所有 `getStats()` 调用保持无参（参数有默认值 null），无需改。但 `new StageRunService()` 调用可选改成 `new StageRunService(emptyLocaleCatalog())`（参数有默认值）。

- [ ] **Step 4: 运行测试 + typecheck**

```bash
cd app
pnpm test -- stageRun
pnpm typecheck
```

预期：测试通过；typecheck 错误数继续减少。

- [ ] **Step 5: Commit**

```bash
git add app/src/core/stageRunTracker.ts app/src/main/services/StageRunService.ts app/test/main/stageRunService.test.ts app/test/core/stageRunTracker.test.ts
git commit -m "feat(main): StageRunService accepts LocaleCatalog, populates stageName

- StageRunTracker.getStats(catalog?) fills stageName on each history entry
- StageRunService constructor + setLocaleCatalog(catalog) re-broadcast
- captureSnapshot strips stageName to keep stage_run_history.json format
  unchanged (stageName is runtime-only)"
```

---

## Task 10: InventoryService 注入 catalog

**Files:**
- Modify: `app/src/main/services/InventoryService.ts`

- [ ] **Step 1: 改 `mergeLookupNames` 接 catalog 参数**

在 `app/src/main/services/InventoryService.ts` 顶部 import：

```typescript
import { gameItemName } from "../../core/gamedata";
import type { LocaleCatalog } from "../../core/localeCatalog";
import { emptyLocaleCatalog } from "../../core/localeCatalog";
```

改 `mergeLookupNames`：

```typescript
export function mergeLookupNames(
  gameData: Map<number, GameItem>,
  lookup: Map<number, LookupItem>,
  catalog: LocaleCatalog | null = null,
): Map<number, GameItem> {
  if (lookup.size === 0 && !catalog) return gameData;
  const merged = new Map<number, GameItem>();
  for (const [key, item] of gameData) {
    if (isPlaceholderItemName(item.name)) {
      // First try locale catalog (localized name); fall back to lookup_items.json
      // (English display name); fall back to original placeholder.
      const localized = catalog ? catalog.items[String(item.id)] : undefined;
      if (localized) {
        merged.set(key, { ...item, name: localized });
        continue;
      }
      const lookupItem = lookup.get(key);
      if (lookupItem?.name) {
        merged.set(key, { ...item, name: lookupItem.name });
        continue;
      }
    }
    merged.set(key, item);
  }
  return merged;
}
```

- [ ] **Step 2: 在 `InventoryService` 类里加字段 + setter**

在 `lookupCatalogSource` 字段后追加：

```typescript
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();
```

在 `setLookupCatalog` 后追加 setter：

```typescript
  /**
   * Update the locale catalog (called by appState on language switch). Re-runs
   * `mergeLookupNames` so the worker receives freshly-localized item names,
   * then re-resolves the current inventory so the renderer sees localized
   * names in the next ResolvedInventory payload.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
    this.refreshWorkerState();
    this.resolveAndPushInventory();
  }
```

- [ ] **Step 3: 把 `buildMergedGameDataLookup` 调用改成传 catalog**

```typescript
  private buildMergedGameDataLookup(): Map<number, GameItem> {
    return mergeLookupNames(this.gameData.asMap(), this.lookupCatalog, this.localeCatalog);
  }
```

同样 `getMergedGameItem` 里的 placeholder 路径也接 catalog：

```typescript
  private getMergedGameItem(itemKey: number): GameItem | undefined {
    const item = this.gameData.get(itemKey);
    if (!item) return undefined;
    if (!isPlaceholderItemName(item.name)) return item;
    // Locale catalog first (localized name).
    const localized = this.localeCatalog.items[String(item.id)];
    if (localized) return { ...item, name: localized };
    // Then lookup_items.json (English fallback).
    const lookupItem = this.lookupCatalog.get(item.id);
    if (lookupItem?.name) return { ...item, name: lookupItem.name };
    return item;
  }
```

- [ ] **Step 4: 运行测试 + typecheck**

```bash
cd app
pnpm test -- inventoryService
pnpm typecheck
```

预期：测试通过；typecheck 错误数继续减少。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/services/InventoryService.ts
git commit -m "feat(main): InventoryService accepts LocaleCatalog, localizes placeholder item names

- mergeLookupNames gains optional catalog param; locale catalog takes
  priority over lookup_items.json (English fallback)
- InventoryService.setLocaleCatalog refreshes worker state + re-resolves
  inventory so renderer sees localized names immediately after language
  change
- getMergedGameItem applies same priority: catalog.items[id] → lookup →
  placeholder"
```

---

## Task 11: appState.ts 启动加载 + 语言切换 reload + getConfig 填 stageMetadata

**Files:**
- Modify: `app/src/main/app/appState.ts`

- [ ] **Step 1: 在 `appState.ts` import 区追加**

```typescript
import {
  loadLocaleCatalog,
  emptyLocaleCatalog,
  type LocaleCatalog,
} from "../../core/localeCatalog";
```

- [ ] **Step 2: 加 catalog 状态变量**

在 `let config: AppConfig;` 后追加：

```typescript
let localeCatalog: LocaleCatalog = emptyLocaleCatalog();
```

- [ ] **Step 3: 加 helper 函数 `reloadLocaleCatalog`**

在 `getConfigWithRuntime` 函数后追加：

```typescript
/**
 * Reload the locale catalog for the currently-resolved language and inject
 * it into all services that hold one. Called once on startup (after
 * `initMainI18n`) and again whenever the user changes the UI language.
 *
 * Service `setLocaleCatalog` calls each trigger a re-broadcast, so the
 * renderer receives freshly-localized names in the next Stats / BoxTimerState
 * / StageRunStats / ResolvedInventory payload without any extra fan-out.
 */
function reloadLocaleCatalog(): void {
  const resolved = getConfigWithRuntime().resolvedLanguage;
  // resolveLanguage("auto", app.getLocale()) returns one of en/zh-CN/ja/ko.
  // resolvedLanguage is only set when config.language === "game"; otherwise
  // fall back to the same resolveLanguage call the renderer uses.
  const lang =
    resolved ??
    resolveLanguage(config.language, safeGetLocaleForCatalog());
  localeCatalog = loadLocaleCatalog(lang);
  tracking.setLocaleCatalog(localeCatalog);
  boxTimers.setLocaleCatalog(localeCatalog);
  stageRuns.setLocaleCatalog(localeCatalog);
  inventory.setLocaleCatalog(localeCatalog);
}

function safeGetLocaleForCatalog(): string {
  try {
    return app.getLocale();
  } catch {
    return "en-US";
  }
}
```

注：`app` 来自 `electron`，需在文件顶部 `import { BrowserWindow, app, dialog, ... } from "electron";` 调整。

- [ ] **Step 4: 在 `startTracking` 里调用 `reloadLocaleCatalog`**

在 `tracking.setLookupPriceSnapshot(lookupPrices.getSnapshot());` 之后、`lookupPrices.setOnSnapshotUpdated(...)` 之前插入：

```typescript
  // Load the locale catalog for the current language and inject into
  // services. Called after `tracking.start()` so all services exist.
  reloadLocaleCatalog();
```

- [ ] **Step 5: 在 `onLanguageChanged` 回调里调用 `reloadLocaleCatalog`**

定位 `onLanguageChanged: (newLanguage) => { ... }`，改成：

```typescript
          onLanguageChanged: (newLanguage) => {
            changeLanguage(newLanguage);
            reloadLocaleCatalog();
            rebuildTrayMenu(getAppServices());
          },
```

- [ ] **Step 6: 改 `getConfigWithRuntime` 填 `stageMetadata`**

```typescript
function getConfigWithRuntime(): AppConfig {
  const base = normalizeConfigFromRaw(config);
  if (base.language !== "game") {
    // Still attach stageMetadata so renderer's boxLootFilters can search.
    return { ...base, stageMetadata: buildStageMetadata(localeCatalog) };
  }
  const gameLang = readGameLanguage();
  if (!gameLang) {
    return { ...base, stageMetadata: buildStageMetadata(localeCatalog) };
  }
  const resolved: ResolvedLanguage = resolveLanguage(base.language, "", gameLang);
  return {
    ...base,
    resolvedLanguage: resolved,
    stageMetadata: buildStageMetadata(localeCatalog),
  };
}

/**
 * Build the runtime-only stageMetadata map (30 entries) for the renderer's
 * boxLootFilters text-matching. Covers all 4 difficulties × 30 stages, but
 * since stageName produces the same string for all 4 difficulties (catalog
 * key drops difficulty), the 30 unique stageKey × 4 difficulties collapse to
 * 30 distinct stageKeys per difficulty range — we emit the full 120-entry
 * map so any stageKey the renderer encounters has a localized string.
 */
function buildStageMetadata(catalog: LocaleCatalog): Record<number, string> {
  const result: Record<number, string> = {};
  for (let diff = 1; diff <= 4; diff++) {
    for (let act = 1; act <= 3; act++) {
      for (let stage = 1; stage <= 10; stage++) {
        const stageKey = diff * 1000 + act * 100 + stage;
        result[stageKey] = stageName(stageKey, catalog);
      }
    }
  }
  return result;
}
```

注：`stageName` 需在 `appState.ts` 顶部 import：

```typescript
import { stageName } from "../../core/stages";
```

- [ ] **Step 7: 运行 typecheck + 启动测试**

```bash
cd app
pnpm typecheck
pnpm test
```

预期：typecheck 应全部通过（所有新字段都被 main 端填充）。`pnpm test` 可能有少量已存在的 pre-existing 失败，不应新增失败。

- [ ] **Step 8: Commit**

```bash
git add app/src/main/app/appState.ts
git commit -m "feat(main): appState loads LocaleCatalog on startup + language switch

- reloadLocaleCatalog() loads catalog for resolved language and injects
  into TrackingService / BoxTimerService / StageRunService / InventoryService
- Called once after tracking.start() and again on onLanguageChanged
- getConfigWithRuntime attaches stageMetadata (120-entry stageKey → name
  map covering 4 difficulties × 30 stages) so renderer's boxLootFilters
  can match search queries against localized names without importing
  core/stages"
```

---

## Task 12: renderer 调用点更新（5 处文件）

**Files:**
- Modify: `app/src/renderer/Overlay.tsx`
- Modify: `app/src/renderer/BoxTracker.tsx`
- Modify: `app/src/renderer/tabs/Live.tsx`
- Modify: `app/src/renderer/tabs/LiveMemoryDiagnostics.tsx`
- Modify: `app/src/renderer/components/live/StageRunPanel.tsx`

- [ ] **Step 1: `app/src/renderer/Overlay.tsx`**

定位 `import { stageName } from "../core/stages";`，删除该行。

定位 `{stageName(stats.stageKey)}` (约 203 行)，改成：

```tsx
              {stats.stageName}
```

- [ ] **Step 2: `app/src/renderer/BoxTracker.tsx`**

定位 `import { stageName } from "../core/stages";`，删除该行。

定位 `const currentLabel = stageName(state.currentStageKey);` (约 96 行)，改成：

```tsx
  const currentLabel = state.currentStageLabel ?? "—";
```

- [ ] **Step 3: `app/src/renderer/tabs/Live.tsx`**

定位 `import { stageName } from "../../core/stages";`，删除该行。

定位 `{stageName(stage?.stageKey ?? stats.stageKey)}` (约 422 行)，改成：

```tsx
                  {stage?.stageName ?? stats.stageName}
```

定位 `content: stageName(e.stageKey),` (约 552 行)，改成：

```tsx
                      content: e.stageName ?? "",
```

注：`e` 是 `StageRunHistoryEntry`，已加 `stageName?` 字段。

- [ ] **Step 4: `app/src/renderer/tabs/LiveMemoryDiagnostics.tsx`**

定位 `import { heroName } from "../../core/heroes";`，删除该行。

定位 `name: heroName(String(h.heroKey)),` (约 127 行)，改成：

```tsx
                    name: h.name ?? String(h.heroKey),
```

- [ ] **Step 5: `app/src/renderer/components/live/StageRunPanel.tsx`**

定位 `import { stageName } from "../../../core/stages";`，删除该行。

定位 `name={stageName(entry.stageKey)}` (约 50 行)，改成：

```tsx
                  name={entry.stageName ?? String(entry.stageKey)}
```

- [ ] **Step 6: 运行 typecheck + test:dom**

```bash
cd app
pnpm typecheck
pnpm test:dom
```

预期：typecheck 全过；test:dom 可能有少量 pre-existing 失败，不应新增。如有组件测试用到了 `stageName(...)`，改为传 mock 的 `stats.stageName` / `entry.stageName` 字段。

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/Overlay.tsx app/src/renderer/BoxTracker.tsx app/src/renderer/tabs/Live.tsx app/src/renderer/tabs/LiveMemoryDiagnostics.tsx app/src/renderer/components/live/StageRunPanel.tsx
git commit -m "refactor(renderer): read localized names from IPC fields, drop core/stages + core/heroes imports

- Overlay: stats.stageName (was stageName(stats.stageKey))
- BoxTracker: state.currentStageLabel (was stageName(state.currentStageKey))
- Live: stage?.stageName ?? stats.stageName, e.stageName (was stageName(...))
- LiveMemoryDiagnostics: h.name ?? String(h.heroKey) (was heroName(...))
- StageRunPanel: entry.stageName ?? String(entry.stageKey)

Renderer is now strict main-only read — no locale catalog import, all
localized names come from IPC payload fields."
```

---

## Task 13: boxLootFilters 接 stageMetadata

**Files:**
- Modify: `app/src/renderer/lib/boxLootFilters.ts`
- Modify: `app/test/renderer/lib/boxLootFilters.test.ts`（如存在）
- 修改调用 `stageMatchesQuery` / `filterFirstDropStages` / `filterAndSortBoxStages` 的组件

- [ ] **Step 1: 改 `app/src/renderer/lib/boxLootFilters.ts`**

删除 `import { stageName } from "../../core/stages";`。

改 `stageMatchesQuery` 签名：

```typescript
export function stageMatchesQuery(
  stageKey: number,
  displayName: string,
  query: string,
  stageMetadata: Record<number, string>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const compact = (stageMetadata[stageKey] ?? "").toLowerCase();
  const difficulty = compact.split(" ")[0] ?? "";
  return displayName.toLowerCase().includes(q) || compact.includes(q) || difficulty.includes(q);
}
```

改 `filterFirstDropStages`：

```typescript
export function filterFirstDropStages(
  stages: LookupBoxFirstDropStageRef[],
  query: string,
  stageMetadata: Record<number, string>,
): LookupBoxFirstDropStageRef[] {
  return stages.filter((row) =>
    stageMatchesQuery(row.stageKey, row.stageName, query, stageMetadata),
  );
}
```

改 `filterAndSortBoxStages`：

```typescript
export function filterAndSortBoxStages(
  stages: LookupBoxStageRef[],
  state: BoxStageFilterState,
  stageMetadata: Record<number, string>,
): LookupBoxStageRef[] {
  const q = state.query.trim().toLowerCase();
  let rows = stages.filter((row) =>
    stageMatchesQuery(row.stageKey, row.stageName, q, stageMetadata),
  );

  const dir = state.sortDir === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    let cmp: number;
    if (state.sortKey === "name") {
      cmp = a.stageName.localeCompare(b.stageName);
    } else {
      cmp = a.spawnPct - b.spawnPct;
    }
    if (cmp === 0 && state.sortKey !== "spawnPct") cmp = a.stageKey - b.stageKey;
    return cmp * dir;
  });
  return rows;
}
```

- [ ] **Step 2: 找到所有调用 `filterFirstDropStages` / `filterAndSortBoxStages` 的组件**

```bash
# 用 Grep 工具：
```

Grep pattern: `filterFirstDropStages|filterAndSortBoxStages|stageMatchesQuery`

预期命中：`BoxDetailCard.tsx` 或类似组件 + 测试文件。

在每个调用点，从 `useConfig()` 拿 `stageMetadata` 并传入。例如：

```tsx
// 在 BoxDetailCard.tsx 或调用组件里：
const { stageMetadata } = useConfig();
const filtered = filterAndSortBoxStages(stages, state, stageMetadata ?? {});
```

如果该组件没有 `useConfig`，需要从父组件传 `stageMetadata` prop。优先用 `useConfig()` 直接获取（renderer 已有 `TbhProvider` 提供 config）。

- [ ] **Step 3: 更新 `app/test/renderer/lib/boxLootFilters.test.ts`**

每个 `stageMatchesQuery` / `filterFirstDropStages` / `filterAndSortBoxStages` 调用末尾追加 `stageMetadata` 参数。例：

```typescript
// 原：
stageMatchesQuery(3205, "Pasture", "pasture");
// 改：
stageMatchesQuery(3205, "Pasture", "pasture", { 3205: "Pasture" });
```

如测试文件不存在，跳过此步骤。

- [ ] **Step 4: 运行 typecheck + test:dom**

```bash
cd app
pnpm typecheck
pnpm test:dom
```

预期：typecheck 全过；test:dom 失败数不增加。

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/lib/boxLootFilters.ts app/src/renderer/components/lookup/BoxDetailCard.tsx app/test/renderer/lib/boxLootFilters.test.ts
git commit -m "refactor(renderer): boxLootFilters accepts stageMetadata, drops core/stages import

- stageMatchesQuery / filterFirstDropStages / filterAndSortBoxStages gain
  stageMetadata param (Record<number, string>) sourced from useConfig()
- Call sites in BoxDetailCard pass stageMetadata from useConfig()
- Removes the last renderer import of core/stages — renderer is now fully
  main-only read for localized names"
```

---

## Task 14: 文档更新

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 `docs/ARCHITECTURE.md`**

Grep `## Internationalization` 找到 i18n 段落，在末尾追加一段：

```markdown
### Locale catalog (dynamic game data)

Stage / hero / item / difficulty names are not UI strings (covered by i18next
namespaces) but data-driven strings sourced from the game's Unity Localization
bundles. The companion extracts them offline via
`scripts/extract_locale_catalog.py` (UnityPy) into 4 JSON files under `data/`
(`locale_strings_<lang>.json` for en / zh-CN / ja / ko).

At runtime, `core/localeCatalog.ts` loads the catalog for the resolved
language via `loadLocaleCatalog(lang)` (cached per-language for process
lifetime). Services receive the catalog via constructor injection
(`TrackingService` / `BoxTimerService` / `StageRunService` / `InventoryService`)
and expose `setLocaleCatalog(catalog)` for runtime language switches — each
call triggers a re-broadcast so the renderer sees localized names in the
next IPC payload without polling.

Renderer is **strict main-only read**: it never imports `core/localeCatalog`
or `core/stages` / `core/heroes`. All localized names come from IPC payload
fields:

| Field | Source |
|-------|--------|
| `Stats.stageName` | `stageName(stats.stageKey, catalog)` in `buildStats` |
| `Stats.heroes[].name` | `heroName(key, catalog)` in `buildStats` |
| `StageRunHistoryEntry.stageName?` | `stageName(entry.stageKey, catalog)` in `StageRunTracker.getStats` |
| `LiveHeroData.name?` | Filled by main when locale catalog is loaded |
| `BoxTimerState.currentStageLabel` | `stageName(currentStageKey, catalog)` in `buildState` |
| `AppConfig.stageMetadata?` | 120-entry stageKey → name map for renderer search |

Fallback chain when the catalog misses (game update adds new keys): catalog
→ English hardcoded (`HERO_NAMES` / `DIFFICULTIES`) → raw key / placeholder.
```

- [ ] **Step 2: 更新 `CHANGELOG.md`**

在 `## [Unreleased]` 段加 bullets（如不存在则在该文件顶部新建 `## [Unreleased]`）：

```markdown
## [Unreleased]

### Added

- Stage / hero / item / difficulty names now follow the UI language. Names
  are extracted from the game's Unity Localization bundles and bundled as
  4 JSON files (`data/locale_strings_<lang>.json`). The companion reads them
  at runtime via a locale catalog injected into main services; renderer
  receives localized names through existing IPC streams (`Stats.stageName`,
  `StageRunHistoryEntry.stageName`, `LiveHeroData.name`,
  `BoxTimerState.currentStageLabel`, `AppConfig.stageMetadata`).

- Language switch now re-broadcasts all stats / box timers / stage runs /
  inventory with freshly-localized names — no app restart needed.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: 文档化 locale catalog 架构与 CHANGELOG 条目

ARCHITECTURE.md Internationalization 段新增 Locale catalog 子段,
说明数据流(离线提取 → core 加载 → service 注入 → IPC 字段)与
renderer 严格仅 main 读策略。

CHANGELOG [Unreleased] 新增 stage/hero/item 名称本地化 bullets。"
```

---

## Task 15: pnpm qa + 修复 breakage

**Files:**
- 任意被 qa 暴露的问题文件

- [ ] **Step 1: 运行完整 qa**

```bash
cd app
pnpm qa
```

预期：可能暴露 typecheck / lint / format / test / build / bundle guards 问题。

- [ ] **Step 2: 修复 typecheck 错误**

逐个修，不批量。常见可能：

- main 服务的测试构造函数缺 `emptyLocaleCatalog()` 参数
- renderer 组件 mock 缺新字段（`stats.stageName` / `entry.stageName` / `state.currentStageLabel`）
- `boxLootFilters` 测试调用缺 `stageMetadata` 参数

- [ ] **Step 3: 修复 lint 错误**

```bash
cd app
pnpm lint:fix
```

- [ ] **Step 4: 修复 format**

```bash
cd app
pnpm format
```

- [ ] **Step 5: 修复测试失败**

```bash
cd app
pnpm test
pnpm test:dom
```

如有组件 snapshot 失败（因新增 `stageName` 字段），更新 snapshot：

```bash
pnpm test:dom -- -u
```

- [ ] **Step 6: 再次运行 qa 确认全绿**

```bash
cd app
pnpm qa
```

预期：全绿，或仅有 pre-existing 失败（数量与基线一致）。

- [ ] **Step 7: Commit 修复**

```bash
git add -A
git commit -m "chore: pnpm qa 修复 — locale catalog 集成遗留

修复类型/测试/snapshot 问题:
- main 服务测试注入 emptyLocaleCatalog()
- renderer 组件 mock 填充 stageName / currentStageLabel / stageMetadata
- boxLootFilters 测试调用补 stageMetadata 参数"
```

---

## 验收标准

完成所有 15 个 task 后，应达到：

1. **数据**：`data/locale_strings_{en,zh-CN,ja,ko}.json` 4 份文件存在，每份含 `items` (~511) + `stages` (~30) + `heroes` (6) + `difficulties` (4)。
2. **core**：`stageName` / `heroName` / `gameItemName` 都接 `catalog` 参数；`core/localeCatalog.ts` 提供 `LocaleCatalog` 类型 + `loadLocaleCatalog` + `emptyLocaleCatalog`。
3. **shared types**：`Stats.stageName` / `StageRunHistoryEntry.stageName?` / `LiveHeroData.name?` / `BoxTimerState.currentStageLabel` / `AppConfig.stageMetadata?` 已加。
4. **main**：4 个 service 通过构造函数注入 catalog，`setLocaleCatalog` 在语言切换时被调用；`appState.startTracking` 加载 catalog，`getConfigWithRuntime` 填 `stageMetadata`。
5. **renderer**：5 处文件不再 import `core/stages` 或 `core/heroes`，所有名字从 IPC 字段拿；`boxLootFilters` 接 `stageMetadata`。
6. **测试**：`pnpm test` + `pnpm test:dom` 不新增失败。
7. **qa**：`pnpm qa` 全绿（或仅有基线 pre-existing 失败）。
8. **文档**：`docs/ARCHITECTURE.md` 有 locale catalog 段落；`CHANGELOG.md` `[Unreleased]` 有 bullets。

## 自审记录

- **Spec coverage**：spec 8 个章节全覆盖。Task 1 = 数据提取；Task 2-5 = core 层；Task 7-11 = main 层（含 appState）；Task 6 = shared types；Task 12-13 = renderer；Task 14 = 文档；Task 15 = qa。spec 提到的测试计划分散到对应 task（每个 task 都有测试 step）。
- **Placeholder scan**：无 TBD/TODO/待补；每个 step 都有完整代码。
- **Type consistency**：`LocaleCatalog` / `loadLocaleCatalog` / `emptyLocaleCatalog` / `setLocaleCatalog` 在所有 task 里签名一致；`Stats.stageName` / `StageRunHistoryEntry.stageName?` / `LiveHeroData.name?` / `BoxTimerState.currentStageLabel` / `AppConfig.stageMetadata?` 字段名贯穿 types + main + renderer；`stageMatchesQuery` 新参数 `stageMetadata: Record<number, string>` 在定义与调用一致。
- **Ambiguity**：stageKey 编码（1+1+2 位，catalog key 是 `<act><stage>` 4 位）、catalog fallback 链（catalog → English 硬编码 → raw key/placeholder）、`stageMetadata` 120 条（4 difficulties × 30 stages）已明确。
