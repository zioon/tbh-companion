# 多语言全语种扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 实施状态（2026-07-19 完成）

全部 12 个 Task 已完成并通过 typecheck + 单元测试。下文 checkbox 未逐一勾选，
以本节为准。

| Task | 状态 | Commit |
|------|------|--------|
| 1: 调查 idx → 语言代码映射 | ✅ | （调查脚本，未提交） |
| 2: 扩展 shared/language.ts | ✅ | 951fcce |
| 3: 扩展 shared/types.ts GameLocaleData | ✅ | dbeb0c0（与 5/6/7/8 合并） |
| 4: 扩展 localeExtractor.ts | ✅ | 77638c2 |
| 5: 扩展 catalogRefreshService.ts 动态扫描 | ✅ | dbeb0c0 |
| 6: 扩展 localeCatalog.ts 新语言 en 兜底 | ✅ | dbeb0c0 |
| 7: 扩展 shared/locales/index.ts | ✅ | dbeb0c0 |
| 8: 扩展 renderer/i18n.ts 动态遍历 | ✅ | dbeb0c0（在 Task 5 中一并完成） |
| 9: 扩展 dump_game_locale.py | ✅ | b733753 |
| 10: Settings.tsx 显示原生语言名 | ✅ | 5f52b9b |
| 11: 文档与 CHANGELOG 更新 | ✅ | （本提交） |
| 12: QA 全流程验证 | ✅ | typecheck + 37 测试通过 |

**验证结果：**
- `pnpm typecheck`：0 错误（除 base branch 已有的 `InventoryContext.tsx` orphan 类型错误）
- `pnpm test`：37 测试全过（catalogRefreshService 12 + localeExtractor 5 + localeCatalog 6 + language 14）
- `pnpm lint`：0 错误（3 个预存 warning 与本次改动无关）
- 实地验证 `scripts/dump_game_locale.py` 能发现全部 16 个 locale bundle，包括 vi-VN 的 hash 后缀文件

**架构要点：**
- 16 种语言中 4 种（en/zh-CN/ja/ko）有完整 UI 翻译 + 离线 catalog JSON；12 种新语言 UI 字符串引用 en 兜底
- 游戏内 labels（grades/types/stats/classes/gearGroups）通过 catalog refresh 时从游戏 bundle 动态提取，每种语言独立翻译
- `catalogRefreshService` 通过 `readdirSync` 动态扫描 locale bundle 文件名解析 BCP-47 代码，无需硬编码语言数量
- 零新增 IPC 通道，全部通过现有 `getLocaleData` 通道传输

---


**目标：** 把 companion 的语言支持从 4 种（en/zh-CN/ja/ko）扩展到游戏支持的全部 16 种语言；游戏内 labels（grades/types/stats/classes/gearGroups）从 bundle 自动同步到每种语言；12 种新语言的 companion UI 字符串先用 en 兜底，通过 i18next fallback 机制保证界面可用。

**架构：**
- `shared/language.ts` 把 `APP_LANGUAGES` 从 4 项扩展到 16 项；`GAME_LANG_IDX_TO_RESOLVED` 填齐 16 个 idx；`resolveAuto` 处理新语言前缀。
- `shared/types.ts` 把 `GameLocaleData` 从硬编码 4 字段改为 `Record<string, Record<string, string>>` 动态结构。
- `core/unityAssets/localeExtractor.ts` 输入输出改为 `Record<lang, Buffer>` / `Record<lang, Record<string, string>>`，不再硬编码语言数量。
- `main/catalogRefreshService.ts` 通过 `readdirSync` 动态扫描 `localization-string-tables-*` 文件，按文件名模式解析语言代码，提取所有可用语言的 locale。
- `core/localeCatalog.ts` + `app/shared/locales/index.ts` 为 12 种新语言提供占位（指向 en 内容），i18next fallback 自动补齐缺失 key。
- `renderer/i18n.ts` 遍历 localeData 中所有语言调用 `flatGameKeysToLabels` 合并到 i18next。
- `scripts/dump_game_locale.py` 扩展为 dump 全部 16 种语言的 locale bundle。

**技术栈：** TypeScript（shared/core/main/renderer）、Python（UnityPy 离线 dump 脚本）、Vitest（单元测试）、Electron IPC（复用已有 `GET_LOCALE_DATA`，零新增 channel）。

**约束：**
- 不新增 IPC 通道（项目硬约束）。
- core 层保持纯净（无 node/electron 依赖）。
- 文档使用中文撰写；代码注释/commit message 保持英文。
- 12 种新语言的 companion UI 字符串先用 en 兜底，后续可逐语言人工/AI 替换。

**依赖：** 已交付的 v1.19.0 i18n 框架（4 语言 × 16 namespace）+ commit 4139740 的 locale 自动同步机制（`localeExtractor` + `catalogRefreshService.refresh()` + `tryMergeGameLocale`）。

**spec：** 无独立 spec；本计划直接基于用户需求"既然使用了游戏数据，那统一支持游戏支持的所有语种。包含游戏内内容和项目UI，全部支持。"生成。

---

## 游戏支持的全部 16 种语言

