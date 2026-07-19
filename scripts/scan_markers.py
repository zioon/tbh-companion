"""Scan all marker=14 occurrences in localization bundles to understand entry structure."""
import struct, UnityPy
from pathlib import Path

AA = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64")
SHARED = AA / "localization-assets-shared_assets_all.bundle"
EN = AA / "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"

def scan_markers(raw, label, max_show=30):
    """Find every position where bytes [4B][4B][0e 00 00 00][4B len] look like a valid entry."""
    print(f"\n=== {label} (raw={len(raw)}B) ===")
    hits = []
    n = len(raw)
    for i in range(0, n - 16):
        m = struct.unpack_from("<I", raw, i + 8)[0]
        if m != 14:
            continue
        slen = struct.unpack_from("<I", raw, i + 12)[0]
        if slen == 0 or slen > 256:
            continue
        str_start = i + 16
        str_end = str_start + slen
        if str_end > n:
            continue
        try:
            s = raw[str_start:str_end].decode("utf-8")
        except UnicodeDecodeError:
            continue
        if not all(0x20 <= ord(c) < 0x7f or ord(c) > 0x7f for c in s):
            continue
        key_id = struct.unpack_from("<I", raw, i)[0]
        hash4 = struct.unpack_from("<I", raw, i + 4)[0]
        hits.append((i, key_id, hash4, slen, s))
    print(f"Found {len(hits)} marker=14 entries")
    for i, (off, kid, h4, sl, s) in enumerate(hits[:max_show]):
        print(f"  @{off:06x}  key_id={kid:>12d} (0x{kid:08x})  hash=0x{h4:08x}  len={sl:>3}  {s!r}")
    if len(hits) > max_show:
        print(f"  ... ({len(hits) - max_show} more)")
    # Show distribution of key_ids.
    if hits:
        kids = [h[1] for h in hits]
        unique = sorted(set(kids))
        print(f"  Unique key_ids: {len(unique)} (min={min(kids)}, max={max(kids)})")
        if len(unique) <= 20:
            print(f"  All key_ids: {unique}")
    return hits

env = UnityPy.load(str(SHARED))
for obj in env.objects:
    if obj.type.name != "MonoBehaviour":
        continue
    raw = obj.get_raw_data()
    # Identify by size (21KB = ItemTable Shared, 52KB = StringTable Shared).
    label = f"SHARED path_id={obj.path_id} size={len(raw)}"
    scan_markers(raw, label)

env = UnityPy.load(str(EN))
for obj in env.objects:
    if obj.type.name != "MonoBehaviour":
        continue
    raw = obj.get_raw_data()
    label = f"EN path_id={obj.path_id} size={len(raw)}"
    scan_markers(raw, label, max_show=10)
