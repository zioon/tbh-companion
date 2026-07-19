"""Deep dump of ItemTable MonoBehaviour to find key_id → string mapping."""
import struct, UnityPy

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
    except Exception:
        continue

    print(f"\n=== path_id={obj.path_id} raw_size={len(raw)} ===")

    # Dump first 1024 bytes with annotations.
    print("First 1024 bytes (looking for structure):")
    for off in range(0, min(len(raw), 1024), 16):
        chunk = raw[off:off + 16]
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        ascii_part = "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in chunk)
        print(f"  {off:04x}  {hex_part:<48}  {ascii_part}")

    # Parse as sequence of entries. Each entry seems to be:
    #   [key_id: 8B] [type_marker: 4B = 14] [len: 4B] [string: L bytes] [padding to 4]
    # Let's verify by reading the first few entries explicitly.
    print("\nExplicit parse (assuming [8B key][4B marker=14][4B len][string]):")
    # Skip the 60-byte header (based on first dump: 0x00..0x3c had table metadata).
    i = 0x40
    count = 0
    while i < len(raw) - 16 and count < 20:
        key_id = struct.unpack_from("<Q", raw, i)[0]
        marker = struct.unpack_from("<I", raw, i + 8)[0]
        slen = struct.unpack_from("<I", raw, i + 12)[0]
        if marker != 14 or slen > 200:
            i += 1
            continue
        s = raw[i + 16:i + 16 + slen].decode("utf-8", errors="replace")
        print(f"  @{i:06x}  key_id={key_id:>20d} (0x{key_id:016x})  marker={marker}  len={slen:>3}  {s!r}")
        i += 16 + slen
        # Align to 4.
        while i % 4 != 0:
            i += 1
        count += 1

    # Try alternative: [4B key][4B marker][4B len][string] (key is 4 bytes only).
    print("\nAlternative parse ([4B key][4B marker=14][4B len][string]):")
    i = 0x40
    count = 0
    while i < len(raw) - 12 and count < 20:
        key_id = struct.unpack_from("<I", raw, i)[0]
        marker = struct.unpack_from("<I", raw, i + 4)[0]
        slen = struct.unpack_from("<I", raw, i + 8)[0]
        if marker != 14 or slen > 200:
            i += 1
            continue
        s = raw[i + 12:i + 12 + slen].decode("utf-8", errors="replace")
        if not all(0x20 <= b < 0x7f for b in raw[i + 12:i + 12 + slen]):
            i += 1
            continue
        print(f"  @{i:06x}  key_id={key_id:>10d}  marker={marker}  len={slen:>3}  {s!r}")
        i += 12 + slen
        while i % 4 != 0:
            i += 1
        count += 1
