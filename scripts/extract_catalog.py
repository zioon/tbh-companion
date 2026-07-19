#!/usr/bin/env python3
"""
Extract game item catalog from TBH's sharedassets0.assets.

The game ships an `ItemInfoData` TextAsset containing a CSV with 5895+ items
(full item catalog). This script extracts it and writes a gamedata.json file
compatible with the companion app's `data/gamedata.json` format.

CSV columns (v1.00.28):
    ItemKey, ITEMTYPE, GRADE, PARTS, GEARTYPE, GearGroup, ItemSynthesisType,
    NameKey, DescriptionKey, GearKey, DropKey, DropCooldown, Level, IsSteamItem,
    IconPath, IsBucketBox, IsDeletedInServer, IsCanExchangeMarketable, IsTempMarketableFalse

Output format matches app/src/core/gamedata.ts GameItem interface:
    {
      "source": "...",
      "fetchedUtc": "...",
      "gameVersion": "1.00.28",
      "count": N,
      "items": [
        { "id": 910011, "name": "Normal Monster Box 1", "grade": "COMMON",
          "type": "STAGEBOX", "level": null, "marketTradable": true }
      ]
    }

Name resolution: NameKey is either "ItemName_XXXXXX" (use the XXXXXX as a
lookup key into a localization bundle later) or a literal display name like
"Normal Monster Box 1". For literal names we use them directly. For
ItemName_ keys we emit the key as-is; the companion app can later resolve
them via a localization bundle, OR we run a second pass to patch names from
the English localization bundle.

Usage:
    python scripts/extract_catalog.py [--game-dir GAME_DIR] [--out OUT_PATH]

Examples:
    python scripts/extract_catalog.py
    python scripts/extract_catalog.py --out data/gamedata.json
"""

from __future__ import annotations

import argparse
import csv
import datetime
import io
import json
import os
import re
import sys

import UnityPy


ITEM_NAME_RE = re.compile(r"^ItemName_(\d+)$")

# CSV columns (v1.00.28). We tolerate extra/missing trailing columns.
EXPECTED_COLUMNS = [
    "ItemKey", "ITEMTYPE", "GRADE", "PARTS", "GEARTYPE", "GearGroup",
    "ItemSynthesisType", "NameKey", "DescriptionKey", "GearKey", "DropKey",
    "DropCooldown", "Level", "IsSteamItem", "IconPath", "IsBucketBox",
    "IsDeletedInServer", "IsCanExchangeMarketable", "IsTempMarketableFalse",
]


def parse_bool(s: str) -> bool:
    """Parse Unity-style bool from CSV: 'True'/'False' (case-insensitive)."""
    if not s:
        return False
    return s.strip().lower() in ("true", "1", "yes")