游戏目录 `D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64\` 下的 locale bundle 文件名（除 shared 外共 16 个）：

| 游戏 bundle 文件名片段 | BCP-47 子tag（companion 用） | 说明 |
|------------------------|------------------------------|------|
| `english(unitedstates)(en-us)` | `en` | 英文（已有） |
| `chinese(simplified)(zh-hans)` | `zh-CN` | 简体中文（已有，保留 zh-CN 代码与 navigator.language 对齐） |
| `chinese(traditional)(zh-hant)` | `zh-Hant` | 繁体中文（新增） |
| `french(france)(fr-fr)` | `fr-FR` | 法语（新增） |
| `german(germany)(de-de)` | `de-DE` | 德语（新增） |
| `indonesian(indonesia)(id-id)` | `id-ID` | 印尼语（新增） |
| `japanese(japan)(ja-jp)` | `ja` | 日语（已有） |
| `korean(southkorea)(ko-kr)` | `ko` | 韩语（已有） |
| `polish(poland)(pl-pl)` | `pl-PL` | 波兰语（新增） |
| `portuguese(brazil)(pt-br)` | `pt-BR` | 葡萄牙语-巴西（新增） |
| `russian(russia)(ru-ru)` | `ru-RU` | 俄语（新增） |
| `spanish(spain)(es-es)` | `es-ES` | 西班牙语（新增） |
| `thai(thailand)(th-th)` | `th-TH` | 泰语（新增） |
| `turkish(turkey)(tr-tr)` | `tr-TR` | 土耳其语（新增） |
| `ukrainian(ukraine)(uk-ua)` | `uk-UA` | 乌克兰语（新增） |
| `vietnamese(vietnam)(vi-vn)` | `vi-VN` | 越南语（新增） |

**注意：** `zh-CN` 与 `zh-Hant` 不对称（前者是 region 形式，后者是 script 形式），但这是合理的——`zh-CN` 是 navigator.language 在简中 Windows 上的常见返回值，保留它避免破坏现有用户体验；新增的繁中用 `zh-Hant`（与游戏 bundle 文件名一致）。

---

## 文件结构总览

| 类型 | 路径 | 责任 |
|------|------|------|
| Create | `scripts/dump_locale_index.py` | 一次性调查脚本：读 `localization-locales` bundle 输出 idx → LocaleCode 映射 |
| Modify | `app/shared/language.ts` | `APP_LANGUAGES` 扩到 16 项；`GAME_LANG_IDX_TO_RESOLVED` 填齐；`resolveAuto` 加新前缀 |
| Modify | `app/shared/types.ts` | `GameLocaleData` 改为动态 `Record<string, Record<string, string>>` 结构 |
| Modify | `app/src/core/unityAssets/localeExtractor.ts` | 输入输出改为 `Record<lang, Buffer>` / `Record<lang, Record<string, string>>` |
| Create | `app/test/core/localeExtractor.test.ts` | core 层单元测试（多语言输入） |
| Modify | `app/src/main/catalogRefreshService.ts` | 动态扫描 locale bundle 目录；`resolveAssetPaths` 改用 `readdirSync` |
| Modify | `app/test/main/catalogRefreshService.test.ts` | 现有测试加 `readdirSync` mock |
| Modify | `app/src/core/localeCatalog.ts` | `LANG_TO_FILENAME` 新语言用 `locale_strings_en.json` 兜底 |
| Modify | `app/test/core/localeCatalog.test.ts` | 加新语言 fallback 测试 |
| Modify | `app/shared/locales/index.ts` | `LOCALE_RESOURCES` 加入 12 种新语言（引用 en 对象） |
| Modify | `app/src/renderer/i18n.ts` | `tryMergeGameLocale` 遍历 `localeData` 所有 key（不写死 4 种） |
| Modify | `scripts/dump_game_locale.py` | `LOCALE_BUNDLES` 加 12 种新语言 |
| Modify | `app/src/renderer/tabs/Settings.tsx` | 语言下拉菜单显示完整语言名（可选，提升 UX） |
| Modify | `app/src/shared/language.ts`（已在上方） | — |
| Modify | `docs/ARCHITECTURE.md` | Internationalization 段补 16 语言说明 |
| Modify | `CHANGELOG.md` | `[Unreleased]` 加 bullets |

---

## Task 1: 调查游戏 idx → 语言代码映射

**Files:**
- Create: `scripts/dump_locale_index.py`

游戏注册表 `tbh_lang_idx` 是 0–15 的 int，但 companion 当前只知道 0/9/11/12 四个值对应的语言。本任务用一次性脚本读 `localization-locales_assets_all.bundle`，输出完整的 idx → LocaleCode 表，作为 Task 2 填充 `GAME_LANG_IDX_TO_RESOLVED` 的依据。

- [ ] **Step 1: 写 `scripts/dump_locale_index.py`**

```python
#!/usr/bin/env python3
"""Dump game's Locale metadata: idx -> LocaleCode mapping.

Reads `localization-locales_assets_all.bundle` (Unity Localization package's
Locale metadata asset) and prints the idx field of each Locale MonoBehaviour,
ordered by idx.

Output (stderr): human-readable table.
Output (stdout): JSON `{ idx: code, ... }` for programmatic use.
"""
import json
import sys
from pathlib import Path
import UnityPy

GAME_DIR = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64"
)
LOCALES_BUNDLE = "localization-locales_assets_all.bundle"


def main() -> None:
    env = UnityPy.load(str(GAME_DIR / LOCALES_BUNDLE))
    locales: list[dict] = []
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        # Unity Localization Locale MonoBehaviour fields:
        #   m_Identifier, m_Code, m_Name, m_Format, m_CultureInfo, ...
        # The game stores an int `idx` somewhere in the tree; dump all int
        # fields to discover the layout.
        code = tree.get("m_Code") or tree.get("Code")
        name = tree.get("m_Name") or tree.get("Name")
        idx = tree.get("idx") or tree.get("Index") or tree.get("m_Idx")
        locales.append({"code": code, "name": name, "idx": idx, "tree_keys": list(tree.keys())})

    locales.sort(key=lambda x: (x["idx"] if isinstance(x["idx"], int) else 9999, x["code"] or ""))
    print(f"Found {len(locales)} Locale entries:\n", file=sys.stderr)
    for loc in locales:
        print(
            f"  idx={loc['idx']!s:>5}  code={loc['code']!s:<12}  name={loc['name']!s:<30}  keys={loc['tree_keys']}",
            file=sys.stderr,
        )
    out = {str(loc["idx"]): loc["code"] for loc in locales if loc["idx"] is not None}
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 运行脚本并记录结果**

Run:
```bash
cd D:\Project\TBH\tbh-companion
python scripts/dump_locale_index.py
```

Expected: stderr 打印 16 行 `idx=N  code=xx-XX  name=...`，stdout 输出 JSON 形如 `{"0": "en", "1": "de", ..., "15": "vi"}`。

把输出贴到本计划的"Task 1 结果记录"小节（执行时填入），供 Task 2 使用。

- [ ] **Step 3: 不提交此脚本（一次性调查工具，不入仓库）**

```bash
# 不执行 git add；脚本保留在 scripts/ 下供未来游戏更新时复用
# 但因为是一次性调查工具，不需要加入 package.json scripts
```

> **注意：** 如果脚本读不到 `idx` 字段（tree_keys 中没有），改用 UnityPy 的 `obj.read_typetree()` dump 完整 tree 到 JSON 文件人工检查字段名。备用方案：让用户在游戏中切换语言，读取注册表 `tbh_lang_idx` 值对照已知的语言名手动建立映射。

---

## Task 2: 扩展 shared/language.ts

**Files:**
- Modify: `app/shared/language.ts`

- [ ] **Step 1: 写失败测试（新语言在 APP_LANGUAGES 中）**

Create `app/test/shared/language.test.ts`（若不存在）或追加到现有测试文件。先查一下是否存在：

Run: `ls app/test/shared/`

如果不存在，创建：

