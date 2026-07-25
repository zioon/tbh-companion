#!/usr/bin/env python3
"""
Extract stage / hero / item / difficulty names from the game's Unity
Localization bundles for the 4 locales the companion app supports
(en, zh-CN, ja, ko).

Outputs 4 JSON files under data/:
  - locale_strings_en.json
  - locale_strings_zh-CN.json
  - locale_strings_ja.json
  - locale_strings_ko.json

Each file has the shape:
  {
    "source": "game v1.00.28 localization bundles",
    "fetchedUtc": "2026-07-19T...",
    "items": { "<itemKey>": "<localized name>", ... },        # ~5885 entries
    "stages": { "<act><stage>": "<localized name>", ... },    # 30 entries (4-digit key)
    "heroes": { "<heroKey>": "<localized name>", ... },       # 6 entries
    "difficulties": { "NORMAL": "Normal", ... }               # 4 entries
  }

Pipeline:
  1. Load localization-assets-shared_assets_all.bundle → SharedTableData
     with m_Entries[i] = { m_Id, m_Key, m_Metadata }. Build m_Id → m_Key map.
  2. For each of the 4 locale bundles:
       Load <locale>_string-tables_assets_all.bundle → StringTable
       with m_TableData[i] = { m_Id, m_Localized, m_Metadata }.
       Build m_Id → m_Localized map.
  3. Join: m_Key → m_Localized via shared m_Id.
  4. Partition by key prefix (ItemName_ / StageName_ / HeroName_ / Difficulty_).
  5. Expand items by ItemKey: read ItemInfoData CSV from sharedassets0.assets,
     build ItemKey → NameKey ID map, then for each ItemKey look up the
     NameKey's localized value. Multiple ItemKeys can share one NameKey
     (equipment rarity variants — e.g. ItemKey 300001/301011/301012 all
     use NameKey ItemName_300001). The expanded items dict uses ItemKey
     as the key so the companion app can look up by `String(item.id)`
     directly (matching gameItemName's contract).

Usage:
  python scripts/extract_locale_catalog.py [game_data_dir] [output_dir]

Defaults:
  game_data_dir = D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data\\StreamingAssets\\aa\\StandaloneWindows64
  output_dir    = <repo_root>/data
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

import UnityPy

# Locale bundle filename → output language code.
LOCALE_BUNDLES = {
    "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle": "en",
    "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle": "zh-CN",
    "localization-string-tables-japanese(japan)(ja-jp)_assets_all.bundle": "ja",
    "localization-string-tables-korean(southkorea)(ko-kr)_assets_all.bundle": "ko",
}

SHARED_BUNDLE = "localization-assets-shared_assets_all.bundle"
# sharedassets0.assets lives one level above the StreamingAssets/aa dir.
SHAREDASSETS_NAME = "sharedassets0.assets"

# Key prefixes in SharedTableData.m_Entries[i].m_Key.
PREFIX_ITEM = "ItemName_"
PREFIX_STAGE = "StageName_"
PREFIX_HERO = "HeroName_"
PREFIX_DIFF = "Difficulty_"

ITEMKEY_RE = re.compile(r"^\d+$")
ITEM_NAME_KEY_RE = re.compile(r"^ItemName_(\d+)$")


def build_id_to_key(shared_bundle_path: str) -> dict[int, str]:
    """SharedTableData.m_Entries[i] = { m_Id: long, m_Key: string, m_Metadata }.
    Return m_Id → m_Key map."""
    env = UnityPy.load(shared_bundle_path)
    result: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        # SharedTableData has m_Entries list.
        entries = tree.get("m_Entries") or tree.get("m_TableData") or []
        for entry in entries:
            m_id = entry.get("m_Id")
            m_key = entry.get("m_Key")
            if m_id is None or not m_key:
                continue
            result[int(m_id)] = str(m_key)
    return result


def build_id_to_value(locale_bundle_path: str) -> dict[int, str]:
    """StringTable.m_TableData[i] = { m_Id: long, m_Localized: string, m_Metadata }.
    Return m_Id → m_Localized map."""
    env = UnityPy.load(locale_bundle_path)
    result: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        entries = tree.get("m_TableData") or []
        for entry in entries:
            m_id = entry.get("m_Id")
            m_value = entry.get("m_Localized")
            if m_id is None or m_value is None:
                continue
            result[int(m_id)] = str(m_value)
    return result


def partition_keys(
    id_to_key: dict[int, str],
    id_to_value: dict[int, str],
) -> dict:
    """Join via m_Id, partition by key prefix.

    Returns dict with raw NameKey-ID-keyed items (not yet expanded by ItemKey).
    The caller will expand items via CSV ItemKey → NameKey ID map.
    """
    items_by_namekeyid: dict[str, str] = {}
    stages: dict[str, str] = {}
    heroes: dict[str, str] = {}
    difficulties: dict[str, str] = {}
    for m_id, key in id_to_key.items():
        value = id_to_value.get(m_id)
        if value is None:
            continue
        if key.startswith(PREFIX_ITEM):
            items_by_namekeyid[key[len(PREFIX_ITEM):]] = value
        elif key.startswith(PREFIX_STAGE):
            stages[key[len(PREFIX_STAGE):]] = value
        elif key.startswith(PREFIX_HERO):
            heroes[key[len(PREFIX_HERO):]] = value
        elif key.startswith(PREFIX_DIFF):
            difficulties[key[len(PREFIX_DIFF):]] = value
    return {
        "items_by_namekeyid": items_by_namekeyid,
        "stages": stages,
        "heroes": heroes,
        "difficulties": difficulties,
    }


def parse_textasset_raw(raw: bytes) -> tuple[str | None, str | None]:
    """Parse a TextAsset's raw serialization bytes (IL2CPP, no type tree).

    Layout: [4B name_len][name bytes][pad to 4][4B script_len][script bytes][pad to 4]
    Returns (name, script_text) — both None on parse failure.
    """
    if len(raw) < 8:
        return None, None
    name_len = struct.unpack_from("<I", raw, 0)[0]
    if name_len > 256 or 4 + name_len > len(raw):
        return None, None
    try:
        name = raw[4:4 + name_len].decode("utf-8")
    except UnicodeDecodeError:
        return None, None
    off = 4 + name_len
    while off % 4 != 0:
        off += 1
    if off + 4 > len(raw):
        return name, None
    script_len = struct.unpack_from("<I", raw, off)[0]
    if script_len > 50_000_000 or off + 4 + script_len > len(raw):
        return name, None
    try:
        script = raw[off + 4:off + 4 + script_len].decode("utf-8")
    except UnicodeDecodeError:
        return name, None
    return name, script


def load_csv_text(game_data_dir: str) -> str:
    """Extract ItemInfoData CSV text from sharedassets0.assets.

    Uses raw byte parsing — UnityPy's obj.read() doesn't always populate
    m_Text / m_Script for IL2CPP TextAssets without a type tree.
    """
    # sharedassets0.assets is at <game_data_dir>/../sharedassets0.assets
    # (game_data_dir ends in .../StreamingAssets/aa/StandaloneWindows64)
    aa_dir = Path(game_data_dir)
    streaming_assets_dir = aa_dir.parent.parent  # .../StreamingAssets
    data_dir = streaming_assets_dir.parent  # .../TaskbarHero_Data
    sharedassets_path = data_dir / SHAREDASSETS_NAME
    env = UnityPy.load(str(sharedassets_path))
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        try:
            raw = obj.get_raw_data()
        except Exception:
            continue
        name, script = parse_textasset_raw(raw)
        if name == "ItemInfoData" and script:
            print(f"  Found ItemInfoData via raw parse: {len(script)} chars")
            return script
    raise RuntimeError("ItemInfoData TextAsset not found in sharedassets0.assets")


def build_itemkey_to_namekeyid(csv_text: str) -> dict[int, str]:
    """Parse ItemInfoData CSV, return ItemKey → NameKey ID (as string).

    Only rows whose NameKey is `ItemName_<id>` are included. Rows with
    literal names (e.g. 'Normal Monster Box 1') are skipped — they have
    no localization key and will be handled by the renderer fallback.
    """
    # utf-8-sig strips the BOM that makes the first column '\ufeffItemKey'.
    reader = csv.DictReader(io.StringIO(csv_text, newline=""))
    result: dict[int, str] = {}
    for row in reader:
        ik_str = (
            row.get("ItemKey")
            or row.get("\ufeffItemKey")
            or row.get("itemKey")
            or ""
        ).strip()
        if not ITEMKEY_RE.match(ik_str):
            continue
        item_key = int(ik_str)
        name_key = (row.get("NameKey") or "").strip()
        m = ITEM_NAME_KEY_RE.match(name_key)
        if not m:
            continue
        result[item_key] = m.group(1)
    return result


def expand_items_by_itemkey(
    items_by_namekeyid: dict[str, str],
    itemkey_to_namekeyid: dict[int, str],
) -> dict[str, str]:
    """Build ItemKey → localized name dict by joining CSV ItemKey → NameKey ID
    with the localization bundle's NameKey ID → localized value.

    Multiple ItemKeys sharing one NameKey ID all get the same localized value
    (equipment rarity variants share the base item's name).

    Also includes the raw NameKey ID as a key (fallback for NameKey-only
    entries that don't appear in the CSV — e.g. base ids like 620017 that
    the game's BoxOpenLog may emit directly).
    """
    items: dict[str, str] = {}
    # First pass: ItemKey → localized value via CSV join.
    for item_key, namekey_id in itemkey_to_namekeyid.items():
        value = items_by_namekeyid.get(namekey_id)
        if value is not None:
            items[str(item_key)] = value
    # Second pass: include NameKey IDs that have translations but aren't in
    # the CSV (base ids emitted by BoxOpenLog). These keep their NameKey ID
    # as the dict key so gameItemName(item with id == namekey_id) still hits.
    for namekey_id, value in items_by_namekeyid.items():
        items.setdefault(namekey_id, value)
    return items


def main() -> int:
    default_game_dir = (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
        r"\StreamingAssets\aa\StandaloneWindows64"
    )
    game_dir = sys.argv[1] if len(sys.argv) > 1 else default_game_dir
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else repo_root / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    shared_path = os.path.join(game_dir, SHARED_BUNDLE)
    print(f"Loading shared table: {SHARED_BUNDLE}")
    id_to_key = build_id_to_key(shared_path)
    print(f"  {len(id_to_key)} shared entries")

    print("Loading ItemInfoData CSV for ItemKey → NameKey ID map...")
    csv_text = load_csv_text(game_dir)
    itemkey_to_namekeyid = build_itemkey_to_namekeyid(csv_text)
    print(
        f"  {len(itemkey_to_namekeyid)} CSV rows with ItemName_ NameKey "
        f"({len(set(itemkey_to_namekeyid.values()))} unique NameKey IDs)"
    )

    fetched_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
    output_files: dict[str, str] = {}

    for bundle_name, lang_code in LOCALE_BUNDLES.items():
        bundle_path = os.path.join(game_dir, bundle_name)
        print(f"\nLoading locale bundle: {bundle_name}")
        id_to_value = build_id_to_value(bundle_path)
        print(f"  {len(id_to_value)} localized entries")
        partitioned = partition_keys(id_to_key, id_to_value)
        items_by_namekeyid = partitioned["items_by_namekeyid"]
        items = expand_items_by_itemkey(items_by_namekeyid, itemkey_to_namekeyid)
        print(
            f"  items_by_namekeyid={len(items_by_namekeyid)} "
            f"items_by_itemkey={len(items)} "
            f"stages={len(partitioned['stages'])} "
            f"heroes={len(partitioned['heroes'])} "
            f"difficulties={len(partitioned['difficulties'])}"
        )
        payload = {
            "source": "game v1.00.28 localization bundles",
            "fetchedUtc": fetched_utc,
            "items": items,
            "stages": partitioned["stages"],
            "heroes": partitioned["heroes"],
            "difficulties": partitioned["difficulties"],
        }
        out_path = out_dir / f"locale_strings_{lang_code}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"  wrote {out_path}")
        output_files[lang_code] = str(out_path)

    print("\n=== Done ===")
    for lang, path in output_files.items():
        print(f"  {lang}: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
