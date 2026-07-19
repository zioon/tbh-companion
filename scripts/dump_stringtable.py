#!/usr/bin/env python3
"""Dump the full structure of an English string-table bundle.

Goal: understand the StringTable typetree so we can extract all entries with
their keys (numeric id → "ItemName_<id>" name) and values (localized string).
"""

from __future__ import annotations

import json
import os
import sys

import UnityPy


BUNDLE = (
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
)


def short_repr(v, max_len: int = 200) -> str:
    s = repr(v)
    return s if len(s) <= max_len else s[:max_len] + "..."


def main() -> int:
    env = UnityPy.load(BUNDLE)
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception as e:
            print(f"path_id={obj.path_id} typetree error: {e}")
            continue
        print(f"\n=== path_id={obj.path_id} ===")
        print(f"m_Name: {tree.get('m_Name')!r}")
        print(f"m_LocaleId: {short_repr(tree.get('m_LocaleId'))}")
        shared = tree.get("m_SharedData")
        print(f"m_SharedData keys: {list(shared.keys()) if isinstance(shared, dict) else type(shared).__name__}")
        if isinstance(shared, dict):
            for k, v in shared.items():
                print(f"  SharedData.{k}: {short_repr(v, 400)}")

        table_data = tree.get("m_TableData")
        print(f"m_TableData type: {type(table_data).__name__}, length: {len(table_data) if hasattr(table_data, '__len__') else 'N/A'}")
        if isinstance(table_data, list) and table_data:
            print(f"first entry keys: {list(table_data[0].keys()) if isinstance(table_data[0], dict) else type(table_data[0]).__name__}")
            for i, entry in enumerate(table_data[:5]):
                print(f"  [{i}]: {short_repr(entry, 500)}")
            print(f"  ... ({len(table_data)} total)")
            # Also dump last 3 to see if format is consistent.
            for i, entry in enumerate(table_data[-3:], start=len(table_data) - 3):
                print(f"  [{i}]: {short_repr(entry, 500)}")

        # Don't dump all — just this one table. Break after the first non-empty
        # table to keep output manageable.
        if isinstance(table_data, list) and len(table_data) > 0:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
