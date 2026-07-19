"""Dump every marker=14 entry from ItemTable Shared Data to see all key types."""
import struct
from pathlib import Path
import UnityPy

SHARED_BUNDLE = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\localization-assets-shared_assets_all.bundle"
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


def main():
    env = UnityPy.load(str(SHARED_BUNDLE))
    print(f"Total objects: {len(env.objects)}")
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        print(f"\n=== path_id={obj.path_id} raw_size={len(raw)} ===")
        if len(raw) >= 30000:
            print("  (skipping — too large, likely StringTable Shared Data)")
            continue
        hits = scan_marker_entries(raw, marker=14)
        print(f"  Total marker=14 entries: {len(hits)}")

        # Group by prefix.
        from collections import Counter
        prefixes = Counter()
        for off, kid, h4, sl, s in hits:
            # Take chars up to first '_' or digits.
            prefix = ""
            for c in s:
                if c == "_":
                    prefix += "_"
                    break
                elif c.isdigit():
                    break
                else:
                    prefix += c
            prefixes[prefix] += 1
        print(f"  Prefix groups: {dict(prefixes)}")

        # Print first 20 and last 20 entries.
        print("\n  First 20 entries:")
        for i, (off, kid, h4, sl, s) in enumerate(hits[:20]):
            print(f"    [{i:3d}] @{off:06x}  kid={kid:6d}  hash=0x{h4:08x}  len={sl:3}  {s!r}")
        print("\n  Last 20 entries:")
        for i, (off, kid, h4, sl, s) in enumerate(hits[-20:]):
            idx = len(hits) - 20 + i
            print(f"    [{idx:3d}] @{off:06x}  kid={kid:6d}  hash=0x{h4:08x}  len={sl:3}  {s!r}")

        # Find indices where string does NOT start with ItemName_.
        non_itemname = [(i, s) for i, (_, _, _, _, s) in enumerate(hits) if not s.startswith("ItemName_")]
        print(f"\n  Non-ItemName_ entries: {len(non_itemname)}")
        for idx, s in non_itemname[:30]:
            print(f"    [{idx:3d}] {s!r}")
        break


if __name__ == "__main__":
    main()