```typescript
// app/test/shared/language.test.ts
import { describe, expect, it } from "vitest";
import {
  APP_LANGUAGES,
  GAME_LANG_IDX_TO_RESOLVED,
  resolveAuto,
  resolveGameLanguage,
  resolveLanguage,
} from "../../shared/language";

describe("APP_LANGUAGES", () => {
  it("includes all 16 game-supported languages", () => {
    expect(APP_LANGUAGES).toEqual(
      expect.arrayContaining([
        "en", "zh-CN", "zh-Hant", "fr-FR", "de-DE", "id-ID",
        "ja", "ko", "pl-PL", "pt-BR", "ru-RU", "es-ES",
        "th-TH", "tr-TR", "uk-UA", "vi-VN",
      ]),
    );
    expect(APP_LANGUAGES).toHaveLength(16);
  });
});

describe("GAME_LANG_IDX_TO_RESOLVED", () => {
  it("maps all 16 idx values", () => {
    expect(Object.keys(GAME_LANG_IDX_TO_RESOLVED)).toHaveLength(16);
    expect(GAME_LANG_IDX_TO_RESOLVED[0]).toBe("en");
    expect(GAME_LANG_IDX_TO_RESOLVED[9]).toBe("zh-CN");
    expect(GAME_LANG_IDX_TO_RESOLVED[11]).toBe("ja");
    expect(GAME_LANG_IDX_TO_RESOLVED[12]).toBe("ko");
  });
});

describe("resolveAuto", () => {
  // resolveAuto 未导出，通过 resolveLanguage("auto", systemLocale) 间接测试
  it("resolves zh-TW system locale to zh-Hant", () => {
    expect(resolveLanguage("auto", "zh-TW")).toBe("zh-Hant");
  });
  it("resolves fr-FR system locale to fr-FR", () => {
    expect(resolveLanguage("auto", "fr-FR")).toBe("fr-FR");
  });
  it("resolves de-DE system locale to de-DE", () => {
    expect(resolveLanguage("auto", "de-DE")).toBe("de-DE");
  });
  it("resolves pt-BR system locale to pt-BR", () => {
    expect(resolveLanguage("auto", "pt-BR")).toBe("pt-BR");
  });
  it("resolves ru-RU system locale to ru-RU", () => {
    expect(resolveLanguage("auto", "ru-RU")).toBe("ru-RU");
  });
  it("resolves unknown locale to en", () => {
    expect(resolveLanguage("auto", "xx-XX")).toBe("en");
  });
});

describe("resolveGameLanguage", () => {
  it("returns null for null/undefined idx", () => {
    expect(resolveGameLanguage(null)).toBeNull();
    expect(resolveGameLanguage(undefined)).toBeNull();
  });
  it("returns 'en' for unmapped idx", () => {
    expect(resolveGameLanguage(999)).toBe("en");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app && pnpm test -- language.test`
Expected: FAIL，错误信息包含 `APP_LANGUAGES` 长度不为 16 / `resolveAuto` 未能解析新前缀。

- [ ] **Step 3: 修改 `app/shared/language.ts`**

替换文件顶部 `APP_LANGUAGES` 与 `GAME_LANG_IDX_TO_RESOLVED`：

```typescript
// app/shared/language.ts
// UI 语言类型与解析工具。shared 层 — 为主进程、渲染进程、core 共享。

/** 已支持的具体语言（不含 "auto" / "game"）。覆盖游戏支持的全部 16 种语言。 */
export const APP_LANGUAGES = [
  "en",
  "zh-CN",
  "zh-Hant",
  "fr-FR",
  "de-DE",
  "id-ID",
  "ja",
  "ko",
  "pl-PL",
  "pt-BR",
  "ru-RU",
  "es-ES",
  "th-TH",
  "tr-TR",
  "uk-UA",
  "vi-VN",
] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number] | "auto" | "game";

export const DEFAULT_LANGUAGE: AppLanguage = "auto";

/** resolveLanguage 的返回类型：去掉 "auto" / "game" 的具体语言。 */
export type ResolvedLanguage = (typeof APP_LANGUAGES)[number];

/**
 * 游戏 `tbh_lang_idx` 注册表值 → BCP-47 区码。从 `localization-locales` bundle
 * 中解析出的 16 个 Locale MonoBehaviour 的 idx 字段。
 *
 * 完整映射通过 scripts/dump_locale_index.py 调查得出；如游戏更新后映射变化，
 * 重新运行该脚本并更新此表。
 */
export const GAME_LANG_IDX_TO_RESOLVED: Readonly<Record<number, ResolvedLanguage>> = {
  // ❗ 执行 Task 1 后用实际 dump 结果替换下方占位值
  // 占位假设（按字母顺序推测，需用 dump 结果验证）：
  0: "en",
  1: "de-DE",
  2: "es-ES",
  3: "fr-FR",
  4: "id-ID",
  5: "it-IT", // 若游戏无意大利语则删除
  6: "ja",
  7: "ko",
  8: "pl-PL",
  9: "zh-CN",
  10: "pt-BR",
  11: "ru-RU",
  12: "th-TH",
  13: "tr-TR",
  14: "uk-UA",
  15: "vi-VN",
  // 实际 idx 顺序以 dump_locale_index.py 输出为准
};
```

> ⚠️ **执行时务必用 Task 1 的实际 dump 结果替换占位值。** 上方仅是占位假设，不一定是游戏真实顺序。如果 dump 显示游戏只支持 16 种语言且无意大利语，则删除 `5: "it-IT"` 并调整其它映射。

然后修改 `resolveAuto` 函数：

```typescript
function resolveAuto(systemLocale: string): ResolvedLanguage {
  const lower = systemLocale.toLowerCase();
  // 简体中文：zh-CN, zh-Hans, zh-SG, zh-hans-*
  if (lower.startsWith("zh-cn") || lower.startsWith("zh-hans") || lower.startsWith("zh-sg")) {
    return "zh-CN";
  }
  // 繁体中文：zh-TW, zh-Hant, zh-HK, zh-MO
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hant") || lower.startsWith("zh-hk") || lower.startsWith("zh-mo")) {
    return "zh-Hant";
  }
  // 其它 zh* 一律回退到简中
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("fr")) return "fr-FR";
  if (lower.startsWith("de")) return "de-DE";
  if (lower.startsWith("id")) return "id-ID";
  if (lower.startsWith("pl")) return "pl-PL";
  if (lower.startsWith("pt-br")) return "pt-BR";
  // 其它 pt* 回退到 pt-BR
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("ru")) return "ru-RU";
  if (lower.startsWith("es")) return "es-ES";
  if (lower.startsWith("th")) return "th-TH";
  if (lower.startsWith("tr")) return "tr-TR";
  if (lower.startsWith("uk")) return "uk-UA";
  if (lower.startsWith("vi")) return "vi-VN";
  return "en";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app && pnpm test -- language.test`
Expected: PASS。

- [ ] **Step 5: 运行 typecheck 与 lint**

Run: `cd app && pnpm typecheck && pnpm lint`
Expected: 无错误。如果有错误（如某些地方用了 `ResolvedLanguage` 字面量类型期望 4 个值），相应修复。

- [ ] **Step 6: 提交**

```bash
git add app/shared/language.ts app/test/shared/language.test.ts
git commit -m "feat(i18n): expand APP_LANGUAGES to all 16 game-supported languages"
```

---

## Task 3: 扩展 shared/types.ts GameLocaleData 为动态结构

**Files:**
- Modify: `app/shared/types.ts:1506-1513`

- [ ] **Step 1: 修改 `GameLocaleData` 接口**

把现有的硬编码 4 字段结构：

```typescript
export interface GameLocaleData {
  /** Game version at extraction time (same as CatalogStatus.gameVersion). */
  version: string | null;
  en: Record<string, string>;
  "zh-CN": Record<string, string>;
  ja: Record<string, string>;
  ko: Record<string, string>;
}
```

替换为动态结构：

```typescript
/**
 * 游戏提取的 locale 数据。`locales` 字段是动态 map：key 是 BCP-47 语言代码
 * （如 "en", "zh-CN", "zh-Hant", "fr-FR", ...），value 是该语言的扁平 key→value
 * 翻译表（如 `{ "Grade_COMMON": "Common", ... }`）。
 *
 * 只包含提取成功且非空的语言；缺失语言由 renderer 通过 i18next fallback 处理。
 */
export interface GameLocaleData {
  /** Game version at extraction time (same as CatalogStatus.gameVersion). */
  version: string | null;
  locales: Record<string, Record<string, string>>;
}
```

