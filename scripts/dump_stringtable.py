"""Dump all readable strings from the 95KB StringTable_en-US MonoBehaviour."""
import os, sys, struct, UnityPy

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

    print(f"\n=== path_id={obj.path_id} raw_size={len(raw)} ===")

    # Brute-force scan: find every length-prefixed string (4-byte LE length
    # followed by printable text of that length). Print ALL of them with their
    # offset and the 8 bytes preceding the length field (potential key_id).
    i = 0
    n = len(raw)
    found = 0
    while i < n - 4:
        slen = struct.unpack_from("<I", raw, i)[0]
        if slen < 2 or slen > 200:
            i += 1
            continue
        if i + 4 + slen > n:
            i += 1
            continue
        candidate = raw[i + 4:i + 4 + slen]
        try:
            s = candidate.decode("utf-8")
        except UnicodeDecodeError:
            i += 1
            continue
        # Require strictly printable ASCII (item names are English).
        if not all(0x20 <= b < 0x7f for b in candidate):
            i += 1
            continue
        # Skip if it looks like a C# identifier with underscore + digits.
        if "_" in s and any(c.isdigit() for c in s):
            i += 1
            continue
        # Print offset + preceding 8 bytes (as int) + string.
        prev8 = struct.unpack_from("<Q", raw, i - 8)[0] if i >= 8 else 0
        prev4 = struct.unpack_from("<I", raw, i - 4)[0] if i >= 4 else 0
        print(f"  @{i:06x}  prev8={prev8:>20d}  prev4={prev4:>10d}  len={slen:>3}  {s!r}")
        found += 1
        # Skip past string + padding.
        i += 4 + slen
        while i % 4 != 0 and i < n:
            i += 1
    print(f"  Total found: {found}")
