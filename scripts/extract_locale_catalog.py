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
