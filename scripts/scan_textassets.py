#!/usr/bin/env python3
"""
Scan all TextAsset objects in sharedassets0.assets for ItemName_XXX entries.

The TBH game stores localization strings (including ItemName_530017) as
TextAsset objects inside sharedassets0.assets (18MB). Each TextAsset may
contain JSON, CSV, or raw text with the localization table.

Usage:
    python scripts/scan_textassets.py [ASSETS_FILE]
"""

from __future__ import annotations

import json
import os
import re
import sys

import UnityPy


ITEM_NAME_RE = re.compile(r"ItemName_(\d+)")


def main() -> int:
    assets_file = sys.argv[1] if len(sys.argv) > 1 else (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
        r"\sharedassets0.assets"
    )
    if not os.path.isfile(assets_file):
        print(f"ERROR: {assets_file} not found", file=sys.stderr)
        return 2

    env = UnityPy.load(assets_file)
    print(f"Loaded {assets_file}")
    print(f"Total objects: {len(env.objects)}")

    text_assets = [o for o in env.objects if o.type.name == "TextAsset"]
    print(f"TextAsset count: {len(text_assets)}")

    # Each TextAsset: dump name, size, first 200 chars, and ItemName_ hit count.
    print()
    print(f"{'Idx':>3}  {'path_id':>10}  {'size':>8}  {'ItemName':>8}  Name")
    print("-" * 90)
    for i, obj in enumerate(text_assets):
        try:
            data = obj.read()
        except Exception as e:
            print(f"{i:>3}  ERROR: {e}")
            continue
        name = getattr(data, "m_Name", None) or "<no name>"
        text = getattr(data, "m_Text", None)
        if text is None:
            script = getattr(data, "m_Script", None)
            if isinstance(script, bytes):
                text = script.decode("utf-8", errors="replace")
            elif script is not None:
                text = str(script)
        if text is None:
            text = ""
        size = len(text.encode("utf-8", errors="replace"))
        hits = len(ITEM_NAME_RE.findall(text))
        print(f"{i:>3}  {obj.path_id:>10}  {size:>8}  {hits:>8}  {name}")

    # Find the TextAsset with the most ItemName_ hits and dump its structure.
    best_obj = None
    best_hits = 0
    for obj in text_assets:
        try:
            data = obj.read()
        except Exception:
            continue
        text = getattr(data, "m_Text", None)
        if text is None:
            script = getattr(data, "m_Script", None)
            if isinstance(script, bytes):
                text = script.decode("utf-8", errors="replace")
            elif script is not None:
                text = str(script)
        if text is None:
            continue
        hits = len(ITEM_NAME_RE.findall(text))
        if hits > best_hits:
            best_hits = hits
            best_obj = obj

    if best_obj is None or best_hits == 0:
        print("\nNo ItemName_ entries found in any TextAsset.")
        return 1

    print()
    print(f"=== Best TextAsset: path_id={best_obj.path_id} hits={best_hits} ===")
    data = best_obj.read()
    name = getattr(data, "m_Name", None) or "<no name>"
    text = getattr(data, "m_Text", None)
    if text is None:
        script = getattr(data, "m_Script", None)
        if isinstance(script, bytes):
            text = script.decode("utf-8", errors="replace")
        elif script is not None:
            text = str(script)
    print(f"Name: {name}")
    print(f"Size: {len(text)} chars")
    print(f"First 500 chars:")
    print(text[:500])
    print("...")
    print(f"Last 300 chars:")
    print(text[-300:])

    # Try to parse as JSON.
    try:
        payload = json.loads(text)
        print()
        print(f"JSON parse OK. Top-level keys: {list(payload.keys())[:20]}")
        # Show structure of first entry.
        for k, v in payload.items():
            if isinstance(v, list) and v:
                print(f"  {k}: list of {len(v)} items; first item type: {type(v[0]).__name__}")
                if isinstance(v[0], dict):
                    print(f"    first item keys: {list(v[0].keys())[:10]}")
                    print(f"    first item: {json.dumps(v[0], ensure_ascii=False)[:300]}")
                break
    except json.JSONDecodeError as e:
        print(f"\nNot JSON: {e}")
        # Maybe CSV or pipe-separated.
        print(f"First 3 lines:")
        for line in text.splitlines()[:3]:
            print(f"  {line[:200]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
