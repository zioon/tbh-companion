"""Extract gamedata.json from ItemInfoData CSV + Unity Localization bundles.

Linking strategy: each entry in SharedTableData (ItemName_XXX key) shares a
4-byte hash with the corresponding entry in the locale's StringTable (localized
value). Hash is the reliable linker — key_id is only non-zero on the first
entry, and position order differs between files (SharedTableData is sorted by
ItemKey; StringTable is sorted by hash).

Inputs (read-only from the game install):
  - sharedassets0.assets → ItemInfoData TextAsset (CSV, 5954 rows)
  - localization-assets-shared_assets_all.bundle → ItemTable SharedTableData
  - localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle
    → ItemTable_en-US StringTable

Output: data/gamedata.json with GameItem rows ({id, name, grade, type, level,
marketTradable}). Also adds "NameKey-only" rows for ItemName_XXX keys present
in the localization bundle but absent from the CSV (base ids like 620017 that
the game's BoxOpenLog may emit as itemStringKey).
"""
import csv
import io
import json
import re
import struct
from pathlib import Path

import UnityPy

STEAM = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data")
AA = STEAM / "StreamingAssets" / "aa" / "StandaloneWindows64"
SHAREDASSETS = STEAM / "sharedassets0.assets"

SHARED_BUNDLE = AA / "localization-assets-shared_assets_all.bundle"
EN_BUNDLE = AA / "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"

OUT = Path(__file__).resolve().parent.parent / "data" / "gamedata.json"


def scan_marker_entries(raw, marker=14):
    """Scan raw bytes for [4B key_id][4B hash][4B marker][4B len][string] entries.

    Returns list of (offset, key_id, hash4, slen, string) in order of appearance.
    Does NOT advance past strings — scans every position so entries are found
    even when padding between them is irregular.
    """
    hits = []
    n = len(raw)
    i = 0
    while i < n - 16:
        m = struct.unpack_from("<I", raw, i + 8)[0]
        if m != marker:
            i += 1
            continue
        slen = struct.unpack_from("<I", raw, i + 12)[0]
        if slen == 0 or slen > 256:
            i += 1
            continue
        str_start = i + 16
        str_end = str_start + slen
        if str_end > n:
            i += 1
            continue
        try:
            s = raw[str_start:str_end].decode("utf-8")
        except UnicodeDecodeError:
            i += 1
            continue
        if not all(0x20 <= ord(c) < 0x7f or ord(c) > 0x7f for c in s):
            i += 1
            continue
        key_id = struct.unpack_from("<I", raw, i)[0]
        hash4 = struct.unpack_from("<I", raw, i + 4)[0]
        hits.append((i, key_id, hash4, slen, s))
        # Advance past this entry to avoid overlapping matches inside the string.
        i = str_end
        while i % 4 != 0:
            i += 1
    return hits


def load_shared_by_hash():
    """Load SharedTableData entries keyed by hash.

    Returns dict: hash -> ItemName_XXX (or ItemDescription_XXX).
    Hash is the reliable linker between SharedTableData and StringTable.
    """
    env = UnityPy.load(str(SHARED_BUNDLE))
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        # ItemTable Shared Data is the smaller one (~21KB); StringTable Shared is ~52KB.
        if len(raw) < 30000:  # ItemTable Shared Data
            hits = scan_marker_entries(raw, marker=14)
            by_hash = {}
            for off, kid, h, sl, s in hits:
                by_hash[h] = s
            return by_hash
    return {}


def load_en_by_hash():
    """Load EN StringTable entries keyed by hash.

    Returns dict: hash -> localized string.
    """
    env = UnityPy.load(str(EN_BUNDLE))
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        # ItemTable_en-US is ~28KB; StringTable_en-US is ~95KB.
        if len(raw) < 60000:  # ItemTable_en-US
            hits = scan_marker_entries(raw, marker=14)
            by_hash = {}
            for off, kid, h, sl, s in hits:
                by_hash[h] = s
            return by_hash
    return {}


def build_name_map():
    """Build ItemName_XXX -> localized string by matching hash.

    Hash is the reliable linker: each entry in SharedTableData has a 4B hash
    that exactly matches the hash of the corresponding entry in StringTable.
    Position is NOT reliable (SharedTableData is sorted by ItemKey;
    StringTable is sorted by hash).
    """
    shared_by_hash = load_shared_by_hash()
    en_by_hash = load_en_by_hash()
    print(f"SharedTableData: {len(shared_by_hash)} entries (by hash)")
    print(f"EN StringTable:  {len(en_by_hash)} entries (by hash)")
    inter = set(shared_by_hash.keys()) & set(en_by_hash.keys())
    print(f"Hash intersection: {len(inter)}")

    name_map = {}
    desc_map = {}
    for h in inter:
        k = shared_by_hash[h]
        v = en_by_hash[h]
        if k.startswith("ItemName_"):
            name_map[k] = v
        elif k.startswith("ItemDescription_"):
            desc_map[k] = v
    print(f"Merged: {len(name_map)} ItemName_ + {len(desc_map)} ItemDescription_ mappings")
    # Spot-check.
    for nk in ["ItemName_110001", "ItemName_530017", "ItemName_620011", "ItemName_620017", "ItemName_628111"]:
        print(f"  {nk} -> {name_map.get(nk, '<MISSING>')!r}")
    return name_map


