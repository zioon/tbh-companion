"""Audit unresolved ItemName_ keys to understand why they have no localized string."""
import csv
import io
import re
from collections import Counter
from pathlib import Path

import UnityPy

STEAM = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data")
SHAREDASSETS = STEAM / "sharedassets0.assets"
SHARED_BUNDLE = (
    STEAM / "StreamingAssets" / "aa" / "StandaloneWindows64"
    / "localization-assets-shared_assets_all.bundle"
)
EN_BUNDLE = (
    STEAM / "StreamingAssets" / "aa" / "StandaloneWindows64"
    / "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
)


def parse_textasset_raw(raw):
    if len(raw) < 8:
        return None, None
    import struct
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


def scan_marker_entries(raw, marker=14):
    import struct
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
        i = str_end
        while i % 4 != 0:
            i += 1
    return hits


def load_name_keys_set():
    """Return set of all ItemName_XXX keys present in SharedTableData."""
    env = UnityPy.load(str(SHARED_BUNDLE))
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        if len(raw) < 30000:
            hits = scan_marker_entries(raw, marker=14)
            return {s for (_, _, _, _, s) in hits if s.startswith("ItemName_")}
    return set()


def main():
    name_keys_in_bundle = load_name_keys_set()
    print(f"ItemName_ keys in SharedTableData: {len(name_keys_in_bundle)}")

    # Load CSV.
    env = UnityPy.load(str(SHAREDASSETS))
    csv_text = None
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        raw = obj.get_raw_data()
        name, script = parse_textasset_raw(raw)
        if name == "ItemInfoData" and script:
            csv_text = script
            break
    if not csv_text:
        raise RuntimeError("ItemInfoData CSV not found")

    rows = list(csv.DictReader(io.StringIO(csv_text, newline="")))
    print(f"CSV rows: {len(rows)}")

    # Find rows whose NameKey starts with ItemName_ but is NOT in the bundle.
    unresolved = []
    for row in rows:
        nk = (row.get("NameKey") or "").strip()
        if nk.startswith("ItemName_") and nk not in name_keys_in_bundle:
            ik = (row.get("ItemKey") or row.get("\ufeffItemKey") or "").strip()
            unresolved.append((ik, nk, (row.get("ITEMTYPE") or "").strip(), (row.get("GRADE") or "").strip()))

    print(f"\nUnresolved ItemName_ rows (in CSV but not in localization bundle): {len(unresolved)}")

    # Group by prefix pattern (the number after ItemName_).
    # Pattern: ItemName_XXYZZZ where XX=type, Y=grade, ZZZ=index.
    prefixes = Counter()
    for ik, nk, t, g in unresolved:
        m = re.match(r"^ItemName_(\d+)$", nk)
        if m:
            num = m.group(1)
            # Take first 2 digits as type prefix.
            prefix = num[:2] + "xxxx" if len(num) >= 6 else num
            prefixes[prefix] += 1
    print(f"  By ItemKey prefix (first 2 digits):")
    for p, c in prefixes.most_common(20):
        print(f"    {p}: {c}")

    # Sample 20 unresolved rows.
    print(f"\n  Sample unresolved rows:")
    for ik, nk, t, g in unresolved[:20]:
        print(f"    ItemKey={ik}  NameKey={nk}  type={t}  grade={g}")


if __name__ == "__main__":
    main()
