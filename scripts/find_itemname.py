#!/usr/bin/env python3
"""
Scan all game data files for the byte pattern "ItemName_530017" (the known
itemStringKey for an Ethereal Ring). This tells us which file actually
contains the localization table — we'll target that file for extraction.

Usage:
    python scripts/find_itemname.py [GAME_DATA_DIR]
"""

from __future__ import annotations

import os
import sys


PATTERN = b"ItemName_530017"


def main() -> int:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    )
    if not os.path.isdir(data_dir):
        print(f"ERROR: {data_dir} not found", file=sys.stderr)
        return 2

    hits = 0
    for root, _dirs, files in os.walk(data_dir):
        for name in sorted(files):
            full = os.path.join(root, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            # Skip huge files we can't reasonably scan line-by-line.
            try:
                with open(full, "rb") as f:
                    # Read in 64MB chunks to handle big .resS files.
                    offset = 0
                    while True:
                        chunk = f.read(64 * 1024 * 1024)
                        if not chunk:
                            break
                        idx = chunk.find(PATTERN)
                        if idx != -1:
                            rel = os.path.relpath(full, data_dir)
                            print(f"HIT: {rel} at byte {offset + idx} (file size {size:,})")
                            hits += 1
                            break
                        offset += len(chunk) - len(PATTERN) + 1
                        f.seek(offset)
            except OSError as e:
                print(f"  skip {name}: {e}", file=sys.stderr)
                continue

    print()
    print(f"Total files with pattern: {hits}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