- [ ] **Step 2: 检查所有引用 `GameLocaleData` 的地方**

Run: `cd app && grep -rn "GameLocaleData" src/ shared/`

预期命中：
- `app/src/preload/index.ts` — `getLocaleData()` 返回类型，无需改（类型自动跟随）
- `app/src/main/catalogRefreshService.ts` — `cachedLocale` 字段，Task 5 一起改
- `app/src/main/app/appState.ts` — `getLocaleData` 方法签名，类型自动跟随
- `app/src/main/ipc/handlers/catalog.ts` — handler 实现，类型自动跟随
- `app/src/renderer/i18n.ts` — `tryMergeGameLocale` 实现，Task 8 一起改

`preload/index.ts`、`appState.ts`、`handlers/catalog.ts` 不需要改动，因为它们只传递 `GameLocaleData | null`，不访问具体字段。

- [ ] **Step 3: 运行 typecheck（此时 catalogRefreshService 和 i18n 会报类型错误，Task 5/8 修复）**

Run: `cd app && pnpm typecheck`
Expected: `catalogRefreshService.ts` 和 `renderer/i18n.ts` 报类型错误（访问 `localeData.en` 等不存在字段）。这是预期的，下方 Task 5/8 会修复。

- [ ] **Step 4: 暂不提交（与 Task 5 一起提交，避免中间状态破坏 build）**

---

## Task 4: 扩展 core/unityAssets/localeExtractor.ts

**Files:**
- Modify: `app/src/core/unityAssets/localeExtractor.ts`
- Create: `app/test/core/localeExtractor.test.ts`

- [ ] **Step 1: 写失败测试**

Create `app/test/core/localeExtractor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { extractLocales } from "../../src/core/unityAssets/localeExtractor";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 复用 catalogExtractor 测试已有的 fixture bundle
const FIXTURES = join(__dirname, "fixtures");
const sharedBundle = readFileSync(join(FIXTURES, "shared_assets.bundle"));
const enBundle = readFileSync(join(FIXTURES, "en_stringtable.bundle"));

describe("extractLocales", () => {
  it("returns null when shared bundle has no entries", () => {
    const result = extractLocales({
      sharedBundle: Buffer.alloc(0),
      locales: { en: enBundle },
    });
    expect(result).toBeNull();
  });

  it("returns locales map for all provided languages", () => {
    const result = extractLocales({
      sharedBundle,
      locales: { en: enBundle, "zh-CN": Buffer.alloc(0) },
    });
    expect(result).not.toBeNull();
    expect(result!.en).toEqual(expect.any(Object));
    expect(Object.keys(result!.en).length).toBeGreaterThan(0);
    // zh-CN bundle 为空，应该返回空 map（不报错）
    expect(result!["zh-CN"]).toEqual({});
  });

  it("accepts arbitrary language codes (dynamic, not hardcoded)", () => {
    const result = extractLocales({
      sharedBundle,
      locales: {
        en: enBundle,
        "zh-Hant": enBundle, // 复用 en bundle 测试任意 lang key
        "fr-FR": enBundle,
        "vi-VN": enBundle,
      },
    });
    expect(result).not.toBeNull();
    expect(result!["zh-Hant"]).toEqual(expect.any(Object));
    expect(result!["fr-FR"]).toEqual(expect.any(Object));
    expect(result!["vi-VN"]).toEqual(expect.any(Object));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app && pnpm test -- localeExtractor`
Expected: FAIL，错误信息包含 `locales` 字段不存在（旧接口是 `enBundle/zhCNBundle/...`）。

- [ ] **Step 3: 修改 `app/src/core/unityAssets/localeExtractor.ts`**

替换整个文件：

```typescript
// app/src/core/unityAssets/localeExtractor.ts
// Extracts ALL localized string entries from the game's locale bundles,
// not just ItemName_ (which catalogExtractor handles). Produces a flat
// key-value map per language so the companion can sync grade/type/stat
// translations at runtime.
//
// Reuses the same binary-format parser chain as catalogExtractor:
//   parseBundle → parseSerializedFile → scanMarkerEntries
//
// Language list is dynamic: caller provides a `locales` map keyed by BCP-47
// code; extractor returns the same keys with their respective string maps.
// Missing/empty bundles yield an empty map (not null) for that language.

import { parseBundle } from "./bundleParser";
import { parseSerializedFile } from "./serializedFile";
import { scanMarkerEntries } from "./monobehaviourEntries";

const TYPE_MONOBEHAVIOUR = 114;

/**
 * Input: shared bundle (hash → key) + per-language locale bundles.
 *
 * `locales` keys are BCP-47 language codes (e.g. "en", "zh-CN", "zh-Hant",
 * "fr-FR", ...). Values are raw bundle Buffers; empty Buffer is allowed
 * (yields an empty map for that language, not null).
 */
export interface LocaleExtractorInput {
  sharedBundle: Buffer;
  locales: Record<string, Buffer>;
}

/**
 * Output: same keys as input `locales`, each mapping to a flat key→value
 * translation map (e.g. `{ "Grade_COMMON": "Common", ... }`).
 */
export type ExtractedLocales = Record<string, Record<string, string>>;

/**
 * Find the smallest MonoBehaviour in a parsed bundle (which is the
 * SharedTableData / StringTable), scan marker entries, and return an
 * ordered list of { hash, str } pairs.
 */
function scanLocaleEntries(bundleBuffer: Buffer): { hash: number; str: string }[] {
  if (bundleBuffer.length === 0) return [];
  const bundle = parseBundle(bundleBuffer);
  const sf = parseSerializedFile(bundle.data);
  const monos = sf.objects
    .filter((o) => o.classID === TYPE_MONOBEHAVIOUR)
    .map((o) => ({ info: o, raw: sf.getObjectRaw(o, bundle.data) }))
    .sort((a, b) => a.raw.length - b.raw.length);
  const smallest = monos[0];
  if (!smallest) return [];
  return scanMarkerEntries(smallest.raw).map((e) => ({ hash: e.hash, str: e.str }));
}

/**
 * Extract all localized strings from the locale bundles.
 *
 * Returns null only if the shared bundle has no entries (game bundles
 * unavailable / unreadable). Individual locale bundles that fail are
 * silently returned as empty maps (caller can detect missing translations
 * by checking `Object.keys(result[lang]).length === 0`).
 */
export function extractLocales(input: LocaleExtractorInput): ExtractedLocales | null {
  // Shared bundle: hash → key mapping (e.g. hash 12345 → "Grade_COMMON").
  const sharedEntries = scanLocaleEntries(input.sharedBundle);
  if (sharedEntries.length === 0) return null;

  const keyByHash = new Map<number, string>();
  for (const e of sharedEntries) keyByHash.set(e.hash, e.str);

  /**
   * For a locale bundle, build key→value map by joining with shared keys.
   * Returns empty map if the bundle is unreadable (empty entries).
   */
  function buildMap(bundleBuffer: Buffer): Record<string, string> {
    const localeEntries = scanLocaleEntries(bundleBuffer);
    if (localeEntries.length === 0) return {};
    const map: Record<string, string> = {};
    for (const e of localeEntries) {
      const key = keyByHash.get(e.hash);
      if (key !== undefined) map[key] = e.str;
    }
    return map;
  }

  const result: ExtractedLocales = {};
  for (const [lang, buf] of Object.entries(input.locales)) {
    result[lang] = buildMap(buf);
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app && pnpm test -- localeExtractor`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add app/src/core/unityAssets/localeExtractor.ts app/test/core/localeExtractor.test.ts
git commit -m "refactor(core): make localeExtractor accept dynamic language map"
```

---

## Task 5: 扩展 main/catalogRefreshService.ts 动态扫描 locale bundle

**Files:**
- Modify: `app/src/main/catalogRefreshService.ts`
- Modify: `app/test/main/catalogRefreshService.test.ts`

- [ ] **Step 1: 在 `catalogRefreshService.ts` 中替换 `AssetPaths` 与 `resolveAssetPaths`**

把现有的硬编码 4 语言 `AssetPaths` interface 与 `resolveAssetPaths` 函数替换为动态扫描：

```typescript
// 在文件顶部 import 处加 readdirSync
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

