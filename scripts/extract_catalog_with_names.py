#!/usr/bin/env python3
"""
Extract full TBH item catalog with resolved names.

Strategy:
  1. Parse ItemInfoData CSV from sharedassets0.assets → get all 5954 items
     with ItemKey, type, grade, NameKey (which is either a literal name for
     STAGEBOX or "ItemName_XXX" for GEAR/MATERIAL).
  2. Parse the English localization bundle's ItemTable MonoBehaviour → get
     the ordered list of localized names (materials, weapons, accessories).
  3. Build a NameKey → display-name map by matching the ORDER of names in
     the localization table to the ORDER of NameKeys in the CSV.

The localization table stores entries sequentially by item type group, and
the CSV's NameKeys follow the same grouping (610xxx = amulets, 620xxx =
rings, 630xxx = bracers, etc.). We use the CSV to determine which NameKey
ranges exist, then walk the localization names in order to fill them.

Usage:
    python scripts/extract_catalog_with_names.py
"""

from __future__ import annotations

import csv
import datetime
import io
import json
import os
import re
import struct
import sys
from collections import OrderedDict

import UnityPy


GAME_DATA_DIR = r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
ITEM_NAME_RE = re.compile(r"^ItemName_(\d+)$")


def load_item_info_csv(data_dir: str) -> list[dict[str, str]]:
    """Load and parse the ItemInfoData CSV from sharedassets0.assets."""
    assets_file = os.path.join(data_dir, "sharedassets0.assets")
    env = UnityPy.load(assets_file)
    item_obj = next(
        o for o in env.objects
        if o.type.name == "TextAsset" and o.read().m_Name == "ItemInfoData"
    )
    data = item_obj.read()
    text = getattr(data, "m_Text", None)
    if text is None:
        script = getattr(data, "m_Script", None)
        if isinstance(script, bytes):
            text = script.decode("utf-8-sig", errors="replace")
        elif script is not None:
            text = str(script)
    text = text.lstrip("\ufeff")
    return list(csv.DictReader(io.StringIO(text)))


def extract_ordered_strings(raw: bytes) -> list[str]:
    """
    Extract length-prefixed strings from localization MonoBehaviour raw
    bytes, in the ORDER they appear. Used to build an ordered name list
    that we'll match against the CSV's NameKey order.

    Looks for the pattern: [8B prev_id][4B prev_const=14][4B len][string].
    Returns strings in file order.
    """
    strings: list[str] = []
    n = len(raw)
    i = 0
    while i < n - 4:
        slen = struct.unpack_from("<I", raw, i)[0]
        if slen < 2 or slen > 200:
            i += 1
            continue
        if i + 4 + slen > n:
            i += 1
            continue
        candidate = raw[i + 4:i + 4 + slen]
        # Require strictly printable ASCII (English item names).
        if not all(0x20 <= b < 0x7f for b in candidate):
            i += 1
            continue
        try:
            s = candidate.decode("utf-8")
        except UnicodeDecodeError:
            i += 1
            continue
        # Skip C# identifiers with underscore + digits (like "ItemName_530017").
        if re.match(r"^[A-Z][a-zA-Z0-9_]*_\d+$", s):
            i += 1
            continue
        # Require prev4 == 14 (entry-type marker observed in dump).
        if i >= 4:
            prev4 = struct.unpack_from("<I", raw, i - 4)[0]
            if prev4 != 14:
                i += 1
                continue
        strings.append(s)
        i += 4 + slen
        # Align to 4 bytes.
        while i % 4 != 0 and i < n:
            i += 1
    return strings


def load_localization_names(data_dir: str) -> list[str]:
    """Load ordered item-name strings from the English localization bundle."""
    bundle = os.path.join(
        data_dir, "StreamingAssets", "aa", "StandaloneWindows64",
        "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
    )
    env = UnityPy.load(bundle)
    all_strings: list[str] = []
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            raw = obj.get_raw_data()
        except Exception:
            continue
        all_strings.extend(extract_ordered_strings(raw))
    return all_strings


