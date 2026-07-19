"""Compare hash values between SharedTableData and EN StringTable to find linker."""
import struct
from pathlib import Path
import UnityPy

SHARED_BUNDLE = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\localization-assets-shared_assets_all.bundle"
)
EN_BUNDLE = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle"
)


def scan_marker_entries(raw, marker=14):
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


def load_hits(path, max_size):
    """Return marker entries from the MonoBehaviour with raw_size < max_size."""
    env = UnityPy.load(str(path))
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        if len(raw) < max_size:
            return scan_marker_entries(raw, marker=14)
    return []


def main():
    shared = load_hits(SHARED_BUNDLE, 30000)
    en = load_hits(EN_BUNDLE, 60000)
    print(f"SharedTableData: {len(shared)} entries")
    print(f"EN StringTable:  {len(en)} entries")

    # Print side-by-side first 15 entries.
    print("\n=== First 15 entries side-by-side ===")
    print(f"  {'idx':>3}  {'SHARED kid':>10}  {'SHARED hash':>10}  {'SHARED str':<28}  {'EN kid':>10}  {'EN hash':>10}  {'EN str':<28}")
    for i in range(15):
        s_off, s_kid, s_h, s_sl, s_str = shared[i]
        e_off, e_kid, e_h, e_sl, e_str = en[i]
        print(f"  {i:>3}  {s_kid:>10}  0x{s_h:08x}  {s_str[:28]:<28}  {e_kid:>10}  0x{e_h:08x}  {e_str[:28]:<28}")

    # Build hash -> string maps and check if hashes intersect.
    shared_by_hash = {}
    for off, kid, h, sl, s in shared:
        shared_by_hash.setdefault(h, []).append(s)
    en_by_hash = {}
    for off, kid, h, sl, s in en:
        en_by_hash.setdefault(h, []).append(s)

    shared_hashes = set(shared_by_hash.keys())
    en_hashes = set(en_by_hash.keys())
    inter = shared_hashes & en_hashes
    print(f"\n=== Hash overlap ===")
    print(f"  SharedTableData unique hashes: {len(shared_hashes)}")
    print(f"  EN StringTable unique hashes:  {len(en_hashes)}")
    print(f"  Intersection:                  {len(inter)}")

    # If intersection is small, hash is NOT the linker. If it's ~574, hash IS the linker.
    if len(inter) > 100:
        print("  -> Hash appears to be the linker! Sample matches:")
        for h in list(inter)[:10]:
            ss = shared_by_hash[h][0]
            es = en_by_hash[h][0]
            print(f"    hash=0x{h:08x}  shared={ss!r:<30}  en={es!r}")
    else:
        print("  -> Hash does NOT overlap. Position is the only candidate linker.")
        # Check: are there duplicate hashes within SharedTableData?
        dupes = {h: v for h, v in shared_by_hash.items() if len(v) > 1}
        print(f"  SharedTableData duplicate hashes: {len(dupes)}")
        for h, strs in list(dupes.items())[:5]:
            print(f"    hash=0x{h:08x}  strings({len(strs)}): {strs[:3]}")
        # Distribution of key_id values.
        from collections import Counter
        shared_kids = Counter(kid for _, kid, _, _, _ in shared)
        en_kids = Counter(kid for _, kid, _, _, _ in en)
        print(f"  SharedTableData key_id distribution: {dict(shared_kids)}")
        print(f"  EN StringTable key_id distribution:  {dict(en_kids)}")

    # Try a different hypothesis: maybe entries are sorted by hash in one file
    # and by ItemKey in the other. Sort both by hash and compare positions.
    print("\n=== Sort both by hash, compare first 15 ===")
    shared_sorted = sorted(shared, key=lambda x: x[2])
    en_sorted = sorted(en, key=lambda x: x[2])
    print(f"  {'idx':>3}  {'SHARED hash':>10}  {'SHARED str':<28}  {'EN hash':>10}  {'EN str':<28}")
    for i in range(15):
        s_off, s_kid, s_h, s_sl, s_str = shared_sorted[i]
        e_off, e_kid, e_h, e_sl, e_str = en_sorted[i]
        same = "✓" if s_h == e_h else "✗"
        print(f"  {i:>3}  0x{s_h:08x}  {s_str[:28]:<28}  0x{e_h:08x}  {e_str[:28]:<28}  {same}")


if __name__ == "__main__":
    main()
