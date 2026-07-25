#!/usr/bin/env python3
"""Dump all StageName_/HeroName_/Difficulty_ entries from en-US string table.

Builds the m_Id -> m_Key map from SharedTableData, then joins with the en-US
StringTable's m_TableData (m_Id -> m_Localized) to print all 30 StageName_,
6 HeroName_, and 4 Difficulty_ entries with their English values.
"""

from __future__ import annotations

import os
import sys

import UnityPy


BUNDLE_DIR = (
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
)
SHARED_BUNDLE = os.path.join(BUNDLE_DIR, "localization-assets-shared_assets_all.bundle")
EN_BUNDLE = os.path.join(
    BUNDLE_DIR, "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
)


def build_id_to_key(shared_bundle: str) -> dict[int, str]:
    env = UnityPy.load(shared_bundle)
    out: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        if tree.get("m_TableCollectionName") != "StringTable":
            continue
        for entry in tree.get("m_Entries", []):
            out[entry["m_Id"]] = entry["m_Key"]
    return out


def build_id_to_value(locale_bundle: str) -> dict[int, str]:
    env = UnityPy.load(locale_bundle)
    out: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        if not tree.get("m_Name", "").startswith("StringTable_"):
            continue
        for entry in tree.get("m_TableData", []):
            out[entry["m_Id"]] = entry["m_Localized"]
    return out


def main() -> int:
    id_to_key = build_id_to_key(SHARED_BUNDLE)
    id_to_val = build_id_to_value(EN_BUNDLE)
    print(f"shared keys: {len(id_to_key)}, en values: {len(id_to_val)}")

    # Join and print entries matching our patterns.
    patterns = ["StageName_", "HeroName_", "Difficulty_"]
    for pat in patterns:
        print(f"\n=== {pat}* ===")
        matching = [(kid, key) for kid, key in id_to_key.items() if key.startswith(pat)]
        matching.sort(key=lambda x: x[1])
        for kid, key in matching:
            val = id_to_val.get(kid, "<MISSING>")
            print(f"  {key:30s} -> {val!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