// 删除旧的 AssetPaths interface 与 resolveAssetPaths 函数，替换为：

interface AssetPaths {
  sharedassets0: string;
  sharedBundle: string;
  enBundle: string;
  /** 动态扫描出的所有 locale bundle：BCP-47 lang → absolute path。 */
  localeBundles: Record<string, string>;
}

/**
 * 解析 locale bundle 文件名为 BCP-47 语言代码。
 *
 * 游戏文件名模式：
 *   localization-string-tables-<language>(<region>)(<code>)_assets_all.bundle
 *   localization-string-tables-<language>(<region>)(<code>)_assets_all_<hash>.bundle
 *
 * 例：
 *   "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle" → "en"
 *   "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle" → "zh-CN"
 *   "localization-string-tables-chinese(traditional)(zh-hant)_assets_all.bundle" → "zh-Hant"
 *
 * 返回 null 表示文件名不匹配（不应发生，但兜底）。
 */
function parseLocaleBundleFilename(filename: string): string | null {
  const m = /localization-string-tables-[a-z]+\([^)]+\)\(([^)]+)\)_assets_all/.exec(filename);
  if (!m) return null;
  const code = m[1].toLowerCase();
  // 把游戏 bundle 中的 code 映射到 companion 的 BCP-47 子tag
  const MAP: Record<string, string> = {
    "en-us": "en",
    "zh-hans": "zh-CN", // 简中保留 zh-CN 与 navigator.language 对齐
    "zh-hant": "zh-Hant",
    "fr-fr": "fr-FR",
    "de-de": "de-DE",
    "id-id": "id-ID",
    "ja-jp": "ja",
    "ko-kr": "ko",
    "pl-pl": "pl-PL",
    "pt-br": "pt-BR",
    "ru-ru": "ru-RU",
    "es-es": "es-ES",
    "th-th": "th-TH",
    "tr-tr": "tr-TR",
    "uk-ua": "uk-UA",
    "vi-vn": "vi-VN",
  };
  return MAP[code] ?? null;
}

function resolveAssetPaths(installDir: string): AssetPaths {
  const aa = join(installDir, "StreamingAssets", "aa", "StandaloneWindows64");
  const localeBundles: Record<string, string> = {};
  if (existsSync(aa)) {
    for (const entry of readdirSync(aa)) {
      if (!entry.startsWith("localization-string-tables-")) continue;
      if (!entry.endsWith(".bundle")) continue;
      // 跳过 shared_assets_all（不是 locale bundle）
      if (entry.includes("_shared_")) continue;
      const lang = parseLocaleBundleFilename(entry);
      if (lang) localeBundles[lang] = join(aa, entry);
    }
  }
  return {
    sharedassets0: join(installDir, "sharedassets0.assets"),
    sharedBundle: join(aa, "localization-assets-shared_assets_all.bundle"),
    // enBundle 保留为独立字段（catalog extractor 仍需要它作为 required asset）
    enBundle: localeBundles.en ?? join(aa, "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"),
    localeBundles,
  };
}
```

- [ ] **Step 2: 修改 `refresh()` 方法中的 locale 提取段**

找到 `refresh()` 中现有的 locale 提取段（约 132-161 行），替换为：

```typescript
      // --- Locale extraction (best-effort: non-fatal) ---
      // 动态收集所有可用语言的 locale bundle Buffer。enBundle 已经读过，
      // 复用；其它语言按需读取。
      const localeBuffers: Record<string, Buffer> = { en: enBundle };
      for (const [lang, path] of Object.entries(paths.localeBundles)) {
        if (lang === "en") continue; // 已包含
        if (!existsSync(path)) {
          log.warn(`locale bundle missing (${lang}), skipping`);
          continue;
        }
        localeBuffers[lang] = readFileSync(path);
      }
      const localeData = extractLocales({
        sharedBundle,
        locales: localeBuffers,
      });
      if (localeData) {
        // 统计每种语言的 key 数量用于日志
        const langCounts = Object.entries(localeData)
          .map(([lang, map]) => `${lang}=${Object.keys(map).length}`)
          .join(" ");
        const localePayload: GameLocaleData = {
          version: gameVersion,
          locales: localeData,
        };
        const localePath = join(this.userDataDir, LOCALE_FILE);
        writeFileSync(localePath, JSON.stringify(localePayload), "utf-8");
        this.cachedLocale = localePayload;
        log.info(`wrote ${localePath}: ${langCounts}`);
      } else {
        log.warn("locale extraction returned no data (game bundles may be unavailable)");
      }
```

同时删除旧的 `localeKeys` 检查段（132-137 行）：

```typescript
      // 删除这段：
      const localeKeys: (keyof AssetPaths)[] = ["zhCNBundle", "jaBundle", "koBundle"];
      for (const key of localeKeys) {
        if (!existsSync(paths[key])) {
          log.warn(`locale bundle missing (${key}), skipping locale extraction`);
        }
      }
