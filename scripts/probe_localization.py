#!/usr/bin/env python3
"""
Extract all ItemName_XXX keys from a localization bundle.

The TBH game stores localized item names in Unity Addressables bundles
(localization-string-tables-english_assets_all.bundle). Each entry is a
key like "ItemName_530017" → "Ethereal Ring" (localized text).

This script extracts all keys matching /^ItemName_(\d+)$/ from the English
bundle and outputs a JSON map { itemKey: name }. The companion app can use
this as a minimal catalog overlay (name-only; grade/type/marketTradable
remain unknown).

Usage:
    python scripts/probe_localization.py [BUNDLE_PATH]

Default BUNDLE_PATH:
    D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data\\
    StreamingAssets\\aa\\StandaloneWindows64\\
    localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle
"""

from __future__ import annotations

import json
import os
import re
import sys

import UnityPy


ITEM_NAME_RE = re.compile(r"^ItemName_(\d+)$")


def main() -> int:
    default = (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
        r"\StreamingAssets\aa\StandaloneWindows64"
        r"\localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
    )
    bundle_path = sys.argv[1] if len(sys.argv) > 1 else default
    if not os.path.isfile(bundle_path):
        print(f"ERROR: bundle not found: {bundle_path}", file=sys.stderr)
        return 2

    print(f"Loading bundle: {os.path.basename(bundle_path)}")
    env = UnityPy.load(bundle_path)

    # Dump object type counts first so we understand the structure.
    type_counts: dict[str, int] = {}
    for obj in env.objects:
        type_counts[obj.type.name] = type_counts.get(obj.type.name, 0) + 1
    print("Object types in bundle:")
    for name, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {count:>5}  {name}")

    # Localization assets are typically TextAsset (JSON) or MonoBehaviour.
    # Try TextAsset first — easiest to parse.
    found_keys: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name == "TextAsset":
            try:
                data = obj.read()
            except Exception as e:
                print(f"  WARN: TextAsset read error: {e}", file=sys.stderr)
                continue
            text = getattr(data, "m_Text", None)
            if text is None:
                script = getattr(data, "m_Script", None)
                if script is not None:
                    if isinstance(script, bytes):
                        text = script.decode("utf-8", errors="replace")
                    else:
                        text = str(script)
            if text is None:
                continue
            try:
                payload = json.loads(text)
            except Exception:
                continue
            entries = (
                payload.get("m_Entries")
                or payload.get("entries")
                or payload.get("Items")
                or payload.get("items")
                or []
            )
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                key = entry.get("Key") or entry.get("key") or entry.get("k")
                value = entry.get("Value") or entry.get("value") or entry.get("v")
                if not isinstance(key, str) or not isinstance(value, str):
                    continue
                m = ITEM_NAME_RE.match(key)
                if not m:
                    continue
                item_key = int(m.group(1))
                if item_key not in found_keys:
                    found_keys[item_key] = value
        elif obj.type.name == "MonoBehaviour":
            # Unity Localization stores StringTable as MonoBehaviour. IL2CPP
            # games don't have type trees, so we scan the raw bytes for the
            # pattern "ItemName_XXXXXX" (ASCII) followed soon after by the
            # localized string. The value is typically stored as a length-
            # prefixed UTF-8 string elsewhere in the object.
            try:
                raw = obj.get_raw_data()
            except Exception as e:
                print(f"  WARN: MonoBehaviour raw read: {e}", file=sys.stderr)
                continue
            # Scan for ItemName_XXX ASCII patterns.
            text = raw.decode("utf-8", errors="replace")
            for m in re.finditer(r"ItemName_(\d+)", text):
                item_key = int(m.group(1))
                if item_key in found_keys:
                    continue
                # Look for a nearby length-prefixed string after the key. The
                # value usually appears within ~200 bytes after the key.
                # Scan forward for a 4-byte little-endian length followed by
                # printable ASCII of that length.
                start = m.end()
                window = raw[start:start + 400]
                for i in range(0, len(window) - 4):
                    slen = int.from_bytes(window[i:i + 4], "little")
                    # Reasonable name length: 2..60 chars.
                    if slen < 2 or slen > 60:
                        continue
                    if i + 4 + slen > len(window):
                        continue
                    candidate = window[i + 4:i + 4 + slen]
                    try:
                        s = candidate.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                    # Must be mostly printable ASCII (allow some unicode).
                    printable = sum(1 for c in s if 0x20 <= ord(c) < 0x7f or ord(c) > 0x7f)
                    if printable < slen * 0.7:
                        continue
                    # Reject if it looks like another key (contains underscore + digits).
                    if re.match(r"^[A-Z][a-zA-Z]+_\d+$", s):
                        continue
                    found_keys[item_key] = s
                    break

    print()
    print(f"=== Extracted {len(found_keys)} ItemName entries ===")
    # Show first 30 + last 10 to verify the range.
    sorted_keys = sorted(found_keys.keys())
    for k in sorted_keys[:30]:
        print(f"  {k:>8}  {found_keys[k]}")
    if len(sorted_keys) > 40:
        print(f"  ... ({len(sorted_keys) - 40} more) ...")
    for k in sorted_keys[-10:]:
        print(f"  {k:>8}  {found_keys[k]}")

    # Write to scripts/itemname-extracted.json for inspection.
    out_path = os.path.join(os.path.dirname(__file__), "itemname-extracted.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "source": os.path.basename(bundle_path),
                "count": len(found_keys),
                "items": [
                    {"itemKey": k, "name": found_keys[k]}
                    for k in sorted(found_keys.keys())
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
