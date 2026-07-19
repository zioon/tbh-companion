#!/usr/bin/env python3
"""
Parse all length-prefixed strings from localization bundle MonoBehaviours.

Unity Localization's StringTable serialization (IL2CPP, no type tree) stores
entries as a sequence of:
    [key_id: 8 bytes] [value_hash: 8 bytes] [value_len: 4 bytes] [value_str]

We scan the raw bytes for the pattern: 8-byte key + 8-byte hash + 4-byte
length + printable string of that length. Output is a map {key_id: value}.

For item names, the key_id IS the numeric suffix of ItemName_XXX (verified
by cross-referencing with the catalog CSV — ItemKey 530017 has NameKey
"ItemName_530017", and the bundle should contain key_id=530017 → "Ethereal
Ring" or similar).
"""

from __future__ import annotations

import json
import os
import re
import sys
import struct

import UnityPy


def extract_strings(raw: bytes) -> dict[int, str]:
    """
    Scan raw bytes for length-prefixed strings preceded by a 16-byte
    (key_id + hash) header. Returns a map of key_id → value.

    Heuristic: we look for the pattern `XX XX XX XX XX XX XX XX  HH HH HH HH HH HH HH HH  LL LL LL LL  <L bytes of printable text>`
    where LL is a reasonable string length (1..200) and the bytes after
    are mostly printable ASCII / valid UTF-8.

    This is a brute-force scan — we try every offset and validate.
    """
    results: dict[int, str] = {}
    n = len(raw)
    # We scan for the 4-byte length field first (faster than trying every offset).
    # For each candidate length, check if the preceding 16 bytes look like a
    # key_id + hash (any bytes), and the following bytes are a valid string.
    i = 0
    while i < n - 4:
        # Read 4-byte LE length at offset i.
        slen = struct.unpack_from("<I", raw, i)[0]
        if slen < 1 or slen > 200:
            i += 1
            continue
        # Check if there's room for the string.
        if i + 4 + slen > n:
            i += 1
            continue
        # Check if the candidate bytes are mostly printable.
        candidate = raw[i + 4:i + 4 + slen]
        try:
            s = candidate.decode("utf-8")
        except UnicodeDecodeError:
            i += 1
            continue
        # At least 70% printable ASCII (allow unicode letters).
        printable = sum(1 for c in s if 0x20 <= ord(c) < 0x7f or ord(c) > 0x7f)
        if printable < slen * 0.8:
            i += 1
            continue
        # Reject if it looks like a C# identifier (likely a key, not a value).
        if re.match(r"^[A-Z][a-zA-Z0-9_]+$", s) and "_" in s and len(s) > 8:
            i += 1
            continue
        # The 16 bytes before should be key_id (8B) + hash (8B). We don't
        # validate the hash, just read the key_id.
        if i < 16:
            i += 1
            continue
        key_id = struct.unpack_from("<Q", raw, i - 16)[0]
        # Key IDs for item names are in the range 100000..999999 (matching
        # ItemKey range). For UI strings they're smaller (1..10000). Accept
        # a wide range and let the caller filter.
        if key_id < 1 or key_id > 9_999_999:
            i += 1
            continue
        # Deduplicate — keep the first occurrence.
        if key_id not in results:
            results[key_id] = s
        # Skip past this string.
        i += 4 + slen
        # Align to 4 bytes (Unity serialization aligns to 4).
        while i % 4 != 0 and i < n:
            i += 1
    return results


def main() -> int:
    bundle = (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
        r"\StreamingAssets\aa\StandaloneWindows64"
        r"\localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
    )
    if len(sys.argv) > 1:
        bundle = sys.argv[1]

    print(f"Loading {os.path.basename(bundle)}")
    env = UnityPy.load(bundle)

    all_strings: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            raw = obj.get_raw_data()
        except Exception as e:
            print(f"  path_id={obj.path_id} read error: {e}")
            continue
        print(f"\npath_id={obj.path_id} raw_size={len(raw)}")
        strings = extract_strings(raw)
        print(f"  extracted {len(strings)} strings")
        # Show first 10 + check for item-name range.
        item_range_count = sum(1 for k in strings if 100_000 <= k <= 999_999)
        print(f"  strings in item-key range (100k..1M): {item_range_count}")
        for k in sorted(strings.keys())[:10]:
            print(f"    {k}: {strings[k][:60]}")
        # Merge.
        for k, v in strings.items():
            if k not in all_strings:
                all_strings[k] = v

    print()
    print(f"=== Total extracted: {len(all_strings)} strings ===")
    item_range = {k: v for k, v in all_strings.items() if 100_000 <= k <= 999_999}
    print(f"Strings in item-key range (100k..1M): {len(item_range)}")

    # Show samples from the item range.
    print()
    print("=== Sample item-range strings ===")
    for k in sorted(item_range.keys())[:20]:
        print(f"  {k}: {item_range[k]}")
    print("...")
    for k in sorted(item_range.keys())[-10:]:
        print(f"  {k}: {item_range[k]}")

    # Check for our target.
    target = all_strings.get(530017)
    print()
    print(f"=== Target key_id 530017: {target!r} ===")
    target2 = all_strings.get(620017)
    print(f"=== Target key_id 620017: {target2!r} ===")

    # Write JSON.
    out_path = os.path.join(os.path.dirname(__file__), "loc-strings-en.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "source": os.path.basename(bundle),
                "count": len(all_strings),
                "item_range_count": len(item_range),
                "strings": [
                    {"key_id": k, "value": v}
                    for k, v in sorted(all_strings.items())
                ],
            },
            f,
            indent=2,
            ensure_ascii=False,
        )
    print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
