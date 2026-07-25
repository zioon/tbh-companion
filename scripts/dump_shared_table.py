#!/usr/bin/env python3
"""Dump the SharedTableData from the localization-assets-shared bundle.

SharedTableData holds the key definitions: each entry has an m_Id (the big
number referenced by per-locale StringTable.m_TableData[i].m_Id) and a key
name (e.g. "ItemName_530017"). Building the m_Id → key_name map lets us
join per-locale StringTable values back to catalog itemKeys.
"""

from __future__ import annotations

import os
import re
import sys

import UnityPy


SHARED_BUNDLE = (
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\localization-assets-shared_assets_all.bundle"
)


def short_repr(v, max_len: int = 300) -> str:
    s = repr(v)
    return s if len(s) <= max_len else s[:max_len] + "..."


def main() -> int:
    env = UnityPy.load(SHARED_BUNDLE)
    print(f"objects: {len(env.objects)}")
    type_counts: dict[str, int] = {}
    for obj in env.objects:
        type_counts[obj.type.name] = type_counts.get(obj.type.name, 0) + 1
    print(f"type counts: {type_counts}")

    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception as e:
            print(f"path_id={obj.path_id} typetree error: {e}")
            continue
        print(f"\n=== path_id={obj.path_id} m_Name={tree.get('m_Name')!r} ===")
        print(f"top keys: {list(tree.keys())}")
        for k in ["m_TableCollectionName", "m_Entries"]:
            if k in tree:
                v = tree[k]
                if isinstance(v, list):
                    print(f"{k}: list of {len(v)}")
                    if v:
                        print(f"  first entry keys: {list(v[0].keys()) if isinstance(v[0], dict) else type(v[0]).__name__}")
                        for i, entry in enumerate(v[:5]):
                            print(f"  [{i}]: {short_repr(entry, 500)}")
                        # Show some entries that look like ItemName_.
                        item_entries = [
                            (i, e) for i, e in enumerate(v)
                            if isinstance(e, dict) and isinstance(e.get("m_Key"), str) and "ItemName_" in e["m_Key"]
                        ]
                        print(f"  entries with 'ItemName_' in m_Key: {len(item_entries)}")
                        for i, e in item_entries[:5]:
                            print(f"  [{i}]: {short_repr(e, 300)}")
                        # Also check StageName_, HeroName_.
                        for pat in ["StageName_", "HeroName_", "ItemDesc_", "StageDesc_", "HeroDesc_", "Difficulty", "Act", "Knight", "Ranger"]:
                            hits = [
                                (i, e) for i, e in enumerate(v)
                                if isinstance(e, dict) and isinstance(e.get("m_Key"), str) and pat in e["m_Key"]
                            ]
                            print(f"  entries with '{pat}' in m_Key: {len(hits)}")
                            for i, e in hits[:2]:
                                print(f"    [{i}]: {short_repr(e, 300)}")
                else:
                    print(f"{k}: {short_repr(v, 400)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
