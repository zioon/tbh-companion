#!/usr/bin/env python3
"""Dump raw bytes of MonoBehaviour objects in the English localization bundle."""

from __future__ import annotations

import binascii
import os
import sys

import UnityPy


def main() -> int:
    bundle = (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
        r"\StreamingAssets\aa\StandaloneWindows64"
        r"\localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
    )
    env = UnityPy.load(bundle)
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            raw = obj.get_raw_data()
        except Exception as e:
            print(f"path_id={obj.path_id} read error: {e}")
            continue
        print(f"\n=== path_id={obj.path_id} size={obj.byte_size} raw={len(raw)} ===")
        # Dump first 512 bytes as hex+ascii.
        n = min(len(raw), 512)
        for off in range(0, n, 16):
            chunk = raw[off:off + 16]
            hex_part = " ".join(f"{b:02x}" for b in chunk)
            ascii_part = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in chunk)
            print(f"  {off:04x}  {hex_part:<48}  {ascii_part}")
        # Count occurrences of ItemName_ in the full raw.
        text = raw.decode("utf-8", errors="replace")
        count = text.count("ItemName_")
        print(f"  ItemName_ occurrences: {count}")
        # Show first 5 ItemName_ contexts (40 chars around each).
        idx = 0
        shown = 0
        while shown < 5:
            pos = text.find("ItemName_", idx)
            if pos == -1:
                break
            ctx = text[max(0, pos - 20):pos + 60]
            print(f"    @{pos}: ...{ctx}...")
            idx = pos + 9
            shown += 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