def parse_int_or_none(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def resolve_name(name_key: str, item_key: int) -> str:
    """
    Resolve a NameKey to a display name. v1.00.28 NameKey is either:
      - "ItemName_XXXXXX" (localization key) — we can't resolve it here
        without the localization bundle, so emit "#XXXXXX" as placeholder.
        The companion app will later resolve via overlay.
      - A literal display name like "Normal Monster Box 1" — use as-is.
    """
    if not name_key:
        return f"#{item_key}"
    m = ITEM_NAME_RE.match(name_key)
    if m:
        # Localization key — return the key itself; companion app resolves.
        # We use the ItemName_ prefix so the overlay loader can detect it.
        return name_key
    return name_key


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract TBH item catalog")
    parser.add_argument(
        "--game-dir",
        default=r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data",
        help="Path to TaskbarHero_Data directory",
    )
    parser.add_argument(
        "--out",
        default="data/gamedata.json",
        help="Output path (relative to repo root or absolute)",
    )
    parser.add_argument(
        "--game-version",
        default="1.00.28",
        help="Game version label to embed in the catalog",
    )
    args = parser.parse_args()

    assets_file = os.path.join(args.game_dir, "sharedassets0.assets")
    if not os.path.isfile(assets_file):
        print(f"ERROR: {assets_file} not found", file=sys.stderr)
        return 2

    print(f"Loading {assets_file}")
    env = UnityPy.load(assets_file)

    # Find the ItemInfoData TextAsset.
    item_info_obj = None
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        try:
            data = obj.read()
        except Exception:
            continue
        name = getattr(data, "m_Name", None) or ""
        if name == "ItemInfoData":
            item_info_obj = obj
            break

    if item_info_obj is None:
        print("ERROR: ItemInfoData TextAsset not found", file=sys.stderr)
        return 1

    data = item_info_obj.read()
    text = getattr(data, "m_Text", None)
    if text is None:
        script = getattr(data, "m_Script", None)
        if isinstance(script, bytes):
            text = script.decode("utf-8-sig", errors="replace")
        elif script is not None:
            text = str(script)
    if text is None:
        print("ERROR: could not extract text from ItemInfoData", file=sys.stderr)
        return 1

    # Strip BOM if present.
    if text.startswith("\ufeff"):
        text = text[1:]

    print(f"ItemInfoData size: {len(text)} chars")

    # Parse CSV.
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = reader.fieldnames or []
    print(f"CSV columns: {fieldnames}")

    # Validate required columns.
    missing = [c for c in EXPECTED_COLUMNS[:3] if c not in fieldnames]
    if missing:
        print(f"ERROR: missing required columns: {missing}", file=sys.stderr)
        return 1

    items = []
    skipped = 0
    for row in reader:
        item_key_str = (row.get("ItemKey") or "").strip()
        if not item_key_str:
            skipped += 1
            continue
        try:
            item_key = int(item_key_str)
        except ValueError:
            skipped += 1
            continue

        item_type = (row.get("ITEMTYPE") or "UNKNOWN").strip()
        grade = (row.get("GRADE") or "UNKNOWN").strip()
        name_key = (row.get("NameKey") or "").strip()
        name = resolve_name(name_key, item_key)
        level = parse_int_or_none(row.get("Level") or "")
        # marketTradable: IsCanExchangeMarketable OR IsTempMarketableFalse
        # (latter True means NOT temporarily marketable, i.e. fully marketable).
        market_tradable = parse_bool(row.get("IsCanExchangeMarketable") or "")

        items.append({
            "id": item_key,
            "name": name,
            "grade": grade,
            "type": item_type,
            "level": level,
            "marketTradable": market_tradable,
        })

    print(f"Parsed {len(items)} items ({skipped} skipped)")

    # Stats by type / grade.
    by_type: dict[str, int] = {}
    by_grade: dict[str, int] = {}
    unresolved_names = 0
    for it in items:
        by_type[it["type"]] = by_type.get(it["type"], 0) + 1
        by_grade[it["grade"]] = by_grade.get(it["grade"], 0) + 1
        if it["name"].startswith("ItemName_"):
            unresolved_names += 1

    print()
    print("=== Stats ===")
    print(f"By type: {dict(sorted(by_type.items(), key=lambda x: -x[1]))}")
    print(f"By grade: {dict(sorted(by_grade.items(), key=lambda x: -x[1]))}")
    print(f"Names needing localization resolve: {unresolved_names}/{len(items)}")

    # Sample items (first 5 + last 5).
    print()
    print("=== Sample items ===")
    for it in items[:5]:
        print(f"  {it['id']:>8}  {it['type']:<10}  {it['grade']:<10}  {it['name']}")
    print(f"  ... ({len(items) - 10} more) ...")
    for it in items[-5:]:
        print(f"  {it['id']:>8}  {it['type']:<10}  {it['grade']:<10}  {it['name']}")

    # Check for our target itemKey 620017.
    print()
    target = next((it for it in items if it["id"] == 620017), None)
    if target:
        print(f"=== Target itemKey 620017 ===")
        print(f"  {target}")
    else:
        print(f"WARNING: itemKey 620017 not found in catalog")

    # Write output.
    out_path = args.out
    if not os.path.isabs(out_path):
        # Resolve relative to repo root (parent of scripts/).
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        out_path = os.path.join(repo_root, out_path)
    fetched_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload = {
        "source": f"sharedassets0.assets/ItemInfoData (game v{args.game_version})",
        "fetchedUtc": fetched_utc,
        "gameVersion": args.game_version,
        "count": len(items),
        "items": items,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    size_kb = os.path.getsize(out_path) // 1024
    print()
    print(f"Wrote {out_path} ({size_kb} KB, {len(items)} items)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
