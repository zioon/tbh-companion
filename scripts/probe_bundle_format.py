"""Probe Unity bundle format to assess Node.js parsing complexity."""
import struct
from pathlib import Path

STEAM = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data")
AA = STEAM / "StreamingAssets" / "aa" / "StandaloneWindows64"

BUNDLES = [
    AA / "localization-assets-shared_assets_all.bundle",
    AA / "localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle",
]
SHAREDASSETS = STEAM / "sharedassets0.assets"


def probe_bundle(path: Path):
    print(f"\n=== {path.name} ({path.stat().st_size} bytes) ===")
    with open(path, "rb") as f:
        data = f.read()
    # Unity Bundle header (format 6+): signature, version, unityVersion, unityRevision, size, compressedBlocksInfoSize, uncompressedBlocksInfoSize, flags.
    sig_end = data.find(b"\x00")
    signature = data[:sig_end].decode("ascii", errors="replace")
    print(f"  Signature: {signature!r}")
    off = sig_end + 1
    # version: uint32
    version = struct.unpack_from("<I", data, off)[0]
    off += 4
    print(f"  Format version: {version}")
    # unityVersion: null-terminated string
    uv_end = data.find(b"\x00", off)
    unity_version = data[off:uv_end].decode("ascii", errors="replace")
    off = uv_end + 1
    print(f"  Unity version: {unity_version!r}")
    # unityRevision: null-terminated string
    ur_end = data.find(b"\x00", off)
    unity_revision = data[off:ur_end].decode("ascii", errors="replace")
    off = ur_end + 1
    print(f"  Unity revision: {unity_revision!r}")
    # size: int64
    size = struct.unpack_from("<q", data, off)[0]
    off += 8
    print(f"  Bundle size: {size}")
    # compressedBlocksInfoSize: uint32
    cbi = struct.unpack_from("<I", data, off)[0]
    off += 4
    # uncompressedBlocksInfoSize: uint32
    ubi = struct.unpack_from("<I", data, off)[0]
    off += 4
    print(f"  BlocksInfo: compressed={cbi} uncompressed={ubi}")
    # flags: uint32
    flags = struct.unpack_from("<I", data, off)[0]
    off += 4
    print(f"  Flags: 0x{flags:08x}")
    print(f"    compression: {flags & 0x3f} (0=none, 1=lzma, 2=lz4, 3=lz4hc)")
    print(f"    blocksInfoAtEnd: {bool(flags & 0x80)}")
    print(f"    oldWebPluginCompatibility: {bool(flags & 0x100)}")
    print(f"    blockInfoNeedPaddingAtStart: {bool(flags & 0x200)}")

    # Try to find ItemInfoData / ItemName_ strings in the raw bundle.
    # If they're readable without decompression, bundle is uncompressed.
    for needle in [b"ItemInfoData", b"ItemName_110001", b"Goblin Hide"]:
        idx = data.find(needle)
        print(f"  Needle {needle!r}: {'found@' + str(idx) if idx >= 0 else 'NOT FOUND (compressed?)'}")


def probe_assets(path: Path):
    print(f"\n=== {path.name} ({path.stat().st_size} bytes) ===")
    with open(path, "rb") as f:
        data = f.read()
    # SerializedFile header: metadata size (uint32), file size (int32), version (int32), data offset (uint32), endianness (byte), reserved[3]
    if len(data) < 20:
        print("  Too small")
        return
    meta_size = struct.unpack_from("<I", data, 0)[0]
    file_size = struct.unpack_from("<i", data, 4)[0]
    version = struct.unpack_from("<i", data, 8)[0]
    data_offset = struct.unpack_from("<I", data, 12)[0]
    endianness = data[16]
    print(f"  SerializedFile version: {version}, metadata_size={meta_size}, data_offset={data_offset}, endianness={endianness}")
    # Look for ItemInfoData string.
    for needle in [b"ItemInfoData", b"BuffGroupInfoData", b"TextAsset"]:
        idx = data.find(needle)
        print(f"  Needle {needle!r}: {'found@' + str(idx) if idx >= 0 else 'NOT FOUND'}")


def main():
    for b in BUNDLES:
        if b.exists():
            probe_bundle(b)
        else:
            print(f"\n=== {b} NOT FOUND ===")
    if SHAREDASSETS.exists():
        probe_assets(SHAREDASSETS)


if __name__ == "__main__":
    main()