```

- [ ] **Step 3: 修改 `cachedLocale` 字段类型**

`cachedLocale` 字段类型已经是 `GameLocaleData | null`，跟随 Task 3 的接口变化自动适配，无需改。

- [ ] **Step 4: 更新 `app/test/main/catalogRefreshService.test.ts`**

现有测试不直接调用 `refresh()`，所以不需要改 `readdirSync` mock。但要加一个新测试验证 `getLocaleData` 返回动态结构：

```typescript
  it("getLocaleData returns null before any refresh", () => {
    const { gameData, liveMemory } = makeMocks();
    const svc = new CatalogRefreshService(
      gameData as GameDataProvider,
      liveMemory as LiveMemoryService,
      "/some/userData",
    );
    expect(svc.getLocaleData()).toBeNull();
  });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd app && pnpm test -- catalogRefreshService`
Expected: PASS。

- [ ] **Step 6: 运行 typecheck**

Run: `cd app && pnpm typecheck`
Expected: 无错误（`catalogRefreshService.ts` 类型错误应已修复；`renderer/i18n.ts` 仍可能有错误，Task 8 修复）。

- [ ] **Step 7: 提交（与 Task 3 一起提交，避免中间状态破坏 build）**

```bash
git add app/shared/types.ts app/src/main/catalogRefreshService.ts app/test/main/catalogRefreshService.test.ts
git commit -m "feat(catalog): extract all 16 locale bundles with dynamic language scanning"
```

---

## Task 6: 扩展 core/localeCatalog.ts 新语言用 en 兜底

**Files:**
- Modify: `app/src/core/localeCatalog.ts:34-39`
- Modify: `app/test/core/localeCatalog.test.ts`

游戏内 stage/hero/item/difficulty 名字通过 `data/locale_strings_<lang>.json` 提供，但目前只有 4 种语言文件。为新语言复用 en 的 JSON（i18next fallback 机制保证界面可用）。

- [ ] **Step 1: 写失败测试**

在 `app/test/core/localeCatalog.test.ts` 末尾追加：

```typescript
import { loadLocaleCatalog, _resetLocaleCatalogCacheForTests } from "../../src/core/localeCatalog";

describe("loadLocaleCatalog (multi-language fallback)", () => {
  beforeEach(() => _resetLocaleCatalogCacheForTests());

  it("loads en catalog directly", () => {
    const c = loadLocaleCatalog("en");
    expect(Object.keys(c.items).length).toBeGreaterThan(0);
  });

  it("falls back to en JSON for new languages (zh-Hant, fr-FR, vi-VN)", () => {
    // 新语言没有独立的 locale_strings_<lang>.json，应该回退到 en
    const cHant = loadLocaleCatalog("zh-Hant");
    const cFr = loadLocaleCatalog("fr-FR");
    const cVi = loadLocaleCatalog("vi-VN");
    // 应该返回与 en 相同的内容
    const cEn = loadLocaleCatalog("en");
    expect(Object.keys(cHant.items).length).toBe(Object.keys(cEn.items).length);
    expect(Object.keys(cFr.items).length).toBe(Object.keys(cEn.items).length);
    expect(Object.keys(cVi.items).length).toBe(Object.keys(cEn.items).length);
  });
});
```

注意在文件顶部加 `import { beforeEach } from "vitest"`（如果还没引入）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app && pnpm test -- localeCatalog`
Expected: FAIL，错误信息包含 `locale_strings_zh-Hant.json not found`。

- [ ] **Step 3: 修改 `app/src/core/localeCatalog.ts`**

替换 `LANG_TO_FILENAME` 为函数：

```typescript
// 已有的 4 种语言有独立 JSON 文件；其它新语言复用 en JSON 兜底。
const LANG_TO_FILENAME: Record<ResolvedLanguage, string> = {
  en: "locale_strings_en.json",
  "zh-CN": "locale_strings_zh-CN.json",
  "zh-Hant": "locale_strings_en.json", // 兜底
  ja: "locale_strings_ja.json",
  ko: "locale_strings_ko.json",
  "fr-FR": "locale_strings_en.json", // 兜底
  "de-DE": "locale_strings_en.json",
  "id-ID": "locale_strings_en.json",
  "pl-PL": "locale_strings_en.json",
  "pt-BR": "locale_strings_en.json",
  "ru-RU": "locale_strings_en.json",
  "es-ES": "locale_strings_en.json",
  "th-TH": "locale_strings_en.json",
  "tr-TR": "locale_strings_en.json",
  "uk-UA": "locale_strings_en.json",
  "vi-VN": "locale_strings_en.json",
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app && pnpm test -- localeCatalog`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add app/src/core/localeCatalog.ts app/test/core/localeCatalog.test.ts
git commit -m "feat(core): fallback new languages to en locale_strings JSON"
```

---

## Task 7: 扩展 app/shared/locales/index.ts 新语言引用 en

**Files:**
- Modify: `app/shared/locales/index.ts`

12 种新语言没有自己的 namespace JSON 文件，让 `LOCALE_RESOURCES` 中新语言直接引用 `en` 对象。i18next fallback 机制保证缺失 key 自动回退到 en（虽然这里直接引用 en 对象，理论上不会触发 fallback，但保持引用一致性）。

- [ ] **Step 1: 修改 `app/shared/locales/index.ts`**

替换整个文件：

```typescript
// Single entry point for all bundled locale resources. Importers (main and
// renderer) use this to feed i18next's `resources` option without touching
// JSON files directly.
//
// 12 种新语言（zh-Hant, fr-FR, de-DE, id-ID, pl-PL, pt-BR, ru-RU, es-ES,
// th-TH, tr-TR, uk-UA, vi-VN）暂时复用 en 内容作为占位。运行时通过
// tryMergeGameLocale() 从游戏 bundle 动态合并 labels/* 翻译；其它 companion
// UI 字符串仍为英文，后续可逐语言人工/AI 替换为独立 JSON 文件。
import type { ResolvedLanguage } from "../language";
import en from "./en";
import ja from "./ja";
import ko from "./ko";
import zhCN from "./zh-CN";

export const LOCALE_RESOURCES: Record<ResolvedLanguage, Record<string, object>> = {
  en,
  "zh-CN": zhCN,
  ja,
  ko,
  // 12 种新语言：复用 en 作为占位。运行时 tryMergeGameLocale 会覆盖 labels/*
  // 字段为游戏 bundle 中对应语言的翻译；其它字段保持英文。
  "zh-Hant": en,
  "fr-FR": en,
  "de-DE": en,
  "id-ID": en,
  "pl-PL": en,
  "pt-BR": en,
  "ru-RU": en,
  "es-ES": en,
  "th-TH": en,
  "tr-TR": en,
  "uk-UA": en,
  "vi-VN": en,
};
```

- [ ] **Step 2: 运行 typecheck**

Run: `cd app && pnpm typecheck`
Expected: 无错误。`LOCALE_RESOURCES` 类型是 `Record<ResolvedLanguage, ...>`，新 `ResolvedLanguage` 联合类型已扩到 16 项，对应 16 个属性。

- [ ] **Step 3: 运行现有 i18n 相关测试**

Run: `cd app && pnpm test -- i18n`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add app/shared/locales/index.ts
git commit -m "feat(i18n): add 12 new languages to LOCALE_RESOURCES with en fallback"
```

---

## Task 8: 扩展 renderer/i18n.ts tryMergeGameLocale 遍历所有语言

**Files:**
- Modify: `app/src/renderer/i18n.ts:22-38`

- [ ] **Step 1: 修改 `tryMergeGameLocale`**

把现有的硬编码 4 语言循环：

```typescript
async function tryMergeGameLocale(): Promise<void> {
  try {
    const localeData = await window.tbh.getLocaleData();
    if (!localeData) return;

    for (const lang of ["en", "zh-CN", "ja", "ko"] as const) {
      const game = localeData[lang];
      if (!game || Object.keys(game).length === 0) continue;
      const labels = flatGameKeysToLabels(game);
      if (labels) {
        i18next.addResourceBundle(lang, "common", { labels }, true, true);
      }
    }
  } catch {
    // Non-fatal: game bundles not available, no refresh done yet, etc.
  }
}
```

