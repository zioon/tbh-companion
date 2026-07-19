#!/usr/bin/env python3
"""Dump ALL game localization entries from every locale bundle found.

Dynamically discovers all `localization-string-tables-*` bundles in the
game's StreamingAssets/aa directory (4 or 16, depending on game version)
and parses the BCP-47 code from each filename to determine the language.

Outputs:
  - data/_game_locale_dump.json: { lang: { key: value, ... }, ... }
  - prints a summary of key prefixes per language.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path
import UnityPy

GAME_DIR = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64"
)

SHARED_BUNDLE = "localization-assets-shared_assets_all.bundle"
LOCALE_BUNDLE_PREFIX = "localization-string-tables-"

# BCP-47 code in parentheses, e.g. `(en-us)`, `(zh-hans)`, `(vi-vn)`.
# Lowercased, hyphenated — earlier groups like `(unitedstates)` won't match.
_BCP47_RE = re.compile(r"\(([a-z]{2,3}-[a-z]{2,8})\)", re.IGNORECASE)

# Codes that need special normalization to match the app's ResolvedLanguage.
_SPECIAL_CODES = {
    "en-us": "en",
    "ja-jp": "ja",
    "ko-kr": "ko",
    "zh-hans": "zh-CN",
    "zh-hant": "zh-Hant",
}


def normalize_locale_code(raw: str) -> str | None:
    """Map a lowercased BCP-47 code from a bundle filename to the app's ResolvedLanguage."""
    lower = raw.lower()
    if lower in _SPECIAL_CODES:
        return _SPECIAL_CODES[lower]
    parts = lower.split("-")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    lang, region = parts
    return f"{lang}-{region.upper()}"


def discover_locale_bundles() -> dict[str, str]:
    """Scan GAME_DIR for all locale bundles, return {app_lang_code: filename}."""
    result: dict[str, str] = {}
    if not GAME_DIR.is_dir():
        return result
    for entry in GAME_DIR.iterdir():
        if not entry.is_file():
            continue
        name = entry.name
        if not name.startswith(LOCALE_BUNDLE_PREFIX):
            continue
        match = _BCP47_RE.search(name)
        if not match:
            continue
        code = normalize_locale_code(match.group(1))
        if not code:
            continue
        # First match wins (in case of duplicate hashes etc.)
        result.setdefault(code, name)
    return result


def build_id_to_key() -> dict[int, str]:
    env = UnityPy.load(str(GAME_DIR / SHARED_BUNDLE))
    result: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        entries = tree.get("m_Entries") or tree.get("m_TableData") or []
        for entry in entries:
            m_id = entry.get("m_Id")
            m_key = entry.get("m_Key")
            if m_id is None or not m_key:
                continue
            result[int(m_id)] = str(m_key)
    return result


def collect_all_entries(lang: str, bundle_name: str, id_to_key: dict[int, str]) -> dict[str, str]:
    env = UnityPy.load(str(GAME_DIR / bundle_name))
    result: dict[str, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        entries = tree.get("m_TableData") or tree.get("m_Entries") or []
        for entry in entries:
            m_id = entry.get("m_Id")
            m_value = entry.get("m_Localized")
            if m_id is None or m_value is None:
                continue
            key = id_to_key.get(int(m_id))
            if key:
                result[key] = str(m_value)
    return result


def main() -> None:
    locale_bundles = discover_locale_bundles()
    if not locale_bundles:
        print(f"no locale bundles found in {GAME_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"discovered {len(locale_bundles)} locale bundles:", file=sys.stderr)
    for code in sorted(locale_bundles):
        print(f"  {code}: {locale_bundles[code]}", file=sys.stderr)

    id_to_key = build_id_to_key()
    print(f"\nshared id->key entries: {len(id_to_key)}", file=sys.stderr)

    all_langs: dict[str, dict[str, str]] = {}
    for lang in sorted(locale_bundles):
        bundle = locale_bundles[lang]
        entries = collect_all_entries(lang, bundle, id_to_key)
        all_langs[lang] = entries
        print(f"\n{lang}: {len(entries)} entries ({bundle})", file=sys.stderr)

        # Prefix summary
        prefixes: Counter[str] = Counter()
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


if __name__ == "__main__":
    main()