def parse_textasset_raw(raw):
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


def load_csv_text():
    """Extract ItemInfoData CSV text from sharedassets0.assets.

    Uses raw byte parsing — UnityPy's obj.read() doesn't always populate
    m_Text / m_Script for IL2CPP TextAssets without a type tree.
    """
    env = UnityPy.load(str(SHAREDASSETS))
    textassets = []
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        try:
            raw = obj.get_raw_data()
        except Exception:
            continue
        name, script = parse_textasset_raw(raw)
        if name is None:
            continue
        textassets.append((name, script, len(raw)))
        if name == "ItemInfoData":
            if script:
                print(f"  Found ItemInfoData via raw parse: {len(script)} chars")
                return script
            print(f"  Found ItemInfoData but script is empty (raw_size={len(raw)})")
    # Debug: list what we saw.
    names = sorted(set(n for n, _, _ in textassets))
    raise RuntimeError(
        f"ItemInfoData not parseable. Saw {len(textassets)} TextAssets. "
        f"Unique names ({len(names)}): {names}"
    )


ITEMKEY_RE = re.compile(r"^\d+$")


def parse_bool(s):
    """Parse CSV boolean field (True/False/empty)."""
    if not s:
        return False
    return s.strip().lower() in ("true", "1", "yes")


def main():
    print("=== Step 1: Build name map from localization bundles ===")
    name_map = build_name_map()

    print("\n=== Step 2: Load ItemInfoData CSV ===")
    csv_text = load_csv_text()
    print(f"  CSV size: {len(csv_text)} chars")

    # utf-8-sig strips the BOM that makes the first column '\ufeffItemKey'.
    reader = csv.DictReader(io.StringIO(csv_text, newline=""))
    # Re-wrap to ensure BOM stripping even if DictReader already saw it.
    rows = list(csv.DictReader(io.StringIO(csv_text, newline="")))
    print(f"  Rows: {len(rows)}")
    print(f"  Columns: {reader.fieldnames}")
    if rows:
        print(f"  Sample row[0]: {rows[0]}")

    print("\n=== Step 3: Build catalog ===")
    items = []
    resolved = 0
    unresolved_namekey = 0
    literal_names = 0
    skipped = 0
    for row in rows:
        # Tolerate BOM-prefixed first column name.
        ik_str = (row.get("ItemKey") or row.get("\ufeffItemKey") or row.get("itemKey") or "").strip()
        if not ITEMKEY_RE.match(ik_str):
            skipped += 1
            continue
        item_key = int(ik_str)
        name_key = (row.get("NameKey") or "").strip()
        if name_key.startswith("ItemName_"):
            name = name_map.get(name_key)
            if name is None:
                name = name_key
                unresolved_namekey += 1
            else:
                resolved += 1
        elif name_key:
            name = name_key
            literal_names += 1
        else:
            name = f"#{item_key}"
            unresolved_namekey += 1
        level_str = (row.get("Level") or "").strip()
        level = int(level_str) if level_str else None
        items.append({
            "id": item_key,
            "name": name,
            "grade": (row.get("GRADE") or "").strip(),
            "type": (row.get("ITEMTYPE") or "").strip(),
            "level": level,
            "marketTradable": parse_bool(row.get("IsCanExchangeMarketable")),
        })

    print(f"  Total items: {len(items)}")
    print(f"  Resolved (ItemName_ -> localized): {resolved}")
    print(f"  Unresolved ItemName_ (raw key kept): {unresolved_namekey}")
    print(f"  Literal names (STAGEBOX etc.): {literal_names}")
    print(f"  Skipped (non-numeric ItemKey): {skipped}")

    # Step 3b: Add NameKey-only entries (ItemName_XXX in localization bundle but
    # not in CSV). These are "base ids" like 620017 = RING(62) + grade 0 +
    # item 17 — the CSV only has variant rows (628111 etc.), but the game's
    # BoxOpenLog may emit ItemName_620017 as the itemStringKey. Without these
    # rows the runtime would display '#620017' instead of the real name.
    seen_ids = {it["id"] for it in items}
    namekey_only = 0
    for nk, name in name_map.items():
        m = re.match(r"^ItemName_(\d+)$", nk)
        if not m:
            continue
        base_id = int(m.group(1))
        if base_id in seen_ids:
            continue
        items.append({
            "id": base_id,
            "name": name,
            "grade": "",
            "type": "",
            "level": None,
            "marketTradable": False,
        })
        namekey_only += 1
        seen_ids.add(base_id)
    print(f"  NameKey-only entries added (base id not in CSV): {namekey_only}")

    print("\n=== Step 4: Write gamedata.json ===")
    catalog = {
        "gameVersion": "1.00.28",
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  Written: {OUT} ({OUT.stat().st_size} bytes)")

    print("\n=== Sample items ===")
    for ik in [110001, 120001, 530017, 620011, 620017, 628111, 910011]:
        for it in items:
            if it["id"] == ik:
                print(f"  {ik}: name={it['name']!r} type={it['type']} grade={it['grade']} level={it['level']}")
                break
        else:
            print(f"  {ik}: NOT FOUND in catalog")


if __name__ == "__main__":
    main()
