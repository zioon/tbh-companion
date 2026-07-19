#!/usr/bin/env python3
"""
Probe catalog candidates from TBH game asset files.

Lists all ScriptableObject types and their instance counts across all .assets
files. Run once to discover the real ItemSO class name, then we write the
targeted extractor.

Usage:
    python scripts/probe_catalog.py [GAME_DATA_DIR]

Default GAME_DATA_DIR:
    D:\\SteamLibrary\\steamapps\\common\\TaskbarHero\\TaskbarHero_Data
"""

from __future__ import annotations

import collections
import os
import sys

import UnityPy


def main() -> int:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else (
        r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
    )
    if not os.path.isdir(data_dir):
        print(f"ERROR: data dir not found: {data_dir}", file=sys.stderr)
        return 2

    # Scan every .assets file (resource files don't carry ScriptableObjects).
    assets_files = []
    for name in sorted(os.listdir(data_dir)):
        full = os.path.join(data_dir, name)
        if os.path.isfile(full) and name.endswith(".assets"):
            assets_files.append(full)

    print(f"Scanning {len(assets_files)} .assets files in {data_dir}")
    for f in assets_files:
        size_kb = os.path.getsize(f) // 1024
        print(f"  {os.path.basename(f)}  ({size_kb} KB)")

    # type_name -> count
    type_counts: collections.Counter[str] = collections.Counter()
    # type_name -> sample path_ids (first 3)
    type_samples: dict[str, list[int]] = {}

    for assets_file in assets_files:
        try:
            env = UnityPy.load(assets_file)
        except Exception as e:
            print(f"  WARN: failed to load {assets_file}: {e}", file=sys.stderr)
            continue
        for obj in env.objects:
            # Only care about ScriptableObject / MonoBehaviour subclasses.
            # In UnityPy, ScriptableObject instances are type 0x72 (MonoBehaviour)
            # or 0x72 with a ScriptableObject-typed m_Script. We bucket by
            # obj.type.name which UnityPy resolves from the type tree.
            type_name = obj.type.name
            if type_name in ("MonoBehaviour", "MonoScript", "Texture2D",
                             "Sprite", "Material", "Shader", "Font",
                             "AudioClip", "TextAsset", "AnimationClip",
                             "RuntimeAnimatorController", "AnimatorController",
                             "Texture3D", "RenderTexture", "Mesh", "SpriteAtlas"):
                continue
            type_counts[type_name] += 1
            if type_name not in type_samples:
                type_samples[type_name] = []
            if len(type_samples[type_name]) < 3:
                type_samples[type_name].append(obj.path_id)

    print()
    print(f"=== Non-builtin types ({len(type_counts)} distinct) ===")
    print("Count  Type                              Sample path_ids")
    print("-" * 80)
    for type_name, count in type_counts.most_common():
        samples = type_samples.get(type_name, [])
        sample_str = ",".join(str(s) for s in samples)
        print(f"{count:>5}  {type_name:<35} {sample_str}")

    # Also dump MonoBehaviour tree names — IL2CPP games sometimes store
    # ScriptableObjects as MonoBehaviour with m_Script referencing a MonoScript
    # whose m_ClassName is the real type. We bucket by m_ClassName.
    print()
    print("=== MonoBehaviour by m_Script.m_ClassName ===")
    mono_counts: collections.Counter[str] = collections.Counter()
    mono_samples: dict[str, list[int]] = {}
    for assets_file in assets_files:
        try:
            env = UnityPy.load(assets_file)
        except Exception:
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
                script = script_ref.read()
                class_name = getattr(script, "m_ClassName", None) or "<unknown>"
            except Exception:
                class_name = "<unreadable>"
            mono_counts[class_name] += 1
            if class_name not in mono_samples:
                mono_samples[class_name] = []
            if len(mono_samples[class_name]) < 3:
                mono_samples[class_name].append(obj.path_id)

    print("Count  ClassName                          Sample path_ids")
    print("-" * 80)
    for class_name, count in mono_counts.most_common():
        samples = mono_samples.get(class_name, [])
        sample_str = ",".join(str(s) for s in samples)
        print(f"{count:>5}  {class_name:<35} {sample_str}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
