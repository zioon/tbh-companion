#!/usr/bin/env python3
"""Probe the structure of a Unity Localization string-table bundle.

Goal: figure out the actual key format used by ItemName_/StageName_/HeroName_
entries. The previous extract_loc_strings.py assumed numeric key_id (8 bytes)
but found 0 entries in the item-key range (100k..1M), so the keys must be
strings, not numbers.

Strategy: dump the first 500 bytes of every MonoBehaviour raw data and look
for ASCII patterns like "ItemName_", "StageName_", "HeroName_". Also try
UnityPy's typed deserialization to see if the StringTable has a typed structure
we can use directly.
"""

from __future__ import annotations

import os
import re
import sys

import UnityPy


BUNDLE_DIR = (
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
)
BUNDLES = [
    "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
    "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle",
]


def probe(bundle_name: str) -> None:
    path = os.path.join(BUNDLE_DIR, bundle_name)
    print(f"\n=== {os.path.basename(path)} ===")
    env = UnityPy.load(path)

    print(f"objects: {len(env.objects)}")
    type_counts: dict[str, int] = {}
    for obj in env.objects:
        type_counts[obj.type.name] = type_counts.get(obj.type.name, 0) + 1
    print(f"type counts: {type_counts}")

    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            raw = obj.get_raw_data()
        except Exception as e:
            print(f"  path_id={obj.path_id} read error: {e}")
            continue
        print(f"\n  path_id={obj.path_id} raw_size={len(raw)}")

        # Look for ASCII patterns of interest in the raw bytes.
        text = raw.decode("latin-1", errors="replace")
        patterns = ["ItemName_", "StageName_", "HeroName_", "ItemDesc_", "StageDesc_"]
        for pat in patterns:
            hits = [m.start() for m in re.finditer(re.escape(pat), text)]
            if hits:
                print(f"    '{pat}' appears {len(hits)} times")
                # Show first 3 occurrences with surrounding context.
                for off in hits[:3]:
                    snippet = text[max(0, off - 32): off + 80]
                    # Strip non-printable.
                    snippet = "".join(c if 0x20 <= ord(c) < 0x7f else "." for c in snippet)
                    print(f"      @{off}: ...{snippet}...")

        # Try typed deserialization.
        try:
            tree = obj.read_typetree()
            print(f"    typetree keys: {list(tree.keys())[:10] if isinstance(tree, dict) else type(tree).__name__}")
            if isinstance(tree, dict):
                for k, v in list(tree.items())[:3]:
                    vs = repr(v)[:120]
                    print(f"      {k}: {vs}")
        except Exception as e:
            print(f"    typetree error: {e}")


def main() -> int:
    for b in BUNDLES:
        probe(b)
    return 0


if __name__ == "__main__":
    sys.exit(main())