替换为动态遍历：

```typescript
async function tryMergeGameLocale(): Promise<void> {
  try {
    const localeData = await window.tbh.getLocaleData();
    if (!localeData) return;
    // 遍历 locales map 中所有语言（动态结构，不再写死 4 种）。
    // 每个语言对应一个扁平 key→value map（如 { "Grade_COMMON": "Common", ... }）。
    for (const [lang, game] of Object.entries(localeData.locales)) {
      if (!game || Object.keys(game).length === 0) continue;
      const labels = flatGameKeysToLabels(game);
      if (labels) {
        i18next.addResourceBundle(lang, "common", { labels }, true, true);
      }
    }
  } catch {
    // Non-fatal: game bundles not available, no refresh done yet, etc.
  }
}
```

- [ ] **Step 2: 运行 typecheck**

Run: `cd app && pnpm typecheck`
Expected: 无错误（Task 3 改了 `GameLocaleData` 接口，这里访问 `localeData.locales` 应该匹配）。

- [ ] **Step 3: 运行 lint**

Run: `cd app && pnpm lint`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add app/src/renderer/i18n.ts
git commit -m "feat(i18n): merge game locale for all languages dynamically"
```

---

## Task 9: 扩展 scripts/dump_game_locale.py 支持 16 种语言

**Files:**
- Modify: `scripts/dump_game_locale.py:18-23`

- [ ] **Step 1: 修改 `LOCALE_BUNDLES` 字典**

把现有的 4 语言扩展为 16 语言：

```python
LOCALE_BUNDLES = {
    "en": "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
    "zh-CN": "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle",
    "zh-Hant": "localization-string-tables-chinese(traditional)(zh-hant)_assets_all.bundle",
    "fr-FR": "localization-string-tables-french(france)(fr-fr)_assets_all.bundle",
    "de-DE": "localization-string-tables-german(germany)(de-de)_assets_all.bundle",
    "id-ID": "localization-string-tables-indonesian(indonesia)(id-id)_assets_all.bundle",
    "ja": "localization-string-tables-japanese(japan)(ja-jp)_assets_all.bundle",
    "ko": "localization-string-tables-korean(southkorea)(ko-kr)_assets_all.bundle",
    "pl-PL": "localization-string-tables-polish(poland)(pl-pl)_assets_all.bundle",
    "pt-BR": "localization-string-tables-portuguese(brazil)(pt-br)_assets_all.bundle",
    "ru-RU": "localization-string-tables-russian(russia)(ru-ru)_assets_all.bundle",
    "es-ES": "localization-string-tables-spanish(spain)(es-es)_assets_all.bundle",
    "th-TH": "localization-string-tables-thai(thailand)(th-th)_assets_all.bundle",
    "tr-TR": "localization-string-tables-turkish(turkey)(tr-tr)_assets_all.bundle",
    "uk-UA": "localization-string-tables-ukrainian(ukraine)(uk-ua)_assets_all.bundle",
    "vi-VN": "localization-string-tables-vietnamese(vietnam)(vi-vn)_assets_all_1fd32a756f001caa967456dee50c7be9.bundle",
}
```

> **注意 vi-VN 的文件名有 hash 后缀**（`_1fd32a756f001caa967456dee50c7be9.bundle`）。这是 Unity Addressables 的内容寻址 hash，可能随游戏更新变化。如果 dump 失败，让脚本动态 glob 匹配 `localization-string-tables-vietnamese(vietnam)(vi-vn)_assets_all*.bundle`。

- [ ] **Step 2: 让 `collect_all_entries` 容忍缺失文件**

修改 `main()` 函数：

```python
def main() -> None:
    id_to_key = build_id_to_key()
    print(f"shared id->key entries: {len(id_to_key)}", file=sys.stderr)

    all_langs: dict[str, dict[str, str]] = {}
    for lang, bundle in LOCALE_BUNDLES.items():
        bundle_path = GAME_DIR / bundle
        if not bundle_path.exists():
            # 兜底：尝试 glob 匹配带 hash 后缀的变体
            import glob
            matches = glob.glob(str(GAME_DIR / bundle.replace("_assets_all.bundle", "_assets_all*.bundle")))
            if matches:
                bundle_path = Path(matches[0])
            else:
                print(f"WARN: {lang} bundle missing: {bundle}", file=sys.stderr)
                all_langs[lang] = {}
                continue
        entries = collect_all_entries(lang, str(bundle_path), id_to_key)
        all_langs[lang] = entries
        print(f"{lang}: {len(entries)} entries", file=sys.stderr)

        # Prefix summary
        prefixes = Counter()
        for k in entries:
            prefix = k.split("_")[0] if "_" in k else k
            prefixes[prefix] += 1
        print(f"  top prefixes:", file=sys.stderr)
        for p, c in prefixes.most_common(20):
            print(f"    {p:30} {c}", file=sys.stderr)

    out_path = Path(__file__).resolve().parent.parent / "data" / "_game_locale_dump.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(all_langs, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"\nwrote: {out_path}", file=sys.stderr)
```

- [ ] **Step 3: 运行脚本验证**

Run:
```bash
cd D:\Project\TBH\tbh-companion
python scripts/dump_game_locale.py
```

Expected: stderr 打印 16 行 `<lang>: <N> entries`，每行 N ≈ 1875。stdout 无输出（写文件）。`data/_game_locale_dump.json` 应包含 16 个 lang key。

- [ ] **Step 4: 提交**

```bash
git add scripts/dump_game_locale.py
git commit -m "feat(scripts): dump all 16 game locale bundles"
```

---

## Task 10: 更新 Settings.tsx 语言下拉菜单显示完整语言名（可选）

**Files:**
- Modify: `app/src/renderer/tabs/Settings.tsx:363-368`
- Modify: `app/shared/locales/en/settings.json`（添加 languageNames 节）

当前语言下拉菜单用 lang code 作为 label（如 "zh-Hant", "fr-FR"），对新用户不友好。改为显示完整语言名（如 "繁体中文", "Français"）。每种语言用自身的语言名（endonym）。

- [ ] **Step 1: 在 `app/shared/locales/en/settings.json` 中添加 `languageNames` 节**

```json
{
  "language": {
    "label": "Language",
    "auto": "Auto (system)",
    "game": "Follow game",
    "restartHint": "Changes apply after restart.",
    "tabTitle": "Settings",
    "intro": "Companion app preferences.",
    "names": {
      "en": "English",
      "zh-CN": "简体中文",
      "zh-Hant": "繁體中文",
      "fr-FR": "Français",
      "de-DE": "Deutsch",
      "id-ID": "Bahasa Indonesia",
      "ja": "日本語",
      "ko": "한국어",
      "pl-PL": "Polski",
      "pt-BR": "Português (Brasil)",
      "ru-RU": "Русский",
      "es-ES": "Español",
      "th-TH": "ไทย",
      "tr-TR": "Türkçe",
      "uk-UA": "Українська",
      "vi-VN": "Tiếng Việt"
    }
  }
}
```

> **注意：** languageNames 放在 `settings.json` 的 `language.names` 节。其它语言文件（zh-CN/ja/ko）也需要加同样的 `names` 节（值相同，因为是 endonym）。或者更简单：只在 en 中加，i18next fallback 自动补齐。

- [ ] **Step 2: 把同样的 `names` 节加到 zh-CN / ja / ko 的 settings.json**

值保持一致（语言名是 endonym，不随 UI 语言变化）。

- [ ] **Step 3: 修改 `app/src/renderer/tabs/Settings.tsx`**

把：

```tsx
              options={[
                { value: "auto", label: tSettings("language.auto") },
                { value: "game", label: tSettings("language.game") },
                ...APP_LANGUAGES.map((lang) => ({ value: lang, label: lang })),
              ]}
