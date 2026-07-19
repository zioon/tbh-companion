"""Dump localization-assets-shared bundle (SharedTableData).
Goal: find ItemName_XXX string -> 32-bit entry id mapping.
"""
import struct, UnityPy

bundle = (
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\localization-assets-shared_assets_all.bundle"
)
env = UnityPy.load(bundle)

print(f"Loaded bundle: {bundle}")
print(f"Objects: {len(env.objects)}\n")

for obj in env.objects:
    try:
        tn = obj.type.name
    except Exception:
        tn = "?"
    try:
        raw = obj.get_raw_data()
    except Exception:
        raw = b""
    print(f"=== path_id={obj.path_id} type={tn} raw_size={len(raw)} ===")

    # Dump first 512 bytes as hex+ascii.
    for off in range(0, min(len(raw), 512), 16):
        chunk = raw[off:off + 16]
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        ascii_part = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in chunk)
        print(f"  {off:04x}  {hex_part:<48}  {ascii_part}")

    # Try to find ItemName_ strings and dump their context (preceding 8 or 4 bytes might be the entry id).
    print("\n  ItemName_ occurrences (with 16 bytes prefix):")
    idx = 0
    found = 0
    while True:
        pos = raw.find(b"ItemName_", idx)
        if pos < 0:
            break
        # Find end of string (null terminator).
        end = raw.find(b"\x00", pos)
        if end < 0:
            end = pos + 32
        s = raw[pos:end].decode("utf-8", errors="replace")
        # Show 16 bytes before the string.
        prefix_start = max(0, pos - 16)
        prefix = raw[prefix_start:pos]
        prefix_hex = " ".join(f"{b:02x}" for b in prefix)
        # Try to read 4B and 8B values at various offsets before the string.
        if pos >= 8:
            v4_at_minus8 = struct.unpack_from("<I", raw, pos - 8)[0]
            v4_at_minus4 = struct.unpack_from("<I", raw, pos - 4)[0]
            v8_at_minus8 = struct.unpack_from("<Q", raw, pos - 8)[0]
        else:
            v4_at_minus8 = v4_at_minus4 = v8_at_minus8 = 0
        print(f"    @{pos:06x}  '{s}'  prefix16={prefix_hex}  u32@-8=0x{v4_at_minus8:08x}  u32@-4=0x{v4_at_minus4:08x}  u64@-8=0x{v8_at_minus8:016x}")
        idx = end + 1
        found += 1
        if found >= 30:
            print("    ... (truncated, showing first 30)")
            break

    # Also dump any 'Item' string occurrences that might be collection names.
    print("\n  Collection names / 'ItemTable' / 'StringTable' occurrences:")
    for needle in [b"ItemTable", b"StringTable", b"Shared", b"Collection", b"Key"]:
        pos = raw.find(needle)
        if pos >= 0:
            end = raw.find(b"\x00", pos)
            if end < 0 or end - pos > 64:
                end = pos + 64
            s = raw[pos:end].decode("utf-8", errors="replace")
            print(f"    '{needle.decode()}' @{pos:06x}: {s!r}")
    print()
