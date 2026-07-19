#!/usr/bin/env python3
"""Dump ALL game localization entries from the 4 locale bundles.

Outputs:
  - data/_game_locale_dump.json: { lang: { key: value, ... }, ... }
  - prints a summary of key prefixes.
"""
import json
import sys
from collections import Counter
from pathlib import Path
import UnityPy

GAME_DIR = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64"
)

LOCALE_BUNDLES = {
    "en": "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
    "zh-CN": "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle",
    "ja": "localization-string-tables-japanese(japan)(ja-jp)_assets_all.bundle",
    "ko": "localization-string-tables-korean(southkorea)(ko-kr)_assets_all.bundle",
}

SHARED_BUNDLE = "localization-assets-shared_assets_all.bundle"


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
    id_to_key = build_id_to_key()
    print(f"shared id->key entries: {len(id_to_key)}", file=sys.stderr)

    all_langs: dict[str, dict[str, str]] = {}
    for lang, bundle in LOCALE_BUNDLES.items():
        entries = collect_all_entries(lang, bundle, id_to_key)
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


if __name__ == "__main__":
    main()