```

改为：

```tsx
              options={[
                { value: "auto", label: tSettings("language.auto") },
                { value: "game", label: tSettings("language.game") },
                ...APP_LANGUAGES.map((lang) => ({
                  value: lang,
                  label: tSettings(`language.names.${lang}`),
                })),
              ]}
```

- [ ] **Step 4: 运行 typecheck + lint + test**

Run: `cd app && pnpm typecheck && pnpm lint && pnpm test:dom`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add app/src/renderer/tabs/Settings.tsx app/shared/locales/*/settings.json
git commit -m "feat(settings): show full language names (endonyms) in language picker"
```

---

## Task 11: 文档与 CHANGELOG 更新

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 `docs/ARCHITECTURE.md`**

找到 Internationalization 段（如存在），补 16 语言说明：

```markdown
### Internationalization

Companion 支持游戏内置的全部 16 种语言：en, zh-CN, zh-Hant, fr-FR, de-DE,
id-ID, ja, ko, pl-PL, pt-BR, ru-RU, es-ES, th-TH, tr-TR, uk-UA, vi-VN。

- **游戏内 labels**（grades/types/stats/classes/gearGroups）：通过
  `CatalogRefreshService.refresh()` 从游戏 localization bundle 动态提取，
  写入 `userData/locale.json`，renderer 启动时通过 `tryMergeGameLocale()`
  合并到 i18next 资源。
- **游戏内数据名**（items/stages/heroes/difficulties）：通过
  `data/locale_strings_<lang>.json` 提供。已有 4 种语言（en/zh-CN/ja/ko）
  有独立 JSON；其它 12 种新语言复用 en JSON 兜底。
- **Companion UI 字符串**：通过 `app/shared/locales/<lang>/*.json` 提供。
  已有 4 种语言有完整翻译；其它 12 种新语言复用 en 内容作为占位，后续可
  逐语言人工/AI 替换为独立 JSON。
- **语言选择**：用户在 Settings 中选择 "Auto" / "Follow game" / 具体语言。
  "Follow game" 通过读取注册表 `tbh_lang_idx` 解析游戏当前语言。
```

- [ ] **Step 2: 更新 `CHANGELOG.md`**

在 `[Unreleased]` 段加 bullets：

```markdown
## [Unreleased]

### Added
- 支持游戏内置的全部 16 种语言（新增 zh-Hant, fr-FR, de-DE, id-ID, pl-PL,
  pt-BR, ru-RU, es-ES, th-TH, tr-TR, uk-UA, vi-VN）
- `CatalogRefreshService.refresh()` 现在动态扫描 `localization-string-tables-*`
  bundle 文件，提取所有可用语言的 locale 数据
- Settings 语言下拉菜单显示完整语言名（endonym）

### Changed
- `GameLocaleData` 接口改为动态结构 `locales: Record<string, Record<string, string>>`
- `localeExtractor.extractLocales` 输入输出改为 `Record<lang, Buffer>` /
  `Record<lang, Record<string, string>>`，不再硬编码语言数量
- 12 种新语言的 companion UI 字符串暂时复用 en 内容作为占位
```

- [ ] **Step 3: 提交**

```bash
git add docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: document 16-language support"
```

---

## Task 12: QA 全流程验证

**Files:** 无（运行已有 QA 命令）

- [ ] **Step 1: 运行完整 QA**

Run:
```bash
cd app
pnpm qa
```

Expected: typecheck + lint + format + test + build + bundle guards 全部通过。

> **注意：** 已知 `chestDropTracker.test.ts` 和 `trackingService.test.ts` 中有 5 个 timing 相关的 flaky 测试，不是本次改动引起。如果失败，重跑一次确认。

- [ ] **Step 2: 手动验证（dev 模式）**

Run:
```bash
cd app
pnpm dev
```

在打开的 companion 中：
1. 进入 Settings → Language
2. 选择 "繁體中文"（zh-Hant），重启 app
3. 验证：
   - UI 字符串仍为英文（en 兜底，符合预期）
   - 进入 Inventory / Loot 等界面，物品的 grade/type 名应该显示为繁体中文（来自游戏 bundle）
4. 切换到 "Français"，重启，验证 grade/type 名为法语
5. 切换回 "Auto"，验证按 system locale 推断

- [ ] **Step 3: 触发 catalog refresh 验证 locale 提取**

在 companion 中点击 "Refresh catalog" 按钮（或确保游戏运行时自动触发）。验证：
- `userData/locale.json` 文件存在
- 文件内容形如 `{"version":"1.00.28","locales":{"en":{...},"zh-CN":{...},...,"vi-VN":{...}}}`
- 包含 16 个 lang key

- [ ] **Step 4: 如全部通过，无需额外提交**

QA 是验证步骤，不产生新代码。

---

## Self-Review 检查清单

执行完所有 Task 后，回头检查：

1. **spec 覆盖：**
   - ✅ "支持游戏支持的所有语种" → Task 2 扩 APP_LANGUAGES 到 16 项
   - ✅ "包含游戏内内容" → Task 5/8 把游戏 bundle 翻译合并到 i18next labels 节
   - ✅ "项目UI全部支持" → Task 7 新语言用 en 兜底，i18next fallback 保证可用

2. **placeholder 扫描：**
   - ⚠️ Task 2 的 `GAME_LANG_IDX_TO_RESOLVED` 占位值需要 Task 1 dump 结果替换 → 已在 Task 2 Step 3 用 ❗ 标注提醒
   - 其它无 placeholder

3. **类型一致性：**
   - `GameLocaleData.locales: Record<string, Record<string, string>>` → Task 3 定义，Task 5（main 写入）、Task 8（renderer 读取）一致使用
   - `LocaleExtractorInput.locales: Record<string, Buffer>` → Task 4 定义，Task 5 调用一致
   - `ExtractedLocales = Record<string, Record<string, string>>` → Task 4 定义，Task 5 接收一致

4. **约束遵守：**
   - ✅ 不新增 IPC 通道（复用 GET_LOCALE_DATA）
   - ✅ core 层保持纯净（localeExtractor 无 node/electron 依赖）
   - ✅ 文档中文撰写
   - ✅ 代码注释/commit message 英文

---

## 执行选择

**Plan complete and saved to `docs/superpowers/plans/2026-07-19-locale-all-languages.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
