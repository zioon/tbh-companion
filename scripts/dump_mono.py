#!/usr/bin/env python3
"""
Dump fields of MonoBehaviour instances grouped by m_Script.m_ClassName.

Useful for discovering the real ItemSO class when class names are obfuscated
(v1.00.28: cb / xw / yc / cl / bgx / bfd). For each class name, dumps up to
N instances as raw typetree key/value pairs.

Usage:
    python scripts/dump_mono.py [CLASS_NAME] [MAX_INSTANCES] [GAME_DATA_DIR]

Examples:
    python scripts/dump_mono.py cb 3
    python scripts/dump_mono.py xw 2
    python scripts/dump_mono.py "" 1    # empty = dump first instance of EVERY class
"""

from __future__ import annotations

import os
import sys

import UnityPy


def main() -> int:
    class_filter = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        max_instances = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    except ValueError:
        max_instances = 3
    data_dir = sys.argv[3] if len(sys.argv) > 3 else (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    )

    assets_files = [
        os.path.join(data_dir, n)
        for n in sorted(os.listdir(data_dir))
        if n.endswith(".assets")
    ]

    # class_name -> list of (assets_file, path_id, mono_obj)
    by_class: dict[str, list[tuple[str, int, object]]] = {}

    for assets_file in assets_files:
        try:
            env = UnityPy.load(assets_file)
        except Exception as e:
            print(f"WARN: load {assets_file}: {e}", file=sys.stderr)
            continue
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                data = obj.read()
            except Exception:
                continue
            script_ref = getattr(data, "m_Script", None)
            if script_ref is None:
                continue
            try:
                class_name = getattr(script_ref.read(), "m_ClassName", None) or "<unknown>"
            except Exception:
                class_name = "<unreadable>"
            if class_filter and class_name != class_filter:
                continue
            by_class.setdefault(class_name, []).append(
                (os.path.basename(assets_file), obj.path_id, obj)
            )

    for class_name, entries in sorted(by_class.items()):
        print(f"\n=== class {class_name!r}  ({len(entries)} instances) ===")
        for assets_name, path_id, obj in entries[:max_instances]:
            print(f"--- {assets_name} path_id={path_id} ---")
            try:
                data = obj.read()
            except Exception as e:
                print(f"  read error: {e}")
                continue
            # Try typetree first (most reliable for IL2CPP games).
            typetree_dumped = False
            try:
                tree = obj.read_typetree()
                if isinstance(tree, dict) and tree:
                    # Skip Unity boilerplate fields.
                    skip_prefixes = ("m_GameObject", "m_Enabled", "m_Script",
                                     "m_Name", "m_EditorHideFlags", "m_EditorClassIdentifier")
                    shown = 0
                    for k, v in tree.items():
                        if k.startswith(skip_prefixes):
                            continue
                        s = repr(v)
                        if len(s) > 200:
                            s = s[:200] + "..."
                        print(f"  {k} = {s}")
                        shown += 1
                    if shown > 0:
                        typetree_dumped = True
            except Exception as e:
                print(f"  typetree error: {e}")
            if not typetree_dumped:
                # IL2CPP games don't have type trees. Fall back to raw bytes:
                # read the MonoBehaviour's raw data (after the 20+ byte Unity
                # header: m_GameObject ptr, m_Enabled u8, padding 3 bytes,
                # m_Script ptr, m_Name str). We dump 256 bytes as hex + ASCII
                # to look for recognizable patterns (itemKey ints, string ptrs
                # are not visible but inline strings are).
                try:
                    raw = obj.get_raw_data()
                except Exception as e:
                    print(f"  raw read error: {e}")
                    continue
                print(f"  raw bytes ({len(raw)} bytes):")
                # Skip the standard MonoBehaviour preamble (20 bytes: 4+1+3+4+4+4)
                # but also show it so we can see the structure.
                offset = 0
                step = 16
                max_dump = min(len(raw), 512)
                while offset < max_dump:
                    chunk = raw[offset:offset + step]
                    hex_part = " ".join(f"{b:02x}" for b in chunk)
                    ascii_part = "".join(
                        chr(b) if 0x20 <= b < 0x7f else "." for b in chunk
                    )
                    print(f"    {offset:04x}  {hex_part:<48}  {ascii_part}")
                    offset += step

    return 0


if __name__ == "__main__":
    sys.exit(main())