def build_name_map(
    csv_rows: list[dict[str, str]],
    loc_names: list[str],
) -> dict[int, str]:
    """
    Build a map {name_key_number: display_name} by matching the ORDER of
    ItemName_XXX keys in the CSV to the ORDER of names in the localization
    bundle.

    The CSV's NameKeys follow a pattern: 610xxx (amulets), 620xxx (rings),
    630xxx (bracers), 300xxx-530xxx (weapons/armor). Within each group,
    keys go from 001 to NNN sequentially. The localization bundle stores
    the corresponding names in the same sequential order.

    We collect the UNIQUE NameKey numbers (sorted), then map the i-th
    unique NameKey to the i-th localization name.
    """
    unique_name_keys: list[int] = []
    seen = set()
    for row in csv_rows:
        nk = row.get("NameKey", "").strip()
        m = ITEM_NAME_RE.match(nk)
        if not m:
            continue
        num = int(m.group(1))
        if num not in seen:
            seen.add(num)
            unique_name_keys.append(num)
    unique_name_keys.sort()

    print(f"  CSV unique NameKeys: {len(unique_name_keys)}")
    print(f"  Localization names:  {len(loc_names)}")

    # If counts match, do a 1:1 positional mapping.
    if len(unique_name_keys) == len(loc_names):
        print("  Counts match — using positional mapping")
        return {k: v for k, v in zip(unique_name_keys, loc_names)}

    # If counts differ, log a warning but still map positionally up to the
    # shorter list. Mismatches likely indicate the bundle has extra UI
    # strings (we tried to filter them, but some may slip through) or the
    # CSV has NameKeys the bundle doesn't provide.
    print(f"  WARNING: count mismatch — mapping up to min({len(unique_name_keys)}, {len(loc_names)})")
    result = {}
    for i, k in enumerate(unique_name_keys):
        if i >= len(loc_names):
            break
        result[k] = loc_names[i]
    return result


def main() -> int:
    print("=== Step 1: Load ItemInfoData CSV ===")
    csv_rows = load_item_info_csv(GAME_DATA_DIR)
    print(f"  Loaded {len(csv_rows)} rows")

    print("\n=== Step 2: Load localization names ===")
    loc_names = load_localization_names(GAME_DATA_DIR)
    print(f"  Loaded {len(loc_names)} names")
    print(f"  First 10: {loc_names[:10]}")
    print(f"  Last 10:  {loc_names[-10:]}")

    print("\n=== Step 3: Build NameKey → name map ===")
    name_map = build_name_map(csv_rows, loc_names)
    print(f"  Mapped {len(name_map)} NameKeys to names")

    # Show a few samples including our target.
    for target in [530017, 620011, 620017, 630011]:
        print(f"  NameKey {target}: {name_map.get(target, '<unmapped>')!r}")

    print("\n=== Step 4: Build catalog items ===")
    items = []
    for row in csv_rows:
        item_key_str = row.get("ItemKey", "").strip()
        try:
            item_key = int(item_key_str)
        except ValueError:
            continue
        name_key = row.get("NameKey", "").strip()
        m = ITEM_NAME_RE.match(name_key)
        if m:
            name_key_num = int(m.group(1))
            name = name_map.get(name_key_num, name_key)  # fallback to "ItemName_XXX"
        else:
            name = name_key  # literal name (STAGEBOX)
        level_str = row.get("Level", "").strip()
        try:
            level = int(level_str) if level_str else None
        except ValueError:
            level = None
        items.append({
            "id": item_key,
            "name": name,
            "grade": (row.get("GRADE") or "UNKNOWN").strip(),
            "type": (row.get("ITEMTYPE") or "UNKNOWN").strip(),
            "level": level,
            "marketTradable": (row.get("IsCanExchangeMarketable", "").strip().lower() == "true"),
        })

    print(f"  Built {len(items)} items")
    unresolved = sum(1 for it in items if it["name"].startswith("ItemName_"))
    print(f"  Names still unresolved (ItemName_ fallback): {unresolved}")

    # Stats.
    by_type: dict[str, int] = {}
    by_grade: dict[str, int] = {}
    for it in items:
        by_type[it["type"]] = by_type.get(it["type"], 0) + 1
        by_grade[it["grade"]] = by_grade.get(it["grade"], 0) + 1
    print(f"  By type:  {dict(sorted(by_type.items(), key=lambda x: -x[1]))}")
    print(f"  By grade: {dict(sorted(by_grade.items(), key=lambda x: -x[1]))}")

    # Sample.
    print("\n=== Sample items ===")
    for it in items[:5]:
        print(f"  {it['id']:>8}  {it['type']:<10}  {it['grade']:<10}  {it['name']}")
    print("  ...")
    # Target items.
    for target_id in [530017, 620011, 621171, 628111, 620017]:
        target = next((it for it in items if it["id"] == target_id), None)
        if target:
            print(f"  TARGET {target_id}: {target['type']} {target['grade']} \"{target['name']}\"")
        else:
            print(f"  TARGET {target_id}: NOT IN CATALOG")

    # Write output.
    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "data", "gamedata.json",
    )
    fetched_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload = {
        "source": f"sharedassets0.assets/ItemInfoData + en-US localization (game v1.00.28)",
        "fetchedUtc": fetched_utc,
        "gameVersion": "1.00.28",
        "count": len(items),
        "items": items,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    size_kb = os.path.getsize(out_path) // 1024
    print(f"\nWrote {out_path} ({size_kb} KB, {len(items)} items)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
